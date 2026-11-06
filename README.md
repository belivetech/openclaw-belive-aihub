# BeLive AI Hub for OpenClaw

A release-compatible provider plugin for [BeLive AI Hub](https://aihub.belive.sg/), maintained by BeLive Technology. It adds BeLive models for chat and tools, image generation, video generation, speech and image and video understanding. Requires **OpenClaw 2026.11.1** or later and its supported Node.js runtime. MIT license. Owner contact: Hassan / BeLive Technology; report issues in this repository.

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

## Media: images, video, speech and understanding

The plugin registers native BeLive AI Hub adapters for OpenClaw's media features under the same provider id, `belive-aihub`, and the same credential as chat. They never use another provider's identity, settings or credentials: a missing BeLive key fails with a message naming `BELIVE_TOKENHUB_API_KEY`, before any request.

| Feature | OpenClaw setting | Example model | AI Hub route |
| --- | --- | --- | --- |
| Image generation | `agents.defaults.mediaModels.image` | `belive-aihub/qwen/qwen-image-2.1-turbo` | `POST /images/generations` |
| Video generation | `agents.defaults.mediaModels.video` | `belive-aihub/alibaba/wan3.0-video` | `POST /videos`, poll, download |
| Speech (text to speech) | `tts.provider` and `tts.providers.belive-aihub` | `qwen/qwen-audio-3.0-tts-flash` | `POST /audio/speech` |
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
  }
}
```

```sh
openclaw infer image generate --model belive-aihub/qwen/qwen-image-2.1-turbo --prompt "A red apple on a white table" --size 1024x1024 --output apple.png
openclaw infer video generate --model belive-aihub/alibaba/wan3.0-video --prompt "A red balloon floating upward" --resolution 480P --duration 2 --output balloon.mp4
openclaw infer tts convert --local --provider belive-aihub --text "Hello from AI Hub." --output hello.wav
openclaw infer image describe --file photo.png --model belive-aihub/z-ai/glm-5.3-flash
openclaw infer video describe --file clip.mp4 --model belive-aihub/qwen/qwen3.8-flash
```

Run `openclaw models list --provider belive-aihub --refresh` once after installing, so OpenClaw knows each chat model's image input. Model IDs are always the exact AI Hub IDs.

### How the media adapters behave

- **Live catalogues.** Image, video and speech models come from the account's own `GET /images/models`, `GET /videos/models` and `GET /models?output_modalities=audio`; the pickers list the same rows. Nothing is bundled, so a model AI Hub adds is usable without a plugin release. A model that is not listed, or an option the model does not offer (size, aspect ratio, resolution, duration, audio, seed, reference images), is refused with the list of what the model does offer, before any paid request.
- **Credentials.** The key is a saved BeLive AI Hub auth profile (for example `openclaw models auth paste-api-key --provider belive-aihub`), else `BELIVE_TOKENHUB_API_KEY`. The env var's name, which OpenClaw stores as a stand-in, is never sent as a key.
- **Endpoint.** Production unless `models.providers.belive-aihub.baseUrl` is the official staging base, as for chat. Only those two HTTPS bases are accepted.
- **Images** return one image per request (`n` is 1 on every model). Reference images go to the models that list `input_references`. An image request is never resubmitted automatically, because a rerun is a new charge.
- **Video is resumable and idempotent.** Each submit carries an `Idempotency-Key`, and the key and job ID are saved in one small JSON file per in-flight request under the OpenClaw state directory (`belive-aihub/video-jobs/`; no credential, removed when the video is saved). A call waits at least 15 minutes. If the process is interrupted, or the wait ends, running the same request again resumes the saved job: it looks the job up by key and polls and downloads it; it does not create a second one. A failed, cancelled or expired job ends the call and clears the record, so the next run is a new job. Frame images (`first_frame`, `last_frame`) and reference images are supported where the model lists them. Reference video and audio inputs, such as Kling Motion Control, are not.
- **Speech** takes 1 to 600 characters per request and asks for `wav`, the format the AI Hub speech route guarantees today; another `responseFormat` is refused before the request. Voice names are case-sensitive and belong to a model, so set `voice` to one the model supports (`loongjohn` for the Qwen models). OpenClaw lists `loongjohn`, `longanhuan_v3.6`, `longanlingxin` and `longanlufeng` as voice hints.
- **Video understanding** sends the clip inline as a `video_url` part, only to a model whose catalogue input includes `video`. Image understanding needs no adapter: OpenClaw reads images with any `belive-aihub/*` chat model that lists `image`.

### Supported clients

Every feature needs the plugin's floor, OpenClaw **2026.11.1**; it was built and tested against that release only (`peerDependencies: openclaw >=2026.11.1 <2027`).

| Feature | Minimum OpenClaw | Notes |
| --- | --- | --- |
| Chat, tools, live model discovery (0.1.x) | 2026.11.1 | |
| Image generation and reference-image edits | 2026.11.1 | Edits only on models listing `input_references` |
| Video generation, resume, idempotent submit | 2026.11.1 | Text to video, first and last frame, reference images |
| Speech (WAV) | 2026.11.1 | Named voices on `/audio/speech` |
| Image understanding | 2026.11.1 | Through the chat model |
| Video understanding | 2026.11.1 | Models whose input includes `video` |
| Media model pickers | 2026.11.1 | Image, video and speech rows |
| Speech to text, music, MiMo chat-route TTS, speech jobs, saved characters, webhooks | not provided | Different AI Hub contracts; use the API directly |

## Migration

The existing BeLive custom-provider guide uses `TOKENHUB_API_KEY` and a `tokenhub/` model prefix. For this plugin, make the BeLive key available through supported host auth or `BELIVE_TOKENHUB_API_KEY`, and deliberately change BeLive model references to `belive-aihub/<author>/<slug>`. Replace literal environment references `${TOKENHUB_API_KEY}` with `${BELIVE_TOKENHUB_API_KEY}` in any retained BeLive custom/media configuration. If you pointed `litellm` (images), `openrouter` (video) or `openai` (speech) at AI Hub, switch those settings to `belive-aihub/...` references and the `tts.providers.belive-aihub` block above, then restore each of those providers to its own service: they no longer need to carry a BeLive key or base URL, and this plugin does not change them. Preserve Tencent's variable and connection if you also use that separate service. Do not copy a key into an example command.

Existing custom-provider connections remain supported independently of this plugin. Do not retain two competing configurations for the same default model. Review auxiliary/media/fallback settings separately before switching.

## Update, remove and development

Use the host's plugin update/uninstall commands. To return to a custom connection, disable/remove `belive-aihub`, restore your deliberately backed-up BeLive provider settings and restart. The plugin does not delete or revoke keys.

The plugin performs model-list requests and normal host-managed inference to BeLive, and sends image, video, speech and video-understanding requests itself to the same two official endpoints. It reads credentials only through OpenClaw's provider auth helpers and `BELIVE_TOKENHUB_API_KEY`, and never reads another provider's. Its only local state is the in-flight video job file described above. It has no telemetry, updater, credential-file reader or background process, and does not rewrite foreign providers.

```sh
npm run typecheck
npm test
openclaw plugins inspect belive-aihub --runtime --json
openclaw plugins doctor --json
```

On 2026.11.1, `plugins validate --root` validates tool/feature authoring-helper metadata and rejects the documented generic provider entry. This package uses actual host installation, runtime inspection and doctor checks instead; it does not add fake tool/feature metadata to pass that command.

See the [validation record](https://github.com/belivetech/openclaw-belive-aihub/blob/main/VALIDATION.md) for actual results and qualification limits. Community publication, upstream bundled inclusion and successful live qualification are separate milestones.
