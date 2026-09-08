# Repository hygiene design

## Purpose

Repository hygiene keeps task evidence reviewable and recoverable. It covers
four artifact classes: generated output and forensic evidence, dead or
deprecated code, debug probes, and experiments. The implementation is a
read-only evaluator and does not replace owner review, Git custody or release
policy.

## Adoption gap matrix

| Area | Before adoption | After adoption | Toolkit enforces | Human proof remains |
| --- | --- | --- | --- | --- |
| Artifact classes | Partial ignore rules mixed generated output with evidence; no shared classification | Generated/forensic evidence, deprecated code, debug probes and experiments are separate classes | Narrow path rules, exact registry categories and staged findings | Correct classification, provenance, purpose and retention decision |
| Lifecycle | No exact-path registry or review lifecycle | Version-1 registry, task/PR/release/maintenance phases, renewal, retirement and promotion rules | Schema, inherited-entry retention and release expiry | Owner, compatibility, rollback and approval decisions |
| Contamination | Ignore visibility was treated as cleanup policy | New committed contamination blocks; unchanged historical findings stay advisory; changed known mandatory artifacts block | Immutable range, path history and blocker severity | Diff context and reason for retaining or moving evidence |
| Isolation and cleanup | Ignored files could survive branch switches; no bounded dry-run contract | Experiments use isolated `codex/*` worktrees and maintenance uses bounded review scopes | Read-only inventory/plan; no scheduler or delete executor | Exact action paths, process ownership and execution approval |

The matrix separates executable enforcement from evidence that still requires an
owner or reviewer. A directory can remain an opaque review scope in inventory
or planning; only a separately approved executable action names exact files.

## Registry contract

Projects opt in with:

```yaml
checks:
  repository_hygiene: true
```

The repository root contains `.governance-hygiene.json`:

```json
{
  "version": 1,
  "entries": [
    {
      "path": "exact/path",
      "category": "deprecated",
      "owner": "team-or-person",
      "reviewBy": "YYYY-MM-DD",
      "evidence": "link-or-revision-and-reason"
    }
  ]
}
```

The object and every entry have an exact schema. Paths are normalized,
repository-relative file paths; globs, waivers and deletion directives are
rejected. Categories are `deprecated`, `debug` and `experimental`. An empty
`entries` array is valid and creates no synthetic debt. A registry entry
documents ownership and review evidence; it does not waive a hygiene blocker.

## Commands and stages

The unified toolkit command is:

```text
governance hygiene audit|plan|check
  --stage task-start|task-end|pr|release|maintenance
  --base FULL --head FULL
  --format text|json
```

`audit` defaults to `task-start` local evidence and `plan` defaults to
`task-end` local evidence. `check` is restricted to `pr` or `release` and
requires an immutable range. An authoritative range uses full commit SHAs,
requires both objects to exist, requires `base` to be a strict ancestor of
`head`, and requires the checkout `HEAD` to equal `head`. CI cannot use local
mode. The CLI reads inventory and produces findings or a dry-run plan; it has
no delete executor, scheduler, timed deletion or broad cleanup operation.

The phases are intentionally batched:

1. Task start inventories dirty state, relevant paths, real paths/symlinks and
   possible active ownership.
2. Task end reviews probes and generated output created by the task.
3. Pre-PR checks new committed contamination against the immutable diff.
4. Pre-release reviews expiry, compatibility and retention.
5. Maintenance records a bounded batch with owners, reasons, rollback and
   tests; an opaque directory may be a review scope, while any separately
   approved executable action names exact files.

New committed generated, debug and experimental contamination is a blocker at
PR and release stages. Historical findings are advisory review items. A
historical finding that remains unchanged is advisory, while a change to a
known mandatory artifact is a blocker. A registered entry with an expired
`reviewBy` is a release blocker, and inherited registry entries cannot be
removed silently. Missing registry targets are reported as review errors.
Unknown files remain untouched.

An inventory or plan may summarize an ignored or opaque directory as a review
scope, but any approved executable action identifies exact files and
directories are never executable delete targets. Renew a live entry by updating
its evidence or review date; retirement removes the target and entry in one
reviewed commit; promotion moves the item to a permanent path and uses normal
source review. The toolkit does not perform those operations or detect dead
code automatically.

## Built-in inventory rules

The evaluator classifies common generated paths (`artifacts`, `dist`,
`node_modules`, `.wrangler`, outputs, caches, Python caches, Playwright
directories, temporary run directories, scratch/tool/test-output directories,
package stores and `grasp-report.json`), generated media/log files, probe
directories, `deprecated/`, and `experimental/` paths. The rules are narrow
path classifications; they do not scan application semantics or infer dead
code from no-import results.

The local evaluator distinguishes tracked, untracked and ignored paths. A
forced tracked generated file in an authoritative range is a new blocker.
Legacy artifacts are retained as historical findings; changing one requires
review. Ordinary test logging and Unicode paths are not probes solely because
they contain logging or non-ASCII characters. Symlink directories are not
traversed.

## Manual review boundary

Static findings for dead or deprecated code remain candidates. Review dynamic
entrypoints, public and persisted contracts, tests, configuration and deploy
references before retirement, and record an owner and compatibility decision.
The CLI does not detect active-process ownership or inspect runtime log
retention. Those checks, production retention policy, approval authority and
rollback decisions remain manual. Hygiene does not authorize staging, commits,
pushes, tags, deployment or production deletion.

## Adoption and evidence

First adoption records the final committed toolkit implementation at its
immutable full SHA in `.governance-toolkit.json`; that pin update is part of
the protected adoption. A later toolkit repository/ref or scan-pin change is a
separate protected adoption flow and must retain initial adoption evidence.
The aggregate unpublished first-adoption range uses
`c4cc0d44658a42be54cdad192707b9c8eb1b5bae` as its base revision.
