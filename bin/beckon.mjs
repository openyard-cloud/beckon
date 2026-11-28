#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beckonHome, homePaths } from '../src/config.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const [cmd, sub, ...rest] = process.argv.slice(2);

const HELP = `beckon ${pkg.version}: run Claude Code from Slack on this machine

Usage:
  beckon init                 guided setup: Slack app, tokens, first project, a hello in Slack
  beckon init --files         only create ~/.beckon/config.json and ~/.beckon/env to edit by hand
  beckon manifest             print the Slack app manifest (paste it at api.slack.com/apps)
  beckon doctor               check node, claude, git, the config and the Slack tokens
  beckon start                run in the foreground
  beckon service install      run in the background and on login (launchd or systemd)
  beckon service restart      restart after running tasks finish
  beckon service uninstall
  beckon service status

Options for "service install":
  --no-caffeinate             macOS: let the Mac sleep while beckon runs

Set BECKON_HOME to keep the config somewhere other than ~/.beckon.`;

async function installService(flags) {
  const service = await import('../src/service.mjs');
  const paths = homePaths(beckonHome());
  let grace = 30;
  try {
    const { loadConfig } = await import('../src/config.mjs');
    grace = loadConfig(paths.config).shutdownGraceMinutes;
  } catch {
    /* no config yet: use the default */
  }
  const { file, notes } = await service.installService({
    bin: fileURLToPath(import.meta.url),
    logsDir: paths.logs,
    caffeinate: !flags.includes('--no-caffeinate'),
    stopSeconds: grace * 60 + 60,
  });
  console.log(`Wrote ${file}`);
  for (const n of notes) console.log(n);
}

async function main() {
  switch (cmd) {
    case 'init': {
      if (sub !== '--files' && process.stdin.isTTY && process.stdout.isTTY) {
        const { guidedInit, terminalIO } = await import('../src/wizard.mjs');
        const io = terminalIO();
        try {
          const ok = await guidedInit({ io, install: () => installService([]) });
          process.exitCode = ok ? 0 : 1;
        } finally {
          io.close();
        }
        return;
      }
      const { init } = await import('../src/setup.mjs');
      const { paths, made } = init();
      for (const f of made) console.log(`Created ${f}`);
      if (!made.length) console.log(`Already set up in ${paths.home}`);
      console.log(`
Next (or run "beckon init" in a terminal to be guided through these):
  1. Create the Slack app: https://api.slack.com/apps?new_app=1 > From a manifest > paste "beckon manifest".
  2. Install it to your workspace. Copy the Bot User OAuth Token (xoxb-...) into ${paths.env}.
  3. Basic Information > App-Level Tokens > generate one with connections:write. Copy it (xapp-...) into the same file.
  4. Edit ${paths.config}: your Slack member ID (profile > ... > Copy member ID), projects and channels.
  5. /invite @beckon in each project channel, then run "beckon doctor" and "beckon start".`);
      return;
    }
    case 'manifest': {
      const { manifestText } = await import('../src/setup.mjs');
      process.stdout.write(manifestText());
      return;
    }
    case 'doctor': {
      const { doctor } = await import('../src/setup.mjs');
      const results = await doctor();
      let failed = 0;
      for (const [ok, msg] of results) {
        const mark = ok === true ? 'ok  ' : ok === 'warn' ? 'warn' : 'FAIL';
        if (ok === false) failed++;
        console.log(`${mark}  ${msg}`);
      }
      process.exitCode = failed ? 1 : 0;
      return;
    }
    case 'start': {
      const { start } = await import('../src/start.mjs');
      await start();
      return;
    }
    case 'service': {
      const service = await import('../src/service.mjs');
      if (sub === 'install') {
        await installService(rest);
      } else if (sub === 'restart') {
        console.log('Restarting. Running tasks get to finish first (shutdownGraceMinutes).');
        await service.restartService();
        console.log('Restarted.');
      } else if (sub === 'uninstall') {
        const { file } = await service.uninstallService();
        console.log(`Stopped and removed ${file}`);
      } else if (sub === 'status') {
        console.log(await service.serviceStatus());
      } else {
        console.log(HELP);
        process.exitCode = 1;
      }
      return;
    }
    case '--version':
    case '-v':
    case 'version':
      console.log(pkg.version);
      return;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command "${cmd}".\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
