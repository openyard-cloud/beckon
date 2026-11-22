import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, openSync, writeSync, closeSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The other half of `beckon-secret --run`: gives a secret to one command, once, and cleans up.
//
// - stdin: the command reads it from standard input (gh secret set, wrangler secret put, ...).
// - env:   it is in one environment variable of that command only.
// - file:  it is in a file only this user can read, at $BECKON_SECRET_FILE, which is overwritten
//          and deleted as soon as the command ends, also when it fails or is killed.
//
// The command's output comes back with the value masked, since that output goes to Claude.

const MAX_OUTPUT = 64 * 1024;
const MASK = '[secret]';

// Masks the value, its trimmed form and, for multi-line values, every longer line of it.
export function redact(text, secret) {
  const value = Buffer.isBuffer(secret) ? secret.toString('utf8') : String(secret);
  const parts = new Set([value, value.trim()]);
  if (value.includes('\n')) for (const line of value.split(/\r?\n/)) if (line.trim().length >= 8) parts.add(line.trim());
  let out = text;
  for (const p of [...parts].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(p).join(MASK);
  return out;
}

export function runWithSecret({ command, via, name, secret, cwd = process.cwd(), env = process.env, timeoutMs = 15 * 60_000, shell = '/bin/sh' }) {
  return new Promise((resolve) => {
    const childEnv = { ...env };
    delete childEnv.BECKON_HOOK_TOKEN; // the command needs the secret, not beckon's hook token
    let dir = null;
    let file = null;
    const cleanup = () => {
      if (file) {
        try {
          const fd = openSync(file, 'r+');
          writeSync(fd, Buffer.alloc(statSync(file).size));
          closeSync(fd);
        } catch { /* the command may have removed it */ }
      }
      if (dir) rmSync(dir, { recursive: true, force: true });
      file = dir = null;
    };
    const onSignal = (sig) => { cleanup(); process.kill(process.pid, sig); };
    try {
      if (via === 'env') childEnv[name] = secret.toString('utf8');
      if (via === 'file') {
        dir = mkdtempSync(join(tmpdir(), 'beckon-secret-'));
        file = join(dir, 'secret');
        writeFileSync(file, secret, { mode: 0o600, flag: 'wx' });
        childEnv.BECKON_SECRET_FILE = file;
      }
    } catch (e) {
      cleanup();
      return resolve({ exitCode: null, stdout: '', stderr: `could not hand over the secret: ${e.message}` });
    }
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    const child = spawn(shell, ['-c', command], { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const take = (prev, chunk) => (prev.length < MAX_OUTPUT ? prev + chunk : prev);
    child.stdout.setEncoding('utf8').on('data', (c) => { stdout = take(stdout, c); });
    child.stderr.setEncoding('utf8').on('data', (c) => { stderr = take(stderr, c); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const finish = (exitCode, extra = '') => {
      clearTimeout(timer);
      cleanup();
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolve({ exitCode, stdout: redact(stdout.slice(0, MAX_OUTPUT), secret), stderr: redact((stderr + extra).slice(0, MAX_OUTPUT), secret) });
    };
    child.on('error', (e) => finish(null, `\n${e.message}`));
    child.on('close', (code, signal) => finish(code, signal ? `\nkilled by ${signal}` : ''));
    child.stdin.on('error', () => {}); // the command may exit without reading stdin
    child.stdin.end(via === 'stdin' ? secret : undefined);
  });
}
