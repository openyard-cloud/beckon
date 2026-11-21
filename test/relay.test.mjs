import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { RelayClient } from '../src/relay.mjs';

class FakeSocket {
  static last = null;
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = {};
    FakeSocket.last = this;
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() {}
  deliver(msg) { for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(msg) }); }
}

const tick = () => new Promise((r) => setImmediate(r));

test('answers the challenge with an HMAC, republishes open requests and relays submissions', async () => {
  const token = 'x'.repeat(48);
  const client = new RelayClient({ url: 'https://relay.example.workers.dev', token, WebSocketImpl: FakeSocket, pingMs: 60_000 });
  client.handlers.submit = async (id, body) => ({ status: body.ok ? 'filled' : 'refused', reason: body.ok ? undefined : 'nope' });
  client.start();
  const ws = FakeSocket.last;
  assert.equal(ws.url, 'wss://relay.example.workers.dev/connect');

  client.open('A'.repeat(43), 'secret', { label: 'x' }, Date.now() + 60_000);
  assert.equal(ws.sent.length, 0, 'nothing is sent before the relay accepts beckon');

  ws.deliver({ type: 'challenge', nonce: 'n0nce' });
  assert.deepEqual(ws.sent[0], { type: 'auth', mac: createHmac('sha256', token).update('n0nce').digest('hex') });
  assert.ok(!JSON.stringify(ws.sent).includes(token), 'the token never crosses the wire');

  ws.deliver({ type: 'ready' });
  assert.equal(ws.sent[1].type, 'open', 'open requests are published once ready');

  ws.deliver({ type: 'submit', id: 'A'.repeat(43), reqId: 'r1', body: { ok: true } });
  await tick();
  assert.deepEqual(ws.sent.at(-1), { type: 'result', reqId: 'r1', status: 'filled' });
  ws.deliver({ type: 'submit', id: 'B'.repeat(43), reqId: 'r2', body: {} });
  await tick();
  assert.deepEqual(ws.sent.at(-1), { type: 'result', reqId: 'r2', status: 'refused', reason: 'nope' });
  client.stop();
});
