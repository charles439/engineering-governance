import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAdrDocument, validateAdrLifecycle } from '../verify-adr-policy.mjs';

const validPrefix = '# Use versioned API\n\nStatus: Accepted\n\nAffected paths: contracts/**\n\n';

test('rejects an empty Context section', () => {
  const errors = validateAdrDocument(`${validPrefix}## Context\n\n## Decision\n\nExpose a versioned API.`, { requireAccepted: true });

  assert.ok(errors.includes('ADR ## Context section must contain content'));
  assert.ok(!errors.includes('ADR ## Decision section must contain content'));
});

test('rejects an empty Decision section', () => {
  const errors = validateAdrDocument(`${validPrefix}## Context\n\nConsumers need a stable boundary.\n\n## Decision\n   \n\t`, { requireAccepted: true });

  assert.ok(errors.includes('ADR ## Decision section must contain content'));
  assert.ok(!errors.includes('ADR ## Context section must contain content'));
});

test('rejects missing Context and Decision sections as before', () => {
  const errors = validateAdrDocument(`${validPrefix}No section headings.`, { requireAccepted: true });

  assert.ok(errors.includes('ADR must include a ## Context section'));
  assert.ok(errors.includes('ADR must include a ## Decision section'));
});

test('accepts valid multiline Context and Decision sections', () => {
  const errors = validateAdrDocument(
    `${validPrefix}## Context\n\nConsumers need a stable boundary.\nThe existing clients depend on predictable versioning.\n\n## Decision\n\nExpose versioned API contracts.\nKeep the public boundary documented.`,
    { requireAccepted: true },
  );

  assert.deepEqual(errors, []);
});

const oldPath = 'docs/adr/0001-api.md';
const newPath = 'docs/adr/0002-api.md';
const thirdPath = 'docs/adr/0003-api.md';
function document(status = 'Accepted', fields = '', decision = 'Expose versioned API contracts.') {
  return `# Use versioned API\n\nStatus: ${status}\nAffected paths: contracts/**\n${fields}\n## Context\nConsumers need a stable boundary.\n\n## Decision\n${decision}\n`;
}
function replacement() {
  return {
    base: new Map([[oldPath, document()]]),
    head: new Map([
      [oldPath, document('Superseded', `Superseded by: ${newPath}\n`)],
      [newPath, document('Accepted', `Supersedes: ${oldPath}\n`, 'Expose the next API version.')],
    ]),
  };
}

test('a reciprocal supersession covers architecture only through the changed Accepted replacement', () => {
  const { base, head } = replacement();
  assert.deepEqual(validateAdrLifecycle([oldPath, newPath], head, base), {
    errors: [], acceptedPaths: [newPath], coverage: ['contracts/**'],
  });
  assert.deepEqual(validateAdrLifecycle([oldPath], head, base), {
    errors: [], acceptedPaths: [], coverage: [],
  });
});

test('new and proposed-to-Accepted ADRs provide coverage; Proposed ADRs do not', () => {
  assert.deepEqual(validateAdrLifecycle([newPath], { [newPath]: document() }).coverage, ['contracts/**']);
  assert.deepEqual(validateAdrLifecycle([newPath], { [newPath]: document() }, { [newPath]: document('Proposed') }).errors, []);
  assert.deepEqual(validateAdrLifecycle([newPath], { [newPath]: document('Proposed') }), { errors: [], acceptedPaths: [], coverage: [] });
});

test('an existing Accepted ADR metadata edit does not authorize coverage', () => {
  const base = { [oldPath]: document() };
  const head = { [oldPath]: document().replace('# Use versioned API', '# Retitled API') };
  assert.deepEqual(validateAdrLifecycle([oldPath], head, base), { errors: [], acceptedPaths: [], coverage: [] });
});

test('deprecated history requires accepted base and an explicit reason but never provides coverage', () => {
  const base = { [oldPath]: document() };
  const head = { [oldPath]: document('Deprecated', 'Deprecation reason: No clients use this API.\n') };
  assert.deepEqual(validateAdrLifecycle([oldPath], head, base), { errors: [], acceptedPaths: [], coverage: [] });
  assert.match(validateAdrLifecycle([oldPath], head).errors.join('\n'), /requires an existing Accepted/);
  assert.match(validateAdrLifecycle([oldPath], { [oldPath]: document('Deprecated') }, base).errors.join('\n'), /Deprecation reason/);
});

test('accepted decisions and Context cannot be silently rewritten or downgraded', () => {
  for (const text of [document('Accepted', '', 'Choose an incompatible policy.'), document().replace('stable boundary', 'different boundary')]) {
    const result = validateAdrLifecycle([oldPath], { [oldPath]: text }, { [oldPath]: document() });
    assert.match(result.errors.join('\n'), /must be preserved/);
    assert.deepEqual(result.coverage, []);
  }
  assert.match(validateAdrLifecycle([oldPath], { [oldPath]: document('Proposed') }, { [oldPath]: document() }).errors.join('\n'), /unsupported lifecycle transition/);
});

test('historical scope expansion and rewriting during supersession are rejected', () => {
  const { base, head } = replacement();
  head.set(oldPath, head.get(oldPath).replace('contracts/**', 'contracts/**, src/**'));
  assert.match(validateAdrLifecycle([oldPath, newPath], head, base).errors.join('\n'), /Affected paths must be preserved/);
  head.set(oldPath, document('Superseded', `Superseded by: ${newPath}\n`, 'Rewrite the historical decision.'));
  assert.match(validateAdrLifecycle([oldPath, newPath], head, base).errors.join('\n'), /Decision must be preserved/);
});

test('missing targets, missing reciprocal links, and non-Accepted replacements fail closed', () => {
  for (const mutation of [
    (head) => head.delete(newPath),
    (head) => head.set(newPath, document()),
    (head) => head.set(newPath, document('Proposed', `Supersedes: ${oldPath}\n`)),
  ]) {
    const { base, head } = replacement();
    mutation(head);
    const result = validateAdrLifecycle([oldPath, newPath], head, base);
    assert.ok(result.errors.length);
    assert.deepEqual(result.coverage, []);
    assert.deepEqual(result.acceptedPaths, []);
  }
});

test('supersession references reject escaping paths, encoded paths and self links', () => {
  for (const target of ['../escape.md', 'docs/adr/../escape.md', 'docs/adr/%2e%2e.md', 'C:/escape.md', 'docs/adr/sub/other.md', oldPath]) {
    const { base, head } = replacement();
    head.set(oldPath, document('Superseded', `Superseded by: ${target}\n`));
    const result = validateAdrLifecycle([oldPath, newPath], head, base);
    assert.ok(result.errors.length, target);
    assert.deepEqual(result.coverage, []);
  }
});

test('detects a fully reciprocal cycle among linked historical ADRs', () => {
  const head = new Map([
    [oldPath, document('Superseded', `Supersedes: ${thirdPath}\nSuperseded by: ${newPath}\n`)],
    [newPath, document('Superseded', `Supersedes: ${oldPath}\nSuperseded by: ${thirdPath}\n`)],
    [thirdPath, document('Superseded', `Supersedes: ${newPath}\nSuperseded by: ${oldPath}\n`)],
  ]);
  const result = validateAdrLifecycle([oldPath], head, head);
  assert.match(result.errors.join('\n'), /graph contains a cycle/);
  assert.deepEqual(result.coverage, []);
});

test('historical supersession chains remain valid when their newest Accepted decision is replaced', () => {
  const { head: base } = replacement();
  const head = new Map(base);
  head.set(newPath, document('Superseded', `Supersedes: ${oldPath}\nSuperseded by: ${thirdPath}\n`, 'Expose the next API version.'));
  head.set(thirdPath, document('Accepted', `Supersedes: ${newPath}\n`, 'Expose version three.'));
  assert.deepEqual(validateAdrLifecycle([newPath, thirdPath], head, base), { errors: [], acceptedPaths: [thirdPath], coverage: ['contracts/**'] });
});

test('invalid Accepted documents and duplicated status cannot contribute coverage', () => {
  for (const text of [document().replace('## Context', '## Other'), document('Accepted', 'Status: Proposed\n'), document().replace('Affected paths: contracts/**', 'Affected paths:')]) {
    const result = validateAdrLifecycle([newPath], { [newPath]: text });
    assert.ok(result.errors.length);
    assert.deepEqual(result.coverage, []);
  }
});

test('deletion preserves decision history while allowing removal of proposals', () => {
  assert.match(validateAdrLifecycle([oldPath], {}, { [oldPath]: document() }).errors.join('\n'), /must not be deleted/);
  assert.deepEqual(validateAdrLifecycle([oldPath], {}, { [oldPath]: document('Proposed') }).errors, []);
});
