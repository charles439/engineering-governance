#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadGovernanceConfig } from './config.mjs';
import { adrAffectedPaths, validateAdrDocument } from './verify-adr-policy.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

function option(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function commandError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function runGit(args, cwd, invoke = execFileSync) {
  try {
    return invoke('git', args, { cwd, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const detail = Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8').trim() : String(error.stderr || error.message).trim();
    throw commandError(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
}

function nullDelimited(value) {
  return Buffer.from(value || '').toString('utf8').split('\0').filter(Boolean);
}

function nameStatusFiles(value) {
  const tokens = nullDelimited(value);
  const files = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      files.push(tokens[index++], tokens[index++]);
    } else {
      files.push(tokens[index++]);
    }
  }
  return files.filter(Boolean);
}

/** Exact files under review. CI uses an immutable commit range; local runs use HEAD plus untracked files. */
export function collectChangedFiles({ cwd, base, head, ci = Boolean(process.env.CI), invoke } = {}) {
  if ((base && !head) || (!base && head)) throw commandError('--base and --head must be supplied together');
  if (ci && !base) throw commandError('CI requires --base and --head full commit SHAs');
  const git = (args) => runGit(args, cwd, invoke);
  if (base) {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(base) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(head)) {
      throw commandError('--base and --head must be full 40- or 64-character commit SHAs');
    }
    git(['cat-file', '-e', `${base}^{commit}`]);
    git(['cat-file', '-e', `${head}^{commit}`]);
    const checkedOutHead = Buffer.from(git(['rev-parse', 'HEAD'])).toString('utf8').trim();
    if (checkedOutHead !== head) throw commandError('--head must match the checked-out HEAD commit');
    return [...new Set(nameStatusFiles(git(['diff', '--name-status', '-z', '--find-renames', '--diff-filter=ACMRD', base, head])))];
  }
  const changed = nameStatusFiles(git(['diff', '--name-status', '-z', '--find-renames', '--diff-filter=ACMRD', 'HEAD']));
  const untracked = nullDelimited(git(['ls-files', '-z', '--others', '--exclude-standard']));
  return [...new Set([...changed, ...untracked])];
}

function matchesPath(file, pattern) {
  const normalized = file.replaceAll('\\', '/');
  const prefix = String(pattern).replaceAll('\\', '/').replace(/\/\*\*$/, '').replace(/\*+$/, '');
  return prefix ? normalized === prefix || normalized.startsWith(`${prefix}/`) : false;
}

function changedAdrFiles(changed, cwd) {
  return changed
    .filter((file) => /^docs\/adr\/[^/]+\.md$/i.test(file.replaceAll('\\', '/')))
    .map((file) => path.resolve(cwd, file))
    .filter((file) => fs.existsSync(file));
}

function dependencyGate(cwd, configPath, input) {
  const gate = path.resolve(scriptDirectory, 'dependency-gates.mjs');
  try {
    const childArgs = [gate, '--config', configPath];
    if (input) childArgs.push('--input', input);
    const stdout = execFileSync(process.execPath, childArgs, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (stdout.trim()) process.stdout.write(stdout);
    return 0;
  } catch (error) {
    if (error.stdout?.trim()) process.stdout.write(error.stdout);
    if (error.stderr?.trim()) process.stderr.write(error.stderr);
    return error.status ?? 2;
  }
}

export function evaluateGovernance({ cwd, configPath, dependencyInput, base, head, ci, invoke } = {}) {
  const profilesDir = path.resolve(scriptDirectory, '..', 'profiles');
  const loaded = loadGovernanceConfig(configPath, { profilesDir });
  if (loaded.errors.length) return { code: 2, errors: loaded.errors };

  const changed = collectChangedFiles({ cwd, base, head, ci, invoke });
  const config = loaded.config;
  const adrRequired = config.checks?.adr_required_for ?? [];
  const architectureFiles = changed.filter((file) => adrRequired.some((pattern) => matchesPath(file, pattern)));
  const architectureChange = architectureFiles.length > 0;
  const errors = [];
  if (architectureChange) {
    const adrs = changedAdrFiles(changed, cwd);
    const coverage = [];
    if (!adrs.length) {
      errors.push('architecture-impacting change requires a changed docs/adr/*.md decision record');
    } else {
      for (const adr of adrs) {
        const adrText = fs.readFileSync(adr, 'utf8');
        const validation = validateAdrDocument(adrText, { requireAccepted: true });
        for (const error of validation) errors.push(`${path.relative(cwd, adr)}: ${error}`);
        const affected = adrAffectedPaths(adrText);
        if (!affected.length) errors.push(`${path.relative(cwd, adr)}: ADR must declare Affected paths`);
        else coverage.push(...affected);
      }
      for (const file of architectureFiles) if (!coverage.some((pattern) => matchesPath(file, pattern))) errors.push(`architecture change is not covered by a changed ADR: ${file}`);
    }
  }
  const dependencyStatus = dependencyGate(cwd, configPath, dependencyInput);
  if (dependencyStatus !== 0) errors.push(`dependency gates failed with exit code ${dependencyStatus}`);
  const deferred = [];
  if (Object.keys(config.checks?.quality ?? {}).length) deferred.push('quality policy is declared; run the project test, lint, and typecheck CI jobs separately');
  if (Object.keys(config.checks?.release ?? {}).length) deferred.push('release policy is declared; enforce it in the release pipeline separately');
  return { code: errors.length ? 1 : 0, errors, deferred, project: config.project.name, profile: config.governance.profile, changed };
}

function usage() {
  return 'Usage: governance check [--config .governance.yml] [--dependency-input report.json] [--base <commit-sha> --head <commit-sha>]';
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'check';
  if (command !== 'check') { console.error(`Unknown command: ${command}`); process.exitCode = 2; return; }
  const validOptions = new Set(['--config', '--dependency-input', '--base', '--head']);
  const seen = new Set();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!validOptions.has(flag) || !value || value.startsWith('--') || seen.has(flag)) {
      console.error(`FAIL ${usage()}`); process.exitCode = 2; return;
    }
    seen.add(flag);
  }
  const root = process.cwd();
  const configValue = option(args, '--config') ?? '.governance.yml';
  const dependencyInput = option(args, '--dependency-input');
  const base = option(args, '--base');
  const head = option(args, '--head');
  if (args.includes('--config') && !configValue) { console.error(`FAIL ${usage()}`); process.exitCode = 2; return; }
  try {
    const result = evaluateGovernance({ cwd: root, configPath: path.resolve(root, configValue), dependencyInput, base, head });
    for (const error of result.errors) console.error(`FAIL ${error}`);
    for (const notice of result.deferred ?? []) console.log(`SKIP ${notice}`);
    if (result.code === 0) console.log(`PASS governance core gates (${result.project}, profile=${result.profile}, changed=${result.changed.length})`);
    process.exitCode = result.code;
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = error.exitCode ?? 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
