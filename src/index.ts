import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi, UnifiedModelCatalogEntry, UnifiedModelCatalogKind } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { baseUrlFor, resolveApiKey } from "./auth.js";
import { BASE_URL, DEFAULT_MODEL, KEY_ENV, PROVIDER_ID, fetchCatalog, officialBaseUrl, type CatalogModel } from "./catalog.js";
import { buildImageProvider } from "./image.js";
import { fetchImageModels, fetchSpeechModels, fetchVideoModels } from "./media-catalog.js";
import { buildSpeechProvider } from "./speech.js";
import { buildUnderstandingProvider } from "./understanding.js";
import { createVideoProvider, fileJobStore, videoCapabilities } from "./video.js";

/** How long a fetched catalogue is reused when a chat model is resolved. */
const LIVE_TTL_MS = 10 * 60_000;
/** The last catalogue fetched for each API base. A model row saved in the config by an older
 *  install or by hand can be stale (for example text-only for a vision model); OpenClaw compares
 *  it with the row from this catalogue, and the live row wins. */
const live = new Map<string, { at: number; models: CatalogModel[] }>();

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(kind => b.includes(kind));

function runtimeModel(model: Omit<CatalogModel, "input"> & { input: readonly string[] }, baseUrl: string) {
  return {
    id: model.id, name: model.name, reasoning: model.reasoning,
    contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost: model.cost,
    input: model.input.filter((kind): kind is "text" | "image" => kind === "text" || kind === "image"),
    provider: PROVIDER_ID, api: "openai-completions" as const, baseUrl,
  };
}

type CatalogContext = Parameters<NonNullable<Parameters<OpenClawPluginApi["registerModelCatalogProvider"]>[0]["liveCatalog"]>>[0];

/** Picker rows for one media kind, from the account's live catalogue; nothing without a key. */
function mediaCatalog(
  kind: Exclude<UnifiedModelCatalogKind, "text">,
  load: (baseUrl: string, apiKey: string, ctx: CatalogContext) => Promise<UnifiedModelCatalogEntry[]>,
) {
  return {
    provider: PROVIDER_ID,
    kinds: [kind] as const,
    async liveCatalog(ctx: CatalogContext) {
      const key = ctx.resolveProviderApiKey(PROVIDER_ID).discoveryApiKey;
      if (!key) return null;
      return load(baseUrlFor(ctx.config), key, ctx);
    },
  };
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "BeLive AI Hub",
  description: "BeLive AI Hub model, image, video, speech, speech-to-text and media-understanding provider",
  register(api) {
    const jobs = fileJobStore(() => path.join(api.runtime.state.resolveStateDir(), PROVIDER_ID, "video-jobs"));
    api.registerProvider({
      id: PROVIDER_ID,
      label: "BeLive AI Hub",
      docsPath: "https://aihub.belive.sg/docs/openclaw",
      envVars: [KEY_ENV],
      auth: [createProviderApiKeyAuthMethod({
        providerId: PROVIDER_ID,
        methodId: "api-key",
        label: "BeLive AI Hub API key",
        hint: "Workspace inference key from aihub.belive.sg",
        optionKey: "beliveAihubApiKey",
        flagName: "--belive-aihub-api-key",
        envVar: KEY_ENV,
        promptMessage: "Enter your BeLive AI Hub workspace inference key",
        defaultModel: `${PROVIDER_ID}/${DEFAULT_MODEL}`,
      })],
      catalog: {
        order: "simple",
        async run(ctx) {
          // `apiKey` is the config-safe value (an env name or marker); only `discoveryApiKey` is the secret.
          const { apiKey, discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
          if (!apiKey || !discoveryApiKey) return null;
          const baseUrl = officialBaseUrl(ctx.config.models?.providers?.[PROVIDER_ID]?.baseUrl ?? BASE_URL);
          const models = await fetchCatalog(baseUrl, discoveryApiKey, ctx.signal);
          live.set(baseUrl, { at: Date.now(), models });
          return { provider: { baseUrl, apiKey, api: "openai-completions", models } };
        },
      },
      resolveDynamicModel(ctx) {
        if (ctx.provider !== PROVIDER_ID) return;
        const config = ctx.providerConfig;
        const baseUrl = officialBaseUrl(config?.baseUrl ?? BASE_URL);
        const model = config?.models?.find(row => row.id === ctx.modelId);
        if (!model || !model.input.includes("text")) return;
        return runtimeModel(model, baseUrl);
      },
      // A configured row is checked against the live catalogue, so an upgraded install does not
      // keep the capabilities it saved earlier.
      preferRuntimeResolvedModel: ctx => ctx.provider === PROVIDER_ID,
      async prepareDynamicModel(ctx) {
        if (ctx.provider !== PROVIDER_ID) return;
        let baseUrl: string;
        try {
          baseUrl = officialBaseUrl(ctx.providerConfig?.baseUrl ?? baseUrlFor(ctx.config));
        } catch {
          return;
        }
        let models = live.get(baseUrl);
        if (!models || Date.now() - models.at > LIVE_TTL_MS) {
          try {
            models = { at: Date.now(), models: await fetchCatalog(baseUrl, await resolveApiKey(ctx.config, ctx.agentDir)) };
          } catch {
            return; // No key or no network: the saved row is used, as before.
          }
          live.set(baseUrl, models);
        }
        const model = models.models.find(row => row.id === ctx.modelId);
        return model && runtimeModel(model, baseUrl);
      },
      // OpenClaw keeps a hand-saved row's input list over the live one, so the input list is set
      // here, last, from the catalogue fetched above.
      normalizeResolvedModel(ctx) {
        if (ctx.provider !== PROVIDER_ID) return;
        let baseUrl: string;
        try {
          baseUrl = officialBaseUrl(ctx.model.baseUrl);
        } catch {
          return;
        }
        const model = live.get(baseUrl)?.models.find(row => row.id === ctx.model.id);
        if (!model || same(model.input, ctx.model.input)) return;
        return { ...ctx.model, input: runtimeModel(model, baseUrl).input };
      },
    });
    api.registerModelCatalogProvider({
      provider: PROVIDER_ID,
      kinds: ["text"],
      async liveCatalog(ctx) {
        const key = ctx.resolveProviderApiKey(PROVIDER_ID).discoveryApiKey;
        if (!key) return null;
        const baseUrl = officialBaseUrl(ctx.config.models?.providers?.[PROVIDER_ID]?.baseUrl ?? BASE_URL);
        const models = await fetchCatalog(baseUrl, key, ctx.signal);
        return models.map(model => ({
          kind: "text" as const,
          provider: PROVIDER_ID,
          model: model.id,
          label: model.name,
          source: "live" as const,
        }));
      },
    });
    api.registerImageGenerationProvider(buildImageProvider());
    api.registerVideoGenerationProvider(createVideoProvider({ jobs }));
    api.registerSpeechProvider(buildSpeechProvider());
    api.registerMediaUnderstandingProvider(buildUnderstandingProvider());
    api.registerModelCatalogProvider(mediaCatalog("image_generation", async (baseUrl, key, ctx) =>
      (await fetchImageModels(baseUrl, key, { signal: ctx.signal })).map(model => ({
        kind: "image_generation" as const, provider: PROVIDER_ID, model: model.id, label: model.name, source: "live" as const,
      }))));
    api.registerModelCatalogProvider(mediaCatalog("video_generation", async (baseUrl, key, ctx) =>
      (await fetchVideoModels(baseUrl, key, { signal: ctx.signal })).map(model => ({
        kind: "video_generation" as const, provider: PROVIDER_ID, model: model.id, label: model.name, source: "live" as const,
        capabilities: videoCapabilities(model),
      }))));
    api.registerModelCatalogProvider(mediaCatalog("voice", async (baseUrl, key, ctx) =>
      (await fetchSpeechModels(baseUrl, key, { signal: ctx.signal })).map(model => ({
        kind: "voice" as const, provider: PROVIDER_ID, model: model.id, label: model.name, source: "live" as const,
      }))));
  },
});
