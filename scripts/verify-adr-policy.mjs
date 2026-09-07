#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateAdrDocument(text, { requireAccepted = false } = {}) {
  const errors = [];
  if (!/^#\s+\S+/m.test(text)) errors.push('ADR must have a title');
  const status = field(text, 'Status');
  if (!status) errors.push('ADR must declare Status');
  else if (!/^(proposed|accepted|superseded|deprecated)$/i.test(status)) errors.push(`unsupported ADR status: ${status}`);
  else if (requireAccepted && !/^accepted$/i.test(status)) errors.push('architecture changes require Status: Accepted');
  const contextHeading = /^##\s+Context\s*$/im.test(text);
  const decisionHeading = /^##\s+Decision\s*$/im.test(text);
  if (!contextHeading) errors.push('ADR must include a ## Context section');
  else if (!hasNonEmptySectionContent(text, 'Context')) errors.push('ADR ## Context section must contain content');
  if (!decisionHeading) errors.push('ADR must include a ## Decision section');
  else if (!hasNonEmptySectionContent(text, 'Decision')) errors.push('ADR ## Decision section must contain content');
  return errors;
}

function hasNonEmptySectionContent(text, heading) {
  return /\S/.test(sectionContent(text, heading));
}

function sectionContent(text, heading) {
  const match = text.match(new RegExp(`^##\\s+${heading}\\s*$`, 'im'));
  if (!match) return '';
  const contentStart = match.index + match[0].length;
  const afterHeading = text.slice(contentStart);
  const nextHeading = afterHeading.search(/^##\s+/im);
  const content = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
  return content.replaceAll('\r\n', '\n').trim();
}

export function adrAffectedPaths(text) {
  const value = field(text, 'Affected paths');
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function field(text, name) {
  return text.match(new RegExp(`^${name}:[ \\t]*(.*?)[ \\t]*$`, 'im'))?.[1]?.trim() ?? '';
}

function adrPath(value) {
  return typeof value === 'string' && /^docs\/adr\/[^/\\:\x00-\x1f]+\.md$/.test(value)
    && !value.includes('..') && !/[?#%]/.test(value);
}

/**
 * Validate changed ADRs against the complete head/base document snapshots.
 * Snapshots are Maps (or records) of repository-relative paths to Markdown text.
 * Only a successful lifecycle check returns changed Accepted ADR coverage.
 */
export function validateAdrLifecycle(changedPaths, headDocuments, baseDocuments = new Map()) {
  const head = headDocuments instanceof Map ? headDocuments : new Map(Object.entries(headDocuments));
  const base = baseDocuments instanceof Map ? baseDocuments : new Map(Object.entries(baseDocuments));
  const changed = new Set(changedPaths);
  const errors = [];
  const acceptedPaths = [];
  const coverage = [];
  const relevant = new Set(changed);
  const links = new Map();
  const status = (text) => field(text, 'Status').toLowerCase();
  const fail = (file, error) => errors.push(`${file}: ${error}`);

  // Follow both directions so unchanged linked documents receive the same checks.
  for (const file of relevant) {
    const text = head.get(file);
    if (typeof text !== 'string') continue;
    for (const name of ['Supersedes', 'Superseded by']) {
      const target = field(text, name);
      if (adrPath(target) && head.has(target)) relevant.add(target);
    }
  }

  for (const file of relevant) {
    if (!adrPath(file)) { fail(file, 'ADR path must be docs/adr/*.md without path traversal'); continue; }
    const text = head.get(file);
    const previous = base.get(file);
    if (typeof text !== 'string') {
      if (previous === undefined || status(previous) !== 'proposed') fail(file, 'decision history must not be deleted');
      continue;
    }
    for (const error of validateAdrDocument(text)) fail(file, error);
    for (const name of ['Status', 'Affected paths', 'Supersedes', 'Superseded by', 'Deprecation reason']) {
      if ((text.match(new RegExp(`^${name}:`, 'gim')) ?? []).length > 1) fail(file, `duplicate ${name} field`);
    }
    const currentStatus = status(text);
    const previousStatus = typeof previous === 'string' ? status(previous) : '';
    if (changed.has(file) && ['accepted', 'superseded', 'deprecated'].includes(previousStatus)) {
      for (const heading of ['Context', 'Decision']) {
        if (sectionContent(text, heading) !== sectionContent(previous, heading)) {
          fail(file, `historical ## ${heading} must be preserved; write a new superseding ADR`);
        }
      }
      if (JSON.stringify(adrAffectedPaths(text).sort()) !== JSON.stringify(adrAffectedPaths(previous).sort())) {
        fail(file, 'historical Affected paths must be preserved; write a new superseding ADR');
      }
      if (previousStatus !== currentStatus && !(previousStatus === 'accepted' && ['superseded', 'deprecated'].includes(currentStatus))) {
        fail(file, `unsupported lifecycle transition: ${previousStatus} -> ${currentStatus}`);
      }
    }
    if (changed.has(file) && ['superseded', 'deprecated'].includes(currentStatus)
        && previousStatus !== 'accepted' && previousStatus !== currentStatus) {
      fail(file, `${currentStatus} requires an existing Accepted ADR`);
    }
    if (currentStatus === 'deprecated' && !field(text, 'Deprecation reason')) fail(file, 'Deprecated ADR must declare Deprecation reason');

    const supersedes = field(text, 'Supersedes');
    const successor = field(text, 'Superseded by');
    if (currentStatus === 'superseded' && !successor) fail(file, 'Superseded ADR must declare Superseded by');
    if (successor && currentStatus !== 'superseded') fail(file, 'Superseded by requires Status: Superseded');
    if (supersedes && !['accepted', 'superseded', 'deprecated'].includes(currentStatus)) fail(file, 'Supersedes requires an accepted decision history');

    for (const [name, target, reciprocal] of [
      ['Supersedes', supersedes, 'Superseded by'],
      ['Superseded by', successor, 'Supersedes'],
    ]) {
      if (!target) continue;
      if (!adrPath(target)) { fail(file, `${name} must reference docs/adr/*.md without path traversal`); continue; }
      const targetText = head.get(target);
      if (typeof targetText !== 'string') { fail(file, `${name} target does not exist: ${target}`); continue; }
      if (target === file) fail(file, 'ADR must not supersede itself');
      if (field(targetText, reciprocal) !== file) fail(file, `${name} requires reciprocal ${reciprocal}: ${file} in ${target}`);
      if (name === 'Supersedes' && status(targetText) !== 'superseded') fail(file, 'Supersedes target must have Status: Superseded');
      if (name === 'Superseded by') {
        links.set(file, target);
        if (changed.has(file) && previousStatus === 'accepted' && status(targetText) !== 'accepted') {
          fail(file, 'replacement ADR must have Status: Accepted');
        }
      }
    }
    // Existing Accepted ADR metadata edits do not authorize architecture changes.
    // Coverage is granted only by a new Accepted ADR or Proposed -> Accepted.
    const grantsCoverage = changed.has(file) && currentStatus === 'accepted'
      && (previous === undefined || previousStatus === 'proposed');
    if (grantsCoverage) {
      const affected = adrAffectedPaths(text);
      if (!affected.length) fail(file, 'ADR must declare Affected paths');
      acceptedPaths.push(file);
      coverage.push(...affected);
    }
  }

  const visited = new Set();
  for (const start of links.keys()) {
    const chain = new Set();
    let current = start;
    while (links.has(current) && !visited.has(current)) {
      if (chain.has(current)) { fail(current, 'supersession graph contains a cycle'); break; }
      chain.add(current);
      current = links.get(current);
    }
    for (const file of chain) visited.add(file);
  }
  return { errors, acceptedPaths: errors.length ? [] : acceptedPaths, coverage: errors.length ? [] : [...new Set(coverage)] };
}

function main() {
  const args = process.argv.slice(2);
  const requireAccepted = args.includes('--require-accepted');
  const files = args.filter((arg) => arg !== '--require-accepted');
  if (!files.length) { console.error('FAIL ADR policy requires at least one ADR file'); process.exitCode = 2; return; }
  const errors = [];
  for (const file of files) {
    const target = path.resolve(process.cwd(), file);
    if (!fs.existsSync(target)) { errors.push(`${file}: does not exist`); continue; }
    for (const error of validateAdrDocument(fs.readFileSync(target, 'utf8'), { requireAccepted })) errors.push(`${file}: ${error}`);
  }
  if (errors.length) { errors.forEach((error) => console.error(`FAIL ${error}`)); process.exitCode = 1; }
  else console.log(`PASS ADR policy (${files.length} ADRs)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
