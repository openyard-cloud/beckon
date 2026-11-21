import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

export const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions', 'dontAsk'];

export function beckonHome(env = process.env) {
  return env.BECKON_HOME || join(homedir(), '.beckon');
}

export function homePaths(home) {
  return {
    home,
    config: join(home, 'config.json'),
    env: join(home, 'env'),
    state: join(home, 'state.json'),
    worktrees: join(home, 'worktrees'),
    logs: join(home, 'logs'),
  };
}

export function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

export function loadEnvFile(file, env = process.env) {
  if (!existsSync(file)) return;
  const values = parseEnvFile(readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(values)) {
    if (env[k] === undefined || env[k] === '') env[k] = v;
  }
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);
}

function checkRegex(source, where, errors) {
  try {
    new RegExp(source);
  } catch (e) {
    errors.push(`${where}: not a valid regular expression (${e.message})`);
  }
}

export function validateConfig(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: ['config must be a JSON object'] };
  }

  const users = raw.users;
  if (!isStringArray(users) || users.length === 0) {
    errors.push('users: list the Slack member IDs (like "U0123ABCD") allowed to give beckon work and approve actions');
  } else {
    for (const u of users) if (!/^[UW][A-Z0-9]+$/.test(u)) errors.push(`users: "${u}" is not a Slack member ID (they start with U or W)`);
  }

  const projects = {};
  const channelOwner = new Map();
  if (!raw.projects || typeof raw.projects !== 'object' || Object.keys(raw.projects).length === 0) {
    errors.push('projects: add at least one project, e.g. { "myapp": { "path": "~/code/myapp", "channels": ["#myapp"] } }');
  } else {
    for (const [name, p] of Object.entries(raw.projects)) {
      const at = `projects.${name}`;
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) errors.push(`${at}: project names may use letters, digits, dot, dash and underscore`);
      if (!p || typeof p !== 'object') { errors.push(`${at}: must be an object`); continue; }
      if (typeof p.path !== 'string' || !p.path) { errors.push(`${at}.path: required`); continue; }
      const path = expandHome(p.path);
      if (!isAbsolute(path)) errors.push(`${at}.path: use an absolute path or one starting with ~/`);
      const channels = p.channels ?? [];
      if (!isStringArray(channels)) errors.push(`${at}.channels: must be a list of channel IDs or #names`);
      for (const c of isStringArray(channels) ? channels : []) {
        if (channelOwner.has(c)) errors.push(`${at}.channels: ${c} is already linked to project "${channelOwner.get(c)}"`);
        channelOwner.set(c, name);
      }
      const permissionMode = p.permissionMode ?? 'acceptEdits';
      if (!PERMISSION_MODES.includes(permissionMode)) errors.push(`${at}.permissionMode: one of ${PERMISSION_MODES.join(', ')}`);
      const alwaysAsk = p.alwaysAsk ?? [];
      if (!Array.isArray(alwaysAsk)) errors.push(`${at}.alwaysAsk: must be a list`);
      const rules = [];
      for (const [i, r] of (Array.isArray(alwaysAsk) ? alwaysAsk : []).entries()) {
        const where = `${at}.alwaysAsk[${i}]`;
        if (typeof r === 'string') {
          checkRegex(r, where, errors);
          rules.push({ tool: '^Bash$', match: r, label: 'project rule' });
        } else if (r && typeof r === 'object') {
          if (r.tool) checkRegex(r.tool, `${where}.tool`, errors);
          if (r.match) checkRegex(r.match, `${where}.match`, errors);
          if (!r.tool && !r.match) errors.push(`${where}: give "tool", "match" or both`);
          rules.push({ tool: r.tool ?? '^Bash$', match: r.match ?? null, label: r.label ?? 'project rule' });
        } else {
          errors.push(`${where}: a regex string or { "tool", "match", "label" }`);
        }
      }
      for (const key of ['baseBranch', 'model', 'setup', 'instructions']) {
        if (p[key] !== undefined && typeof p[key] !== 'string') errors.push(`${at}.${key}: must be a string`);
      }
      projects[name] = {
        name,
        path,
        channels: isStringArray(channels) ? channels : [],
        baseBranch: p.baseBranch ?? null,
        model: p.model ?? null,
        permissionMode,
        alwaysAsk: rules,
        setup: p.setup ?? null,
        instructions: p.instructions ?? null,
      };
    }
  }

  if (raw.defaultProject !== undefined && !projects[raw.defaultProject]) {
    errors.push(`defaultProject: "${raw.defaultProject}" is not one of the projects`);
  }

  const schedules = [];
  if (raw.schedules !== undefined && !Array.isArray(raw.schedules)) errors.push('schedules: must be a list');
  for (const [i, s] of (Array.isArray(raw.schedules) ? raw.schedules : []).entries()) {
    const at = `schedules[${i}]`;
    if (!s || typeof s !== 'object') { errors.push(`${at}: must be an object`); continue; }
    for (const key of ['cron', 'project', 'channel', 'prompt']) {
      if (typeof s[key] !== 'string' || !s[key]) errors.push(`${at}.${key}: required`);
    }
    if (s.project && !projects[s.project]) errors.push(`${at}.project: "${s.project}" is not one of the projects`);
    const timezone = s.timezone ?? 'UTC';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      errors.push(`${at}.timezone: "${timezone}" is not a known time zone`);
    }
    schedules.push({ name: s.name ?? `schedule ${i + 1}`, cron: s.cron, timezone, project: s.project, channel: s.channel, prompt: s.prompt });
  }

  const num = (key, def, min, max) => {
    const v = raw[key] ?? def;
    if (!Number.isFinite(v) || v < min || v > max) errors.push(`${key}: a number from ${min} to ${max}`);
    return v;
  };

  const config = {
    users: isStringArray(users) ? users : [],
    projects,
    defaultProject: raw.defaultProject ?? (Object.keys(projects).length === 1 ? Object.keys(projects)[0] : null),
    schedules,
    approvalTimeoutMinutes: num('approvalTimeoutMinutes', 60, 1, 1440),
    maxParallel: num('maxParallel', 3, 1, 20),
    keepDays: num('keepDays', 7, 1, 365),
    claudePath: typeof raw.claudePath === 'string' ? expandHome(raw.claudePath) : 'claude',
    allowApiKey: raw.allowApiKey === true,
  };
  return { config, errors };
}

export function loadConfig(file) {
  if (!existsSync(file)) {
    throw new Error(`No config at ${file}. Run "beckon init" first.`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
  const { config, errors } = validateConfig(raw);
  if (errors.length) {
    throw new Error(`${file} has problems:\n  - ${errors.join('\n  - ')}`);
  }
  return config;
}
