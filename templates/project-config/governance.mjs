#!/usr/bin/env node
// Project launcher: all governance rules remain in the pinned external toolkit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function run(command, args, cwd, invoke) {
  const result = invoke(command, args, { cwd, encoding: 'utf8', shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || String(result.status ?? 'signal')}`);
  return String(result.stdout || '').trim();
}

export function launch({ projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), args = process.argv.slice(2), env = process.env, invoke = spawnSync } = {}) {
  const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, '.governance-toolkit.json'), 'utf8'));
  if (typeof lock.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(lock.repository) || !/^[a-f0-9]{40}$/i.test(lock.ref)) throw new Error('.governance-toolkit.json must pin a valid owner/repository path to a full 40-character commit SHA.');
  if (lock.directory !== undefined && (typeof lock.directory !== 'string' || !lock.directory.trim())) throw new Error('Toolkit lock directory must be a nonempty explicit path.');
  const ci = [env.CI, env.GITHUB_ACTIONS, env.RELEASE].some((value) => value && !/^(false|0)$/i.test(value));
  const dev = args.includes('--toolkit-dev');
  if (dev && (ci || args.includes('--release'))) throw new Error('--toolkit-dev is forbidden in CI/release.');
  const forwarded = args.filter((arg) => arg !== '--toolkit-dev');
  const command = forwarded[0] ?? 'check';
  if (dev && !['check', 'doctor'].includes(command)) throw new Error('--toolkit-dev is restricted to local check/doctor diagnostics.');
  if (dev && (forwarded.includes('--base') || forwarded.includes('--head'))) throw new Error('--toolkit-dev cannot be combined with an authoritative --base/--head range.');
  const home = env.GOVERNANCE_HOME || (process.platform === 'win32' ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'engineering-governance') : path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'engineering-governance'));
  const explicit = env.GOVERNANCE_TOOLKIT_DIR || lock.directory;
  const cache = env.GOVERNANCE_TOOLKIT_CACHE || path.join(home, 'toolkits');
  const toolkit = explicit ? path.resolve(projectRoot, explicit) : path.resolve(cache, lock.ref.toLowerCase());
  const git = (gitArgs, cwd = toolkit) => run('git', gitArgs, cwd, invoke);
  if (command === 'bootstrap') {
    if (forwarded.length !== 1) throw new Error('Usage: node scripts/governance.mjs bootstrap');
    if (!fs.existsSync(toolkit)) {
      fs.mkdirSync(path.dirname(toolkit), { recursive: true });
      const staging = fs.mkdtempSync(path.join(path.dirname(toolkit), '.bootstrap-'));
      try {
        git(['init', '--quiet'], staging);
        git(['-c', 'credential.interactive=never', 'fetch', '--no-tags', '--depth=1', `https://github.com/${lock.repository}.git`, lock.ref], staging);
        git(['-c', 'core.hooksPath=', 'checkout', '--quiet', '--detach', lock.ref], staging);
        if (git(['rev-parse', 'HEAD'], staging).toLowerCase() !== lock.ref.toLowerCase()) throw new Error('Fetched toolkit does not match the pinned SHA.');
        fs.renameSync(staging, toolkit);
      } finally {
        if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
      }
    }
  }
  if (!fs.existsSync(toolkit)) throw new Error(`Pinned toolkit is absent: ${toolkit}. Run node scripts/governance.mjs bootstrap explicitly; check never downloads dependencies.`);
  const revision = git(['rev-parse', 'HEAD']);
  const dirty = git(['status', '--porcelain', '--untracked-files=all']);
  if (revision.toLowerCase() !== lock.ref.toLowerCase() || dirty) {
    if (!dev) throw new Error('Toolkit must have the pinned HEAD and a clean source tree. Use a clean pinned checkout; --toolkit-dev permits local diagnostics only.');
    console.warn('NON-RELEASE toolkit development diagnostics: revision or source differs from the lock.');
  }
  if (command === 'bootstrap') return { code: 0, toolkit, revision };
  const entry = path.join(toolkit, 'scripts/governance.mjs');
  if (!fs.existsSync(entry)) throw new Error(`Pinned toolkit entrypoint is missing: ${entry}`);
  const result = invoke(process.execPath, [entry, ...forwarded], { cwd: projectRoot, env: { ...env, GOVERNANCE_HOME: home }, shell: false, windowsHide: true, stdio: 'inherit' });
  if (result.error) throw result.error;
  return { code: result.status ?? 2, toolkit, revision };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = launch(); if (process.argv[2] === 'bootstrap') console.log(`PASS pinned toolkit ready: ${result.toolkit} (${result.revision})`); process.exitCode = result.code; }
  catch (error) { console.error(`FAIL ${error.message}`); process.exitCode = 2; }
}
