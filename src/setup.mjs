import { existsSync, writeFileSync, mkdirSync, statSync, chmodSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homePaths, beckonHome, loadEnvFile, loadConfig } from './config.mjs';
import { SlackApi } from './slack.mjs';

export const CONFIG_TEMPLATE = {
  users: ['U0000000000'],
  projects: {
    myapp: {
      path: '~/code/myapp',
      channels: ['#myapp'],
      permissionMode: 'acceptEdits',
      alwaysAsk: [],
    },
  },
  schedules: [
    {
      name: 'Morning report',
      cron: '0 8 * * 1-5',
      timezone: 'UTC',
      project: 'myapp',
      channel: '#myapp',
      prompt: 'Summarize what changed in the last day: merged and open pull requests, failing CI runs, and anything that needs my attention. Keep it under 15 lines.',
    },
  ],
  approvalTimeoutMinutes: 60,
  maxParallel: 3,
  keepDays: 7,
};

const ENV_TEMPLATE = `# beckon reads these at start. Keep this file private (chmod 600).
# Bot token: Slack app > OAuth & Permissions > Bot User OAuth Token.
SLACK_BOT_TOKEN=
# App token: Slack app > Basic Information > App-Level Tokens, with the connections:write scope.
SLACK_APP_TOKEN=
# Linux servers only, when claude is not logged in interactively: run "claude setup-token" and paste it here.
# CLAUDE_CODE_OAUTH_TOKEN=
`;

export function init(env = process.env) {
  const paths = homePaths(beckonHome(env));
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const made = [];
  if (!existsSync(paths.config)) {
    writeFileSync(paths.config, JSON.stringify(CONFIG_TEMPLATE, null, 2) + '\n');
    made.push(paths.config);
  }
  if (!existsSync(paths.env)) {
    writeFileSync(paths.env, ENV_TEMPLATE, { mode: 0o600 });
    made.push(paths.env);
  }
  return { paths, made };
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60_000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim() || err?.message || '' });
    });
  });
}

// Each check returns [ok, message]. ok is true, false, or 'warn'.
export async function doctor(env = process.env) {
  const out = [];
  const add = (ok, msg) => out.push([ok, msg]);
  const paths = homePaths(beckonHome(env));

  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 22, `Node ${process.versions.node}${major >= 22 ? '' : ' (beckon needs 22 or newer)'}`);

  loadEnvFile(paths.env, env);
  if (existsSync(paths.env)) {
    const mode = statSync(paths.env).mode & 0o777;
    if (mode & 0o077) {
      chmodSync(paths.env, 0o600);
      add('warn', `${paths.env} was readable by others; changed it to 600`);
    }
  }

  let config = null;
  try {
    config = loadConfig(paths.config);
    add(true, `Config ${paths.config}`);
  } catch (e) {
    add(false, e.message);
  }

  const claudeBin = config?.claudePath ?? 'claude';
  const version = await run(claudeBin, ['--version']);
  add(version.ok, version.ok ? `claude ${version.stdout}` : `claude was not found (${claudeBin}). Install Claude Code and log in.`);

  if (env.ANTHROPIC_API_KEY && !config?.allowApiKey) {
    add('warn', 'ANTHROPIC_API_KEY is set. beckon removes it for claude so your subscription is used; set "allowApiKey": true to bill the API instead.');
  }

  if (version.ok) {
    const auth = await run(claudeBin, ['auth', 'status'], { env: { ...env, ANTHROPIC_API_KEY: config?.allowApiKey ? env.ANTHROPIC_API_KEY : '' } });
    let status = null;
    try {
      status = JSON.parse(auth.stdout);
    } catch {
      /* older claude versions print text */
    }
    if (status?.loggedIn === true) add(true, `claude is logged in (${status.authMethod ?? 'unknown method'})`);
    else if (status?.loggedIn === false) add(false, 'claude is not logged in. Run claude once and log in, or put CLAUDE_CODE_OAUTH_TOKEN in the env file.');
    else add('warn', 'Could not confirm the claude login with "claude auth status".');
  }

  const gitOk = await run('git', ['--version']);
  add(gitOk.ok, gitOk.ok ? gitOk.stdout : 'git was not found');

  for (const p of Object.values(config?.projects ?? {})) {
    const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: existsSync(p.path) ? p.path : undefined });
    add(existsSync(p.path) && inside.ok, existsSync(p.path) ? `Project ${p.name}: ${p.path}${inside.ok ? '' : ' is not a git repository'}` : `Project ${p.name}: ${p.path} does not exist`);
  }

  const botToken = env.SLACK_BOT_TOKEN;
  const appToken = env.SLACK_APP_TOKEN;
  if (!botToken) add(false, `SLACK_BOT_TOKEN is missing in ${paths.env}`);
  if (!appToken) add(false, `SLACK_APP_TOKEN is missing in ${paths.env}`);
  if (botToken) {
    try {
      const auth = await new SlackApi(botToken).call('auth.test');
      add(true, `Slack bot: @${auth.user} in ${auth.team}`);
      if (config) {
        const channels = new Set();
        for (const p of Object.values(config.projects)) for (const c of p.channels) channels.add(c);
        const named = [...channels].filter((c) => c.startsWith('#'));
        if (named.length) {
          const found = new Set();
          let cursor;
          do {
            const page = await new SlackApi(botToken).call('conversations.list', { types: 'public_channel,private_channel', exclude_archived: true, limit: 1000, cursor });
            for (const ch of page.channels ?? []) if (ch.is_member) found.add(`#${ch.name}`);
            cursor = page.response_metadata?.next_cursor || undefined;
          } while (cursor);
          for (const c of named) add(found.has(c) ? true : 'warn', found.has(c) ? `Channel ${c}` : `Channel ${c}: beckon is not a member. Invite it with /invite @beckon`);
        }
      }
    } catch (e) {
      add(false, `Slack bot token: ${e.message}`);
    }
  }
  if (appToken) {
    try {
      await new SlackApi(appToken).call('apps.connections.open');
      add(true, 'Slack app token can open a Socket Mode connection');
    } catch (e) {
      add(false, `Slack app token: ${e.message}`);
    }
  }
  return out;
}

export function manifestPath() {
  return new URL('../slack-app-manifest.json', import.meta.url);
}

export function manifestText() {
  return readFileSync(manifestPath(), 'utf8');
}

