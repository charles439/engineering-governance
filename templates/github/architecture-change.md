## Architecture impact

- [ ] No boundary or contract change
- [ ] Change classification and boundary impact stated
- [ ] Relevant architecture context, decisions and exemplars loaded
- [ ] ADR linked and accepted before implementation
- [ ] Owners and affected modules updated
- [ ] Migration and rollback plan included
- [ ] Exceptions include owner, reason, scope and expiry/review date
- [ ] Governance rules are not weakened by this change
- [ ] New Accepted ADRs or Proposed → Accepted ADRs collectively cover every changed protected path through single-line `Affected paths:` fields

## Context evidence

- Base/head revisions:
- Accepted ADRs/contracts:
- Exemplar paths reused:
- Actual topology/import query:
- Documentation/source mismatches:

## Verification evidence

- Tests:
- Architecture checks:
- Dependency evidence:
- Dependency report head SHA and per-root TS/TSX (or other declared type) coverage:
- TypeScript checker and companion versions:
- Independent reviewer:
- Trusted-base review of governance/workflow changes:
- Deployment checks:

The toolkit compares governance policy against the trusted base and rejects implemented weakening. Independent review still covers semantic intent and approval authority. A workflow result is not non-bypassable unless the repository requires that check or an equivalent ruleset.
