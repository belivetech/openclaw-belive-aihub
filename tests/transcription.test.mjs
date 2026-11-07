import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

// Isolate the host's auth store and state from the developer's real OpenClaw home before it is used.
const home = mkdtempSync(path.join(tmpdir(), "belive-stt-"));
process.env.OPENCLAW_STATE_DIR = path.join(home, "state");
const { upsertAuthProfileAsync } = await import("openclaw/plugin-sdk/provider-auth");
const plugin = (await import("../dist/index.js")).default;
const { STAGING_URL, BASE_URL, KEY_ENV, PROVIDER_ID } = await import("../dist/catalog.js");
const { buildUnderstandingProvider } = await import("../dist/understanding.js");
const { mapTranscriptionModels } = await import("../dist/media-catalog.js");
const { MAX_RECORDING_BYTES, DEFAULT_TRANSCRIPTION_MODEL, FALLBACK_TRANSCRIPTION_MODEL } = await import("../dist/transcription.js");
const { fakeApi, routedFetch, json, PNG_BASE64, WAV_BYTES } = await import("./helpers.mjs");

after(() => rmSync(home, { recursive: true, force: true }));

const SECRET = "fixture-belive-secret";
const DECOYS = { OPENAI_API_KEY: "decoy-openai", OPENROUTER_API_KEY: "decoy-openrouter", GROQ_API_KEY: "decoy-groq", DEEPGRAM_API_KEY: "decoy-deepgram", TOKENHUB_API_KEY: "decoy-tokenhub" };
const cfg = { models: { providers: { [PROVIDER_ID]: { baseUrl: STAGING_URL } } } };
const MP3_BYTES = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(40, 3)]);
const OGG_BYTES = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(40)]);
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");
let agentDir;

beforeEach(() => {
  agentDir = mkdtempSync(path.join(home, "agent-"));
  delete process.env[KEY_ENV];
  Object.assign(process.env, DECOYS);
});

const row = (id, route = "audio_transcriptions", status = "ready") => ({
  id, name: id, architecture: { input_modalities: ["audio"], output_modalities: ["text"] },
  supported_parameters: [], endpoints: [{ route, status }],
});
const catalogue = () => json({ data: [
  row("a/asr"), row(DEFAULT_TRANSCRIPTION_MODEL), row("a/asr-down", "audio_transcriptions", "down"),
  row("a/tts", "audio_speech"), row("a/chat", "chat_completions"),
] });
const authorizations = calls => calls.map(call => call.headers.get("authorization"));
const posts = calls => calls.filter(call => call.method === "POST");

/** The provider as the host registers it, with a fetch mock that serves the transcription catalogue first. */
function setup(t, routes = [], { env = SECRET, pollIntervalMs = 1 } = {}) {
  if (env) process.env[KEY_ENV] = env;
  const { api, registered } = fakeApi(path.join(home, "plugin-state-" + Math.random().toString(36).slice(2)));
  plugin.register(api);
  const provider = registered.understanding[0];
  const { mock, calls } = routedFetch([{ method: "GET", match: "/models?output_modalities=all", respond: catalogue }, ...routes]);
  t.mock.method(globalThis, "fetch", mock);
  return { provider, fast: buildUnderstandingProvider({ pollIntervalMs }), calls };
}
const ask = (extra = {}) => ({ buffer: WAV_BYTES, fileName: "note.wav", mime: "audio/wav", timeoutMs: 5000, baseUrl: STAGING_URL, model: "a/asr", cfg, agentDir, ...extra });
const answer = text => ({ method: "POST", match: "/audio/transcriptions", respond: () => json({ text }) });

// ---------------------------------------------------------------- registration

test("the host surface: audio is declared in the manifest, registered once, never auto-selected", () => {
  const { api, registered } = fakeApi();
  plugin.register(api);
  const provider = registered.understanding[0];
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  const metadata = manifest.mediaUnderstandingProviderMetadata[PROVIDER_ID];
  assert.deepEqual(provider.capabilities, metadata.capabilities);
  assert.ok(provider.capabilities.includes("audio"));
  assert.deepEqual(provider.defaultModels, metadata.defaultModels);
  assert.equal(provider.defaultModels.audio, DEFAULT_TRANSCRIPTION_MODEL);
  assert.equal(typeof provider.transcribeAudioWithContext, "function");
  assert.equal(typeof provider.isAudioConfigured, "function");
  assert.equal(provider.autoPriority, undefined);
  assert.equal(provider.transcribeAudio, undefined);
  assert.deepEqual(manifest.contracts.mediaUnderstandingProviders, [PROVIDER_ID]);
});

test("the transcription catalogue keeps only ready audio_transcriptions rows", () => {
  assert.deepEqual(mapTranscriptionModels({ data: [row("a/ok"), row("a/down", "audio_transcriptions", "down"), row("a/tts", "audio_speech")] }).map(r => r.id), ["a/ok"]);
  assert.throws(() => mapTranscriptionModels({ data: null }), /Invalid/);
});

// ---------------------------------------------------------------- the upload

test("uploads the recording as multipart with only model and language, authenticated with the BeLive key", async t => {
  const { provider, calls } = setup(t, [answer("hello from ai hub")]);
  // The config-safe value the chat catalogue stores is the env var's name, which must never be sent.
  const withMarker = { models: { providers: { [PROVIDER_ID]: { baseUrl: STAGING_URL, apiKey: KEY_ENV } } } };
  const result = await provider.transcribeAudioWithContext(ask({
    cfg: withMarker, language: "en-US", prompt: "Spell BeLive correctly.",
    headers: { Authorization: "Bearer decoy-header", "X-Other": "1" }, query: { diarize: true },
  }));
  assert.deepEqual(result, { ok: true, value: { text: "hello from ai hub", model: "a/asr" } });
  assert.equal(calls.length, 2);
  const [get, post] = calls;
  assert.equal(get.url, STAGING_URL + "/models?output_modalities=all");
  assert.equal(post.url, STAGING_URL + "/audio/transcriptions");
  assert.deepEqual(authorizations(calls), [`Bearer ${SECRET}`, `Bearer ${SECRET}`]);
  assert.equal(post.redirect, "error");
  assert.equal(post.headers.get("content-type"), null, "fetch must set the multipart boundary itself");
  assert.equal(post.headers.get("x-other"), null);
  assert.ok(post.body instanceof FormData);
  assert.deepEqual([...post.body.keys()].sort(), ["file", "language", "model"]);
  assert.equal(post.body.get("model"), "a/asr");
  assert.equal(post.body.get("language"), "en");
  const file = post.body.get("file");
  assert.deepEqual([file.type, file.name, file.size], ["audio/wav", "recording.wav", WAV_BYTES.length]);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), WAV_BYTES);
});

test("an MP3 is sent as audio/mpeg, the default model applies, and no language is sent unless asked", async t => {
  const { provider, calls } = setup(t, [answer("ok")]);
  const result = await provider.transcribeAudioWithContext(ask({ buffer: MP3_BYTES, fileName: "voice-note.m4a", mime: "audio/mp4", model: undefined }));
  assert.equal(result.value.model, DEFAULT_TRANSCRIPTION_MODEL);
  const body = posts(calls)[0].body;
  assert.deepEqual([...body.keys()].sort(), ["file", "model"]);
  assert.deepEqual([body.get("file").type, body.get("file").name], ["audio/mpeg", "recording.mp3"]);
});

test("a saved BeLive profile wins over the environment, and another provider's profile is never used", async t => {
  await upsertAuthProfileAsync({ profileId: `${PROVIDER_ID}:default`, credential: { type: "api_key", provider: PROVIDER_ID, key: "fixture-pasted-key" }, agentDir });
  await upsertAuthProfileAsync({ profileId: "openai:default", credential: { type: "api_key", provider: "openai", key: "decoy-profile-openai" }, agentDir });
  const { provider, calls } = setup(t, [answer("ok")]);
  await provider.transcribeAudioWithContext(ask());
  assert.deepEqual(new Set(authorizations(calls)), new Set(["Bearer fixture-pasted-key"]));
  assert.equal(await provider.isAudioConfigured({ cfg, agentDir }), true);
});

test("with no BeLive key the call is refused before any request, whatever other providers' keys exist", async t => {
  await upsertAuthProfileAsync({ profileId: "openai:default", credential: { type: "api_key", provider: "openai", key: "decoy-profile-openai" }, agentDir });
  const { provider } = setup(t, [], { env: null });
  t.mock.method(globalThis, "fetch", () => assert.fail("No request may be issued without a BeLive AI Hub key"));
  const result = await provider.transcribeAudioWithContext(ask());
  assert.equal(result.ok, false);
  assert.match(result.error.message, new RegExp(KEY_ENV));
  assert.equal(await provider.isAudioConfigured({ cfg, agentDir }), false);
});

test("only the two official bases are accepted, from the host's baseUrl", async t => {
  const { provider } = setup(t);
  t.mock.method(globalThis, "fetch", () => assert.fail("Must not issue a request"));
  for (const baseUrl of ["https://evil.invalid/api/v1", "http://tokenhub-api.belive.sg/api/v1", STAGING_URL + "/../x"]) {
    const result = await provider.transcribeAudioWithContext(ask({ baseUrl }));
    assert.equal(result.ok, false);
    assert.match(result.error.message, /official/);
  }
});

test("production is the default base", async t => {
  const { provider, calls } = setup(t, [answer("ok")]);
  await provider.transcribeAudioWithContext(ask({ baseUrl: undefined, cfg: {} }));
  assert.ok(calls.every(call => call.url.startsWith(BASE_URL + "/")));
});

// ---------------------------------------------------------------- refusals before the paid call

test("recordings the route cannot take are refused locally, with no request at all", async t => {
  const { provider } = setup(t);
  t.mock.method(globalThis, "fetch", () => assert.fail("A refused recording must not reach the network"));
  const refuse = async (extra, pattern) => {
    const result = await provider.transcribeAudioWithContext(ask(extra));
    assert.equal(result.ok, false);
    assert.match(result.error.message, pattern);
  };
  await refuse({ buffer: PNG_BYTES, fileName: "audio.wav", mime: "audio/wav" }, /MP3 or WAV recordings only/);
  await refuse({ buffer: OGG_BYTES, fileName: "voice.ogg", mime: "audio/ogg" }, /MP3 or WAV recordings only/);
  await refuse({ buffer: Buffer.alloc(0) }, /non-empty/);
  await refuse({ buffer: Buffer.concat([WAV_BYTES, Buffer.alloc(MAX_RECORDING_BYTES)]) }, /at most 25000000 bytes/);
  await refuse({ language: "english" }, /two-letter language code/);
});

test("the size limit is inclusive", async t => {
  const { provider, calls } = setup(t, [answer("big")]);
  const exact = Buffer.concat([WAV_BYTES, Buffer.alloc(MAX_RECORDING_BYTES - WAV_BYTES.length)]);
  assert.equal(exact.length, MAX_RECORDING_BYTES);
  assert.equal((await provider.transcribeAudioWithContext(ask({ buffer: exact }))).ok, true);
  assert.equal(posts(calls).length, 1);
});

test("when the account is not offered the default, the 3.0 model is used; a model the user chose is never swapped", async t => {
  const { provider } = setup(t);
  const offer = () => json({ data: [row("a/asr"), row(FALLBACK_TRANSCRIPTION_MODEL)] });
  t.mock.method(globalThis, "fetch", routedFetch([{ method: "GET", match: "/models?output_modalities=all", respond: offer }, answer("ok")]).mock);
  for (const model of [undefined, DEFAULT_TRANSCRIPTION_MODEL]) {
    const result = await provider.transcribeAudioWithContext(ask({ model }));
    assert.equal(result.value.model, FALLBACK_TRANSCRIPTION_MODEL);
  }
  const chosen = await provider.transcribeAudioWithContext(ask({ model: "a/absent" }));
  assert.equal(chosen.ok, false);
  assert.match(chosen.error.message, /does not list a\/absent/);
});

test("a model the live catalogue does not list as transcription is refused with what is offered, before the paid call", async t => {
  const { provider, calls } = setup(t);
  for (const model of ["a/tts", "a/chat", "a/asr-down", "a/absent"]) {
    const result = await provider.transcribeAudioWithContext(ask({ model }));
    assert.equal(result.ok, false);
    assert.match(result.error.message, new RegExp(`does not list ${model} as a transcription model. Offered: a/asr, ${DEFAULT_TRANSCRIPTION_MODEL}`));
  }
  assert.equal(posts(calls).length, 0);
});

// ---------------------------------------------------------------- the answer

test("a 400 from the route throws with the gateway's message, is not retried and never echoes the key", async t => {
  const { provider, calls } = setup(t, [{ method: "POST", match: "/audio/transcriptions", respond: () => json({ error: { message: "the recording must be an MP3 or WAV file" } }, 400) }]);
  await assert.rejects(provider.transcribeAudioWithContext(ask()), error => {
    assert.match(error.message, /returned HTTP 400: the recording must be an MP3 or WAV file/);
    assert.ok(!error.message.includes(SECRET));
    return true;
  });
  assert.equal(posts(calls).length, 1);
});

test("a server error after the upload throws, so the host does not hand the file to another provider, and is not retried", async t => {
  const { provider, calls } = setup(t, [{ method: "POST", match: "/audio/transcriptions", respond: () => json({ error: { message: "upstream" } }, 502) }]);
  await assert.rejects(provider.transcribeAudioWithContext(ask()), /HTTP 502/);
  assert.equal(posts(calls).length, 1);
});

test("a long-recording model's job is read until it finishes; the recording is uploaded once", async t => {
  let reads = 0;
  const { fast, calls } = setup(t, [
    { method: "POST", match: "/audio/transcriptions", respond: () => json({ id: "job_1", status: "pending", polling_url: "https://evil.invalid/steal" }, 202) },
    { method: "GET", match: "/audio/transcriptions/job_1", respond: () => json(++reads < 3 ? { id: "job_1", status: "in_progress" } : { id: "job_1", status: "completed", transcript: { text: "long recording" } }) },
  ]);
  const result = await fast.transcribeAudioWithContext(ask());
  assert.deepEqual(result.value, { text: "long recording", model: "a/asr" });
  assert.equal(posts(calls).length, 1);
  const reads$ = calls.filter(call => call.url.includes("/audio/transcriptions/job_1"));
  assert.equal(reads$.length, 3);
  assert.ok(calls.every(call => call.url.startsWith(STAGING_URL) && call.headers.get("authorization") === `Bearer ${SECRET}`));
});

test("a failed job throws its message; one still running at the timeout names the job and says not to upload again", async t => {
  const failed = setup(t, [
    { method: "POST", match: "/audio/transcriptions", respond: () => json({ id: "job_2", status: "pending" }, 202) },
    { method: "GET", match: "/audio/transcriptions/job_2", respond: () => json({ id: "job_2", status: "failed", error: { message: "the audio is too long for this model" } }) },
  ]);
  await assert.rejects(failed.fast.transcribeAudioWithContext(ask()), /transcription failed: the audio is too long for this model/);
  assert.equal(posts(failed.calls).length, 1);
  t.mock.restoreAll();
  const slow = setup(t, [
    { method: "POST", match: "/audio/transcriptions", respond: () => json({ id: "job_3", status: "pending" }, 202) },
    { method: "GET", match: "/audio/transcriptions/job_3", respond: () => json({ id: "job_3", status: "in_progress" }) },
  ]);
  await assert.rejects(slow.fast.transcribeAudioWithContext(ask({ timeoutMs: 50 })), /job job_3 was still running.*may be charged.*do not upload the recording again/);
  assert.equal(posts(slow.calls).length, 1);
});

test("an answer that is not understood is flagged as possibly charged", async t => {
  for (const respond of [() => json({ nothing: true }), () => new Response("not json"), () => json({ id: "../x", status: "pending" }, 202), () => json({ id: "job_9", status: "mystery" }, 202)]) {
    t.mock.restoreAll();
    const { provider } = setup(t, [{ method: "POST", match: "/audio/transcriptions", respond }]);
    await assert.rejects(provider.transcribeAudioWithContext(ask()), /not understood|not JSON|job status "mystery"/);
  }
  t.mock.restoreAll();
  const done = setup(t, [
    { method: "POST", match: "/audio/transcriptions", respond: () => json({ id: "job_8", status: "completed" }, 202) },
  ]);
  await assert.rejects(done.provider.transcribeAudioWithContext(ask()), /finished without text; the request may have been charged/);
});

test("an empty transcript is returned as empty text, not an error", async t => {
  const { provider } = setup(t, [answer("")]);
  assert.deepEqual((await provider.transcribeAudioWithContext(ask())).value, { text: "", model: "a/asr" });
});
