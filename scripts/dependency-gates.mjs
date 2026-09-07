#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import pathPosix from 'node:path/posix';
import { fileURLToPath } from 'node:url';
import { loadGovernanceConfig, parseGovernanceYaml } from './config.mjs';

const args = process.argv.slice(2);
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;

function inputError(message) {
  console.error(`FAIL dependency gate input: ${message}`);
  process.exitCode = 2;
}

function normalizePath(value, label = 'path') {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  let normalized = pathPosix.normalize(value.trim().replaceAll('\\', '/'));
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (pathPosix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized) || normalized.startsWith('//')) {
    throw new Error(`${label} must be repository-relative`);
  }
  return normalized;
}

function normalizeEdge(edge, label) {
  if (Array.isArray(edge) && edge.length === 2) return { from: normalizePath(edge[0], `${label}.from`), to: normalizePath(edge[1], `${label}.to`) };
  if (edge && typeof edge === 'object' && typeof edge.from === 'string' && typeof edge.to === 'string') {
    return { from: normalizePath(edge.from, `${label}.from`), to: normalizePath(edge.to, `${label}.to`) };
  }
  throw new Error(`${label} must contain {from, to} pairs`);
}

function edgeKey({ from, to }) { return `${from}\0${to}`; }
function identity(rule, { from, to }) { return `${rule}\0${from}\0${to}`; }

function normalizeToolViolation(violation, label) {
  if (!violation || typeof violation !== 'object' || Array.isArray(violation)) throw new Error(`${label} must be an object`);
  const result = { ...violation };
  if (result.rule && typeof result.rule === 'object' && !Array.isArray(result.rule)) {
    if (typeof result.rule.name !== 'string' || !result.rule.name.trim()) throw new Error(`${label}.rule.name must be a non-empty string`);
    result.ruleSeverity = result.rule.severity;
    result.rule = result.rule.name;
  }
  if (typeof result.from === 'string') result.from = normalizePath(result.from, `${label}.from`);
  if (typeof result.to === 'string') result.to = normalizePath(result.to, `${label}.to`);
  return result;
}

function graphFromDependencyCruiser(report) {
  if (!Array.isArray(report.modules)) return undefined;
  const nodes = new Set();
  const edges = [];
  const toolViolations = Array.isArray(report.summary?.violations)
    ? [...report.summary.violations]
    : report.violations ?? [];
  if (!Array.isArray(toolViolations)) throw new Error('dependency-cruiser report violations must be an array');

  report.modules.forEach((module, moduleIndex) => {
    if (!module || typeof module !== 'object' || typeof module.source !== 'string') {
      throw new Error(`modules[${moduleIndex}] must contain a source path`);
    }
    const source = normalizePath(module.source, `modules[${moduleIndex}].source`);
    nodes.add(source);
    if (module.dependencies !== undefined && !Array.isArray(module.dependencies)) {
      throw new Error(`modules[${moduleIndex}].dependencies must be an array`);
    }
    for (const [dependencyIndex, dependency] of (module.dependencies ?? []).entries()) {
      if (!dependency || typeof dependency !== 'object') throw new Error(`modules[${moduleIndex}].dependencies[${dependencyIndex}] must be an object`);
      const target = typeof dependency.resolved === 'string'
        ? normalizePath(dependency.resolved, `modules[${moduleIndex}].dependencies[${dependencyIndex}].resolved`)
        : typeof dependency.module === 'string'
          ? normalizePath(dependency.module, `modules[${moduleIndex}].dependencies[${dependencyIndex}].module`)
          : undefined;
      if (dependency.couldNotResolve || !target) {
        toolViolations.push({
          rule: 'unresolved-import',
          from: source,
          to: target ?? String(dependency.module ?? dependency.source ?? '<unresolved>'),
          message: dependency.couldNotResolve ? 'dependency could not be resolved' : 'dependency has no resolved target',
        });
        continue;
      }
      if (dependency.core) continue;
      nodes.add(target);
      edges.push({ from: source, to: target });
    }
  });
  const normalizedViolations = toolViolations.map((violation, index) => normalizeToolViolation(violation, `violations[${index}]`));
  return {
    nodes: [...nodes],
    edges,
    forbiddenDependencies: normalizedViolations
      .filter((violation) => FORBIDDEN_RULES.has(violation.rule) && violation.from && violation.to)
      .map(({ from, to }) => ({ from, to })),
    toolViolations: normalizedViolations,
    provenance: report.provenance,
    metadata: report.metadata,
    meta: report.meta,
  };
}

function normalizeFixtureGraph(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('graph must be a JSON object');
  if (!Object.hasOwn(report, 'edges') && !Object.hasOwn(report, 'dependencies')) {
    throw new Error('report must be dependency-cruiser JSON with modules or a fixture graph with edges');
  }
  if (!Array.isArray(report.edges ?? report.dependencies ?? [])) throw new Error('edges must be an array');
  if (report.nodes !== undefined && !Array.isArray(report.nodes)) throw new Error('nodes must be an array');
  const edges = (report.edges ?? report.dependencies ?? []).map((edge, index) => normalizeEdge(edge, `edges[${index}]`));
  const forbiddenDependencies = (report.forbidden_dependencies ?? report.forbiddenDependencies ?? []).map((edge, index) => normalizeEdge(edge, `forbidden_dependencies[${index}]`));
  const violations = report.summary?.violations ?? report.violations ?? [];
  if (!Array.isArray(violations)) throw new Error('report violations must be an array');
  const nodes = new Set((report.nodes ?? []).map((node, index) => normalizePath(node, `nodes[${index}]`)));
  for (const edge of [...edges, ...forbiddenDependencies]) { nodes.add(edge.from); nodes.add(edge.to); }
  const normalizedViolations = violations.map((violation, index) => normalizeToolViolation(violation, `violations[${index}]`));
  return {
    nodes: [...nodes],
    edges,
    forbiddenDependencies: [...forbiddenDependencies, ...normalizedViolations
      .filter((violation) => FORBIDDEN_RULES.has(violation.rule) && violation.from && violation.to)
      .map(({ from, to }) => ({ from, to }))],
    toolViolations: normalizedViolations,
    provenance: report.provenance,
    metadata: report.metadata,
    meta: report.meta,
  };
}

function normalizeReport(report, label = 'report') {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error(`${label} must be a JSON object`);
  const graph = graphFromDependencyCruiser(report) ?? normalizeFixtureGraph(report);
  if (!graph.nodes.length && !graph.edges.length) throw new Error(`${label} is empty`);
  return graph;
}

function loadReport(file) {
  if (!file) throw new Error('report path is required');
  let report;
  try { report = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    throw new Error(`unable to read report ${file}: ${error.message}`);
  }
  return report;
}

function normalizeAllowedRules(value) {
  const allowedRules = value === undefined ? [] : value;
  if (!Array.isArray(allowedRules) || allowedRules.some((rule) => !['no-cycle', 'no-forbidden-dependencies'].includes(rule))) {
    throw new Error('baseline.allowed_rules must contain only no-cycle and no-forbidden-dependencies');
  }
  if (new Set(allowedRules).size !== allowedRules.length) throw new Error('baseline.allowed_rules must not contain duplicates');
  return [...allowedRules];
}

/** Return the dependency policy represented by a parsed governance document. */
export function dependencyPolicy(config = {}) {
  const normalized = config?.noCycles !== undefined || config?.noForbidden !== undefined || config?.forbiddenDependencies !== undefined;
  const architecture = config?.checks?.architecture ?? config?.architecture ?? (normalized ? config : {});
  const baseline = config?.baseline ?? (normalized ? config : {});
  const mode = config?.mode ?? baseline.mode ?? 'strict';
  if (!['strict', 'ratchet'].includes(mode)) throw new Error('baseline.mode must be strict or ratchet');
  const forbidden = architecture.forbidden_dependencies ?? architecture.forbiddenDependencies ?? [];
  if (!Array.isArray(forbidden)) throw new Error('architecture.forbidden_dependencies must be an array');
  const allowedRules = normalizeAllowedRules(config?.allowedRules ?? config?.allowed_rules ?? baseline.allowed_rules);
  return {
    mode,
    allowedRules,
    allowed_rules: [...allowedRules],
    required: architecture.require_dependency_graph === true,
    noCycles: normalized ? architecture.noCycles !== false : architecture.no_new_cycles !== false,
    noForbidden: normalized ? architecture.noForbidden !== false : architecture.no_new_forbidden_dependencies !== false,
    forbiddenDependencies: (normalized ? (config.forbiddenDependencies ?? []) : forbidden).map((edge, index) => normalizeEdge(edge, `${normalized ? 'forbiddenDependencies' : 'architecture.forbidden_dependencies'}[${index}]`)),
  };
}

function loadPolicy(file) {
  if (!file) return dependencyPolicy();
  const raw = fs.readFileSync(file, 'utf8');
  const candidate = parseGovernanceYaml(raw);
  const profilesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'profiles');
  const loaded = candidate.governance ? loadGovernanceConfig(file, { profilesDir }) : undefined;
  if (loaded?.errors.length) throw new Error(loaded.errors.join('; '));
  return dependencyPolicy(loaded?.config ?? candidate);
}

function findCyclicEdges(graph) {
  const adjacency = new Map(graph.nodes.map((node) => [node, []]));
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
    adjacency.get(edge.from).push(edge.to);
  }
  let nextIndex = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  function visit(node) {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(next)));
      } else if (onStack.has(next)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(next)));
      }
    }
    if (lowLinks.get(node) === indices.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      components.push(new Set(component));
    }
  }
  for (const node of adjacency.keys()) if (!indices.has(node)) visit(node);
  const cyclicEdges = new Map();
  for (const component of components) {
    for (const edge of graph.edges) {
      if (component.has(edge.from) && component.has(edge.to) && (component.size > 1 || edge.from === edge.to)) {
        cyclicEdges.set(edgeKey(edge), edge);
      }
    }
  }
  return [...cyclicEdges.values()];
}

// Kept for the original diagnostic CLI and fixture API.
export function findCycles(graph) {
  const normalized = graph?.nodes && graph?.edges ? graph : normalizeReport(graph);
  return findCyclicEdges(normalized).map(({ from, to }) => [from, to]);
}

const CIRCULAR_RULES = new Set(['no-circular-source-dependencies', 'no-circular']);
const FORBIDDEN_RULES = new Set(['no-forbidden-dependencies', 'no-forbidden-dependency']);

function toolViolationsFor(graph, cycleEdges, forbiddenEdges) {
  const hard = [];
  for (const violation of graph.toolViolations ?? []) {
    const rule = typeof violation.rule === 'string' ? violation.rule : '';
    if (CIRCULAR_RULES.has(rule)) {
      if (violation.from && violation.to) {
        const key = edgeKey({ from: violation.from, to: violation.to });
        if (!cycleEdges.some((edge) => edgeKey(edge) === key)) hard.push({ ...violation, reason: 'circular violation is not represented by the report graph' });
      } else if (!cycleEdges.length) hard.push({ ...violation, reason: 'circular violation has no cyclic graph edges' });
      continue;
    }
    if (FORBIDDEN_RULES.has(rule)) {
      if (violation.from && violation.to) {
        const key = edgeKey({ from: violation.from, to: violation.to });
        if (!graph.edges.some((edge) => edgeKey(edge) === key)) hard.push({ ...violation, reason: 'forbidden violation is not represented by the report graph' });
      } else hard.push({ ...violation, reason: 'forbidden violation has no dependency edge' });
      continue;
    }
    hard.push(violation);
  }
  return hard;
}

function formatToolViolation(violation) {
  const edge = typeof violation.from === 'string' && typeof violation.to === 'string'
    ? `${violation.from} -> ${violation.to}`
    : JSON.stringify(violation);
  const rule = typeof violation.rule === 'string' ? ` (${violation.rule})` : '';
  return `dependency-cruiser violation: ${edge}${rule}`;
}

function stablePolicy(policy) {
  return JSON.stringify({
    mode: policy.mode,
    allowedRules: [...policy.allowedRules].sort(),
    noCycles: policy.noCycles,
    noForbidden: policy.noForbidden,
    forbiddenDependencies: [...policy.forbiddenDependencies].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
  });
}

const PROVENANCE_FIELDS = ['trustedPolicy', 'trustedPolicyHash', 'policyHash', 'scannerVersion', 'toolVersion', 'configurationHash', 'configHash', 'toolConfigHash'];

function reportProvenance(report) {
  const result = {};
  for (const source of [report?.provenance, report?.metadata, report?.meta]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const field of PROVENANCE_FIELDS) if (source[field] !== undefined) result[field] = source[field];
  }
  for (const field of PROVENANCE_FIELDS) if (report?.[field] !== undefined) result[field] = report[field];
  return result;
}

function assertMatchingProvenance(base, head) {
  const baseProvenance = reportProvenance(base);
  const headProvenance = reportProvenance(head);
  for (const field of new Set([...Object.keys(baseProvenance), ...Object.keys(headProvenance)])) {
    if (JSON.stringify(baseProvenance[field]) !== JSON.stringify(headProvenance[field])) {
      throw new Error(`base and head report provenance differ for ${field}`);
    }
  }
}

/**
 * Evaluate fresh dependency reports without filesystem or process side effects.
 * In ratchet mode only exact, allowed identities present in the base report are grandfathered.
 */
export function evaluateDependencyReports({ headReport, baseReport, policy = dependencyPolicy(), basePolicy, headPolicy } = {}) {
  const normalizedPolicy = dependencyPolicy(headPolicy ?? policy);
  const normalizedBasePolicy = dependencyPolicy(basePolicy ?? policy);
  const head = normalizeReport(headReport, 'head report');
  if (normalizedPolicy.mode === 'ratchet' && baseReport === undefined) throw new Error('ratchet mode requires --base-input');
  const base = normalizedPolicy.mode === 'ratchet' && baseReport !== undefined ? normalizeReport(baseReport, 'base report') : undefined;
  if (base) assertMatchingProvenance(base, head);
  const headCycleEdges = normalizedPolicy.noCycles ? findCyclicEdges(head) : [];
  const baseCycleEdges = base && normalizedBasePolicy.noCycles ? findCyclicEdges(base) : [];
  const headForbiddenEdges = normalizedPolicy.noForbidden
    ? [...normalizedPolicy.forbiddenDependencies, ...head.forbiddenDependencies].filter((edge, index, list) => list.findIndex((candidate) => edgeKey(candidate) === edgeKey(edge)) === index && head.edges.some((candidate) => edgeKey(candidate) === edgeKey(edge)))
    : [];
  const baseForbiddenEdges = base && normalizedBasePolicy.noForbidden
    ? [...normalizedBasePolicy.forbiddenDependencies, ...base.forbiddenDependencies].filter((edge, index, list) => list.findIndex((candidate) => edgeKey(candidate) === edgeKey(edge)) === index && base.edges.some((candidate) => edgeKey(candidate) === edgeKey(edge)))
    : [];
  const headViolations = new Set();
  const baseViolations = new Set();
  for (const edge of headCycleEdges) headViolations.add(identity('no-cycle', edge));
  for (const edge of baseCycleEdges) baseViolations.add(identity('no-cycle', edge));
  for (const edge of headForbiddenEdges) headViolations.add(identity('no-forbidden-dependencies', edge));
  for (const edge of baseForbiddenEdges) baseViolations.add(identity('no-forbidden-dependencies', edge));
  const hardHead = toolViolationsFor(head, headCycleEdges, headForbiddenEdges);
  const hardBase = base ? toolViolationsFor(base, baseCycleEdges, baseForbiddenEdges) : [];
  const hardViolations = [];
  const hardKeys = new Set();
  for (const violation of [...hardHead, ...hardBase.map((item) => ({ ...item, report: 'base' }))]) {
    const key = formatToolViolation(violation);
    if (!hardKeys.has(key)) { hardKeys.add(key); hardViolations.push(violation); }
  }
  const headIdentityList = [...headViolations].sort();
  const baseIdentityList = [...baseViolations].sort();
  const newViolations = normalizedPolicy.mode === 'ratchet'
    ? headIdentityList.filter((item) => !normalizedPolicy.allowedRules.includes(item.split('\0', 1)[0]) || !baseViolations.has(item))
    : headIdentityList;
  const grandfathered = normalizedPolicy.mode === 'ratchet'
    ? headIdentityList.filter((item) => normalizedPolicy.allowedRules.includes(item.split('\0', 1)[0]) && baseViolations.has(item))
    : [];
  const errors = [];
  for (const violation of hardViolations) errors.push(formatToolViolation(violation));
  for (const item of newViolations) {
    const [rule, from, to] = item.split('\0');
    errors.push(rule === 'no-cycle' ? `dependency cycle detected: ${from} -> ${to}` : `forbidden dependency: ${from} -> ${to}`);
  }
  return {
    passed: errors.length === 0,
    ok: errors.length === 0,
    mode: normalizedPolicy.mode,
    errors,
    headViolations: headIdentityList,
    baseViolations: baseIdentityList,
    newViolations,
    grandfathered,
    violations: headIdentityList,
    newViolationIdentities: newViolations,
    grandfatheredIdentities: grandfathered,
    hardViolations,
    headReport: head,
    baseReport: base,
  };
}

function main() {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: dependency-gates.mjs [--config .governance.yml] [--input head-report.json] [--base-input base-report.json]');
    return;
  }
  const input = option('--input');
  const baseInput = option('--base-input');
  const config = option('--config');
  if (args.some((arg, index) => ['--input', '--base-input', '--config'].includes(arg) && (!args[index + 1] || args[index + 1].startsWith('--')))) {
    inputError('an option is missing its file path');
    return;
  }
  if (baseInput && !input) { inputError('--base-input requires --input'); return; }
  try {
    const policy = config ? loadPolicy(path.resolve(process.cwd(), config)) : loadPolicy();
    if (!input) {
      if (policy.mode === 'ratchet') { inputError('ratchet mode requires --input and --base-input'); return; }
      if (policy.required) { console.error('FAIL dependency graph is required; pass --input generated by dependency-cruiser'); process.exitCode = 1; }
      else console.log('SKIP dependency gates (no generated dependency report supplied)');
      return;
    }
    const result = evaluateDependencyReports({
      headReport: loadReport(path.resolve(process.cwd(), input)),
      baseReport: baseInput ? loadReport(path.resolve(process.cwd(), baseInput)) : undefined,
      policy,
    });
    if (result.grandfathered.length) {
      result.grandfathered.forEach((item) => console.log(`INFO grandfathered dependency violation: ${item.replaceAll('\0', ' -> ')}`));
    }
    if (result.errors.length) {
      result.errors.forEach((error) => console.error(`FAIL ${error}`));
      process.exitCode = 1;
    } else {
      console.log(`PASS dependency gates (mode=${result.mode}, nodes=${result.headReport.nodes.length}, edges=${result.headReport.edges.length})`);
    }
  } catch (error) {
    inputError(error.message);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
