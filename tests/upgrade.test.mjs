import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// An existing install: the config already holds model rows saved by an older plugin or by hand.
// Isolate the host's auth store from the developer's real OpenClaw home before it is used.
const home = mkdtempSync(path.join(tmpdir(), "belive-upgrade-"));
process.env.OPENCLAW_STATE_DIR = path.join(home, "state");
const plugin = (await import("../dist/index.js")).default;
const { BASE_URL, KEY_ENV, PROVIDER_ID } = await import("../dist/catalog.js");
const { fakeApi } = await import("./helpers.mjs");

after(() => rmSync(home, { recursive: true, force: true }));

const VISION = "qwen/qwen3.8-flash";
const liveRow = id => ({
  id, name: "Qwen3.8 Flash", context_length: 1000000,
  architecture: { input_modalities: ["text", "image", "video"], output_modalities: ["text"] },
  supported_parameters: ["tools"],
  endpoints: [{ route: "chat_completions", status: "ready", supported_parameters: ["tools"] }],
  pricing: { prompt: "0.0000001", completion: "0.0000004" },
});
// The row as the 2026-09 custom-provider recipe or 0.1.x saved it: text only.
const savedRow = { id: VISION, name: "Qwen3.8 Flash", reasoning: false, input: ["text"],
  cost: { input: 0.1, output: 0.4, cacheRead: 0.1, cacheWrite: 0.1 }, contextWindow: 1000000, maxTokens: 4096 };
const providerConfig = { baseUrl: BASE_URL, api: "openai-completions", models: [savedRow] };
const config = { models: { providers: { [PROVIDER_ID]: providerConfig } } };

function provider() {
  const { api, registered } = fakeApi(path.join(home, "plugin-state"));
  plugin.register(api);
  return registered.providers[0];
}

test("a text-only row saved by an older install resolves with the live catalogue's image input", async t => {
  process.env[KEY_ENV] = "fixture-upgrade-key";
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, authorization: options.headers.Authorization });
    return Response.json({ data: [liveRow(VISION)] });
  });
  const p = provider();
  const agentDir = mkdtempSync(path.join(home, "agent-"));
  const ctx = { provider: PROVIDER_ID, modelId: VISION, config, providerConfig, agentDir };

  // The saved row alone is what 0.3.0 resolved: text only.
  assert.deepEqual(p.resolveDynamicModel(ctx).input, ["text"]);
  // 0.3.1 asks OpenClaw to compare saved rows with the live one, for this provider only.
  assert.equal(p.preferRuntimeResolvedModel(ctx), true);
  assert.equal(p.preferRuntimeResolvedModel({ ...ctx, provider: "openrouter" }), false);

  const resolved = await p.prepareDynamicModel(ctx);
  assert.deepEqual(resolved.input, ["text", "image"]);
  assert.equal(resolved.baseUrl, BASE_URL);
  assert.equal(resolved.api, "openai-completions");
  assert.deepEqual(requests, [{ url: BASE_URL + "/models", authorization: "Bearer fixture-upgrade-key" }]);

  // OpenClaw keeps the saved row's input list over a discovered one, so the last rewrite sets it.
  const saved = p.resolveDynamicModel(ctx);
  assert.deepEqual(p.normalizeResolvedModel({ ...ctx, model: saved }).input, ["text", "image"]);
  assert.equal(p.normalizeResolvedModel({ ...ctx, model: resolved }), undefined);
  assert.equal(p.normalizeResolvedModel({ ...ctx, provider: "openrouter", model: saved }), undefined);

  // Within the reuse window the catalogue is not fetched again on every turn.
  assert.deepEqual((await p.prepareDynamicModel(ctx)).input, ["text", "image"]);
  assert.equal(requests.length, 1);
  // A saved model the catalogue no longer lists is left to the saved row.
  assert.equal(await p.prepareDynamicModel({ ...ctx, modelId: "lab/retired" }), undefined);
  assert.equal(await p.prepareDynamicModel({ ...ctx, provider: "openrouter" }), undefined);
});

test("without a key the saved row is kept and nothing is sent", async t => {
  delete process.env[KEY_ENV];
  t.mock.method(globalThis, "fetch", () => assert.fail("Must not issue a request"));
  const p = provider();
  const staging = { ...providerConfig, baseUrl: "https://api-stg-tokenhub.belive.sg/api/v1" };
  const ctx = { provider: PROVIDER_ID, modelId: VISION, config: { models: { providers: { [PROVIDER_ID]: staging } } },
    providerConfig: staging, agentDir: mkdtempSync(path.join(home, "agent-")) };
  assert.equal(await p.prepareDynamicModel(ctx), undefined);
});
