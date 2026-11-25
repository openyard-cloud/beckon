import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, watch, existsSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { SecretBroker, runJson, peekabooTypist } from './secrets.mjs';
import { RelayClient } from './relay.mjs';
import { PasskeyStore } from './passkeys.mjs';
import { join } from 'node:path';
import { beckonHome, homePaths, loadEnvFile, loadConfig, validateConfig } from './config.mjs';
import { SlackApi, SocketClient } from './slack.mjs';
import { StateStore } from './state.mjs';
import { startHookServer } from './hookserver.mjs';
import { Beckon } from './daemon.mjs';

export function log(msg) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

export async function start(env = process.env) {
  const paths = homePaths(beckonHome(env));
  loadEnvFile(paths.env, env);
  const config = loadConfig(paths.config);
  const botToken = env.SLACK_BOT_TOKEN;
  const appToken = env.SLACK_APP_TOKEN;
  if (!botToken?.startsWith('xoxb-')) throw new Error(`SLACK_BOT_TOKEN (xoxb-...) is missing. Put it in ${paths.env}.`);
  if (!appToken?.startsWith('xapp-')) throw new Error(`SLACK_APP_TOKEN (xapp-...) is missing. Put it in ${paths.env}.`);
  mkdirSync(paths.worktrees, { recursive: true });
  if (env.BECKON_CAFFEINATE === '1' && process.platform === 'darwin') {
    spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref();
  }

  const secretSetup = startSecrets(config.secretRelay, env, paths.home);

  const slack = new SlackApi(botToken);
  const state = new StateStore(paths.state);
  const beckon = new Beckon({
    config,
    slack,
    state,
    worktreesDir: paths.worktrees,
    hookScript: fileURLToPath(new URL('../bin/beckon-hook.mjs', import.meta.url)),
    env,
    log,
    configFile: paths.config,
    secrets: secretSetup?.broker ?? null,
    secretScript: fileURLToPath(new URL('../bin/beckon-secret.mjs', import.meta.url)),
  });
  beckon.configText = readFileSync(paths.config, 'utf8');
  const hook = await startHookServer((body) => beckon.onHook(body), { log });
  await beckon.start({ hook });

  const socket = new SocketClient(appToken, { log });
  const safely = (label, fn) => (arg) => {
    Promise.resolve()
      .then(() => fn(arg))
      .catch((e) => log(`${label} failed: ${e.stack ?? e.message}`));
  };
  socket.on('event', safely('Event', (ev) => beckon.handleEvent(ev)));
  socket.on('interactive', safely('Button', (p) => beckon.handleInteractive(p)));
  socket.on('ready', () => log('Listening for Slack messages'));
  await socket.start();
  watchConfig(paths.config, beckon);

  let stopping = false;
  const shutdown = async (signal, graceMs = beckon.config.shutdownGraceMinutes * 60_000) => {
    if (stopping) {
      log(`Got ${signal} again, stopping now`);
      await beckon.stopAll();
      process.exit(0);
    }
    stopping = true;
    log(`Got ${signal}, finishing running tasks before stopping`);
    await beckon.shutdownGracefully(graceMs);
    secretSetup?.broker.cancelAll('beckon is shutting down');
    secretSetup?.relay.stop();
    socket.stop();
    await hook.close();
    process.exit(0);
  };
  // launchd kills a LaunchAgent 60 seconds after SIGTERM, whatever ExitTimeOut says. Stop in time
  // to deny open approvals cleanly instead of leaving buttons that nothing answers.
  const termGrace = () => Math.min(beckon.config.shutdownGraceMinutes * 60_000, process.platform === 'darwin' ? 45_000 : Infinity);
  process.on('SIGTERM', () => shutdown('SIGTERM', termGrace()));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // `beckon service restart` on macOS: drain for the full grace period, then exit; launchd's
  // KeepAlive starts beckon again.
  process.on('SIGUSR2', () => shutdown('SIGUSR2 (restart)'));
}

// Edits to config.json take effect without a restart. A file that does not parse or validate is
// ignored (beckon keeps the config it has) and the problems go to the log.
export function watchConfig(file, beckon, { debounceMs = 500 } = {}) {
  let timer = null;
  const reload = () => {
    timer = null;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    if (text === beckon.configText) return;
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      log(`${file} changed but is not valid JSON, keeping the old config: ${e.message}`);
      beckon.configText = text;
      return;
    }
    const { config: next, errors } = validateConfig(raw);
    beckon.configText = text;
    if (errors.length) {
      log(`${file} changed but has problems, keeping the old config:\n  - ${errors.join('\n  - ')}`);
      return;
    }
    beckon.applyConfig(next, text).catch((e) => log(`Could not apply the new config: ${e.message}`));
  };
  // The folder is watched rather than the file, because editors often replace the file.
  const watcher = watch(dirname(file), (_, name) => {
    if (name && name !== basename(file)) return;
    clearTimeout(timer);
    timer = setTimeout(reload, debounceMs);
  });
  watcher.unref?.();
  return watcher;
}

// The secret handoff. Needs the relay (relay/, deployed to Cloudflare) and its token, the
// beckon-ax helper (compiled from helpers/ax-focus.swift on first use) and the openyard Peekaboo
// build with `type --secret-stdin`.
function startSecrets(settings, env, home) {
  if (!settings) return null;
  const token = env.BECKON_RELAY_TOKEN;
  if (!token || token.length < 32) {
    log('Secret handoff is off: BECKON_RELAY_TOKEN is missing from ~/.beckon/env');
    return null;
  }
  if (!existsSync(settings.axHelperPath)) {
    const source = fileURLToPath(new URL('../helpers/ax-focus.swift', import.meta.url));
    mkdirSync(dirname(settings.axHelperPath), { recursive: true });
    const built = spawnSync('swiftc', ['-O', '-o', settings.axHelperPath, source], { encoding: 'utf8' });
    if (built.status !== 0) {
      log(`Secret handoff is off: could not build ${settings.axHelperPath} (${(built.stderr || built.error?.message || '').trim().split('\n').pop()})`);
      return null;
    }
  }
  if (!existsSync(settings.peekabooPath)) {
    log(`Secret handoff is off: ${settings.peekabooPath} is missing (build openyard-cloud/Peekaboo)`);
    return null;
  }
  const relay = new RelayClient({ url: settings.url, token, log });
  const broker = new SecretBroker({
    relayUrl: settings.url,
    relay,
    passkeys: new PasskeyStore(join(home, 'passkeys.json')),
    ttlMs: settings.ttlMinutes * 60_000,
    readFocus: (app) => runJson(settings.axHelperPath, [app]),
    typeSecret: peekabooTypist(settings.peekabooPath),
    log,
  });
  relay.once('ready', () => log(`Connected to the secret relay ${settings.url}`));
  relay.start();
  return { broker, relay };
}
