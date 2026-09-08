import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadGovernanceConfig,
  parseGovernanceYaml,
  validateGovernanceConfig,
} from '../config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const toolkitRoot = path.resolve(here, '..', '..');
const fixture = path.join(toolkitRoot, 'fixtures', 'typescript-project', '.governance.yml');
const profilesDir = path.join(toolkitRoot, 'profiles');

test('parses and validates the TypeScript fixture', () => {
  const result = loadGovernanceConfig(fixture, { profilesDir });

  assert.deepEqual(result.errors, []);
  assert.equal(result.config.governance.version, '1.0');
  assert.equal(result.config.governance.profile, 'python-typescript-monorepo');
  assert.equal(result.config.project.name, 'fixture-typescript');
  assert.deepEqual(result.config.modules, [
    { name: 'app', path: 'src', owner: 'platform' },
  ]);
  assert.deepEqual(result.config.checks.adr_required_for, ['contracts/**']);
  assert.equal(result.config.checks.architecture.no_new_cycles, true);
});

test('defaults and validates the top-level dependency baseline policy', () => {
  const config = parseGovernanceYaml(`
governance:
  version: "1.0"
  profile: "python-typescript-monorepo"
project:
  name: baseline
modules:
  - name: api
    path: api
    owner: platform
baseline:
  mode: ratchet
  allowed_rules:
    - no-cycle
    - no-forbidden-dependencies
`);
  assert.deepEqual(validateGovernanceConfig(config, { profilesDir }), []);
  assert.deepEqual(validateGovernanceConfig({ ...config, baseline: { mode: 'ratchet', allowed_rules: ['no-cycle', 'no-cycle'] } }, { profilesDir }), [
    'baseline.allowed_rules must not contain duplicates',
  ]);
  assert.deepEqual(validateGovernanceConfig({ ...config, baseline: { mode: 'loose', allowed_rules: ['no-secrets'] } }, { profilesDir }), [
    'baseline.mode must be strict or ratchet',
    'baseline.allowed_rules must contain only no-cycle and no-forbidden-dependencies',
  ]);
});

test('rejects duplicate modules and paths escaping the project', () => {
  const config = parseGovernanceYaml(`
governance:
  version: "1.0"
  profile: "python-typescript-monorepo"
project:
  name: "invalid-boundary"
modules:
  - name: api
    path: ../outside
    owner: platform
  - name: api
    path: ../outside
    owner: platform
`);
  const errors = validateGovernanceConfig(config, { profilesDir });
  assert.ok(errors.some((error) => error.includes('relative path inside')));
  assert.ok(errors.some((error) => error.includes('duplicate module name')));
  assert.ok(errors.some((error) => error.includes('duplicate module path')));
});

test('rejects non-boolean architecture policy flags', () => {
  const config = parseGovernanceYaml(`
governance:
  version: "1.0"
  profile: "python-typescript-monorepo"
project:
  name: "invalid-policy"
modules:
  - name: api
    path: api
    owner: platform
checks:
  architecture:
    require_dependency_graph: yes
`);
  const errors = validateGovernanceConfig(config, { profilesDir });
  assert.ok(errors.some((error) => error.includes('require_dependency_graph must be boolean')));
});

test('accepts repository hygiene as a boolean policy flag', () => {
  const config = parseGovernanceYaml(`
governance:
  version: "1.0"
  profile: "python-typescript-monorepo"
project:
  name: "hygiene-policy"
modules:
  - name: api
    path: api
    owner: platform
checks:
  repository_hygiene: true
`);
  assert.deepEqual(validateGovernanceConfig(config, { profilesDir }), []);
  assert.ok(validateGovernanceConfig({ ...config, checks: { repository_hygiene: 'yes' } }, { profilesDir }).includes('checks.repository_hygiene must be boolean'));
});

test('rejects profile traversal and unknown policy fields', () => {
  const config = parseGovernanceYaml(`
governance:
  version: "1.0"
  profile: "../outside"
project:
  name: "invalid-profile"
modules:
  - name: api
    path: api
    owner: platform
checks:
  architecture:
    require_dependecy_graph: true
`);
  const errors = validateGovernanceConfig(config, { profilesDir });
  assert.ok(errors.some((error) => error.includes('simple profile name')));
  assert.ok(errors.some((error) => error.includes('unknown checks.architecture field')));
});

test('rejects duplicate YAML keys and module paths that do not exist', () => {
  assert.throws(() => parseGovernanceYaml(`
governance:
  version: "1.0"
  version: "2.0"
`), /duplicates mapping key/);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-path-'));
  const configPath = path.join(temporary, '.governance.yml');
  fs.writeFileSync(configPath, `
governance:
  version: "1.0"
  profile: "python-typescript-monorepo"
project:
  name: "missing-module"
modules:
  - name: api
    path: api
    owner: platform
`);
  const result = loadGovernanceConfig(configPath, { profilesDir });
  assert.ok(result.errors.some((error) => error.includes('path does not exist')));
});

test('rejects trailing root mappings, unknown fields, and Windows absolute paths on every host', () => {
  assert.throws(() => parseGovernanceYaml(`
  governance:
    version: "1.0"
    profile: python-typescript-monorepo
checks:
  adr_required_for: []
`), /unexpected indentation/);
  const config = parseGovernanceYaml(`
governance:
  version: "1.0"
  profile: python-typescript-monorepo
  typo: true
project:
  name: strict
  typo: true
modules:
  - name: api
    path: C:/outside
    owner: platform
    typo: true
`);
  const errors = validateGovernanceConfig(config, { profilesDir });
  assert.ok(errors.some((error) => error.includes('unknown governance field')));
  assert.ok(errors.some((error) => error.includes('unknown project field')));
  assert.ok(errors.some((error) => error.includes('unknown modules[0] field')));
  assert.ok(errors.some((error) => error.includes('relative path inside')));
});

test('reports a missing module owner', () => {
  const config = parseGovernanceYaml(`
governance:
  version: "1.0"
  profile: "python-typescript-monorepo"
project:
  name: "missing-owner"
modules:
  - name: api
    path: api
`);

  const errors = validateGovernanceConfig(config, { profilesDir });
  assert.ok(errors.some((error) => error.includes('modules[0].owner')));
});

test('reports invalid version and unknown profile', () => {
  const config = parseGovernanceYaml(`
governance:
  version: "one"
  profile: "does-not-exist"
project:
  name: "invalid-config"
modules:
  - name: api
    path: api
    owner: platform
`);

  const errors = validateGovernanceConfig(config, { profilesDir });
  assert.ok(errors.some((error) => error.includes('governance.version')));
  assert.ok(errors.some((error) => error.includes('governance.profile')));
});

test('reports a missing configuration file without throwing', () => {
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'governance-config-')), '.governance.yml');
  const result = loadGovernanceConfig(missing, { profilesDir });

  assert.equal(result.config, null);
  assert.deepEqual(result.errors, [`missing config: ${missing}`]);
});
