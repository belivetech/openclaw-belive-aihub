import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { baseUrlFor, isConfigured, resolveApiKey } from "./auth.js";
import { KEY_ENV, PROVIDER_ID } from "./catalog.js";
import { bearer, fetchChecked, readLimited, record } from "./http.js";
import { isWav } from "./sniff.js";

type SpeechProvider = Parameters<OpenClawPluginApi["registerSpeechProvider"]>[0] extends infer P
  ? Exclude<P, (...args: never[]) => unknown> : never;

export const DEFAULT_SPEECH_MODEL = "qwen/qwen-audio-3.0-tts-flash";
export const DEFAULT_SPEECH_VOICE = "loongjohn";
/** Voices the AI Hub speech docs name for the default models. Voice names are case-sensitive and per model. */
const KNOWN_VOICES = ["loongjohn", "longanhuan_v3.6", "longanlingxin", "longanlufeng"];
const MAX_CHARACTERS = 600;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const SPEECH_TIMEOUT_MS = 120_000;
/** Formats a model is known to return besides WAV. Every model starts WAV-only; add a model here only once the gateway documents it. */
const FORMATS_BY_MODEL: Readonly<Record<string, readonly string[]>> = {};

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

function readSpeechConfig(config: Record<string, unknown> | undefined) {
  return {
    model: text(config?.model ?? config?.modelId) ?? DEFAULT_SPEECH_MODEL,
    voice: text(config?.voice ?? config?.voiceId) ?? DEFAULT_SPEECH_VOICE,
    responseFormat: text(config?.responseFormat)?.toLowerCase() ?? "wav",
  };
}

/** `tts.providers.belive-aihub` from the raw `tts` config: `model`, `voice` and `responseFormat`. */
export function resolveSpeechConfig(raw: Record<string, unknown> | undefined) {
  return readSpeechConfig(record(record(raw?.providers)?.[PROVIDER_ID]) ?? record(raw?.[PROVIDER_ID]));
}

export function buildSpeechProvider(): SpeechProvider {
  return {
    id: PROVIDER_ID,
    label: "BeLive AI Hub",
    // Sorted after providers that are not billed per character; an explicit `tts.provider` always wins.
    autoSelectOrder: 60,
    defaultModel: DEFAULT_SPEECH_MODEL,
    defaultTimeoutMs: SPEECH_TIMEOUT_MS,
    voices: KNOWN_VOICES,
    resolveConfig: ({ rawConfig }) => resolveSpeechConfig(rawConfig),
    // The synchronous check is the host's deprecated one; isConfiguredAsync below is authoritative.
    isConfigured: () => Boolean(process.env[KEY_ENV]?.trim()),
    isConfiguredAsync: ({ cfg }) => isConfigured({ cfg }),
    listVoices: async () => KNOWN_VOICES.map(voice => ({ id: voice, name: voice })),
    async synthesize(req) {
      const config = readSpeechConfig(req.providerConfig);
      const model = text(req.providerOverrides?.model ?? req.providerOverrides?.modelId) ?? config.model;
      const voice = text(req.providerOverrides?.voice ?? req.providerOverrides?.voiceId) ?? config.voice;
      const length = Array.from(req.text).length;
      if (length < 1 || length > MAX_CHARACTERS) {
        throw new Error(`BeLive AI Hub speech takes 1 to ${MAX_CHARACTERS} characters per request; this text has ${length}`);
      }
      const formats = ["wav", ...(FORMATS_BY_MODEL[model] ?? [])];
      if (!formats.includes(config.responseFormat)) {
        throw new Error(`BeLive AI Hub speech model ${model} returns ${formats.join(", ")} only; responseFormat "${config.responseFormat}" is not available`);
      }
      const baseUrl = baseUrlFor(req.cfg);
      const apiKey = await resolveApiKey(req.cfg);
      const response = await fetchChecked(baseUrl + "/audio/speech", {
        method: "POST",
        headers: bearer(apiKey, { "Content-Type": "application/json", Accept: "audio/*" }),
        body: JSON.stringify({ model, input: req.text, voice, response_format: config.responseFormat }),
      }, "speech synthesis", { timeoutMs: req.timeoutMs });
      const audio = await readLimited(response, MAX_AUDIO_BYTES, "speech audio");
      if (config.responseFormat === "wav" && !isWav(audio)) {
        throw new Error("BeLive AI Hub speech synthesis did not return WAV audio; the request may have been charged, so check Activity before retrying");
      }
      return { audioBuffer: audio, outputFormat: config.responseFormat, fileExtension: `.${config.responseFormat}`, voiceCompatible: false };
    },
  };
}
