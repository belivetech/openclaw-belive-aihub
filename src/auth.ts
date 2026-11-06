import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { isNonSecretApiKeyMarker, isProviderApiKeyConfiguredAsync, resolveProviderAuthProfileApiKey } from "openclaw/plugin-sdk/provider-auth";
import { BASE_URL, KEY_ENV, PROVIDER_ID, officialBaseUrl } from "./catalog.js";

/** The official API base for this config: production unless `models.providers.belive-aihub.baseUrl` names staging. */
export function baseUrlFor(cfg?: OpenClawConfig): string {
  return officialBaseUrl(cfg?.models?.providers?.[PROVIDER_ID]?.baseUrl ?? BASE_URL);
}

function usable(value: string | undefined): string | undefined {
  const key = value?.trim();
  // The env var's *name* and secret-ref markers are config-safe stand-ins, never a bearer token.
  return key && key !== KEY_ENV && !isNonSecretApiKeyMarker(key) ? key : undefined;
}

/**
 * The BeLive AI Hub key for media calls: a stored `belive-aihub` auth profile (a pasted key or an
 * env reference), else `BELIVE_TOKENHUB_API_KEY`. No other provider's profile or env var is read.
 */
export async function resolveApiKey(cfg?: OpenClawConfig, agentDir?: string): Promise<string> {
  const stored = usable(await resolveProviderAuthProfileApiKey({ provider: PROVIDER_ID, cfg, agentDir }));
  const key = stored ?? usable(process.env[KEY_ENV]);
  if (!key) {
    throw new Error(`BeLive AI Hub needs ${KEY_ENV} or a saved BeLive AI Hub API key (openclaw models auth paste-api-key --provider ${PROVIDER_ID})`);
  }
  return key;
}

export async function isConfigured(ctx: { cfg?: OpenClawConfig; agentDir?: string }): Promise<boolean> {
  if (usable(process.env[KEY_ENV])) return true;
  return isProviderApiKeyConfiguredAsync({ provider: PROVIDER_ID, cfg: ctx.cfg, agentDir: ctx.agentDir });
}
