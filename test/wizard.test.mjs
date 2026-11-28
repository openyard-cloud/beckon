import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers.mjs';
import { guidedInit, helloFrom, manifestUrl, setEnvValues, projectName } from '../src/wizard.mjs';
import { validateConfig } from '../src/config.mjs';
import { CONFIG_TEMPLATE } from '../src/setup.mjs';

const WAIT = Symbol('wait for Slack');

// Answers questions from a script. WAIT leaves the question open until it is cancelled, the
// way the terminal waits for Enter while beckon listens for the hello.
function scriptedIO(answers) {
  const said = [];
  const asked = [];
  const next = (q) => {
    asked.push(q);
    if (!answers.length) throw new Error(`No answer left for: ${q}`);
    return answers.shift();
  };
  return {
    said,
    asked,
    say: (t = '') => said.push(t),
    async ask(q, { def = '', signal } = {}) {
      const a = next(q);
      if (a === WAIT) {
        return new Promise((_, fail) => signal?.addEventListener('abort', () => fail(new Error('aborted'))));
      }
      return a || def;
    },
    secret: async (q) => next(q),
    confirm: async (q) => {
      const a = next(q);
      return a === '' ? true : a;
    },
    close() {},
  };
}

function fakeSlack({ hello }) {
  const calls = [];
  const slack = (token) => ({
    async call(method, body = {}) {
      calls.push({ token, method, body });
      if (method === 'auth.test') {
        if (token !== 'xoxb-good') throw Object.assign(new Error('invalid_auth'), { code: 'invalid_auth' });
        return { ok: true, user: 'beckon', user_id: 'UBOT', team: 'Acme' };
      }
      if (method === 'apps.connections.open') {
        if (token !== 'xapp-good') throw Object.assign(new Error('invalid_auth'), { code: 'invalid_auth' });
        return { ok: true, url: 'wss://example' };
      }
      if (method === 'conversations.info') return { ok: true, channel: { id: body.channel, name: 'shop' } };
      return { ok: true };
    },
  });
  const socketFor = () => {
    const s = new EventEmitter();
    s.start = async () => setImmediate(() => {
      s.emit('event', { type: 'message', user: 'UBOT', bot_id: 'B1', channel: 'C9', ts: '1.0' });
      s.emit('event', hello);
    });
    s.stop = () => { s.stopped = true; };
    return s;
  };
  return { calls, slack, socketFor };
}

function setup() {
  const dir = tempDir('beckon-wizard-');
  const repo = join(dir, 'My Shop');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const claude = join(dir, 'claude');
  writeFileSync(claude, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.0.0 (Claude Code)"; else echo '{"loggedIn":true,"email":"me@example.com"}'; fi\n`);
  chmodSync(claude, 0o755);
  const home = join(dir, 'home');
  return { dir, repo, claude, home, env: { BECKON_HOME: home, PATH: process.env.PATH } };
}

test('guided setup: checks the tokens, learns the member and channel from a hello, and writes a valid config', async () => {
  const { repo, claude, home, env } = setup();
  const { calls, slack, socketFor } = fakeSlack({ hello: { type: 'app_mention', user: 'UME123', channel: 'CSHOP', ts: '2.0', text: '<@UBOT> hello' } });
  const io = scriptedIO([
    false,          // open the browser? no
    'xapp-wrong',   // pasted the wrong token first
    'xoxb-bad',     // a bot token Slack rejects
    'xoxb-good',
    'xapp-good',
    '',             // the repository: the default (cwd)
    '',             // the project name: the default
    WAIT,           // listening for the hello
    true,           // is that you? yes
    false,          // run in the background? no
  ]);
  let installed = false;
  const ok = await guidedInit({ io, env, cwd: repo, slack, socketFor, claudeBin: claude, runDoctor: async () => [[true, 'fine']], install: () => { installed = true; }, open: async () => true });
  assert.equal(ok, true, io.said.join('\n'));
  assert.equal(installed, false);

  const said = io.said.join('\n');
  assert.match(said, /logged in as me@example.com/);
  assert.match(said, /does not start with xoxb-/);
  assert.match(said, /Slack did not accept it: invalid_auth/);
  assert.match(said, /manifest_json=/);
  assert.ok(!said.includes('xoxb-good') && !said.includes('xapp-good'), 'tokens are never printed');
  assert.ok(io.asked.some((q) => /member UME123 in #shop/.test(q)));

  const envFile = join(home, 'env');
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  const envText = readFileSync(envFile, 'utf8');
  assert.match(envText, /^SLACK_BOT_TOKEN=xoxb-good$/m);
  assert.match(envText, /^SLACK_APP_TOKEN=xapp-good$/m);

  const raw = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  assert.deepEqual(raw.users, ['UME123']);
  assert.deepEqual(raw.projects['my-shop'].channels, ['CSHOP']);
  assert.equal(raw.defaultProject, 'my-shop');
  assert.deepEqual(validateConfig(raw).errors, []);

  const reply = calls.find((c) => c.method === 'chat.postMessage');
  assert.equal(reply.body.channel, 'CSHOP');
  assert.equal(reply.body.thread_ts, '2.0');
});

test('guided setup replaces the template from "init --files" and keeps saved tokens', async () => {
  const { repo, claude, home, env } = setup();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify(CONFIG_TEMPLATE));
  writeFileSync(join(home, 'env'), '# mine\nSLACK_BOT_TOKEN=xoxb-good\nSLACK_APP_TOKEN=xapp-good\nOTHER=1\n', { mode: 0o600 });
  const { slack, socketFor } = fakeSlack({ hello: { type: 'message', channel_type: 'im', user: 'UME123', channel: 'DME', ts: '3.0' } });
  const io = scriptedIO(['', repo, 'shop', WAIT, true, true]);
  let installed = false;
  const ok = await guidedInit({ io, env, cwd: '/', slack, socketFor, claudeBin: claude, runDoctor: async () => [[true, 'fine']], install: () => { installed = true; } });
  assert.equal(ok, true, io.said.join('\n'));
  assert.equal(installed, true);
  assert.match(io.said.join('\n'), /already set up: @beckon in Acme/);
  const raw = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  assert.deepEqual(raw.users, ['UME123']);
  assert.deepEqual(Object.keys(raw.projects), ['shop']);
  assert.deepEqual(raw.projects.shop.channels, []);
  assert.equal(raw.schedules, undefined);
  assert.deepEqual(validateConfig(raw).errors, []);
  assert.match(readFileSync(join(home, 'env'), 'utf8'), /^# mine$[\s\S]*^OTHER=1$/m);
});

test('pressing Enter instead of saying hello asks for the member ID and channel', async () => {
  const { repo, claude, home, env } = setup();
  const { slack } = fakeSlack({});
  const socketFor = () => Object.assign(new EventEmitter(), { start: async () => {}, stop() {} });
  const io = scriptedIO([false, 'xoxb-good', 'xapp-good', '', '', '', 'nope', 'ume123', 'shop', false]);
  const ok = await guidedInit({ io, env, cwd: repo, slack, socketFor, claudeBin: claude, runDoctor: async () => [[true, 'fine']] });
  assert.equal(ok, true, io.said.join('\n'));
  assert.match(io.said.join('\n'), /start with U or W/);
  const raw = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  assert.deepEqual(raw.users, ['UME123']);
  assert.deepEqual(raw.projects['my-shop'].channels, ['#shop']);
});

test('a hello is a mention or a direct message from a person', () => {
  assert.deepEqual(helloFrom({ type: 'app_mention', user: 'U1', channel: 'C1', ts: '1' }, 'UBOT'), { user: 'U1', channel: 'C1', ts: '1', im: false });
  assert.equal(helloFrom({ type: 'message', channel_type: 'im', user: 'U1', channel: 'D1', ts: '1' }, 'UBOT').im, true);
  assert.equal(helloFrom({ type: 'message', channel_type: 'channel', user: 'U1', channel: 'C1', ts: '1' }, 'UBOT'), null);
  assert.equal(helloFrom({ type: 'message', channel_type: 'im', user: 'UBOT', channel: 'D1', ts: '1' }, 'UBOT'), null);
  assert.equal(helloFrom({ type: 'message', channel_type: 'im', subtype: 'message_changed', user: 'U1' }, 'UBOT'), null);
});

test('helpers: manifest link, env file edits, project names', () => {
  const url = new URL(manifestUrl());
  assert.equal(JSON.parse(url.searchParams.get('manifest_json')).settings.socket_mode_enabled, true);
  const file = join(tempDir(), 'env');
  writeFileSync(file, 'A=1\nexport SLACK_BOT_TOKEN=old\n');
  setEnvValues(file, { SLACK_BOT_TOKEN: 'new', SLACK_APP_TOKEN: 'x' });
  assert.equal(readFileSync(file, 'utf8'), 'A=1\nSLACK_BOT_TOKEN=new\nSLACK_APP_TOKEN=x\n');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(projectName('/x/My Shop'), 'my-shop');
  assert.equal(projectName('/x/__'), 'app');
});
