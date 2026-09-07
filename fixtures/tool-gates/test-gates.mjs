#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const adapter = path.resolve(fixtureDir, '../../scripts/tool-gates.mjs');
const fakeTool = path.join(fixtureDir, 'fake-tool.mjs');

function run(args, env = {}) {
  return spawnSync(process.execPath, [adapter, ...args], {
    cwd: fixtureDir,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

const dryRun = run(['--tool', 'contract', '--dry-run', '--path', 'openapi.yaml']);
assert.equal(dryRun.status, 0, dryRun.stderr);
assert.match(dryRun.stdout, /contract@6\.15\.0: spectral lint .*openapi\.yaml/u);

const typescriptDryRun = run(['--tool', 'typescript', '--dry-run', '--path', 'src']);
assert.equal(typescriptDryRun.status, 0, typescriptDryRun.stderr);
assert.match(typescriptDryRun.stdout, /typescript@16\.10\.4: depcruise --validate .*\.dependency-cruiser\.cjs .*src/u);

const pass = run(['--tool', 'python', '--executable', fakeTool, '--path', '.'], { FAKE_TOOL_EXIT: '0' });
assert.equal(pass.status, 0, pass.stderr);
assert.match(pass.stdout, /PASS python checker/u);

const fail = run(['--tool', 'typescript', '--executable', fakeTool, '--path', '.'], { FAKE_TOOL_EXIT: '1' });
assert.equal(fail.status, 1);
assert.match(fail.stderr, /fake tool violation/u);

const missing = run(['--tool', 'python', '--executable', path.join(fixtureDir, 'missing-tool.mjs')]);
assert.equal(missing.status, 2);
assert.match(missing.stderr, /executable does not exist/u);

console.log('PASS tool-gates fixture tests (5 cases)');
