import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

// Isolate the host's auth store and state from the developer's real OpenClaw home before it is used.
const home = mkdtempSync(path.join(tmpdir(), "belive-media-"));
process.env.OPENCLAW_STATE_DIR = path.join(home, "state");
const { upsertAuthProfileAsync } = await import("openclaw/plugin-sdk/provider-auth");
const plugin = (await import("../dist/index.js")).default;
const { STAGING_URL, BASE_URL, KEY_ENV, PROVIDER_ID } = await import("../dist/catalog.js");
const { imageGeometry } = await import("../dist/image.js");
const { createVideoProvider, fileJobStore, deadlineMs, MIN_DEADLINE_MS, videoBody } = await import("../dist/video.js");
const { mapImageModels, mapVideoModels, mapSpeechModels } = await import("../dist/media-catalog.js");
const { fakeApi, routedFetch, json, PNG_BASE64, MP4_BYTES, WAV_BYTES } = await import("./helpers.mjs");

after(() => rmSync(home, { recursive: true, force: true }));

const SECRET = "fixture-belive-secret";
const DECOYS = { OPENAI_API_KEY: "decoy-openai", OPENROUTER_API_KEY: "decoy-openrouter", LITELLM_API_KEY: "decoy-litellm", TOKENHUB_API_KEY: "decoy-tokenhub" };
const cfg = { models: { providers: { [PROVIDER_ID]: { baseUrl: STAGING_URL } } } };
let agentDir;

beforeEach(() => {
  agentDir = mkdtempSync(path.join(home, "agent-"));
  delete process.env[KEY_ENV];
  Object.assign(process.env, DECOYS);
});

function setup() {
  const { api, registered } = fakeApi(path.join(home, "plugin-state-" + Math.random().toString(36).slice(2)));
  plugin.register(api);
  return registered;
}

const catalogRow = (id, route, extra = {}) => ({
  id, name: id, architecture: { input_modalities: ["text"], output_modalities: ["image"] },
  supported_parameters: [], endpoints: [{ route, status: "ready" }], ...extra,
});
const imageRow = (id = "qwen/img", { refs = false } = {}) => catalogRow(id, "image_generations", {
  architecture: { input_modalities: refs ? ["text", "image"] : ["text"], output_modalities: ["image"] },
  supported_parameters: refs ? ["input_references"] : [],
  tokenhub_image_options: { sizes: [
    { aspect_ratio: "1:1", resolution: "1K", size: "1024x1024" },
    { aspect_ratio: "16:9", resolution: "1K", size: "1360x768" },
    { aspect_ratio: "1:1", resolution: "2K", size: "2048x2048" },
  ] },
});
const videoRow = (id = "alibaba/wan", extra = {}) => catalogRow(id, "video_generations", {
  supported_resolutions: ["480p", "720p"], supported_aspect_ratios: ["16:9", "9:16"], supported_durations: [2, 3, 4],
  supported_frame_images: [], supported_parameters: ["prompt", "duration", "resolution", "aspect_ratio", "seed"], ...extra,
});

const authorizations = calls => calls.map(call => call.headers.get("authorization"));
const noDecoys = calls => assert.ok(authorizations(calls).every(value => value === null || value === `Bearer ${SECRET}`));

// ---------------------------------------------------------------- registration

test("registers each capability under belive-aihub only, matching the manifest contracts", () => {
  const registered = setup();
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(registered.image.map(row => row.id), manifest.contracts.imageGenerationProviders);
  assert.deepEqual(registered.video.map(row => row.id), manifest.contracts.videoGenerationProviders);
  assert.deepEqual(registered.speech.map(row => row.id), manifest.contracts.speechProviders);
  assert.deepEqual(registered.understanding.map(row => row.id), manifest.contracts.mediaUnderstandingProviders);
  for (const rows of [registered.image, registered.video, registered.speech, registered.understanding]) {
    assert.deepEqual(rows.map(row => row.id), [PROVIDER_ID]);
  }
  assert.ok(registered.video[0].defaultTimeoutMs >= 15 * 60_000);
  assert.deepEqual(registered.catalogs.flatMap(row => row.kinds).sort(), ["image_generation", "text", "video_generation", "voice"]);
});

test("media pickers list the live catalogues and return nothing without a key", async t => {
  const registered = setup();
  const { mock, calls } = routedFetch([
    { method: "GET", match: "/images/models", respond: () => json({ data: [imageRow("a/one")] }) },
    { method: "GET", match: "/videos/models", respond: () => json({ data: [videoRow("a/clip")] }) },
    { method: "GET", match: "/models?output_modalities=audio", respond: () => json({ data: [catalogRow("a/tts", "audio_speech"), catalogRow("a/music", "audio_generations")] }) },
  ]);
  t.mock.method(globalThis, "fetch", mock);
  const ctx = (discoveryApiKey) => ({ config: cfg, resolveProviderApiKey: () => ({ apiKey: KEY_ENV, discoveryApiKey }) });
  const byKind = Object.fromEntries(registered.catalogs.map(row => [row.kinds[0], row]));
  const rows = await Promise.all(["image_generation", "video_generation", "voice"].map(kind => byKind[kind].liveCatalog(ctx(SECRET))));
  assert.deepEqual(rows.map(list => list.map(row => row.model)), [["a/one"], ["a/clip"], ["a/tts"]]);
  assert.deepEqual(rows[1][0].capabilities.generate.supportedDurationSeconds, [2, 3, 4]);
  assert.ok(rows.flat().every(row => row.provider === PROVIDER_ID && row.source === "live"));
  assert.deepEqual(authorizations(calls), Array(3).fill(`Bearer ${SECRET}`));
  for (const kind of ["image_generation", "video_generation", "voice"]) assert.equal(await byKind[kind].liveCatalog(ctx(null)), null);
  assert.equal(calls.length, 3);
});

test("catalogue mappers keep only ready rows on the right route", () => {
  assert.deepEqual(mapImageModels({ data: [imageRow("a/ok"), { ...imageRow("a/down"), endpoints: [{ route: "image_generations", status: "down" }] }, videoRow("a/wrong")] }).map(row => row.id), ["a/ok"]);
  assert.deepEqual(mapVideoModels({ data: [videoRow("a/ok"), imageRow("a/wrong")] }).map(row => row.id), ["a/ok"]);
  assert.deepEqual(mapSpeechModels({ data: [catalogRow("a/ok", "audio_speech"), catalogRow("a/chat", "chat_completions")] }).map(row => row.id), ["a/ok"]);
  assert.throws(() => mapImageModels({ data: null }), /Invalid/);
});

// ---------------------------------------------------------------- credentials

test("an env-backed key authenticates every media call; the env name and other providers' keys never do", async t => {
  process.env[KEY_ENV] = SECRET;
  const { image, speech } = setup();
  const { mock, calls } = routedFetch([
    { method: "GET", match: "/images/models", respond: () => json({ data: [imageRow()] }) },
    { method: "POST", match: "/images/generations", respond: () => json({ data: [{ b64_json: PNG_BASE64 }] }) },
    { method: "POST", match: "/audio/speech", respond: () => new Response(WAV_BYTES) },
  ]);
  t.mock.method(globalThis, "fetch", mock);
  // The config-safe value the chat catalogue stores is the env var's name, which must never be sent.
  const withMarker = { models: { providers: { [PROVIDER_ID]: { baseUrl: STAGING_URL, apiKey: KEY_ENV } } } };
  await image[0].generateImage({ provider: PROVIDER_ID, model: "qwen/img", prompt: "x", cfg: withMarker, agentDir });
  await speech[0].synthesize({ text: "hello", cfg: withMarker, providerConfig: {}, target: "audio-file", timeoutMs: 5000 });
  assert.equal(calls.length, 3);
  noDecoys(calls);
  assert.deepEqual(new Set(authorizations(calls)), new Set([`Bearer ${SECRET}`]));
});

test("a pasted key saved in the BeLive auth profile is used, and wins over the environment", async t => {
  await upsertAuthProfileAsync({ profileId: `${PROVIDER_ID}:default`, credential: { type: "api_key", provider: PROVIDER_ID, key: "fixture-pasted-key" }, agentDir });
  process.env[KEY_ENV] = SECRET;
  const { image } = setup();
  const { mock, calls } = routedFetch([
    { method: "GET", match: "/images/models", respond: () => json({ data: [imageRow()] }) },
    { method: "POST", match: "/images/generations", respond: () => json({ data: [{ b64_json: PNG_BASE64 }] }) },
  ]);
  t.mock.method(globalThis, "fetch", mock);
  await image[0].generateImage({ provider: PROVIDER_ID, model: "qwen/img", prompt: "x", cfg, agentDir });
  assert.deepEqual(new Set(authorizations(calls)), new Set(["Bearer fixture-pasted-key"]));
  const configured = await image[0].isConfiguredAsync({ cfg, agentDir });
  assert.equal(configured, true);
});

test("another provider's credential is never used: with no BeLive key every capability refuses before a request", async t => {
  for (const provider of ["openrouter", "openai", "litellm"]) {
    await upsertAuthProfileAsync({ profileId: `${provider}:default`, credential: { type: "api_key", provider, key: `decoy-profile-${provider}` }, agentDir });
  }
  const registered = setup();
  t.mock.method(globalThis, "fetch", () => assert.fail("No request may be issued without a BeLive AI Hub key"));
  const pattern = new RegExp(KEY_ENV);
  await assert.rejects(registered.image[0].generateImage({ provider: PROVIDER_ID, model: "qwen/img", prompt: "x", cfg, agentDir }), pattern);
  await assert.rejects(registered.video[0].generateVideo({ provider: PROVIDER_ID, model: "alibaba/wan", prompt: "x", cfg, agentDir }), pattern);
  await assert.rejects(registered.speech[0].synthesize({ text: "hi", cfg, providerConfig: {}, target: "audio-file", timeoutMs: 5000 }), pattern);
  assert.equal(await registered.video[0].resolveModelCapabilities({ provider: PROVIDER_ID, model: "alibaba/wan", cfg, agentDir }), undefined);
});

test("the plugin points only at official base URLs", async t => {
  process.env[KEY_ENV] = SECRET;
  const { image } = setup();
  t.mock.method(globalThis, "fetch", () => assert.fail("Must not issue a request"));
  const evil = { models: { providers: { [PROVIDER_ID]: { baseUrl: "https://evil.invalid/api/v1" } } } };
  await assert.rejects(image[0].generateImage({ provider: PROVIDER_ID, model: "x/y", prompt: "x", cfg: evil, agentDir }), /official/);
  assert.equal(BASE_URL.startsWith("https://tokenhub-api.belive.sg"), true);
});

// ---------------------------------------------------------------- images

test("image generation sends the model's own geometry, decodes the bytes and reports the real type", async t => {
  process.env[KEY_ENV] = SECRET;
  const { image } = setup();
  const { mock, calls } = routedFetch([
    { method: "GET", match: "/images/models", respond: () => json({ data: [imageRow()] }) },
    { method: "POST", match: "/images/generations", respond: () => json({ data: [{ b64_json: PNG_BASE64, revised_prompt: "y" }] }) },
  ]);
  t.mock.method(globalThis, "fetch", mock);
  const result = await image[0].generateImage({ provider: PROVIDER_ID, model: "qwen/img", prompt: "a red apple", cfg, agentDir, size: "1360x768" });
  const post = calls.find(call => call.method === "POST");
  assert.equal(post.url, STAGING_URL + "/images/generations");
  assert.deepEqual(JSON.parse(post.body), { model: "qwen/img", prompt: "a red apple", size: "1360x768" });
  assert.equal(result.images[0].mimeType, "image/png");
  assert.equal(result.images[0].fileName, "image.png");
  assert.equal(result.images[0].revisedPrompt, "y");
  assert.equal(result.images[0].buffer.subarray(1, 4).toString(), "PNG");
  // With no geometry requested the body carries none, so the model's default is used.
  await image[0].generateImage({ provider: PROVIDER_ID, model: "qwen/img", prompt: "p", cfg, agentDir });
  assert.deepEqual(JSON.parse(calls.filter(call => call.method === "POST").at(-1).body), { model: "qwen/img", prompt: "p" });
});

test("unsupported image options are refused before the paid call", async t => {
  process.env[KEY_ENV] = SECRET;
  const { image } = setup();
  const { mock, calls } = routedFetch([
    { method: "GET", match: "/images/models", respond: () => json({ data: [imageRow("a/plain"), imageRow("a/edit", { refs: true })] }) },
  ]);
  t.mock.method(globalThis, "fetch", mock);
  const base = { provider: PROVIDER_ID, prompt: "x", cfg, agentDir };
  await assert.rejects(image[0].generateImage({ ...base, model: "a/plain", size: "999x999" }), /does not offer size 999x999\. Offered: 1024x1024 \(1:1, 1K\)/);
  await assert.rejects(image[0].generateImage({ ...base, model: "a/plain", aspectRatio: "3:2" }), /does not offer 3:2/);
  await assert.rejects(image[0].generateImage({ ...base, model: "a/plain", size: "1024x1024", resolution: "2K" }), /together with 2K/);
  await assert.rejects(image[0].generateImage({ ...base, model: "a/plain", count: 2 }), /one image per request/);
  await assert.rejects(image[0].generateImage({ ...base, model: "a/missing" }), /does not list an image generation model named a\/missing/);
  await assert.rejects(image[0].generateImage({ ...base, model: "a/plain", inputImages: [{ buffer: Buffer.from(PNG_BASE64, "base64"), mimeType: "image/png" }] }), /does not accept reference images/);
  await assert.rejects(image[0].generateImage({ ...base, model: "a/edit", inputImages: [{ buffer: Buffer.from("not an image"), mimeType: "image/png" }] }), /PNG, JPEG or WebP/);
  assert.equal(calls.filter(call => call.method === "POST").length, 0);
  assert.deepEqual(imageGeometry(mapImageModels({ data: [imageRow()] })[0], { aspectRatio: "16:9", resolution: "1K" }), { aspect_ratio: "16:9", resolution: "1K" });
});

test("reference images go to models that take them, as data URIs", async t => {
  process.env[KEY_ENV] = SECRET;
  const { image } = setup();
  const { mock, calls } = routedFetch([
    { method: "GET", match: "/images/models", respond: () => json({ data: [imageRow("a/edit", { refs: true })] }) },
    { method: "POST", match: "/images/generations", respond: () => json({ data: [{ b64_json: PNG_BASE64 }] }) },
  ]);
  t.mock.method(globalThis, "fetch", mock);
  await image[0].generateImage({ provider: PROVIDER_ID, model: "a/edit", prompt: "edit", cfg, agentDir, inputImages: [{ buffer: Buffer.from(PNG_BASE64, "base64"), mimeType: "image/png" }] });
  const body = JSON.parse(calls.find(call => call.method === "POST").body);
  assert.equal(body.input_references[0].image_url.url, `data:image/png;base64,${PNG_BASE64}`);
});

test("image errors keep the gateway's message but never the key, and an unusable body is flagged as possibly charged", async t => {
  process.env[KEY_ENV] = SECRET;
  const { image } = setup();
  let reply = () => json({ error: { message: "size not offered" } }, 400);
  const { mock, calls } = routedFetch([
    { method: "GET", match: "/images/models", respond: () => json({ data: [imageRow()] }) },
    { method: "POST", match: "/images/generations", respond: () => reply() },
  ]);
  t.mock.method(globalThis, "fetch", mock);
  const req = { provider: PROVIDER_ID, model: "qwen/img", prompt: "x", cfg, agentDir };
  const failure = await image[0].generateImage(req).catch(error => error);
  assert.match(failure.message, /^BeLive AI Hub image generation returned HTTP 400: size not offered$/);
  assert.ok(!failure.message.includes(SECRET));
  reply = () => json({ data: [{ b64_json: Buffer.from("garbage").toString("base64") }] });
  await assert.rejects(image[0].generateImage(req), /may have been charged/);
  // A failed paid request is never resubmitted by the plugin.
  assert.equal(calls.filter(call => call.method === "POST").length, 2);
});

// ---------------------------------------------------------------- video

function videoSetup(t, routes, options = {}) {
  process.env[KEY_ENV] = SECRET;
  const jobsDir = path.join(home, "jobs-" + Math.random().toString(36).slice(2));
  const jobs = fileJobStore(() => jobsDir);
  const provider = createVideoProvider({ jobs, pollIntervalMs: 1, backoffMs: 1, ...options });
  const { mock, calls } = routedFetch([
    { method: "GET", match: "/videos/models", respond: () => json({ data: [videoRow(), videoRow("a/audio", { supported_parameters: ["prompt", "generate_audio", "frame_images"], supported_frame_images: ["first_frame"] })] }) },
    ...routes,
  ]);
  t.mock.method(globalThis, "fetch", mock);
  const files = () => { try { return readdirSync(jobsDir); } catch { return []; } };
  return { provider, calls, jobsDir, files, request: (extra = {}) => ({ provider: PROVIDER_ID, model: "alibaba/wan", prompt: "a balloon", cfg, agentDir, durationSeconds: 2, resolution: "480P", ...extra }) };
}
const posts = calls => calls.filter(call => call.method === "POST");
const sequence = (...responses) => { let index = 0; return () => { const next = responses[Math.min(index++, responses.length - 1)]; return typeof next === "function" ? next() : next; }; };

test("video: submits once with an Idempotency-Key, polls to completion, downloads the mp4 and clears its record", async t => {
  const { provider, calls, files, request } = videoSetup(t, [
    { method: "POST", match: "/videos", respond: () => json({ id: "job_1", status: "pending" }, 202) },
    { method: "GET", match: "/videos/job_1/content", respond: () => new Response(MP4_BYTES, { headers: { "content-type": "video/mp4" } }) },
    { method: "GET", match: "/videos/job_1", respond: sequence(json({ id: "job_1", status: "pending", queued: true }), json({ id: "job_1", status: "in_progress" }), json({ id: "job_1", status: "completed", generation_id: "req_1", usage: { tokenhub_cost: "0.07" } })) },
  ]);
  const result = await provider.generateVideo(request());
  const [post] = posts(calls);
  assert.equal(post.url, STAGING_URL + "/videos");
  assert.match(post.headers.get("idempotency-key"), /^[0-9a-f-]{36}$/);
  assert.deepEqual(JSON.parse(post.body), { model: "alibaba/wan", prompt: "a balloon", duration: 2, resolution: "480p" });
  assert.equal(calls.filter(call => call.url.includes("/videos/job_1") && !call.url.includes("content")).length, 3);
  assert.deepEqual(result.videos[0].buffer, MP4_BYTES);
  assert.equal(result.videos[0].mimeType, "video/mp4");
  assert.deepEqual(result.metadata, { jobId: "job_1", generationId: "req_1", usage: { tokenhub_cost: "0.07" } });
  assert.deepEqual(files(), []);
  assert.ok(calls.every(call => call.headers.get("authorization") === null || call.headers.get("authorization") === `Bearer ${SECRET}`));
});

test("video: an uncertain submit is retried with the same Idempotency-Key, and a rerun after the error reuses it", async t => {
  const submit = sequence(json({ error: { message: "upstream hiccup" } }, 502), new Error("socket closed"), json({ error: { message: "still down" } }, 503), json({ id: "job_2", status: "pending" }, 202));
  const { provider, calls, files, request } = videoSetup(t, [
    { method: "GET", match: "idempotency_key=", respond: () => json({ error: { message: "no video job for this Idempotency-Key" } }, 404) },
    { method: "POST", match: "/videos", respond: submit },
    { method: "GET", match: "/videos/job_2/content", respond: () => new Response(MP4_BYTES) },
    { method: "GET", match: "/videos/job_2", respond: () => json({ id: "job_2", status: "completed" }) },
  ]);
  // Three attempts all fail; the saved record keeps the key for the rerun.
  await assert.rejects(provider.generateVideo(request()), /HTTP 503.*run the same request again/s);
  assert.equal(files().length, 1);
  const result = await provider.generateVideo(request());
  assert.equal(result.metadata.jobId, "job_2");
  const keys = posts(calls).map(call => call.headers.get("idempotency-key"));
  assert.equal(keys.length, 4);
  assert.equal(new Set(keys).size, 1, "every submit of one request carries the same Idempotency-Key");
  assert.deepEqual(files(), []);
});

test("video: a rerun after an unknown submit outcome finds the job by its key instead of submitting again", async t => {
  let known = false;
  const { provider, calls, request } = videoSetup(t, [
    { method: "GET", match: "idempotency_key=", respond: () => known ? json({ id: "job_3", status: "in_progress" }) : json({ error: { message: "no video job" } }, 404) },
    { method: "POST", match: "/videos", respond: () => new Error("connection reset") },
    { method: "GET", match: "/videos/job_3/content", respond: () => new Response(MP4_BYTES) },
    { method: "GET", match: "/videos/job_3", respond: () => json({ id: "job_3", status: "completed" }) },
  ]);
  await assert.rejects(provider.generateVideo(request()), /network error.*the saved Idempotency-Key reconciles it/s);
  const sent = posts(calls).map(call => call.headers.get("idempotency-key"));
  assert.equal(sent.length, 3);
  // The server did create the job after all; the rerun must find it by the same key.
  known = true;
  const result = await provider.generateVideo(request());
  assert.equal(result.metadata.jobId, "job_3");
  assert.equal(posts(calls).length, 3, "the rerun submitted nothing");
  const lookups = calls.filter(call => call.url.includes("idempotency_key="));
  assert.equal(new URL(lookups.at(-1).url).searchParams.get("idempotency_key"), sent[0]);
});

test("video: resume after a poll timeout reuses the saved job and never posts again", async t => {
  let status = "in_progress";
  const { provider, calls, files, request } = videoSetup(t, [
    { method: "POST", match: "/videos", respond: () => json({ id: "job_4", status: "pending" }, 202) },
    { method: "GET", match: "/videos/job_4/content", respond: () => new Response(MP4_BYTES) },
    { method: "GET", match: "/videos/job_4", respond: () => json({ id: "job_4", status }) },
  ], { minDeadlineMs: 30 });
  await assert.rejects(provider.generateVideo(request()), /job_4 was still running.*has not been cancelled.*resume it; no second job/s);
  assert.equal(files().length, 1);
  status = "completed";
  const result = await provider.generateVideo(request());
  assert.equal(result.metadata.jobId, "job_4");
  assert.equal(posts(calls).length, 1, "the resumed call only polls and downloads");
  assert.deepEqual(files(), []);
});

test("video: the wait is never shorter than fifteen minutes", () => {
  assert.equal(MIN_DEADLINE_MS, 15 * 60_000);
  assert.equal(deadlineMs(undefined), 900_000);
  assert.equal(deadlineMs(60_000), 900_000);
  assert.equal(deadlineMs(30 * 60_000), 1_800_000);
});

test("video: failed, cancelled and expired jobs end the call, drop the record, and a rerun is a new job with a new key", async t => {
  for (const terminal of ["failed", "cancelled", "expired"]) {
    const { provider, calls, files, request } = videoSetup(t, [
      { method: "POST", match: "/videos", respond: () => json({ id: `job_${terminal}`, status: "pending" }, 202) },
      { method: "GET", match: "/videos/job_", respond: () => json({ id: `job_${terminal}`, status: terminal, error: { code: "upstream_error", message: "model refused" } }) },
    ]);
    await assert.rejects(provider.generateVideo(request()), new RegExp(`job_${terminal} ${terminal}: model refused`));
    assert.deepEqual(files(), []);
    await assert.rejects(provider.generateVideo(request()));
    const keys = posts(calls).map(call => call.headers.get("idempotency-key"));
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
    t.mock.restoreAll();
  }
});

test("video: a refused submit (400) is not retried and leaves no record", async t => {
  const { provider, calls, files, request } = videoSetup(t, [
    { method: "POST", match: "/videos", respond: () => json({ error: { message: "unsupported_parameter: seed" } }, 400) },
  ]);
  await assert.rejects(provider.generateVideo(request()), /HTTP 400: unsupported_parameter: seed/);
  assert.equal(posts(calls).length, 1);
  assert.deepEqual(files(), []);
});

test("video: unsupported options are refused before any paid call", async t => {
  const { provider, calls, files, request } = videoSetup(t, []);
  await assert.rejects(provider.generateVideo(request({ durationSeconds: 9 })), /does not support a 9 s duration\. Offered: 2, 3, 4/);
  await assert.rejects(provider.generateVideo(request({ resolution: "1080P" })), /does not support 1080P resolution\. Offered: 480p, 720p/);
  await assert.rejects(provider.generateVideo(request({ aspectRatio: "1:1" })), /does not support aspect ratio 1:1/);
  await assert.rejects(provider.generateVideo(request({ audio: true })), /does not support audio/);
  await assert.rejects(provider.generateVideo(request({ providerOptions: { seed: 1.5 } })), /does not support this seed/);
  await assert.rejects(provider.generateVideo(request({ inputVideos: [{ url: "https://example.com/a.mp4" }] })), /video or audio reference inputs/);
  await assert.rejects(provider.generateVideo(request({ inputImages: [{ buffer: Buffer.from(PNG_BASE64, "base64") }] })), /does not support reference images/);
  await assert.rejects(provider.generateVideo(request({ model: "a/missing" })), /does not list a video generation model named a\/missing/);
  assert.equal(posts(calls).length, 0);
  assert.deepEqual(files(), []);
});

test("video: frame images are sent only to models that offer the role", () => {
  const [plain, framed] = mapVideoModels({ data: [videoRow(), videoRow("a/frame", { supported_frame_images: ["first_frame"], architecture: { input_modalities: ["text", "image"], output_modalities: ["video"] } })] });
  const image = { buffer: Buffer.from(PNG_BASE64, "base64"), role: "first_frame" };
  assert.throws(() => videoBody(plain, { prompt: "x", inputImages: [image] }), /does not support a first_frame image/);
  assert.throws(() => videoBody(framed, { prompt: "x", inputImages: [{ ...image, role: "last_frame" }] }), /does not support a last_frame image/);
  const body = videoBody(framed, { prompt: "x", inputImages: [{ buffer: Buffer.from(PNG_BASE64, "base64") }] });
  assert.equal(body.frame_images[0].frame_type, "first_frame");
  assert.match(body.frame_images[0].image_url.url, /^data:image\/png;base64,/);
  assert.throws(() => videoBody(framed, { prompt: "x", inputImages: [{ url: "http://insecure.example/a.png" }] }), /HTTPS URL or image bytes/);
});

test("video: the content redirect is followed without the AI Hub key", async t => {
  const { provider, calls, request } = videoSetup(t, [
    { method: "POST", match: "/videos", respond: () => json({ id: "job_5", status: "pending" }, 202) },
    { method: "GET", match: "/videos/job_5/content", respond: () => new Response(null, { status: 302, headers: { location: "https://cdn.example.com/v.mp4?sig=1" } }) },
    { method: "GET", match: "cdn.example.com", respond: () => new Response(MP4_BYTES) },
    { method: "GET", match: "/videos/job_5", respond: () => json({ id: "job_5", status: "completed" }) },
  ]);
  const result = await provider.generateVideo(request());
  assert.deepEqual(result.videos[0].buffer, MP4_BYTES);
  const cdn = calls.find(call => call.url.includes("cdn.example.com"));
  assert.equal(cdn.headers.get("authorization"), null);
  assert.equal(calls.find(call => call.url.includes("/content")).redirect, "manual");
});

test("video: a download that is not an mp4 fails, and keeps the finished job for a free rerun", async t => {
  let content = () => new Response("<html>oops</html>");
  const { provider, calls, files, request } = videoSetup(t, [
    { method: "POST", match: "/videos", respond: () => json({ id: "job_6", status: "pending" }, 202) },
    { method: "GET", match: "/videos/job_6/content", respond: () => content() },
    { method: "GET", match: "/videos/job_6", respond: () => json({ id: "job_6", status: "completed" }) },
  ]);
  await assert.rejects(provider.generateVideo(request()), /not an MP4 file.*without a new charge/s);
  assert.equal(files().length, 1);
  content = () => new Response(MP4_BYTES);
  await provider.generateVideo(request());
  assert.equal(posts(calls).length, 1);
});

test("video: capabilities come from the live catalogue per model", async t => {
  const { provider } = videoSetup(t, []);
  const caps = await provider.resolveModelCapabilities({ provider: PROVIDER_ID, model: "alibaba/wan", cfg, agentDir });
  assert.deepEqual(caps.generate.supportedDurationSeconds, [2, 3, 4]);
  assert.deepEqual(caps.generate.resolutions, ["480P", "720P"]);
  assert.equal(caps.generate.supportsAudio, false);
  assert.equal(caps.imageToVideo.enabled, false);
  assert.equal(caps.videoToVideo.enabled, false);
  const audio = await provider.resolveModelCapabilities({ provider: PROVIDER_ID, model: "a/audio", cfg, agentDir });
  assert.equal(audio.generate.supportsAudio, true);
  assert.equal(audio.imageToVideo.enabled, true);
  assert.equal(await provider.resolveModelCapabilities({ provider: PROVIDER_ID, model: "a/none", cfg, agentDir }), undefined);
});

// ---------------------------------------------------------------- speech

test("speech asks for WAV by default and validates the audio it gets back", async t => {
  process.env[KEY_ENV] = SECRET;
  const { speech } = setup();
  const provider = speech[0];
  const { mock, calls } = routedFetch([{ method: "POST", match: "/audio/speech", respond: () => new Response(WAV_BYTES, { headers: { "content-type": "audio/wav" } }) }]);
  t.mock.method(globalThis, "fetch", mock);
  const providerConfig = provider.resolveConfig({ cfg, rawConfig: { providers: { [PROVIDER_ID]: { model: "qwen/qwen-audio-3.0-tts-plus", voice: "longanlingxin" } } }, timeoutMs: 1000 });
  assert.deepEqual(providerConfig, { model: "qwen/qwen-audio-3.0-tts-plus", voice: "longanlingxin", responseFormat: "wav" });
  const result = await provider.synthesize({ text: "Hello from AI Hub.", cfg, providerConfig, target: "audio-file", timeoutMs: 5000 });
  assert.deepEqual(JSON.parse(calls[0].body), { model: "qwen/qwen-audio-3.0-tts-plus", input: "Hello from AI Hub.", voice: "longanlingxin", response_format: "wav" });
  assert.equal(calls[0].url, STAGING_URL + "/audio/speech");
  assert.deepEqual([result.outputFormat, result.fileExtension, result.audioBuffer.length], ["wav", ".wav", WAV_BYTES.length]);
  // Per-message overrides from the host take precedence over config.
  await provider.synthesize({ text: "hi", cfg, providerConfig, target: "audio-file", timeoutMs: 5000, providerOverrides: { model: "google/chirp-3-hd", voice: "en-US-Chirp3-HD-Aoede" } });
  assert.deepEqual([JSON.parse(calls[1].body).model, JSON.parse(calls[1].body).voice], ["google/chirp-3-hd", "en-US-Chirp3-HD-Aoede"]);
});

test("speech refuses unsupported options before the paid call and flags non-audio answers", async t => {
  process.env[KEY_ENV] = SECRET;
  const { speech } = setup();
  const provider = speech[0];
  let body = () => new Response("not audio");
  const { mock, calls } = routedFetch([{ method: "POST", match: "/audio/speech", respond: () => body() }]);
  t.mock.method(globalThis, "fetch", mock);
  const base = { cfg, target: "audio-file", timeoutMs: 5000 };
  await assert.rejects(provider.synthesize({ ...base, text: "x".repeat(601), providerConfig: {} }), /1 to 600 characters.*has 601/);
  await assert.rejects(provider.synthesize({ ...base, text: "", providerConfig: {} }), /1 to 600 characters/);
  await assert.rejects(provider.synthesize({ ...base, text: "hi", providerConfig: { responseFormat: "ogg" } }), /returns mp3, opus, aac, flac, wav, pcm only; responseFormat "ogg" is not available/);
  assert.equal(calls.length, 0);
  await assert.rejects(provider.synthesize({ ...base, text: "hi", providerConfig: {} }), /did not return WAV audio; the request may have been charged/);
  // A 600-character text is within the limit even when it is made of multi-unit characters.
  body = () => new Response(WAV_BYTES);
  await provider.synthesize({ ...base, text: "语".repeat(600), providerConfig: {} });
  assert.equal(calls.length, 2);
});

test("speech offers mp3, opus, aac, flac, wav and pcm, sends the chosen one and checks the bytes match it", async t => {
  process.env[KEY_ENV] = SECRET;
  const { speech } = setup();
  const provider = speech[0];
  const samples = {
    mp3: Buffer.concat([Buffer.from("ID3"), Buffer.alloc(20)]),
    opus: Buffer.concat([Buffer.from("OggS"), Buffer.alloc(24), Buffer.from("OpusHead"), Buffer.alloc(20)]),
    aac: Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc, 0x21, 0x00]),
    flac: Buffer.concat([Buffer.from("fLaC"), Buffer.alloc(20)]),
    wav: WAV_BYTES,
    pcm: Buffer.alloc(64, 7),
  };
  let reply = samples.wav;
  const { mock, calls } = routedFetch([{ method: "POST", match: "/audio/speech", respond: () => new Response(reply) }]);
  t.mock.method(globalThis, "fetch", mock);
  const base = { cfg, target: "audio-file", timeoutMs: 5000, text: "hi" };
  for (const [format, bytes] of Object.entries(samples)) {
    reply = bytes;
    const providerConfig = provider.resolveConfig({ cfg, rawConfig: { providers: { [PROVIDER_ID]: { responseFormat: format.toUpperCase() } } }, timeoutMs: 1000 });
    const result = await provider.synthesize({ ...base, providerConfig });
    assert.equal(JSON.parse(calls.at(-1).body).response_format, format);
    assert.deepEqual([result.outputFormat, result.fileExtension, result.audioBuffer.length], [format, `.${format}`, bytes.length]);
  }
  // Bytes in another format than the one asked for are flagged, with the charge warning.
  reply = samples.wav;
  await assert.rejects(provider.synthesize({ ...base, providerConfig: { responseFormat: "mp3" } }), /did not return MP3 audio; the request may have been charged/);
  reply = samples.mp3;
  await assert.rejects(provider.synthesize({ ...base, providerConfig: { responseFormat: "flac" } }), /did not return FLAC audio/);
});

// ---------------------------------------------------------------- understanding

test("video understanding refuses a model the catalogue does not mark as video-capable, before any paid call", async t => {
  const { understanding } = setup();
  const provider = understanding[0];
  assert.deepEqual(provider.capabilities, ["image", "video", "audio"]);
  assert.equal(provider.describeImage, undefined);
  const { mock, calls } = routedFetch([{ method: "GET", match: "/models", respond: () => json({ data: [
    { id: "a/text-only", architecture: { input_modalities: ["text", "image"] } },
    { id: "a/video", architecture: { input_modalities: ["text", "image", "video"] } },
  ] }) }]);
  t.mock.method(globalThis, "fetch", mock);
  const base = { apiKey: SECRET, buffer: MP4_BYTES, fileName: "clip.mp4", mime: "video/mp4", timeoutMs: 5000, baseUrl: STAGING_URL };
  await assert.rejects(provider.describeVideo({ ...base, model: "a/text-only" }), /does not list a\/text-only as a model that accepts video/);
  await assert.rejects(provider.describeVideo({ ...base, model: "a/absent" }), /does not list a\/absent/);
  await assert.rejects(provider.describeVideo({ ...base, baseUrl: "https://evil.invalid/api/v1", model: "a/video" }), /official/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.headers.get("authorization") === `Bearer ${SECRET}` && call.url.startsWith(STAGING_URL)));
});

test("video understanding posts a video_url part to chat completions on the official endpoint", async t => {
  const { understanding } = setup();
  const { mock, calls } = routedFetch([
    { method: "GET", match: "/models", respond: () => json({ data: [{ id: "a/video", architecture: { input_modalities: ["text", "video"] } }] }) },
    { method: "POST", match: "/chat/completions", respond: () => json({ choices: [{ message: { content: "A balloon rises." } }] }) },
  ]);
  t.mock.method(globalThis, "fetch", mock);
  const result = await understanding[0].describeVideo({ apiKey: SECRET, buffer: MP4_BYTES, fileName: "clip.mp4", mime: "video/mp4", timeoutMs: 5000, baseUrl: STAGING_URL, model: "a/video", prompt: "What is shown?" });
  assert.equal(result.text, "A balloon rises.");
  const post = calls.find(call => call.method === "POST");
  assert.equal(post.url, STAGING_URL + "/chat/completions");
  assert.equal(post.headers.get("authorization"), `Bearer ${SECRET}`);
  const content = JSON.parse(post.body).messages[0].content;
  assert.equal(content[1].type, "video_url");
  assert.match(content[1].video_url.url, /^data:video\/mp4;base64,/);
  assert.equal(content[0].text, "What is shown?");
});

test("video understanding fails clearly when the answer has no text", async t => {
  const { understanding } = setup();
  const { mock } = routedFetch([
    { method: "GET", match: "/models", respond: () => json({ data: [{ id: "a/video", architecture: { input_modalities: ["text", "video"] } }] }) },
    { method: "POST", match: "/chat/completions", respond: () => json({ choices: [{ message: { content: [] } }] }) },
  ]);
  t.mock.method(globalThis, "fetch", mock);
  await assert.rejects(understanding[0].describeVideo({ apiKey: SECRET, buffer: MP4_BYTES, fileName: "c.mp4", timeoutMs: 5000, baseUrl: STAGING_URL, model: "a/video" }), /returned no text/);
});
