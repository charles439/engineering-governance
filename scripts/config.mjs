import fs from 'node:fs';
import path from 'node:path';

// The governance file intentionally uses a small, dependency-free YAML subset:
// mappings, block sequences, scalar values, and sequence items that are mappings.
// Keeping this parser local makes the checks runnable in a clean Node container.

function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if ((char === '"' || char === "'") && text[i - 1] !== '\\') {
      quote = quote === char ? null : quote ?? char;
    }
    if (char === '#' && !quote && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text;
}

function scalar(value) {
  const text = stripComment(value.trim());
  if (!text) return null;
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); } catch { return text.slice(1, -1); }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?(?:\d+|\d*\.\d+)$/.test(text)) return Number(text);
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    return inner ? inner.split(',').map((item) => scalar(item)) : [];
  }
  return text;
}

function tokens(text) {
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim() || /^\s*#/.test(line)) return [];
    if (/\t/.test(line.slice(0, line.search(/\S|$/)))) {
      throw new Error(`line ${index + 1} uses tabs for indentation`);
    }
    const content = stripComment(line);
    if (!content.trim()) return [];
    const indent = content.match(/^ */)[0].length;
    return [{ indent, text: content.trim(), line: index + 1 }];
  });
}

function keyValue(text, line) {
  const match = text.match(/^([^:]+):(?:\s+(.*))?$/);
  if (!match) throw new Error(`line ${line} must contain a mapping key and ':'`);
  return [match[1].trim(), match[2] ?? ''];
}

function assignUnique(target, key, value, line) {
  if (Object.hasOwn(target, key)) throw new Error(`line ${line} duplicates mapping key: ${key}`);
  target[key] = value;
}

function parseBlock(items, start, indent) {
  const isList = items[start]?.text.startsWith('- ');
  const result = isList ? [] : {};
  let index = start;

  while (index < items.length && items[index].indent === indent) {
    const item = items[index];
    if (isList !== item.text.startsWith('- ')) {
      throw new Error(`line ${item.line} mixes mapping and sequence entries`);
    }

    if (isList) {
      const body = item.text.slice(2).trim();
      if (!body) {
        if (index + 1 < items.length && items[index + 1].indent > indent) {
          const child = parseBlock(items, index + 1, items[index + 1].indent);
          result.push(child.value);
          index = child.index;
        } else {
          result.push(null);
          index += 1;
        }
        continue;
      }
      if (!body.includes(':')) {
        result.push(scalar(body));
        index += 1;
        continue;
      }
      const object = {};
      result.push(object);
      const [key, raw] = keyValue(body, item.line);
      if (raw) {
        assignUnique(object, key, scalar(raw), item.line);
        index += 1;
      } else if (index + 1 < items.length && items[index + 1].indent > indent) {
        const child = parseBlock(items, index + 1, items[index + 1].indent);
        assignUnique(object, key, child.value, item.line);
        index = child.index;
      } else {
        assignUnique(object, key, null, item.line);
        index += 1;
      }
      while (index < items.length && items[index].indent > indent) {
        const field = items[index];
        if (field.text.startsWith('- ')) throw new Error(`line ${field.line} has an invalid nested sequence`);
        const [fieldKey, fieldRaw] = keyValue(field.text, field.line);
        if (fieldRaw) {
          assignUnique(object, fieldKey, scalar(fieldRaw), field.line);
          index += 1;
        } else if (index + 1 < items.length && items[index + 1].indent > field.indent) {
          const child = parseBlock(items, index + 1, items[index + 1].indent);
          assignUnique(object, fieldKey, child.value, field.line);
          index = child.index;
        } else {
          assignUnique(object, fieldKey, null, field.line);
          index += 1;
        }
      }
      continue;
    }

    const [key, raw] = keyValue(item.text, item.line);
    if (raw) {
      assignUnique(result, key, scalar(raw), item.line);
      index += 1;
    } else if (index + 1 < items.length && items[index + 1].indent > indent) {
      const child = parseBlock(items, index + 1, items[index + 1].indent);
      assignUnique(result, key, child.value, item.line);
      index = child.index;
    } else {
      assignUnique(result, key, null, item.line);
      index += 1;
    }
  }
  return { value: result, index };
}

export function parseGovernanceYaml(text) {
  const input = tokens(text);
  if (!input.length) return {};
  const parsed = parseBlock(input, 0, input[0].indent);
  if (parsed.index !== input.length) throw new Error(`line ${input[parsed.index].line} has unexpected indentation or a second root mapping`);
  return parsed.value;
}

function requiredString(value, name, errors) {
  if (typeof value !== 'string' || !value.trim()) errors.push(`${name} is required`);
}

function isSafeProjectPath(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized) || normalized.startsWith('//')) return false;
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith('../');
}

function mergeDefaults(defaults, value) {
  if (Array.isArray(defaults) || Array.isArray(value)) return value === undefined ? defaults : value;
  if (!defaults || typeof defaults !== 'object') return value === undefined ? defaults : value;
  const merged = { ...defaults };
  for (const [key, child] of Object.entries(value ?? {})) merged[key] = mergeDefaults(defaults[key], child);
  return merged;
}

export function validateGovernanceConfig(config, options = {}) {
  const errors = [];
  const profilesDir = options.profilesDir;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ['configuration must be a mapping'];

  for (const key of Object.keys(config)) if (!['governance', 'project', 'modules', 'checks'].includes(key)) errors.push(`unknown top-level section: ${key}`);

  for (const key of ['governance', 'project', 'modules']) {
    if (!(key in config)) errors.push(`missing required section: ${key}`);
  }
  const governance = config.governance;
  if (!governance || typeof governance !== 'object' || Array.isArray(governance)) {
    errors.push('governance must be a mapping');
  } else {
    for (const key of Object.keys(governance)) if (!['version', 'profile'].includes(key)) errors.push(`unknown governance field: ${key}`);
    if (!/^\d+\.\d+$/.test(String(governance.version ?? ''))) errors.push('governance.version must be major.minor');
    requiredString(governance.profile, 'governance.profile', errors);
    if (typeof governance.profile === 'string' && !/^[a-z0-9][a-z0-9-]*$/i.test(governance.profile)) errors.push('governance.profile must be a simple profile name');
    if (profilesDir && typeof governance.profile === 'string' && /^[a-z0-9][a-z0-9-]*$/i.test(governance.profile) && !fs.existsSync(path.join(profilesDir, `${governance.profile}.yml`))) {
      errors.push(`governance.profile unknown: ${governance.profile}`);
    }
  }

  const project = config.project;
  if (!project || typeof project !== 'object' || Array.isArray(project)) errors.push('project must be a mapping');
  else {
    for (const key of Object.keys(project)) if (!['name'].includes(key)) errors.push(`unknown project field: ${key}`);
    requiredString(project.name, 'project.name', errors);
    if (project.name === 'replace-me') errors.push('project.name must be set');
  }

  if (!Array.isArray(config.modules) || !config.modules.length) errors.push('modules must be a non-empty array');
  else config.modules.forEach((module, index) => {
    if (!module || typeof module !== 'object' || Array.isArray(module)) {
      errors.push(`modules[${index}] must be a mapping`);
      return;
    }
    for (const key of Object.keys(module)) if (!['name', 'path', 'owner'].includes(key)) errors.push(`unknown modules[${index}] field: ${key}`);
    requiredString(module.name, `modules[${index}].name`, errors);
    requiredString(module.path, `modules[${index}].path`, errors);
    requiredString(module.owner, `modules[${index}].owner`, errors);
    if (!isSafeProjectPath(module.path)) errors.push(`modules[${index}].path must be a relative path inside the project`);
    if (options.projectRoot && isSafeProjectPath(module.path) && !fs.existsSync(path.resolve(options.projectRoot, module.path))) {
      errors.push(`modules[${index}].path does not exist in the project: ${module.path}`);
    }
  });

  if (Array.isArray(config.modules)) {
    const names = new Set(); const paths = new Set();
    for (const module of config.modules) {
      if (!module || typeof module !== 'object') continue;
      const name = String(module.name ?? '').toLowerCase();
      const modulePath = String(module.path ?? '').replaceAll('\\', '/').toLowerCase();
      if (name && names.has(name)) errors.push(`duplicate module name: ${module.name}`); else names.add(name);
      if (modulePath && paths.has(modulePath)) errors.push(`duplicate module path: ${module.path}`); else paths.add(modulePath);
    }
  }

  if ('checks' in config && (!config.checks || typeof config.checks !== 'object' || Array.isArray(config.checks))) errors.push('checks must be a mapping');
  for (const key of Object.keys(config.checks ?? {})) if (!['adr_required_for', 'architecture', 'quality', 'release'].includes(key)) errors.push(`unknown checks section: ${key}`);
  if (config.checks?.adr_required_for !== undefined && (!Array.isArray(config.checks.adr_required_for) || config.checks.adr_required_for.some((item) => typeof item !== 'string' || !item.trim()))) {
    errors.push('checks.adr_required_for must be an array of non-empty strings');
  }
  for (const [section, fields] of Object.entries({ architecture: ['no_new_cycles', 'no_new_forbidden_dependencies', 'require_dependency_graph'], quality: ['require_tests_for_changed_logic', 'require_lint', 'require_typecheck'], release: ['immutable_artifact', 'rollback_plan_required'] })) {
    const value = config.checks?.[section];
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) errors.push(`checks.${section} must be a mapping`);
    for (const key of Object.keys(value ?? {})) if (!fields.includes(key)) errors.push(`unknown checks.${section} field: ${key}`);
    for (const field of fields) if (value?.[field] !== undefined && typeof value[field] !== 'boolean') errors.push(`checks.${section}.${field} must be boolean`);
  }
  return errors;
}

export function loadGovernanceConfig(file, options = {}) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) return { config: null, errors: [`missing config: ${absolute}`] };
  try {
    const parsed = parseGovernanceYaml(fs.readFileSync(absolute, 'utf8'));
    let config = parsed;
    if (options.profilesDir && typeof parsed.governance?.profile === 'string' && /^[a-z0-9][a-z0-9-]*$/i.test(parsed.governance.profile)) {
      const profilePath = path.join(options.profilesDir, `${parsed.governance.profile}.yml`);
      if (fs.existsSync(profilePath)) {
        const profile = parseGovernanceYaml(fs.readFileSync(profilePath, 'utf8'));
        config = { ...parsed, checks: mergeDefaults(profile.defaults ?? {}, parsed.checks ?? {}) };
      }
    }
    return { config, errors: validateGovernanceConfig(config, { ...options, projectRoot: options.projectRoot ?? path.dirname(absolute) }) };
  } catch (error) {
    return { config: null, errors: [`invalid config: ${error.message}`] };
  }
}
