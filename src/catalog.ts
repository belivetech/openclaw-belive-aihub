import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";

export const PROVIDER_ID = "belive-aihub";
export const KEY_ENV = "BELIVE_TOKENHUB_API_KEY";
export const BASE_URL = "https://tokenhub-api.belive.sg/api/v1";
export const STAGING_URL = "https://api-stg-tokenhub.belive.sg/api/v1";
export const DEFAULT_MODEL = "qwen/qwen3.8-flash";
const MAX_BYTES = 4 * 1024 * 1024;
const OUTPUT_CAP = 4096;

type RecordValue = Record<string, unknown>;
export type CatalogModel = Pick<ProviderRuntimeModel,
  "id" | "name" | "reasoning" | "input" | "cost" | "contextWindow" | "maxTokens">;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : undefined;
}

export function officialBaseUrl(value: unknown = BASE_URL): string {
  const base = typeof value === "string" ? value.replace(/\/+$/, "") : "";
  if (base !== BASE_URL && base !== STAGING_URL) {
    throw new Error("BeLive AI Hub requires an official production or staging HTTPS API base URL");
  }
  return base;
}

export function perMillion(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value) || value.length > 40) return;
  const [whole, fraction = ""] = value.split(".");
  // Shift the decimal as text/integers before the final conversion to the host's UI number.
  const digits = BigInt(whole + fraction);
  const denominator = 10n ** BigInt(fraction.length);
  const millionths = digits * 1_000_000n;
  const result = Number(millionths) / Number(denominator);
  return Number.isFinite(result) && result <= 1e9 ? result : undefined;
}

export function mapCatalog(payload: unknown): CatalogModel[] {
  const rows = record(payload)?.data;
  if (!Array.isArray(rows)) throw new Error("Invalid BeLive AI Hub model catalog");
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const item of rows) {
    const row = record(item);
    if (!row) continue;
    const { id, name, context_length: context, supported_parameters: parameters, endpoints } = row;
    const architecture = record(row.architecture);
    const outputs = architecture?.output_modalities;
    const inputs = architecture?.input_modalities;
    if (typeof id !== "string" || !id.includes("/") || /\s/.test(id) || seen.has(id)
        || !Array.isArray(outputs) || !outputs.includes("text")
        || !Array.isArray(inputs) || !inputs.includes("text")
        || !Array.isArray(parameters) || !parameters.includes("tools")
        || !Array.isArray(endpoints) || !endpoints.some(item => {
          const endpoint = record(item);
          const supported = endpoint?.supported_parameters;
          return endpoint?.route === "chat_completions" && endpoint?.status === "ready"
            && Array.isArray(supported) && supported.includes("tools");
        })
        || typeof context !== "number" || !Number.isSafeInteger(context) || context < OUTPUT_CAP) continue;
    const pricing = record(row.pricing);
    const priceSpec = record(row.tokenhub_pricing);
    const tiers = priceSpec?.tiers;
    const tiered = (Array.isArray(tiers) && tiers.length > 1)
      || (Array.isArray(pricing?.overrides) && pricing.overrides.length > 0);
    // The host takes one flat rate. A tiered model shows its first (smallest-prompt) tier, which
    // must be the flat `pricing` row; anything else is not a translation we can vouch for.
    const firstTier = Array.isArray(tiers) ? record(tiers[0]) : undefined;
    if (tiered && (!firstTier || firstTier.prompt !== pricing?.prompt
        || firstTier.completion !== pricing?.completion)) continue;
    const input = perMillion(pricing?.prompt);
    const output = perMillion(pricing?.completion);
    if (input === undefined || output === undefined) continue;
    // A missing cache rate falls back to the input rate: an upper bound, never free.
    const cacheRead = perMillion(pricing?.input_cache_read ?? pricing?.cached_prompt);
    const cacheWrite = perMillion(pricing?.cache_write);
    const modelName = typeof name === "string" && name ? name : id;
    models.push({
      id,
      name: modelName + (tiered ? " (tiered pricing)" : ""),
      reasoning: parameters.includes("reasoning_effort") || parameters.includes("thinking")
        || parameters.includes("enable_thinking"),
      input: inputs.includes("image") ? ["text", "image"] : ["text"],
      cost: { input, output, cacheRead: cacheRead ?? input, cacheWrite: cacheWrite ?? input },
      contextWindow: context,
      // A documented client reply budget; the API does not publish the model's true output maximum.
      maxTokens: OUTPUT_CAP,
    });
    seen.add(id);
  }
  return models;
}

export async function fetchCatalog(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<CatalogModel[]> {
  const base = officialBaseUrl(baseUrl);
  if (!apiKey) throw new Error(`BeLive AI Hub requires ${KEY_ENV}`);
  const timeout = AbortSignal.timeout(8000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(base + "/models", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      redirect: "error", signal: combined,
    });
  } catch {
    throw new Error("BeLive AI Hub model discovery failed or was cancelled");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`BeLive AI Hub model discovery returned HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("BeLive AI Hub returned an empty catalog response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("BeLive AI Hub model catalog exceeds supported size");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  try {
    return mapCatalog(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw new Error("BeLive AI Hub returned an invalid or unsupported model catalog");
  }
}
