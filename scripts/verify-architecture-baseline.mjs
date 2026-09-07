#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGovernanceConfig } from './config.mjs';

const args = process.argv.slice(2);
const index = args.indexOf('--config');
const config = path.resolve(process.cwd(), index >= 0 ? args[index + 1] : args[0] ?? '.governance.yml');
const profilesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'profiles');
const loaded = loadGovernanceConfig(config, { profilesDir });
if (loaded.errors.length) {
  loaded.errors.forEach((error) => console.error(`FAIL architecture baseline: ${error}`));
  process.exitCode = 2;
} else {
  console.log(`PASS architecture baseline (${loaded.config.project.name}, profile=${loaded.config.governance.profile})`);
}
