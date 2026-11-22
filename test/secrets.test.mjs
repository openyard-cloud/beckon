import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { hostMatches, checkTarget, validateRequest, SecretBroker, NoPasskeyError } from '../src/secrets.mjs';
import { PasskeyStore, newKeyPair, decrypt } from '../src/passkeys.mjs';
import { makeAuthenticator, registration, submission } from './phone.mjs';
import { tempDir } from './helpers.mjs';

const RELAY = 'https://beckon-relay.example.workers.dev';
const focus = (extra = {}) => ({ app: 'Google Chrome', bundleId: 'com.google.Chrome', role: 'AXTextField', subrole: 'AXSecureTextField', url: 'https://appleid.apple.com/sign-in', ...extra });
const req = (extra = {}) => validateRequest({ label: 'Apple ID password', kind: 'password', app: 'Google Chrome', domains: ['apple.com'], ...extra }).request;

class FakeRelay {
  constructor() {
    this.records = new Map();
    this.closed = [];
    this.handlers = {};
  }
  open(id, kind, meta, expiresAt) { this.records.set(id, { kind, meta, expiresAt }); }
  close(id) { this.closed.push(id); this.records.delete(id); }
}

function setup(options = {}) {
  const relay = new FakeRelay();
  const passkeys = new PasskeyStore(join(tempDir(), 'passkeys.json'));
  const typed = [];
  const logs = [];
  const broker = new SecretBroker({
    relayUrl: RELAY,
    relay,
    passkeys,
    readFocus: async () => focus(),
    typeSecret: async ({ secret }) => { typed.push(Buffer.from(secret).toString()); },
    log: (m) => logs.push(m),
    ...options,
  });
  return { relay, passkeys, broker, typed, logs };
}

async function enroll(broker, relay) {
  const auth = makeAuthenticator();
  const e = broker.createEnrollment('Thi (beckon)');
  const meta = relay.records.get(e.id).meta;
  assert.equal(meta.mode, 'enroll');
  const result = await relay.handlers.enrolled(e.id, registration(auth, { challenge: meta.challenge, origin: RELAY }));
  assert.deepEqual(result, { status: 'enrolled' });
  assert.equal((await e.done).status, 'enrolled');
  return auth;
}

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

test('no secret request before a passkey is registered', () => {
  const { broker } = setup();
  assert.throws(() => broker.create(req()), NoPasskeyError);
});

test('an encrypted, passkey-signed value is typed once and never logged', async () => {
  const { broker, relay, typed, logs } = setup();
  const auth = await enroll(broker, relay);
  const h = broker.create(req());
  assert.match(h.url, /^https:\/\/beckon-relay\.example\.workers\.dev\/s\/[A-Za-z0-9_-]{43}#k=/);
  const meta = relay.records.get(h.id).meta;
  assert.deepEqual(meta.credentials, [auth.id]);
  assert.ok(!JSON.stringify(meta).includes(new URL(h.url).hash.slice(3)), 'the relay never gets the key');

  const body = await submission({ url: h.url, meta, secret: 'hunter2! đ', authenticator: auth });
  assert.ok(!JSON.stringify(body).includes('hunter2'), 'the relay only sees ciphertext');
  assert.deepEqual(await relay.handlers.submit(h.id, body), { status: 'filled' });
  assert.deepEqual(await h.done, { status: 'filled' });
  assert.deepEqual(typed, ['hunter2! đ']);
  assert.ok(!logs.join('\n').includes('hunter2'));
  assert.ok(relay.closed.includes(h.id));
  assert.equal((await relay.handlers.submit(h.id, body)).status, 'expired', 'one use only');
});

test('wrong passkeys, tampering, replays elsewhere and a moved focus type nothing', async () => {
  const { broker, relay, typed } = setup();
  const auth = await enroll(broker, relay);
  const cases = [
    ['an unknown passkey', async (h, meta) => submission({ url: h.url, meta, secret: 'x', authenticator: makeAuthenticator() }), /not registered/],
    ['no user verification', async (h, meta) => submission({ url: h.url, meta, secret: 'x', authenticator: auth, flags: 0x01 }), /did not verify the person/],
    ['another origin', async (h, meta) => submission({ url: h.url, meta, secret: 'x', authenticator: auth, origin: 'https://evil.example' }), /used on https:\/\/evil\.example/],
    ['another rp', async (h, meta) => submission({ url: h.url, meta, secret: 'x', authenticator: auth, rpId: 'evil.example' }), /belongs to another site/],
    ['a swapped ciphertext', async (h, meta) => {
      const good = await submission({ url: h.url, meta, secret: 'x', authenticator: auth });
      const other = await submission({ url: h.url, meta, secret: 'attacker value', authenticator: makeAuthenticator() });
      return { ...good, ct: other.ct, iv: other.iv, epk: other.epk };
    }, /signed something else/],
  ];
  for (const [name, build, reason] of cases) {
    const h = broker.create(req());
    const result = await relay.handlers.submit(h.id, await build(h, relay.records.get(h.id).meta));
    assert.equal(result.status, 'refused', name);
    assert.match(result.reason, reason, name);
  }
  assert.equal(typed.length, 0);

  const moved = setup({ readFocus: async () => focus({ url: 'https://phish.example/apple' }) });
  const auth2 = await enroll(moved.broker, moved.relay);
  const h = moved.broker.create(req());
  const r = await moved.relay.handlers.submit(h.id, await submission({ url: h.url, meta: moved.relay.records.get(h.id).meta, secret: 'x', authenticator: auth2 }));
  assert.match(r.reason, /on phish\.example/);
  assert.equal(moved.typed.length, 0);
});

test('a one-time code is typed one character at a time, checking the field before each', async () => {
  let checks = 0;
  const { broker, relay, typed } = setup({ readFocus: async () => { checks += 1; return focus({ subrole: '' }); } });
  const auth = await enroll(broker, relay);
  const h = broker.create(req({ label: 'PIN', kind: 'otp' }));
  const r = await relay.handlers.submit(h.id, await submission({ url: h.url, meta: relay.records.get(h.id).meta, secret: '482913', authenticator: auth }));
  assert.equal(r.status, 'filled');
  assert.deepEqual(typed, ['4', '8', '2', '9', '1', '3']);
  assert.equal(checks, 6);

  let n = 0;
  const away = setup({ readFocus: async () => (++n > 3 ? focus({ subrole: '', app: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' }) : focus({ subrole: '' })) });
  const auth2 = await enroll(away.broker, away.relay);
  const h2 = away.broker.create(req({ label: 'PIN', kind: 'otp' }));
  const r2 = await away.relay.handlers.submit(h2.id, await submission({ url: h2.url, meta: away.relay.records.get(h2.id).meta, secret: '482913', authenticator: auth2 }));
  assert.equal(r2.status, 'failed');
  assert.match(r2.reason, /stopped after 3 of 6 characters: the focus is in Slack/);
  assert.deepEqual(away.typed, ['4', '8', '2']);
});

test('cancel and expiry settle requests; enrollment checks its challenge', async () => {
  const { broker, relay } = setup({ ttlMs: 40 });
  await enroll(broker, relay);
  const c = broker.create(req());
  assert.equal((await relay.handlers.submit(c.id, { cancel: true })).status, 'cancelled');
  assert.equal((await c.done).status, 'cancelled');
  const s = broker.create(req());
  assert.ok(broker.cancel(s.id));
  assert.equal((await s.done).status, 'cancelled');
  // The expiry timer is unref'd (the daemon has other handles); hold the loop open meanwhile.
  const hold = setTimeout(() => {}, 5000);
  assert.equal((await broker.create(req()).done).status, 'expired');
  clearTimeout(hold);

  const e = broker.createEnrollment('x');
  const bad = await relay.handlers.enrolled(e.id, registration(makeAuthenticator(), { challenge: 'not-the-challenge', origin: RELAY }));
  assert.equal(bad.status, 'refused');
});

test('only https relays are accepted', () => {
  assert.throws(() => new SecretBroker({ relayUrl: 'http://relay.local', relay: new FakeRelay() }), /https/);
});

const runReq = (extra = {}) => {
  const keys = newKeyPair();
  const { request, errors } = validateRequest({ label: 'Stripe key', kind: 'password', run: { command: 'gh secret set STRIPE_KEY' }, publicKey: keys.publicKey, ...extra });
  return { keys, request, errors };
};

test('a request for a command needs a command and the asking process\'s public key', () => {
  assert.deepEqual(runReq().errors, []);
  assert.deepEqual(runReq().request.run, { command: 'gh secret set STRIPE_KEY', via: 'stdin', name: null });
  assert.match(runReq({ run: { command: '' } }).errors.join(), /run:/);
  assert.match(runReq({ run: { command: 'x', via: 'clipboard' } }).errors.join(), /via:/);
  assert.match(runReq({ run: { command: 'x', via: 'env', name: 'lower case' } }).errors.join(), /env:/);
  assert.match(runReq({ publicKey: 'AAAA' }).errors.join(), /publicKey/);
  assert.deepEqual(runReq({ kind: 'multiline', run: { command: 'x', via: 'file' } }).errors, []);
  assert.match(validateRequest({ label: 'x', kind: 'multiline', app: 'Google Chrome' }).errors.join(), /multiline is only for a command/);
});

test('a value for a command is passed on sealed: only the asking process can open it, once', async () => {
  const { broker, relay, typed, logs } = setup({ readFocus: async () => { throw new Error('no focus check for a command'); } });
  const auth = await enroll(broker, relay);
  const { keys, request } = runReq({ kind: 'multiline', run: { command: 'upload --key "$BECKON_SECRET_FILE"', via: 'file' } });
  const h = broker.create(request);
  assert.ok(h.url.endsWith(`#k=${keys.publicKey}`), 'the link carries the asking process\'s key');
  const meta = relay.records.get(h.id).meta;
  assert.deepEqual(meta.run, { command: 'upload --key "$BECKON_SECRET_FILE"', via: 'file', name: null });

  const secret = '{\n  "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIE"\n}';
  const body = await submission({ url: h.url, meta, secret, authenticator: auth });
  assert.deepEqual(await relay.handlers.submit(h.id, body), { status: 'delivered' }, 'the relay learns only that it was delivered');
  const result = await h.done;
  assert.equal(result.status, 'delivered');
  assert.deepEqual(result.sealed, { id: h.id, epk: body.epk, iv: body.iv, ct: body.ct });
  assert.equal(decrypt({ ecdh: keys.ecdh, ...result.sealed }).toString(), secret);
  assert.deepEqual(typed, [], 'nothing is typed');
  assert.ok(!logs.join('\n').includes('private_key'));
  assert.equal((await relay.handlers.submit(h.id, body)).status, 'expired', 'one use only');
});

test('a value for a command still needs the passkey', async () => {
  const { broker, relay } = setup();
  await enroll(broker, relay);
  const { request } = runReq();
  const h = broker.create(request);
  const body = await submission({ url: h.url, meta: relay.records.get(h.id).meta, secret: 'sk_live_x', authenticator: makeAuthenticator() });
  assert.equal((await relay.handlers.submit(h.id, body)).status, 'refused');
  const result = await h.done;
  assert.equal(result.status, 'refused');
  assert.equal(result.sealed, undefined);
});
