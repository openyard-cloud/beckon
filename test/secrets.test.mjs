import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { formField, hostMatches, checkTarget, validateRequest, SecretBroker, startSecretServer } from '../src/secrets.mjs';

const HOST = 'mac.tail1234.ts.net';

function http(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host: HOST, ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const focus = (extra = {}) => ({ app: 'Google Chrome', bundleId: 'com.google.Chrome', role: 'AXTextField', subrole: 'AXSecureTextField', url: 'https://appleid.apple.com/sign-in', ...extra });
const req = (extra = {}) => validateRequest({ label: 'Apple ID password', kind: 'password', app: 'Google Chrome', domains: ['apple.com'], ...extra }).request;

test('form fields decode to bytes', () => {
  const body = Buffer.from('action=submit&secret=p%40ss+w%C3%B6rd%26%3D');
  assert.equal(formField(body, 'secret').toString('utf8'), 'p@ss wörd&=');
  assert.equal(formField(body, 'action').toString(), 'submit');
  assert.equal(formField(body, 'missing'), null);
  assert.equal(formField(Buffer.from('secret=%4'), 'secret').toString(), '%4');
});

test('domains match whole labels over https only', () => {
  assert.ok(hostMatches('https://appleid.apple.com/x', ['apple.com']));
  assert.ok(hostMatches('https://apple.com', ['apple.com']));
  assert.ok(!hostMatches('https://evilapple.com', ['apple.com']));
  assert.ok(!hostMatches('https://apple.com.evil.io', ['apple.com']));
  assert.ok(!hostMatches('http://appleid.apple.com', ['apple.com']));
  assert.ok(!hostMatches('not a url', ['apple.com']));
});

test('the focused field must be the one described', () => {
  assert.equal(checkTarget(focus(), req()), null);
  assert.match(checkTarget(focus({ app: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' }), req()), /focus is in Slack/);
  assert.match(checkTarget(focus({ subrole: '' }), req()), /not a password field/);
  assert.match(checkTarget(focus({ role: 'AXButton', subrole: '' }), req()), /not a text field/);
  assert.match(checkTarget(focus({ url: 'https://apple.com.phish.io/login' }), req()), /on apple\.com\.phish\.io/);
  assert.match(checkTarget(focus({ url: undefined }), req()), /could not read which site/);
  assert.match(checkTarget(focus(), req({ domains: [] })), /needs the site's domain/);
  assert.equal(checkTarget(focus({ subrole: '' }), req({ kind: 'otp' })), null);
  assert.equal(checkTarget({ app: 'Xcode', bundleId: 'com.apple.dt.Xcode', role: 'AXTextField', subrole: 'AXSecureTextField' }, req({ app: 'Xcode', domains: [] })), null);
  assert.match(checkTarget({ error: 'nothing has focus in Xcode' }, req()), /nothing has focus/);
});

test('requests are validated', () => {
  assert.deepEqual(validateRequest({ label: 'x', kind: 'password', app: 'Xcode' }).errors, []);
  assert.equal(validateRequest({ label: '', kind: 'pin', app: '', domain: 'not a domain' }).errors.length, 4);
});

async function broker(options = {}) {
  const typed = [];
  const logs = [];
  const b = new SecretBroker({
    publicUrl: `https://${HOST}`,
    readFocus: async () => focus(),
    typeSecret: async ({ secret }) => { typed.push(Buffer.from(secret)); },
    log: (m) => logs.push(m),
    ...options,
  });
  const server = await startSecretServer(b, { port: 0 });
  return { b, server, typed, logs };
}

test('the form fills the field once and keeps the secret out of logs', async () => {
  const { b, server, typed, logs } = await broker();
  const h = b.create(req());
  const path = new URL(h.url).pathname;
  assert.equal(h.url.startsWith(`https://${HOST}/s/`), true);

  const wrongHost = await http(server.port, path, { headers: { host: 'evil.example' } });
  assert.equal(wrongHost.status, 421);

  const form = await http(server.port, path);
  assert.equal(form.status, 200);
  assert.match(form.text, /Apple ID password/);
  assert.match(form.text, /type="password"/);
  assert.match(form.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(form.headers['cache-control'], 'no-store');
  assert.ok(!/<script/i.test(form.text), 'the form has no scripts');

  const foreign = await http(server.port, path, { method: 'POST', body: 'secret=x', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(foreign.status, 403);

  const sent = await http(server.port, path, { method: 'POST', body: 'action=submit&secret=hunter2%21', headers: { origin: `https://${HOST}`, 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(sent.status, 200);
  assert.match(sent.text, /Filled in/);
  assert.deepEqual(await h.done, { status: 'filled' });
  assert.equal(typed[0].toString(), 'hunter2!');
  assert.ok(!logs.join('\n').includes('hunter2'), 'never logged');

  const again = await http(server.port, path);
  assert.equal(again.status, 410, 'one use only');
  await server.close();
});

test('a moved focus refuses and types nothing; cancel and expiry settle the request', async () => {
  const { b, server, typed } = await broker({ readFocus: async () => focus({ url: 'https://phish.example/apple' }) });
  const h = b.create(req());
  const path = new URL(h.url).pathname;
  const sent = await http(server.port, path, { method: 'POST', body: 'secret=hunter2', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.match(sent.text, /Nothing was typed/);
  assert.equal((await h.done).status, 'refused');
  assert.equal(typed.length, 0);

  const c = b.create(req());
  await http(server.port, new URL(c.url).pathname, { method: 'POST', body: 'action=cancel' });
  assert.equal((await c.done).status, 'cancelled');

  const s = b.create(req());
  assert.ok(b.cancel(s.id));
  assert.equal((await s.done).status, 'cancelled');
  await server.close();

  const short = new SecretBroker({ publicUrl: `https://${HOST}`, ttlMs: 30, readFocus: async () => focus(), typeSecret: async () => {} });
  assert.equal((await short.create(req()).done).status, 'expired');
});

test('only https public addresses are accepted', () => {
  assert.throws(() => new SecretBroker({ publicUrl: 'http://mac.local' }), /https/);
});
