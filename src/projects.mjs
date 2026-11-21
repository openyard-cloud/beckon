import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { validateConfig, expandHome } from './config.mjs';

// Changes to the projects in config.json, made from Slack. Each function edits the raw JSON
// (what is in the file, before validation) and returns an error message or null. The file is
// written only when the result is a valid config.

export const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

export function findName(projects, name) {
  const want = String(name ?? '').toLowerCase();
  return Object.keys(projects ?? {}).find((n) => n.toLowerCase() === want) ?? null;
}

// A folder can become a project when it is a git repository (or inside one).
export function checkRepo(path) {
  const full = expandHome(path);
  try {
    if (!statSync(full).isDirectory()) return `${path} is not a folder.`;
  } catch {
    return `${path} does not exist on this machine.`;
  }
  try {
    execFileSync('git', ['-C', full, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
  } catch {
    return `${path} is not a git repository.`;
  }
  return null;
}

export function addProject(raw, { name, path, channels = [] }, sameChannel = (a, b) => a === b) {
  if (!PROJECT_NAME.test(name)) return `"${name}" cannot be a project name: use letters, digits, dot, dash and underscore.`;
  raw.projects ??= {};
  const existing = findName(raw.projects, name);
  if (existing) return `There is already a project called \`${existing}\`.`;
  for (const c of channels) {
    const owner = ownerOf(raw, c, sameChannel);
    if (owner) return `${c} is already linked to \`${owner}\`. Use \`link\` to move it.`;
  }
  raw.projects[name] = { path, channels: [...channels] };
  return null;
}

export function removeProject(raw, name) {
  const key = findName(raw.projects, name);
  if (!key) return `There is no project called \`${name}\`.`;
  if (Object.keys(raw.projects).length === 1) return `\`${key}\` is the only project, and beckon needs at least one.`;
  const used = (raw.schedules ?? []).filter((s) => s.project === key).map((s) => `"${s.name ?? s.cron}"`);
  if (used.length) return `\`${key}\` is used by the schedule ${used.join(', ')}. Change or remove the schedule in the config file first.`;
  delete raw.projects[key];
  if (raw.defaultProject === key) delete raw.defaultProject;
  return null;
}

// Links a channel to a project, moving it away from the project it belonged to.
export function linkChannel(raw, channel, name, sameChannel = (a, b) => a === b) {
  const key = findName(raw.projects, name);
  if (!key) return `There is no project called \`${name}\`.`;
  unlinkChannel(raw, channel, sameChannel);
  const p = raw.projects[key];
  p.channels = [...(p.channels ?? []), channel];
  return null;
}

export function unlinkChannel(raw, channel, sameChannel = (a, b) => a === b) {
  let found = false;
  for (const p of Object.values(raw.projects ?? {})) {
    const before = p.channels ?? [];
    const after = before.filter((c) => !sameChannel(c, channel));
    if (after.length !== before.length) {
      p.channels = after;
      found = true;
    }
  }
  return found ? null : `${channel} is not linked to any project.`;
}

export function setDefault(raw, name) {
  const key = findName(raw.projects, name);
  if (!key) return `There is no project called \`${name}\`.`;
  raw.defaultProject = key;
  return null;
}

export function ownerOf(raw, channel, sameChannel = (a, b) => a === b) {
  for (const [name, p] of Object.entries(raw.projects ?? {})) {
    if ((p.channels ?? []).some((c) => sameChannel(c, channel))) return name;
  }
  return null;
}

export function readRaw(file) {
  const text = readFileSync(file, 'utf8');
  return { text, raw: JSON.parse(text) };
}

// Validates and writes the file in one step (a temporary file renamed over the old one), so
// beckon never reads a half-written config.
export function writeRaw(file, raw) {
  const { config, errors } = validateConfig(raw);
  if (errors.length) return { errors };
  const text = JSON.stringify(raw, null, 2) + '\n';
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  return { config, text };
}
