# Architecture Context

- Owner: `<architecture owner>`
- Last reviewed revision: `<full commit SHA>`
- Last reviewed date: `YYYY-MM-DD`

This file indexes intended decisions and verified exemplars. Query GRASP or current source for actual dependencies; do not copy a static dependency graph here. A generated dependency report proves only the verified head from the same CI run and only the source roots whose coverage it checks separately; local and older reports are snapshots. When source and accepted decisions conflict, record the mismatch and require a scoped decision.

## Architecture sources

| Topic/scope | Accepted ADR or contract | Owner |
| --- | --- | --- |
| `<scope>` | `<link>` | `<owner>` |

## Invariants

| ID | Scope | Rule | Enforcement/evidence |
| --- | --- | --- | --- |
| `INV-001` | `<scope>` | `<rule>` | `<test/gate/review>` |

## Scoped pattern exemplars

| Pattern | Applies to | Verified paths | Decision | Required checks |
| --- | --- | --- | --- | --- |
| `<pattern>` | `<explicit scope>` | `<paths>` | `<accepted ADR>` | `<commands>` |

An exemplar applies only to its declared scope. Verify that the paths still exist and express the decision at the current task revision.

## Exceptions

| Rule/scope | Owner | Reason | ADR | Expires/review |
| --- | --- | --- | --- | --- |
| `<rule/scope>` | `<owner>` | `<reason>` | `<link>` | `YYYY-MM-DD` |

## Known mismatches and open decisions

| Actual source/runtime evidence | Intended decision | Affected scope | Owner | Required decision |
| --- | --- | --- | --- | --- |
| `<evidence>` | `<ADR/contract>` | `<scope>` | `<owner>` | `<next action>` |
