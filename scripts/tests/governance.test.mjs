import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectChangedFiles, evaluateGovernance } from '../governance.mjs';

const toolkitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const governance = path.join(toolkitRoot, 'scripts', 'governance.mjs');

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function commit(root, message) {
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function createRepository({ withScanPin = false } = {}) {
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
  if (withScanPin) addScanPin(root);
  commit(root, 'baseline');
  return root;
}

function addScanPin(root) {
  write(root, '.dependency-cruiser.cjs', 'module.exports = { forbidden: [] };\n');
  write(root, '.governance-toolkit.json', JSON.stringify({
    repository: 'example/engineering-governance',
    ref: '0123456789abcdef0123456789abcdef01234567',
    scan: { config: '.dependency-cruiser.cjs', roots: [{ path: 'contracts', typescript: true }] },
  }, null, 2) + '\n');
}

function cleanDependencyReport() {
  return { modules: [{ source: 'contracts/remove-me.ts', dependencies: [] }] };
}

function runGovernance(root, args) {
  return spawnSync(process.execPath, [governance, ...args], { cwd: root, encoding: 'utf8' });
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
  assert.throws(() => collectChangedFiles({ cwd: root, base: head, head, ci: true }), /distinct commits/);
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

test('authoritative checks compare complete base/head Git trees', () => {
  const root = createRepository();
  const base = git(root, ['rev-parse', 'HEAD']);
  write(root, 'contracts/new-api.ts', 'export const api = 1;\n');
  write(root, 'docs/adr/0001-api.md', '# Use versioned API\n\nStatus: Accepted\n\nAffected paths: contracts/**\n\n## Context\n\nConsumers need a stable boundary.\n\n## Decision\n\nExpose versioned API contracts.\n');
  const head = commit(root, 'architecture change');
  const result = evaluateGovernance({ cwd: root, base, head, ci: true });
  assert.equal(result.code, 0, result.errors.join('\n'));
  assert.equal(result.authoritative, true);
  assert.deepEqual(result.changed, ['contracts/new-api.ts', 'docs/adr/0001-api.md']);
});

test('trusted base configuration is validated against its own tree', () => {
  const root = createRepository();
  write(root, '.governance.yml', fs.readFileSync(path.join(root, '.governance.yml'), 'utf8').replace('path: contracts', 'path: legacy'));
  fs.renameSync(path.join(root, 'contracts'), path.join(root, 'legacy'));
  const base = commit(root, 'legacy module');
  fs.rmSync(path.join(root, 'legacy'), { recursive: true });
  write(root, 'current/marker.ts', 'export const current = true;\n');
  write(root, '.governance.yml', fs.readFileSync(path.join(root, '.governance.yml'), 'utf8').replace('path: legacy', 'path: current'));
  const head = commit(root, 'move module');
  const result = evaluateGovernance({ cwd: root, base, head, ci: true });
  assert.equal(result.code, 0, result.errors.join('\n'));
});

test('authoritative checks reject trusted policy weakening', () => {
  const root = createRepository();
  const base = git(root, ['rev-parse', 'HEAD']);
  write(root, '.governance.yml', fs.readFileSync(path.join(root, '.governance.yml'), 'utf8').replace('\nchecks:\n', '\nbaseline:\n  mode: ratchet\n  allowed_rules:\n    - no-cycle\n\nchecks:\n'));
  const head = commit(root, 'weaken governance');
  const result = evaluateGovernance({
    cwd: root,
    base,
    head,
    ci: true,
    scan: () => ({ headReport: cleanDependencyReport(), baseReport: cleanDependencyReport(), range: { base, head } }),
  });
  assert.equal(result.code, 1);
  assert.match(result.errors.join('\n'), /baseline\.mode from strict to ratchet/);
});

test('authoritative checks reject in-range scanner configuration changes', () => {
  const root = createRepository();
  const base = git(root, ['rev-parse', 'HEAD']);
  write(root, '.dependency-cruiser.cjs', 'module.exports = { forbidden: [] };\n');
  const head = commit(root, 'change scanner policy');
  const result = evaluateGovernance({ cwd: root, base, head, ci: true });
  assert.equal(result.code, 1);
  assert.match(result.errors.join('\n'), /scanner configuration changes/);
});

test('a pinned project check performs a fresh dependency scan automatically', () => {
  const root = createRepository({ withScanPin: true });
  const calls = [];
  const result = evaluateGovernance({
    cwd: root,
    scan: (options) => {
      calls.push(options);
      return { headReport: cleanDependencyReport(), range: { head: 'HEAD', authoritative: false } };
    },
  });
  assert.equal(result.code, 0, result.errors.join('\n'));
  assert.equal(result.dependency.fresh, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].base, undefined);
});

test('authoritative checks apply head dependency policy strengthening immediately', () => {
  const root = createRepository({ withScanPin: true });
  const base = git(root, ['rev-parse', 'HEAD']);
  const config = fs.readFileSync(path.join(root, '.governance.yml'), 'utf8').replace(
    'checks:\n',
    'checks:\n  architecture:\n    no_new_forbidden_dependencies: true\n    forbidden_dependencies:\n      - from: contracts/remove-me.ts\n        to: contracts/new-api.ts\n',
  );
  write(root, '.governance.yml', config);
  write(root, 'contracts/new-api.ts', 'export const api = 1;\n');
  const head = commit(root, 'strengthen forbidden dependency policy');
  const result = evaluateGovernance({
    cwd: root,
    base,
    head,
    ci: true,
    scan: () => ({
      headReport: {
        modules: [
          { source: 'contracts/remove-me.ts', dependencies: [{ resolved: 'contracts/new-api.ts' }] },
          { source: 'contracts/new-api.ts', dependencies: [] },
        ],
      },
      range: { base, head },
    }),
  });
  assert.equal(result.code, 1);
  assert.match(result.errors.join('\n'), /forbidden dependency: contracts\/remove-me\.ts -> contracts\/new-api\.ts/);
});

test('explicit dependency reports bypass automatic scanning', () => {
  const root = createRepository({ withScanPin: true });
  write(root, 'head-report.json', JSON.stringify(cleanDependencyReport()) + '\n');
  const result = evaluateGovernance({
    cwd: root,
    dependencyInput: 'head-report.json',
    scan: () => { throw new Error('automatic scan should be bypassed when a report is supplied'); },
  });
  assert.equal(result.code, 0, result.errors.join('\n'));
  assert.equal(result.dependency.fresh, undefined);
});

test('authoritative checks reject supplied dependency reports instead of bypassing a fresh scan', () => {
  const root = createRepository({ withScanPin: true });
  const base = git(root, ['rev-parse', 'HEAD']);
  write(root, 'README.md', 'head\n');
  const head = commit(root, 'head');
  write(root, 'head-report.json', JSON.stringify(cleanDependencyReport()) + '\n');
  let scanned = false;
  const result = evaluateGovernance({
    cwd: root,
    base,
    head,
    ci: true,
    dependencyInput: 'head-report.json',
    scan: () => { scanned = true; return { headReport: cleanDependencyReport(), range: { base, head } }; },
  });
  assert.equal(scanned, false);
  assert.equal(result.code, 2);
  assert.match(result.errors.join('\n'), /authoritative governance checks require a fresh dependency scan/);
});

test('authoritative checks validate committed toolkit pins before scanning', () => {
  for (const mutation of ['tamper', 'delete', 'malform', 'directory']) {
    const root = createRepository({ withScanPin: true });
    const base = git(root, ['rev-parse', 'HEAD']);
    const pinFile = path.join(root, '.governance-toolkit.json');
    if (mutation === 'tamper') {
      const pin = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
      pin.ref = 'fedcba9876543210fedcba9876543210fedcba98';
      fs.writeFileSync(pinFile, JSON.stringify(pin, null, 2) + '\n');
    } else if (mutation === 'delete') {
      fs.rmSync(pinFile);
    } else if (mutation === 'malform') {
      fs.writeFileSync(pinFile, '{ malformed\n');
    } else {
      fs.rmSync(pinFile);
      fs.mkdirSync(pinFile);
      write(root, '.governance-toolkit.json/child', 'not a pin\n');
    }
    const head = commit(root, `${mutation} toolkit pin`);
    let scanned = false;
    const result = evaluateGovernance({
      cwd: root,
      base,
      head,
      ci: true,
      scan: () => { scanned = true; return { headReport: cleanDependencyReport(), range: { base, head } }; },
    });
    assert.equal(scanned, false, mutation);
    assert.equal(result.code, ['tamper', 'delete'].includes(mutation) ? 1 : 2, mutation);
    if (mutation === 'tamper') assert.match(result.errors.join('\n'), /head toolkit pin identity differs/);
    if (mutation === 'delete') assert.match(result.errors.join('\n'), /toolkit pin is missing at .*\.governance-toolkit\.json/);
    if (mutation === 'malform') assert.match(result.errors.join('\n'), /toolkit pin at .* is malformed/);
    if (mutation === 'directory') assert.match(result.errors.join('\n'), /toolkit pin at .* is unreadable: expected a regular file/);
  }
});

test('authoritative scans use committed pins when the working-tree pin is deleted', () => {
  const root = createRepository({ withScanPin: true });
  const base = git(root, ['rev-parse', 'HEAD']);
  write(root, 'README.md', 'head\n');
  const head = commit(root, 'head change');
  fs.rmSync(path.join(root, '.governance-toolkit.json'));
  let scanned = false;
  const result = evaluateGovernance({
    cwd: root,
    base,
    head,
    ci: true,
    scan: () => { scanned = true; return { headReport: cleanDependencyReport(), range: { base, head } }; },
  });
  assert.equal(scanned, true);
  assert.equal(result.code, 0, result.errors.join('\n'));
  assert.equal(result.dependency.fresh, true);
});

test('governance git delegates the complete custody CLI lifecycle in a project cwd', async () => {
  const root = createRepository();
  git(root, ['branch', '--move', 'governance-acceptance']);
  const initial = runGovernance(root, ['git', 'status']);
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);
  assert.equal(JSON.parse(initial.stdout).exists, false);

  const acquired = runGovernance(root, ['git', 'acquire', '--task', 'acceptance lifecycle']);
  assert.equal(acquired.status, 0, acquired.stderr || acquired.stdout);
  const lease = JSON.parse(acquired.stdout);
  assert.equal(lease.acquired, true);

  const verified = runGovernance(root, ['git', 'verify', '--owner-token', lease.ownerToken]);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assert.equal(JSON.parse(verified.stdout).verified, true);

  const released = runGovernance(root, ['git', 'release', '--owner-token', lease.ownerToken]);
  assert.equal(released.status, 0, released.stderr || released.stdout);
  assert.equal(JSON.parse(released.stdout).released, true);
  assert.equal(JSON.parse(runGovernance(root, ['git', 'status']).stdout).exists, false);

  const expiring = runGovernance(root, ['git', 'acquire', '--task', 'expired acceptance lease', '--ttl-ms', '1']);
  assert.equal(expiring.status, 0, expiring.stderr || expiring.stdout);
  const expiringLease = JSON.parse(expiring.stdout);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const recovered = runGovernance(root, ['git', 'recover-expired', '--identity', expiringLease.identity]);
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.equal(JSON.parse(recovered.stdout).recovered, true);
});
