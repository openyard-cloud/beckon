import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { beckonHome, homePaths, loadEnvFile, loadConfig } from './config.mjs';
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
  });
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

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`Got ${signal}, stopping`);
    socket.stop();
    await beckon.stopAll();
    await hook.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
