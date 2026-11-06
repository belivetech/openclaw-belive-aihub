import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { baseUrlFor, isConfigured, resolveApiKey } from "./auth.js";
import { PROVIDER_ID } from "./catalog.js";
import { BeliveApiError, bearer, fetchChecked, fetchJson, readLimited, record } from "./http.js";
import { fetchVideoModels, type VideoModel } from "./media-catalog.js";
import { isMp4, sniffImage } from "./sniff.js";

type VideoProvider = Parameters<OpenClawPluginApi["registerVideoGenerationProvider"]>[0];
type VideoRequest = Parameters<VideoProvider["generateVideo"]>[0];
type VideoCapabilities = NonNullable<Awaited<ReturnType<NonNullable<VideoProvider["resolveModelCapabilities"]>>>>;

export const DEFAULT_VIDEO_MODEL = "alibaba/wan3.0-video";
/** Total time one call waits for a job. A queued job alone may wait ten minutes before it starts. */
export const MIN_DEADLINE_MS = 15 * 60_000;
/** The gateway keeps an Idempotency-Key for 24 hours; a saved job is dropped a little earlier. */
const RECORD_TTL_MS = 23 * 3600_000;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_SUBMIT_ATTEMPTS = 3;
const MAX_POLL_FAILURES = 5;

export type JobRecord = { idempotencyKey: string; jobId?: string; model: string; createdAt: number };
export type JobStore = {
  read(fingerprint: string): Promise<JobRecord | undefined>;
  write(fingerprint: string, job: JobRecord): Promise<void>;
  remove(fingerprint: string): Promise<void>;
};

/** One small JSON file per in-flight request: an idempotency key and a job id, never a credential. */
export function fileJobStore(directory: () => string): JobStore {
  const file = (fingerprint: string) => path.join(directory(), `${fingerprint}.json`);
  const remove = async (fingerprint: string) => { await unlink(file(fingerprint)).catch(() => undefined); };
  return {
    async read(fingerprint) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(file(fingerprint), "utf8"));
      } catch {
        return undefined;
      }
      const job = record(parsed);
      if (typeof job?.idempotencyKey !== "string" || typeof job.model !== "string" || typeof job.createdAt !== "number"
          || (job.jobId !== undefined && typeof job.jobId !== "string") || Date.now() - job.createdAt > RECORD_TTL_MS) {
        await remove(fingerprint);
        return undefined;
      }
      return { idempotencyKey: job.idempotencyKey, model: job.model, createdAt: job.createdAt, ...(job.jobId ? { jobId: job.jobId } : {}) };
    },
    async write(fingerprint, job) {
      await mkdir(directory(), { recursive: true, mode: 0o700 });
      const temporary = `${file(fingerprint)}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(job), { mode: 0o600 });
      await rename(temporary, file(fingerprint));
    },
    remove,
  };
}

function imageUrl(asset: { url?: string; buffer?: Buffer }): string {
  if (asset.buffer) {
    const mime = sniffImage(asset.buffer);
    if (!mime) throw new Error("BeLive AI Hub video input images must be PNG, JPEG or WebP");
    return `data:${mime};base64,${asset.buffer.toString("base64")}`;
  }
  if (asset.url && /^https:\/\//i.test(asset.url)) return asset.url;
  throw new Error("BeLive AI Hub video input images must be an HTTPS URL or image bytes");
}

/** The submit body for one model, or an error naming what the model offers. Nothing here is billed. */
export function videoBody(model: VideoModel, req: VideoRequest): Record<string, unknown> {
  const refuse = (what: string, offered?: readonly (string | number)[]) => new Error(
    `BeLive AI Hub video model ${model.id} does not support ${what}${offered?.length ? `. Offered: ${offered.join(", ")}` : ""}`);
  if (req.inputVideos?.length || req.inputAudios?.length) {
    throw refuse("video or audio reference inputs through this plugin");
  }
  const body: Record<string, unknown> = { model: model.id, prompt: req.prompt };
  if (req.durationSeconds !== undefined) {
    const seconds = Math.round(req.durationSeconds);
    if (model.durations.length && !model.durations.includes(seconds)) throw refuse(`a ${req.durationSeconds} s duration`, model.durations);
    body.duration = seconds;
  }
  if (req.resolution) {
    const wanted = req.resolution.toLowerCase();
    const offered = model.resolutions.find(value => value.toLowerCase() === wanted);
    if (model.resolutions.length && !offered) throw refuse(`${req.resolution} resolution`, model.resolutions);
    body.resolution = offered ?? wanted;
  }
  if (req.aspectRatio) {
    if (!model.parameters.includes("aspect_ratio") || (model.aspectRatios.length && !model.aspectRatios.includes(req.aspectRatio))) {
      throw refuse(`aspect ratio ${req.aspectRatio}`, model.aspectRatios);
    }
    body.aspect_ratio = req.aspectRatio;
  }
  for (const [value, parameter, label] of [[req.audio, "generate_audio", "audio"], [req.watermark, "watermark", "a watermark option"]] as const) {
    if (value === undefined) continue;
    if (model.parameters.includes(parameter)) body[parameter] = value;
    else if (value) throw refuse(label);
  }
  const seed = req.providerOptions?.seed;
  if (seed !== undefined) {
    if (!model.parameters.includes("seed") || typeof seed !== "number" || !Number.isSafeInteger(seed)) throw refuse("this seed");
    body.seed = seed;
  }
  const frames: unknown[] = [];
  const references: unknown[] = [];
  for (const image of req.inputImages ?? []) {
    const url = imageUrl(image);
    const role = image.role;
    const wantsFrame = role === "first_frame" || role === "last_frame"
      || (role === undefined && model.frameRoles.includes("first_frame") && frames.length === 0);
    if (wantsFrame) {
      const frameType = role === "last_frame" ? "last_frame" : "first_frame";
      if (!model.frameRoles.includes(frameType)) throw refuse(`a ${frameType} image`, model.frameRoles);
      frames.push({ type: "image_url", image_url: { url }, frame_type: frameType });
    } else {
      if (!model.parameters.includes("input_references")) throw refuse("reference images");
      references.push({ type: "image_url", image_url: { url } });
    }
  }
  if (frames.length && references.length) throw refuse("frame images together with reference images");
  if (frames.length) body.frame_images = frames;
  if (references.length) body.input_references = references;
  return body;
}

export function videoCapabilities(model: VideoModel): VideoCapabilities {
  const mode = {
    maxVideos: 1,
    ...(model.durations.length ? { supportedDurationSeconds: model.durations } : {}),
    supportsSize: false,
    supportsResolution: model.resolutions.length > 0,
    ...(model.resolutions.length ? { resolutions: model.resolutions.map(value => value.toUpperCase()) } : {}),
    supportsAspectRatio: model.aspectRatios.length > 0 && model.parameters.includes("aspect_ratio"),
    ...(model.aspectRatios.length ? { aspectRatios: model.aspectRatios } : {}),
    supportsAudio: model.parameters.includes("generate_audio"),
    supportsWatermark: model.parameters.includes("watermark"),
  };
  const images = model.frameRoles.length > 0 || model.parameters.includes("input_references");
  return {
    providerOptions: { seed: "number" },
    generate: mode,
    imageToVideo: { enabled: images, ...mode, ...(model.frameRoles.length ? { maxInputImages: model.frameRoles.length } : {}) },
    videoToVideo: { enabled: false },
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = record(value);
  return object
    ? `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`
    : JSON.stringify(value);
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

type Job = { id: string; status: string; message?: string; generationId?: string; usage?: unknown };

function readJob(payload: unknown): Job {
  const job = record(payload);
  if (typeof job?.id !== "string" || typeof job.status !== "string") {
    throw new Error("BeLive AI Hub video job response was not understood");
  }
  const error = job.error;
  return {
    id: job.id, status: job.status,
    ...(typeof record(error)?.message === "string" ? { message: record(error)?.message as string } : typeof error === "string" ? { message: error } : {}),
    ...(typeof job.generation_id === "string" ? { generationId: job.generation_id } : {}),
    ...(job.usage !== undefined ? { usage: job.usage } : {}),
  };
}

/** The wait for one call: the caller's timeout, but never less than {@link MIN_DEADLINE_MS}. */
export function deadlineMs(timeoutMs: number | undefined, minimum = MIN_DEADLINE_MS): number {
  return Math.max(timeoutMs ?? 0, minimum);
}

export type VideoDeps = { jobs: JobStore; pollIntervalMs?: number; backoffMs?: number; minDeadlineMs?: number };

export function createVideoProvider(deps: VideoDeps): VideoProvider {
  const pollIntervalMs = deps.pollIntervalMs ?? 5000;
  const backoffMs = deps.backoffMs ?? 2000;

  async function findByKey(baseUrl: string, apiKey: string, idempotencyKey: string): Promise<string | undefined> {
    const payload = record(await fetchJson(`${baseUrl}/videos?idempotency_key=${encodeURIComponent(idempotencyKey)}`,
      { headers: bearer(apiKey) }, "video lookup", { timeoutMs: REQUEST_TIMEOUT_MS }));
    const first = record(Array.isArray(payload?.data) ? payload.data[0] : payload);
    return typeof first?.id === "string" ? first.id : undefined;
  }

  /** Submits once per idempotency key. An uncertain outcome is reconciled by key, never by a new key. */
  async function submit(baseUrl: string, apiKey: string, body: Record<string, unknown>, job: JobRecord, deadline: number, resumed: boolean): Promise<string> {
    if (resumed) {
      const known = await findByKey(baseUrl, apiKey, job.idempotencyKey).catch(() => undefined);
      if (known) return known;
    }
    let last: unknown;
    for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt++) {
      try {
        const payload = await fetchJson(`${baseUrl}/videos`, {
          method: "POST",
          headers: bearer(apiKey, { "Content-Type": "application/json", "Idempotency-Key": job.idempotencyKey }),
          body: JSON.stringify(body),
        }, "video submit", { timeoutMs: REQUEST_TIMEOUT_MS });
        return readJob(payload).id;
      } catch (error) {
        last = error;
        const status = error instanceof BeliveApiError ? error.status : undefined;
        const transient = status === undefined || status === 429 || status >= 500;
        if (!transient || attempt === MAX_SUBMIT_ATTEMPTS || Date.now() >= deadline) break;
        await wait(error instanceof BeliveApiError && error.retryAfterMs ? error.retryAfterMs : backoffMs * attempt);
        const known = await findByKey(baseUrl, apiKey, job.idempotencyKey).catch(() => undefined);
        if (known) return known;
      }
    }
    throw last;
  }

  async function download(baseUrl: string, apiKey: string, jobId: string): Promise<Buffer> {
    const url = `${baseUrl}/videos/${encodeURIComponent(jobId)}/content?index=0`;
    const timeoutMs = 5 * 60_000;
    let response = await fetchChecked(url, { headers: bearer(apiKey, { Accept: "video/mp4,*/*" }), redirect: "manual" },
      "video download", { timeoutMs, accept: status => status >= 300 && status < 400 });
    if (response.status >= 300) {
      await response.body?.cancel();
      const target = URL.parse(response.headers.get("location") ?? "", url);
      if (!target || target.protocol !== "https:") throw new Error("BeLive AI Hub video download redirected somewhere unusable");
      // The key goes to AI Hub only; a CDN link is fetched without it.
      const sameOrigin = target.origin === new URL(baseUrl).origin;
      response = await fetchChecked(target.href, { headers: sameOrigin ? bearer(apiKey) : { Accept: "video/mp4,*/*" } },
        "video download", { timeoutMs });
    }
    const bytes = await readLimited(response, MAX_VIDEO_BYTES, "generated video");
    if (!isMp4(bytes)) throw new Error("BeLive AI Hub video download was not an MP4 file");
    return bytes;
  }

  async function generateVideo(req: VideoRequest) {
    const baseUrl = baseUrlFor(req.cfg);
    const apiKey = await resolveApiKey(req.cfg, req.agentDir);
    const waitMs = deadlineMs(req.timeoutMs, deps.minDeadlineMs);
    const deadline = Date.now() + waitMs;
    const model = (await fetchVideoModels(baseUrl, apiKey)).find(row => row.id === req.model);
    if (!model) throw new Error(`BeLive AI Hub does not list a video generation model named ${req.model}`);
    const body = videoBody(model, req);

    const fingerprint = sha(canonical([baseUrl, sha(apiKey), body]));
    let saved = await deps.jobs.read(fingerprint);
    const resumed = saved !== undefined;
    if (!saved) {
      saved = { idempotencyKey: randomUUID(), model: model.id, createdAt: Date.now() };
      await deps.jobs.write(fingerprint, saved);
    }
    let jobId = saved.jobId;
    if (!jobId) {
      try {
        jobId = await submit(baseUrl, apiKey, body, saved, deadline, resumed);
      } catch (error) {
        const status = error instanceof BeliveApiError ? error.status : undefined;
        if (status !== undefined && status < 500 && status !== 429) {
          await deps.jobs.remove(fingerprint); // refused: nothing was created, a retry may use a new key
          throw error;
        }
        throw new Error(`${(error as Error).message}. The job may have started; run the same request again and the saved Idempotency-Key reconciles it instead of creating a second job`);
      }
      await deps.jobs.write(fingerprint, { ...saved, jobId });
    }

    const resumeHint = `BeLive AI Hub video job ${jobId} has not been cancelled and may still be charged. Run the same request again to resume it; no second job is created`;
    let completed: Job | undefined;
    for (let failures = 0; !completed;) {
      try {
        const job = readJob(await fetchJson(`${baseUrl}/videos/${encodeURIComponent(jobId)}`,
          { headers: bearer(apiKey) }, "video status", { timeoutMs: REQUEST_TIMEOUT_MS }));
        failures = 0;
        if (job.status === "completed") completed = job;
        else if (["failed", "cancelled", "expired"].includes(job.status)) {
          await deps.jobs.remove(fingerprint);
          throw new Error(`BeLive AI Hub video job ${jobId} ${job.status}${job.message ? `: ${job.message}` : ""}`);
        } else if (!["pending", "in_progress", "queued", "processing"].includes(job.status)) {
          throw new Error(`BeLive AI Hub video job ${jobId} reported an unknown status. ${resumeHint}`);
        }
      } catch (error) {
        const status = error instanceof BeliveApiError ? error.status : undefined;
        if (!(error instanceof BeliveApiError)) throw error;
        if (status === 404) {
          await deps.jobs.remove(fingerprint);
          throw new Error(`BeLive AI Hub video job ${jobId} was not found for this key; run the request again to start a new job`);
        }
        if ((status !== undefined && status < 500 && status !== 429) || ++failures >= MAX_POLL_FAILURES) {
          throw new Error(`${error.message}. ${resumeHint}`);
        }
        if (error.retryAfterMs) await wait(Math.min(error.retryAfterMs, Math.max(0, deadline - Date.now())));
      }
      if (completed) break;
      if (Date.now() >= deadline) {
        throw new Error(`BeLive AI Hub video job ${jobId} was still running after ${Math.max(1, Math.round(waitMs / 60000))} minutes. ${resumeHint}`);
      }
      await wait(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    }

    let buffer: Buffer;
    try {
      buffer = await download(baseUrl, apiKey, jobId);
    } catch (error) {
      throw new Error(`${(error as Error).message}. The job completed and is saved; run the same request again to download it without a new charge`);
    }
    await deps.jobs.remove(fingerprint);
    return {
      videos: [{ buffer, mimeType: "video/mp4", fileName: "video.mp4" }],
      model: model.id,
      metadata: { jobId, ...(completed.generationId ? { generationId: completed.generationId } : {}), ...(completed.usage !== undefined ? { usage: completed.usage } : {}) },
    };
  }

  return {
    id: PROVIDER_ID,
    label: "BeLive AI Hub",
    defaultModel: DEFAULT_VIDEO_MODEL,
    defaultTimeoutMs: MIN_DEADLINE_MS,
    capabilities: {
      providerOptions: { seed: "number" },
      generate: { maxVideos: 1, supportsSize: false, supportsResolution: true, supportsAspectRatio: true },
      imageToVideo: { enabled: true, maxVideos: 1, supportsSize: false, supportsResolution: true, supportsAspectRatio: true },
      videoToVideo: { enabled: false },
    },
    isConfiguredAsync: isConfigured,
    async resolveModelCapabilities(ctx) {
      try {
        const apiKey = await resolveApiKey(ctx.cfg, ctx.agentDir);
        const rows = await fetchVideoModels(baseUrlFor(ctx.cfg), apiKey, { timeoutMs: 4000 });
        const row = rows.find(item => item.id === ctx.model);
        return row ? videoCapabilities(row) : undefined;
      } catch {
        return undefined; // generateVideo reports the real reason before any charge
      }
    },
    generateVideo,
  };
}
