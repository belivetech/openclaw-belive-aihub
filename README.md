# BeLive AI Hub for OpenClaw

A release-compatible provider plugin for [BeLive AI Hub](https://aihub.belive.sg/), maintained by BeLive Technology. It adds BeLive models for chat and tools, image generation, video generation, speech, speech to text and image and video understanding. Requires **OpenClaw 2026.11.1** or later and its supported Node.js runtime. MIT license. Owner contact: Hassan / BeLive Technology; report issues in this repository.

## Install and sign in

Install the community package from its [ClawHub listing](https://clawhub.ai/belivetech/plugins/openclaw-belive-aihub):

```sh
openclaw plugins install clawhub:@belivetech/openclaw-belive-aihub
```

OpenClaw 2026.11.1 installs, loads and activates this community provider, but `plugins doctor` retains a provenance warning. The host reserves official trust for packages admitted to its official catalog/feed. Review the [security audit](https://clawhub.ai/belivetech/plugins/openclaw-belive-aihub/security-audit) and [validation record](https://github.com/belivetech/openclaw-belive-aihub/blob/main/VALIDATION.md). For a local build:

```sh
npm ci --ignore-scripts
npm run build
openclaw plugins install /absolute/path/to/openclaw-belive-aihub
```

Use OpenClaw's normal model-provider authentication flow to select **BeLive AI Hub** and save a workspace inference key. The provider also declares `BELIVE_TOKENHUB_API_KEY` for supported environment-based setup. Keep secrets out of config files, shell history, source control and logs. A background gateway needs its own secret configuration and a restart after changes.

Select a model using its full client reference, such as `belive-aihub/qwen/qwen3.8-flash`. The API receives `qwen/qwen3.8-flash`, preserving the exact gateway model ID. Only explicitly configured client fallbacks are used; this plugin does not enable another service as a fallback.

## Without the plugin

OpenClaw older than 2026.11.1, or a host where you do not want a plugin, can call BeLive AI Hub as a custom OpenAI-compatible provider. It is compatible with the custom-provider recipe in the public [OpenClaw guide](https://aihub.belive.sg/docs/openclaw): same provider id, key name and models. The guide also sets model aliases and covers media settings. It was run against production on OpenClaw 2026.11.1 on 2026-11-09.

Put `BELIVE_TOKENHUB_API_KEY=sk-tokenhub-…` in `~/.openclaw/.env` or the gateway process's environment, not a project `.env`, which OpenClaw does not trust. Do not use `TOKENHUB_API_KEY`: OpenClaw's Tencent TokenHub provider reads that name. Then merge into `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "tokenhub": {
        "baseUrl": "https://tokenhub-api.belive.sg/api/v1",
        "apiKey": "${BELIVE_TOKENHUB_API_KEY}",
        "api": "openai-completions",
        "models": [
          { "id": "z-ai/glm-5.3-flash", "name": "GLM-5.3 Flash", "input": ["text", "image"], "contextWindow": 1000000, "maxTokens": 8192 },
          { "id": "deepseek/deepseek-v4.1-flash-1017", "name": "DeepSeek V4.1 Flash", "input": ["text", "image"], "contextWindow": 1024000, "maxTokens": 8192 }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "tokenhub/z-ai/glm-5.3-flash",
        "fallbacks": ["tokenhub/deepseek/deepseek-v4.1-flash-1017"]
      }
    }
  }
}
```

- Copy `contextWindow` and the input types from `GET https://tokenhub-api.belive.sg/api/v1/models` (`context_length`, `architecture.input_modalities`).
- Set `maxTokens` yourself. AI Hub reserves credit for the output cap of each request, and the plugin caps it for you.
- From OpenClaw 2026.10.5, models marked `reasoning: true` get a top-level `reasoning_effort` (default `medium`). On 2026.10.4 and earlier, add `"compat": { "supportsReasoningEffort": true }` to each model.
- A setup made from an earlier version of the guide used `TOKENHUB_API_KEY`; rename the variable and its `${…}` references together.

What you do not get without the plugin:

| Feature | Plugin | Custom provider |
|---|---|---|
| Chat, tools, fallback, image understanding | Yes | Yes |
| Model list, context and prices | From the live catalogue | Typed by hand |
| Output cap that limits credit holds | Automatic | Your `maxTokens` |
| Image and video generation, speech | Yes | Through per-feature settings in the guide |
| Speech to text, video understanding | Yes | No |
| Address guard, request ids in media errors, video resume | Yes | No |

To move to the plugin later, keep the key name, change model references from `tokenhub/…` to `belive-aihub/…`, and remove the `models.providers.tokenhub` block in the same change.

## Scheduled automations

A scheduled job needs a stored inference account. `BELIVE_TOKENHUB_API_KEY` in the Gateway's environment, or a provider `apiKey` setting, is enough for interactive chat, but OpenClaw does not accept it as the account of an isolated, scheduled job, and refuses to create a new job that would rely on it. A chat that works does not show that a scheduled job can use the same key.

1. Save the key as an auth profile for the job's agent. OpenClaw prompts for it; never put it in a command argument, a document or a log:

   ```sh
   openclaw models auth paste-api-key --provider belive-aihub --agent <job-agent>
   ```

   Use the profile id OpenClaw prints (by default `belive-aihub:manual`).

2. Saving a profile, or changing a job's plain model, does not move an existing job to it. Adopt the account explicitly, keeping the job's model:

   ```sh
   openclaw automations edit <job-id> --model "belive-aihub/<model-id>@<profile-id>"
   ```

   The schedule, instructions, tools, delivery and enabled state are unchanged.

3. Before pinning a job that has no explicit model, check what it really uses: an isolated job can take `agents.defaults.subagents.model` (or the agent's `subagents.model`) ahead of the agent's main model.

4. Check `openclaw automations runs <job-id> --limit 3`: provider `belive-aihub`, the intended model, status `ok`, and delivery status `delivered` when the job sends a message. A queued-run acknowledgement alone proves neither. `openclaw automations run <job-id> --wait` runs the real job, messages included; use it only when you mean to.

Inference accounts are separate from a job's Gmail, Telegram and other tool or delivery accounts. Deleting or replacing the stored profile stops a job bound to it instead of switching accounts.

| Symptom | What to do |
|---|---|
| `Automation has no recorded inference account` | Save a profile and adopt it with `model@profile` |
| `Automation candidate is incompatible with its recorded inference account and route` | The new model's provider differs from the recorded account; adopt a matching profile with `model@profile` |
| Job runs on another provider although the agent's main model is on AI Hub | Check the job's model, any saved session model and `subagents.model` |
| `heartbeat skipped: no-route` | Heartbeat delivery routing; unrelated to the inference account |

Do not repair these by editing OpenClaw's database, removing unrelated provider profiles, changing global model defaults or enabling disabled jobs. Checked against OpenClaw 2026.11.1 ([inference account continuity](https://docs.openclaw.ai/automation/cron-jobs/payloads), [troubleshooting](https://docs.openclaw.ai/automation/cron-jobs/troubleshooting)); used on 2026-11-09 to repair one job on one installation with plugin 0.3.2, not a guarantee for every setup.

## Discovery, context and price estimates

The provider uses the OpenClaw 2026.11.1 `catalog.run`, `registerModelCatalogProvider({ liveCatalog })` and `resolveDynamicModel` contracts. Both catalog surfaces fetch the authenticated account's models from the configured official API endpoint. No `main`-only discovery API is required. Refresh through the host's model listing/restart path; background automatic refresh is not claimed.

Only ready text Chat Completions models with advertised tool support, known context length and representable input/output pricing are listed. Image input is included when the catalog advertises it. Non-chat and unpriced rows, and rows without a published context length, are omitted rather than made to look free or assigned invented limits.

Each model's reply budget is the output maximum AI Hub publishes for it (`top_provider.max_completion_tokens`, the smallest any of its routes accepts), capped at **32768 tokens**. Models with no published maximum keep a **4096-token** budget. OpenClaw 2026.11.1 sends the budget as each request's output limit, and AI Hub reserves credit for that limit before the call, so the plugin does not send a model's full maximum (up to 1,000,000 tokens). To allow more for one model, set a per-model parameter, which OpenClaw sends as given:

```json
{
  "agents": {
    "defaults": {
      "models": {
        "belive-aihub/qwen/qwen3.8-flash": { "params": { "maxTokens": 16384 } }
      }
    }
  }
}
```

Stay within the model's documented output maximum; the upstream refuses larger values.

Prices are converted from per-token API rates to OpenClaw's per-million-token UI units. Models whose price rises with prompt size are named **(tiered pricing)** and show their first (smallest-prompt) tier; longer prompts cost more. If a cache rate is absent, that bucket uses the input-token rate, an upper bound rather than free. Check AI Hub Activity for actual charges; client estimates are not an invoice. If the host cannot represent a future pricing shape, fix the mapper before claiming support for those rows.

The default endpoint is `https://tokenhub-api.belive.sg/api/v1`. For isolated staging qualification, explicitly configure `models.providers.belive-aihub.baseUrl` as `https://api-stg-tokenhub.belive.sg/api/v1` and use a staging key. Catalog requests accept only those two official HTTPS bases, refuse redirects, have an eight-second deadline and a bounded response size. Completion transport and user overrides are host-owned; configure only an endpoint you intend to trust with the key.

## Media: images, video, speech, speech to text and understanding

The plugin registers native BeLive AI Hub adapters for OpenClaw's media features under the same provider id, `belive-aihub`, and the same credential as chat. They never use another provider's identity, settings or credentials: a missing BeLive key fails with a message naming `BELIVE_TOKENHUB_API_KEY`, before any request.

| Feature | OpenClaw setting | Example model | AI Hub route |
| --- | --- | --- | --- |
| Image generation | `agents.defaults.mediaModels.image` | `belive-aihub/qwen/qwen-image-2.1-turbo` | `POST /images/generations` |
| Video generation | `agents.defaults.mediaModels.video` | `belive-aihub/alibaba/wan3.0-video` | `POST /videos`, poll, download |
| Speech (text to speech) | `tts.provider` and `tts.providers.belive-aihub` | `qwen/qwen-audio-3.0-tts-flash` | `POST /audio/speech` |
| Speech to text | `tools.media.models` (`capabilities: ["audio"]`) | `qwen/qwen-audio-3.1-asr-flash` | `POST /audio/transcriptions` |
| Image understanding | any chat model whose input includes `image` | `belive-aihub/z-ai/glm-5.3-flash` | Chat Completions |
| Video understanding | any chat model whose input includes `video` | `belive-aihub/qwen/qwen3.8-flash` | Chat Completions |

```json
{
  "agents": {
    "defaults": {
      "mediaModels": {
        "image": { "primary": "belive-aihub/qwen/qwen-image-2.1-turbo" },
        "video": { "primary": "belive-aihub/alibaba/wan3.0-video" }
      }
    }
  },
  "tts": {
    "provider": "belive-aihub",
    "providers": { "belive-aihub": { "model": "qwen/qwen-audio-3.0-tts-flash", "voice": "loongjohn" } }
  },
  "tools": {
    "media": {
      "models": [{ "provider": "belive-aihub", "model": "qwen/qwen-audio-3.1-asr-flash", "capabilities": ["audio"] }]
    }
  }
}
```

```sh
openclaw infer image generate --model belive-aihub/qwen/qwen-image-2.1-turbo --prompt "A red apple on a white table" --size 1024x1024 --output apple.png
openclaw infer video generate --model belive-aihub/alibaba/wan3.0-video --prompt "A red balloon floating upward" --resolution 480P --duration 2 --output balloon.mp4
openclaw infer tts convert --local --provider belive-aihub --text "Hello from AI Hub." --output hello.wav
openclaw infer audio transcribe --file hello.wav --model belive-aihub/qwen/qwen-audio-3.1-asr-flash
openclaw infer image describe --file photo.png --model belive-aihub/z-ai/glm-5.3-flash
openclaw infer video describe --file clip.mp4 --model belive-aihub/qwen/qwen3.8-flash
```

Run `openclaw models list --provider belive-aihub --refresh` once after installing, so the model picker lists every chat model. Model IDs are always the exact AI Hub IDs. A chat model's details, such as image input, come from the account's live catalogue: from 0.3.1, a model row saved in the config by an older install or by hand is checked against the catalogue when OpenClaw resolves the model, and the catalogue's details win, so a stale text-only row no longer turns off image input. The catalogue is fetched at most once every 10 minutes for this; without a key or network the saved row is used as before.

### How the media adapters behave

- **Request ids for support.** Every media failure that reached AI Hub ends with `(AI Hub request <id>)`, the gateway's `X-Generation-Id`; image results carry it as `metadata.requestId`, and video results as `metadata.generationId` with the `jobId`. Look a completed request up with `GET /generation?id=<id>` (model, provider, cost); a request AI Hub refused before running it is not listed there, so quote its id to BeLive support, who confirm any charge from billing records. Chat requests run through OpenClaw itself; find those in Activity.
- **Live catalogues.** Image, video and speech models come from the account's own `GET /images/models`, `GET /videos/models` and `GET /models?output_modalities=audio`; the pickers list the same rows. Nothing is bundled, so a model AI Hub adds is usable without a plugin release. A model that is not listed, or an option the model does not offer (size, aspect ratio, resolution, duration, audio, seed, reference images), is refused with the list of what the model does offer, before any paid request.
- **Credentials.** The key is a saved BeLive AI Hub auth profile (for example `openclaw models auth paste-api-key --provider belive-aihub`), else `BELIVE_TOKENHUB_API_KEY`. The env var's name, which OpenClaw stores as a stand-in, is never sent as a key.
- **Endpoint.** Production unless `models.providers.belive-aihub.baseUrl` is the official staging base, as for chat. Only those two HTTPS bases are accepted.
- **Images** return one image per request (`n` is 1 on every model). Reference images go to the models that list `input_references`. An image request is never resubmitted automatically, because a rerun is a new charge.
- **Video is resumable and idempotent.** Each submit carries an `Idempotency-Key`, and the key and job ID are saved in one small JSON file per in-flight request under the OpenClaw state directory (`belive-aihub/video-jobs/`; no credential, removed when the video is saved). A call waits at least 15 minutes. If the process is interrupted, or the wait ends, running the same request again resumes the saved job: it looks the job up by key and polls and downloads it; it does not create a second one. A failed, cancelled or expired job ends the call and clears the record, so the next run is a new job. Frame images (`first_frame`, `last_frame`) and reference images are supported where the model lists them. Reference video and audio inputs, such as Kling Motion Control, are not.
- **Speech** takes 1 to 600 characters per request and asks for `wav` unless `tts.providers.belive-aihub.responseFormat` is `mp3`, `opus`, `aac`, `flac`, `wav` or `pcm` (`pcm` is raw 24 kHz mono 16-bit samples). AI Hub converts the model's WAV, so every model offers every format; `ogg` and anything else is refused before the request, and bytes that are not the format asked for are reported as a possible charge. Voice names are case-sensitive and belong to a model, so set `voice` to one the model supports (`loongjohn` for the Qwen models). OpenClaw lists `loongjohn`, `longanhuan_v3.6`, `longanlingxin` and `longanlufeng` as voice hints.
- **Speech to text** uploads a WAV or MP3 recording (recognised by its bytes, not its name; 1 to 25,000,000 bytes) as multipart to `POST /audio/transcriptions` and returns the text. It sends only `model` and, if you set one, a two-letter `language` (`en-US` is sent as `en`). AI Hub refuses a `prompt`, so the host's prompt hint and extra query values are not sent. Models come from the account's live catalogue (`GET /models?output_modalities=all`, rows with a ready `audio_transcriptions` endpoint, which is where AI Hub lists speech-to-text models); a model that is not listed is refused with the list of what is, before the upload. The default is `qwen/qwen-audio-3.1-asr-flash`; if the account's catalogue does not offer it, `qwen/qwen-audio-3.0-asr-flash` is used instead. A model you chose is never swapped. OpenClaw 2026.11.1 chooses the model from `tools.media.models`, or this default: `openclaw infer audio transcribe --model belive-aihub/...` selects the provider only, so use the `tools.media.models` entry above to pick another model such as `openai/gpt-transcribe`. Each model has its own length, size and language limits, which AI Hub enforces before charging. A long-recording model such as `qwen/qwen-audio-3.1-asr-flash-filetrans` may answer after about a minute with a job; the plugin then reads that job until the audio timeout (`tools.media.audio.timeoutSeconds`, 60 s by default) and never uploads the recording a second time, because every upload is a new charge. Once the upload has begun, any failure (for example a 400) stops the request and is not retried.
- **Voice notes and fallback.** The plugin has no `autoPriority`, so OpenClaw does not choose it by itself, but when BeLive AI Hub is the active chat provider, OpenClaw's automatic audio transcription tries it first. A recording it cannot take before any upload (Ogg/Opus voice notes, files over 25,000,000 bytes, an unlisted model, a missing key) is handed back to OpenClaw, whose own selection may then try another transcription provider you configured; the plugin never sends a recording anywhere else itself. With no audio entry in `tools.media.models`, OpenClaw picks transcription providers automatically from every key it finds (for example a Google or OpenAI key), so a recording can reach another service. To keep recordings on AI Hub only, add the single `belive-aihub` audio entry shown above to `tools.media.models` and no other audio entry: OpenClaw then tries only the entries listed.
- **Video understanding** sends the clip inline as a `video_url` part, only to a model whose catalogue input includes `video`. Image understanding needs no adapter: OpenClaw reads images with any `belive-aihub/*` chat model that lists `image`.

### Diagnostics and request counts by feature

A request id is shown only where OpenClaw's result type has room for it. "Attempts" counts HTTP requests to AI Hub in one call; "jobs" and "charges" count what AI Hub creates and bills.

| Feature | Request id on success | Request id on failure | Attempts per call | Jobs and charges |
| --- | --- | --- | --- | --- |
| Image generation | `metadata.requestId` | Yes | 1, never retried | At most 1 charge |
| Video generation | `metadata.generationId` and `jobId` | Yes | Up to 3 submits per run, all with one `Idempotency-Key`, only after a 429, 5xx or dropped connection, with a lookup by key before each retry; then polls and one download | 1 job per key, charged once (staging, 2026-11-07: interrupted and rerun, one submit, one charge) |
| Speech | None: OpenClaw 2026.11.1's speech result has no metadata field | Yes | 1, never retried | At most 1 charge |
| Speech to text | None, for the same reason | Yes | 1 upload, never retried; a job answer is polled, not re-uploaded | At most 1 charge |
| Video understanding | None: the result is text only | Yes | 1, never retried | At most 1 charge |
| Chat and image understanding | Not added: OpenClaw's own transport | OpenClaw's own message | Set by OpenClaw, including its retries | Each attempt is a separate charge |

For support:
- **Completed request:** look it up with `GET /generation?id=<id>` (model, provider, cost).
- **Request AI Hub refused before running it** (`GET /generation` answers 404): a 404 alone does not show whether the request was charged. Quote the id from the error to BeLive support, who confirm any charge from billing records. The refusals tested on staging on 2026-11-07 (an unknown voice, an invalid key) were refused before inference; their charge was not checked against billing records.
- **Speech, speech to text and chat that succeeded:** find them in Activity by time and model.

### Supported clients

Every feature needs the plugin's floor, OpenClaw **2026.11.1**; it was built and tested against that release only (`peerDependencies: openclaw >=2026.11.1 <2027`).

| Feature | Minimum OpenClaw | Notes |
| --- | --- | --- |
| Chat, tools, live model discovery (0.1.x) | 2026.11.1 | |
| Image generation and reference-image edits | 2026.11.1 | Edits only on models listing `input_references` |
| Video generation, resume, idempotent submit | 2026.11.1 | Text to video, first and last frame, reference images |
| Speech (WAV, MP3, Opus, AAC, FLAC, PCM) | 2026.11.1 | Named voices on `/audio/speech`; `responseFormat` in the `tts` block |
| Speech to text (WAV, MP3) | 2026.11.1 | Models listed by the live catalogue; chosen in `tools.media.models` |
| Image understanding | 2026.11.1 | Through the chat model |
| Video understanding | 2026.11.1 | Models whose input includes `video` |
| Media model pickers | 2026.11.1 | Image, video and speech rows |
| Other recording formats (Ogg, M4A), music, MiMo chat-route TTS, speech jobs, saved characters, webhooks | not provided | Different AI Hub contracts; convert to WAV or MP3, or use the API directly |

## Migration

The existing BeLive custom-provider guide uses `TOKENHUB_API_KEY` and a `tokenhub/` model prefix. For this plugin, make the BeLive key available through supported host auth or `BELIVE_TOKENHUB_API_KEY`, and deliberately change BeLive model references to `belive-aihub/<author>/<slug>`. Replace literal environment references `${TOKENHUB_API_KEY}` with `${BELIVE_TOKENHUB_API_KEY}` in any retained BeLive custom/media configuration. If you pointed `litellm` (images), `openrouter` (video) or `openai` (speech or transcription) at AI Hub, switch those settings to `belive-aihub/...` references and the `tts.providers.belive-aihub` block above, then restore each of those providers to its own service: they no longer need to carry a BeLive key or base URL, and this plugin does not change them. Preserve Tencent's variable and connection if you also use that separate service. Do not copy a key into an example command.

Existing custom-provider connections remain supported independently of this plugin. Do not retain two competing configurations for the same default model. Review auxiliary/media/fallback settings separately before switching.

## Update, remove and development

Use the host's plugin update/uninstall commands. To return to a custom connection, disable/remove `belive-aihub`, restore your deliberately backed-up BeLive provider settings and restart. The plugin does not delete or revoke keys.

The plugin performs model-list requests and normal host-managed inference to BeLive, and sends image, video, speech, transcription and video-understanding requests itself to the same two official endpoints. It reads credentials only through OpenClaw's provider auth helpers and `BELIVE_TOKENHUB_API_KEY`, and never reads another provider's. Its only local state is the in-flight video job file described above. It has no telemetry, updater, credential-file reader or background process, and does not rewrite foreign providers.

```sh
npm run typecheck
npm test
openclaw plugins inspect belive-aihub --runtime --json
openclaw plugins doctor --json
```

On 2026.11.1, `plugins validate --root` validates tool/feature authoring-helper metadata and rejects the documented generic provider entry. This package uses actual host installation, runtime inspection and doctor checks instead; it does not add fake tool/feature metadata to pass that command.

See the [validation record](https://github.com/belivetech/openclaw-belive-aihub/blob/main/VALIDATION.md) for actual results and qualification limits. Community publication, upstream bundled inclusion and successful live qualification are separate milestones.
