import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

// Secret handoff. When Claude reaches a password or one-time-code field, it asks beckon instead
// of typing anything itself. beckon posts a link in Slack to a one-time form, served from this
// machine and reached over a private network (Tailscale Serve), never the public internet. The
// person types the secret on their phone; beckon checks that the field Claude left focused is
// still the one the form described (app, kind of field, site) and types the secret into it with
// Peekaboo. The secret never reaches Claude, Slack, the logs or the clipboard: it is held as bytes,
// passed to Peekaboo on stdin, and overwritten as soon as it is typed.

export const SECRET_KINDS = ['password', 'otp', 'text'];
const MAX_SECRET_BYTES = 1024;
const MAX_BODY_BYTES = 4096;
const BROWSERS = new Set([
  'com.google.Chrome', 'com.google.Chrome.canary', 'com.apple.Safari', 'com.apple.SafariTechnologyPreview',
  'company.thebrowser.Browser', 'com.brave.Browser', 'com.microsoft.edgemac', 'org.mozilla.firefox',
  'com.operasoftware.Opera', 'com.vivaldi.Vivaldi',
]);

// Decodes one field of an application/x-www-form-urlencoded body into bytes, so the secret is
// never turned into a JavaScript string (which cannot be wiped).
export function formField(body, name) {
  const want = Buffer.from(`${name}=`);
  let start = 0;
  while (start <= body.length) {
    let end = body.indexOf(0x26, start); // &
    if (end === -1) end = body.length;
    if (body.subarray(start, start + want.length).equals(want)) {
      const raw = body.subarray(start + want.length, end);
      const out = Buffer.alloc(raw.length);
      let n = 0;
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === 0x2b) {
          out[n++] = 0x20; // + is a space
        } else if (c === 0x25 && i + 2 < raw.length && isHex(raw[i + 1]) && isHex(raw[i + 2])) {
          out[n++] = hexValue(raw[i + 1]) * 16 + hexValue(raw[i + 2]); // no strings made from the secret
          i += 2;
        } else {
          out[n++] = c;
        }
      }
      const value = Buffer.from(out.subarray(0, n));
      out.fill(0);
      return value;
    }
    start = end + 1;
  }
  return null;
}

function hexValue(c) {
  if (c <= 0x39) return c - 0x30;
  if (c <= 0x46) return c - 0x41 + 10;
  return c - 0x61 + 10;
}

function isHex(c) {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

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
  const app = typeof input?.app === 'string' ? input.app.trim() : '';
  const domains = (Array.isArray(input?.domains) ? input.domains : input?.domain ? [input.domain] : [])
    .map((d) => String(d).trim().toLowerCase())
    .filter(Boolean);
  const errors = [];
  if (!label || label.length > 80) errors.push('label: a short name for the secret, like "Apple ID password"');
  if (!SECRET_KINDS.includes(kind)) errors.push(`kind: one of ${SECRET_KINDS.join(', ')}`);
  if (!app) errors.push('app: the app whose focused field gets the secret, like "Google Chrome"');
  for (const d of domains) if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) errors.push(`domain: "${d}" is not a domain`);
  return { request: { label, kind, app, domains, note: typeof input?.note === 'string' ? input.note.slice(0, 200) : '' }, errors };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6efe0;--fg:#1c2530;--muted:#5b6470;--card:#fff;--accent:#ef9f2c;--line:#e2d8c4}
@media (prefers-color-scheme:dark){:root{--bg:#14191f;--fg:#f1ece2;--muted:#a3abb5;--card:#1c2530;--line:#2c3642}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 -apple-system,system-ui,sans-serif;padding:24px 16px}
main{max-width:420px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px}
h1{font-size:19px;margin:0 0 14px}dl{margin:0 0 18px;display:grid;grid-template-columns:auto 1fr;gap:6px 12px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
input{width:100%;font:inherit;font-size:20px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);margin:4px 0 16px}
.row{display:flex;gap:10px}button{flex:1;font:inherit;font-weight:600;padding:12px;border-radius:10px;border:0;cursor:pointer}
.go{background:var(--accent);color:#1c2530}.stop{background:transparent;color:var(--muted);border:1px solid var(--line)}
p{margin:0 0 10px}.muted{color:var(--muted);font-size:14px}
</style></head><body><main>${body}</main></body></html>`;
}

export function formPage(entry) {
  const r = entry.request;
  const where = r.domains.length ? r.domains.join(', ') : '(not a web page)';
  const field = r.kind === 'password' ? 'password field' : r.kind === 'otp' ? 'one-time code field' : 'text field';
  const autocomplete = r.kind === 'otp' ? 'one-time-code' : r.kind === 'password' ? 'current-password' : 'off';
  const inputmode = r.kind === 'otp' ? ' inputmode="numeric"' : '';
  return page('beckon: enter a secret', `<h1>🔐 ${escapeHtml(r.label)}</h1>
<dl><dt>App</dt><dd>${escapeHtml(r.app)}</dd><dt>Site</dt><dd>${escapeHtml(where)}</dd><dt>Into</dt><dd>the focused ${field}</dd>${r.note ? `<dt>Note</dt><dd>${escapeHtml(r.note)}</dd>` : ''}</dl>
<form method="post" autocomplete="off">
<input type="password" name="secret" autocomplete="${autocomplete}"${inputmode} maxlength="${MAX_SECRET_BYTES}" required autofocus aria-label="${escapeHtml(r.label)}">
<div class="row"><button class="go" name="action" value="submit">Fill it in</button><button class="stop" name="action" value="cancel" formnovalidate>Cancel</button></div>
</form>
<p class="muted" style="margin-top:14px">beckon types this into the field on the Mac after checking it is still the field described above. Claude, Slack and the logs never see it. This link works once.</p>`);
}

export function resultPage(title, text) {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p><p class="muted">You can close this page.</p>`);
}

const SECURITY_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

export class SecretBroker {
  constructor({
    publicUrl,
    ttlMs = 5 * 60_000,
    readFocus,
    typeSecret,
    log = () => {},
    now = () => Date.now(),
    newId = () => randomBytes(32).toString('base64url'),
  }) {
    const url = new URL(publicUrl);
    if (url.protocol !== 'https:') throw new Error('secretForm.publicUrl must be https (Tailscale Serve gives one)');
    this.origin = url.origin;
    this.host = url.host;
    Object.assign(this, { ttlMs, readFocus, typeSecret, log, now, newId });
    this.pending = new Map();
  }

  // Opens a request. `done` settles with { status: filled | refused | cancelled | expired | failed, reason }.
  create(request) {
    const id = this.newId();
    let settle;
    const done = new Promise((r) => { settle = r; });
    const entry = { id, request, expiresAt: this.now() + this.ttlMs, settle, busy: false };
    entry.timer = setTimeout(() => this.finish(id, { status: 'expired', reason: 'nobody filled the form in time' }), this.ttlMs);
    entry.timer.unref?.();
    this.pending.set(id, entry);
    return { id, url: `${this.origin}/s/${id}`, expiresAt: entry.expiresAt, done };
  }

  cancel(id, reason = 'cancelled in Slack') {
    return this.finish(id, { status: 'cancelled', reason });
  }

  cancelAll(reason) {
    for (const id of [...this.pending.keys()]) this.finish(id, { status: 'cancelled', reason });
  }

  finish(id, result) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.settle(result);
    return true;
  }

  // The HTTP handler behind Tailscale Serve. Bound to loopback by start().
  async handle(req, res) {
    const send = (status, html) => {
      res.writeHead(status, SECURITY_HEADERS);
      res.end(html);
    };
    // Requests must arrive for the published name: this rejects DNS rebinding and stray callers.
    if (req.headers.host !== this.host) return send(421, resultPage('Wrong address', 'Open the link from Slack.'));
    const match = /^\/s\/([A-Za-z0-9_-]{20,64})$/.exec(req.url ?? '');
    const entry = match && this.pending.get(match[1]);
    if (!entry || this.now() > entry.expiresAt) {
      if (entry) this.finish(entry.id, { status: 'expired', reason: 'the link expired' });
      return send(410, resultPage('Link no longer valid', 'This link was used, cancelled or has expired. Ask again from Slack if you still need it.'));
    }
    if (req.method === 'GET') return send(200, formPage(entry));
    if (req.method !== 'POST') return send(405, resultPage('Not allowed', 'Use the form.'));
    const origin = req.headers.origin;
    if (origin && origin !== this.origin) return send(403, resultPage('Not allowed', 'The form must be sent from its own page.'));
    if (entry.busy) return send(409, resultPage('Already in progress', 'This request is being handled.'));
    entry.busy = true;

    let body;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch {
      entry.busy = false;
      return send(413, resultPage('Too long', 'That is longer than any password should be.'));
    }
    const action = formField(body, 'action')?.toString('utf8') ?? 'submit';
    const secret = formField(body, 'secret');
    body.fill(0);

    if (action === 'cancel') {
      secret?.fill(0);
      this.finish(entry.id, { status: 'cancelled', reason: 'cancelled on the form' });
      return send(200, resultPage('Cancelled', 'Nothing was typed. Claude is told the request was cancelled.'));
    }
    if (!secret || secret.length === 0 || secret.length > MAX_SECRET_BYTES) {
      secret?.fill(0);
      entry.busy = false;
      return send(400, resultPage('Nothing entered', 'Go back and enter the value.'));
    }

    // Single use from here on: the entry is gone whatever happens next.
    this.pending.delete(entry.id);
    clearTimeout(entry.timer);
    let result;
    try {
      const reason = checkTarget(await this.readFocus(entry.request.app), entry.request);
      if (reason) {
        result = { status: 'refused', reason };
      } else {
        await this.typeSecret({ app: entry.request.app, secret });
        result = { status: 'filled' };
      }
    } catch (e) {
      result = { status: 'failed', reason: e.message };
    } finally {
      secret.fill(0);
    }
    entry.settle(result);
    this.log(`Secret "${entry.request.label}": ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
    if (result.status === 'filled') return send(200, resultPage('Filled in', `beckon typed it into ${entry.request.app}. You can close this page.`));
    return send(200, resultPage('Not filled', `Nothing was typed: ${result.reason}. Claude is told, and can ask again once the right field is focused.`));
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        chunks.forEach((x) => x.fill(0));
        req.destroy();
        reject(new Error('too large'));
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      chunks.forEach((x) => x.fill(0));
      resolve(body);
    });
    req.on('error', reject);
  });
}

export async function startSecretServer(broker, { port, host = '127.0.0.1' }) {
  const server = createServer((req, res) => {
    broker.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, SECURITY_HEADERS);
      res.end();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    port: server.address().port,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
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
