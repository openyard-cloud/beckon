import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, resolve, sep } from 'node:path';
import { homePaths, beckonHome, parseEnvFile, expandHome } from './config.mjs';
import { SlackApi, SocketClient } from './slack.mjs';
import { checkRepo, addProject, writeRaw, findName, PROJECT_NAME } from './projects.mjs';
import { manifestText, doctor, ENV_TEMPLATE } from './setup.mjs';

// "beckon init" in a terminal: a guided setup that ends with beckon answering in Slack. It asks
// for the two Slack tokens and checks each one, then learns the person's member ID and the
// project's channel from a message they send to beckon, so nobody has to dig for IDs.

const PLACEHOLDER_USER = 'U0000000000';
const MEMBER_ID = /^[UW][A-Z0-9]+$/;

// Opens the Slack page that creates the app with beckon's manifest already filled in.
export function manifestUrl() {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(JSON.parse(manifestText())))}`;
}

// Sets keys in the env file and leaves every other line as it was. The file stays private.
export function setEnvValues(file, values) {
  let lines = (existsSync(file) ? readFileSync(file, 'utf8') : ENV_TEMPLATE).split('\n');
  for (const [key, value] of Object.entries(values)) {
    const at = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(l));
    if (at >= 0) lines[at] = `${key}=${value}`;
    else {
      if (lines.at(-1) === '') lines.pop();
      lines.push(`${key}=${value}`, '');
    }
  }
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

export function tildePath(p) {
  const home = homedir();
  return p === home ? '~' : p.startsWith(home + sep) ? `~/${p.slice(home.length + 1)}` : p;
}

export function projectName(path) {
  const name = basename(path).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '');
  return PROJECT_NAME.test(name) ? name : 'app';
}

function run(cmd, args, opts = {}) {
  return new Promise((done) => {
    execFile(cmd, args, { timeout: 60_000, ...opts }, (err, stdout) => done({ ok: !err, out: String(stdout ?? '').trim() }));
  });
}

async function gitTop(dir) {
  const r = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
  return r.ok ? r.out : null;
}

// The first message a person sends beckon: a mention in a channel, or a direct message.
export function helloFrom(ev, botUserId) {
  if (!ev?.user || ev.bot_id || ev.subtype || ev.user === botUserId) return null;
  if (ev.type === 'app_mention') return { user: ev.user, channel: ev.channel, ts: ev.ts, im: false };
  if (ev.type === 'message' && ev.channel_type === 'im') return { user: ev.user, channel: ev.channel, ts: ev.ts, im: true };
  return null;
}

function waitForHello(socket, botUserId) {
  return new Promise((done) => {
    const onEvent = (ev) => {
      const hello = helloFrom(ev, botUserId);
      if (!hello) return;
      socket.off('event', onEvent);
      done(hello);
    };
    socket.on('event', onEvent);
  });
}

// A terminal with plain questions, yes/no questions and hidden input for tokens.
export function terminalIO({ input = process.stdin, output = process.stdout } = {}) {
  // readline writes the echo of what is typed through this stream, so muting it hides a token.
  let muted = false;
  const echo = new Writable({
    write(chunk, encoding, done) {
      if (muted) done();
      else output.write(chunk, encoding, done);
    },
  });
  Object.defineProperty(echo, 'columns', { get: () => output.columns });
  echo.isTTY = output.isTTY;
  const rl = createInterface({ input, output: echo, terminal: true });
  rl.on('SIGINT', () => {
    output.write('\nStopped. Run "beckon init" again to pick up where you left off.\n');
    process.exit(130);
  });
  return {
    say: (text = '') => output.write(`${text}\n`),
    async ask(question, { def = '', signal } = {}) {
      const prompt = !question ? '' : def ? `${question} [${def}]: ` : `${question}: `;
      const answer = await rl.question(prompt, signal ? { signal } : undefined);
      return answer.trim() || def;
    },
    async secret(question) {
      output.write(`${question}: `);
      muted = true;
      try {
        return (await rl.question('')).trim();
      } finally {
        muted = false;
        output.write('\n');
      }
    },
    async confirm(question, def = true) {
      const answer = (await rl.question(`${question} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
      return answer ? answer.startsWith('y') : def;
    },
    close: () => rl.close(),
  };
}

export function openUrl(url, platform = process.platform) {
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? null : 'xdg-open';
  if (!cmd) return Promise.resolve(false);
  return run(cmd, [url], { timeout: 10_000 }).then((r) => r.ok);
}

async function tokenStep(io, { label, prefix, where, check }) {
  for (;;) {
    const token = await io.secret(`${label} (${prefix}...)`);
    if (!token) {
      io.say(`  Nothing pasted. ${where}`);
      continue;
    }
    if (!token.startsWith(prefix)) {
      io.say(`  That does not start with ${prefix}. ${where}`);
      continue;
    }
    try {
      const note = await check(token);
      io.say(`  ok  ${note}`);
      return token;
    } catch (e) {
      io.say(`  Slack did not accept it: ${e.code ?? e.message}. Copy it again and paste it here.`);
    }
  }
}

export async function guidedInit({
  io,
  env = process.env,
  cwd = process.cwd(),
  slack = (token) => new SlackApi(token),
  socketFor = (token) => new SocketClient(token),
  open = openUrl,
  runDoctor = doctor,
  install = null,
  claudeBin = null,
} = {}) {
  const paths = homePaths(beckonHome(env));
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  let raw = {};
  if (existsSync(paths.config)) {
    try {
      raw = JSON.parse(readFileSync(paths.config, 'utf8'));
    } catch (e) {
      io.say(`${paths.config} is not valid JSON (${e.message}). Fix or move it, then run "beckon init" again.`);
      return false;
    }
  }

  io.say('Setting up beckon. It takes about five minutes, and ends with beckon answering you in Slack.');
  io.say('');

  // 1. Claude Code, logged in.
  io.say('1/4  Claude Code');
  const claude = claudeBin ?? raw.claudePath ?? 'claude';
  for (;;) {
    const version = await run(claude, ['--version']);
    const auth = version.ok ? await run(claude, ['auth', 'status'], { env: { ...env, ANTHROPIC_API_KEY: '' } }) : null;
    let status = null;
    try {
      status = JSON.parse(auth?.out ?? '');
    } catch {
      /* older versions print text */
    }
    if (version.ok && status?.loggedIn !== false) {
      io.say(`  ok  claude ${version.out}${status?.email ? `, logged in as ${status.email}` : ''}`);
      break;
    }
    io.say(version.ok
      ? '  Claude Code is not logged in. In another terminal, run "claude" and log in with your Claude account.'
      : `  Claude Code was not found (${claude}). Install it from https://code.claude.com/docs and log in.`);
    if (!(await io.confirm('  Check again?'))) {
      io.say('  Skipped. beckon cannot run tasks until Claude Code works; "beckon doctor" checks it.');
      break;
    }
  }
  io.say('');

  // 2. The Slack app and its two tokens.
  io.say('2/4  Slack app');
  const saved = existsSync(paths.env) ? parseEnvFile(readFileSync(paths.env, 'utf8')) : {};
  let botToken = saved.SLACK_BOT_TOKEN || env.SLACK_BOT_TOKEN || '';
  let appToken = saved.SLACK_APP_TOKEN || env.SLACK_APP_TOKEN || '';
  let bot = null;
  if (botToken && appToken) {
    try {
      bot = await slack(botToken).call('auth.test');
      await slack(appToken).call('apps.connections.open');
      io.say(`  ok  already set up: @${bot.user} in ${bot.team}`);
      if (!(await io.confirm('  Keep this Slack app?'))) bot = null;
    } catch {
      bot = null;
    }
  }
  if (!bot) {
    const url = manifestUrl();
    io.say('  Create beckon\'s Slack app from its manifest. This page has it filled in:');
    io.say(`  ${url}`);
    if (await io.confirm('  Open it in your browser?')) await open(url);
    io.say('  a. Pick your workspace, check the summary and press Create.');
    io.say('  b. Press "Install to <workspace>" and allow it.');
    io.say('  c. Under OAuth & Permissions, copy the Bot User OAuth Token.');
    botToken = await tokenStep(io, {
      label: '  Bot token',
      prefix: 'xoxb-',
      where: 'It is under OAuth & Permissions > Bot User OAuth Token, after you install the app.',
      check: async (t) => {
        bot = await slack(t).call('auth.test');
        return `@${bot.user} in ${bot.team}`;
      },
    });
    io.say('  d. Under Basic Information > App-Level Tokens, press "Generate Token and Scopes",');
    io.say('     name it anything, add the scope connections:write and press Generate. Copy the token.');
    appToken = await tokenStep(io, {
      label: '  App token',
      prefix: 'xapp-',
      where: 'It is under Basic Information > App-Level Tokens, with the scope connections:write.',
      check: async (t) => {
        await slack(t).call('apps.connections.open');
        return 'it can open a connection to Slack';
      },
    });
    setEnvValues(paths.env, { SLACK_BOT_TOKEN: botToken, SLACK_APP_TOKEN: appToken });
    io.say(`  Saved both tokens in ${paths.env} (only you can read it).`);
  }
  io.say('');

  // 3. The first project: a git repository on this machine.
  io.say('3/4  Project');
  const existing = Object.entries(raw.projects ?? {}).filter(([n, p]) => !(n === 'myapp' && p?.path === '~/code/myapp'));
  let path;
  for (;;) {
    const answer = await io.ask('  Folder of the git repository beckon should work on', { def: tildePath((await gitTop(cwd)) ?? '') });
    if (!answer) continue;
    const full = resolve(cwd, expandHome(answer));
    const problem = checkRepo(full);
    if (problem) {
      io.say(`  ${problem}`);
      continue;
    }
    path = (await gitTop(full)) ?? full;
    break;
  }
  let name = existing.find(([, p]) => resolve(expandHome(p.path)) === path)?.[0] ?? null;
  if (name) io.say(`  This is already the project "${name}".`);
  while (!name) {
    const answer = await io.ask('  Project name', { def: projectName(path) });
    if (!PROJECT_NAME.test(answer)) io.say('  Use letters, digits, dot, dash and underscore.');
    else if (findName(raw.projects, answer) && !(answer === 'myapp' && raw.projects.myapp?.path === '~/code/myapp')) io.say(`  "${answer}" is taken.`);
    else name = answer;
  }
  io.say('');

  // 4. A hello in Slack gives the member ID and the project's channel.
  io.say('4/4  Say hello in Slack');
  io.say(`  In Slack, open the channel for ${name} (make one if you like, say #${name}) and send:`);
  io.say('      @beckon hello');
  io.say('  Slack asks whether to invite beckon: choose Invite. To use beckon only in direct');
  io.say('  messages, send it a direct message instead (Apps > beckon in the sidebar).');
  io.say('  Waiting for your message. Press Enter to type your member ID yourself instead.');
  if (bot && saved.SLACK_APP_TOKEN) {
    // Slack hands each event to one of the app's open connections, maybe a running beckon's.
    io.say('  (If beckon is already running, it may get your hello instead: then press Enter.)');
  }
  let user = null;
  let channel = null;
  const socket = socketFor(appToken);
  try {
    await socket.start();
    while (!user) {
      const stop = new AbortController();
      const typed = io.ask('', { signal: stop.signal }).then(() => null, () => null);
      const hello = await Promise.race([waitForHello(socket, bot.user_id), typed]);
      stop.abort();
      if (!hello) break;
      let where = 'a direct message';
      if (!hello.im) {
        const info = await slack(botToken).call('conversations.info', { channel: hello.channel }).catch(() => null);
        where = info?.channel?.name ? `#${info.channel.name}` : hello.channel;
      }
      if (await io.confirm(`  Got a message from member ${hello.user} in ${where}. Is that you?`)) {
        user = hello.user;
        channel = hello.im ? null : hello.channel;
        await slack(botToken).call('chat.postMessage', {
          channel: hello.channel,
          thread_ts: hello.ts,
          text: `:wave: Hi <@${user}>! beckon is set up for *${name}*${channel ? ', and tasks in this channel go to it' : ''}. Finish in the terminal.`,
        }).catch(() => {});
      } else {
        io.say('  Waiting for your message. Press Enter to type your member ID yourself instead.');
      }
    }
  } catch (e) {
    io.say(`  Could not listen to Slack (${e.message}).`);
  } finally {
    socket.stop();
  }
  if (!user) {
    io.say('  Your member ID is in Slack: your profile > the ⋯ button > Copy member ID.');
    for (;;) {
      const answer = (await io.ask('  Member ID')).toUpperCase();
      if (MEMBER_ID.test(answer)) {
        user = answer;
        break;
      }
      io.say('  Member IDs start with U or W, like U0123ABCD.');
    }
    const answer = await io.ask('  Channel for this project (#name, or empty for direct messages only)');
    channel = answer ? (answer.startsWith('#') || /^[CG][A-Z0-9]+$/.test(answer) ? answer : `#${answer}`) : null;
    if (channel) io.say(`  Remember to type /invite @beckon in ${channel}.`);
  }
  io.say('');

  // Write the config: the template's placeholders give way to the real values.
  raw.users = [...new Set([...(raw.users ?? []).filter((u) => u !== PLACEHOLDER_USER), user])];
  if (raw.projects?.myapp?.path === '~/code/myapp') {
    delete raw.projects.myapp;
    raw.schedules = (raw.schedules ?? []).filter((s) => s.project !== 'myapp');
    if (!raw.schedules.length) delete raw.schedules;
  }
  if (!findName(raw.projects, name)) {
    const problem = addProject(raw, { name, path: tildePath(path), channels: channel ? [channel] : [] });
    if (problem) {
      io.say(`  ${problem} The project is added without a channel.`);
      addProject(raw, { name, path: tildePath(path), channels: [] });
    }
  } else if (channel && !(raw.projects[name].channels ?? []).includes(channel)) {
    raw.projects[name].channels = [...(raw.projects[name].channels ?? []), channel];
  }
  raw.projects[name].permissionMode ??= 'acceptEdits';
  // DMs keep going where they went: to the project that was there first.
  if (!raw.defaultProject || !raw.projects[raw.defaultProject]) raw.defaultProject = existing[0]?.[0] ?? name;
  raw.approvalTimeoutMinutes ??= 60;
  raw.maxParallel ??= 3;
  raw.keepDays ??= 7;
  const written = writeRaw(paths.config, raw);
  if (written.errors) {
    io.say('The config would not be valid, so nothing was written:');
    for (const e of written.errors) io.say(`  ${e}`);
    return false;
  }
  io.say(`Saved ${paths.config}.`);
  io.say('');

  io.say('Checking everything:');
  let failed = 0;
  for (const [ok, msg] of await runDoctor(env)) {
    if (ok === false) failed++;
    io.say(`  ${ok === true ? 'ok  ' : ok === 'warn' ? 'warn' : 'FAIL'}  ${msg}`);
  }
  io.say('');
  if (failed) {
    io.say('Fix what failed above, then run "beckon doctor" and "beckon start".');
    return false;
  }

  if (install && (await io.confirm('Run beckon in the background now, and every time you log in?'))) {
    await install();
  } else {
    io.say('Run "beckon start" to start it (or "beckon service install" for the background).');
  }
  io.say('');
  io.say(channel
    ? `Done. Give beckon its first task in Slack, in that channel: @beckon what does this repository do?`
    : 'Done. Give beckon its first task in a direct message: what does this repository do?');
  io.say('Risky actions (deploys, pushes to main, merges, migrations) wait for your Allow button.');
  return true;
}
