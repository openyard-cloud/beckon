import { newKeyPair, decrypt, signedChallenge, verifyAssertion, verifyRegistration, newId as randomId, unb64url } from './passkeys.mjs';
import { spawn } from 'node:child_process';

// Secret handoff. When Claude reaches a password or one-time-code field, it asks beckon instead
// of typing anything itself. beckon publishes a one-time page on its relay (relay/worker.mjs, on
// Cloudflare) and DMs the link. On the phone, the page encrypts the value to a key pair made here
// for this request (the public half rides in the link's #fragment, which never reaches a server)
// and signs the ciphertext with the person's passkey. Here, beckon checks the passkey, decrypts,
// checks that the field Claude left focused is still the one described (app, kind of field, site)
// and types the value with Peekaboo. The relay, Slack, Claude, the logs and the process list never
// see it: it is held as bytes, passed on stdin and overwritten once typed.
//
// A request can instead be "for a command" (beckon-secret --run): the value is for one command
// Claude runs, like `gh secret set` or an upload that needs a key file. Then the key pair is made
// by that beckon-secret process, not here. beckon only checks the passkey and hands the sealed
// value back to the process that asked, which decrypts it, gives it to the command once and
// wipes it. Nobody else can open it: not the relay, not this daemon, not a second visit to the link.

export const SECRET_KINDS = ['password', 'otp', 'text', 'multiline'];
export const RUN_VIA = ['stdin', 'env', 'file'];
const MAX_SECRET_BYTES = 1024;
export const MAX_RUN_SECRET_BYTES = 8192;
const BROWSERS = new Set([
  'com.google.Chrome', 'com.google.Chrome.canary', 'com.apple.Safari', 'com.apple.SafariTechnologyPreview',
  'company.thebrowser.Browser', 'com.brave.Browser', 'com.microsoft.edgemac', 'org.mozilla.firefox',
  'com.operasoftware.Opera', 'com.vivaldi.Vivaldi',
]);

export class NoPasskeyError extends Error {}

export function hostMatches(url, domains) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return domains.some((d) => {
    const domain = d.toLowerCase().replace(/^\*?\./, '');
    return host === domain || host.endsWith(`.${domain}`);
  });
}

// Is the focused element the place this secret was asked for? Returns a reason when not.
export function checkTarget(focus, request) {
  if (!focus || focus.error) return focus?.error ?? 'could not read the focused field';
  const app = request.app.toLowerCase();
  if (focus.app.toLowerCase() !== app && focus.bundleId.toLowerCase() !== app) {
    return `the focus is in ${focus.app}, not ${request.app}`;
  }
  const secure = focus.subrole === 'AXSecureTextField' || focus.role === 'AXSecureTextField';
  const textual = secure || ['AXTextField', 'AXComboBox', 'AXSearchField'].includes(focus.role);
  if (!textual) return `the focused element is a ${focus.role || 'non-text element'}, not a text field`;
  if (request.kind === 'password' && !secure) return 'the focused field is not a password field';
  if (request.domains.length) {
    if (!focus.url) return `could not read which site the field is on (expected ${request.domains.join(', ')})`;
    if (!hostMatches(focus.url, request.domains)) {
      return `the field is on ${safeHost(focus.url)}, not ${request.domains.join(', ')}`;
    }
  } else if (BROWSERS.has(focus.bundleId)) {
    return 'a secret for a web page needs the site\'s domain';
  }
  return null;
}

function safeHost(url) {
  try {
    return new URL(url).host || url.slice(0, 60);
  } catch {
    return url.slice(0, 60);
  }
}

export function validateRequest(input) {
  const label = typeof input?.label === 'string' ? input.label.trim() : '';
  const kind = input?.kind ?? 'password';
  const note = typeof input?.note === 'string' ? input.note.slice(0, 200) : '';
  const errors = [];
  if (!label || label.length > 80) errors.push('label: a short name for the secret, like "Apple ID password"');
  if (!SECRET_KINDS.includes(kind)) errors.push(`kind: one of ${SECRET_KINDS.join(', ')}`);
  if (input?.run !== undefined) {
    const run = validateRun(input.run, input.publicKey, errors);
    return { request: { label, kind, note, run, publicKey: input.publicKey, app: '', domains: [] }, errors };
  }
  const app = typeof input?.app === 'string' ? input.app.trim() : '';
  const domains = (Array.isArray(input?.domains) ? input.domains : input?.domain ? [input.domain] : [])
    .map((d) => String(d).trim().toLowerCase())
    .filter(Boolean);
  if (kind === 'multiline') errors.push('kind: multiline is only for a command (--run), not for typing into a field');
  if (!app) errors.push('app: the app whose focused field gets the secret, like "Google Chrome"');
  for (const d of domains) if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) errors.push(`domain: "${d}" is not a domain`);
  return { request: { label, kind, app, domains, note }, errors };
}

function validateRun(input, publicKey, errors) {
  const command = typeof input?.command === 'string' ? input.command.trim() : '';
  const via = input?.via ?? 'stdin';
  const name = input?.name ?? null;
  if (!command || command.length > 500 || command.includes('\0')) errors.push('run: the command that gets the secret, up to 500 characters');
  if (!RUN_VIA.includes(via)) errors.push(`via: one of ${RUN_VIA.join(', ')}`);
  if (via === 'env' && !/^[A-Z_][A-Z0-9_]{0,63}$/.test(name ?? '')) errors.push('env: an environment variable name like STRIPE_KEY');
  const key = typeof publicKey === 'string' ? unb64url(publicKey) : Buffer.alloc(0);
  if (key.length !== 65 || key[0] !== 4) errors.push('publicKey: the P-256 public key of the beckon-secret process');
  return { command, via, name: via === 'env' ? name : null };
}

export class SecretBroker {
  constructor({ relayUrl, relay, passkeys, ttlMs = 5 * 60_000, readFocus, typeSecret, log = () => {}, now = () => Date.now(), newId = randomId }) {
    const url = new URL(relayUrl);
    if (url.protocol !== 'https:') throw new Error('secretRelay.url must be https');
    this.origin = url.origin;
    this.rpId = url.hostname;
    Object.assign(this, { relay, passkeys, ttlMs, readFocus, typeSecret, log, now, newId });
    this.pending = new Map();
    relay.handlers.submit = (id, body) => this.onSubmit(id, body);
    relay.handlers.enrolled = (id, body) => this.onEnrolled(id, body);
  }

  open(kind, extra, meta) {
    const id = this.newId();
    let settle;
    const done = new Promise((r) => { settle = r; });
    const expiresAt = this.now() + this.ttlMs;
    const entry = { id, kind, expiresAt, settle, ...extra };
    entry.timer = setTimeout(() => this.finish(id, { status: 'expired', reason: 'nobody answered in time' }), this.ttlMs);
    entry.timer.unref?.();
    this.pending.set(id, entry);
    this.relay.open(id, kind, { ...meta, mode: kind, id }, expiresAt);
    return { entry, done };
  }

  // A secret request. `done` settles with { status: filled | refused | cancelled | expired | failed, reason }.
  // For a command (request.run), `done` settles with { status: delivered, sealed } instead: the
  // ciphertext for the beckon-secret process that holds the private key.
  create(request) {
    const credentials = this.passkeys.list().map((k) => k.id);
    if (!credentials.length) throw new NoPasskeyError('no passkey is registered with this beckon yet');
    const keys = request.run ? { ecdh: null, publicKey: request.publicKey } : newKeyPair();
    const challenge = this.newId();
    const { entry, done } = this.open('secret', { request, ecdh: keys.ecdh, challenge }, {
      label: request.label, app: request.app, domains: request.domains, inputKind: request.kind, note: request.note, challenge, credentials,
      ...(request.run ? { run: request.run } : {}),
    });
    return { id: entry.id, url: `${this.origin}/s/${entry.id}#k=${keys.publicKey}`, expiresAt: entry.expiresAt, done };
  }

  // A passkey enrollment for one person. `done` settles with { status: enrolled | ... }.
  createEnrollment(userName) {
    const challenge = this.newId();
    const userId = this.newId();
    const { entry, done } = this.open('enroll', { challenge, userName }, {
      challenge, userId, userName, credentials: this.passkeys.list().map((k) => k.id),
    });
    return { id: entry.id, url: `${this.origin}/e/${entry.id}`, expiresAt: entry.expiresAt, done };
  }

  cancel(id, reason = 'cancelled in Slack') {
    return this.finish(id, { status: 'cancelled', reason });
  }

  cancelAll(reason) {
    for (const id of [...this.pending.keys()]) this.finish(id, { status: 'cancelled', reason });
  }

  take(id, kind) {
    const entry = this.pending.get(id);
    if (!entry || entry.kind !== kind) return null;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    this.relay.close(id);
    if (this.now() > entry.expiresAt) {
      entry.settle({ status: 'expired', reason: 'the link expired' });
      return null;
    }
    return entry;
  }

  finish(id, result) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.ecdh = null;
    this.relay.close(id);
    entry.settle(result);
    return true;
  }

  async onSubmit(id, body) {
    const entry = this.take(id, 'secret');
    if (!entry) return { status: 'expired', reason: 'this request is no longer open' };
    if (body.cancel === true) {
      entry.settle({ status: 'cancelled', reason: 'cancelled on the form' });
      return { status: 'cancelled' };
    }
    let plain = null;
    let result;
    try {
      verifyAssertion(body.passkey, {
        stored: this.passkeys.list(),
        challenge: signedChallenge(entry.challenge, body),
        origin: this.origin,
        rpId: this.rpId,
      });
    } catch (e) {
      result = { status: 'refused', reason: e.message };
    }
    if (!result && entry.request.run) return this.deliver(entry, id, body);
    if (!result) {
      try {
        plain = decrypt({ ecdh: entry.ecdh, id, epk: body.epk, iv: body.iv, ct: body.ct });
      } catch {
        result = { status: 'refused', reason: 'the value could not be decrypted' };
      }
    }
    entry.ecdh = null;
    try {
      if (!result && (plain.length === 0 || plain.length > MAX_SECRET_BYTES)) result = { status: 'refused', reason: 'the value is empty or too long' };
      if (!result) {
        const reason = checkTarget(await this.readFocus(entry.request.app), entry.request);
        if (reason) result = { status: 'refused', reason };
      }
      if (!result) result = await this.type(entry.request, plain);
    } catch (e) {
      result = { status: 'failed', reason: e.message };
    } finally {
      plain?.fill(0);
    }
    this.log(`Secret "${entry.request.label}": ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
    entry.settle(result);
    return result;
  }

  // A one-time code is typed one character at a time, with the field checked again before each:
  // many sign-in pages split the code into one box per digit and move the focus as each is
  // typed, which Peekaboo, pinned to the box focused when it started, refuses to follow.
  async type(request, plain) {
    if (request.kind !== 'otp') {
      await this.typeSecret({ app: request.app, secret: plain });
      return { status: 'filled' };
    }
    const chars = [...plain.toString('utf8')];
    try {
      for (let i = 0; i < chars.length; i++) {
        if (i > 0) {
          const reason = checkTarget(await this.readFocus(request.app), request);
          if (reason) return { status: 'failed', reason: `stopped after ${i} of ${chars.length} characters: ${reason}` };
        }
        const one = Buffer.from(chars[i], 'utf8');
        try {
          await this.typeSecret({ app: request.app, secret: one });
        } finally {
          one.fill(0);
        }
      }
    } finally {
      chars.fill('');
    }
    return { status: 'filled' };
  }

  // A value for a command: this daemon cannot decrypt it (it has no private key), so it hands the
  // sealed value to the beckon-secret process waiting on `done` and keeps nothing.
  deliver(entry, id, body) {
    const ct = unb64url(body.ct);
    let result;
    if (ct.length <= 16) result = { status: 'refused', reason: 'the value is empty' };
    else if (ct.length > MAX_RUN_SECRET_BYTES + 16) result = { status: 'refused', reason: 'the value is too long' };
    else result = { status: 'delivered' };
    this.log(`Secret "${entry.request.label}": ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
    entry.settle(result.status === 'delivered' ? { ...result, sealed: { id, epk: body.epk, iv: body.iv, ct: body.ct } } : result);
    return result;
  }

  async onEnrolled(id, body) {
    const entry = this.take(id, 'enroll');
    if (!entry) return { status: 'expired', reason: 'this enrollment is no longer open' };
    let result;
    try {
      const passkey = verifyRegistration(body, { challenge: entry.challenge, origin: this.origin });
      this.passkeys.add({ ...passkey, name: entry.userName, createdAt: new Date(this.now()).toISOString() });
      result = { status: 'enrolled' };
    } catch (e) {
      result = { status: 'refused', reason: e.message };
    }
    this.log(`Passkey enrollment for ${entry.userName}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
    entry.settle(result);
    return result;
  }
}

// The real focus reader and typist: the beckon-ax helper and Peekaboo's type --secret-stdin.
export function runJson(bin, args, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ error: e.message }); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ error: 'could not read the focused field' });
      }
    });
  });
}

export function peekabooTypist(peekabooPath) {
  return ({ app, secret }) => new Promise((resolve, reject) => {
    const child = spawn(peekabooPath, ['type', '--secret-stdin', '--app', app, '--accept-dispatched'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Peekaboo could not type it (${err.trim().split('\n').pop()?.slice(0, 200) || `exit ${code}`})`));
    });
    child.stdin.end(secret);
  });
}
