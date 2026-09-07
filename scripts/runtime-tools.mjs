import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadGovernanceConfig } from './config.mjs';

const defaultToolkit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pythonHelp = 'Python provisioning is unsupported. Create an explicit isolated governance runtime outside the project, install the pinned import-linter there, then pass --python-executable <absolute lint-imports path>. Never use the application .venv or arbitrary Python from PATH.';

export function loadRuntimeProfiles(toolkitRoot = defaultToolkit) {
  const tools = {};
  let current;
  for (const line of fs.readFileSync(path.join(toolkitRoot, 'profiles/tool-versions.yml'), 'utf8').split(/\r?\n/)) {
    const group = line.match(/^  ([a-z]+):\s*$/);
    const field = line.match(/^    ([a-z_]+):\s*(.*?)\s*$/);
    if (group) { current = group[1]; tools[current] = {}; }
    else if (current && field) tools[current][field[1]] = field[2].replace(/^['"]|['"]$/g, '');
  }
  for (const name of ['typescript', 'contract', 'python']) {
    if (!tools[name]?.package || !tools[name]?.version || !tools[name]?.executable) throw new Error(`Invalid tool profile: ${name}`);
  }
  return tools;
}

function safeOutput(value) {
  return String(value || '')
    .replace(/(token|password|passwd|secret|authorization|npm_config_[a-z0-9_]+)\s*[=:]\s*[^\s,;]+/giu, '$1=[redacted]')
    .slice(0, 1000);
}

function run(command, args, cwd, invoke = spawnSync) {
  const result = invoke(command, args, { cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || safeOutput(result.stderr) || `exit ${result.status ?? 'signal'}`;
    throw new Error(`${command}: ${detail}`);
  }
  return `${result.stdout || ''}${result.stderr || ''}`.trim();
}

function execute(file, args, cwd, invoke) {
  return /\.[cm]?js$/i.test(file) ? run(process.execPath, [file, ...args], cwd, invoke) : run(file, args, cwd, invoke);
}

function executeNode(file, args, cwd, invoke) {
  return run(process.execPath, [file, ...args], cwd, invoke);
}

function packageInfo(toolDir, name, boundary) {
  const root = outsideSourcePath(path.join(toolDir, 'node_modules', ...name.split('/')), { ...boundary, label: 'Tool package' });
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (metadata.name !== name) throw new Error(`Unexpected package identity at ${root}`);
  return { root, metadata };
}

function packageBin(info, name, boundary) {
  const value = typeof info.metadata.bin === 'string' ? info.metadata.bin : info.metadata.bin?.[name];
  if (!value) throw new Error(`Missing ${name} executable in ${info.root}`);
  const bin = path.resolve(info.root, value);
  let canonicalRoot;
  try {
    canonicalRoot = actualPath(info.root);
  } catch { throw new Error(`Invalid package executable: ${bin}`); }
  const canonicalBin = outsideSourcePath(bin, { ...boundary, label: 'Tool executable' });
  if (!fs.existsSync(bin) || !inside(canonicalBin, canonicalRoot)) throw new Error(`Invalid package executable: ${bin}`);
  return canonicalBin;
}

function inside(target, root) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function actualPath(value, base = process.cwd()) {
  const resolved = path.resolve(base, value);
  if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
  return path.join(actualPath(path.dirname(resolved)), path.basename(resolved));
}

function outsideSourcePath(value, { base = process.cwd(), projectRoot, toolkitRoot, label = 'Tool path' } = {}) {
  const target = actualPath(value, base);
  for (const source of [projectRoot, toolkitRoot]) {
    const canonicalSource = actualPath(source);
    if (inside(target, canonicalSource)) throw new Error(`${label} must be outside source repository: ${source}`);
  }
  return target;
}

function hasVersion(output, version) {
  return new RegExp(`(?:^|[^0-9.])${version.replaceAll('.', '\\.')}($|[^0-9.])`).test(output);
}

function hasTypeScriptVersion(output, version) {
  const escaped = version.replaceAll('.', '\\.');
  return new RegExp(`\\btypescript(?:@|\\s+)${escaped}\\b`, 'i').test(output);
}

function failure(message, hints = []) {
  return { code: 2, checks: [], errors: [message], hints };
}

export function governanceHome(env = process.env) {
  return env.GOVERNANCE_HOME || (process.platform === 'win32'
    ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'engineering-governance')
    : path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'engineering-governance'));
}

/** Resolve an already provisioned runtime without installing or touching it. */
export function resolveToolDir({ toolkitRoot = defaultToolkit, toolDir = process.env.GOVERNANCE_TOOL_DIR, projectRoot = process.cwd(), tool = 'typescript', env = process.env } = {}) {
  if (toolDir) return outsideSourcePath(toolDir, { base: projectRoot, projectRoot, toolkitRoot, label: 'Tool directory' });
  const home = governanceHome(env);
  if (tool === 'python') return undefined;
  const profiles = loadRuntimeProfiles(toolkitRoot);
  const profile = profiles[tool];
  if (!profile) return undefined;
  const runtimeName = tool === 'typescript'
    ? `node-depcruise-${profile.version}-ts-${profile.typescript_companion}`
    : `node-spectral-${profile.version}`;
  return outsideSourcePath(path.resolve(home, 'environments', runtimeName), { projectRoot, toolkitRoot, label: 'Tool directory' });
}

/** Inspect only existing runtimes. No package managers or implicit downloads. */
export function doctor({ toolkitRoot = defaultToolkit, toolDir = process.env.GOVERNANCE_TOOL_DIR, tool, executable, pythonExecutable = process.env.GOVERNANCE_PY_EXECUTABLE, projectRoot = process.cwd(), invoke = spawnSync } = {}) {
  const checks = [];
  const errors = [];
  const hints = [];
  let resolvedToolDir;
  try { resolvedToolDir = resolveToolDir({ toolkitRoot, toolDir, projectRoot, tool: tool ?? 'typescript' }); }
  catch (error) { return failure(`Could not resolve the isolated tool directory: ${error.message}`); }
  const inspect = (name, fn, required = true) => {
    try { const evidence = fn(); checks.push({ name, status: 'PASS', ...evidence }); }
    catch (error) { checks.push({ name, status: required ? 'FAIL' : 'OPTIONAL', detail: error.message }); if (required) errors.push(`${name}: ${error.message}`); }
  };
  inspect('node', () => ({ executable: process.execPath, version: run(process.execPath, ['--version'], projectRoot, invoke) }));
  inspect('git', () => ({ executable: 'git', version: run('git', ['--version'], projectRoot, invoke) }));
  for (const optional of ['uv', 'docker']) inspect(optional, () => ({ executable: optional, version: run(optional, ['--version'], projectRoot, invoke) }), false);
  inspect('configuration', () => {
    const configPath = path.join(projectRoot, '.governance.yml');
    if (!fs.existsSync(configPath)) throw new Error(`missing config: ${configPath}`);
    const loaded = loadGovernanceConfig(configPath, {
      profilesDir: path.join(toolkitRoot, 'profiles'),
      projectRoot,
    });
    if (loaded.errors.length) throw new Error(loaded.errors.join('; '));
    return { path: configPath, project: loaded.config.project.name };
  });
  let profiles;
  try { profiles = loadRuntimeProfiles(toolkitRoot); }
  catch (error) { return failure(`Invalid runtime profiles: ${error.message}`); }
  if (tool && !Object.hasOwn(profiles, tool)) return failure(`Unsupported tool: ${tool}`);
  const installed = resolvedToolDir
    ? ['typescript', 'contract'].filter((name) => fs.existsSync(path.join(resolvedToolDir, 'node_modules', ...profiles[name].package.split('/'))))
    : [];
  const selected = tool ? [tool] : resolvedToolDir ? (installed.length ? installed : ['typescript', 'contract']) : [];
  if (pythonExecutable && !selected.includes('python')) selected.push('python');
  for (const name of selected) inspect(name, () => {
    const profile = profiles[name];
    if (name === 'python') {
      const file = executable && tool === 'python' ? executable : pythonExecutable;
      if (!file || !path.isAbsolute(file)) throw new Error(pythonHelp);
      const isolatedFile = outsideSourcePath(file, { base: projectRoot, projectRoot, toolkitRoot, label: 'Python executable' });
      if (!fs.existsSync(isolatedFile)) throw new Error(`Python executable does not exist: ${file}`);
      const version = execute(isolatedFile, ['--version'], projectRoot, invoke);
      if (!hasVersion(version, profile.version)) throw new Error(`Expected ${profile.package}@${profile.version}; actual ${version}`);
      return { executable: isolatedFile, version, expected: profile.version };
    }
    if (!resolvedToolDir) throw new Error('Specify --tool-dir for the isolated installation so package and companion metadata can be verified.');
    const boundary = { base: projectRoot, projectRoot, toolkitRoot };
    const info = packageInfo(resolvedToolDir, profile.package, boundary);
    if (info.metadata.version !== profile.version) throw new Error(`Expected ${profile.package}@${profile.version}; metadata reports ${info.metadata.version}`);
    const file = executable && tool === name
      ? outsideSourcePath(executable, { base: projectRoot, projectRoot, toolkitRoot, label: 'Tool executable' })
      : packageBin(info, profile.executable, boundary);
    if (!fs.existsSync(file)) throw new Error(`Tool executable does not exist: ${file}`);
    const version = executable && tool === name
      ? execute(file, ['--version'], projectRoot, invoke)
      : executeNode(file, ['--version'], projectRoot, invoke);
    if (!hasVersion(version, profile.version)) throw new Error(`Expected ${profile.package}@${profile.version}; executable reports ${version}`);
    const evidence = { executable: file, version, package: profile.package, expected: profile.version };
    if (name === 'typescript') {
      const companion = packageInfo(resolvedToolDir, profile.typescript_companion_package, boundary);
      if (companion.metadata.version !== profile.typescript_companion) throw new Error(`TypeScript companion must be ${profile.typescript_companion}; actual ${companion.metadata.version}`);
      const companionExecutable = packageBin(companion, 'tsc', boundary);
      const companionVersion = executeNode(companionExecutable, ['--version'], projectRoot, invoke);
      if (!hasVersion(companionVersion, profile.typescript_companion)) throw new Error(`TypeScript companion executable reports ${companionVersion}`);
      evidence.companion = { executable: companionExecutable, version: companionVersion, expected: profile.typescript_companion };
      evidence.info = executable && tool === name
        ? execute(file, ['--info'], projectRoot, invoke)
        : executeNode(file, ['--info'], projectRoot, invoke);
      if (!hasTypeScriptVersion(evidence.info, profile.typescript_companion)) throw new Error('dependency-cruiser --info does not prove the pinned TypeScript companion is available');
    }
    return evidence;
  });
  if (!selected.length) hints.push('No checker selected. Use doctor --tool typescript|contract --tool-dir <isolated directory> to verify checker and companion versions.');
  return { code: errors.length ? 2 : 0, checks, errors, hints };
}

function npmCli() {
  const runtimeDirectory = path.dirname(process.execPath);
  const candidates = [path.join(runtimeDirectory, 'node_modules/npm/bin/npm-cli.js'), path.resolve(runtimeDirectory, '../lib/node_modules/npm/bin/npm-cli.js')];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('npm-cli.js was not found beside this Node runtime. Install a Node distribution containing npm; no PATH npm shell shim will be executed.');
  return found;
}

/** Explicit installation into a dedicated, caller-selected directory outside source repositories. */
export function provision({ toolkitRoot = defaultToolkit, tool, target, projectRoot = process.cwd(), invoke = spawnSync, npmPath } = {}) {
  if (tool === 'python') return failure(pythonHelp);
  if (!['typescript', 'contract'].includes(tool)) return failure('provision requires --tool typescript|contract');
  if (!target) return failure('provision requires an explicit --target outside the project repository');
  let destination;
  try { destination = actualPath(target, projectRoot); }
  catch (error) { return failure(`Invalid tool target: ${error.message}`); }
  for (const source of [projectRoot, toolkitRoot]) if (inside(destination, actualPath(source))) return failure(`Tool target must be outside source repository: ${source}`);
  let profile;
  try { profile = loadRuntimeProfiles(toolkitRoot)[tool]; }
  catch (error) { return failure(`Invalid runtime profiles: ${error.message}`); }
  const dependencies = { [profile.package]: profile.version };
  if (tool === 'typescript') dependencies[profile.typescript_companion_package] = profile.typescript_companion;
  const invalidDependency = Object.entries(dependencies).find(([name, version]) => !/^(?:@[a-z0-9_-]+\/[a-z0-9_-]+)?[a-z0-9_-]+$/i.test(name) || !/^\d+\.\d+\.\d+$/.test(version));
  if (invalidDependency) return failure(`Installation requires an exact pinned Node package: ${invalidDependency[0]}@${invalidDependency[1]}`);
  for (const [name, version] of Object.entries(dependencies)) {
    if (!/^(?:@[a-z0-9_-]+\/)?[a-z0-9_-]+$/i.test(name) || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Installation requires an exact pinned Node package: ${name}@${version}`);
  }
  const manifest = { name: 'engineering-governance-isolated-tools', private: true, version: '1.0.0', dependencies };
  const markerPath = path.join(destination, '.governance-runtime.json');
  const marker = { owner: 'engineering-governance', tool, dependencies };
  if (fs.existsSync(destination)) {
    try {
      if (!fs.statSync(destination).isDirectory()) return failure('Refusing to overwrite an existing tool target that is not a directory.');
      if (!fs.existsSync(markerPath) || fs.readFileSync(markerPath, 'utf8') !== JSON.stringify(marker, null, 2) + '\n') return failure('Refusing to overwrite an unknown or differently pinned tool target; select a new isolated directory.');
      const existing = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'));
      if (JSON.stringify(existing) !== JSON.stringify(manifest)) return failure('Owned runtime package.json has changed; select a fresh isolated directory.');
      if (!fs.existsSync(path.join(destination, 'package-lock.json'))) return failure('Owned tool target is missing package-lock.json; select a fresh isolated directory.');
    } catch (error) { return failure(`Refusing to use an invalid owned tool target: ${error.message}`); }
  }
  const existingOwned = fs.existsSync(destination);
  if (existingOwned) {
    const healthy = doctor({ toolkitRoot, toolDir: destination, tool, projectRoot, invoke });
    if (healthy.code === 0) return { ...healthy, target: destination, evidence: { target: destination, tool, dependencies, node: process.version, checks: healthy.checks, verified: true } };
  }
  let npm;
  try { npm = npmPath ?? npmCli(); }
  catch (error) { return failure(error.message); }
  try {
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n');
    fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    run(process.execPath, [npm, existingOwned ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=true'], destination, invoke);
  } catch (error) { return failure(`Provisioning failed: ${error.message}`); }
  const result = doctor({ toolkitRoot, toolDir: destination, tool, projectRoot, invoke });
  const evidence = { target: destination, tool, dependencies, node: process.version, checks: result.checks, verified: result.code === 0 };
  try { fs.writeFileSync(path.join(destination, 'governance-runtime-evidence.json'), JSON.stringify(evidence, null, 2) + '\n'); }
  catch (error) { return failure(`Could not write provisioning evidence: ${error.message}`); }
  return { ...result, target: destination, evidence };
}

function runtimeOptions(args) {
  const allowed = new Set(['--toolkit-root', '--project-root', '--tool-dir', '--tool', '--executable', '--python-executable', '--target']);
  const values = {};
  for (let index = 1; index < args.length; index += 1) {
    const name = args[index];
    if (!allowed.has(name) || values[name] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid runtime option: ${name}`);
    values[name] = args[++index];
  }
  return values;
}

function printResult(result) {
  for (const check of result.checks ?? []) console.log(`${check.status === 'PASS' ? 'PASS' : check.status} ${check.name}${check.version ? ` (${check.version})` : ''}`);
  for (const error of result.errors ?? []) console.error(`FAIL ${error}`);
  for (const hint of result.hints ?? []) console.log(`HINT ${hint}`);
  if (result.target) console.log(`PASS provisioned ${result.tool} runtime at ${result.target}`);
}

function main(args = process.argv.slice(2)) {
  const command = args[0] ?? 'doctor';
  try {
    const options = runtimeOptions(args);
    const toolkitRoot = options['--toolkit-root'] ?? defaultToolkit;
    const projectRoot = options['--project-root'] ?? process.cwd();
    const result = command === 'doctor'
      ? doctor({ toolkitRoot, projectRoot, toolDir: options['--tool-dir'], tool: options['--tool'], executable: options['--executable'], pythonExecutable: options['--python-executable'] })
      : command === 'provision'
        ? provision({ toolkitRoot, projectRoot, tool: options['--tool'], target: options['--target'] })
        : failure(`Unknown runtime command: ${command}`);
    printResult(result);
    return result.code;
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
