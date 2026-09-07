import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { doctor, provision, resolveToolDir } from '../runtime-tools.mjs';
import { launch } from '../../templates/project-config/governance.mjs';

const toolkitSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pinnedRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: toolkitSource, encoding: 'utf8' }).trim();

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function projectFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-runtime-project-'));
  fs.mkdirSync(path.join(root, 'src'));
  write(root, '.governance.yml', `
governance:
  version: "1.0"
  profile: python-typescript-monorepo
project:
  name: runtime-fixture
modules:
  - name: src
    path: src
    owner: platform
`);
  return root;
}

function toolkitFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-runtime-toolkit-'));
  fs.cpSync(path.join(toolkitSource, 'profiles'), path.join(root, 'profiles'), { recursive: true });
  return root;
}

function fakePackage(toolDir, name, version, binName, fileName, output) {
  const packageRoot = path.join(toolDir, 'node_modules', ...name.split('/'));
  fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  write(packageRoot, 'package.json', JSON.stringify({ name, version, bin: { [binName]: `bin/${fileName}` } }));
  write(packageRoot, `bin/${fileName}`, `
const mode = process.argv[2];
console.log(mode === '--info' ? ${JSON.stringify(output)} : ${JSON.stringify(version)});
`);
  return packageRoot;
}

function fakeNodeRuntime(toolDir, includeContract = false) {
  fakePackage(toolDir, 'dependency-cruiser', '16.10.4', 'depcruise', 'depcruise.js', 'dependency-cruiser TypeScript 5.9.3');
  fakePackage(toolDir, 'typescript', '5.9.3', 'tsc', 'tsc', 'Version 5.9.3');
  if (includeContract) fakePackage(toolDir, '@stoplight/spectral-cli', '6.15.0', 'spectral', 'spectral.js', 'Spectral 6.15.0');
}

function trackedInvoke(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'uv' || command === 'docker') return { status: 1, stdout: '', stderr: 'not installed' };
    return spawnSync(command, args, options);
  };
}

function directoryLink(target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  return link;
}

function committedToolkitFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-runtime-toolkit-fixture-'));
  fs.cpSync(path.join(toolkitSource, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  fs.cpSync(path.join(toolkitSource, 'profiles'), path.join(root, 'profiles'), { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'runtime-fixture@example.invalid'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Runtime Fixture'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '--quiet', '-m', 'runtime toolkit fixture'], { cwd: root, stdio: 'ignore' });
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { root, revision };
}

function realLauncherProject() {
  const projectRoot = projectFixture();
  const launcher = write(projectRoot, 'scripts/governance.mjs', fs.readFileSync(path.join(toolkitSource, 'templates', 'project-config', 'governance.mjs'), 'utf8'));
  const pinnedToolkit = committedToolkitFixture();
  const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-runtime-toolkit-alias-'));
  const toolkitAlias = directoryLink(pinnedToolkit.root, path.join(aliasRoot, 'toolkit'));
  const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-runtime-child-node-'));
  fakeNodeRuntime(toolDir);
  write(projectRoot, '.governance-toolkit.json', JSON.stringify({
    repository: 'charles439/engineering-governance',
    ref: pinnedToolkit.revision,
    directory: toolkitAlias,
  }));
  execFileSync('git', ['init', '--quiet'], { cwd: projectRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'runtime-fixture@example.invalid'], { cwd: projectRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Runtime Fixture'], { cwd: projectRoot, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: projectRoot, stdio: 'ignore' });
  execFileSync('git', ['commit', '--quiet', '-m', 'runtime fixture'], { cwd: projectRoot, stdio: 'ignore' });
  return { projectRoot, launcher, toolDir };
}

test('doctor verifies actual dependency-cruiser and TypeScript companion versions', () => {
  const projectRoot = projectFixture();
  const toolkitRoot = toolkitFixture();
  const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-runtime-ts-'));
  fakeNodeRuntime(toolDir);
  const calls = [];
  const result = doctor({ toolkitRoot, toolDir, tool: 'typescript', projectRoot, invoke: trackedInvoke(calls) });
  assert.equal(result.code, 0, result.errors.join('\n'));
  assert.equal(result.errors.length, 0);
  assert.ok(result.checks.find((check) => check.name === 'typescript').companion.version.includes('5.9.3'));
  assert.ok(calls.some(({ args }) => args.includes('--info')));
  assert.ok(calls.every(({ options }) => options.shell === false));
});

test('doctor selects only installed checker packages and optional uv/docker failures do not block Node', () => {
  const projectRoot = projectFixture();
  const toolkitRoot = toolkitFixture();
  const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-runtime-ts-only-'));
  fakeNodeRuntime(toolDir);
  const result = doctor({ toolkitRoot, toolDir, projectRoot, invoke: trackedInvoke([]) });
  assert.equal(result.code, 0, result.errors.join('\n'));
  assert.equal(result.checks.filter((check) => check.name === 'typescript').length, 1);
  assert.equal(result.checks.filter((check) => check.name === 'contract').length, 0);
  assert.equal(result.checks.find((check) => check.name === 'uv').status, 'OPTIONAL');
  assert.equal(result.checks.find((check) => check.name === 'docker').status, 'OPTIONAL');
});

test('doctor accepts canonical external runtimes and rejects source or aliased tool directories', () => {
  const projectRoot = projectFixture();
  const toolkitRoot = toolkitFixture();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-runtime-external-'));
  fakeNodeRuntime(external);
  const externalExecutable = write(external, 'override.js', `
console.log(process.argv[2] === '--info' ? 'dependency-cruiser TypeScript 5.9.3' : '16.10.4');
`);
  const externalResult = doctor({ toolkitRoot, toolDir: external, tool: 'typescript', executable: externalExecutable, projectRoot, invoke: trackedInvoke([]) });
  assert.equal(externalResult.code, 0, externalResult.errors.join('\n'));

  const externalAlias = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'governance-runtime-alias-')), 'external-runtime');
  directoryLink(external, externalAlias);
  const aliasResult = doctor({ toolkitRoot, toolDir: externalAlias, tool: 'typescript', projectRoot, invoke: trackedInvoke([]) });
  assert.equal(aliasResult.code, 0, aliasResult.errors.join('\n'));

  const projectRuntime = path.join(projectRoot, 'node_modules');
  const toolkitRuntime = path.join(toolkitRoot, 'node_modules');
  fs.mkdirSync(projectRuntime, { recursive: true });
  fs.mkdirSync(toolkitRuntime, { recursive: true });
  assert.throws(() => resolveToolDir({ toolkitRoot, toolDir: projectRuntime, projectRoot }), /outside source repository/);
  assert.throws(() => resolveToolDir({ toolkitRoot, toolDir: toolkitRuntime, projectRoot }), /outside source repository/);

  const projectAlias = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'governance-runtime-project-alias-')), 'project-runtime');
  directoryLink(projectRuntime, projectAlias);
  assert.throws(() => resolveToolDir({ toolkitRoot, toolDir: projectAlias, projectRoot }), /outside source repository/);

  const projectExecutable = write(projectRoot, 'node_modules/depcruise.js', 'console.log("16.10.4");\n');
  const executableResult = doctor({ toolkitRoot, toolDir: external, tool: 'typescript', executable: projectExecutable, projectRoot, invoke: trackedInvoke([]) });
  assert.equal(executableResult.code, 2);
  assert.match(executableResult.errors.join('\n'), /Tool executable must be outside source repository/);
});

test('doctor accepts an external Python executable and rejects project .venv tools', () => {
  const projectRoot = projectFixture();
  const toolkitRoot = toolkitFixture();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-runtime-python-'));
  const externalExecutable = write(external, 'lint-imports.js', "console.log('2.2');\n");
  const accepted = doctor({ toolkitRoot, projectRoot, tool: 'python', pythonExecutable: externalExecutable, invoke: trackedInvoke([]) });
  assert.equal(accepted.code, 0, accepted.errors.join('\n'));
  assert.ok(accepted.checks.find((check) => check.name === 'python' && check.status === 'PASS'));

  const projectExecutable = write(projectRoot, '.venv/Scripts/lint-imports.js', "console.log('2.2');\n");
  const rejected = doctor({ toolkitRoot, projectRoot, tool: 'python', pythonExecutable: projectExecutable, invoke: trackedInvoke([]) });
  assert.equal(rejected.code, 2);
  assert.match(rejected.errors.join('\n'), /Python executable must be outside source repository/);
});

test('doctor rejects a manifest version mismatch and checks Spectral when selected', () => {
  const projectRoot = projectFixture();
  const toolkitRoot = toolkitFixture();
  const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-runtime-contract-'));
  fakeNodeRuntime(toolDir, true);
  const spectralPackage = path.join(toolDir, 'node_modules', '@stoplight', 'spectral-cli', 'package.json');
  fs.writeFileSync(spectralPackage, JSON.stringify({ name: '@stoplight/spectral-cli', version: '6.15.1', bin: { spectral: 'bin/spectral.js' } }));
  const mismatch = doctor({ toolkitRoot, toolDir, tool: 'contract', projectRoot });
  assert.equal(mismatch.code, 2);
  assert.match(mismatch.errors.join('\n'), /Expected @stoplight\/spectral-cli@6\.15\.0/);
});

test('provision refuses unknown existing targets, Python installation, and project paths', () => {
  const projectRoot = projectFixture();
  const toolkitRoot = toolkitFixture();
  const unknown = fs.mkdtempSync(path.join(os.tmpdir(), '治理 runtime unknown-'));
  const calls = [];
  const unknownResult = provision({ toolkitRoot, tool: 'typescript', target: unknown, projectRoot, invoke: trackedInvoke(calls) });
  assert.equal(unknownResult.code, 2);
  assert.match(unknownResult.errors[0], /unknown|differently pinned/i);
  assert.equal(calls.length, 0);
  assert.equal(provision({ toolkitRoot, tool: 'python', target: path.join(os.tmpdir(), 'python target'), projectRoot }).code, 2);
  assert.match(provision({ toolkitRoot, tool: 'typescript', target: projectRoot, projectRoot }).errors[0], /outside source repository/);
});

test('provision uses the pinned Node manifest and shell-free npm-cli execution in a Unicode target', () => {
  const projectRoot = projectFixture();
  const toolkitRoot = toolkitFixture();
  const target = path.join(os.tmpdir(), '治理 tools with spaces', `node-${Date.now()}`);
  const fakeNpm = write(fs.mkdtempSync(path.join(os.tmpdir(), 'governance-fake-npm-')), 'npm-cli.js', `
import fs from 'node:fs';
import path from 'node:path';
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
for (const [name, version] of Object.entries(manifest.dependencies)) {
  const root = path.join('node_modules', ...name.split('/'));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  const binName = name === 'dependency-cruiser' ? 'depcruise' : name === 'typescript' ? 'tsc' : 'spectral';
  const file = binName === 'tsc' ? 'tsc' : binName === 'depcruise' ? 'depcruise.js' : 'spectral.js';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version, bin: { [binName]: 'bin/' + file } }));
  fs.writeFileSync(path.join(root, 'bin', file), 'console.log(process.argv[2] === "--info" ? "dependency-cruiser TypeScript 5.9.3" : "' + version + '");');
}
`);
  const calls = [];
  const result = provision({ toolkitRoot, tool: 'typescript', target, projectRoot, npmPath: fakeNpm, invoke: trackedInvoke(calls) });
  assert.equal(result.code, 0, result.errors.join('\n'));
  assert.deepEqual(result.evidence.dependencies, { 'dependency-cruiser': '16.10.4', typescript: '5.9.3' });
  const install = calls.find(({ args }) => args.includes('install'));
  assert.ok(install);
  assert.equal(install.options.shell, false);
  assert.ok(install.args.includes('--ignore-scripts'));
});

test('project launcher rejects invalid pins and never bootstraps during check', () => {
  const projectRoot = projectFixture();
  write(projectRoot, '.governance-toolkit.json', JSON.stringify({ repository: 'charles439/engineering-governance', ref: 'invalid' }));
  assert.throws(() => launch({ projectRoot, args: ['check'], env: {}, invoke: trackedInvoke([]) }), /full 40-character/);

  write(projectRoot, '.governance-toolkit.json', JSON.stringify({ repository: 'charles439/engineering-governance', ref: pinnedRevision, directory: path.join(projectRoot, 'absent toolkit') }));
  const calls = [];
  assert.throws(() => launch({ projectRoot, args: ['check'], env: {}, invoke: trackedInvoke(calls) }), /Pinned toolkit is absent/);
  assert.equal(calls.some(({ args }) => args.includes('fetch')), false);
});

test('project launcher forwards doctor to the pinned governance owner and preserves the clean checkout rule', () => {
  const projectRoot = projectFixture();
  write(projectRoot, '.governance-toolkit.json', JSON.stringify({ repository: 'charles439/engineering-governance', ref: pinnedRevision, directory: toolkitSource }));
  const calls = [];
  const invoke = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === process.execPath && args[0].endsWith('governance.mjs')) return { status: 7 };
    return spawnSync(command, args, options);
  };
  const result = launch({ projectRoot, args: ['doctor', '--tool', 'typescript', '--toolkit-dev'], env: {}, invoke });
  assert.equal(result.code, 7);
  const child = calls.find(({ args }) => args[0].endsWith('governance.mjs'));
  assert.ok(child);
  assert.deepEqual(child.args.slice(1, 3), ['doctor', '--tool']);
  assert.equal(child.options.shell, false);
});

test('project launcher rejects toolkit development diagnostics for authoritative ranges', () => {
  const projectRoot = projectFixture();
  write(projectRoot, '.governance-toolkit.json', JSON.stringify({ repository: 'charles439/engineering-governance', ref: pinnedRevision, directory: toolkitSource }));
  assert.throws(() => launch({ projectRoot, args: ['check', '--base', '0123456789abcdef0123456789abcdef01234567', '--head', 'fedcba9876543210fedcba9876543210fedcba98', '--toolkit-dev'], env: {} }), /cannot be combined.*authoritative/);
});

test('project launcher resolves an aliased toolkit entry before real doctor and Git status runs', () => {
  const { projectRoot, launcher, toolDir } = realLauncherProject();
  const env = { ...process.env, GOVERNANCE_TOOL_DIR: toolDir };
  const doctorOutput = execFileSync(process.execPath, [launcher, 'doctor', '--tool', 'typescript'], { cwd: projectRoot, env, encoding: 'utf8' });
  assert.match(doctorOutput, /PASS typescript(?:\s|$)/m);
  const statusOutput = execFileSync(process.execPath, [launcher, 'git', 'status'], { cwd: projectRoot, env, encoding: 'utf8' }).trim();
  const status = JSON.parse(statusOutput);
  assert.equal(status.exists, false);
  assert.ok(status.commonDir);
});
