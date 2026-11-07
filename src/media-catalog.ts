import { bearer, fetchJson, record, stringList, type RequestOptions } from "./http.js";

/** Rows from the live AI Hub media catalogues. Nothing here is a bundled model list. */
export type ImageSize = { aspectRatio: string; resolution: string; size: string };
export type ImageModel = {
  id: string; name: string; sizes: ImageSize[]; acceptsReferences: boolean;
};
export type VideoModel = {
  id: string; name: string; resolutions: string[]; aspectRatios: string[]; durations: number[];
  frameRoles: string[]; parameters: string[]; acceptsImages: boolean;
};
export type SpeechModel = { id: string; name: string };
export type TranscriptionModel = { id: string; name: string };

function ready(row: Record<string, unknown>, route: string): boolean {
  return Array.isArray(row.endpoints) && row.endpoints.some(item => {
    const endpoint = record(item);
    return endpoint?.route === route && endpoint?.status === "ready";
  });
}

function rows(payload: unknown, route: string): Array<{ row: Record<string, unknown>; id: string; name: string }> {
  const data = record(payload)?.data;
  if (!Array.isArray(data)) throw new Error("Invalid BeLive AI Hub model catalog");
  const seen = new Set<string>();
  const result: Array<{ row: Record<string, unknown>; id: string; name: string }> = [];
  for (const item of data) {
    const row = record(item);
    const id = row?.id;
    if (!row || typeof id !== "string" || !id.includes("/") || /\s/.test(id) || seen.has(id) || !ready(row, route)) continue;
    seen.add(id);
    result.push({ row, id, name: typeof row.name === "string" && row.name ? row.name : id });
  }
  return result;
}

export function mapImageModels(payload: unknown): ImageModel[] {
  return rows(payload, "image_generations").map(({ row, id, name }) => {
    const sizes: ImageSize[] = [];
    const options = record(row.tokenhub_image_options);
    for (const item of Array.isArray(options?.sizes) ? options.sizes : []) {
      const pair = record(item);
      if (typeof pair?.size === "string" && typeof pair.aspect_ratio === "string" && typeof pair.resolution === "string") {
        sizes.push({ size: pair.size, aspectRatio: pair.aspect_ratio, resolution: pair.resolution });
      }
    }
    const inputs = stringList(record(row.architecture)?.input_modalities);
    return {
      id, name, sizes,
      acceptsReferences: inputs.includes("image") && stringList(row.supported_parameters).includes("input_references"),
    };
  });
}

export function mapVideoModels(payload: unknown): VideoModel[] {
  return rows(payload, "video_generations").map(({ row, id, name }) => ({
    id, name,
    resolutions: stringList(row.supported_resolutions),
    aspectRatios: stringList(row.supported_aspect_ratios),
    durations: Array.isArray(row.supported_durations)
      ? row.supported_durations.filter((n): n is number => Number.isSafeInteger(n)) : [],
    frameRoles: stringList(row.supported_frame_images),
    parameters: stringList(row.supported_parameters),
    acceptsImages: stringList(record(row.architecture)?.input_modalities).includes("image"),
  }));
}

export function mapSpeechModels(payload: unknown): SpeechModel[] {
  return rows(payload, "audio_speech").map(({ id, name }) => ({ id, name }));
}

/** Speech-to-text models: rows with a ready `audio_transcriptions` endpoint. */
export function mapTranscriptionModels(payload: unknown): TranscriptionModel[] {
  return rows(payload, "audio_transcriptions").map(({ id, name }) => ({ id, name }));
}

const CATALOG_TIMEOUT_MS = 8000;

function get(baseUrl: string, path: string, apiKey: string, options?: Partial<RequestOptions>) {
  return fetchJson(baseUrl + path, { headers: bearer(apiKey) }, "model discovery",
    { timeoutMs: CATALOG_TIMEOUT_MS, ...options });
}

export async function fetchImageModels(baseUrl: string, apiKey: string, options?: Partial<RequestOptions>) {
  return mapImageModels(await get(baseUrl, "/images/models", apiKey, options));
}
export async function fetchVideoModels(baseUrl: string, apiKey: string, options?: Partial<RequestOptions>) {
  return mapVideoModels(await get(baseUrl, "/videos/models", apiKey, options));
}
export async function fetchSpeechModels(baseUrl: string, apiKey: string, options?: Partial<RequestOptions>) {
  return mapSpeechModels(await get(baseUrl, "/models?output_modalities=audio", apiKey, options));
}
/** `output_modalities=audio` lists speech synthesis only; speech-to-text rows appear under `all`. */
export async function fetchTranscriptionModels(baseUrl: string, apiKey: string, options?: Partial<RequestOptions>) {
  return mapTranscriptionModels(await get(baseUrl, "/models?output_modalities=all", apiKey, options));
}
/** Raw chat catalogue rows, used to check a model's input modalities before a paid understanding call. */
export async function fetchModelInputs(baseUrl: string, apiKey: string, options?: Partial<RequestOptions>) {
  const data = record(await get(baseUrl, "/models", apiKey, options))?.data;
  const inputs = new Map<string, string[]>();
  for (const item of Array.isArray(data) ? data : []) {
    const row = record(item);
    if (typeof row?.id === "string") inputs.set(row.id, stringList(record(row.architecture)?.input_modalities));
  }
  return inputs;
}
