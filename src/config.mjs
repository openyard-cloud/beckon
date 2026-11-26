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
    const lowerNames = new Map();
    for (const [name, p] of Object.entries(raw.projects)) {
      const at = `projects.${name}`;
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) errors.push(`${at}: project names may use letters, digits, dot, dash and underscore`);
      const lower = name.toLowerCase();
      if (lowerNames.has(lower)) errors.push(`${at}: "${lowerNames.get(lower)}" already uses this name (names ignore case)`);
      lowerNames.set(lower, name);
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
          rules.push({ tool: r.tool ?? '^Bash$', match: r.match ?? null, label: r.label ?? 'project rule', ...(r.reads === true ? { reads: true } : {}) });
        } else {
          errors.push(`${where}: a regex string or { "tool", "match", "label" }`);
        }
      }
      for (const key of ['baseBranch', 'model', 'setup', 'instructions', 'mcpConfig']) {
        if (p[key] !== undefined && typeof p[key] !== 'string') errors.push(`${at}.${key}: must be a string`);
      }
      const agents = agentsConfig(p.agents, at, isStringArray(channels) ? channels : [], errors);
      if (p.defaultAgent !== undefined && !agents[p.defaultAgent]) errors.push(`${at}.defaultAgent: "${p.defaultAgent}" is not one of this project's agents`);
      if (p.lead !== undefined && !agents[p.lead]) errors.push(`${at}.lead: "${p.lead}" is not one of this project's agents`);
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
        mcpConfig: typeof p.mcpConfig === 'string' ? expandHome(p.mcpConfig) : null,
        agents,
        defaultAgent: typeof p.defaultAgent === 'string' && agents[p.defaultAgent] ? p.defaultAgent : null,
        // The agent that leads the others: it plans the work and assigns it, and gets their reports.
        lead: typeof p.lead === 'string' && agents[p.lead] ? p.lead : null,
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
    checkAgentRef(s.agent, projects[s.project], at, errors);
    const timezone = s.timezone ?? 'UTC';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      errors.push(`${at}.timezone: "${timezone}" is not a known time zone`);
    }
    schedules.push({ name: s.name ?? `schedule ${i + 1}`, cron: s.cron, timezone, project: s.project, channel: s.channel, prompt: s.prompt, agent: typeof s.agent === 'string' ? s.agent : null });
  }

  // Channels where a new alert starts an investigation on its own, without a mention.
  const watches = [];
  const watchNames = new Set();
  if (raw.watches !== undefined && !Array.isArray(raw.watches)) errors.push('watches: must be a list');
  for (const [i, w] of (Array.isArray(raw.watches) ? raw.watches : []).entries()) {
    const at = `watches[${i}]`;
    if (!w || typeof w !== 'object') { errors.push(`${at}: must be an object`); continue; }
    for (const key of ['channel', 'project', 'match']) {
      if (typeof w[key] !== 'string' || !w[key]) errors.push(`${at}.${key}: required`);
    }
    if (w.project && !projects[w.project]) errors.push(`${at}.project: "${w.project}" is not one of the projects`);
    checkAgentRef(w.agent, projects[w.project], at, errors);
    if (typeof w.match === 'string' && w.match) checkRegex(w.match, `${at}.match`, errors);
    if (w.from !== undefined && !isStringArray(w.from)) errors.push(`${at}.from: a list of bot IDs, member IDs or bot names`);
    if (w.prompt !== undefined && typeof w.prompt !== 'string') errors.push(`${at}.prompt: must be a string`);
    const cooldown = w.cooldownMinutes ?? 60;
    if (!Number.isFinite(cooldown) || cooldown < 0 || cooldown > 1440) errors.push(`${at}.cooldownMinutes: a number from 0 to 1440`);
    const name = typeof w.name === 'string' && w.name ? w.name : `${w.channel} alerts`;
    if (watchNames.has(name)) errors.push(`${at}.name: "${name}" is used twice`);
    watchNames.add(name);
    watches.push({
      name,
      channel: w.channel,
      project: w.project,
      match: w.match,
      from: isStringArray(w.from) ? w.from : null,
      prompt: typeof w.prompt === 'string' && w.prompt ? w.prompt : null,
      cooldownMinutes: cooldown,
      agent: typeof w.agent === 'string' ? w.agent : null,
    });
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
    watches,
    approvalTimeoutMinutes: num('approvalTimeoutMinutes', 60, 1, 1440),
    maxParallel: num('maxParallel', 3, 1, 20),
    // Agents handing a thread to each other: at most this many in a row without a person's message.
    maxHandoffs: num('maxHandoffs', 3, 0, 30),
    keepDays: num('keepDays', 7, 1, 365),
    shutdownGraceMinutes: num('shutdownGraceMinutes', 30, 0, 240),
    claudePath: typeof raw.claudePath === 'string' ? expandHome(raw.claudePath) : 'claude',
    allowApiKey: raw.allowApiKey === true,
    secretRelay: secretRelayConfig(raw.secretRelay, errors),
  };
  return { config, errors };
}

export const AGENT_NAME = /^[a-z0-9][a-z0-9_-]*$/i;
const AGENT_ICONS = { pm: ':clipboard:', dev: ':hammer_and_wrench:', designer: ':art:', design: ':art:', qa: ':mag:' };

// A project's agents: the roles a task can be given to, like pm, dev, designer and qa. Each runs
// one of Claude Code's agents (`claude --agent`, defined in the repository's .claude/agents/ or in
// ~/.claude/agents/), with its own folders of skills loaded as plugins (`--plugin-dir`).
function agentsConfig(raw, at, projectChannels, errors) {
  const agents = {};
  if (raw === undefined) return agents;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${at}.agents: an object like { "qa": { "agent": "qa", "skills": ".claude/roles/qa" } }`);
    return agents;
  }
  const lower = new Map();
  for (const [key, a] of Object.entries(raw)) {
    const where = `${at}.agents.${key}`;
    if (!AGENT_NAME.test(key)) errors.push(`${where}: agent names may use letters, digits, dash and underscore`);
    if (lower.has(key.toLowerCase())) errors.push(`${where}: "${lower.get(key.toLowerCase())}" already uses this name (names ignore case)`);
    lower.set(key.toLowerCase(), key);
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      errors.push(`${where}: must be an object; {} runs the Claude Code agent of the same name`);
      continue;
    }
    for (const k of ['agent', 'description', 'model', 'displayName', 'icon', 'slackApp']) {
      if (a[k] !== undefined && (typeof a[k] !== 'string' || !a[k])) errors.push(`${where}.${k}: must be a string`);
    }
    if (typeof a.agent === 'string' && a.agent && !/^[a-z0-9][a-z0-9_:-]*$/i.test(a.agent)) errors.push(`${where}.agent: the name of a Claude Code agent, like "qa"`);
    if (typeof a.icon === 'string' && a.icon && !/^:[a-z0-9_+-]+:$/i.test(a.icon) && !/^https:\/\//.test(a.icon)) errors.push(`${where}.icon: an emoji like ":mag:" or an https image address`);
    if (typeof a.slackApp === 'string' && a.slackApp && !/^[a-z0-9_]+$/i.test(a.slackApp)) errors.push(`${where}.slackApp: a short name like "QA"; its tokens are SLACK_BOT_TOKEN_QA and SLACK_APP_TOKEN_QA in the env file, or "main" for beckon's own app`);
    const skills = a.skills === undefined ? [] : typeof a.skills === 'string' ? [a.skills] : a.skills;
    if (!isStringArray(skills)) errors.push(`${where}.skills: a folder of skills (it holds skills/<name>/SKILL.md), or a list of them; relative to the repository, or absolute`);
    if (a.permissionMode !== undefined && !PERMISSION_MODES.includes(a.permissionMode)) errors.push(`${where}.permissionMode: one of ${PERMISSION_MODES.join(', ')}`);
    const channels = a.channels ?? [];
    if (!isStringArray(channels)) errors.push(`${where}.channels: a list of this project's channels where this agent takes new tasks`);
    for (const c of isStringArray(channels) ? channels : []) {
      if (!projectChannels.includes(c)) errors.push(`${where}.channels: ${c} is not one of this project's channels`);
    }
    agents[key] = {
      name: key,
      agent: typeof a.agent === 'string' && a.agent ? a.agent : key,
      description: typeof a.description === 'string' ? a.description : null,
      // How its messages appear in Slack (needs the chat:write.customize scope).
      displayName: typeof a.displayName === 'string' && a.displayName ? a.displayName : key.length <= 3 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1),
      icon: typeof a.icon === 'string' && a.icon ? a.icon : AGENT_ICONS[key.toLowerCase()] ?? ':robot_face:',
      skills: isStringArray(skills) ? skills.map(expandHome) : [],
      model: typeof a.model === 'string' && a.model ? a.model : null,
      permissionMode: PERMISSION_MODES.includes(a.permissionMode) ? a.permissionMode : null,
      channels: isStringArray(channels) ? channels : [],
      // A Slack app of its own (a real member people can @mention), or "main": beckon's app as is.
      slackApp: typeof a.slackApp === 'string' && /^[a-z0-9_]+$/i.test(a.slackApp) ? a.slackApp.toUpperCase() : null,
    };
  }
  return agents;
}

function checkAgentRef(agent, project, at, errors) {
  if (agent === undefined) return;
  if (typeof agent !== 'string' || !agent) errors.push(`${at}.agent: the name of one of the project's agents`);
  else if (project && !project.agents[agent]) errors.push(`${at}.agent: "${agent}" is not one of the agents of project "${project.name}"`);
}

// Secret handoff (src/secrets.mjs) through your own relay on Cloudflare (relay/). Off unless
// configured. The relay token is BECKON_RELAY_TOKEN in ~/.beckon/env.
function secretRelayConfig(raw, errors) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') {
    errors.push('secretRelay: an object like { "url": "https://beckon-relay.you.workers.dev" }');
    return null;
  }
  let url = null;
  try {
    url = new URL(raw.url);
  } catch {
    errors.push('secretRelay.url: the https address of your deployed relay (relay/)');
  }
  if (url && url.protocol !== 'https:') errors.push('secretRelay.url: must be https');
  const ttl = raw.ttlMinutes ?? 5;
  if (typeof ttl !== 'number' || ttl < 1 || ttl > 30) errors.push('secretRelay.ttlMinutes: 1 to 30');
  return {
    url: url ? url.origin : null,
    ttlMinutes: ttl,
    peekabooPath: expandHome(raw.peekabooPath ?? '~/.beckon/bin/peekaboo'),
    axHelperPath: expandHome(raw.axHelperPath ?? '~/.beckon/bin/beckon-ax'),
  };
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
