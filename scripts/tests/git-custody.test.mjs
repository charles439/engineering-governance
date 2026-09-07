import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  acquire,
  recoverExpired,
  release,
  status,
  verify,
} from '../git-custody.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const custody = path.resolve(here, '..', 'git-custody.mjs');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function commit(cwd, message) {
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '--quiet', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function createRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-custody-'));
  git(root, ['init', '--quiet', '--initial-branch', 'feature/lease']);
  git(root, ['config', 'user.email', 'governance@example.test']);
  git(root, ['config', 'user.name', 'Governance Test']);
  fs.writeFileSync(path.join(root, 'README.md'), 'lease fixture\n');
  commit(root, 'baseline');
  return root;
}

function cleanup(root) {
  try { git(root, ['worktree', 'prune']); } catch { /* fixture may already be gone */ }
  fs.rmSync(root, { recursive: true, force: true });
}

test('acquire, status, verify, and release use the shared Git common directory', () => {
  const root = createRepo();
  try {
    const acquired = acquire({ cwd: root, task: 'baseline-test', now: 1_000, ttlMs: 10_000 });
    assert.match(acquired.ownerToken, /^[0-9a-f]{64}$/);
    const current = status({ cwd: root, now: 2_000 });
    assert.equal(current.exists, true);
    assert.equal(current.identity, acquired.identity);
    assert.equal(current.lease.ownerToken, undefined);
    assert.match(current.lease.ownerTokenHint, /^[0-9a-f]{8}…$/);
    assert.equal(verify({ cwd: root, ownerToken: acquired.ownerToken, now: 2_000 }).verified, true);
    assert.equal(release({ cwd: root, ownerToken: acquired.ownerToken }).released, true);
    assert.equal(status({ cwd: root }).exists, false);
  } finally { cleanup(root); }
});

test('contenders and wrong owners cannot take or release an active lease', () => {
  const root = createRepo();
  try {
    const acquired = acquire({ cwd: root, task: 'holder', now: 1_000, ttlMs: 10_000 });
    assert.throws(() => acquire({ cwd: root, task: 'contender', now: 1_100 }), /held by another task/);
    assert.throws(() => verify({ cwd: root, ownerToken: '0'.repeat(64), now: 1_100 }), /does not match/);
    assert.throws(() => release({ cwd: root, ownerToken: '0'.repeat(64) }), /does not match/);
    assert.equal(status({ cwd: root }).identity, acquired.identity);
    release({ cwd: root, ownerToken: acquired.ownerToken });
  } finally { cleanup(root); }
});

test('verification rejects expiry, moved HEAD, and a changed checkout while release remains allowed after commit', () => {
  const root = createRepo();
  try {
    const acquired = acquire({ cwd: root, task: 'moving-head', now: 1_000, ttlMs: 10_000 });
    assert.throws(() => verify({ cwd: root, ownerToken: acquired.ownerToken, now: 11_001 }), /expired/);
    fs.writeFileSync(path.join(root, 'change.txt'), 'committed\n');
    const movedHead = commit(root, 'move head');
    assert.notEqual(movedHead, acquired.lease.expectedHead);
    assert.throws(() => verify({ cwd: root, ownerToken: acquired.ownerToken, now: 2_000 }), /current HEAD/);
    assert.equal(release({ cwd: root, ownerToken: acquired.ownerToken }).released, true);

    const second = acquire({ cwd: root, task: 'branch-change', now: 3_000, ttlMs: 10_000 });
    git(root, ['checkout', '--quiet', '-b', 'feature/other']);
    assert.throws(() => verify({ cwd: root, ownerToken: second.ownerToken, now: 3_100 }), /branch/);
    git(root, ['checkout', '--quiet', 'feature/lease']);
    release({ cwd: root, ownerToken: second.ownerToken });
  } finally { cleanup(root); }
});

test('protected branches cannot acquire a lease', () => {
  const root = createRepo();
  try {
    git(root, ['branch', 'main']);
    git(root, ['checkout', '--quiet', 'main']);
    assert.throws(() => acquire({ cwd: root, task: 'protected', now: 1_000 }), /protected branch/);
    assert.equal(status({ cwd: root }).exists, false);
  } finally { cleanup(root); }
});

test('linked worktrees contend through the common directory lease', () => {
  const root = createRepo();
  const linked = path.join(path.dirname(root), `${path.basename(root)}-linked`);
  try {
    git(root, ['worktree', 'add', '--quiet', linked, '-b', 'feature/linked']);
    const acquired = acquire({ cwd: root, task: 'primary', now: 1_000, ttlMs: 10_000 });
    const linkedStatus = status({ cwd: linked, now: 2_000 });
    assert.equal(linkedStatus.identity, acquired.identity);
    assert.throws(() => acquire({ cwd: linked, task: 'linked-contender', now: 2_000 }), /held by another task/);
    assert.throws(() => verify({ cwd: linked, ownerToken: acquired.ownerToken, now: 2_000 }), /worktree|branch/);
    release({ cwd: root, ownerToken: acquired.ownerToken });
  } finally {
    try { git(root, ['worktree', 'remove', '--force', linked]); } catch { /* best effort fixture cleanup */ }
    cleanup(root);
    try { fs.rmSync(linked, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('expired recovery is explicit and an old identity cannot remove a newer lease', () => {
  const root = createRepo();
  try {
    const oldLease = acquire({ cwd: root, task: 'expired', now: 1_000, ttlMs: 10 });
    assert.equal(status({ cwd: root, now: 1_011 }).expired, true);
    assert.throws(() => recoverExpired({ cwd: root, observedIdentity: oldLease.identity, now: 1_005 }), /has not expired/);
    assert.equal(recoverExpired({ cwd: root, observedIdentity: oldLease.identity, now: 1_011 }).recovered, true);
    const newLease = acquire({ cwd: root, task: 'new-holder', now: 2_000, ttlMs: 10_000 });
    assert.throws(() => recoverExpired({ cwd: root, observedIdentity: oldLease.identity, now: 2_001 }), /does not match/);
    assert.equal(status({ cwd: root }).identity, newLease.identity);
    release({ cwd: root, ownerToken: newLease.ownerToken });
  } finally { cleanup(root); }
});

test('CLI is standalone and status does not reveal the full owner token', () => {
  const root = createRepo();
  try {
    const acquired = spawnSync(process.execPath, [custody, 'acquire', '--cwd', root, '--task', 'cli', '--ttl-ms', '10000'], { encoding: 'utf8', windowsHide: true });
    assert.equal(acquired.status, 0, acquired.stderr);
    const lease = JSON.parse(acquired.stdout);
    const inspected = spawnSync(process.execPath, [custody, 'status', '--cwd', root], { encoding: 'utf8', windowsHide: true });
    assert.equal(inspected.status, 0, inspected.stderr);
    const result = JSON.parse(inspected.stdout);
    assert.equal(result.lease.ownerToken, undefined);
    assert.equal(result.identity, lease.identity);
    release({ cwd: root, ownerToken: lease.ownerToken });
  } finally { cleanup(root); }
});
