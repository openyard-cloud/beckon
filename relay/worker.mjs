// beckon relay: a Cloudflare Worker that hosts the secret form and passes encrypted submissions
// to the beckon daemon, which keeps an outbound WebSocket open to it. The relay never sees a
// secret: the page encrypts it on the phone to a key only the daemon holds (its public half
// travels in the link's #fragment, which browsers do not send to servers), and the daemon
// checks a passkey signature over the ciphertext. The relay only stores request metadata.
//
// Routes
//   GET  /connect      WebSocket for the daemon (HMAC challenge with RELAY_TOKEN)
//   GET  /s/:id        secret form          POST /s/:id   encrypted submission or cancel
//   GET  /e/:id        passkey enrollment   POST /e/:id   new passkey
//   GET  /app.js       the page script (the only script, allowed by CSP 'self')

import { DurableObject } from 'cloudflare:workers';
import { PAGE_SCRIPT } from './page.mjs';

const ID = /^[A-Za-z0-9_-]{43}$/;
const MAX_BODY = 16 * 1024;

const SECURITY = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

const html = (body, status = 200) => new Response(body, { status, headers: { ...SECURITY, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP } });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...SECURITY, 'content-type': 'application/json' } });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' && !url.hostname.endsWith('localhost')) return new Response('https only', { status: 400 });
    if (url.pathname === '/app.js') {
      return new Response(PAGE_SCRIPT, { headers: { ...SECURITY, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' } });
    }
    const relay = env.RELAY.get(env.RELAY.idFromName('beckon'));
    if (url.pathname === '/connect' || /^\/[se]\/[A-Za-z0-9_-]+$/.test(url.pathname)) return relay.fetch(request);
    return html(page('beckon', '<p>Nothing here.</p>'), 404);
  },
};

function page(title, body, meta) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6efe0;--fg:#1c2530;--muted:#5b6470;--card:#fff;--accent:#ef9f2c;--line:#e2d8c4;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#14191f;--fg:#f1ece2;--muted:#a3abb5;--card:#1c2530;--line:#2c3642;--bad:#f2b8b5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 -apple-system,system-ui,sans-serif;padding:24px 16px}
main{max-width:420px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px}
h1{font-size:19px;margin:0 0 14px}dl{margin:0 0 18px;display:grid;grid-template-columns:auto 1fr;gap:6px 12px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
input,textarea{width:100%;font:inherit;font-size:20px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);margin:4px 0 16px}
textarea{font:13px/1.4 ui-monospace,Menlo,monospace;resize:vertical}.pick{display:block;margin:-8px 0 16px}.pick input{font-size:14px;padding:6px;margin:4px 0 0}code{font:13px ui-monospace,Menlo,monospace;overflow-wrap:anywhere}
.row{display:flex;gap:10px}button{flex:1;font:inherit;font-weight:600;padding:12px;border-radius:10px;border:0;cursor:pointer}
.go{background:var(--accent);color:#1c2530}.stop{background:transparent;color:var(--muted);border:1px solid var(--line)}
p{margin:0 0 10px}.muted{color:var(--muted);font-size:14px}#status{min-height:1.4em;margin-top:14px}.bad{color:var(--bad)}
</style></head><body><main>${body}</main>${meta ? `<script type="application/json" id="meta">${JSON.stringify(meta).replace(/</g, '\\u003c')}</script><script src="/app.js"></script>` : ''}</body></html>`;
}

function secretPage(meta) {
  const run = meta.run;
  const multiline = meta.inputKind === 'multiline';
  const autocomplete = meta.inputKind === 'otp' ? 'one-time-code' : meta.inputKind === 'password' && !run ? 'current-password' : 'off';
  const max = run ? 8192 : 1024;
  const details = run
    ? `<dt>For</dt><dd><code>${esc(run.command)}</code></dd><dt>Given</dt><dd>${{ stdin: 'on the command\'s input', env: `in $${esc(run.name)}`, file: 'as a temporary file' }[run.via] ?? ''}, once</dd>`
    : `<dt>App</dt><dd>${esc(meta.app)}</dd><dt>Site</dt><dd>${esc(meta.domains?.length ? meta.domains.join(', ') : '(not a web page)')}</dd><dt>Into</dt><dd>the focused ${{ password: 'password field', otp: 'one-time code field', text: 'text field' }[meta.inputKind] ?? 'field'}</dd>`;
  const input = multiline
    ? `<textarea id="secret" rows="7" maxlength="${max}" required autofocus spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="${esc(meta.label)}"></textarea>
<label class="muted pick">or choose a file <input id="pick" type="file"></label>`
    : `<input id="secret" type="password" autocomplete="${autocomplete}"${meta.inputKind === 'otp' ? ' inputmode="numeric"' : ''} maxlength="${max}" required autofocus aria-label="${esc(meta.label)}">`;
  const footer = run
    ? 'Encrypted on this device for the one beckon-secret process on your Mac that asked for it, and signed with your passkey. The relay, Slack, Claude and beckon itself cannot read it. It is used once, then wiped, and this link stops working.'
    : 'Encrypted on this device for beckon on your Mac and signed with your passkey. The relay, Slack and Claude never see it. This link works once.';
  return page('beckon: enter a secret', `<h1>🔐 ${esc(meta.label)}</h1>
<dl>${details}${meta.note ? `<dt>Note</dt><dd>${esc(meta.note)}</dd>` : ''}</dl>
<form id="form" autocomplete="off">
${input}
<div class="row"><button class="go" type="submit">${run ? 'Send once' : 'Fill it in'}</button><button class="stop" type="button" id="cancel">Cancel</button></div>
</form><p id="status" role="status"></p>
<p class="muted">${footer}</p>`, meta);
}

function enrollPage(meta) {
  return page('beckon: add a passkey', `<h1>🔑 Add a passkey for beckon</h1>
<p>beckon asks for this passkey (Face ID or Touch ID) every time you enter a password or code for it.</p>
<div class="row"><button class="go" id="enroll" type="button">Create passkey</button></div><p id="status" role="status"></p>
<p class="muted">The passkey stays on your devices. beckon on your Mac keeps only its public key.</p>`, meta);
}

const gone = () => html(page('Link no longer valid', '<h1>Link no longer valid</h1><p>This link was used, cancelled or has expired. Ask again from Slack if you still need it.</p>'), 410);

export class Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.waiting = new Map(); // reqId -> resolve, for submissions waiting on the daemon
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  daemon() {
    return this.ctx.getWebSockets('daemon').find((ws) => ws.deserializeAttachment()?.authed);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/connect') return this.connect(request);
    const [, kind, id] = url.pathname.split('/');
    if (!ID.test(id)) return gone();
    const record = await this.ctx.storage.get(`r:${id}`);
    if (!record || record.kind !== (kind === 's' ? 'secret' : 'enroll') || record.used || Date.now() > record.expiresAt) return gone();

    if (request.method === 'GET') return html(kind === 's' ? secretPage(record.meta) : enrollPage(record.meta));
    if (request.method !== 'POST') return json({ status: 'invalid', reason: 'method' }, 405);
    if (request.headers.get('origin') !== url.origin) return json({ status: 'invalid', reason: 'origin' }, 403);
    if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return json({ status: 'invalid', reason: 'content type' }, 415);
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ status: 'invalid', reason: 'too large' }, 413);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ status: 'invalid', reason: 'bad json' }, 400);
    }
    const daemon = this.daemon();
    if (!daemon) return json({ status: 'failed', reason: 'beckon is not connected to the relay right now' }, 503);

    // One use: whatever happens next, this link is spent.
    await this.ctx.storage.put(`r:${id}`, { ...record, used: true });
    const reqId = crypto.randomUUID();
    const result = new Promise((resolve) => {
      this.waiting.set(reqId, resolve);
      setTimeout(() => {
        if (this.waiting.delete(reqId)) resolve({ status: 'failed', reason: 'beckon did not answer in time' });
      }, 60_000);
    });
    daemon.send(JSON.stringify({ type: kind === 's' ? 'submit' : 'enrolled', id, reqId, body }));
    return json(await result);
  }

  async connect(request) {
    if (request.headers.get('upgrade') !== 'websocket') return new Response('expected a websocket', { status: 426 });
    if (!this.env.RELAY_TOKEN || this.env.RELAY_TOKEN.length < 32) return new Response('relay is not configured', { status: 500 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(32)));
    this.ctx.acceptWebSocket(server, ['daemon']);
    server.serializeAttachment({ authed: false, nonce, at: Date.now() });
    server.send(JSON.stringify({ type: 'challenge', nonce }));
    await this.ctx.storage.setAlarm(Date.now() + 10_000);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    const state = ws.deserializeAttachment() ?? {};
    if (!state.authed) {
      if (msg.type !== 'auth' || !(await hmacOk(this.env.RELAY_TOKEN, state.nonce, msg.mac))) {
        ws.close(4001, 'unauthorized');
        return;
      }
      for (const other of this.ctx.getWebSockets('daemon')) {
        if (other !== ws && other.deserializeAttachment()?.authed) other.close(4000, 'replaced by a new connection');
      }
      ws.serializeAttachment({ authed: true });
      ws.send(JSON.stringify({ type: 'ready' }));
      return;
    }
    if (msg.type === 'open' && ID.test(msg.id) && (msg.kind === 'secret' || msg.kind === 'enroll')) {
      const expiresAt = Math.min(Number(msg.expiresAt) || 0, Date.now() + 30 * 60_000);
      await this.ctx.storage.put(`r:${msg.id}`, { kind: msg.kind, meta: msg.meta ?? {}, expiresAt, used: false });
      await this.ctx.storage.setAlarm(Math.min(expiresAt + 1000, (await this.ctx.storage.getAlarm()) ?? Infinity));
    } else if (msg.type === 'close' && ID.test(msg.id)) {
      await this.ctx.storage.delete(`r:${msg.id}`);
    } else if (msg.type === 'result' && typeof msg.reqId === 'string') {
      const resolve = this.waiting.get(msg.reqId);
      if (resolve) {
        this.waiting.delete(msg.reqId);
        resolve({ status: String(msg.status ?? 'failed'), reason: msg.reason ? String(msg.reason).slice(0, 300) : undefined });
      }
    }
  }

  // Cleans up expired records and drops sockets that never authenticated.
  async alarm() {
    const now = Date.now();
    let next = Infinity;
    for (const [key, record] of await this.ctx.storage.list({ prefix: 'r:' })) {
      if (now > record.expiresAt + 60_000) await this.ctx.storage.delete(key);
      else next = Math.min(next, record.expiresAt + 61_000);
    }
    for (const ws of this.ctx.getWebSockets('daemon')) {
      const s = ws.deserializeAttachment();
      if (!s?.authed && now - (s?.at ?? 0) > 10_000) ws.close(4001, 'authentication timed out');
    }
    if (next !== Infinity) await this.ctx.storage.setAlarm(next);
  }

  webSocketClose(ws, code) {
    try { ws.close(code, 'closing'); } catch { /* already closed */ }
  }
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacOk(token, nonce, mac) {
  if (typeof mac !== 'string' || !nonce) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sig = Uint8Array.from(mac.match(/../g) ?? [], (h) => parseInt(h, 16));
  return crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(nonce));
}
