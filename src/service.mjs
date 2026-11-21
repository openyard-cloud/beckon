import { execFile } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';

export const LABEL = 'cloud.openyard.beckon';
const MARK = '__BECKON_PATH__';

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || err?.message || '' });
    });
  });
}

// A service starts with a bare PATH, so record the one an interactive login shell has: that is
// where claude, gh, node and deploy tools installed with nvm, Homebrew or npm are found.
export async function loginShellPath(env = process.env) {
  const shell = env.SHELL || '/bin/sh';
  const res = await run(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], { timeout: 10_000 });
  const m = res.stdout.match(new RegExp(`${MARK}(.*?)${MARK}`, 's'));
  return m && m[1] ? m[1] : env.PATH ?? '/usr/bin:/bin';
}

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function launchdPlist({ node, bin, path, home, logFile, caffeinate = true, beckonHome }) {
  const program = caffeinate ? ['/usr/bin/caffeinate', '-i', node, bin, 'start'] : [node, bin, 'start'];
  const env = { PATH: path, HOME: home };
  if (beckonHome) env.BECKON_HOME = beckonHome;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${program.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>WorkingDirectory</key><string>${xml(home)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

export function systemdUnit({ node, bin, path, beckonHome }) {
  const q = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;
  const lines = [
    '[Unit]',
    'Description=beckon: Claude Code from Slack',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    `ExecStart=${q(node)} ${q(bin)} start`,
    'Restart=always',
    'RestartSec=10',
    `Environment=${q(`PATH=${path}`)}`,
  ];
  if (beckonHome) lines.push(`Environment=${q(`BECKON_HOME=${beckonHome}`)}`);
  lines.push('', '[Install]', 'WantedBy=default.target', '');
  return lines.join('\n');
}

export function serviceFile(platform = process.platform) {
  if (platform === 'darwin') return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
  return join(homedir(), '.config', 'systemd', 'user', 'beckon.service');
}

export async function installService({ bin, logsDir, caffeinate = true, env = process.env, platform = process.platform }) {
  const realBin = realpathSync(bin);
  const notes = [];
  if (/[\\/]_npx[\\/]/.test(realBin)) {
    notes.push('beckon is running from the npx cache, which can be cleaned at any time. Install it for good first: npm install -g github:openyard-cloud/beckon');
  }
  const path = await loginShellPath(env);
  const file = serviceFile(platform);
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  const beckonHome = env.BECKON_HOME;

  if (platform === 'darwin') {
    const logFile = join(logsDir, 'beckon.log');
    writeFileSync(file, launchdPlist({ node: process.execPath, bin: realBin, path, home: homedir(), logFile, caffeinate, beckonHome }));
    const domain = `gui/${userInfo().uid}`;
    await run('launchctl', ['bootout', `${domain}/${LABEL}`]);
    const res = await run('launchctl', ['bootstrap', domain, file]);
    if (!res.ok) throw new Error(`launchctl bootstrap failed: ${res.stderr.trim()}`);
    notes.push(`Started. Logs: ${logFile}`);
    if (caffeinate) notes.push('The Mac will not go to sleep on its own while beckon runs. Closing the lid still sleeps it unless an external display is connected.');
    return { file, notes };
  }

  if (platform === 'linux') {
    writeFileSync(file, systemdUnit({ node: process.execPath, bin: realBin, path, beckonHome }));
    for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', '--now', 'beckon.service'], ['--user', 'restart', 'beckon.service']]) {
      const res = await run('systemctl', args);
      if (!res.ok) throw new Error(`systemctl ${args.join(' ')} failed: ${res.stderr.trim()}`);
    }
    notes.push('Started. Logs: journalctl --user -u beckon -f');
    notes.push(`To keep it running after you log out: sudo loginctl enable-linger ${userInfo().username}`);
    return { file, notes };
  }

  throw new Error(`Installing a service is supported on macOS and Linux, not ${platform}. Run "beckon start" under your own process manager.`);
}

export async function uninstallService({ platform = process.platform } = {}) {
  const file = serviceFile(platform);
  if (platform === 'darwin') {
    await run('launchctl', ['bootout', `gui/${userInfo().uid}/${LABEL}`]);
  } else if (platform === 'linux') {
    await run('systemctl', ['--user', 'disable', '--now', 'beckon.service']);
  }
  if (existsSync(file)) rmSync(file);
  if (platform === 'linux') await run('systemctl', ['--user', 'daemon-reload']);
  return { file };
}

export async function serviceStatus({ platform = process.platform } = {}) {
  if (platform === 'darwin') {
    const res = await run('launchctl', ['print', `gui/${userInfo().uid}/${LABEL}`]);
    if (!res.ok) return 'not installed';
    const state = res.stdout.match(/state = (\S+)/)?.[1] ?? 'unknown';
    const pid = res.stdout.match(/pid = (\d+)/)?.[1];
    return pid ? `${state} (pid ${pid})` : state;
  }
  if (platform === 'linux') {
    const res = await run('systemctl', ['--user', 'is-active', 'beckon.service']);
    return res.stdout.trim() || 'not installed';
  }
  return 'not supported on this platform';
}
