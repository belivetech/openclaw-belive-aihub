import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

// Failure-path qualification: what each paid media call does when AI Hub refuses the key (401),
// the balance (402), the rate (429), or the upstream fails (502/503), and when the network drops.
// Every answer must name the status, the gateway's message and the request id, never the key, and a
// paid request must never be sent twice except the video submit, which retries under one Idempotency-Key.
const home = mkdtempSync(path.join(tmpdir(), "belive-failures-"));
process.env.OPENCLAW_STATE_DIR = path.join(home, "state");
const plugin = (await import("../dist/index.js")).default;
const { STAGING_URL, KEY_ENV, PROVIDER_ID } = await import("../dist/catalog.js");
const { createVideoProvider, fileJobStore } = await import("../dist/video.js");
const { fakeApi, routedFetch, json, MP4_BYTES, WAV_BYTES } = await import("./helpers.mjs");

after(() => rmSync(home, { recursive: true, force: true }));

const SECRET = "fixture-failure-secret";
const cfg = { models: { providers: { [PROVIDER_ID]: { baseUrl: STAGING_URL } } } };
let agentDir;
beforeEach(() => {
  agentDir = mkdtempSync(path.join(home, "agent-"));
  process.env[KEY_ENV] = SECRET;
});

const FAILURES = [
  { status: 401, message: "invalid API key" },
  { status: 402, message: "insufficient credit" },
  { status: 429, message: "rate limit exceeded", headers: { "retry-after": "1" } },
  { status: 502, message: "upstream provider failed" },
  { status: 503, message: "model temporarily unavailable" },
];
const refusal = ({ status, message, headers = {} }) =>
  () => json({ error: { message } }, status, { "x-generation-id": `req_fail${status}`, ...headers });
const named = ({ status, message }) =>
  new RegExp(`returned HTTP ${status}: ${message} \\(AI Hub request req_fail${status}\\)`);
const posts = calls => calls.filter(call => call.method === "POST");

function registered() {
  const { api, registered: all } = fakeApi(path.join(home, "state-" + Math.random().toString(36).slice(2)));
  plugin.register(api);
  return all;
}

const row = (id, route, inputs, outputs) => ({
  id, name: id, architecture: { input_modalities: inputs, output_modalities: outputs },
  supported_parameters: [], endpoints: [{ route, status: "ready" }],
});

/** Each paid call, with the catalogue it reads first and the one request that may be charged. */
const CAPABILITIES = {
  image: {
    catalogue: { match: "/images/models", body: { data: [row("qwen/img", "image_generations", ["text"], ["image"])] } },
    paid: "/images/generations",
    run: all => all.image[0].generateImage({ provider: PROVIDER_ID, model: "qwen/img", prompt: "x", cfg, agentDir }),
  },
  speech: {
    paid: "/audio/speech",
    run: all => all.speech[0].synthesize({ cfg, text: "Hi", target: "audio-file", timeoutMs: 5000, providerConfig: {} }),
  },
  transcription: {
    catalogue: { match: "/models?output_modalities=all", body: { data: [row("a/asr", "audio_transcriptions", ["audio"], ["text"])] } },
    paid: "/audio/transcriptions",
    // A failure after the upload throws, so OpenClaw does not hand the recording to another provider.
    run: all => all.understanding[0].transcribeAudioWithContext({
      buffer: WAV_BYTES, fileName: "a.wav", mime: "audio/wav", timeoutMs: 5000, baseUrl: STAGING_URL, model: "a/asr", cfg, agentDir,
    }),
  },
  "video understanding": {
    catalogue: { match: "/models", body: { data: [{ id: "a/video", architecture: { input_modalities: ["text", "video"] } }] } },
    paid: "/chat/completions",
    run: all => all.understanding[0].describeVideo({
      apiKey: SECRET, buffer: MP4_BYTES, fileName: "c.mp4", timeoutMs: 5000, baseUrl: STAGING_URL, model: "a/video",
    }),
  },
};

for (const [name, capability] of Object.entries(CAPABILITIES)) {
  test(`${name}: every refusal names its status, message and request id, and the paid request is sent once`, async t => {
    for (const failure of FAILURES) {
      const { mock, calls } = routedFetch([
        ...(capability.catalogue ? [{ method: "GET", match: capability.catalogue.match, respond: () => json(capability.catalogue.body) }] : []),
        { method: "POST", match: capability.paid, respond: refusal(failure) },
      ]);
      t.mock.method(globalThis, "fetch", mock);
      const error = await capability.run(registered()).then(() => assert.fail(`${name} ${failure.status} resolved`), e => e);
      assert.match(error.message, named(failure), `${name} ${failure.status}`);
      assert.ok(!error.message.includes(SECRET));
      assert.equal(posts(calls).length, 1, `${name} ${failure.status} must not resend a paid request`);
      t.mock.restoreAll();
    }
  });

  test(`${name}: a dropped connection is reported as a network error and not resent`, async t => {
    const { mock, calls } = routedFetch([
      ...(capability.catalogue ? [{ method: "GET", match: capability.catalogue.match, respond: () => json(capability.catalogue.body) }] : []),
      { method: "POST", match: capability.paid, respond: () => new TypeError("socket hang up") },
    ]);
    t.mock.method(globalThis, "fetch", mock);
    const error = await capability.run(registered()).then(() => assert.fail("resolved"), e => e);
    assert.match(error.message, /failed: network error/);
    assert.equal(posts(calls).length, 1);
  });
}

// ---------------------------------------------------------------- video generation

function video(t, submit) {
  const jobsDir = path.join(home, "jobs-" + Math.random().toString(36).slice(2));
  const provider = createVideoProvider({ jobs: fileJobStore(() => jobsDir), pollIntervalMs: 1, backoffMs: 1 });
  const { mock, calls } = routedFetch([
    { method: "GET", match: "/videos/models", respond: () => json({ data: [{ ...row("alibaba/wan", "video_generations", ["text"], ["video"]),
      supported_resolutions: ["480p"], supported_aspect_ratios: ["16:9"], supported_durations: [2], supported_frame_images: [],
      supported_parameters: ["prompt", "duration", "resolution"] }] }) },
    { method: "GET", match: "/videos?idempotency_key=", respond: () => json({ data: [] }) },
    { method: "POST", match: "/videos", respond: submit },
  ]);
  t.mock.method(globalThis, "fetch", mock);
  const files = () => { try { return readdirSync(jobsDir); } catch { return []; } };
  const run = () => provider.generateVideo({ provider: PROVIDER_ID, model: "alibaba/wan", prompt: "a balloon", cfg, agentDir, durationSeconds: 2, resolution: "480P" });
  return { calls, files, run };
}

test("video: a refused key or balance is final; nothing is retried and no job record is kept", async t => {
  for (const failure of FAILURES.filter(f => f.status < 429)) {
    const { calls, files, run } = video(t, refusal(failure));
    const error = await run().catch(e => e);
    assert.match(error.message, named(failure));
    assert.equal(posts(calls).length, 1);
    assert.deepEqual(files(), []);
    t.mock.restoreAll();
  }
});

test("video: rate limits and upstream failures retry under the same Idempotency-Key, honour Retry-After, and keep the record", async t => {
  for (const failure of FAILURES.filter(f => f.status >= 429)) {
    const { calls, files, run } = video(t, refusal(failure));
    const started = Date.now();
    const error = await run().catch(e => e);
    assert.match(error.message, named(failure));
    assert.match(error.message, /run the same request again and the saved Idempotency-Key reconciles it/);
    const keys = new Set(posts(calls).map(call => call.headers.get("idempotency-key")));
    assert.equal(posts(calls).length, 3);
    assert.equal(keys.size, 1, "every attempt reuses one Idempotency-Key");
    // Between attempts the job is looked up by its key, so a submit that did start is never doubled.
    assert.ok(calls.some(call => call.url.includes("/videos?idempotency_key=")));
    if (failure.headers?.["retry-after"]) assert.ok(Date.now() - started >= 2000, "two waits of Retry-After: 1");
    assert.equal(files().length, 1, "the record stays for a rerun");
    t.mock.restoreAll();
  }
});
