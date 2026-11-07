import type { MediaUnderstandingProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { isConfigured, resolveApiKey } from "./auth.js";
import { BASE_URL, officialBaseUrl } from "./catalog.js";
import { bearer, fetchJson, record } from "./http.js";
import { fetchTranscriptionModels } from "./media-catalog.js";
import { sniffTranscriptionAudio } from "./sniff.js";

type WithContext = NonNullable<MediaUnderstandingProviderPlugin["transcribeAudioWithContext"]>;
type Context = Parameters<WithContext>[0];

export const DEFAULT_TRANSCRIPTION_MODEL = "qwen/qwen-audio-3.1-asr-flash";
/** OpenAI's upload limit, which the AI Hub route applies before it stores the recording. */
export const MAX_RECORDING_BYTES = 25_000_000;
const CATALOG_TIMEOUT_MS = 8000;
const POLL_TIMEOUT_MS = 30_000;
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export type TranscriptionDeps = { pollIntervalMs?: number };

/** `en` or `en-US` becomes `en`; the route takes a two-letter ISO 639-1 code. */
function languageCode(value: string | undefined): string | undefined {
  const text = value?.trim().toLowerCase();
  if (!text) return undefined;
  const code = /^([a-z]{2})(?:[-_][a-z0-9]+)*$/.exec(text)?.[1];
  if (!code) throw new Error(`BeLive AI Hub transcription takes a two-letter language code such as "en"; got "${value}"`);
  return code;
}

/** Everything a refusal can come from. Nothing here uploads audio, so a failure is safe for the host to move past. */
async function prepare(ctx: Context) {
  const baseUrl = officialBaseUrl(ctx.baseUrl ?? BASE_URL);
  const bytes = ctx.buffer;
  if (bytes.length < 1) throw new Error("BeLive AI Hub transcription needs a non-empty recording");
  if (bytes.length > MAX_RECORDING_BYTES) {
    throw new Error(`BeLive AI Hub transcription takes a recording of at most ${MAX_RECORDING_BYTES} bytes; this one has ${bytes.length}`);
  }
  const type = sniffTranscriptionAudio(bytes);
  if (!type) throw new Error("BeLive AI Hub transcription takes MP3 or WAV recordings only; convert the file first");
  const language = languageCode(ctx.language);
  const apiKey = await resolveApiKey(ctx.cfg, ctx.agentDir);
  const model = ctx.model?.trim() || DEFAULT_TRANSCRIPTION_MODEL;
  const offered = (await fetchTranscriptionModels(baseUrl, apiKey, { timeoutMs: CATALOG_TIMEOUT_MS, signal: ctx.signal })).map(row => row.id);
  if (!offered.includes(model)) {
    throw new Error(`BeLive AI Hub does not list ${model} as a transcription model. Offered: ${offered.join(", ") || "none"}`);
  }
  return { baseUrl, apiKey, model, language, bytes, type };
}

type Job = { id: string; status: string; text?: string; message?: string };

function readJob(payload: unknown): Job | undefined {
  const job = record(payload);
  if (typeof job?.id !== "string" || !JOB_ID.test(job.id) || typeof job.status !== "string") return undefined;
  const error = record(job.error)?.message;
  const text = record(job.transcript)?.text;
  return {
    id: job.id, status: job.status,
    ...(typeof text === "string" ? { text } : {}),
    ...(typeof error === "string" ? { message: error.slice(0, 300) } : {}),
  };
}

/**
 * Speech to text for BeLive AI Hub: a multipart `POST /audio/transcriptions` with `file`, `model` and
 * an optional `language`. A short recording is answered with `{ text }`. A long-recording model
 * answers with a job after about a minute; the job is then read, never resubmitted, until the
 * caller's timeout, because every upload is a new charge.
 */
export function createTranscription(deps: TranscriptionDeps = {}): Pick<MediaUnderstandingProviderPlugin, "isAudioConfigured" | "transcribeAudioWithContext"> {
  const pollIntervalMs = deps.pollIntervalMs ?? 2000;

  async function finish(first: unknown, plan: Awaited<ReturnType<typeof prepare>>, ctx: Context, started: number) {
    const { baseUrl, apiKey, model } = plan;
    const lost = (detail: string) => new Error(`BeLive AI Hub transcription ${detail}; the request may have been charged, so check Activity before retrying`);
    const direct = record(first)?.text;
    if (typeof direct === "string") return { text: direct, model };
    let job = readJob(first);
    if (!job) throw lost("returned a response that was not understood");
    const deadline = started + ctx.timeoutMs;
    for (;;) {
      if (job.status === "completed") {
        if (job.text === undefined) throw lost("finished without text");
        return { text: job.text, model };
      }
      if (job.status === "failed" || job.status === "expired") {
        throw new Error(`BeLive AI Hub transcription ${job.status}${job.message ? `: ${job.message}` : ""}`);
      }
      if (job.status !== "pending" && job.status !== "in_progress") throw lost(`returned job status "${job.status}"`);
      if (ctx.signal?.aborted) throw new Error("BeLive AI Hub transcription was cancelled");
      if (Date.now() + pollIntervalMs >= deadline) {
        throw new Error(`BeLive AI Hub transcription job ${job.id} was still running when the ${Math.round(ctx.timeoutMs / 1000)} s timeout ended; `
          + `it may be charged. Read it with GET /audio/transcriptions/${job.id} or raise the audio timeout; do not upload the recording again`);
      }
      await wait(pollIntervalMs);
      const next = readJob(await fetchJson(`${baseUrl}/audio/transcriptions/${job.id}`, { headers: bearer(apiKey) }, "transcription job lookup",
        { timeoutMs: Math.max(1000, Math.min(POLL_TIMEOUT_MS, deadline - Date.now())), signal: ctx.signal }));
      if (!next || next.id !== job.id) throw lost("returned a job response that was not understood");
      job = next;
    }
  }

  return {
    isAudioConfigured: ({ cfg, agentDir }) => isConfigured({ cfg, agentDir }),
    async transcribeAudioWithContext(ctx) {
      let plan: Awaited<ReturnType<typeof prepare>>;
      try {
        plan = await prepare(ctx);
      } catch (error) {
        // A rejection before any upload: the host may try another provider the user configured.
        return { ok: false, error };
      }
      const started = Date.now();
      const form = new FormData();
      form.set("model", plan.model);
      if (plan.language) form.set("language", plan.language);
      form.set("file", new Blob([new Uint8Array(plan.bytes)], { type: plan.type }), plan.type === "audio/wav" ? "recording.wav" : "recording.mp3");
      // The one paid request. A refusal (400) or any other failure throws and is never retried here.
      const first = await fetchJson(`${plan.baseUrl}/audio/transcriptions`, { method: "POST", headers: bearer(plan.apiKey), body: form },
        "transcription", { timeoutMs: ctx.timeoutMs, signal: ctx.signal });
      return { ok: true, value: await finish(first, plan, ctx, started) };
    },
  };
}
