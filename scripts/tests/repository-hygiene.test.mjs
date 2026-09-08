import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { evaluateHygiene, runHygieneCli } from '../repository-hygiene.mjs'

const modulePath = fileURLToPath(new URL('../repository-hygiene.mjs', import.meta.url))

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function fixture(files = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'repository-hygiene-'))
  for (const [file, content] of Object.entries(files)) {
    const target = join(cwd, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  git(cwd, 'init', '--quiet')
  git(cwd, 'config', 'user.email', 'hygiene-test@example.invalid')
  git(cwd, 'config', 'user.name', 'Repository Hygiene Test')
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '--quiet', '-m', 'baseline')
  return cwd
}

function commit(cwd, message, ...paths) {
  if (paths.length) git(cwd, 'add', '-A', '--', ...paths)
  else git(cwd, 'add', '-A')
  git(cwd, 'commit', '--quiet', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

function range(cwd, base) { return { base, head: git(cwd, 'rev-parse', 'HEAD') } }

function runRange(cwd, command, base, extra = {}) {
  return evaluateHygiene({ cwd, command, ...range(cwd, base), ...extra })
}

function cleanup(cwd) { rmSync(cwd, { recursive: true, force: true }) }

test('reports ignored generated inventory but only forced tracked contamination blocks PR', () => {
  const cwd = fixture({ '.gitignore': 'outputs/\n' })
  try {
    mkdirSync(join(cwd, 'outputs'), { recursive: true })
    writeFileSync(join(cwd, 'outputs', 'local.bin'), 'local')
    let result = evaluateHygiene({ cwd, command: 'audit' })
    assert.equal(result.code, 0)
    assert.equal(result.findings.find((item) => item.path === 'outputs')?.classification, 'ignored')

    writeFileSync(join(cwd, 'outputs', 'forced.bin'), 'forced')
    git(cwd, 'add', '-f', 'outputs/forced.bin')
    const base = git(cwd, 'rev-parse', 'HEAD')
    git(cwd, 'commit', '--quiet', '-m', 'force generated file')
    result = runRange(cwd, 'check', base)
    const item = result.findings.find((finding) => finding.path === 'outputs/forced.bin')
    assert.equal(result.code, 1)
    assert.equal(item?.classification, 'tracked')
    assert.equal(item?.history, 'new')
    assert.equal(item?.rule, 'new-generated-file')
  } finally { cleanup(cwd) }
})

test('authoritative range retains historical debt despite dirty edits and deletion', () => {
  const cwd = fixture({ 'artifacts/legacy.bin': 'v1' })
  try {
    const base = git(cwd, 'rev-parse', 'HEAD')
    writeFileSync(join(cwd, 'README.md'), 'head\n')
    commit(cwd, 'unrelated head change', 'README.md')
    rmSync(join(cwd, 'artifacts', 'legacy.bin'))
    let result = runRange(cwd, 'check', base)
    assert.equal(result.code, 0)
    assert.equal(result.findings.some((item) => item.path === 'artifacts/legacy.bin' && item.history === 'historical'), true)

    writeFileSync(join(cwd, 'artifacts', 'legacy.bin'), 'dirty replacement')
    result = runRange(cwd, 'check', base)
    assert.equal(result.findings.some((item) => item.path === 'artifacts/legacy.bin'), true)
  } finally { cleanup(cwd) }
})

test('changed legacy artifacts require review while ordinary logging and Unicode paths remain clean', () => {
  const unusualPath = process.platform === 'win32' ? 'src/space name 雪.ts' : 'src/space name\n雪.ts'
  const cwd = fixture({ 'artifacts/legacy.bin': 'v1', 'tests/logging.test.mjs': 'console.log("test output")\n', [unusualPath]: 'export const value = 1\n' })
  try {
    const base = git(cwd, 'rev-parse', 'HEAD')
    writeFileSync(join(cwd, 'artifacts', 'legacy.bin'), 'v2')
    commit(cwd, 'change legacy artifact', 'artifacts/legacy.bin')
    const result = runRange(cwd, 'check', base)
    const item = result.findings.find((finding) => finding.path === 'artifacts/legacy.bin')
    assert.equal(result.code, 1)
    assert.equal(item?.rule, 'changed-legacy-artifact')
    assert.equal(result.findings.some((finding) => finding.path === 'tests/logging.test.mjs'), false)
    assert.equal(result.findings.some((finding) => finding.path === unusualPath), false)
  } finally { cleanup(cwd) }
})

test('path table flags explicit generated, debug, and experimental roots while ordinary logging stays clean', () => {
  const cwd = fixture({
    'coverage/index.html': 'generated\n',
    '.venv/bin/python': 'generated\n',
    'venv/bin/python': 'generated\n',
    '.mypy_cache/data': 'generated\n',
    '.ruff_cache/data': 'generated\n',
    'reports/grasp-report.json': '{}\n',
    '.tmp-supabase-validation-check/result.json': '{}\n',
    'experimental/new.js': 'generated\n',
    'probe/check.js': 'generated\n',
    'deprecated/old.js': 'legacy\n',
    'src/logging.js': 'console.log("ordinary output")\n',
  })
  try {
    const expected = [
      ['coverage/index.html', 'generated-directory', 'generated'],
      ['.venv/bin/python', 'generated-directory', 'generated'],
      ['venv/bin/python', 'generated-directory', 'generated'],
      ['.mypy_cache/data', 'generated-directory', 'generated'],
      ['.ruff_cache/data', 'generated-directory', 'generated'],
      ['reports/grasp-report.json', 'generated-directory', 'generated'],
      ['.tmp-supabase-validation-check/result.json', 'generated-directory', 'generated'],
      ['experimental/new.js', 'experimental-path', 'experimental'],
      ['probe/check.js', 'debug-probe-path', 'debug'],
      ['deprecated/old.js', 'deprecated-path', 'deprecated'],
    ]
    const result = evaluateHygiene({ cwd, command: 'audit' })
    for (const [file, rule, category] of expected) {
      const item = result.findings.find((finding) => finding.path === file)
      assert.ok(item, `expected a finding for ${file}`)
      assert.equal(item.rule, rule)
      assert.equal(item.category, category)
    }
    assert.equal(result.findings.some((finding) => finding.path === 'src/logging.js'), false)
    assert.equal(result.findings.find((finding) => finding.path === 'deprecated/old.js')?.severity, 'advisory')
    assert.equal(result.code, 0)
  } finally { cleanup(cwd) }
})

test('nested cwd uses the Git root so root contamination cannot be bypassed', () => {
  const cwd = fixture({ 'src/entry.js': 'export const entry = true\n' })
  try {
    mkdirSync(join(cwd, 'outputs'), { recursive: true })
    writeFileSync(join(cwd, 'outputs', 'root.bin'), 'generated\n')
    const base = git(cwd, 'rev-parse', 'HEAD')
    commit(cwd, 'add root generated output')
    const result = runRange(join(cwd, 'src'), 'check', base)
    const item = result.findings.find((finding) => finding.path === 'outputs/root.bin')
    assert.equal(result.mode, 'range')
    assert.equal(item?.classification, 'tracked')
    assert.equal(item?.rule, 'new-generated-file')
    assert.equal(result.code, 1)
  } finally { cleanup(cwd) }
})

test('generic nested temporary artifact directories are detected', () => {
  const cwd = fixture({ 'src/entry.js': 'export const entry = true\n' })
  try {
    const base = git(cwd, 'rev-parse', 'HEAD')
    mkdirSync(join(cwd, 'pkg', '.tmp-build'), { recursive: true })
    writeFileSync(join(cwd, 'pkg', '.tmp-build', 'result.json'), '{}\n')
    commit(cwd, 'add nested temporary artifact')
    const result = runRange(cwd, 'check', base)
    const item = result.findings.find((finding) => finding.path === 'pkg/.tmp-build/result.json')
    assert.equal(item?.rule, 'new-generated-file')
    assert.equal(result.code, 1)
  } finally { cleanup(cwd) }
})

test('mode-only legacy artifact changes require review', () => {
  const cwd = fixture({ 'artifacts/legacy.bin': 'v1\n' })
  try {
    const base = git(cwd, 'rev-parse', 'HEAD')
    git(cwd, 'update-index', '--chmod=+x', '--', 'artifacts/legacy.bin')
    commit(cwd, 'change legacy artifact mode')
    const result = runRange(cwd, 'check', base)
    const item = result.findings.find((finding) => finding.path === 'artifacts/legacy.bin')
    assert.equal(result.code, 1)
    assert.equal(item?.rule, 'changed-legacy-artifact')
    assert.equal(item?.changed, true)
  } finally { cleanup(cwd) }
})

test('local untracked and ignored actions preserve provenance without deletion advice', () => {
  const cwd = fixture({ '.gitignore': 'outputs/\n' })
  try {
    mkdirSync(join(cwd, 'outputs'), { recursive: true })
    writeFileSync(join(cwd, 'outputs', 'local.bin'), 'ignored\n')
    mkdirSync(join(cwd, 'probe'), { recursive: true })
    writeFileSync(join(cwd, 'probe', 'local.js'), 'debug\n')
    const result = evaluateHygiene({ cwd, command: 'audit' })
    const ignored = result.findings.find((finding) => finding.path === 'outputs')
    const untracked = result.findings.find((finding) => finding.path === 'probe/local.js')
    assert.equal(ignored?.classification, 'ignored')
    assert.equal(untracked?.classification, 'untracked')
    for (const item of [ignored, untracked]) {
      assert.ok(item)
      assert.doesNotMatch(item.suggestedAction, /committed|remove|delete/i)
      assert.match(item.suggestedAction, /review|keep|excluded|uncommitted/i)
    }
  } finally { cleanup(cwd) }
})

test('malformed registry, escaped path, invalid date, and range validation fail closed', () => {
  const cwd = fixture({ 'README.md': 'ok\n' })
  try {
    writeFileSync(join(cwd, '.governance-hygiene.json'), JSON.stringify({ version: 1, entries: [{ path: '../escape.js', category: 'debug', owner: 'team', reviewBy: '2099-01-01', evidence: 'review' }] }))
    let result = evaluateHygiene({ cwd, command: 'audit' })
    assert.equal(result.code, 2)
    assert.match(result.errors[0], /path|repository-relative|escape/i)

    writeFileSync(join(cwd, '.governance-hygiene.json'), JSON.stringify({ version: 1, entries: [{ path: 'debug.js', category: 'debug', owner: 'team', reviewBy: '2026-02-30', evidence: 'review' }] }))
    result = evaluateHygiene({ cwd, command: 'audit' })
    assert.equal(result.code, 2)
    assert.match(result.errors[0], /date/i)

    result = evaluateHygiene({ cwd, command: 'check', base: 'abc', head: 'def' })
    assert.equal(result.code, 2)
    assert.match(result.errors[0], /full commit SHA/i)
  } finally { cleanup(cwd) }
})

test('registry targets must resolve to regular files, including local untracked targets', () => {
  const cwd = fixture({ '.governance-hygiene.json': JSON.stringify({ version: 1, entries: [{ path: 'local-debug.js', category: 'debug', owner: 'team', reviewBy: '2099-01-01', evidence: 'review' }] }) })
  try {
    writeFileSync(join(cwd, 'local-debug.js'), 'debug\n')
    let result = evaluateHygiene({ cwd, command: 'audit' })
    assert.equal(result.errors.length, 0)
    assert.equal(result.findings.find((item) => item.path === 'local-debug.js')?.classification, 'untracked')

    rmSync(join(cwd, 'local-debug.js'))
    result = evaluateHygiene({ cwd, command: 'audit' })
    assert.equal(result.code, 2)
    assert.match(result.errors.join('\n'), /missing file/i)
  } finally { cleanup(cwd) }
})

test('symlink inventory is not traversed and evaluation does not mutate files', (t) => {
  const outside = mkdtempSync(join(tmpdir(), 'repository-hygiene-outside-'))
  const cwd = fixture({ '.gitignore': 'link/\n', 'README.md': 'fixture\n' })
  try {
    mkdirSync(join(outside, 'outputs'), { recursive: true })
    writeFileSync(join(outside, 'outputs', 'secret.bin'), 'outside')
    try { symlinkSync(outside, join(cwd, 'link'), 'junction') } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('junction creation is unavailable'); return }
      throw error
    }
    const before = snapshot(cwd, outside)
    const result = evaluateHygiene({ cwd, command: 'audit' })
    const after = snapshot(cwd, outside)
    assert.equal(before, after)
    assert.equal(result.findings.some((item) => item.path.includes('secret.bin')), false)
    assert.equal(result.inventory.ignored.some((item) => item.startsWith('link/')), false)
  } finally {
    cleanup(cwd)
    rmSync(outside, { recursive: true, force: true })
  }
})

function snapshot(cwd, outside) {
  return createHash('sha256').update(JSON.stringify({
    status: git(cwd, 'status', '--porcelain=v1'),
    readme: readFileSync(join(cwd, 'README.md'), 'utf8'),
    outside: readFileSync(join(outside, 'outputs', 'secret.bin'), 'utf8'),
    link: lstatSync(join(cwd, 'link')).mode,
  })).digest('hex')
}

test('registry retention and release expiry are explicit review gates', () => {
  const registry = { version: 1, entries: [{ path: 'debug.js', category: 'debug', owner: 'team', reviewBy: '2020-01-01', evidence: 'initial review' }] }
  const cwd = fixture({ 'debug.js': 'debug\n', '.governance-hygiene.json': JSON.stringify(registry) })
  try {
    const base = git(cwd, 'rev-parse', 'HEAD')
    rmSync(join(cwd, '.governance-hygiene.json'))
    commit(cwd, 'remove registry entry')
    let result = runRange(cwd, 'check', base)
    assert.equal(result.code, 1)
    assert.equal(result.findings.some((item) => item.rule === 'registry-retention'), true)

    rmSync(join(cwd, 'debug.js'))
    commit(cwd, 'remove registry entry and target file')
    result = runRange(cwd, 'check', base)
    assert.equal(result.code, 0)
    assert.equal(result.findings.some((item) => item.rule === 'registry-retention'), false)

    writeFileSync(join(cwd, '.governance-hygiene.json'), JSON.stringify(registry))
    writeFileSync(join(cwd, 'debug.js'), 'debug\n')
    commit(cwd, 'restore registry entry and target file')
    const retainedBase = git(cwd, 'rev-parse', 'HEAD')
    writeFileSync(join(cwd, 'README.md'), 'unrelated change\n')
    commit(cwd, 'unrelated head change', 'README.md')
    result = runRange(cwd, 'check', retainedBase, { stage: 'release', now: new Date('2026-09-08T00:00:00Z') })
    assert.equal(result.code, 1)
    assert.equal(result.findings.some((item) => item.rule === 'review-expired'), true)
  } finally { cleanup(cwd) }
})

test('registry categories remain review metadata while built-in experimental contamination still blocks', () => {
  const cwd = fixture({ 'src/legacy.js': 'v1\n', '.governance-hygiene.json': JSON.stringify({ version: 1, entries: [{ path: 'src/legacy.js', category: 'deprecated', owner: 'team', reviewBy: '2099-01-01', evidence: 'SECRET-REVIEW-EVIDENCE' }] }) })
  try {
    const base = git(cwd, 'rev-parse', 'HEAD')
    writeFileSync(join(cwd, 'src', 'legacy.js'), 'v2\n')
    mkdirSync(join(cwd, 'experimental'), { recursive: true })
    writeFileSync(join(cwd, 'experimental', 'new.js'), 'new\n')
    commit(cwd, 'legacy review and experimental contamination')
    const result = runRange(cwd, 'check', base)
    const legacy = result.findings.find((item) => item.path === 'src/legacy.js')
    const experimental = result.findings.find((item) => item.path === 'experimental/new.js')
    assert.equal(legacy?.severity, 'advisory')
    assert.equal(legacy?.rule, 'registered-deprecated')
    assert.equal(experimental?.rule, 'new-experimental-file')
    assert.equal(result.code, 1)
    assert.equal(JSON.stringify(result).includes('SECRET-REVIEW-EVIDENCE'), false)

    const invalidRegistryRoot = evaluateHygiene({ cwd, command: 'audit', registryPath: 'config/.governance-hygiene.json' })
    assert.equal(invalidRegistryRoot.code, 2)
    assert.match(invalidRegistryRoot.errors[0], /fixed|root/i)
  } finally { cleanup(cwd) }
})

test('CLI emits parseable JSON and CI rejects local mode', () => {
  const cwd = fixture({ 'README.md': 'ok\n' })
  try {
    const result = runHygieneCli(['check', '--format', 'json'], { cwd })
    assert.equal(result.code, 2)
    assert.equal(result.format, 'json')
    assert.match(JSON.stringify(result), /immutable|base|range/i)
    for (const [args, pattern] of [
      [['audit', 'unexpected', '--format', 'json'], /unexpected positional/i],
      [['audit', '--format', 'json', '--format', 'text'], /only once/i],
      [['audit', '--format'], /requires (?:a value|a non-flag value)/i],
      [['audit', '--format', '--base', 'abc'], /requires a non-flag value/i],
    ]) {
      const invalid = runHygieneCli(args, { cwd })
      assert.equal(invalid.code, 2)
      assert.match(invalid.errors.join('\n'), pattern)
    }
    const child = spawnSync(process.execPath, [modulePath, 'audit', '--format', 'json'], { cwd, env: { ...process.env, CI: '1' }, encoding: 'utf8' })
    assert.notEqual(child.status, 0)
    assert.doesNotThrow(() => JSON.parse(child.stdout))
  } finally { cleanup(cwd) }
})
