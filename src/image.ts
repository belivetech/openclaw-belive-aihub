import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { baseUrlFor, isConfigured, resolveApiKey } from "./auth.js";
import { PROVIDER_ID } from "./catalog.js";
import { bearer, fetchJson, record } from "./http.js";
import { fetchImageModels, type ImageModel } from "./media-catalog.js";
import { extensionFor, sniffImage } from "./sniff.js";

type ImageProvider = Parameters<OpenClawPluginApi["registerImageGenerationProvider"]>[0];
type ImageRequest = Parameters<ImageProvider["generateImage"]>[0];

export const DEFAULT_IMAGE_MODEL = "qwen/qwen-image-2.1-turbo";
/** Some models run up to 300 s inside the request; an uncertain image is never resubmitted automatically. */
const IMAGE_TIMEOUT_MS = 330_000;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

const accepted = (model: ImageModel) =>
  model.sizes.map(pair => `${pair.size} (${pair.aspectRatio}, ${pair.resolution})`).join(", ");

/** Picks the request's geometry fields from the model's own offered pairs, or refuses before any charge. */
export function imageGeometry(model: ImageModel, req: Pick<ImageRequest, "size" | "aspectRatio" | "resolution">): Record<string, string> {
  const { size, aspectRatio, resolution } = req;
  if (!size && !aspectRatio && !resolution) return {};
  if (model.sizes.length === 0) {
    return { ...(size ? { size } : {}), ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}), ...(resolution ? { resolution } : {}) };
  }
  const refuse = (what: string) => new Error(
    `BeLive AI Hub image model ${model.id} does not offer ${what}. Offered: ${accepted(model)}`);
  if (size) {
    const wanted = size.toLowerCase().replace("×", "x");
    const pair = model.sizes.find(item => item.size === wanted);
    if (!pair) throw refuse(`size ${size}`);
    if ((aspectRatio && aspectRatio !== pair.aspectRatio) || (resolution && resolution !== pair.resolution)) {
      throw refuse(`size ${size} together with ${[aspectRatio, resolution].filter(Boolean).join(" ")}`);
    }
    return { size: pair.size };
  }
  const matches = model.sizes.filter(item =>
    (!aspectRatio || item.aspectRatio === aspectRatio) && (!resolution || item.resolution === resolution));
  if (matches.length === 0) throw refuse([aspectRatio, resolution].filter(Boolean).join(" "));
  return { ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}), ...(resolution ? { resolution } : {}) };
}

function references(model: ImageModel, images: NonNullable<ImageRequest["inputImages"]>) {
  if (!model.acceptsReferences) {
    throw new Error(`BeLive AI Hub image model ${model.id} does not accept reference images`);
  }
  return images.map(image => {
    const mime = sniffImage(image.buffer);
    if (!mime) throw new Error("BeLive AI Hub reference images must be PNG, JPEG or WebP");
    return { type: "image_url", image_url: { url: `data:${mime};base64,${image.buffer.toString("base64")}` } };
  });
}

export async function generateImage(req: ImageRequest) {
  if ((req.count ?? 1) !== 1) {
    throw new Error("BeLive AI Hub image models return one image per request; ask for one image at a time");
  }
  const baseUrl = baseUrlFor(req.cfg);
  const apiKey = await resolveApiKey(req.cfg, req.agentDir);
  const timeoutMs = req.timeoutMs ?? IMAGE_TIMEOUT_MS;
  const model = (await fetchImageModels(baseUrl, apiKey, { timeoutMs: Math.min(timeoutMs, 8000) }))
    .find(row => row.id === req.model);
  if (!model) throw new Error(`BeLive AI Hub does not list an image generation model named ${req.model}`);
  const body = {
    model: model.id,
    prompt: req.prompt,
    ...imageGeometry(model, req),
    ...(req.inputImages?.length ? { input_references: references(model, req.inputImages) } : {}),
  };
  const payload = record(await fetchJson(baseUrl + "/images/generations", {
    method: "POST", headers: bearer(apiKey, { "Content-Type": "application/json" }), body: JSON.stringify(body),
  }, "image generation", { timeoutMs }));
  const first = record(Array.isArray(payload?.data) ? payload.data[0] : undefined);
  const encoded = first?.b64_json;
  const bytes = typeof encoded === "string" ? Buffer.from(encoded, "base64") : undefined;
  const mime = bytes ? sniffImage(bytes) : undefined;
  if (!bytes || bytes.length > MAX_IMAGE_BYTES || !mime) {
    // The request was accepted and may have been charged; say so rather than retrying.
    throw new Error("BeLive AI Hub image generation returned no usable PNG, JPEG or WebP data; the request may have been charged, so check Activity before retrying");
  }
  return {
    images: [{
      buffer: bytes, mimeType: mime, fileName: `image.${extensionFor(mime)}`,
      ...(typeof first?.revised_prompt === "string" ? { revisedPrompt: first.revised_prompt } : {}),
    }],
    model: model.id,
  };
}

export function buildImageProvider(): ImageProvider {
  return {
    id: PROVIDER_ID,
    label: "BeLive AI Hub",
    defaultModel: DEFAULT_IMAGE_MODEL,
    defaultTimeoutMs: IMAGE_TIMEOUT_MS,
    capabilities: {
      // Sizes differ per model, so geometry is checked against the live catalogue in generateImage.
      generate: { maxCount: 1, supportsSize: true, supportsAspectRatio: true, supportsResolution: true },
      edit: { enabled: true, maxCount: 1, supportsSize: true, supportsAspectRatio: true, supportsResolution: true },
    },
    isConfiguredAsync: isConfigured,
    generateImage,
  };
}
