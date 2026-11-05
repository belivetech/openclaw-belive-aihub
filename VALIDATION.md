# Validation

Recorded 2026-11-05 against published npm `openclaw@2026.11.1`, matching upstream source commit `4ffdd2047d192dd65554de3c8c46c0e0197c6e2a`, under Node 26.8.2.

- `npm run typecheck`: passed.
- `npm test`: **7 passed, 0 failed**, including a TypeScript build and released-SDK registration.
- `npm pack` and isolated-host local archive installation: passed. The installer required explicit acknowledgment of the independently reviewed local source.
- `plugins inspect belive-aihub --runtime --json`: provider loaded, enabled and activated; `belive-aihub` registered as text inference; no missing dependencies.
- `plugins doctor --json`: no plugin errors, compatibility problems, shadowing or configuration warnings. It returns `ok: false` for the expected unverified local-archive provenance warning. This is not a clean registry-install result; recheck after publication and installation from ClawHub/npm.
- Independent source review found no remaining auth, pricing or isolation blockers.

On this host release, `plugins validate --root` expects tool/feature authoring-helper metadata and rejects the generic provider entry documented by the provider SDK. It is not the provider validation gate. No fake metadata or host patch was added to change that result.

Tests cover decimal price-unit conversion, exact nested IDs, capability/protocol filtering, context limits, explicit output-budget policy, labeled cache estimates, unexpected-origin refusal, actual released SDK provider/picker registration, two profile keys, staging routing, missing keys, sanitized discovery errors, no hidden retry, dynamic lookup and explicit rediscovery of added/removed models. Fixture responses do not prove live provider behavior.

No paid qualification has run. The approved campaign allocates at most USD 5 to OpenClaw in a separately prepaid staging organisation, with verified enforcement and bounded request/time limits. Signup requires normal human CAPTCHA and email verification. No production inference call is authorized by this campaign.

Live acceptance and registry publication remain pending. The release-compatible standalone implementation does not depend on a bundled upstream PR being accepted.
