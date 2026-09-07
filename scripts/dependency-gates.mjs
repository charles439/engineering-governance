#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGovernanceConfig, parseGovernanceYaml } from './config.mjs';

const args = process.argv.slice(2);
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;

function inputError(message) { console.error(`FAIL dependency gate input: ${message}`); process.exitCode = 2; }

function normalizeEdge(edge, label) {
  if (Array.isArray(edge) && edge.length === 2) return { from: String(edge[0]), to: String(edge[1]) };
  if (edge && typeof edge === 'object' && typeof edge.from === 'string' && typeof edge.to === 'string') return edge;
  throw new Error(`${label} must contain {from, to} pairs`);
}

function graphFromDependencyCruiser(report) {
  if (!Array.isArray(report.modules)) return undefined;
  const nodes = new Set();
  const edges = [];
  for (const module of report.modules) {
    if (typeof module.source !== 'string') continue;
    nodes.add(module.source);
    for (const dependency of module.dependencies ?? []) {
      if (typeof dependency.resolved !== 'string' || dependency.couldNotResolve || dependency.core) continue;
      nodes.add(dependency.resolved);
      edges.push({ from: module.source, to: dependency.resolved });
    }
  }
  const violations = report.summary?.violations ?? report.violations ?? [];
  if (!Array.isArray(violations)) throw new Error('dependency-cruiser report violations must be an array');
  return { nodes: [...nodes], edges, forbiddenDependencies: [], toolViolations: violations };
}

function normalizeFixtureGraph(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('graph must be a JSON object');
  if (!Object.hasOwn(report, 'edges') && !Object.hasOwn(report, 'dependencies')) throw new Error('report must be dependency-cruiser JSON with modules or a fixture graph with edges');
  if (!Array.isArray(report.edges ?? report.dependencies ?? [])) throw new Error('edges must be an array');
  const edges = (report.edges ?? report.dependencies ?? []).map((edge, index) => normalizeEdge(edge, `edges[${index}]`));
  const forbiddenDependencies = (report.forbidden_dependencies ?? report.forbiddenDependencies ?? []).map((edge, index) => normalizeEdge(edge, `forbidden_dependencies[${index}]`));
  const nodes = new Set((report.nodes ?? []).map(String));
  for (const edge of [...edges, ...forbiddenDependencies]) { nodes.add(edge.from); nodes.add(edge.to); }
  return { nodes: [...nodes], edges, forbiddenDependencies, toolViolations: [] };
}

function loadReport(file) {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  return graphFromDependencyCruiser(report) ?? normalizeFixtureGraph(report);
}

function loadPolicy(file) {
  if (!file) return { required: false, noCycles: true, noForbidden: true, forbiddenDependencies: [] };
  const raw = fs.readFileSync(file, 'utf8');
  const candidate = parseGovernanceYaml(raw);
  const profilesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'profiles');
  const loaded = candidate.governance ? loadGovernanceConfig(file, { profilesDir }) : undefined;
  if (loaded?.errors.length) throw new Error(loaded.errors.join('; '));
  const parsed = loaded?.config ?? candidate;
  const architecture = parsed.checks?.architecture ?? parsed.architecture ?? {};
  const forbidden = architecture.forbidden_dependencies ?? architecture.forbiddenDependencies ?? [];
  if (!Array.isArray(forbidden)) throw new Error('architecture.forbidden_dependencies must be an array');
  return {
    required: architecture.require_dependency_graph === true,
    noCycles: architecture.no_new_cycles !== false,
    noForbidden: architecture.no_new_forbidden_dependencies !== false,
    forbiddenDependencies: forbidden.map((edge, index) => normalizeEdge(edge, `architecture.forbidden_dependencies[${index}]`)),
  };
}

function findCycles(graph) {
  const adjacency = new Map(graph.nodes.map((node) => [node, []]));
  for (const { from, to } of graph.edges) adjacency.get(from)?.push(to);
  const done = new Set(); const active = new Set(); const stack = []; const cycles = []; const known = new Set();
  function visit(node) {
    done.add(node); active.add(node); stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!done.has(next)) visit(next);
      else if (active.has(next)) {
        const cycle = [...stack.slice(stack.indexOf(next)), next];
        const identity = cycle.slice(0, -1).sort().join('\0');
        if (!known.has(identity)) { known.add(identity); cycles.push(cycle); }
      }
    }
    stack.pop(); active.delete(node);
  }
  for (const node of graph.nodes) if (!done.has(node)) visit(node);
  return cycles;
}

function main() {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: dependency-gates.mjs [--config .governance.yml] [--input dependency-cruiser-report.json]'); return;
  }
  const input = option('--input'); const config = option('--config');
  if (args.some((arg, index) => ['--input', '--config'].includes(arg) && (!args[index + 1] || args[index + 1].startsWith('--')))) { inputError('an option is missing its file path'); return; }
  try {
    const policy = config ? loadPolicy(path.resolve(process.cwd(), config)) : loadPolicy();
    if (!input) {
      if (policy.required) { console.error('FAIL dependency graph is required; pass --input generated by dependency-cruiser'); process.exitCode = 1; }
      else console.log('SKIP dependency gates (no generated dependency report supplied)');
      return;
    }
    const graph = loadReport(path.resolve(process.cwd(), input));
    if (!graph.nodes.length && !graph.edges.length) {
      if (policy.required) { console.error('FAIL generated dependency report contains no modules'); process.exitCode = 1; }
      else console.log('SKIP dependency gates (generated dependency report contains no modules)');
      return;
    }
    const errors = [];
    for (const violation of graph.toolViolations ?? []) {
      const rule = typeof violation?.rule === 'string' ? ` (${violation.rule})` : '';
      const edge = typeof violation?.from === 'string' && typeof violation?.to === 'string' ? `${violation.from} -> ${violation.to}` : JSON.stringify(violation);
      errors.push(`dependency-cruiser violation: ${edge}${rule}`);
    }
    if (policy.noCycles) for (const cycle of findCycles(graph)) errors.push(`dependency cycle detected: ${cycle.join(' -> ')}`);
    if (policy.noForbidden) {
      const forbidden = [...policy.forbiddenDependencies, ...graph.forbiddenDependencies];
      const edgeSet = new Set(graph.edges.map(({ from, to }) => `${from}\0${to}`));
      for (const { from, to } of forbidden) if (edgeSet.has(`${from}\0${to}`)) errors.push(`forbidden dependency: ${from} -> ${to}`);
    }
    if (errors.length) { errors.forEach((error) => console.error(`FAIL ${error}`)); process.exitCode = 1; }
    else console.log(`PASS dependency gates (nodes=${graph.nodes.length}, edges=${graph.edges.length})`);
  } catch (error) { inputError(error.message); }
}

main();
