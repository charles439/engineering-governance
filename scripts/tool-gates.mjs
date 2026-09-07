#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const profileFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'profiles', 'tool-versions.yml');
const environment = {
  typescript: 'GOVERNANCE_TS_EXECUTABLE',
  python: 'GOVERNANCE_PY_EXECUTABLE',
  contract: 'GOVERNANCE_CONTRACT_EXECUTABLE',
};

function loadToolProfiles() {
  const lines = fs.readFileSync(profileFile, 'utf8').split(/\r?\n/);
  const tools = {};
  let current;
  for (const line of lines) {
    const tool = line.match(/^  ([a-z]+):\s*$/);
    if (tool) { current = tool[1]; tools[current] = {}; continue; }
    const field = line.match(/^    ([a-z_]+):\s*(.*?)\s*$/);
    if (current && field) tools[current][field[1]] = field[2].replace(/^['"]|['"]$/g, '');
  }
  for (const name of Object.keys(environment)) {
    if (!tools[name]?.version || !tools[name]?.executable) throw new Error(`invalid canonical tool profile for ${name}`);
  }
  return tools;
}

function usage() {
  return [
    'Usage: node scripts/tool-gates.mjs --tool <typescript|python|contract> [options] [-- checker arguments]',
    '  --path <path>           TypeScript source, Python project directory, or OpenAPI document (default: .)',
    '  --executable <path>     Existing executable or JavaScript checker; no package is installed',
    '  --config <path>         dependency-cruiser configuration (TypeScript only)',
    '  --dry-run               Print the canonical version and exact command without running it',
  ].join('\n');
}

function parse(argv) {
  const result = { path: '.', checkerArgs: [] };
  let passthrough = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (passthrough) { result.checkerArgs.push(arg); continue; }
    if (arg === '--') { passthrough = true; continue; }
    if (arg === '--dry-run') { result.dryRun = true; continue; }
    if (arg === '--help' || arg === '-h') { result.help = true; continue; }
    if (['--tool', '--path', '--executable', '--config'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      result[arg.slice(2)] = value;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  if (!result.help && !result.tool) throw new Error('--tool is required');
  return result;
}

function display(parts) {
  return parts.map((part) => /[\s"']/u.test(part) ? JSON.stringify(part) : part).join(' ');
}

function resolvedExecutable(value, cwd) {
  if (!value) return undefined;
  const absolute = path.isAbsolute(value) ? value : path.resolve(cwd, value);
  if (!fs.existsSync(absolute)) throw new Error(`executable does not exist: ${absolute}`);
  if (/\.[cm]?js$/i.test(absolute)) return { command: process.execPath, args: [absolute] };
  return { command: absolute, args: [] };
}

function run() {
  let options;
  let profiles;
  try { options = parse(process.argv.slice(2)); profiles = loadToolProfiles(); }
  catch (error) { console.error(`FAIL tool gate input: ${error.message}`); console.error(usage()); process.exitCode = 2; return; }
  if (options.help) { console.log(usage()); return; }
  const profile = profiles[options.tool];
  if (!profile) { console.error(`FAIL tool gate input: unsupported tool: ${options.tool}`); process.exitCode = 2; return; }
  const root = process.cwd();
  const target = path.resolve(root, options.path);
  if (options.tool === 'python' && (!fs.existsSync(target) || !fs.statSync(target).isDirectory())) {
    console.error(`FAIL tool gate input: Python project directory does not exist: ${target}`);
    process.exitCode = 2;
    return;
  }
  let executable;
  try { executable = resolvedExecutable(options.executable || process.env[environment[options.tool]], root); }
  catch (error) { console.error(`FAIL tool gate input: ${error.message}`); process.exitCode = 2; return; }
  // Defaults only invoke a tool that is already on PATH. They never call npx, uvx, pip, or a shell.
  executable ??= { command: profile.executable, args: [] };
  const validationConfig = options.tool === 'typescript' ? path.resolve(root, options.config ?? profile.validation_config) : undefined;
  const gateArgs = options.tool === 'typescript'
    ? ['--validate', validationConfig, target]
    : options.tool === 'contract' ? ['lint', target] : [];
  const command = [executable.command, ...executable.args, ...gateArgs, ...options.checkerArgs];
  const companion = profile.typescript_companion ? `; requires ${profile.typescript_companion_package ?? 'typescript'}@${profile.typescript_companion}` : '';
  if (options.dryRun) { console.log(`${options.tool}@${profile.version}: ${display(command)}${companion}`); return; }
  if (options.tool === 'typescript' && !fs.existsSync(validationConfig)) {
    console.error(`FAIL tool gate input: dependency-cruiser validation config does not exist: ${validationConfig}`);
    process.exitCode = 2;
    return;
  }
  const result = spawnSync(executable.command, [...executable.args, ...gateArgs, ...options.checkerArgs], {
    cwd: options.tool === 'python' ? target : root,
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
  });
  if (result.error) { console.error(`FAIL ${options.tool} checker executable: ${result.error.message}`); process.exitCode = 2; return; }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status === 0) { console.log(`PASS ${options.tool} checker (expected ${profile.package}@${profile.version}${companion}; executable version not verified)`); return; }
  if (result.status === 1) { console.error(`FAIL ${options.tool} checker (violations reported)`); process.exitCode = 1; return; }
  console.error(`FAIL ${options.tool} checker execution (exit=${result.status ?? 'signal'})`);
  process.exitCode = 2;
}

run();
