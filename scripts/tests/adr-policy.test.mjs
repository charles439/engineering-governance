import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAdrDocument } from '../verify-adr-policy.mjs';

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

