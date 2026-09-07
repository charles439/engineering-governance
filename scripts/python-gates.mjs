#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const toolGate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'tool-gates.mjs');

// Compatibility entrypoint. Python isolation belongs to the caller's pinned tool environment.
export function run(argv = process.argv.slice(2)) {
  const forwarded = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--runner') { index += 1; continue; }
    forwarded.push(arg === '--project' ? '--path' : arg);
  }
  const result = spawnSync(process.execPath, [toolGate, '--tool', 'python', ...forwarded], {
    cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
  });
  if (result.error) { console.error(`FAIL Python gate wrapper: ${result.error.message}`); return 2; }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = run();
