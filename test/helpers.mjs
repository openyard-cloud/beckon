import { mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
chmodSync(FAKE_CLAUDE, 0o755);
export const HOOK_SCRIPT = fileURLToPath(new URL('../bin/beckon-hook.mjs', import.meta.url));

export function tempDir(prefix = 'beckon-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Records every Slack Web API call and answers like Slack would.
export class FakeSlack {
  constructor() {
    this.calls = [];
    this.n = 0;
    this.replies = {};
  }

  async call(method, body = {}) {
    this.calls.push({ method, body });
    if (method === 'auth.test') return { ok: true, user_id: 'UBOT', user: 'beckon', team: 'Test', url: 'https://test.slack.com/' };
    if (method === 'chat.postMessage') return { ok: true, ts: `1700000000.${String(++this.n).padStart(6, '0')}`, channel: body.channel };
    if (method === 'conversations.list') return { ok: true, channels: [{ id: 'CPROJ', name: 'proj', is_member: true }] };
    if (method === 'conversations.replies') return { ok: true, messages: this.replies[body.ts] ?? [] };
    return { ok: true };
  }

  posts() {
    return this.calls.filter((c) => c.method === 'chat.postMessage').map((c) => c.body);
  }

  texts() {
    return this.posts().map((b) => (b.blocks?.find((x) => x.type === 'markdown')?.text ?? b.text)?.replace(/^\*\*(.*?)\*\*/, '$1'));
  }

  find(method, pred = () => true) {
    return this.calls.filter((c) => c.method === method && pred(c.body));
  }
}

export async function waitFor(fn, { timeout = 5000, interval = 20 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}
