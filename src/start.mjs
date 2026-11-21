import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, watch, existsSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { SecretBroker, startSecretServer, runJson, peekabooTypist } from './secrets.mjs';
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

  const secretSetup = await startSecrets(config.secretForm);

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
  const shutdown = async (signal) => {
    if (stopping) {
      log(`Got ${signal} again, stopping now`);
      await beckon.stopAll();
      process.exit(0);
    }
    stopping = true;
    log(`Got ${signal}, finishing running tasks before stopping`);
    await beckon.shutdownGracefully(beckon.config.shutdownGraceMinutes * 60_000);
    secretSetup?.broker.cancelAll('beckon is shutting down');
    await secretSetup?.server.close();
    socket.stop();
    await hook.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
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

// The secret handoff form. Needs the beckon-ax helper (compiled from helpers/ax-focus.swift on
// first use) and the openyard Peekaboo build with `type --secret-stdin`.
async function startSecrets(form) {
  if (!form) return null;
  if (!existsSync(form.axHelperPath)) {
    const source = fileURLToPath(new URL('../helpers/ax-focus.swift', import.meta.url));
    mkdirSync(dirname(form.axHelperPath), { recursive: true });
    const built = spawnSync('swiftc', ['-O', '-o', form.axHelperPath, source], { encoding: 'utf8' });
    if (built.status !== 0) {
      log(`Secret handoff is off: could not build ${form.axHelperPath} (${(built.stderr || built.error?.message || '').trim().split('\n').pop()})`);
      return null;
    }
  }
  if (!existsSync(form.peekabooPath)) {
    log(`Secret handoff is off: ${form.peekabooPath} is missing (build openyard-cloud/Peekaboo)`);
    return null;
  }
  const broker = new SecretBroker({
    publicUrl: form.publicUrl,
    ttlMs: form.ttlMinutes * 60_000,
    readFocus: (app) => runJson(form.axHelperPath, [app]),
    typeSecret: peekabooTypist(form.peekabooPath),
    log,
  });
  try {
    const server = await startSecretServer(broker, { port: form.port });
    log(`Secret handoff form on 127.0.0.1:${server.port}, published as ${form.publicUrl}`);
    return { broker, server };
  } catch (e) {
    log(`Secret handoff is off: could not listen on 127.0.0.1:${form.port} (${e.message})`);
    return null;
  }
}
