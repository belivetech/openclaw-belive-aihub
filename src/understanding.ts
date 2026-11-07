import type { MediaUnderstandingProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { BASE_URL, DEFAULT_MODEL, PROVIDER_ID, officialBaseUrl } from "./catalog.js";
import { bearer, fetchJson, record } from "./http.js";
import { fetchModelInputs } from "./media-catalog.js";
import { DEFAULT_TRANSCRIPTION_MODEL, createTranscription, type TranscriptionDeps } from "./transcription.js";

const DEFAULT_PROMPT = "Describe the video.";

function replyText(payload: unknown): string | undefined {
  const message = record(record(Array.isArray(record(payload)?.choices) ? (record(payload)?.choices as unknown[])[0] : undefined)?.message);
  const content = message?.content;
  const text = Array.isArray(content)
    ? content.map(part => (typeof record(part)?.text === "string" ? (record(part)?.text as string).trim() : "")).filter(Boolean).join("\n")
    : typeof content === "string" ? content.trim() : "";
  const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
  return text || reasoning || undefined;
}

/**
 * Media understanding for BeLive AI Hub. Images need no adapter: the host reads them with any
 * `belive-aihub/*` chat model whose catalogue input includes `image`. Video is sent to Chat
 * Completions as a `video_url` part, only for a model whose catalogue input includes `video`.
 * Audio is transcribed by `POST /audio/transcriptions` (see `transcription.ts`). There is no
 * `autoPriority`, so the host never selects this provider on its own.
 */
export function buildUnderstandingProvider(deps: TranscriptionDeps = {}): MediaUnderstandingProviderPlugin {
  return {
    id: PROVIDER_ID,
    capabilities: ["image", "video", "audio"],
    defaultModels: { image: DEFAULT_MODEL, video: DEFAULT_MODEL, audio: DEFAULT_TRANSCRIPTION_MODEL },
    ...createTranscription(deps),
    describeImage: undefined,
    describeImages: undefined,
    async describeVideo(params) {
      const baseUrl = officialBaseUrl(params.baseUrl ?? BASE_URL);
      const model = params.model?.trim() || DEFAULT_MODEL;
      if (!params.apiKey) throw new Error("BeLive AI Hub video understanding needs a BeLive AI Hub key");
      const inputs = (await fetchModelInputs(baseUrl, params.apiKey, { timeoutMs: 8000, signal: params.signal })).get(model);
      if (!inputs?.includes("video")) {
        throw new Error(`BeLive AI Hub does not list ${model} as a model that accepts video`);
      }
      const mime = params.mime?.trim() || "video/mp4";
      const payload = await fetchJson(baseUrl + "/chat/completions", {
        method: "POST",
        headers: bearer(params.apiKey, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          model,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: params.prompt?.trim() || DEFAULT_PROMPT },
              { type: "video_url", video_url: { url: `data:${mime};base64,${params.buffer.toString("base64")}` } },
            ],
          }],
        }),
      }, "video understanding", { timeoutMs: params.timeoutMs, signal: params.signal });
      const text = replyText(payload);
      if (!text) throw new Error("BeLive AI Hub video understanding returned no text");
      return { text, model };
    },
  };
}
