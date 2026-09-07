#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LEASE_FILE = '.governance-git-custody.lease.json';
const MUTEX_DIRECTORY = '.governance-git-custody.mutex';
const MUTEX_MARKER = 'owner';
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const PROTECTED_BRANCHES = new Set(['main', 'master', 'staging', 'production']);
const SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const TOKEN_PATTERN = /^[0-9a-f]{32,}$/i;

function fail(message) { throw new Error(message); }

function resolveCwd(cwd = process.cwd()) {
  const absolute = path.resolve(cwd);
  if (!fs.existsSync(absolute)) fail(`worktree does not exist: ${absolute}`);
  return fs.realpathSync(absolute);
}

function runGit(cwd, gitArgs, allowFailure = false) {
  const result = spawnSync('git', gitArgs, {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    if (allowFailure) return null;
    const detail = result.error?.message || String(result.stderr || '').trim() || `exit ${result.status ?? 'unknown'}`;
    fail(`git ${gitArgs.join(' ')} failed: ${detail}`);
  }
  return String(result.stdout || '').trim();
}

function gitContext(cwd = process.cwd()) {
  const worktree = resolveCwd(cwd);
  const commonOutput = runGit(worktree, ['rev-parse', '--git-common-dir']);
  const commonCandidate = path.isAbsolute(commonOutput) ? commonOutput : path.resolve(worktree, commonOutput);
  if (!fs.existsSync(commonCandidate)) fail(`git common directory does not exist: ${commonCandidate}`);
  const commonDir = fs.realpathSync(commonCandidate);
  const topLevelOutput = runGit(worktree, ['rev-parse', '--show-toplevel']);
  const gitWorktree = fs.realpathSync(path.resolve(worktree, topLevelOutput));
  const branch = runGit(gitWorktree, ['branch', '--show-current']) || '(detached)';
  const head = runGit(gitWorktree, ['rev-parse', '--verify', 'HEAD']);
  if (!SHA_PATTERN.test(head)) fail(`git HEAD is not a full commit SHA: ${head}`);
  return { cwd: worktree, commonDir, worktree: gitWorktree, branch, head };
}

function branchName(branch) {
  return String(branch).replace(/^refs\/heads\//, '');
}

function assertBranchAllowed(branch) {
  if (PROTECTED_BRANCHES.has(branchName(branch))) fail(`protected branch cannot be leased: ${branch}`);
}

function leasePath(commonDir) { return path.join(commonDir, LEASE_FILE); }

function ensureRegularFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return false;
    fail(`cannot inspect ${label}: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`refusing unsafe ${label}: ${file}`);
  return true;
}

function parseLease(raw, file) {
  let lease;
  try { lease = JSON.parse(raw); } catch (error) { fail(`malformed lease ${file}: ${error.message}`); }
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) fail(`malformed lease ${file}: expected an object`);
  for (const field of ['ownerToken', 'task', 'worktree', 'branch', 'expectedHead', 'expiresAt']) {
    if (typeof lease[field] !== 'string' || !lease[field].trim()) fail(`malformed lease ${file}: ${field} is required`);
  }
  if (!TOKEN_PATTERN.test(lease.ownerToken)) fail(`malformed lease ${file}: ownerToken is invalid`);
  if (!SHA_PATTERN.test(lease.expectedHead)) fail(`malformed lease ${file}: expectedHead is invalid`);
  if (!path.isAbsolute(lease.worktree)) fail(`malformed lease ${file}: worktree must be absolute`);
  if (Number.isNaN(Date.parse(lease.expiresAt))) fail(`malformed lease ${file}: expiresAt is invalid`);
  return {
    version: lease.version ?? 1,
    ownerToken: lease.ownerToken,
    task: lease.task,
    worktree: lease.worktree,
    branch: lease.branch,
    expectedHead: lease.expectedHead,
    expiresAt: lease.expiresAt,
  };
}

function readLease(commonDir) {
  const file = leasePath(commonDir);
  if (!ensureRegularFile(file, 'lease')) return null;
  return parseLease(fs.readFileSync(file, 'utf8'), file);
}

function canonicalLease(lease) {
  return JSON.stringify({
    ownerToken: lease.ownerToken,
    task: lease.task,
    worktree: lease.worktree,
    branch: lease.branch,
    expectedHead: lease.expectedHead,
    expiresAt: lease.expiresAt,
  });
}

function leaseIdentity(lease) {
  return crypto.createHash('sha256').update(canonicalLease(lease)).digest('hex');
}

function nowValue(now) {
  const value = typeof now === 'function' ? now() : now ?? Date.now();
  if (!Number.isFinite(value)) fail('clock must return a finite millisecond timestamp');
  return Number(value);
}

function isExpired(lease, now) { return Date.parse(lease.expiresAt) <= nowValue(now); }

function acquireMutex(commonDir) {
  const directory = path.join(commonDir, MUTEX_DIRECTORY);
  const marker = path.join(directory, MUTEX_MARKER);
  const token = crypto.randomBytes(16).toString('hex');
  try { fs.mkdirSync(directory); } catch (error) {
    if (error.code === 'EEXIST') fail('git custody mutation mutex is already held; refusing to guess or clean it');
    fail(`cannot acquire git custody mutation mutex: ${error.message}`);
  }
  try {
    fs.writeFileSync(marker, token, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    fail(`cannot initialize git custody mutation mutex: ${error.message}`);
  }
  return () => {
    try {
      if (fs.readFileSync(marker, 'utf8') !== token) return;
      fs.unlinkSync(marker);
      fs.rmdirSync(directory);
    } catch {
      // A changed or interrupted mutex is left in place. Removing an unknown
      // lock could allow two custodians to mutate the lease concurrently.
    }
  };
}

function withMutex(commonDir, action) {
  const release = acquireMutex(commonDir);
  try { return action(); } finally { release(); }
}

function writeLease(commonDir, lease) {
  const file = leasePath(commonDir);
  if (ensureRegularFile(file, 'lease') || fs.existsSync(file)) fail(`active lease path already exists: ${file}`);
  const temporary = path.join(commonDir, `.${LEASE_FILE}.${crypto.randomBytes(12).toString('hex')}.tmp`);
  let created = false;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, `${JSON.stringify(lease, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    fs.renameSync(temporary, file);
  } catch (error) {
    if (created) {
      try { fs.unlinkSync(temporary); } catch { /* leave evidence if cleanup is unsafe */ }
    }
    fail(`cannot write git custody lease: ${error.message}`);
  }
}

function removeLease(commonDir, expectedIdentity) {
  const file = leasePath(commonDir);
  const current = readLease(commonDir);
  if (!current) fail('no git custody lease exists');
  if (expectedIdentity && leaseIdentity(current) !== expectedIdentity) fail('lease identity changed; refusing to remove a newer holder');
  fs.unlinkSync(file);
}

function requireTask(task) {
  if (typeof task !== 'string' || !task.trim()) fail('acquire requires a non-empty task');
  return task.trim();
}

function requireToken(ownerToken) {
  if (typeof ownerToken !== 'string' || !ownerToken.trim()) fail('ownerToken is required');
  return ownerToken.trim();
}

function tokenMatches(actual, provided) {
  const left = Buffer.from(actual);
  const right = Buffer.from(provided);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function publicLease(lease, revealToken = false) {
  const result = {
    task: lease.task,
    worktree: lease.worktree,
    branch: lease.branch,
    expectedHead: lease.expectedHead,
    expiresAt: lease.expiresAt,
  };
  if (revealToken) result.ownerToken = lease.ownerToken;
  else result.ownerTokenHint = `${lease.ownerToken.slice(0, 8)}…`;
  return result;
}

/** Acquire the shared advisory lease for the current Git worktree. */
export function acquire({ cwd = process.cwd(), task, ttlMs = DEFAULT_TTL_MS, now } = {}) {
  const context = gitContext(cwd);
  assertBranchAllowed(context.branch);
  const name = requireTask(task);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) fail('ttlMs must be a positive finite number');
  const currentTime = nowValue(now);
  const expiresAt = new Date(currentTime + ttlMs).toISOString();
  const lease = {
    version: 1,
    ownerToken: crypto.randomBytes(32).toString('hex'),
    task: name,
    worktree: context.worktree,
    branch: context.branch,
    expectedHead: context.head,
    expiresAt,
  };
  return withMutex(context.commonDir, () => {
    const existing = readLease(context.commonDir);
    if (existing) {
      if (isExpired(existing, currentTime)) fail('an expired git custody lease exists; run recover-expired with its observed identity');
      fail(`git custody lease is held by another task (task=${existing.task}, expiresAt=${existing.expiresAt})`);
    }
    writeLease(context.commonDir, lease);
    return { acquired: true, identity: leaseIdentity(lease), ownerToken: lease.ownerToken, lease: publicLease(lease, true) };
  });
}

/** Read the shared lease without taking the mutation mutex or exposing its token. */
export function status({ cwd = process.cwd(), now } = {}) {
  const context = gitContext(cwd);
  const lease = readLease(context.commonDir);
  if (!lease) return { exists: false, commonDir: context.commonDir };
  return {
    exists: true,
    commonDir: context.commonDir,
    identity: leaseIdentity(lease),
    expired: isExpired(lease, now),
    lease: publicLease(lease),
  };
}

function currentLeaseFor(cwd, ownerToken) {
  const context = gitContext(cwd);
  const lease = readLease(context.commonDir);
  if (!lease) fail('no git custody lease exists');
  if (!tokenMatches(lease.ownerToken, requireToken(ownerToken))) fail('owner token does not match the active lease');
  return { context, lease };
}

/** Verify ownership, expiry, checkout, branch, and unchanged expected HEAD. */
export function verify({ cwd = process.cwd(), ownerToken, now } = {}) {
  const { context, lease } = currentLeaseFor(cwd, ownerToken);
  assertBranchAllowed(context.branch);
  if (isExpired(lease, now)) fail('git custody lease has expired');
  if (lease.worktree !== context.worktree) fail('lease worktree does not match the current checkout');
  if (lease.branch !== context.branch) fail('lease branch does not match the current checkout');
  if (lease.expectedHead !== context.head) fail(`lease expected HEAD ${lease.expectedHead}, current HEAD is ${context.head}`);
  return { verified: true, identity: leaseIdentity(lease), lease: publicLease(lease) };
}

/** Release only the matching owner's lease; expected HEAD may have moved after a commit. */
export function release({ cwd = process.cwd(), ownerToken } = {}) {
  const context = gitContext(cwd);
  const token = requireToken(ownerToken);
  assertBranchAllowed(context.branch);
  return withMutex(context.commonDir, () => {
    const lease = readLease(context.commonDir);
    if (!lease) fail('no git custody lease exists');
    if (!tokenMatches(lease.ownerToken, token)) fail('owner token does not match the active lease');
    if (lease.worktree !== context.worktree) fail('lease worktree does not match the current checkout');
    if (lease.branch !== context.branch) fail('lease branch does not match the current checkout');
    const identity = leaseIdentity(lease);
    removeLease(context.commonDir, identity);
    return { released: true, identity };
  });
}

/** Remove an expired lease only when its identity was observed before recovery. */
export function recoverExpired({ cwd = process.cwd(), observedIdentity, identity, observed, now } = {}) {
  const observedValue = observedIdentity ?? identity ?? observed?.identity;
  if (typeof observedValue !== 'string' || !/^[0-9a-f]{64}$/i.test(observedValue)) fail('recover-expired requires the observed lease identity from status');
  const context = gitContext(cwd);
  const currentTime = nowValue(now);
  return withMutex(context.commonDir, () => {
    const lease = readLease(context.commonDir);
    if (!lease) fail('no git custody lease exists');
    const currentIdentity = leaseIdentity(lease);
    if (currentIdentity !== observedValue) fail('observed lease identity does not match the active lease');
    if (!isExpired(lease, currentTime)) fail('active lease has not expired; refusing automatic reclaim');
    removeLease(context.commonDir, currentIdentity);
    return { recovered: true, identity: currentIdentity };
  });
}

function parseCli(argv) {
  const command = argv[0] ?? 'status';
  if (command === '--help' || command === '-h') return { help: true };
  const values = {};
  const allowed = new Set(['--cwd', '--task', '--ttl-ms', '--owner-token', '--identity']);
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help' || key === '-h') return { help: true };
    if (!allowed.has(key) || values[key] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) fail(`invalid or missing CLI option: ${key}`);
    values[key] = argv[++index];
  }
  return { command, values };
}

function cliMain(argv = process.argv.slice(2)) {
  try {
    const parsed = parseCli(argv);
    if (parsed.help) {
      console.log('Usage: git-custody.mjs <acquire|status|verify|release|recover-expired> [--cwd DIR] [--task TASK] [--ttl-ms MS] [--owner-token TOKEN] [--identity ID]');
      return 0;
    }
    const values = parsed.values;
    const cwd = values['--cwd'];
    let result;
    if (parsed.command === 'acquire') result = acquire({ cwd, task: values['--task'], ttlMs: values['--ttl-ms'] === undefined ? undefined : Number(values['--ttl-ms']) });
    else if (parsed.command === 'status') result = status({ cwd });
    else if (parsed.command === 'verify') result = verify({ cwd, ownerToken: values['--owner-token'] });
    else if (parsed.command === 'release') result = release({ cwd, ownerToken: values['--owner-token'] });
    else if (parsed.command === 'recover-expired') result = recoverExpired({ cwd, observedIdentity: values['--identity'] });
    else fail(`unknown git custody command: ${parsed.command}`);
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    console.error(`FAIL git custody: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = cliMain();
