# Governance v2 implementation progress

Status: PARTIAL
Recorded: 2026-09-08

The accepted contract is in `docs/governance-v2-design.md`. Acceptance of that
design is not evidence that every project launcher or remote integration is
complete.

## Completed and verified

- The toolkit working tree contains the range-aware governance evaluator in
  `scripts/governance.mjs`, dependency baseline logic, ADR lifecycle checks,
  runtime discovery/provisioning in `scripts/runtime-tools.mjs`, fresh-scan
  support in `scripts/governance-scan.mjs`, and cooperative Git custody in
  `scripts/git-custody.mjs`.
- The interim local toolkit test command passed on 2026-09-08:
  `npm test` — 55 Node tests plus the dependency, TypeScript, Python and tool
  fixture suites passed. This verifies the local implementation and fixtures;
  it does not establish publication or cloud CI evidence.
- Interim candidate governance tests passed for the launcher, repository
  policy, range resolution and release policy. The local runtime evidence also
  recorded a fresh scan of 186 modules and 344 edges with zero violations,
  `doctor` success, provisioning reuse of the pinned lock hash, and isolated
  `GOVERNANCE_HOME` behavior; these measurements require revalidation against
  the final integrated tree.
- The project release-policy tests passed in the isolated candidate:
  `node --test scripts/release-production-policy.test.mjs` — 7/7. Other
  candidate governance checks must still be reviewed against the final
  integrated tree.

## Current implementation boundary

- `scripts/governance.mjs check` evaluates policy, the explicit immutable
  base/head range, and fresh dependency evidence generated from the verified
  checkout in the same run. The project launcher/CI caller and the toolkit
  scanner use the same range; an arbitrary or stale `--dependency-input` file
  remains supplied evidence and cannot establish provenance by itself.
- `doctor` is read-only and verifies actual checker and TypeScript companion
  versions. `provision` is the explicit Node-only installation path into an
  external target. Python provisioning is outside this release.
- The candidate contains a pinned project launcher at
  `scripts/governance.mjs`. Its `bootstrap` command is explicit and
  SHA-pinned; `check` and `doctor` do not download implicitly. Authoritative
  checks use the launcher/toolkit fresh-scan path and forward the same
  immutable range into governance evaluation. The source pin is trusted only
  when base and head retain the same repository/ref and scan roots; a toolkit
  upgrade follows a separately protected adoption process with an initial
  adoption record.

## Pending integration work

- Complete the local Git-custodian integration: review the scoped toolkit and
  candidate changes, create the clean local toolkit revision, update the
  candidate pin, and verify the pinned cache checkout is clean before the
  final local checks.
- Hosted publication, remote workflow execution and required-check
  configuration are separate follow-up work requiring explicit remote
  authorization; they are outside this local documentation pass. The current
  candidate pin remains the project file's source of truth until a protected
  adoption record approves a different immutable identity.

## Repository state and prohibited delivery actions

- No staging action, remote trigger, commit, push, tag, deployment or
  production change was performed by this documentation pass.

## Immediate continuation

1. After the core trust and CI changes are integrated, review the exact
   toolkit/candidate diff and retain `.governance-toolkit.json` as the source
   of truth; any new pin requires a separately protected adoption record.
2. Re-run the local toolkit and candidate checks against the clean pinned
   cache; defer hosted workflow verification to a separately authorized run.
