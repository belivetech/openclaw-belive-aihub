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
