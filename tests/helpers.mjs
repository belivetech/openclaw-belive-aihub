import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A fake plugin API that records every registration. */
export function fakeApi(stateDir = mkdtempSync(path.join(tmpdir(), "belive-state-"))) {
  const registered = { providers: [], catalogs: [], image: [], video: [], speech: [], understanding: [] };
  return {
    registered,
    api: {
      runtime: { state: { resolveStateDir: () => stateDir } },
      registerProvider: value => registered.providers.push(value),
      registerModelCatalogProvider: value => registered.catalogs.push(value),
      registerImageGenerationProvider: value => registered.image.push(value),
      registerVideoGenerationProvider: value => registered.video.push(value),
      registerSpeechProvider: value => registered.speech.push(value),
      registerMediaUnderstandingProvider: value => registered.understanding.push(value),
    },
  };
}

/** A fetch mock: routes are [method, url-substring, responder]; every call is recorded without secrets masked. */
export function routedFetch(routes) {
  const calls = [];
  const mock = async (url, options = {}) => {
    const method = (options.method ?? "GET").toUpperCase();
    const headers = new Headers(options.headers ?? {});
    const call = { method, url: String(url), headers, body: options.body, redirect: options.redirect };
    calls.push(call);
    for (const route of routes) {
      if (route.method === method && String(url).includes(route.match) && (route.times === undefined || route.times-- > 0)) {
        const result = typeof route.respond === "function" ? route.respond(call) : route.respond;
        if (result instanceof Error) throw result;
        return result;
      }
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  return { mock, calls };
}

export const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

export const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
export const MP4_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(32, 1)]);
export const WAV_BYTES = Buffer.concat([Buffer.from("RIFF"), Buffer.from([40, 0, 0, 0]), Buffer.from("WAVEfmt "), Buffer.alloc(32)]);
