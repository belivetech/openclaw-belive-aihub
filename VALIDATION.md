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

Version 0.1.1 updates documentation links and records this registry result; the provider runtime and manifest are unchanged. [Bundled/official placement remains requested separately](https://github.com/openclaw/openclaw/issues/193454).
