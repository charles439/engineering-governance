#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const STAGES = new Set(['task-start', 'task-end', 'pr', 'release', 'maintenance'])
const FORMATS = new Set(['text', 'json'])
const REGISTRY_CATEGORIES = new Set(['deprecated', 'debug', 'experimental'])
const REGISTRY_FIELDS = ['path', 'category', 'owner', 'reviewBy', 'evidence']
const PATH_RULES = [
  { category: 'generated', mandatory: true, rule: 'generated-directory', test: (p) => /^(?:artifacts|coverage|dist|node_modules|\.wrangler|outputs?|\.cache|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv|venv|\.playwright(?:-cli|-mcp)?|\.tmp-[^/]+|scratch|\.tools|\.test-assets|\.test-output|\.pnpm-store|\.pnpm-new)(?:\/|$)/i.test(p) || /(?:^|\/)(?:artifacts|coverage|dist|node_modules|\.wrangler|\.cache|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv|venv|\.tmp-[^/]+)(?:\/|$)/i.test(p) || /(?:^|\/)grasp-report\.json$/i.test(p) },
  { category: 'generated', mandatory: true, rule: 'generated-media-file', test: (p) => /^(?:artifacts|dist|media|outputs?)(?:\/|$).*\.(?:mp4|mov|mkv|webm|wav|mp3|flac|aac|srt)$/i.test(p) },
  { category: 'generated', mandatory: true, rule: 'generated-log-file', test: (p) => /\.log$/i.test(p) },
  { category: 'debug', mandatory: true, rule: 'debug-probe-path', test: (p) => /^(?:probe|probes)(?:\/|$)/i.test(p) || /^scripts\/(?:probe|probes)(?:\/|$)/i.test(p) },
  { category: 'deprecated', mandatory: false, rule: 'deprecated-path', test: (p) => /^(?:deprecated)(?:\/|$)/i.test(p) },
  { category: 'experimental', mandatory: true, rule: 'experimental-path', test: (p) => /^(?:experimental|experiments)(?:\/|$)/i.test(p) },
]

function commandError(message) {
  const error = new Error(message)
  error.exitCode = 2
  return error
}

function text(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')
}

function nullDelimited(value) {
  return text(value).split('\0').filter(Boolean)
}

function normalizePath(value, label = 'path', { gitPath = false } = {}) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a non-empty repository-relative file path`)
  if (!gitPath && value.includes('\\')) throw new Error(`${label} must use normalized repository separators`)
  if (value.includes('\0')) throw new Error(`${label} contains a NUL byte`)
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || (!gitPath && value.includes(':'))) throw new Error(`${label} must be repository-relative`)
  if (value.endsWith('/') || value.split('/').some((part) => part === '' || part === '.' || part === '..')) throw new Error(`${label} must be an exact normalized file path`)
  if (value.split('/').some((part) => part.toLowerCase() === '.git') || value.toLowerCase() === '.git') throw new Error(`${label} cannot access Git control data`)
  if (!gitPath && /[\*\?\[\]\{\}]/.test(value)) throw new Error(`${label} cannot contain a glob pattern`)
  const normalized = path.posix.normalize(value)
  if (normalized !== value || normalized === '.' || normalized === '..' || normalized.startsWith('../')) throw new Error(`${label} must be an exact normalized file path`)
  return normalized
}

function validateRootPath(cwd, value, label) {
  const relative = normalizePath(value, label)
  const absolute = path.resolve(cwd, relative)
  const inside = path.relative(path.resolve(cwd), absolute)
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error(`${label} must stay inside the repository root`)
  return relative
}

function runGit(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  } catch {
    throw commandError(`git operation failed: ${args[0] ?? 'unknown'}`)
  }
}

function gitText(cwd, args) { return text(runGit(cwd, args)) }

function repositoryRoot(cwd) {
  const candidate = path.resolve(cwd)
  const top = gitText(candidate, ['rev-parse', '--show-toplevel']).trim()
  if (!top) throw commandError('cwd must be inside a Git repository')
  return path.resolve(top)
}

function treeEntries(cwd, revision) {
  const entries = new Map()
  for (const token of nullDelimited(runGit(cwd, ['ls-tree', '-r', '-z', revision]))) {
    const match = token.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)\t([\s\S]*)$/i)
    if (!match) continue
    const file = normalizePath(match[4], 'Git tree path', { gitPath: true })
    entries.set(file, { mode: match[1], type: match[2], oid: match[3] })
  }
  return entries
}

function trackedPaths(cwd) {
  return new Set(nullDelimited(runGit(cwd, ['ls-files', '-z'])).map((file) => normalizePath(file, 'Git index path', { gitPath: true })))
}

function otherPaths(cwd, ignored) {
  const args = ignored
    ? ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']
    : ['ls-files', '-z', '--others', '--exclude-standard']
  return new Set(nullDelimited(runGit(cwd, args)).map((file) => file.endsWith('/') ? file.slice(0, -1) : file).filter(Boolean).map((file) => normalizePath(file, 'Git worktree path', { gitPath: true })))
}

function localInventory(cwd, headEntries) {
  const tracked = trackedPaths(cwd)
  const untracked = otherPaths(cwd, false)
  const ignored = otherPaths(cwd, true)
  const paths = new Set([...headEntries.keys(), ...tracked, ...untracked, ...ignored])
  const result = new Map()
  for (const file of paths) {
    const classification = tracked.has(file) || headEntries.has(file)
      ? 'tracked'
      : untracked.has(file)
        ? 'untracked'
        : ignored.has(file)
          ? 'ignored'
          : 'unknown'
    result.set(file, classification)
  }
  return { paths: result, tracked, untracked, ignored }
}

function registryFromJson(raw, label) {
  let value
  try { value = JSON.parse(raw) } catch { throw new Error(`${label} is not valid JSON`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  if (Object.keys(value).sort().join('\0') !== 'entries\0version' || value.version !== 1 || !Array.isArray(value.entries)) {
    throw new Error(`${label} must have exactly version 1 and entries`)
  }
  const entries = new Map()
  value.entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).sort().join('\0') !== REGISTRY_FIELDS.slice().sort().join('\0')) {
      throw new Error(`${label} entry ${index} has an invalid schema`)
    }
    const file = normalizePath(entry.path, `${label} entry ${index} path`)
    if (!REGISTRY_CATEGORIES.has(entry.category)) throw new Error(`${label} entry ${index} has an invalid category`)
    if (typeof entry.owner !== 'string' || !entry.owner.trim()) throw new Error(`${label} entry ${index} owner is required`)
    if (typeof entry.evidence !== 'string' || !entry.evidence.trim()) throw new Error(`${label} entry ${index} evidence is required`)
    if (typeof entry.reviewBy !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewBy)) throw new Error(`${label} entry ${index} reviewBy must be YYYY-MM-DD`)
    const date = new Date(`${entry.reviewBy}T00:00:00.000Z`)
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== entry.reviewBy) throw new Error(`${label} entry ${index} reviewBy is not a valid date`)
    if (entries.has(file)) throw new Error(`${label} contains duplicate path ${file}`)
    entries.set(file, { path: file, category: entry.category, owner: entry.owner, reviewBy: entry.reviewBy, evidence: entry.evidence })
  })
  return entries
}

function registryAt(cwd, revision, relative) {
  const tree = treeEntries(cwd, revision)
  const entry = tree.get(relative)
  if (!entry) return new Map()
  if (entry.mode !== '100644' && entry.mode !== '100755') throw new Error(`registry at ${revision} is not a regular file`)
  return registryFromJson(gitText(cwd, ['show', `${revision}:${relative}`]), `registry at ${revision}`)
}

function localRegistry(cwd, relative) {
  const target = path.resolve(cwd, relative)
  let targetStat
  try { targetStat = lstatSync(target) } catch (error) {
    if (error.code === 'ENOENT') return new Map()
    throw new Error(`registry cannot be inspected: ${relative}`)
  }
  if (targetStat.isSymbolicLink()) throw new Error(`registry must be a regular file: ${relative}`)
  const root = path.resolve(cwd)
  const segments = relative.split('/')
  let current = root
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment)
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`registry path has a symbolic-link ancestor: ${relative}`) } catch (error) {
      if (error.message.includes('symbolic-link')) throw error
    }
  }
  if (!targetStat.isFile()) throw new Error(`registry must be a regular file: ${relative}`)
  return registryFromJson(readFileSync(target, 'utf8'), `registry ${relative}`)
}

function localRegularFile(cwd, relative) {
  let current = path.resolve(cwd)
  const parts = relative.split('/')
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index])
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`registry entry traverses a symbolic link: ${relative}`)
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`registry entry has a non-directory ancestor: ${relative}`)
    if (index === parts.length - 1 && !stat.isFile()) throw new Error(`registry entry must point to a regular file: ${relative}`)
  }
}

function fullSha(value, label) {
  if (!FULL_SHA.test(String(value ?? ''))) throw new Error(`${label} must be a full commit SHA`)
  return String(value).toLowerCase()
}

function authoritativeRange(cwd, base, head) {
  if ((base && !head) || (!base && head)) throw new Error('--base and --head must be supplied together')
  if (!base && !head) return undefined
  const normalizedBase = fullSha(base, '--base')
  const normalizedHead = fullSha(head, '--head')
  if (normalizedBase === normalizedHead) throw new Error('--base and --head must be distinct commits')
  runGit(cwd, ['cat-file', '-e', `${normalizedBase}^{commit}`])
  runGit(cwd, ['cat-file', '-e', `${normalizedHead}^{commit}`])
  const checkedOut = gitText(cwd, ['rev-parse', 'HEAD']).trim().toLowerCase()
  if (checkedOut !== normalizedHead) throw new Error('--head must match checked-out HEAD')
  try { runGit(cwd, ['merge-base', '--is-ancestor', normalizedBase, normalizedHead]) } catch { throw new Error('--base must be a strict ancestor of --head') }
  return { base: normalizedBase, head: normalizedHead }
}

function pathRule(file) {
  return PATH_RULES.find((rule) => rule.test(file))
}

function statusFor(file, inventory, authoritative) {
  if (authoritative) return inventory.has(file) ? 'tracked' : 'unknown'
  return inventory.get(file) ?? 'unknown'
}

function identityFor(file, category, rule) { return `${category}:${rule}:${file}` }

function finding({ file, category, rule, stage, suggestedAction, status, history, changed = false, severity = 'advisory', owner, reviewBy, evidence }) {
  const historical = history === 'historical'
  return {
    path: file,
    classification: status,
    status,
    category,
    rule,
    stage,
    suggestedAction,
    history,
    new: history === 'new',
    historical,
    changed,
    severity,
    identity: identityFor(file, category, rule),
    ...(owner ? { owner } : {}),
    ...(reviewBy ? { reviewBy } : {}),
  }
}

function localSuggestedAction(status) {
  if (status === 'ignored') return 'Review the ignored local directory scope and keep it excluded from repository history; no mutation is required.'
  if (status === 'untracked') return 'Review the untracked local directory scope and keep it out of repository history unless intentionally promoted after review.'
  return undefined
}

function isExpired(reviewBy, now) {
  const today = new Date(now).toISOString().slice(0, 10)
  return reviewBy < today
}

function evaluateHygieneCore({
  cwd = process.cwd(),
  command = 'audit',
  stage,
  base,
  head,
  configPath = '.governance.yml',
  registryPath = '.governance-hygiene.json',
  ci = /^(?:1|true|yes)$/i.test(process.env.CI ?? '') || /^(?:1|true|yes)$/i.test(process.env.GITHUB_ACTIONS ?? '') || /^(?:1|true|yes)$/i.test(process.env.RELEASE ?? ''),
  now = new Date(),
} = {}) {
  const root = repositoryRoot(cwd)
  const action = command || 'audit'
  if (!['audit', 'plan', 'check'].includes(action)) throw new Error(`unknown hygiene command: ${action}`)
  const selectedStage = stage ?? (action === 'audit' ? 'task-start' : action === 'plan' ? 'task-end' : 'pr')
  if (!STAGES.has(selectedStage)) throw new Error(`invalid hygiene stage: ${selectedStage}`)
  if (action === 'check' && (!base || !head)) throw new Error('check requires an immutable --base and --head range')
  if (action === 'check' && !['pr', 'release'].includes(selectedStage)) throw new Error('check only supports the pr or release stages')
  const range = authoritativeRange(root, base, head)
  if (ci && !range) throw new Error('CI cannot run hygiene in local mode; pass full --base and --head')
  const config = validateRootPath(root, configPath, '--config')
  const registry = validateRootPath(root, registryPath, '--registry')
  if (registry !== '.governance-hygiene.json') throw new Error('--registry is fixed to the repository root .governance-hygiene.json')
  const authoritative = Boolean(range)
  const headRevision = authoritative ? range.head : 'HEAD'
  const baseRevision = authoritative ? range.base : 'HEAD'
  const headEntries = treeEntries(root, headRevision)
  const baseEntries = authoritative ? treeEntries(root, baseRevision) : headEntries
  const inventorySnapshot = authoritative ? { paths: new Map([...headEntries.keys()].map((file) => [file, 'tracked'])), tracked: new Set(headEntries.keys()), untracked: new Set(), ignored: new Set() } : localInventory(root, headEntries)
  const inventory = inventorySnapshot.paths
  const headRegistry = authoritative ? registryAt(root, headRevision, registry) : localRegistry(root, registry)
  const baseRegistry = authoritative ? registryAt(root, baseRevision, registry) : headRegistry
  const findings = []
  const errors = []
  for (const file of headRegistry.keys()) {
    const treeEntry = headEntries.get(file)
    if (authoritative) {
      if (!treeEntry) errors.push(`registry entry points to a missing file at ${headRevision}: ${file}`)
      else if (!/^100(?:644|755)$/.test(treeEntry.mode) || treeEntry.type !== 'blob') errors.push(`registry entry must point to a regular file at ${headRevision}: ${file}`)
    } else {
      try { localRegularFile(root, file) }
      catch (error) { errors.push(error.code === 'ENOENT' ? `registry entry points to a missing file: ${file}` : error.message) }
    }
  }
  const seen = new Set()
  const allPaths = new Set([...headEntries.keys(), ...headRegistry.keys(), ...inventory.keys()])
  for (const file of allPaths) {
    const rule = pathRule(file)
    const registered = headRegistry.get(file) ?? baseRegistry.get(file)
    const baseEntry = baseEntries.get(file)
    const headEntry = headEntries.get(file)
    if (!rule && !registered) continue
    const category = rule?.category ?? registered?.category
    const baseRegistryEntry = baseRegistry.get(file)
    const headRegistryEntry = headRegistry.get(file)
    const status = statusFor(file, inventory, authoritative)
    const pathExistsInHead = authoritative ? Boolean(headEntry) : status !== 'unknown'
    const isNew = authoritative ? !baseEntry : !baseEntries.has(file)
    const changed = authoritative && Boolean(baseEntry && headEntry && (baseEntry.oid !== headEntry.oid || baseEntry.mode !== headEntry.mode || baseEntry.type !== headEntry.type))
    const history = isNew ? 'new' : 'historical'
    const activeRule = rule?.rule ?? `registered-${registered.category}`
    const builtIn = Boolean(rule)
    let severity = authoritative && builtIn && rule.mandatory ? (isNew ? 'blocker' : changed ? 'blocker' : 'advisory') : 'advisory'
    let findingRule = builtIn ? activeRule : `registered-${registered.category}`
    let actionText = registered ? 'Review the registered path and retain explicit ownership evidence; the registry does not waive a hygiene blocker.' : 'Remove the committed hygiene violation or move it to an approved ignored location after review.'
    if (builtIn && isNew && (authoritative || status === 'tracked')) {
      findingRule = category === 'generated' ? 'new-generated-file' : category === 'experimental' ? 'new-experimental-file' : category === 'debug' ? 'new-debug-probe' : activeRule
      actionText = 'Remove the new committed contamination or move it to an approved ignored location after review.'
    } else if (builtIn && changed) {
      findingRule = 'changed-legacy-artifact'
      actionText = 'Review the legacy artifact change and document why it remains committed.'
    }
    if (!authoritative) actionText = localSuggestedAction(status) ?? actionText
    if (registered && !headRegistryEntry && pathExistsInHead && authoritative) {
      severity = 'blocker'
      findingRule = 'registry-retention'
      actionText = 'Retain the inherited registry entry and update it with review evidence before changing the debt record.'
    }
    if (pathExistsInHead && category && !seen.has(file)) {
      const item = finding({ file, category, rule: findingRule, stage: selectedStage, suggestedAction: actionText, status, history, changed, severity, owner: registered?.owner, reviewBy: registered?.reviewBy, evidence: registered?.evidence })
      findings.push(item)
      seen.add(file)
    }
    if (registered && pathExistsInHead && selectedStage === 'release' && isExpired(registered.reviewBy, now)) {
      findings.push(finding({ file, category: registered.category, rule: 'review-expired', stage: selectedStage, suggestedAction: 'Complete the explicit review gate or renew the registry entry with current evidence; no automatic deletion is permitted.', status, history, changed, severity: 'blocker', owner: registered.owner, reviewBy: registered.reviewBy, evidence: registered.evidence }))
    }
    if (authoritative && baseRegistryEntry && !headRegistryEntry && pathExistsInHead && !seen.has(file)) {
      findings.push(finding({ file, category: baseRegistryEntry.category, rule: 'registry-retention', stage: selectedStage, suggestedAction: 'Restore the inherited registry entry with review evidence before changing the debt record.', status, history, changed, severity: 'blocker', owner: baseRegistryEntry.owner, reviewBy: baseRegistryEntry.reviewBy, evidence: baseRegistryEntry.evidence }))
      seen.add(`${file}:retention`)
    }
  }
  if (authoritative) {
    for (const [file, entry] of baseRegistry) {
      if (headRegistry.has(file) || !headEntries.has(file) || seen.has(file) || seen.has(`${file}:retention`)) continue
      findings.push(finding({ file, category: entry.category, rule: 'registry-retention', stage: selectedStage, suggestedAction: 'Retain the inherited registry entry and record explicit review evidence before changing the debt record.', status: headEntries.has(file) ? 'tracked' : 'unknown', history: 'historical', severity: 'blocker', owner: entry.owner, reviewBy: entry.reviewBy, evidence: entry.evidence }))
      seen.add(`${file}:retention`)
    }
  }
  for (const [file, entry] of headRegistry) {
    const present = authoritative ? headEntries.has(file) : inventory.has(file)
    if (!present) {
      findings.push(finding({ file, category: entry.category, rule: 'registry-path-unknown', stage: selectedStage, suggestedAction: 'Review the registry entry and its missing target; registry evidence does not authorize deletion.', status: 'unknown', history: authoritative && baseRegistry.has(file) ? 'historical' : 'new', severity: 'advisory', owner: entry.owner, reviewBy: entry.reviewBy, evidence: entry.evidence }))
    }
  }
  const blockers = (selectedStage === 'pr' || selectedStage === 'release') ? findings.filter((item) => item.severity === 'blocker') : []
  const advisories = findings.filter((item) => item.severity !== 'blocker')
  return {
    command: action,
    stage: selectedStage,
    mode: authoritative ? 'range' : 'local',
    base: authoritative ? range.base : undefined,
    head: authoritative ? range.head : undefined,
    config,
    registry,
    findings,
    blockers,
    advisories,
    inventory: {
      tracked: [...inventorySnapshot.tracked],
      untracked: [...inventorySnapshot.untracked],
      ignored: [...inventorySnapshot.ignored],
    },
    range: authoritative ? { base: range.base, head: range.head } : undefined,
    dirty: (() => { try { return gitText(root, ['status', '--porcelain=v1', '-z']).length > 0 } catch { return false } })(),
    errors,
    code: errors.length ? 2 : blockers.length ? 1 : 0,
  }
}

function evaluateHygiene(options = {}) {
  try {
    return evaluateHygieneCore(options)
  } catch (error) {
    return {
      command: options.command ?? 'audit',
      stage: options.stage,
      mode: options.base || options.head ? 'range' : 'local',
      findings: [],
      blockers: [],
      advisories: [],
      errors: [String(error?.message ?? error)],
      code: error?.exitCode ?? 2,
    }
  }
}

function runHygiene(options = {}) { return evaluateHygiene(options) }

function optionValue(args, flag) {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`))
  if (inline) return inline.slice(flag.length + 1)
  const index = args.indexOf(flag)
  if (index >= 0) return args[index + 1]
  return undefined
}

function parseCli(args) {
  const command = args[0] ?? 'audit'
  const flags = new Set(['--stage', '--base', '--head', '--format', '--config', '--registry'])
  const seen = new Set()
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) throw commandError(`unexpected positional argument: ${arg}`)
    const name = arg.split('=', 1)[0]
    if (name === '--help') continue
    if (!flags.has(name)) throw commandError(`unknown option: ${name}`)
    if (seen.has(name)) throw commandError(`${name} may be supplied only once`)
    seen.add(name)
    if (arg.includes('=')) {
      if (!arg.slice(name.length + 1)) throw commandError(`${name} requires a value`)
      continue
    }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw commandError(`${name} requires a non-flag value`)
    index += 1
  }
  const format = optionValue(args, '--format') ?? 'text'
  if (!FORMATS.has(format)) throw commandError(`invalid format: ${format}`)
  return { command, stage: optionValue(args, '--stage'), base: optionValue(args, '--base'), head: optionValue(args, '--head'), format, configPath: optionValue(args, '--config') ?? '.governance.yml', registryPath: optionValue(args, '--registry') ?? '.governance-hygiene.json' }
}

function printResult(result, format) {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  for (const error of result.errors ?? []) process.stderr.write(`FAIL ${error}\n`)
  process.stdout.write(`${result.command} stage=${result.stage} mode=${result.mode} findings=${result.findings.length}\n`)
  for (const item of result.findings) process.stdout.write(`${item.severity.toUpperCase()} ${item.path} category=${item.category} rule=${item.rule} classification=${item.classification} history=${item.history} action=${item.suggestedAction}\n`)
}

function runHygieneCli(args = [], { cwd = process.cwd() } = {}) {
  try {
    const parsed = parseCli(args)
    const result = runHygiene({ cwd, ...parsed })
    return { ...result, format: parsed.format }
  } catch (error) {
    return { command: args[0] ?? 'audit', findings: [], blockers: [], advisories: [], errors: [String(error?.message ?? error)], code: error?.exitCode ?? 2, format: optionValue(args, '--format') ?? 'text' }
  }
}

function usage() {
  return 'Usage: repository-hygiene.mjs audit|plan|check [--stage task-start|task-end|pr|release|maintenance] [--base FULL --head FULL] [--format text|json] [--config .governance.yml] [--registry .governance-hygiene.json]'
}

function main() {
  try {
    const args = process.argv.slice(2)
    if (args.includes('--help') || args.includes('-h')) { process.stdout.write(`${usage()}\n`); return }
    const parsed = parseCli(args)
    const result = runHygiene({ cwd: process.cwd(), ...parsed })
    printResult(result, parsed.format)
    process.exitCode = result.code
  } catch (error) {
    const format = process.argv.includes('--format=json') || optionValue(process.argv.slice(2), '--format') === 'json' ? 'json' : 'text'
    const payload = { command: process.argv[2] ?? 'audit', stage: optionValue(process.argv.slice(2), '--stage'), findings: [], blockers: [], advisories: [], errors: [error.message], code: error.exitCode ?? 2 }
    if (format === 'json') process.stdout.write(`${JSON.stringify(payload)}\n`)
    else process.stderr.write(`FAIL ${error.message}\n`)
    process.exitCode = payload.code
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()

export { evaluateHygiene, runHygiene, runHygieneCli }
