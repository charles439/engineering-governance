# Governance v2 scoped design

Status: Accepted
Date: 2026-09-08
Toolkit baseline: see each project's `.governance-toolkit.json`; this design does not publish or select a current toolkit SHA.

`Accepted` records the authorized design. It does not mean the implementation or integration is complete. Current delivery state is recorded separately in `docs/governance-v2-progress.md`.

## Decision scope

This change makes the existing governance checks usable through one project command, permits explicitly approved dependency debt to be reduced without blocking every change, and closes the current ADR and Git-range inconsistencies. It is deliberately a small extension of the current Node scripts. It does not introduce a service, plugin framework, daemon, package manager abstraction, staging trigger, push operation, or Python installer.

The accepted project entry point is:

```text
node scripts/governance.mjs check [--base <full-sha> --head <full-sha>]
node scripts/governance.mjs doctor
node scripts/governance.mjs provision --tool <typescript|contract> --target <explicit-directory>
node scripts/governance.mjs bootstrap
```

The project launcher is thin. A checked-in JSON pin identifies the toolkit repository and full 40-character commit SHA. The launcher locates a checkout that exactly matches that pin, passes the project configuration and range to the toolkit, and owns project-specific dependency scan roots. It must not duplicate gate logic. In an authoritative range, the base and head project pins must keep the same toolkit repository/ref and scan roots; changing them is rejected. A legitimate toolkit upgrade is a separate protected adoption change with independent approval and an initial-adoption record containing the selected identity, measured revision and date.

## One comparison range

An authoritative run has exactly one base/head pair. Both values are full commit SHAs, both commits must exist, `base` must be a strict ancestor of `head`, and the checked-out `HEAD` must equal `head`. Changed-file detection, trusted policy loading, ADR lifecycle comparison, dependency baseline comparison, and repository policy checks all consume that same pair. A caller may resolve a pull-request merge base before invocation, but no downstream check may silently recalculate or replace it.

CI and release runs fail with input error exit code `2` when the pair is absent or invalid. A local run without a pair is diagnostic only: it may inspect `HEAD` plus the working tree and must label its evidence non-authoritative. It cannot be reported as immutable CI or release evidence.

The trusted governance policy is read from the base commit. The head configuration is independently validated, but it cannot weaken the rules judging the current change. At minimum, the implementation rejects removal of protected path patterns, a `true` to `false` change for an enforced architecture flag, changing `baseline.mode` from `strict` to `ratchet`, or expanding `baseline.allowed_rules` in the reviewed range. A deliberate relaxation therefore needs a prior accepted policy commit that becomes the trusted base of a later change.

Initial adoption of `ratchet` is a separate governance-only bootstrap decision. An ordinary code pull request cannot enable ratchet or add allowed rules. The first trusted baseline must be approved and installed through an independently protected workflow or equivalent repository administration procedure, with the measured identities retained as evidence; that procedure is outside this implementation scope. Until it exists, projects use `strict`. The current tool must not imply that an in-range configuration edit can authorize its own debt allowance.

## Dependency baseline contract

The configuration extension is a top-level section so baseline policy remains separate from the absolute architecture rule flags:

```yaml
baseline:
  mode: strict
  allowed_rules: []
```

`baseline` is optional. Omission means `mode: strict` and an empty allowlist. Supported modes are only `strict` and `ratchet`. The first release accepts only these built-in values in `allowed_rules`:

- `no-cycle`
- `no-forbidden-dependencies`

YO-vedio remains `strict` because its current TypeScript scan is clean. `ratchet` exists for a project that has measured legacy dependency debt and cannot remove all of it in the adoption change.

The focused dependency CLI contract is:

```text
node scripts/dependency-gates.mjs --config <trusted-config> --input <head-report>
node scripts/dependency-gates.mjs --config <trusted-config> --base-input <base-report> --input <head-report>
```

`strict` evaluates the head report and fails on every violation. `ratchet` requires both reports. Both reports must be produced with the same trusted base dependency policy and the same scanner version/configuration. Missing, malformed, empty, or unverifiable input is an input failure, not a pass.

Ratchet comparison uses normalized violation identity sets, never totals. A head violation is grandfathered only when its exact identity exists in the base set and its rule is explicitly allowed. A base violation that disappears is removed from the allowance automatically; it cannot return later.

Normalized identities are:

```text
no-forbidden-dependencies\0<normalized-from>\0<normalized-to>
no-cycle\0<normalized-from>\0<normalized-to>
```

Paths use repository-relative `/` separators with redundant `.` segments removed; comparison is byte-stable after normalization. Cycle identities are every directed edge whose endpoints are in the same strongly connected component, including a self-loop. Using each cyclic edge makes a new chord inside an existing component a new violation. Counts or a sorted set of component members would miss that regression.

Dependency-cruiser tool-rule violations that cannot be represented by one of the two identities remain hard failures. Import-linter, unresolved imports, configuration/provenance failures, secrets, authentication, contracts, migrations, release checks, and every security finding are always strict and cannot be baselined. Severity labels do not grant baseline eligibility.

The unified toolkit check accepts the immutable range. It internally generates one fresh dependency report in strict mode, or fresh base and head reports in ratchet mode, using the pinned, already provisioned dependency-cruiser and TypeScript companion. Authoritative callers must not pass `--dependency-input` or `--dependency-base-input`; those options are local supplied evidence for diagnostic runs only. A common local `check` therefore performs a real scan and does not require the user to hand-create JSON. CI must generate the reports during the same run from the verified commits. Cached or workspace reports are snapshots and are not authoritative evidence.

## ADR lifecycle contract

`Proposed`, `Accepted`, `Superseded`, and `Deprecated` remain the supported statuses. The range-aware rules are:

- `Proposed` may become `Accepted`.
- A base `Accepted` ADR may remain `Accepted`, become `Superseded`, or become `Deprecated`; it may not return to `Proposed` or be deleted.
- `Superseded` and `Deprecated` are terminal and may not return to an active status.
- `Accepted` to `Superseded` requires `Superseded by: docs/adr/<replacement>.md`. The replacement must exist at head, be `Accepted`, and contain the exact reciprocal `Supersedes: docs/adr/<old>.md` link.
- `Accepted` to `Deprecated` requires a non-empty `Deprecation reason:` field.
- Lifecycle links must remain inside `docs/adr/`, resolve to tracked Markdown files, and form no cycles.

Historical `Context`, `Decision`, and `Affected paths` content remains immutable when an accepted ADR changes lifecycle status. The replacement ADR records the new decision. Coverage comes from new ADRs whose head status is `Accepted`, or Proposed → Accepted ADRs; an ADR changed only to `Superseded` or `Deprecated` contributes no active coverage.

This checks structure and traceability. It still cannot prove that the decision is good or that an authorized reviewer accepted it.

## Launcher, doctor, and provisioning

`check` is side-effect free apart from temporary report files. It never calls `npm install`, `npx`, `pnpm add`, `pip`, `uv`, `uvx`, a network client, or a package download. Missing tools produce exit code `2` with a command that tells the operator to run `doctor` or the explicit provisioning command.

`doctor` is read-only. It checks Node and Git availability, configuration validity, the selected dependency-cruiser executable, and the actual dependency-cruiser and TypeScript companion versions. The project launcher verifies the pinned toolkit directory and revision; the fresh scanner validates that declared scan roots exist. It fails when an actual version differs from `profiles/tool-versions.yml`. Reporting an expected version without interrogating the executable is insufficient.

`provision --tool typescript --target <explicit-directory>` installs the manifest-pinned dependency-cruiser and TypeScript companion together. `provision --tool contract --target <explicit-directory>` installs the manifest-pinned contract checker. These are the only checker download paths in this scope. Each requires an explicit target outside the business repository, uses non-interactive flags, verifies the actual version after installation, and writes runtime evidence under the target for later `doctor`/`check` use. Neither edits the project `package.json`, lockfile, `node_modules`, global packages, or environment files.

`bootstrap` is separate from checker provisioning. It may fetch only the repository and full SHA declared by the checked-in toolkit pin into an isolated cache, verify the resolved revision, and leave a detached clean checkout. It cannot accept a branch, tag, alternate repository, or implicit latest revision. `check` and `doctor` never bootstrap automatically.

Python provisioning is outside this release. Python checks accept only an explicitly supplied existing executable or an approved dedicated governance environment. The launcher must never select an arbitrary Python from `PATH`, run bare `pip install`, or modify a project virtual environment. A later Python provisioner may create a venv only under an explicit approved tool target and must verify the pinned package version.

## Exit and evidence contract

- `0`: every applicable check ran and passed; in ratchet mode any grandfathered identities are printed as debt evidence.
- `1`: policy violations or new ratchet identities were found.
- `2`: invalid arguments, missing tools, invalid configuration/range, report provenance/format failure, or checker execution failure.

Machine-readable output is not required for this release. Deterministic text includes the base/head pair when authoritative, policy mode, scanner versions, new violation identities, grandfathered identities, and skipped checks with reasons. A passing process proves only the implemented gates and supplied evidence.

## Exact implementation ownership

Workers must preserve these non-overlapping write scopes:

1. **Dependency baseline worker** owns `scripts/dependency-gates.mjs`, `scripts/config.mjs`, `schemas/governance-config.schema.json`, `scripts/tests/config.test.mjs`, and dependency-gate fixtures/tests. It adds the top-level `baseline` section, exports a pure report evaluator and the parsed dependency policy, and does not edit the unified launcher or ADR validator.
2. **ADR lifecycle worker** owns `scripts/verify-adr-policy.mjs` and `scripts/tests/adr-policy.test.mjs`. It exports the range-aware lifecycle result containing errors, active accepted paths, and coverage. It does not edit dependency or launcher code.
3. **Toolkit integration worker** owns `scripts/governance.mjs` and `scripts/tests/governance.test.mjs`. It establishes the single range, loads base/head documents, rejects same-range policy weakening, calls the two pure subsystems, and preserves the focused `dependency-gates.mjs` diagnostic entry point.
4. **Runtime tools worker** owns `scripts/runtime-tools.mjs`, its tests, and the project-launcher template under `templates/project-config/`. It implements read-only discovery/version checks and explicit Node provisioning. It does not add Python provisioning or install during `check`.
5. **YO-vedio integration worker** owns only the isolated project files `scripts/governance.mjs`, its pin JSON, launcher tests, `.governance.yml`, the package script, the architecture-governance CI steps, and `docs/governance-integration.md`. It keeps `baseline.mode: strict`, uses the existing source roots, and removes duplicated shell orchestration only after the launcher covers the same evidence.
6. **Repository policy worker** owns `scripts/verify-repository-policy.mjs` and its tests in the isolated project. It consumes the same explicit base/head pair and must not retain an independent fallback range in CI/release mode.
7. **Reviewer** is read-only. It runs toolkit tests, project launcher tests, a strict clean scan, ratchet identity fixtures, ADR transition fixtures, doctor/version mismatch cases, and a check proving that `check` performs no installation or network provisioning.

No worker in these scopes performs Git staging, commit, push, tag, remote trigger, staging deployment, or production action.

## Acceptance criteria and limitations

The change is accepted when one project command performs a fresh strict scan without a hand-built report; authoritative paths share one verified range; a ratchet fixture permits exact legacy cyclic/forbidden edges while rejecting a new edge even inside the same SCC; a policy-relaxation fixture fails; linked ADR supersession and deprecation rules pass/fail deterministically; `doctor` verifies actual versions; and an empty tool target proves `check` fails without downloading while explicit `provision` installs only the pinned Node pair into that target.

The toolkit still depends on hosting-platform required checks and protected toolkit/policy revisions for non-bypassability. It does not establish dependency-report provenance merely from a JSON file, judge ADR semantics or approval authority, provision Python in this release, or trigger any environment delivery.
