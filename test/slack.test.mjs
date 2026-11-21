import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SocketClient, SlackApi } from '../src/slack.mjs';

class FakeWS {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = {};
    FakeWS.last = this;
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() {}
  deliver(obj) { for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(obj) }); }
}

const okFetch = (body) => async () => ({ status: 200, headers: new Headers(), json: async () => body });

test('acknowledges every envelope and emits events and button clicks', async () => {
  const client = new SocketClient('xapp-1', { fetchImpl: okFetch({ ok: true, url: 'wss://example' }), WebSocketImpl: FakeWS });
  const events = [];
  const clicks = [];
  client.on('event', (e) => events.push(e));
  client.on('interactive', (p) => clicks.push(p));
  await client.start();
  const ws = FakeWS.last;
  assert.equal(ws.url, 'wss://example');
  ws.deliver({ type: 'hello' });
  ws.deliver({ envelope_id: 'e1', type: 'events_api', payload: { event: { type: 'app_mention', text: 'hi' } } });
  ws.deliver({ envelope_id: 'e2', type: 'interactive', payload: { type: 'block_actions' } });
  assert.deepEqual(ws.sent, [{ envelope_id: 'e1' }, { envelope_id: 'e2' }]);
  assert.equal(events[0].text, 'hi');
  assert.equal(clicks[0].type, 'block_actions');
  client.stop();
});

test('Web API errors name the method and Slack error code', async () => {
  const api = new SlackApi('xoxb-1', { fetchImpl: okFetch({ ok: false, error: 'channel_not_found' }) });
  await assert.rejects(api.call('chat.postMessage', {}), /chat\.postMessage failed: channel_not_found/);
});

test('waits and retries when rate limited', async () => {
  let n = 0;
  const waits = [];
  const fetchImpl = async () => (++n === 1
    ? { status: 429, headers: new Headers({ 'retry-after': '2' }), json: async () => ({}) }
    : { status: 200, headers: new Headers(), json: async () => ({ ok: true, ts: '1' }) });
  const api = new SlackApi('xoxb-1', { fetchImpl, sleep: async (ms) => waits.push(ms) });
  assert.equal((await api.call('chat.postMessage')).ts, '1');
  assert.deepEqual(waits, [2000]);
});
