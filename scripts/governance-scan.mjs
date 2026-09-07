import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { doctor, resolveToolDir } from './runtime-tools.mjs';

const toolkitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fullSha = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

function text(value) { return Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? ''); }

function commandError(message) {
  const error = new Error(message);
  error.code = 2;
  return error;
}

function run(command, args, cwd, invoke = spawnSync, options = {}) {
  let result;
  try {
    result = invoke(command, args, {
      cwd,
      encoding: options.encoding ?? 'buffer',
      shell: false,
      windowsHide: true,
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout ?? 120000,
      maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
    });
  } catch (error) {
    const detail = text(error.stderr).trim() || error.message;
    throw commandError(`${command} ${args.join(' ')} failed: ${detail}`);
  }
  // The scanner accepts both the child_process spawn-style seam used by tests
  // and simple synchronous seams used by callers. Normalize both here so git
  // and checker invocations cannot accidentally disagree about the protocol.
  if (result && typeof result === 'object' && ('status' in result || 'stdout' in result || 'error' in result)) {
    if (result.error || result.status !== 0) {
      const detail = text(result.stderr).trim() || result.error?.message || `exit ${result.status ?? 'signal'}`;
      throw commandError(`${command} ${args.join(' ')} failed: ${detail}`);
    }
    return result.stdout ?? (options.encoding === 'utf8' ? '' : Buffer.alloc(0));
  }
  return result;
}

function normalizeRelative(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw commandError(`${label} must be a non-empty relative path`);
  const normalized = path.posix.normalize(value.trim().replaceAll('\\', '/'));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) {
    throw commandError(`${label} must stay inside the repository`);
  }
  return normalized;
}

function validatePin(pin, label = 'toolkit pin') {
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) throw commandError(`${label} must be a JSON object`);
  if (typeof pin.repository !== 'string' || !pin.repository.trim()) throw commandError(`${label}.repository is required`);
  if (typeof pin.ref !== 'string' || !fullSha.test(pin.ref)) throw commandError(`${label}.ref must be a full commit SHA`);
  const roots = pin.scan?.roots;
  if (!Array.isArray(roots) || !roots.length) throw commandError(`${label}.scan.roots must be a non-empty array`);
  const normalizedRoots = roots.map((root, index) => {
    if (!root || typeof root !== 'object' || Array.isArray(root)) throw commandError(`${label}.scan.roots[${index}] must be an object`);
    if (typeof root.typescript !== 'boolean') throw commandError(`${label}.scan.roots[${index}].typescript must be boolean`);
    return { path: normalizeRelative(root.path, `${label}.scan.roots[${index}].path`), typescript: root.typescript };
  });
  return { ...pin, ref: pin.ref.toLowerCase(), scan: { ...pin.scan, roots: normalizedRoots } };
}

function readPin({ cwd, revision, invoke = spawnSync }) {
  let raw;
  if (revision === undefined || revision === null) {
    const file = path.join(cwd, '.governance-toolkit.json');
    if (!fs.existsSync(file)) return undefined;
    raw = fs.readFileSync(file, 'utf8');
  } else {
    try { raw = text(run('git', ['show', `${revision}:.governance-toolkit.json`], cwd, invoke)); }
    catch { return undefined; }
  }
  try { return validatePin(JSON.parse(raw), `${revision ?? 'working tree'} .governance-toolkit.json`); }
  catch (error) { throw commandError(`invalid .governance-toolkit.json: ${error.message}`); }
}

function treeText(cwd, revision, relative, invoke) {
  return text(run('git', ['show', `${revision}:${relative}`], cwd, invoke));
}

function materializeRevision({ cwd, revision, invoke = spawnSync }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-scan-'));
  const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-archive-'));
  const archive = path.join(archiveRoot, 'source.tar');
  try {
    assertArchiveSafe({ cwd, revision, invoke });
    const bytes = run('git', ['archive', '--format=tar', revision], cwd, invoke, { maxBuffer: 128 * 1024 * 1024 });
    fs.writeFileSync(archive, bytes);
    run('tar', ['-xf', archive, '-C', root], root, invoke, { encoding: 'utf8' });
    fs.rmSync(archive, { force: true });
    rejectSymlinks(root);
    return root;
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
}

function assertArchiveSafe({ cwd, revision, invoke }) {
  const entries = text(run('git', ['ls-tree', '-r', '-z', '--full-tree', revision], cwd, invoke));
  for (const record of entries.split('\0').filter(Boolean)) {
    const match = record.match(/^([0-9]+)\s+(\w+)\s+[0-9a-f]+\t(.*)$/i);
    if (!match) throw commandError(`could not inspect Git tree entry for ${revision}`);
    const [, mode, type, relative] = match;
    if (mode === '120000') throw commandError(`source snapshot contains a symlink: ${relative}`);
    if (mode === '160000' || type === 'commit') throw commandError(`source snapshot contains a Git submodule: ${relative}`);
  }
}

function materializeWorkingTree({ cwd, invoke }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-scan-worktree-'));
  try {
    const files = text(run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd, invoke)).split('\0').filter(Boolean);
    for (const relative of files) {
      const segments = relative.replaceAll('\\', '/').split('/');
      if (segments.some((segment) => ['.git', 'node_modules', '.venv', '__pycache__'].includes(segment))) continue;
      const source = path.join(cwd, relative);
      if (!fs.existsSync(source, { throwIfNoEntry: false })) continue;
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink()) throw commandError(`source working tree contains a symlink: ${relative}`);
      if (!stat.isFile()) continue;
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    return root;
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function rejectSymlinks(root, ignored = new Set()) {
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (current === root && ignored.has(entry.name)) continue;
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw commandError(`source snapshot contains a symlink: ${path.relative(root, target)}`);
      if (entry.isDirectory()) visit(target);
    }
  };
  visit(root);
}

function hashFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function rootsForSnapshot(root, roots) {
  const files = [];
  for (const item of roots) {
    const relative = item.path;
    const target = path.join(root, relative);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw commandError(`scan root does not exist in snapshot: ${relative}`);
    const before = files.length;
    const visit = (current, prefix) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const next = path.join(current, entry.name);
        const name = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) visit(next, name);
        else if (entry.isFile() && (!item.typescript || /\.(?:ts|tsx)$/i.test(entry.name))) files.push(name.replaceAll('\\', '/'));
      }
    };
    visit(target, relative);
    if (files.length === before) throw commandError(`scan root has no ${item.typescript ? 'TypeScript' : 'source'} modules: ${relative}`);
  }
  if (!files.length) throw commandError('scan roots contain zero source modules');
  return files;
}

function scannerConfig(root, configured) {
  const relative = normalizeRelative(configured ?? '.dependency-cruiser.cjs', 'scanner config');
  const file = path.join(root, relative);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw commandError(`scanner config is missing from snapshot: ${relative}`);
  return { file, relative, hash: hashFile(file) };
}

function dependencyCruiserExecutable(toolDir, projectRoot, invoke) {
  const result = doctor({ toolkitRoot, toolDir, tool: 'typescript', projectRoot, invoke });
  if (result.code !== 0) throw commandError(`dependency-cruiser runtime is unavailable: ${result.errors.join('; ')}`);
  const check = result.checks.find((item) => item.name === 'typescript' && item.status === 'PASS');
  if (!check?.executable) throw commandError('doctor did not return a dependency-cruiser executable');
  return { executable: check.executable, version: check.version, companion: check.companion?.version };
}

function invokeScanner({ executable, config, roots, cwd, invoke }) {
  const args = [executable, '--output-type', 'json', '--output-to', '-', '--validate', config, ...roots];
  let result;
  try {
    result = invoke(process.execPath, args, { cwd, encoding: 'utf8', shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 128 * 1024 * 1024 });
  } catch (error) {
    throw commandError(`dependency-cruiser execution failed: ${error.message}`);
  }
  if (!(result && typeof result === 'object' && ('status' in result || 'stdout' in result || 'error' in result))) result = { status: 0, stdout: result, stderr: '' };
  if (result.error || ![0, 1].includes(result.status)) throw commandError(`dependency-cruiser execution failed: ${text(result.stderr).trim() || `exit ${result.status ?? 'signal'}`}`);
  let report;
  try { report = JSON.parse(text(result.stdout)); }
  catch (error) { throw commandError(`dependency-cruiser returned malformed JSON: ${error.message}`); }
  if (!Array.isArray(report.modules) || !report.modules.length) throw commandError('dependency-cruiser report contains zero modules');
  if (result.status === 1 && !hasExplainableViolation(report)) {
    throw commandError('dependency-cruiser exited 1 without a report violation that matches the dependency graph');
  }
  return { report, status: result.status };
}

function dependencyEdges(report) {
  const edges = new Set();
  for (const module of report.modules ?? []) {
    if (!module || typeof module.source !== 'string') continue;
    for (const dependency of module.dependencies ?? []) {
      const resolved = typeof dependency === 'string'
        ? dependency
        : dependency?.resolved ?? dependency?.module ?? dependency?.source;
      if (typeof resolved === 'string' && resolved.trim()) edges.add(`${normalizeReportSource(module.source)}\0${normalizeReportSource(resolved)}`);
    }
  }
  return edges;
}

function hasPath(edges, from, to) {
  const adjacency = new Map();
  for (const key of edges) {
    const [source, target] = key.split('\0');
    if (!adjacency.has(source)) adjacency.set(source, []);
    adjacency.get(source).push(target);
  }
  const queue = [from];
  const visited = new Set([from]);
  while (queue.length) {
    const current = queue.shift();
    if (current === to) return true;
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
  }
  return false;
}

function hasExplainableViolation(report) {
  const violations = Array.isArray(report.summary?.violations) ? report.summary.violations : report.violations;
  if (!Array.isArray(violations) || !violations.length) return false;
  const edges = dependencyEdges(report);
  for (const violation of violations) {
    if (!violation || typeof violation !== 'object') continue;
    const rule = typeof violation.rule === 'string' ? violation.rule : violation.rule?.name;
    const from = typeof violation.from === 'string' ? normalizeReportSource(violation.from) : undefined;
    const to = typeof violation.to === 'string' ? normalizeReportSource(violation.to) : undefined;
    const circular = violation.type === 'cycle' || /circular/i.test(String(rule ?? ''));
    if (circular && from && to && edges.has(`${from}\0${to}`) && hasPath(edges, to, from)) return true;
    if (from && to && edges.has(`${from}\0${to}`)) return true;
    if (circular && Array.isArray(violation.cycle) && violation.cycle.length > 1) {
      const cycle = violation.cycle.map((item) => normalizeReportSource(item?.name ?? item?.source ?? item)).filter(Boolean);
      if (cycle.length > 1 && cycle.every((source, index) => {
        const target = cycle[(index + 1) % cycle.length];
        return edges.has(`${source}\0${target}`);
      })) return true;
    }
  }
  return false;
}

function normalizeReportSource(value) {
  const source = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  return path.posix.normalize(source);
}

function validateReportRoots(report, roots) {
  const modules = report.modules;
  for (const item of roots) {
    const prefix = item.path.endsWith('/') ? item.path : `${item.path}/`;
    const matches = modules.filter((module) => {
      const source = normalizeReportSource(module?.source);
      if (!(source === item.path || source.startsWith(prefix))) return false;
      return !item.typescript || /\.(?:ts|tsx)$/i.test(source);
    });
    if (!matches.length) throw commandError(`dependency-cruiser report has no ${item.typescript ? 'TypeScript' : 'source'} modules for scan root: ${item.path}`);
  }
}

function dependencyManifestFingerprint({ cwd, revision, invoke }) {
  const files = text(run('git', ['ls-tree', '-r', '--name-only', '-z', revision], cwd, invoke)).split('\0').filter(Boolean)
    .filter((file) => /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(file));
  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) {
    const raw = text(run('git', ['show', `${revision}:${file}`], cwd, invoke));
    let content = raw;
    if (path.posix.basename(file).toLowerCase() === 'package.json') {
      try {
        const parsed = JSON.parse(raw);
        const fields = [
          'name', 'version', 'private', 'workspaces', 'dependencies', 'devDependencies',
          'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta',
          'bundledDependencies', 'bundleDependencies', 'overrides', 'resolutions',
          'pnpm', 'packageManager',
        ];
        content = JSON.stringify(Object.fromEntries(fields.filter((field) => Object.hasOwn(parsed, field)).sort().map((field) => [field, parsed[field]])));
      } catch {
        content = raw;
      }
    }
    hash.update(file).update('\0').update(content).update('\0');
  }
  return { files, hash: hash.digest('hex') };
}

function enrichReport(report, evidence) {
  const modules = Array.isArray(report.modules) ? report.modules.length : 0;
  const edges = Array.isArray(report.modules) ? report.modules.reduce((count, module) => count + (Array.isArray(module.dependencies) ? module.dependencies.length : 0), 0) : 0;
  return {
    ...report,
    metadata: {
      ...(report.metadata ?? {}),
      scannerVersion: evidence.scannerVersion,
      toolVersion: evidence.scannerVersion,
      configurationHash: evidence.configurationHash,
      revision: evidence.revision,
      range: evidence.range,
      roots: evidence.roots,
      moduleCount: modules,
      edgeCount: edges,
    },
    provenance: {
      ...(report.provenance ?? {}),
      scannerVersion: evidence.scannerVersion,
      toolVersion: evidence.scannerVersion,
      configurationHash: evidence.configurationHash,
    },
  };
}

function scanRevision({ cwd, revision, pin, configPin = pin, toolDir, range, gitInvoke, checkerInvoke, scanner, workingTree = false }) {
  const root = workingTree ? materializeWorkingTree({ cwd, invoke: gitInvoke }) : materializeRevision({ cwd, revision, invoke: gitInvoke });
  try {
    const roots = rootsForSnapshot(root, pin.scan.roots);
    const config = scannerConfig(root, configPin.scan.config);
    const runtime = dependencyCruiserExecutable(toolDir, root, checkerInvoke);
    const result = scanner
      ? scanner({ executable: runtime.executable, version: runtime.version, companion: runtime.companion, config: config.file, roots: pin.scan.roots.map((item) => item.path), cwd: root, revision, range })
      : invokeScanner({ executable: runtime.executable, config: config.file, roots: pin.scan.roots.map((item) => item.path), cwd: root, invoke: checkerInvoke });
    if (!result || !result.report || !Array.isArray(result.report.modules) || !result.report.modules.length) throw commandError('dependency-cruiser report contains zero modules');
    validateReportRoots(result.report, pin.scan.roots);
    return enrichReport(result.report, {
      scannerVersion: runtime.version,
      configurationHash: config.hash,
      revision,
      range,
      roots: pin.scan.roots,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Generate fresh dependency-cruiser reports from immutable Git snapshots. */
export function scanDependencies({ cwd = process.cwd(), base, head = 'HEAD', toolDir = process.env.GOVERNANCE_TOOL_DIR, invoke, gitInvoke = invoke ?? spawnSync, checkerInvoke = spawnSync, scanner, includeBase = true } = {}) {
  const root = path.resolve(cwd);
  let resolvedToolDir;
  try { resolvedToolDir = resolveToolDir({ toolkitRoot, toolDir, projectRoot: root, tool: 'typescript' }); }
  catch (error) { throw commandError(`fresh dependency scan cannot resolve its isolated runtime: ${error.message}`); }
  if (!resolvedToolDir) throw commandError('fresh dependency scan requires --tool-dir, GOVERNANCE_TOOL_DIR, or GOVERNANCE_HOME; no package is downloaded');
  if (base && (!fullSha.test(base) || !fullSha.test(head))) throw commandError('scan base/head must be full commit SHAs');
  const local = !base && (head === undefined || head === null || head === 'HEAD');
  const headPin = readPin({ cwd: root, revision: local ? undefined : head, invoke: gitInvoke });
  if (!headPin) throw commandError('fresh dependency scan requires .governance-toolkit.json with scan.roots');
  const basePin = base ? readPin({ cwd: root, revision: base, invoke: gitInvoke }) : undefined;
  const trustedPin = basePin ?? headPin;
  if (basePin && (basePin.repository !== headPin.repository || basePin.ref !== headPin.ref)) {
    throw commandError('head toolkit pin identity differs from trusted base toolkit pin');
  }
  if (basePin && JSON.stringify(basePin.scan) !== JSON.stringify(headPin.scan)) throw commandError('head scan pin differs from trusted base scan pin');
  if (base && includeBase) {
    const baseDependencies = dependencyManifestFingerprint({ cwd: root, revision: base, invoke: gitInvoke });
    const headDependencies = dependencyManifestFingerprint({ cwd: root, revision: head, invoke: gitInvoke });
    if (baseDependencies.hash !== headDependencies.hash) throw commandError('authoritative dependency scan requires matching package manifests and lockfiles in base/head; provision the corresponding isolated runtime for the changed dependency set');
  }
  const range = base ? { base, head } : { head, authoritative: false };
  const headReport = scanRevision({ cwd: root, revision: head, pin: trustedPin, configPin: headPin, toolDir: resolvedToolDir, range, gitInvoke, checkerInvoke, scanner, workingTree: local });
  const baseReport = base && includeBase
    ? scanRevision({ cwd: root, revision: base, pin: trustedPin, configPin: basePin ?? trustedPin, toolDir: resolvedToolDir, range, gitInvoke, checkerInvoke, scanner })
    : undefined;
  return { headReport, baseReport, range, roots: trustedPin.scan.roots, firstAdoption: Boolean(base && !basePin) };
}
