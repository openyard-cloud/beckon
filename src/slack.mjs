import { EventEmitter } from 'node:events';

const API = 'https://slack.com/api/';

// Some read methods (conversations.replies, conversations.list) reject JSON bodies; form
// encoding works everywhere, with objects and arrays sent as JSON strings.
export function formEncode(body) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body ?? {})) {
    if (v === undefined || v === null) continue;
    params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return params.toString();
}

export class SlackError extends Error {
  constructor(method, code, detail) {
    super(`Slack ${method} failed: ${code}${detail ? ` (${detail})` : ''}`);
    this.code = code;
  }
}

export class SlackApi {
  constructor(token, { fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.token = token;
    this.fetch = fetchImpl;
    this.sleep = sleep;
  }

  async call(method, body = {}, attempt = 0) {
    const res = await this.fetch(API + method, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body: formEncode(body),
    });
    if (res.status === 429 && attempt < 5) {
      const wait = Number(res.headers.get('retry-after') ?? 1);
      await this.sleep(Math.max(1, wait) * 1000);
      return this.call(method, body, attempt + 1);
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new SlackError(method, `http_${res.status}`);
    }
    if (!data.ok) {
      const detail = data.response_metadata?.messages?.join('; ');
      throw new SlackError(method, data.error ?? 'unknown_error', detail);
    }
    return data;
  }
}

// Socket Mode: Slack pushes events over a WebSocket opened from this machine, so beckon needs
// no public URL. Every envelope must be acknowledged within 3 seconds, which happens before the
// handlers run.
export class SocketClient extends EventEmitter {
  constructor(appToken, {
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    log = () => {},
    staleMs = 60 * 60 * 1000,
  } = {}) {
    super();
    this.api = new SlackApi(appToken, { fetchImpl });
    this.WebSocket = WebSocketImpl;
    this.log = log;
    this.staleMs = staleMs;
    this.ws = null;
    this.stopped = false;
    this.failures = 0;
    this.lastSeen = 0;
    this.watchdog = null;
  }

  async start() {
    this.stopped = false;
    await this.connect();
    this.watchdog = setInterval(() => {
      if (this.ws && Date.now() - this.lastSeen > this.staleMs) {
        this.log('Slack connection went quiet, reconnecting');
        this.reconnect();
      }
    }, 30_000);
    this.watchdog.unref?.();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    this.ws?.close();
    this.ws = null;
  }

  async connect() {
    const { url } = await this.api.call('apps.connections.open');
    const ws = new this.WebSocket(url);
    this.ws = ws;
    this.lastSeen = Date.now();
    ws.addEventListener('message', (msg) => {
      this.lastSeen = Date.now();
      this.onMessage(ws, msg.data);
    });
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.reconnect();
    });
    ws.addEventListener('error', (e) => {
      this.log(`Slack socket error: ${e.message ?? e.type ?? 'unknown'}`);
    });
  }

  reconnect() {
    const old = this.ws;
    this.ws = null;
    try { old?.close(); } catch { /* already closed */ }
    if (this.stopped) return;
    const delay = Math.min(60_000, 1000 * 2 ** this.failures);
    setTimeout(async () => {
      if (this.stopped) return;
      try {
        await this.connect();
        this.failures = 0;
      } catch (e) {
        this.failures++;
        this.log(`Could not reconnect to Slack: ${e.message}`);
        this.reconnect();
      }
    }, delay).unref?.();
  }

  onMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    } catch {
      return;
    }
    if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
    if (msg.type === 'hello') {
      this.emit('ready');
    } else if (msg.type === 'disconnect') {
      this.log(`Slack asked to reconnect (${msg.reason ?? 'no reason'})`);
      if (this.ws === ws) this.reconnect();
    } else if (msg.type === 'events_api') {
      const event = msg.payload?.event;
      if (event) this.emit('event', event);
    } else if (msg.type === 'interactive') {
      this.emit('interactive', msg.payload);
    }
  }
}
