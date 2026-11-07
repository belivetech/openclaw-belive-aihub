# Validation

Recorded 2026-11-05 against published npm `openclaw@2026.11.1`, matching upstream source commit `4ffdd2047d192dd65554de3c8c46c0e0197c6e2a`, under Node 26.8.2.

- `npm run typecheck`: passed.
- `npm test`: **7 passed, 0 failed**, including a TypeScript build and released-SDK registration.
- `npm pack` and isolated-host local archive installation: passed. The installer required explicit acknowledgment of the independently reviewed local source.
- `plugins inspect belive-aihub --runtime --json`: provider loaded, enabled and activated; `belive-aihub` registered as text inference; no missing dependencies.
- `plugins doctor --json`: no plugin errors, compatibility problems, shadowing or configuration warnings. It returns `ok: false` for unverified provenance, including after the fresh ClawHub install described below.
- Independent source review found no remaining auth, pricing or isolation blockers.

On this host release, `plugins validate --root` expects tool/feature authoring-helper metadata and rejects the generic provider entry documented by the provider SDK. It is not the provider validation gate. No fake metadata or host patch was added to change that result.

Tests cover decimal price-unit conversion, exact nested IDs, capability/protocol filtering, context limits, explicit output-budget policy, labeled cache estimates, unexpected-origin refusal, actual released SDK provider/picker registration, two profile keys, staging routing, missing keys, sanitized discovery errors, no hidden retry, dynamic lookup and explicit rediscovery of added/removed models. Fixture responses do not prove live provider behavior.

Staging qualification passed on 2026-11-05: **3 inference requests**, with **USD 0.00047934 total customer cost**. The real isolated Gateway used a key saved through the released `models auth paste-api-key` command. Its model emitted a streamed `read` tool call, the host read the local fixture, and a second streamed request returned `17 + 38 = 55`. Final usage arrived on both requests. A separate non-streaming companion call used the installed OpenAI SDK with the same staging key/model and returned `QUALIFICATION_OK`; this companion is wire proof, not a claim that the Gateway agent uses non-streaming transport. Activity and authenticated generation lookups matched all three model, usage and charge records. The prepaid balance decreased to USD 4.99952066 with no remaining holds, and the dedicated key was revoked.

The campaign stayed within its original 12-request/600-second window (165.296 seconds from guarded Gateway startup through the companion completion). Its separate organisation had USD 5 prepaid credit, enforcement enabled, auto top-up disabled, a model-restricted key capped at USD 5 and a USD 5 daily/weekly/monthly guardrail. The reviewed transport observer enforced one inference owner, persistent request/time limits across relaunches, exact staging/key/model, a 1024-token reply cap, no redirects and sticky failure stops before any retry. The Gateway exposed only `read` with workspace-only filesystem access. Tool Search, skill-reading tools, heartbeat, automatic compaction, hosted catalog refresh and update checks were disabled for this isolated proof; other model credentials were absent. Real-Gateway offline rehearsal and synthetic guard regressions passed before paid execution.

Sanitized request records are in [qualification-2026-11-05.json](https://github.com/belivetech/openclaw-belive-aihub/blob/main/qualification-2026-11-05.json). Vision remains unqualified. No production inference was performed, and customer-charge matching does not establish supplier invoice reconciliation.

## Registry proof and trust limitation

ClawHub published version 0.1.0 under the BeLive publisher. ClawScan and TruffleHog both returned clean. The registry reports community distribution, artifact-only verification and source-linked metadata; it does not report build provenance. The published archive SHA-256 is `0a81515f43904714a0bf72d392e16eebfba0a44a56a679921114ac579e44b50a`.

A fresh isolated install with `openclaw plugins install clawhub:@belivetech/openclaw-belive-aihub@0.1.0 --accept-capabilities` passed. Runtime inspection reported the provider loaded, enabled and activated. Doctor found no plugin errors, compatibility problems, source shadowing or configuration warnings, but remains `ok: false` with `provenance-invalid`.

This is an official-admission limitation in OpenClaw 2026.11.1: its trust resolver requires a matching entry in the host's official external-plugin catalog/feed. A populated community registry record retains this warning; clean scans and correct package metadata do not confer official trust. The loader warns without refusing runtime access. Independent review confirmed this behavior. No official channel, package identity or install record was substituted, and no host checks were weakened.

Version 0.1.1 updates documentation links and records this registry result; the provider runtime and manifest are unchanged.

## Version 0.1.2

Fixes model discovery for keys supplied through `BELIVE_TOKENHUB_API_KEY` or an environment-reference auth profile. On OpenClaw 2026.11.1, `resolveProviderApiKey` returns the environment variable's *name* in `apiKey` and the secret only in `discoveryApiKey` (`src/agents/models-config.providers.secrets.ts`, "Public auth retains the env name; only discovery consumes its resolved value"). Versions 0.1.0 and 0.1.1 sent `apiKey` as the bearer, so env-sourced setups received HTTP 401 and no models; the qualification above used a pasted key, where both fields hold the same value. Discovery now uses `discoveryApiKey`; the returned provider keeps the config-safe `apiKey`. A non-environment secret reference without a discovery secret returns no catalog instead of sending its marker.

- `npm run typecheck`: passed. `npm test`: **8 passed, 0 failed** under Node 26.8.2. The new env-reference regression fails against the 0.1.1 source (7 passed, 1 failed) and passes with the fix.
- No new paid calls were made. The live chat path is unchanged; only the discovery credential selection changed. [Bundled/official placement remains requested separately](https://github.com/openclaw/openclaw/issues/193454).

## Version 0.1.3

Lists models with tiered (prompt-size-dependent) prices instead of omitting them, and stops renaming models whose cache rates are absent.

- Against the production catalog read on 2026-11-06, 0.1.2 listed 59 of the 78 ready tool-capable chat models; 17 were omitted for tiered prices (all GPT-5.x/6 models, MiniMax M3 and most Qwen Plus/Flash models) and 34 carried a "(cache cost estimate)" suffix. 0.1.3 lists 76: tiered models show their first tier, named "(tiered pricing)", and only when that tier equals the flat `pricing` row. A missing cache rate still uses the input rate. The two remaining omissions, `anthropic/claude-opus-4-5` and `anthropic/claude-sonnet-4-5`, have no `context_length` in the gateway catalog; that is a gateway data gap, and the plugin does not invent a context window.
- Confirmed in the 2026.11.1 completions transport that the model's `maxTokens` is sent as the request output limit when no override is set, and that a per-model `params.maxTokens` override is sent unclamped. The README documents that override; the 4096 budget stays until the API publishes per-model output maximums.
- `npm run typecheck`: passed. `npm test`: **9 passed, 0 failed** under Node 26.8.2. No paid calls; the chat path is unchanged.

## Version 0.1.4

Replaces the flat 4096-token reply budget with the gateway's published output maximum, now live on production `/models` (gateway #2277/#2281, `tokenhub-prod-gateway:278`, 2026-11-06).

- `maxTokens` is `top_provider.max_completion_tokens` capped at 32768; a model with no published maximum, or a value that is not a positive integer, keeps 4096. OpenClaw 2026.11.1 sends `maxTokens` as the request output limit and the gateway reserves credit for it before dispatch, so the cap keeps a model's full maximum (Kimi K3 publishes 1,000,000) out of every request.
- Against the production catalog read on 2026-11-06: 76 models listed; 56 at 32768, three below it (8000, 16000, 32000) and 17 at 4096.
- `npm run typecheck`: passed. `npm test`: **10 passed, 0 failed** under Node 26.8.2. No paid calls; the chat path is unchanged.

## Version 0.1.5

Adds `name` ("BeLive AI Hub") and `description` to `openclaw.plugin.json`. ClawHub flagged 0.1.4 with `manifest-name-missing` because the manifest had no display name. No code change.

- `npm run typecheck`: passed. `npm test`: **10 passed, 0 failed** under Node 26.8.2. No paid calls.

## Version 0.2.0

Adds native BeLive AI Hub adapters for image generation, video generation, speech and media understanding, so media no longer needs `litellm`, `openrouter` or `openai` pointed at AI Hub. Checked 2026-11-06 against published npm `openclaw@2026.11.1` (`4ffdd20`) under Node 26.8.2.

**Implemented:** image generation (`POST /images/generations`, reference-image edits on models that list `input_references`), video generation (`POST /videos` with `Idempotency-Key`, saved job, resume, download), speech (`POST /audio/speech`, WAV), video understanding (`video_url` over Chat Completions), and live-catalogue pickers for image, video and speech models. Image understanding needs no adapter: the host reads images with any `belive-aihub/*` chat model that lists `image`.

**Not provided, with reason:** speech to text (OpenClaw uploads the audio in the request; AI Hub takes a file uploaded beforehand), music, Xiaomi MiMo TTS (served on Chat Completions with its own shape), asynchronous speech jobs, video reference inputs and saved characters (Kling Motion Control), `n` greater than 1 for images (AI Hub allows 1), and webhooks. A feature or option the live catalogue does not offer fails with a message naming what is offered, before any paid request, and never falls back to another provider.

**Host surface:** the adapters import only `plugin-entry` and `provider-auth` from the SDK, the two typed public subpaths this plugin already used, and make their own requests to the two official bases. They do not use the host's private-local `provider-http`, `image-generation`, `video-generation`, `speech-provider` or `provider-auth-runtime` subpaths, or the `media-understanding` subpath, which `plugins doctor` reports as deprecated; a first build that imported its video helper produced that compatibility notice and was replaced. Credentials come from `resolveProviderAuthProfileApiKey` (a pasted key or env-reference profile saved for `belive-aihub`), else `BELIVE_TOKENHUB_API_KEY`.

- `npm run typecheck`: passed. `npm test`: **38 passed, 0 failed** (10 existing, 28 new) under Node 26.8.2 after a clean build. The new tests mock `fetch`, run the real host auth store in a temporary state directory, and cover: an env-backed key (the env name stand-in is never sent), a pasted key in a saved profile that wins over the environment, no request and no use of other providers' env vars or profiles when the BeLive key is absent, official-base enforcement, registration against the manifest contracts, live-catalogue mapping and pickers, image geometry and reference-image refusals, video submit with one stable `Idempotency-Key` across retries and reruns, lookup by key instead of resubmitting, resume after a poll timeout with no second POST, the 15-minute floor, failed/cancelled/expired jobs, 400 refusals without retry, content redirect without the key, non-MP4 downloads, speech length/format refusals and WAV validation, and video-understanding model and endpoint checks.
- `plugins doctor --json` on the tested install: no plugin errors, no compatibility notices, no shadowing or configuration warnings; `ok: false` for the same unverified-provenance warning as earlier versions.

### Live staging run from the packed artifact

`npm pack` produced `belivetech-openclaw-belive-aihub-0.2.0.tgz`, **SHA-256 `4990817d01e99614f0a019fa9329d70fd2901b9127478937bf608a0e7871ec98`**. It was installed with `openclaw plugins install <tarball> --accept-capabilities --force` into a fresh `HOME` and `OPENCLAW_STATE_DIR` for released `openclaw@2026.11.1`; `plugins inspect belive-aihub --runtime --json` showed text inference, image generation, video generation, speech and media understanding registered. `models.providers.belive-aihub.baseUrl` was `https://api-stg-tokenhub.belive.sg/api/v1`; the only credential was `BELIVE_TOKENHUB_API_KEY` in the environment (no auth profile, no other provider key). The release tarball differs from this tested one only in `README.md` and `VALIDATION.md`; `dist/`, `openclaw.plugin.json` and `package.json` are byte-identical. All six features ran through `openclaw infer`:

| Feature | Model | Saved content check | Cost |
| --- | --- | --- | --- |
| Image generation | `qwen/qwen-image-2.1-turbo`, `--size 1024x1024` | PNG, 1024 x 1024 | USD 0.016 (price table) |
| Video generation | `alibaba/wan3.0-video`, 480P, 2 s | `ffprobe`: h264 854x480 + aac, 2.02 s, 682,351 bytes | USD 0.07 (price table) |
| Video resume | same model, new prompt | client killed after the job id was saved; the rerun resumed it. A lookup by the saved key returned the same job id, `completed`; `ffprobe`: h264 854x480 + aac, 2.02 s | USD 0.07 (job `usage.tokenhub_cost`) |
| Speech | `qwen/qwen-audio-3.0-tts-flash`, voice `loongjohn` | `ffprobe`: WAV pcm_s16le, 24 kHz mono, 4.24 s | about USD 0.0007 |
| Image understanding | `z-ai/glm-5.3-flash` | answer named a red circle, a green triangle and the text "BANANA 42" in a drawn test image | under USD 0.001 |
| Video understanding | `qwen/qwen3.8-flash` | answer described a red balloon rising against a blue sky in the generated clip | under USD 0.005 |

The set ran twice, first on a superseded build and then on the tarball above; both passed. Estimated spend across both runs is about USD 0.32 of the USD 2 allowance (four 2 s videos, two images, two speech requests, four chat requests). Sanitized records are in [qualification-2026-11-06-media.json](https://github.com/belivetech/openclaw-belive-aihub/blob/main/qualification-2026-11-06-media.json). Not exercised live: a pasted-key profile (covered by the unit tests against the host's real auth store), reference-image edits, frame images, and production.

Note: `openclaw infer image describe` resolves a `belive-aihub/*` chat model's image input from the cached catalogue, so run `openclaw models list --provider belive-aihub --refresh` after installing; before that refresh the host treated the model as text only.


## Version 0.3.0

Adds speech to text through the host's public audio transcription contract, and the speech formats AI Hub now converts to. Checked 2026-11-07 against published npm `openclaw@2026.11.1` (`4ffdd20`) under Node 26.8.2, with the gateway change that accepts a multipart upload (belivetech/tokenhub-gateway #2292).

**Host surface:** `MediaUnderstandingProviderPlugin` (from `plugin-entry`, the subpath the plugin already used) carries `transcribeAudioWithContext` and `isAudioConfigured`; the provider already registered for video understanding gains the `audio` capability and an audio default model in the manifest. The adapter does not use the host's `transcribeOpenAiCompatibleAudio` helper (it lives in the deprecated `media-understanding` subpath) or any private-local subpath: it builds its own multipart request. It uses `transcribeAudioWithContext` and not `transcribeAudio` so that credentials come from the plugin's own resolver (a saved BeLive profile, else `BELIVE_TOKENHUB_API_KEY`) and the host's key rotation and transient retry never wrap a paid upload. A refusal before the upload returns the host's `{ ok: false }`, which the host defines as a rejection that sent no audio; once the upload begins every failure throws. The plugin declares no `autoPriority`.

**AI Hub contract (read from #2292):** `POST /audio/transcriptions`, `multipart/form-data` with one `file`, `model`, optional `language` (ISO 639-1) and `response_format` (`json` or `text`); `prompt`, `temperature`, `timestamp_granularities` and `stream` are refused; the file is at most 25,000,000 bytes and must be MP3 or WAV by its bytes (a PNG returns 400). The answer is `{ "text" }`, or a job to read on `GET /audio/transcriptions/{id}` for a long-recording model. Speech-to-text rows are listed under `GET /models?output_modalities=all` with a ready `audio_transcriptions` endpoint. Speech `response_format` accepts `mp3`, `opus`, `aac`, `flac`, `wav` and `pcm`, converted from the model's WAV.

**Implemented:** the upload with local checks first (non-empty, at most 25,000,000 bytes, MP3 or WAV by content, two-letter language, official base, BeLive key, model listed by the live catalogue), job reading without a second upload, and `responseFormat` in the `tts` block for the six speech formats, with a content check of the returned bytes. **Not provided:** other input formats, `prompt`, `response_format` other than the default, timestamps and diarisation (the answer's `text` only), and a transcription entry in the model pickers (OpenClaw 2026.11.1 has no such picker kind).

- `npm run typecheck`: passed. `npm test`: **56 passed, 0 failed** (38 existing, 18 new) under Node 26.8.2 after a clean build. The new tests mock `fetch` and run the real host auth store in a temporary state directory. They cover: manifest and registration agreement, no `autoPriority`; the multipart body (only `model`, `language` and `file`, content type from the bytes, no caller file name, no forwarded `prompt`, `query` or `headers`, no hand-set `Content-Type`); an env-backed key with the env-name stand-in never sent; a saved BeLive profile winning over the environment; no request and no use of other providers' keys or profiles when the BeLive key is absent; official-base enforcement and the production default; local refusal of PNG, Ogg, empty and oversized recordings and bad language codes with no request, and the inclusive 25,000,000-byte limit; model refusal listing what is offered; a 400 and a 502 thrown after one upload and never retried; a job read to completion with one upload, a failed job, a job still running at the timeout (naming the job and warning against a second upload), and unreadable answers flagged as possibly charged; the six speech formats sent as chosen, `ogg` refused, and format/content mismatches flagged.
- `plugins doctor --json` on the tested install: no plugin errors, compatibility notices, shadowing or configuration warnings; `ok: false` for the same unverified-provenance warning as earlier versions.

### Live staging run from the packed artifact

`npm pack` produced `belivetech-openclaw-belive-aihub-0.3.0.tgz`, **SHA-256 `6fe84da2f0083560afa1bbef68a99d353e1421d556301d1f43dfc6a6fedc529e`**, installed with `openclaw plugins install <tarball> --accept-capabilities --force` into a fresh `HOME` and `OPENCLAW_STATE_DIR` for released `openclaw@2026.11.1`. `models.providers.belive-aihub.baseUrl` was `https://api-stg-tokenhub.belive.sg/api/v1`; the process environment held only `BELIVE_TOKENHUB_API_KEY`. The release tarball differs from this tested one only in `README.md` and `VALIDATION.md`.

The clip was made by the plugin's own speech adapter from "BeLive AI Hub speech to text test. One, two, three, four, five." (WAV 7.44 s, then MP3 with `responseFormat: mp3`; `ffprobe` confirmed both) and transcribed back through `openclaw infer audio transcribe`:

| Input | Model | Transcript | Cost |
| --- | --- | --- | --- |
| WAV | `qwen/qwen-audio-3.1-asr-flash` (default) | "Belive AI hub speech-to-text test: one, two, three, four, five." | USD 0.00002288 |
| MP3 | `openai/gpt-transcribe` (`tools.media.models`, `language: en`) | "Believe AI Hub speech to text test. One, two, three, four, five." | USD 0.0006 |

**8 paid requests, USD 0.00260564** by the gateway's `/generation` totals (two speech syntheses, six transcriptions); request ids are in [qualification-2026-11-07-stt.json](https://github.com/belivetech/openclaw-belive-aihub/blob/main/qualification-2026-11-07-stt.json). That is two more than the planned six: `infer audio transcribe --model belive-aihub/<model>` selects the provider only, so three requests meant for other models ran the default model, and a fourth followed a rejected config command. The `tools.media.models` entry then proved model selection. An Ogg/Opus recording was refused by the plugin with no request at all, and a PNG sent straight to the route returned 400 `the recording must be an MP3 or WAV file`, uncharged. A first Ogg refusal ran in a shell that held another vendor's key, and OpenClaw's automatic audio selection then passed the recording to that vendor; later runs used a scrubbed environment, and the README now states this host behaviour. Not exercised live: a job (202) answer from a long-recording model (covered by the mocked tests), a pasted-key profile, and production.

### Registry record

ClawHub published 0.3.0 on 2026-11-07 from source commit `81cb0a1a679eff4e5b019fd3d27d2f0b36271efb` (`main`) with tag `latest`; ClawScan reported **clean**. The registry reports community distribution, artifact-only verification and source-linked metadata, as for earlier versions. The published archive SHA-256 is `5678aa06341dc1874b44b5925b149f01e2c791585b95275765ce188ad629d355`. The archive is the registry's zip of this repository's package files, so it differs from the tested tarball above in container format, `README.md` and `VALIDATION.md`; `dist/`, `openclaw.plugin.json` and `package.json` were built from the same commit as the tested tarball's. A fresh install of the published 0.3.0 from the registry was not repeated.

## Version 0.3.1

Fixes two faults a customer test reported on 2026-11-07, and checks the upgrade of an existing configured install rather than only a fresh one.

**Vision on an existing install.** OpenClaw resolves a chat model from the row saved in `models.providers.belive-aihub.models` when one exists. A row saved by the 2026-09 custom-provider recipe, an older plugin or by hand can be text-only for a vision model, and OpenClaw then sends no image, while the model picker (which reads the live catalogue) shows image support. In `openclaw@2026.11.1` a discovered model's details replace a saved row's only when the row came from `models add` (`model.configured-overrides.ts`), so the plugin now uses three provider hooks: `preferRuntimeResolvedModel` makes OpenClaw consult the plugin for a saved row, `prepareDynamicModel` fetches the live catalogue (at most once every 10 minutes per API base, with the BeLive key only), and `normalizeResolvedModel` sets the resolved model's input list from that catalogue. The saved config is not rewritten. Without a key or network the saved row is used as before.

**Speech-to-text default.** The default, `qwen/qwen-audio-3.1-asr-flash`, was live on staging only, so a production key was refused before upload and OpenClaw's automatic audio selection passed the recording to another provider whose key was in the environment. When the account's catalogue does not offer the default, the plugin now uses `qwen/qwen-audio-3.0-asr-flash`; a model the user chose is never swapped. The README now says how to keep recordings on AI Hub only: a single `belive-aihub` audio entry in `tools.media.models`, because OpenClaw then tries only the listed entries (`resolveModelEntries` in `media-understanding/runner.ts`).

- `npm run typecheck`: passed. `npm test`: **59 passed, 0 failed** (56 existing, 3 new) under Node 24.16.0 after a clean build. The new tests cover a text-only saved row resolving with the live catalogue's image input through all three hooks, one catalogue fetch per reuse window, a retired model left to its saved row, no request without a key, and the transcription fallback for the default only.

### Upgrade of a configured install on staging

A fresh `HOME` and `OPENCLAW_STATE_DIR` for released `openclaw@2026.11.1` under Node 24.16.0, with only `BELIVE_TOKENHUB_API_KEY` (staging) in the environment. Published 0.3.0 was installed from ClawHub; the config then received a `belive-aihub` provider block on the staging base with a text-only `qwen/qwen3.8-flash` row, and that model as the default. The packed 0.3.1 tarball was then installed over it with `plugins install <tarball> --force`; the `models` config was byte-for-byte unchanged afterwards.

| Step | Version | Result |
| --- | --- | --- |
| `infer model inspect` | 0.3.0 | `input: ["text"]` |
| `infer model run --local --file red.png` ("one word for the colour") | 0.3.0 | "Unknown": no image sent |
| Same | 0.3.1 | "Red" |
| Same with `blue.png` | 0.3.1 | "Blue" |
| `infer audio transcribe --file clip.wav` (default model) | 0.3.1 | `qwen/qwen-audio-3.1-asr-flash`, "Belive AI hub speech-to-text test: one, two, three, four, five.", `req_gbl03yd131kw3v2ils81g6mtbn`, USD 0.00002288 |

Six paid staging requests in all: five short vision turns on `qwen/qwen3.8-flash` (the CLI does not print their request ids) and one transcription. The vision turns were the 0.3.0 run, two runs of an earlier 0.3.1 build without `normalizeResolvedModel` (answers "white" and "Unknown": no image sent, which is how the `models add` limitation was found), and the two above. The production fallback to 3.0 is covered by the mocked test only, because staging offers 3.1.
