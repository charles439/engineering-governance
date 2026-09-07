#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const adapter = path.resolve(fixtureDir, '../../scripts/python-gates.mjs');
const fakeChecker = path.join(fixtureDir, 'fake-checker.mjs');

function run(args, env = {}) {
  return spawnSync(process.execPath, [adapter, ...args], { cwd: fixtureDir, encoding: 'utf8', env: { ...process.env, ...env } });
}

const dryRun = run(['--dry-run', '--project', fixtureDir]);
assert.equal(dryRun.status, 0, dryRun.stderr);
assert.match(dryRun.stdout, /python@2\.2: lint-imports/u);

const passed = run(['--executable', fakeChecker, '--project', fixtureDir], { FAKE_CHECKER_EXIT: '0', EXPECT_CWD: fixtureDir });
assert.equal(passed.status, 0, passed.stderr);
assert.match(passed.stdout, /PASS python checker/u);

const violation = run(['--executable', fakeChecker, '--project', fixtureDir], { FAKE_CHECKER_EXIT: '1' });
assert.equal(violation.status, 1);
assert.match(violation.stderr, /fake import-linter violation/u);

const missing = run(['--executable', path.join(fixtureDir, 'missing-checker.mjs')]);
assert.equal(missing.status, 2);
assert.match(missing.stderr, /executable does not exist/u);

console.log('PASS python-gates fixture tests (4 cases)');
