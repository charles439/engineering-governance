#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateAdrDocument(text, { requireAccepted = false } = {}) {
  const errors = [];
  if (!/^#\s+\S+/m.test(text)) errors.push('ADR must have a title');
  const status = text.match(/^Status:\s*(.+?)\s*$/im)?.[1]?.trim();
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
  const match = text.match(new RegExp(`^##\\s+${heading}\\s*$`, 'im'));
  if (!match) return false;
  const contentStart = match.index + match[0].length;
  const afterHeading = text.slice(contentStart);
  const nextHeading = afterHeading.search(/^##\s+/im);
  const content = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
  return /\S/.test(content);
}

export function adrAffectedPaths(text) {
  const value = text.match(/^Affected paths:\s*(.+?)\s*$/im)?.[1] ?? '';
  return value.split(',').map((item) => item.trim()).filter(Boolean);
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
