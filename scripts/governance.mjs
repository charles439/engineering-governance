#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadGovernanceConfig, parseGovernanceYaml } from './config.mjs';
import * as dependencyGates from './dependency-gates.mjs';
import { scanDependencies } from './governance-scan.mjs';
import { doctor, provision } from './runtime-tools.mjs';
import { validateAdrLifecycle } from './verify-adr-policy.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const profilesDir = path.resolve(scriptDirectory, '..', 'profiles');
const fullSha = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const scannerConfig = /^(?:\.dependency-cruiser(?:\.[cm]?js)?|dependency-cruiser\.(?:json|[cm]?js)|\.importlinter|import-linter\.(?:ini|cfg)|pyproject\.toml|tsconfig(?:\.[^/]+)?\.json)$/i;

function option(args, names) {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index >= 0) return args[index + 1];
  }
  return undefined;
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

function text(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
}

function nullDelimited(value) {
  return text(value).split('\0').filter(Boolean);
}

function nameStatusFiles(value) {
  const tokens = nullDelimited(value);
  const files = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) files.push(tokens[index++], tokens[index++]);
    else files.push(tokens[index++]);
  }
  return files.filter(Boolean).map((file) => file.replaceAll('\\', '/'));
}

function truthy(value) {
  return value !== undefined && value !== null && !/^(?:false|0|no)$/i.test(String(value));
}

/** Exact files under review. CI uses an immutable commit range; local runs use HEAD plus untracked files. */
export function collectChangedFiles({ cwd, base, head, ci = truthy(process.env.CI), invoke } = {}) {
  if ((base && !head) || (!base && head)) throw commandError('--base and --head must be supplied together');
  if (ci && !base) throw commandError('CI requires --base and --head full commit SHAs');
  const git = (args) => runGit(args, cwd, invoke);
  if (base) {
    if (!fullSha.test(base) || !fullSha.test(head)) throw commandError('--base and --head must be full 40- or 64-character commit SHAs');
    git(['cat-file', '-e', `${base}^{commit}`]);
    git(['cat-file', '-e', `${head}^{commit}`]);
    if (base.toLowerCase() === head.toLowerCase()) throw commandError('--base and --head must be distinct commits with base a strict ancestor of head');
    const checkedOutHead = text(git(['rev-parse', 'HEAD'])).trim();
    if (checkedOutHead.toLowerCase() !== head.toLowerCase()) throw commandError('--head must match the checked-out HEAD commit');
    try { git(['merge-base', '--is-ancestor', base, head]); }
    catch { throw commandError('--base must be an ancestor of --head'); }
    return [...new Set(nameStatusFiles(git(['diff', '--name-status', '-z', '--find-renames', '--diff-filter=ACMRD', base, head])))];
  }
  const changed = nameStatusFiles(git(['diff', '--name-status', '-z', '--find-renames', '--diff-filter=ACMRD', 'HEAD']));
  const untracked = nullDelimited(git(['ls-files', '-z', '--others', '--exclude-standard']));
  return [...new Set([...changed, ...untracked])];
}

function normalizePath(file) {
  return String(file).replaceAll('\\', '/').replace(/^\.\//, '');
}

function matchesPath(file, pattern) {
  const normalized = normalizePath(file);
  const prefix = String(pattern).replaceAll('\\', '/').replace(/\/\*\*$/, '').replace(/\*+$/, '');
  return prefix ? normalized === prefix || normalized.startsWith(`${prefix}/`) : false;
}

function isAdrPath(file) { return /^docs\/adr\/[^/]+\.md$/i.test(normalizePath(file)); }

function treeFiles(cwd, revision, invoke) {
  return nullDelimited(runGit(['ls-tree', '-r', '-z', '--name-only', revision], cwd, invoke)).map(normalizePath);
}

function treeText(cwd, revision, file, invoke) {
  try { return text(runGit(['show', `${revision}:${normalizePath(file)}`], cwd, invoke)); }
  catch { return undefined; }
}

function normalizePinPath(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty relative path`);
  const normalized = path.posix.normalize(value.trim().replaceAll('\\', '/'));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) {
    throw new Error(`${label} must stay inside the repository`);
  }
  return normalized;
}

function parseCommittedPin(raw, revision) {
  const label = `${revision} .governance-toolkit.json`;
  let pin;
  try { pin = JSON.parse(raw); }
  catch (error) { throw new Error(`toolkit pin at ${label} is malformed: ${error.message}`); }
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) throw new Error(`toolkit pin at ${label} is malformed: expected an object`);
  if (typeof pin.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pin.repository)) throw new Error(`toolkit pin at ${label} is malformed: repository must be an owner/repository path`);
  if (typeof pin.ref !== 'string' || !fullSha.test(pin.ref)) throw new Error(`toolkit pin at ${label} is malformed: ref must be a full commit SHA`);
  const roots = pin.scan?.roots;
  if (!Array.isArray(roots) || !roots.length) throw new Error(`toolkit pin at ${label} is malformed: scan.roots must be a non-empty array`);
  const normalizedRoots = roots.map((root, index) => {
    if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error(`toolkit pin at ${label} is malformed: scan.roots[${index}] must be an object`);
    if (typeof root.typescript !== 'boolean') throw new Error(`toolkit pin at ${label} is malformed: scan.roots[${index}].typescript must be boolean`);
    return { path: normalizePinPath(root.path, `toolkit pin at ${label} scan.roots[${index}].path`), typescript: root.typescript };
  });
  return { ...pin, ref: pin.ref.toLowerCase(), scan: { ...pin.scan, roots: normalizedRoots } };
}

function committedPin(cwd, revision, invoke) {
  let entry;
  try { entry = nullDelimited(runGit(['ls-tree', '-z', revision, '--', '.governance-toolkit.json'], cwd, invoke)); }
  catch (error) { throw new Error(`toolkit pin at ${revision} is unreadable: ${error.message}`); }
  if (!entry.length) return undefined;
  const match = entry[0].match(/^(\d+)\s+(\w+)\s+[0-9a-f]+\t\.governance-toolkit\.json$/i);
  if (!match || match[2] !== 'blob' || !/^100(?:644|755)$/.test(match[1])) throw new Error(`toolkit pin at ${revision} is unreadable: expected a regular file`);
  let raw;
  try { raw = text(runGit(['show', `${revision}:.governance-toolkit.json`], cwd, invoke)); }
  catch (error) { throw new Error(`toolkit pin at ${revision} is unreadable: ${error.message}`); }
  return parseCommittedPin(raw, revision);
}

function treeDocuments(cwd, revision, invoke) {
  const documents = new Map();
  for (const file of treeFiles(cwd, revision, invoke).filter(isAdrPath)) {
    const value = treeText(cwd, revision, file, invoke);
    if (value !== undefined) documents.set(file, value);
  }
  return documents;
}

function worktreeFiles(root, relative) {
  const target = path.join(root, relative);
  if (!fs.existsSync(target)) return [];
  const result = [];
  const visit = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`.replace(/^\//, '');
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full, name);
      else if (entry.isFile()) result.push(normalizePath(name));
    }
  };
  visit(target, normalizePath(relative));
  return result;
}

function worktreeDocuments(root) {
  const documents = new Map();
  for (const file of worktreeFiles(root, 'docs/adr').filter(isAdrPath)) documents.set(file, fs.readFileSync(path.join(root, file), 'utf8'));
  return documents;
}

function configRelativePath(cwd, configPath) {
  const absolute = path.resolve(cwd, configPath);
  const relative = normalizePath(path.relative(cwd, absolute));
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw commandError('configuration path must be inside the project root');
  return relative;
}

function snapshotConfig(cwd, revision, relative, invoke) {
  const value = treeText(cwd, revision, relative, invoke);
  if (value === undefined) return { config: null, errors: [`missing config at ${revision}: ${relative}`] };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-config-'));
  try {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
    let parsed;
    try { parsed = parseGovernanceYaml(value); } catch { parsed = undefined; }
    const files = treeFiles(cwd, revision, invoke);
    for (const module of parsed?.modules ?? []) {
      const modulePath = typeof module?.path === 'string' ? normalizePath(module.path) : '';
      if (!modulePath) continue;
      const moduleAbsolute = path.resolve(root, modulePath);
      const relativeToRoot = path.relative(root, moduleAbsolute);
      if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) throw new Error(`module path escapes the configuration snapshot: ${module.path}`);
      if (files.some((file) => file.startsWith(`${modulePath}/`))) fs.mkdirSync(path.join(root, modulePath), { recursive: true });
      else if (files.includes(modulePath)) {
        fs.mkdirSync(path.dirname(path.join(root, modulePath)), { recursive: true });
        fs.writeFileSync(path.join(root, modulePath), '');
      }
    }
    return { ...loadGovernanceConfig(target, { profilesDir, projectRoot: root }), root };
  } catch (error) {
    return { config: null, errors: [`invalid config at ${revision}: ${error.message}`], root };
  }
}

function currentConfig(cwd, absolute) { return loadGovernanceConfig(absolute, { profilesDir, projectRoot: cwd }); }

function dependencyPolicy(config) {
  if (typeof dependencyGates.dependencyPolicy === 'function') {
    const value = dependencyGates.dependencyPolicy(config);
    return { ...value, mode: value?.mode ?? 'strict', allowedRules: [...(value?.allowedRules ?? value?.allowed_rules ?? [])] };
  }
  const baseline = config?.baseline ?? {};
  return { mode: baseline.mode ?? 'strict', allowedRules: [...(baseline.allowed_rules ?? [])], required: config?.checks?.architecture?.require_dependency_graph === true };
}

function edgeKey(edge) { return `${String(edge?.from ?? '')}\0${String(edge?.to ?? '')}`; }

function enabledBooleanRules(value, prefix = '') {
  const rules = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return rules;
  for (const [key, child] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (child === true) rules.push(name);
    else if (child && typeof child === 'object' && !Array.isArray(child)) rules.push(...enabledBooleanRules(child, name));
  }
  return rules;
}

function policyWeakening(baseConfig, headConfig, changed) {
  const errors = [];
  if (baseConfig?.governance?.profile !== headConfig?.governance?.profile) errors.push('head governance.profile differs from the trusted base');
  const baseProtected = new Set(baseConfig?.checks?.adr_required_for ?? []);
  const headProtected = new Set(headConfig?.checks?.adr_required_for ?? []);
  for (const pattern of baseProtected) if (!headProtected.has(pattern)) errors.push(`head removes trusted ADR protected path: ${pattern}`);
  for (const rule of enabledBooleanRules(baseConfig?.checks, 'checks')) {
    const parts = rule.split('.');
    let current = headConfig;
    for (const part of parts) current = current?.[part];
    if (current !== true) errors.push(`head weakens enforced policy flag: ${rule}`);
  }
  const baseForbidden = new Set((baseConfig?.checks?.architecture?.forbidden_dependencies ?? baseConfig?.checks?.architecture?.forbiddenDependencies ?? []).map(edgeKey));
  const headForbidden = new Set((headConfig?.checks?.architecture?.forbidden_dependencies ?? headConfig?.checks?.architecture?.forbiddenDependencies ?? []).map(edgeKey));
  for (const edge of baseForbidden) if (!headForbidden.has(edge)) errors.push('head removes a trusted forbidden dependency rule');
  const basePolicy = dependencyPolicy(baseConfig);
  const headPolicy = dependencyPolicy(headConfig);
  if (basePolicy.mode === 'strict' && headPolicy.mode === 'ratchet') errors.push('head cannot change baseline.mode from strict to ratchet');
  const baseAllowed = new Set(basePolicy.allowedRules);
  for (const rule of headPolicy.allowedRules) if (!baseAllowed.has(rule)) errors.push(`head expands baseline.allowed_rules: ${rule}`);
  if (changed.some((file) => scannerConfig.test(path.posix.basename(normalizePath(file))))) errors.push('scanner configuration changes require a trusted-base policy review');
  return errors;
}

function loadJsonInput(cwd, file, label) {
  const target = path.resolve(cwd, file);
  if (!fs.existsSync(target)) throw commandError(`${label} does not exist: ${file}`);
  try {
    const value = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('report must be a JSON object');
    return value;
  } catch (error) { throw commandError(`${label} is invalid: ${error.message}`); }
}

function dependencyEvaluation({ cwd, config, baseConfig, headConfig, dependencyInput, dependencyBaseInput, dependencyReports, dependencyScanError }) {
  const policy = dependencyPolicy(headConfig ?? config);
  const basePolicy = dependencyPolicy(baseConfig ?? config);
  if (dependencyScanError) return { code: 2, errors: [`fresh dependency scan failed: ${dependencyScanError.message}`] };
  if (dependencyReports) {
    if (typeof dependencyGates.evaluateDependencyReports !== 'function') return { code: 2, errors: ['dependency-gates.mjs does not export evaluateDependencyReports'] };
    try {
      const result = dependencyGates.evaluateDependencyReports({
        headReport: dependencyReports.headReport,
        baseReport: policy.mode === 'ratchet' ? dependencyReports.baseReport : undefined,
        policy,
        basePolicy,
        headPolicy: policy,
      });
      const errors = [...(result?.errors ?? [])].map(String);
      const inputErrors = [...(result?.inputErrors ?? result?.input_errors ?? [])].map(String);
      return { ...result, fresh: true, range: dependencyReports.range, code: result?.code ?? (inputErrors.length ? 2 : errors.length ? 1 : 0), errors: [...inputErrors, ...errors] };
    } catch (error) { return { code: 2, errors: [`dependency report evaluation failed: ${error.message}`] }; }
  }
  if (!dependencyInput && !dependencyBaseInput) {
    if (policy.mode === 'ratchet') return { code: 2, errors: ['ratchet dependency policy requires --dependency-input and --dependency-base-input'] };
    return policy.required ? { code: 2, errors: ['dependency graph is required; pass --dependency-input generated by the scanner'] } : { code: 0, errors: [], deferred: ['dependency gates skipped (no generated dependency report supplied)'] };
  }
  if (!dependencyInput) return { code: 2, errors: ['--dependency-input is required when a dependency baseline report is supplied'] };
  if (policy.mode === 'ratchet' && !dependencyBaseInput) return { code: 2, errors: ['ratchet dependency policy requires --dependency-base-input'] };
  if (typeof dependencyGates.evaluateDependencyReports !== 'function') return { code: 2, errors: ['dependency-gates.mjs does not export evaluateDependencyReports'] };
  try {
    const headReport = loadJsonInput(cwd, dependencyInput, 'dependency head report');
    const baseReport = policy.mode === 'ratchet' && dependencyBaseInput ? loadJsonInput(cwd, dependencyBaseInput, 'dependency base report') : undefined;
    const result = dependencyGates.evaluateDependencyReports({ headReport, baseReport, policy });
    const errors = [...(result?.errors ?? [])].map(String);
    const inputErrors = [...(result?.inputErrors ?? result?.input_errors ?? [])].map(String);
    return { ...result, code: result?.code ?? (inputErrors.length ? 2 : errors.length ? 1 : 0), errors: [...inputErrors, ...errors] };
  } catch (error) { return { code: 2, errors: [`dependency report evaluation failed: ${error.message}`] }; }
}

function closeSnapshot(snapshot) { if (snapshot?.root && fs.existsSync(snapshot.root)) fs.rmSync(snapshot.root, { recursive: true, force: true }); }

export function evaluateGovernance({ cwd, configPath = '.governance.yml', dependencyInput, dependencyBaseInput, base, head, ci, invoke, toolDir, scanner, scan = scanDependencies } = {}) {
  const root = path.resolve(cwd ?? process.cwd());
  const absoluteConfig = path.resolve(root, configPath);
  const relativeConfig = configRelativePath(root, absoluteConfig);
  const changed = collectChangedFiles({ cwd: root, base, head, ci, invoke });
  const authoritative = Boolean(base && head);
  const baseSnapshot = snapshotConfig(root, authoritative ? base : 'HEAD', relativeConfig, invoke);
  const headSnapshot = authoritative ? snapshotConfig(root, head, relativeConfig, invoke) : currentConfig(root, absoluteConfig);
  try {
    if (baseSnapshot.errors?.length) return { code: 2, errors: baseSnapshot.errors, changed };
    if (headSnapshot.errors?.length) return { code: 2, errors: headSnapshot.errors, changed };
    const baseConfig = baseSnapshot.config;
    const headConfig = headSnapshot.config;
    const errors = [];
    const deferred = [];
    errors.push(...policyWeakening(baseConfig, headConfig, changed));
    const adrPaths = changed.filter(isAdrPath);
    const headDocuments = authoritative ? treeDocuments(root, head, invoke) : worktreeDocuments(root);
    const baseDocuments = treeDocuments(root, authoritative ? base : 'HEAD', invoke);
    const lifecycle = adrPaths.length ? validateAdrLifecycle(adrPaths, headDocuments, baseDocuments) : { errors: [], coverage: [], acceptedPaths: [] };
    errors.push(...lifecycle.errors);
    const protectedPatterns = [...new Set([
      ...(baseConfig.checks?.adr_required_for ?? []),
      ...(headConfig.checks?.adr_required_for ?? []),
    ])];
    const architectureFiles = changed.filter((file) => protectedPatterns.some((pattern) => matchesPath(file, pattern)));
    if (architectureFiles.length) {
      if (!adrPaths.length) errors.push('architecture-impacting change requires a changed docs/adr/*.md decision record');
      for (const file of architectureFiles) if (!lifecycle.coverage.some((pattern) => matchesPath(file, pattern))) errors.push(`architecture change is not covered by a new or Proposed-to-Accepted ADR: ${file}`);
    }
    let dependencyReports;
    let dependencyScanError;
    const basePolicy = dependencyPolicy(baseConfig);
    const headPolicy = dependencyPolicy(headConfig);
    const manualDependencyInput = Boolean(dependencyInput || dependencyBaseInput);
    let pinError = false;
    let pinInputError = false;
    const pinErrors = [];
    let committedHeadPin;
    if (authoritative) {
      let committedBasePin;
      try { committedBasePin = committedPin(root, base, invoke); }
      catch (error) { pinErrors.push(error.message); pinError = true; pinInputError = true; }
      try { committedHeadPin = committedPin(root, head, invoke); }
      catch (error) { pinErrors.push(error.message); pinError = true; pinInputError = true; }
      if (committedBasePin && !committedHeadPin) {
        pinErrors.push(`toolkit pin is missing at ${head}: .governance-toolkit.json`);
        pinError = true;
      } else if (committedBasePin && committedHeadPin) {
        if (committedBasePin.repository !== committedHeadPin.repository || committedBasePin.ref !== committedHeadPin.ref) {
          pinErrors.push('head toolkit pin identity differs from trusted base toolkit pin');
          pinError = true;
        }
        if (JSON.stringify(committedBasePin.scan) !== JSON.stringify(committedHeadPin.scan)) {
          pinErrors.push('head scan pin differs from trusted base scan pin');
          pinError = true;
        }
      }
    }
    const pinPresent = authoritative ? Boolean(committedHeadPin) : fs.existsSync(path.join(root, '.governance-toolkit.json'));
    const freshScan = !manualDependencyInput && (pinPresent || headPolicy.required || headPolicy.mode === 'ratchet');
    if (authoritative && manualDependencyInput) {
      dependencyScanError = new Error('authoritative governance checks require a fresh dependency scan; --dependency-input and --dependency-base-input are local supplied evidence only');
    } else if (freshScan && !pinError) {
      try {
        dependencyReports = scan({
          cwd: root,
          base: authoritative ? base : undefined,
          head: authoritative ? head : 'HEAD',
          toolDir,
          gitInvoke: invoke,
          checkerInvoke: invoke,
          scanner,
          includeBase: headPolicy.mode === 'ratchet',
        });
      } catch (error) { dependencyScanError = error; }
    }
    const dependency = pinError
      ? { code: pinInputError ? 2 : 1, errors: pinErrors }
      : dependencyEvaluation({ cwd: root, config: headConfig, baseConfig, headConfig, dependencyInput, dependencyBaseInput, dependencyReports, dependencyScanError });
    errors.push(...dependency.errors);
    deferred.push(...(dependency.deferred ?? []));
    const code = errors.length ? (dependency.code === 2 ? 2 : 1) : (dependency.code ?? 0);
    if (Object.keys(headConfig.checks?.quality ?? {}).length) deferred.push('quality policy is declared; run the project test, lint, and typecheck CI jobs separately');
    if (Object.keys(headConfig.checks?.release ?? {}).length) deferred.push('release policy is declared; enforce it in the release pipeline separately');
    return { code, errors, deferred, project: headConfig.project.name, profile: headConfig.governance.profile, changed, base, head, authoritative, dependency };
  } finally {
    closeSnapshot(baseSnapshot);
    closeSnapshot(headSnapshot);
  }
}

function usage() {
  return 'Usage: governance check [--config .governance.yml] [--dependency-input <head-report>] [--dependency-base-input <base-report>] [--tool-dir <dir>] [--base <full-sha> --head <full-sha>] | governance doctor [--tool-dir <dir>] [--tool <typescript|contract|python>] [--executable <path>] [--python-executable <path>] | governance provision --tool <typescript|contract> --target <directory> | governance git <acquire|status|verify|release|recover-expired> [options]';
}

function parseOptions(args, validOptions) {
  const seen = new Set();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!validOptions.has(flag) || !value || value.startsWith('--') || seen.has(flag)) throw commandError(`FAIL ${usage()}`);
    seen.add(flag);
  }
}

function printRuntimeResult(command, result) {
  for (const error of result.errors ?? []) console.error(`FAIL ${error}`);
  for (const hint of result.hints ?? []) console.log(`HINT ${hint}`);
  for (const check of result.checks ?? []) console.log(`${check.status} ${check.name}${check.version ? ` ${check.version}` : ''}`);
  if (result.target) console.log(`PASS provision target=${result.target}`);
  else if (!result.errors?.length) console.log(`PASS ${command}`);
  return result.code ?? (result.errors?.length ? 2 : 0);
}

function printDependencyEvidence(dependency) {
  const report = dependency?.headReport;
  if (!report) return;
  const metadata = report.metadata ?? report.meta ?? {};
  const modules = metadata.moduleCount ?? report.modules?.length ?? report.nodes?.length ?? 0;
  const edges = metadata.edgeCount ?? report.modules?.reduce((count, module) => count + (Array.isArray(module?.dependencies) ? module.dependencies.length : 0), 0) ?? report.edges?.length ?? 0;
  const scanner = metadata.scannerVersion ?? metadata.toolVersion ?? report.provenance?.scannerVersion ?? 'unverified';
  const range = dependency.range?.base && dependency.range?.head
    ? `, base=${dependency.range.base}, head=${dependency.range.head}`
    : '';
  console.log(`INFO dependency evidence (mode=${dependency.mode ?? 'strict'}, modules=${modules}, edges=${edges}, scanner=${scanner}${range})`);
  for (const identity of dependency.grandfathered ?? []) console.log(`INFO grandfathered dependency violation: ${String(identity).replaceAll('\0', ' -> ')}`);
}

function runGitCustody(args) {
  const result = spawnSync(process.execPath, [path.join(scriptDirectory, 'git-custody.mjs'), ...args], {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 2;
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'check';
  try {
    if (command === 'git') {
      runGitCustody(args.slice(1));
      return;
    }
    if (args.includes('--help') || args.includes('-h')) {
      console.log(usage());
      process.exitCode = 0;
      return;
    }
    if (command === 'check') {
      if (args.includes('--toolkit-dev') && (args.includes('--base') || args.includes('--head'))) throw commandError('--toolkit-dev cannot be combined with an authoritative --base/--head range.');
      parseOptions(args, new Set(['--config', '--dependency-input', '--dependency-base-input', '--tool-dir', '--base', '--head']));
      const dependencyInput = option(args, ['--dependency-input']);
      const dependencyBaseInput = option(args, ['--dependency-base-input']);
      const result = evaluateGovernance({ cwd: process.cwd(), configPath: option(args, ['--config']) ?? '.governance.yml', dependencyInput, dependencyBaseInput, toolDir: option(args, ['--tool-dir']), base: option(args, ['--base']), head: option(args, ['--head']) });
      for (const error of result.errors) console.error(`FAIL ${error}`);
      for (const notice of result.deferred ?? []) console.log(`SKIP ${notice}`);
      printDependencyEvidence(result.dependency);
      if (result.code === 0) console.log(`PASS governance core gates (${result.project}, profile=${result.profile}, changed=${result.changed.length}${result.authoritative ? `, base=${result.base}, head=${result.head}` : ', local diagnostic'})`);
      process.exitCode = result.code;
      return;
    }
    if (command === 'doctor') {
      parseOptions(args, new Set(['--tool-dir', '--tool', '--executable', '--python-executable']));
      const result = doctor({ toolkitRoot: path.resolve(scriptDirectory, '..'), toolDir: option(args, ['--tool-dir']), tool: option(args, ['--tool']), executable: option(args, ['--executable']), pythonExecutable: option(args, ['--python-executable']), projectRoot: process.cwd() });
      process.exitCode = printRuntimeResult('doctor', result);
      return;
    }
    if (command === 'provision') {
      parseOptions(args, new Set(['--tool', '--target']));
      const result = provision({ toolkitRoot: path.resolve(scriptDirectory, '..'), tool: option(args, ['--tool']), target: option(args, ['--target']), projectRoot: process.cwd() });
      process.exitCode = printRuntimeResult('provision', result);
      return;
    }
    throw commandError(`Unknown command: ${command}`);
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = error.exitCode ?? 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
