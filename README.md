# BeLive AI Hub for OpenClaw

A release-compatible provider plugin for [BeLive AI Hub](https://aihub.belive.sg/), maintained by BeLive Technology. Requires **OpenClaw 2026.11.1** or later and its supported Node.js runtime. MIT license. Owner contact: Hassan / BeLive Technology; report issues in this repository.

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

Only ready text Chat Completions models with advertised tool support, known context length and representable input/output pricing are listed. Image input is included when the catalog advertises it. Non-chat, unpriced, conditional-price and multiple-tier rows are omitted rather than made to look free or assigned invented limits. The plugin uses a **4096-token client reply budget** because the current API does not publish each model's output maximum; this is not a claim about its true maximum.

Prices are converted from per-token API rates to OpenClaw's per-million-token UI units. If a cache rate is absent, the model is labeled **cache cost estimate** and that bucket uses the input-token rate for estimation. Check AI Hub Activity for actual charges; client estimates are not an invoice. If the host cannot represent a future pricing shape, fix the mapper before claiming support for those rows.

The default endpoint is `https://tokenhub-api.belive.sg/api/v1`. For isolated staging qualification, explicitly configure `models.providers.belive-aihub.baseUrl` as `https://api-stg-tokenhub.belive.sg/api/v1` and use a staging key. Catalog requests accept only those two official HTTPS bases, refuse redirects, have an eight-second deadline and a bounded response size. Completion transport and user overrides are host-owned; configure only an endpoint you intend to trust with the key.

## Migration

The existing BeLive custom-provider guide uses `TOKENHUB_API_KEY` and a `tokenhub/` model prefix. For this plugin, make the BeLive key available through supported host auth or `BELIVE_TOKENHUB_API_KEY`, and deliberately change BeLive model references to `belive-aihub/<author>/<slug>`. Replace literal environment references `${TOKENHUB_API_KEY}` with `${BELIVE_TOKENHUB_API_KEY}` in any retained BeLive custom/media configuration. Preserve Tencent's variable and connection if you also use that separate service. Do not copy a key into an example command.

Existing custom-provider connections remain supported independently of this plugin. Do not retain two competing configurations for the same default model. Review auxiliary/media/fallback settings separately before switching.

## Update, remove and development

Use the host's plugin update/uninstall commands. To return to a custom connection, disable/remove `belive-aihub`, restore your deliberately backed-up BeLive provider settings and restart. The plugin does not delete or revoke keys.

The plugin performs model-list requests and normal host-managed inference to BeLive. It reads credentials only through OpenClaw's provider auth resolver. It has no telemetry, updater, credential-file reader or background process, and does not rewrite foreign providers.

```sh
npm run typecheck
npm test
openclaw plugins inspect belive-aihub --runtime --json
openclaw plugins doctor --json
```

On 2026.11.1, `plugins validate --root` validates tool/feature authoring-helper metadata and rejects the documented generic provider entry. This package uses actual host installation, runtime inspection and doctor checks instead; it does not add fake tool/feature metadata to pass that command.

See the [validation record](https://github.com/belivetech/openclaw-belive-aihub/blob/main/VALIDATION.md) for actual results and qualification limits. Community publication, upstream bundled inclusion and successful live qualification are separate milestones.
