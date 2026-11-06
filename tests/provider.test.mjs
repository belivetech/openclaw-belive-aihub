import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "../dist/index.js";
import { BASE_URL, STAGING_URL, KEY_ENV, PROVIDER_ID, fetchCatalog, mapCatalog, officialBaseUrl, perMillion, replyBudget } from "../dist/catalog.js";

function entry(id = "lab/nested/model") {
  return {
    id, name: "Fixture model", context_length: 1000000,
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    supported_parameters: ["tools", "reasoning_effort"],
    endpoints: [{ route: "chat_completions", status: "ready", supported_parameters: ["tools"] }],
    pricing: { prompt: "0.0000001425", completion: "0.0000004465", cached_prompt: "0.0000000152", cache_write: "0.00000019", overrides: [] },
  };
}

function registered() {
  const providers = [];
  const catalogs = [];
  plugin.register({
    registerProvider: provider => providers.push(provider),
    registerModelCatalogProvider: catalog => catalogs.push(catalog),
  });
  assert.equal(providers.length, 1);
  assert.equal(catalogs.length, 1);
  return { provider: providers[0], catalog: catalogs[0] };
}

// A pasted key resolves to the same value in both fields; an env-sourced key keeps only its name in `apiKey`.
function context(apiKey, baseUrl = STAGING_URL, discoveryApiKey = apiKey) {
  return {
    config: { models: { providers: { [PROVIDER_ID]: { baseUrl } } } },
    resolveProviderApiKey(provider) {
      assert.equal(provider, PROVIDER_ID);
      return { apiKey, discoveryApiKey, profileId: "fixture-profile" };
    },
  };
}

test("decimal conversion preserves per-token versus per-million units", () => {
  assert.equal(perMillion("0.0000001425"), 0.1425);
  assert.equal(perMillion("0"), 0);
  assert.equal(perMillion("0.000001"), 1);
  for (const invalid of [undefined, null, -1, "-1", "NaN", "Infinity", "1e-8"]) {
    assert.equal(perMillion(invalid), undefined);
  }
});

test("mapping keeps exact IDs and verified context, and excludes unsupported rows", () => {
  const good = entry();
  const bad = [];
  for (const patch of [
    { supported_parameters: [] }, { endpoints: [] }, { context_length: null },
    { architecture: { input_modalities: ["text"], output_modalities: ["image"] } },
    { pricing: {} }, { tokenhub_pricing: { tiers: [{}, {}] } },
  ]) bad.push({ ...entry(), ...patch });
  const result = mapCatalog({ data: [good, ...bad, good, null] });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, good.id);
  assert.equal(result[0].contextWindow, 1000000);
  assert.equal(result[0].maxTokens, 4096);
  assert.deepEqual(result[0].cost, { input: 0.1425, output: 0.4465, cacheRead: 0.0152, cacheWrite: 0.19 });
  assert.deepEqual(mapCatalog({ data: [] }), []);
  assert.throws(() => mapCatalog({ data: null }), /Invalid/);
});

test("missing cache prices fall back to the input price rather than free, without renaming the model", () => {
  const model = entry();
  delete model.pricing.cached_prompt;
  delete model.pricing.cache_write;
  const result = mapCatalog({ data: [model] })[0];
  assert.equal(result.name, "Fixture model");
  assert.equal(result.cost.cacheRead, result.cost.input);
  assert.equal(result.cost.cacheWrite, result.cost.input);
});

test("reply budget follows the published output maximum, capped, with the old budget as fallback", () => {
  // Production /models, 2026-11-06: Qwen3.8 Flash 131000, Kimi K3 1000000, DeepSeek 384000.
  const model = (top) => ({ ...entry(), ...(top === undefined ? {} : { top_provider: top }) });
  const budgets = [undefined, { context_length: 1000000, max_completion_tokens: 8192 },
    { context_length: 1000000, max_completion_tokens: 131000 },
    { context_length: 1000000, max_completion_tokens: 1000000 },
    { context_length: 1000000, max_completion_tokens: null }, { max_completion_tokens: "128000" }]
    .map(top => mapCatalog({ data: [model(top)] })[0].maxTokens);
  assert.deepEqual(budgets, [4096, 8192, 32768, 32768, 4096, 4096]);
  assert.equal(replyBudget({ max_completion_tokens: 0 }), 4096);
  assert.equal(replyBudget({ max_completion_tokens: 1.5 }), 4096);
});

test("tiered models list at their first tier and say so; an inconsistent tier table is excluded", () => {
  // Shape of the production catalog's tiered rows (2026-11-05): flat `pricing` is the first tier.
  const tiered = entry("lab/tiered");
  tiered.pricing.overrides = [{ min_prompt_tokens: 256000, prompt: "0.0000012", completion: "0.0000048" }];
  tiered.tokenhub_pricing = { type: "tiered_token_v1", tier_basis: "total_prompt", tiers: [
    { upper_bound_tokens: 256000, prompt: "0.0000001425", completion: "0.0000004465" },
    { upper_bound_tokens: null, prompt: "0.0000012", completion: "0.0000048" },
  ] };
  const result = mapCatalog({ data: [tiered] });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "Fixture model (tiered pricing)");
  assert.equal(result[0].cost.input, 0.1425);
  assert.equal(result[0].cost.output, 0.4465);
  const mismatched = structuredClone(tiered);
  mismatched.id = "lab/mismatched";
  mismatched.tokenhub_pricing.tiers[0].prompt = "0.0000012";
  const overridesOnly = entry("lab/overrides-only");
  overridesOnly.pricing.overrides = tiered.pricing.overrides;
  assert.deepEqual(mapCatalog({ data: [mismatched, overridesOnly] }), []);
});

test("catalog rejects unexpected origins without issuing a request", async t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Must not issue a request"));
  for (const url of ["http://tokenhub-api.belive.sg/api/v1", "https://evil.invalid/api/v1", BASE_URL + "?redirect=1"]) {
    assert.throws(() => officialBaseUrl(url), /official/);
    await assert.rejects(fetchCatalog(url, "fixture-key"), /official/);
  }
  await assert.rejects(fetchCatalog(BASE_URL, ""), new RegExp(KEY_ENV));
});

test("released SDK registration discovers models in runtime and picker with each profile key", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization, redirect: options.redirect });
    return Response.json({ data: [entry()] });
  });
  const { provider, catalog } = registered();
  for (const key of ["fixture-profile-a", "fixture-profile-b"]) {
    const ctx = context(key);
    const runtime = await provider.catalog.run(ctx);
    assert.equal(runtime.provider.baseUrl, STAGING_URL);
    assert.equal(runtime.provider.models[0].id, "lab/nested/model");
    const picker = await catalog.liveCatalog(ctx);
    assert.equal(picker[0].model, "lab/nested/model");
    assert.equal(calls.at(-1).authorization, "Bearer " + key);
    const resolved = provider.resolveDynamicModel({
      provider: PROVIDER_ID, modelId: "lab/nested/model", providerConfig: runtime.provider,
    });
    assert.equal(resolved.id, "lab/nested/model");
    assert.equal(resolved.baseUrl, STAGING_URL);
    assert.equal(provider.resolveDynamicModel({ provider: PROVIDER_ID, modelId: "lab/missing", providerConfig: runtime.provider }), undefined);
  }
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.url === STAGING_URL + "/models" && call.redirect === "error"));
  assert.equal(provider.resolveDynamicModel({ provider: "openrouter", modelId: "lab/nested/model" }), undefined);
});

test("env-sourced keys authenticate discovery with the resolved secret, never the env name", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(options.headers.Authorization);
    return Response.json({ data: [entry()] });
  });
  const { provider, catalog } = registered();
  const ctx = context(KEY_ENV, STAGING_URL, "fixture-env-secret");
  const runtime = await provider.catalog.run(ctx);
  assert.equal(runtime.provider.apiKey, KEY_ENV);
  assert.equal(runtime.provider.models[0].id, "lab/nested/model");
  assert.equal((await catalog.liveCatalog(ctx))[0].model, "lab/nested/model");
  assert.deepEqual(calls, ["Bearer fixture-env-secret", "Bearer fixture-env-secret"]);
  // A non-env secret-ref marker has no discovery secret: no request carries the marker.
  const marker = context("secretref-marker", STAGING_URL, null);
  assert.equal(await provider.catalog.run(marker), null);
  assert.equal(await catalog.liveCatalog(marker), null);
  assert.equal(calls.length, 2);
});

test("catalog errors, cancellation and absent credentials do not become an empty/free fallback", async t => {
  const { provider, catalog } = registered();
  assert.equal(await provider.catalog.run(context(undefined)), null);
  assert.equal(await catalog.liveCatalog(context(undefined)), null);
  let count = 0;
  t.mock.method(globalThis, "fetch", async () => {
    count++;
    return new Response("private upstream detail", { status: 401 });
  });
  await assert.rejects(provider.catalog.run(context("fake-key")), /^Error: BeLive AI Hub model discovery returned HTTP 401$/);
  assert.equal(count, 1);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("private key material"); });
  await assert.rejects(fetchCatalog(BASE_URL, "fake-key"), /^Error: BeLive AI Hub model discovery failed or was cancelled$/);
});

test("next explicit discovery sees added and removed models without a plugin release", async t => {
  let data = [entry("lab/first")];
  t.mock.method(globalThis, "fetch", async () => Response.json({ data }));
  const { provider } = registered();
  assert.deepEqual((await provider.catalog.run(context("key"))).provider.models.map(row => row.id), ["lab/first"]);
  data = [entry("lab/second")];
  assert.deepEqual((await provider.catalog.run(context("key"))).provider.models.map(row => row.id), ["lab/second"]);
});
