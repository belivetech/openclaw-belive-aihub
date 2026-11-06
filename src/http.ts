/** Small HTTP helpers shared by the media adapters. Every request goes to an official AI Hub base URL. */

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;

export class BeliveApiError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = "BeliveApiError";
  }
}

export type RequestOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Statuses besides 2xx the caller handles itself, such as a download redirect. */
  accept?: (status: number) => boolean;
};

/** The gateway's `error.message`, trimmed, or nothing. Never echoes headers or the request body. */
function errorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const raw = typeof parsed.error === "string" ? parsed.error
      : typeof parsed.error?.message === "string" ? parsed.error.message
        : typeof parsed.message === "string" ? parsed.message : "";
    // eslint-disable-next-line no-control-regex
    return raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
  } catch {
    return "";
  }
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 120) * 1000 : undefined;
}

export async function readLimited(response: Response, maxBytes: number, label: string): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new BeliveApiError(`${label} is larger than the ${Math.floor(maxBytes / 1048576)} MiB limit`);
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new BeliveApiError(`${label} is larger than the ${Math.floor(maxBytes / 1048576)} MiB limit`);
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** One request with a deadline. Network failures and non-2xx answers become a sanitized {@link BeliveApiError}. */
export async function fetchChecked(
  url: string,
  init: RequestInit,
  label: string,
  options: RequestOptions,
): Promise<Response> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await globalThis.fetch(url, { redirect: "error", ...init, signal });
  } catch {
    if (options.signal?.aborted) throw new BeliveApiError(`BeLive AI Hub ${label} was cancelled`);
    if (timeout.aborted) throw new BeliveApiError(`BeLive AI Hub ${label} timed out after ${Math.round(options.timeoutMs / 1000)} s`);
    throw new BeliveApiError(`BeLive AI Hub ${label} failed: network error`);
  }
  if (response.ok || options.accept?.(response.status)) return response;
  const detail = errorDetail((await readLimited(response, MAX_ERROR_BYTES, "error body").catch(() => Buffer.alloc(0))).toString("utf8"));
  throw new BeliveApiError(
    `BeLive AI Hub ${label} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    response.status,
    retryAfterMs(response),
  );
}

export async function fetchJson(
  url: string,
  init: RequestInit,
  label: string,
  options: RequestOptions,
): Promise<unknown> {
  const response = await fetchChecked(url, init, label, options);
  const body = await readLimited(response, MAX_JSON_BYTES, `${label} response`);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new BeliveApiError(`BeLive AI Hub ${label} returned a response that is not JSON`);
  }
}

export function bearer(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, Accept: "application/json", ...extra };
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
