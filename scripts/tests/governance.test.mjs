import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectChangedFiles } from '../governance.mjs';

const toolkitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const governance = path.join(toolkitRoot, 'scripts', 'governance.mjs');

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function createRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-git-'));
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'governance@example.test']);
  git(root, ['config', 'user.name', 'Governance Test']);
  write(root, '.governance.yml', `
governance:
  version: "1.0"
  profile: python-typescript-monorepo
project:
  name: fixture
modules:
  - name: contracts
    path: contracts
    owner: platform
checks:
  adr_required_for:
    - contracts/**
`);
  write(root, 'contracts/remove-me.ts', 'export const removeMe = true;\n');
  write(root, 'README.md', 'baseline\n');
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'baseline']);
  return root;
}

test('local changed-file collection includes both tracked changes and untracked files', () => {
  const root = createRepository();
  write(root, 'contracts/new-api.ts', 'export const api = 1;\n');
  write(root, 'notes/设计 空格.md', 'untracked\n');
  const files = collectChangedFiles({ cwd: root, ci: false });
  assert.deepEqual(new Set(files), new Set(['contracts/new-api.ts', 'notes/设计 空格.md']));
});

test('a deletion in an architecture path is visible to the gate', () => {
  const root = createRepository();
  fs.rmSync(path.join(root, 'contracts/remove-me.ts'));
  assert.ok(collectChangedFiles({ cwd: root, ci: false }).includes('contracts/remove-me.ts'));
});

test('CI requires verified full base and head SHAs', () => {
  const root = createRepository();
  const head = git(root, ['rev-parse', 'HEAD']);
  assert.throws(() => collectChangedFiles({ cwd: root, ci: true }), /CI requires --base and --head/);
  assert.throws(() => collectChangedFiles({ cwd: root, base: 'short', head, ci: true }), /full 40- or 64-character/);
  assert.deepEqual(collectChangedFiles({ cwd: root, base: head, head, ci: true }), []);
});

test('architecture changes require a changed, substantive accepted ADR', () => {
  const root = createRepository();
  write(root, 'contracts/new-api.ts', 'export const api = 1;\n');
  write(root, 'contracts/second-api.ts', 'export const otherApi = 1;\n');
  let result = spawnSync(process.execPath, [governance, 'check', '--config', '.governance.yml'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /requires a changed docs\/adr/);

  write(root, 'docs/adr/0001-api.md', '# Use versioned API\n\nStatus: Accepted\n\nAffected paths: contracts/**\n\n## Context\n\nConsumers need a stable boundary.\n\n## Decision\n\nExpose versioned API contracts.\n');
  result = spawnSync(process.execPath, [governance, 'check', '--config', '.governance.yml'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
