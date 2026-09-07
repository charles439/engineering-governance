import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dependencyPolicy,
  evaluateDependencyReports,
} from '../dependency-gates.mjs';

const policy = (overrides = {}) => dependencyPolicy({
  baseline: { mode: 'ratchet', allowed_rules: ['no-cycle', 'no-forbidden-dependencies'] },
  checks: { architecture: {
    no_new_cycles: true,
    no_new_forbidden_dependencies: true,
    forbidden_dependencies: [{ from: 'src/domain.ts', to: 'src/infra.ts' }],
  } },
  ...overrides,
});

const baseCycle = {
  nodes: ['./src/a.ts', 'src/b.ts', 'src/c.ts', 'src/domain.ts', 'src/infra.ts'],
  edges: [
    ['./src/a.ts', 'src/b.ts'],
    ['src/b.ts', 'src/c.ts'],
    ['src/c.ts', 'src/a.ts'],
    ['src/domain.ts', 'src/infra.ts'],
  ],
};

test('ratchet compares normalized identity sets, so swapped counts and order do not matter', () => {
  const head = {
    nodes: baseCycle.nodes,
    edges: [
      ['src/c.ts', 'src/a.ts'],
      ['src/domain.ts', 'src/infra.ts'],
      ['./src/a.ts', './src/b.ts'],
      ['src/b.ts', './src/c.ts'],
      ['src/a.ts', 'src/b.ts'],
    ],
  };
  const result = evaluateDependencyReports({ headReport: head, baseReport: baseCycle, policy: policy() });
  assert.equal(result.ok, true);
  assert.equal(result.newViolations.length, 0);
  assert.equal(result.grandfathered.length, 4);
});

test('ratchet rejects a new chord inside an existing strongly connected component', () => {
  const head = {
    nodes: baseCycle.nodes,
    edges: [...baseCycle.edges, ['src/a.ts', 'src/c.ts']],
  };
  const result = evaluateDependencyReports({ headReport: head, baseReport: baseCycle, policy: policy() });
  assert.equal(result.ok, false);
  assert.deepEqual(result.newViolations, ['no-cycle\0src/a.ts\0src/c.ts']);
});

test('dependency-cruiser circular rules map to SCC edges and can ratchet', () => {
  const base = {
    modules: [
      { source: 'src/a.ts', dependencies: [{ resolved: 'src/b.ts' }] },
      { source: 'src/b.ts', dependencies: [{ resolved: 'src/a.ts' }] },
    ],
    summary: { violations: [{
      type: 'cycle',
      rule: { severity: 'error', name: 'no-circular-source-dependencies' },
      from: 'src/a.ts',
      to: 'src/b.ts',
      cycle: [
        { name: 'src/b.ts', dependencyTypes: ['local', 'import'] },
        { name: 'src/a.ts', dependencyTypes: ['local', 'import'] },
      ],
    }] },
  };
  const result = evaluateDependencyReports({ headReport: base, baseReport: base, policy: policy({ checks: { architecture: {} } }) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.grandfathered, ['no-cycle\0src/a.ts\0src/b.ts', 'no-cycle\0src/b.ts\0src/a.ts']);
});

test('dependency-cruiser forbidden rule objects map to canonical forbidden identities', () => {
  const report = {
    modules: [
      { source: 'src/domain.ts', dependencies: [{ resolved: 'src/infra.ts' }] },
      { source: 'src/infra.ts', dependencies: [] },
    ],
    summary: { violations: [{
      type: 'dependency',
      rule: { severity: 'error', name: 'no-forbidden-dependencies' },
      from: 'src/domain.ts',
      to: 'src/infra.ts',
    }] },
  };
  const result = evaluateDependencyReports({ headReport: report, baseReport: report, policy: policy() });
  assert.equal(result.ok, true);
  assert.deepEqual(result.grandfathered, ['no-forbidden-dependencies\0src/domain.ts\0src/infra.ts']);
});

test('unresolved and security tool violations remain hard failures', () => {
  const report = {
    modules: [{ source: 'src/app.ts', dependencies: [{ module: 'missing.ts', couldNotResolve: true }] }],
    summary: { violations: [{ rule: 'security-no-secret', from: 'src/app.ts', to: 'src/secret.ts' }] },
  };
  const result = evaluateDependencyReports({ headReport: report, baseReport: report, policy: policy() });
  assert.equal(result.ok, false);
  assert.equal(result.hardViolations.length, 2);
  assert.match(result.errors.join('\n'), /unresolved-import/);
  assert.match(result.errors.join('\n'), /security-no-secret/);
});

test('missing, malformed, empty, and mismatched-provenance reports fail closed', () => {
  assert.throws(() => evaluateDependencyReports({ policy: policy() }), /head report/);
  assert.throws(() => evaluateDependencyReports({ headReport: {}, policy: policy() }), /dependency-cruiser JSON/);
  assert.throws(() => evaluateDependencyReports({ headReport: { nodes: [], edges: [] }, policy: policy() }), /empty/);
  const head = { nodes: ['a'], edges: [], provenance: { scannerVersion: '2' } };
  const base = { nodes: ['a'], edges: [], provenance: { scannerVersion: '1' } };
  assert.throws(() => evaluateDependencyReports({ headReport: head, baseReport: base, policy: policy() }), /provenance/);
});

test('strict remains the default and fails every dependency identity', () => {
  const result = evaluateDependencyReports({
    headReport: { nodes: ['a', 'b'], edges: [['a', 'b'], ['b', 'a']] },
    policy: dependencyPolicy(),
  });
  assert.equal(result.mode, 'strict');
  assert.equal(result.ok, false);
  assert.equal(result.newViolations.length, 2);
});
