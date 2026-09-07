import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const gate = path.resolve(here, '..', '..', 'scripts', 'dependency-gates.mjs');

function run(input) {
  return spawnSync(process.execPath, [gate, '--input', path.join(here, input)], {
    encoding: 'utf8'
  });
}

const pass = run('pass.json');
assert.equal(pass.status, 0, pass.stderr || pass.stdout);
assert.match(pass.stdout, /PASS dependency gates/);

const cycle = run('cycle.json');
assert.equal(cycle.status, 1);
assert.match(cycle.stderr, /dependency cycle detected/);

const forbidden = run('forbidden.json');
assert.equal(forbidden.status, 1);
assert.match(forbidden.stderr, /forbidden dependency/);

const report = run('dependency-cruiser-report.json');
assert.equal(report.status, 0, report.stderr || report.stdout);
assert.match(report.stdout, /nodes=3, edges=2/);

const skipped = spawnSync(process.execPath, [gate, '--config', path.join(here, 'project-fail.yml')], {
  encoding: 'utf8'
});
assert.equal(skipped.status, 0, skipped.stderr || skipped.stdout);
assert.match(skipped.stdout, /^SKIP dependency gates/m);

const required = spawnSync(process.execPath, [gate, '--config', path.join(here, 'required.yml')], {
  encoding: 'utf8'
});
assert.equal(required.status, 1, required.stderr || required.stdout);
assert.match(required.stderr, /dependency graph is required/);

const malformed = run('malformed.json');
assert.equal(malformed.status, 2, malformed.stderr || malformed.stdout);
assert.match(malformed.stderr, /must be dependency-cruiser JSON/);

const reportViolation = run('dependency-cruiser-violation.json');
assert.equal(reportViolation.status, 1, reportViolation.stderr || reportViolation.stdout);
assert.match(reportViolation.stderr, /dependency-cruiser violation: src\/domain\.ts -> src\/infra\.ts/);

console.log('PASS dependency gate fixture tests');
