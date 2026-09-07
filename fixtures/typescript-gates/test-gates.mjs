#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const adapter = path.resolve(fixtureDir, '../../scripts/typescript-gates.mjs');
const fakeChecker = path.join(fixtureDir, 'fake-checker.mjs');

function run(args, env = {}) {
  return spawnSync(process.execPath, [adapter, ...args], {
    cwd: fixtureDir,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

function testDryRunDelegatesToCanonicalGate() {
  const result = run(['--dry-run', '--project', 'src']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /typescript@16\.10\.4: depcruise --validate/u);
}

function testLocalCheckerPasses() {
  const result = run(['--executable', fakeChecker, '--project', 'src'], {
    FAKE_CHECKER_EXIT: '0'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS typescript checker/u);
}

function testLocalCheckerViolationReturnsOne() {
  const result = run(['--executable', fakeChecker, '--project', 'src'], {
    FAKE_CHECKER_EXIT: '1'
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fake checker violation/u);
}

function testMissingExecutableReturnsTwo() {
  const result = run(['--executable', path.join(fixtureDir, 'missing-checker.mjs')]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /executable/u);
}

for (const test of [
  testDryRunDelegatesToCanonicalGate,
  testLocalCheckerPasses,
  testLocalCheckerViolationReturnsOne,
  testMissingExecutableReturnsTwo
]) {
  test();
}

console.log('PASS typescript-gates fixture tests (4 cases)');
