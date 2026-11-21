import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';

// The daemon's side of the relay (relay/worker.mjs): an outbound WebSocket, like Slack's Socket
// Mode, so this machine needs no open port. The relay sends a random challenge; the daemon
// answers with an HMAC of it under the shared token, so the token itself never crosses the wire.
// Submissions arrive as { id, reqId, body } and are answered with { reqId, status, reason }.
export class RelayClient extends EventEmitter {
  constructor({ url, token, WebSocketImpl = globalThis.WebSocket, log = () => {}, pingMs = 30_000 }) {
    super();
    const base = new URL(url);
    this.wsUrl = `${base.protocol === 'http:' ? 'ws' : 'wss'}://${base.host}/connect`;
    Object.assign(this, { token, WebSocket: WebSocketImpl, log, pingMs });
    this.ws = null;
    this.ready = false;
    this.stopped = false;
    this.failures = 0;
    this.records = new Map(); // id -> open message, re-sent after a reconnect
    this.handlers = { submit: null, enrolled: null };
  }

  start() {
    this.stopped = false;
    this.connect();
    this.pinger = setInterval(() => this.send({ type: 'ping' }), this.pingMs);
    this.pinger.unref?.();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pinger);
    this.ws?.close();
    this.ws = null;
    this.ready = false;
  }

  connect() {
    let ws;
    try {
      ws = new this.WebSocket(this.wsUrl);
    } catch (e) {
      this.log(`Relay connection failed: ${e.message}`);
      return this.retry();
    }
    this.ws = ws;
    ws.addEventListener('message', (m) => this.onMessage(ws, m.data));
    ws.addEventListener('close', (e) => {
      if (this.ws !== ws) return;
      this.ready = false;
      this.ws = null;
      if (e.code === 4001) this.log('The relay refused beckon: BECKON_RELAY_TOKEN does not match the relay\'s RELAY_TOKEN');
      this.retry();
    });
    ws.addEventListener('error', () => {});
  }

  retry() {
    if (this.stopped) return;
    const delay = Math.min(60_000, 1000 * 2 ** this.failures++);
    setTimeout(() => !this.stopped && this.connect(), delay).unref?.();
  }

  send(msg) {
    if (this.ws && this.ready) this.ws.send(JSON.stringify(msg));
  }

  // Publishes a request so the relay serves its page. Kept to re-publish after reconnecting.
  open(id, kind, meta, expiresAt) {
    const msg = { type: 'open', id, kind, meta, expiresAt };
    this.records.set(id, msg);
    this.send(msg);
  }

  close(id) {
    this.records.delete(id);
    this.send({ type: 'close', id });
  }

  async onMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    } catch {
      return;
    }
    if (msg.type === 'challenge') {
      ws.send(JSON.stringify({ type: 'auth', mac: createHmac('sha256', this.token).update(String(msg.nonce)).digest('hex') }));
    } else if (msg.type === 'ready') {
      this.ready = true;
      this.failures = 0;
      for (const [id, open] of this.records) {
        if (open.expiresAt < Date.now()) this.records.delete(id);
        else ws.send(JSON.stringify(open));
      }
      this.emit('ready');
    } else if ((msg.type === 'submit' || msg.type === 'enrolled') && msg.reqId) {
      const handler = this.handlers[msg.type];
      let result;
      try {
        result = handler ? await handler(msg.id, msg.body ?? {}) : { status: 'failed', reason: 'not handled' };
      } catch (e) {
        result = { status: 'failed', reason: e.message };
      }
      this.records.delete(msg.id);
      ws.send(JSON.stringify({ type: 'result', reqId: msg.reqId, status: result.status, reason: result.reason }));
    }
  }
}
