import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanDependencies } from '../governance-scan.mjs';

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function commit(root, message) {
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function fakePackage(toolDir, name, version, binName, fileName, body) {
  const packageRoot = path.join(toolDir, 'node_modules', ...name.split('/'));
  fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  write(toolDir, path.relative(toolDir, path.join(packageRoot, 'package.json')), JSON.stringify({ name, version, bin: { [binName]: `bin/${fileName}` } }));
  write(toolDir, path.relative(toolDir, path.join(packageRoot, 'bin', fileName)), body);
}

function fakeRuntime(status = 0, report = { modules: [{ source: 'src/a.ts', dependencies: [] }] }) {
  const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-scan-runtime-'));
  const script = `
const report = ${JSON.stringify(report)};
if (process.argv.includes('--info')) console.log('dependency-cruiser TypeScript 5.9.3');
else if (process.argv.includes('--version')) console.log('16.10.4');
else { console.log(JSON.stringify(report)); process.exitCode = ${status}; }
`;
  fakePackage(toolDir, 'dependency-cruiser', '16.10.4', 'depcruise', 'depcruise.js', script);
  fakePackage(toolDir, 'typescript', '5.9.3', 'tsc', 'tsc.js', 'console.log("Version 5.9.3");\n');
  return toolDir;
}

function fixture({ roots = ['src'], packageJson = false, pinRoots = roots } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-scan-project-'));
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'governance@example.test']);
  git(root, ['config', 'user.name', 'Governance Test']);
  for (const relative of roots) write(root, `${relative}/a.ts`, `export const ${relative.replace(/[^a-z]/gi, '') || 'value'} = true;\n`);
  write(root, '.governance.yml', `
governance:
  version: "1.0"
  profile: python-typescript-monorepo
project:
  name: scan-fixture
modules:
  - name: source
    path: ${roots[0]}
    owner: platform
`);
  write(root, '.dependency-cruiser.cjs', 'module.exports = { forbidden: [] };\n');
  if (packageJson) write(root, 'package.json', JSON.stringify({ name: 'scan-fixture', private: true, version: '1.0.0' }) + '\n');
  write(root, '.governance-toolkit.json', JSON.stringify({
    repository: 'example/engineering-governance',
    ref: '0123456789abcdef0123456789abcdef01234567',
    scan: { config: '.dependency-cruiser.cjs', roots: pinRoots.map((relative) => ({ path: relative, typescript: true })) },
  }, null, 2) + '\n');
  return root;
}

function scan(root, options = {}) {
  return scanDependencies({ cwd: root, toolDir: fakeRuntime(), ...options });
}

test('fresh local scan rejects a missing toolkit pin', () => {
  const root = fixture();
  fs.rmSync(path.join(root, '.governance-toolkit.json'));
  assert.throws(() => scan(root), /requires \.governance-toolkit\.json/);
});

test('fresh scan rejects malformed and empty reports', () => {
  const root = fixture();
  assert.throws(() => scan(root, { scanner: () => ({ report: {} }) }), /zero modules/);
  assert.throws(() => scan(root, { scanner: () => ({ report: { modules: [] } }) }), /zero modules/);
});

test('fresh scan requires every configured root to appear in the report', () => {
  const root = fixture({ roots: ['src', 'lib'], pinRoots: ['src', 'lib'] });
  assert.throws(() => scan(root, { scanner: () => ({ report: { modules: [{ source: 'src/a.ts', dependencies: [] }] } }) }), /no TypeScript modules for scan root: lib/);
});

test('fresh local scan rejects symlinks before invoking the checker', () => {
  const root = fixture();
  try {
    fs.symlinkSync(path.join(root, 'src', 'a.ts'), path.join(root, 'src', 'link.ts'));
  } catch (error) {
    assert.fail(`test environment must support symlinks: ${error.message}`);
  }
  assert.throws(() => scan(root), /contains a symlink/);
});

test('authoritative scans require immutable base and head dependency manifests', () => {
  const root = fixture({ packageJson: true });
  const base = commit(root, 'base');
  write(root, 'package.json', JSON.stringify({ name: 'scan-fixture', private: true, version: '2.0.0' }) + '\n');
  const head = commit(root, 'dependency change');
  assert.throws(() => scan(root, { base, head }), /matching package manifests and lockfiles/);
});

test('authoritative scans reject changed trusted scan roots', () => {
  const root = fixture();
  const base = commit(root, 'base');
  write(root, 'lib/a.ts', 'export const lib = true;\n');
  write(root, '.governance-toolkit.json', JSON.stringify({
    repository: 'example/engineering-governance',
    ref: '0123456789abcdef0123456789abcdef01234567',
    scan: { config: '.dependency-cruiser.cjs', roots: [{ path: 'lib', typescript: true }] },
  }, null, 2) + '\n');
  const head = commit(root, 'change scan roots');
  assert.throws(() => scan(root, { base, head }), /head scan pin differs from trusted base scan pin/);
});

test('authoritative scans reject changed toolkit pin identity', () => {
  const root = fixture();
  const base = commit(root, 'base');
  write(root, '.governance-toolkit.json', JSON.stringify({
    repository: 'other/engineering-governance',
    ref: '0123456789abcdef0123456789abcdef01234567',
    scan: { config: '.dependency-cruiser.cjs', roots: [{ path: 'src', typescript: true }] },
  }, null, 2) + '\n');
  const head = commit(root, 'change toolkit pin identity');
  assert.throws(() => scan(root, { base, head }), /pin identity differs/);
});

test('local scans include tracked edits and untracked source files', () => {
  const root = fixture();
  write(root, 'src/a.ts', 'export const changed = true;\n');
  write(root, 'src/new.ts', 'export const added = true;\n');
  const result = scanDependencies({
    cwd: root,
    toolDir: fakeRuntime(),
    scanner: ({ cwd }) => {
      assert.equal(fs.readFileSync(path.join(cwd, 'src/a.ts'), 'utf8'), 'export const changed = true;\n');
      assert.equal(fs.readFileSync(path.join(cwd, 'src/new.ts'), 'utf8'), 'export const added = true;\n');
      return { report: { modules: [{ source: 'src/a.ts', dependencies: [] }, { source: 'src/new.ts', dependencies: [] }] } };
    },
  });
  assert.equal(result.headReport.metadata.moduleCount, 2);
});

test('immutable base and head scans ignore dirty working-tree files', () => {
  const root = fixture();
  const base = commit(root, 'base');
  write(root, 'src/a.ts', 'export const committed = true;\n');
  const head = commit(root, 'head');
  write(root, 'src/a.ts', 'export const dirty = true;\n');
  write(root, 'src/dirty.ts', 'export const dirtyFile = true;\n');
  const result = scanDependencies({
    cwd: root,
    base,
    head,
    toolDir: fakeRuntime(),
    scanner: ({ cwd, revision }) => {
      const source = fs.readFileSync(path.join(cwd, 'src/a.ts'), 'utf8');
      if (revision === base) assert.match(source, /export const src/);
      if (revision === head) {
        assert.equal(source.replaceAll('\r\n', '\n'), 'export const committed = true;\n');
        assert.equal(fs.existsSync(path.join(cwd, 'src/dirty.ts')), false);
      }
      return { report: { modules: [{ source: 'src/a.ts', dependencies: [] }] } };
    },
  });
  assert.equal(result.baseReport.metadata.range.base, base);
  assert.equal(result.headReport.metadata.range.head, head);
});

test('authoritative scans compare dependency declarations and locks, not package scripts', () => {
  const root = fixture({ packageJson: true });
  write(root, 'package-lock.json', '{"name":"scan-fixture","lockfileVersion":3,"packages":{}}\n');
  const base = commit(root, 'base');
  write(root, 'package.json', JSON.stringify({ name: 'scan-fixture', private: true, version: '1.0.0', scripts: { governance: 'node scripts/governance.mjs check' } }) + '\n');
  const head = commit(root, 'add governance script');
  assert.doesNotThrow(() => scanDependencies({ cwd: root, base, head, includeBase: false, toolDir: fakeRuntime(), scanner: () => ({ report: { modules: [{ source: 'src/a.ts', dependencies: [] }] } }) }));
  write(root, 'package-lock.json', '{"name":"scan-fixture","lockfileVersion":3,"packages":{"":{}}}\n');
  const changedLock = commit(root, 'lock change');
  assert.throws(() => scanDependencies({ cwd: root, base: head, head: changedLock, toolDir: fakeRuntime(), scanner: () => ({ report: { modules: [{ source: 'src/a.ts', dependencies: [] }] } }) }), /matching package manifests and lockfiles/);
});

test('dependency-cruiser status 1 requires an explainable graph violation', () => {
  const root = fixture();
  assert.throws(() => scanDependencies({ cwd: root, toolDir: fakeRuntime(1) }), /exited 1 without a report violation/);
  const cycleReport = {
    modules: [
      { source: 'src/a.ts', dependencies: [{ resolved: 'src/b.ts' }] },
      { source: 'src/b.ts', dependencies: [{ resolved: 'src/a.ts' }] },
    ],
    summary: { violations: [{ type: 'cycle', rule: { name: 'no-circular-source-dependencies' }, from: 'src/a.ts', to: 'src/b.ts' }] },
  };
  const accepted = scanDependencies({ cwd: root, toolDir: fakeRuntime(1, cycleReport) });
  assert.equal(accepted.headReport.metadata.moduleCount, 2);
  assert.throws(() => scanDependencies({ cwd: root, toolDir: fakeRuntime(2) }), /dependency-cruiser execution failed.*exit 2/);
});
