import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Beckon } from '../src/daemon.mjs';
import { validateConfig } from '../src/config.mjs';
import { StateStore } from '../src/state.mjs';
import { startHookServer } from '../src/hookserver.mjs';
import { FakeSlack, FAKE_CLAUDE, HOOK_SCRIPT, tempDir, waitFor } from './helpers.mjs';

async function setup({ config: extra = {}, env: extraEnv = {} } = {}) {
  const home = tempDir();
  const { config, errors } = validateConfig({
    users: ['U1'],
    projects: {
      proj: { path: home, channels: ['#proj'], alwaysAsk: ['playwright test'] },
      other: { path: home, channels: [] },
    },
    defaultProject: 'proj',
    claudePath: FAKE_CLAUDE,
    approvalTimeoutMinutes: 1,
    ...extra,
  });
  assert.deepEqual(errors, []);
  const slack = new FakeSlack();
  const state = new StateStore(join(home, 'state.json'));
  const logFile = join(home, 'claude.log');
  const beckon = new Beckon({
    config,
    slack,
    state,
    worktreesDir: join(home, 'wt'),
    hookScript: HOOK_SCRIPT,
    env: { ...process.env, FAKE_CLAUDE_LOG: logFile, ANTHROPIC_API_KEY: 'sk-should-be-removed', ...extraEnv },
    ensureWorktree: async ({ dir }) => {
      const created = !existsSync(dir);
      mkdirSync(dir, { recursive: true });
      return { created, ref: 'origin/main' };
    },
    removeWorktree: async () => ({ removed: true }),
  });
  const hook = await startHookServer((body) => beckon.onHook(body));
  await beckon.start({ hook, background: false });
  const claudeRuns = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const done = async () => {
    await waitFor(() => beckon.running.size === 0 && beckon.waiting.length === 0);
  };
  const close = async () => {
    await beckon.stopAll();
    await hook.close();
  };
  return { beckon, slack, state, claudeRuns, done, close };
}

let tsN = 0;
const msg = (extra) => ({ type: 'message', channel: 'CPROJ', channel_type: 'channel', user: 'U1', ts: `1800000000.${String(++tsN).padStart(6, '0')}`, ...extra });
const mention = (text, extra) => msg({ type: 'app_mention', text: `<@UBOT> ${text}`, ...extra });

function approvalId(slack, actionId = 'beckon_allow') {
  for (const p of slack.posts()) {
    const actions = p.blocks?.find((b) => b.type === 'actions');
    const btn = actions?.elements.find((e) => e.action_id === actionId);
    if (btn) return btn.value;
  }
  return null;
}

const click = (actionId, value, user = 'U1') => ({ type: 'block_actions', user: { id: user }, channel: { id: 'CPROJ' }, actions: [{ action_id: actionId, value }] });

test('a mention starts a thread, a reply resumes the same session', async () => {
  const { beckon, slack, claudeRuns, done, close } = await setup();
  const first = mention('hello there');
  await beckon.handleEvent(first);
  await done();
  assert.ok(slack.texts().includes('echo: hello there'));
  const thread = slack.posts().find((p) => p.text === 'Working…');
  assert.equal(thread.thread_ts, first.ts);

  const [run1] = claudeRuns();
  assert.ok(run1.argv.includes('--session-id'));
  assert.equal(run1.apiKey, null, 'ANTHROPIC_API_KEY must not reach claude');
  assert.ok(run1.cwd.includes(join('wt', 'proj')));
  const sid = run1.argv[run1.argv.indexOf('--session-id') + 1];

  await beckon.handleEvent(msg({ text: 'and again', thread_ts: first.ts }));
  await done();
  const run2 = claudeRuns()[1];
  assert.equal(run2.argv[run2.argv.indexOf('--resume') + 1], sid);
  assert.equal(run2.cwd, run1.cwd);
  assert.ok(slack.texts().includes('echo: and again'));

  const progress = slack.find('chat.update').at(-1).body;
  assert.match(progress.blocks[0].text.text, /Done in/);
  assert.equal(progress.blocks.length, 1, 'the Stop button is gone when the run ends');
  await close();
});

test('ignores strangers, bots and messages not meant for beckon', async () => {
  const { beckon, claudeRuns, done, close } = await setup();
  await beckon.handleEvent(mention('hi', { user: 'U999' }));
  await beckon.handleEvent(msg({ text: 'just chatting' }));
  await beckon.handleEvent(mention('hi', { bot_id: 'B1', user: 'U1' }));
  await beckon.handleEvent(mention('hi', { subtype: 'message_changed' }));
  await done();
  assert.equal(claudeRuns().length, 0);
  await close();
});

test('the same message delivered as app_mention and message runs once', async () => {
  const { beckon, claudeRuns, done, close } = await setup();
  const m = mention('once');
  await beckon.handleEvent(m);
  await beckon.handleEvent({ ...m, type: 'message' });
  await done();
  assert.equal(claudeRuns().length, 1);
  await close();
});

test('a risky command waits for the button and runs after Allow', async () => {
  const { beckon, slack, done, close } = await setup();
  await beckon.handleEvent(mention('RUN:npx vercel --prod'));
  await waitFor(() => approvalId(slack));
  const ask = slack.posts().find((p) => p.text?.startsWith('Approval needed'));
  assert.match(ask.blocks[0].text.text, /<@U1> approval needed: deploy or change production/);
  assert.ok(!approvalId(slack, 'beckon_allow_all'), 'risky actions are approved one at a time');

  await beckon.handleInteractive(click('beckon_allow', approvalId(slack), 'U999'));
  assert.equal(slack.find('chat.postEphemeral').length, 1);
  assert.equal(beckon.approvals.size, 1, 'a stranger cannot approve');

  await beckon.handleInteractive(click('beckon_allow', approvalId(slack)));
  await done();
  assert.ok(slack.texts().includes('ran npx vercel --prod'));
  const updated = slack.find('chat.update', (b) => b.text?.includes('Allowed by <@U1>'));
  assert.equal(updated.length, 1);
  await close();
});

test('Deny tells claude not to work around it', async () => {
  const { beckon, slack, done, close } = await setup();
  await beckon.handleEvent(mention('RUN:git push origin main'));
  await waitFor(() => approvalId(slack, 'beckon_deny'));
  await beckon.handleInteractive(click('beckon_deny', approvalId(slack, 'beckon_deny')));
  await done();
  const reply = slack.texts().find((t) => t?.startsWith('denied:'));
  assert.match(reply, /denied this in Slack\. Do not reach the same result another way/);
  await close();
});

test('project rules ask too; harmless commands run without asking', async () => {
  const { beckon, slack, done, close } = await setup();
  await beckon.handleEvent(mention('RUN:pnpm exec playwright test'));
  await waitFor(() => approvalId(slack));
  await beckon.handleInteractive(click('beckon_allow', approvalId(slack)));
  await done();

  const before = slack.posts().length;
  await beckon.handleEvent(mention('RUN:pnpm test'));
  await done();
  assert.ok(slack.texts().includes('ran pnpm test'));
  assert.ok(!slack.posts().slice(before).some((p) => p.text?.startsWith('Approval needed')));
  await close();
});

test('"Allow everything in this thread" stops later permission prompts in that thread only', async () => {
  const { beckon, slack, done, close } = await setup();
  const first = mention('PERM:ls -la');
  await beckon.handleEvent(first);
  await waitFor(() => approvalId(slack, 'beckon_allow_all'));
  await beckon.handleInteractive(click('beckon_allow_all', approvalId(slack, 'beckon_allow_all')));
  await done();
  assert.ok(slack.texts().includes('ran ls -la'));

  const asksBefore = slack.posts().filter((p) => p.text?.startsWith('Approval needed')).length;
  await beckon.handleEvent(msg({ text: 'PERM:cat x', thread_ts: first.ts }));
  await done();
  assert.ok(slack.texts().includes('ran cat x'));
  assert.equal(slack.posts().filter((p) => p.text?.startsWith('Approval needed')).length, asksBefore);

  await beckon.handleEvent(msg({ text: 'RUN:npm publish', thread_ts: first.ts }));
  await waitFor(() => beckon.approvals.size === 1);
  await beckon.handleEvent(msg({ text: 'stop', thread_ts: first.ts }));
  await done();
  assert.ok(slack.texts().some((t) => t?.startsWith('denied:') && t.includes('stopped')) || slack.texts().some((t) => t?.startsWith('Stopped by')));
  await close();
});

test('stop ends a running turn', async () => {
  const { beckon, slack, done, close } = await setup();
  const m = mention('SLEEP');
  await beckon.handleEvent(m);
  await waitFor(() => slack.find('chat.update').length > 0 || beckon.running.size === 1);
  await new Promise((r) => setTimeout(r, 300));
  await beckon.handleEvent(msg({ text: 'stop', thread_ts: m.ts }));
  await done();
  assert.ok(slack.texts().some((t) => t?.startsWith('Stopped by <@U1>')));
  await close();
});

test('picks the project from a prefix, the DM default or the channel', async () => {
  const { beckon, slack, state, done, close } = await setup();
  await beckon.handleEvent(mention('other: do it'));
  await beckon.handleEvent(msg({ channel: 'D1', channel_type: 'im', text: 'from a DM' }));
  await beckon.handleEvent(mention('hi', { channel: 'CUNLINKED' }));
  await done();
  const projects = Object.values(state.threads).map((t) => `${t.channel}:${t.project}`).sort();
  assert.deepEqual(projects, ['CPROJ:other', 'D1:proj']);
  assert.ok(slack.texts().includes('echo: do it'));
  assert.ok(slack.posts().some((p) => p.channel === 'CUNLINKED' && /not linked to a project/.test(p.text)));
  await close();
});

test('a mention inside an existing discussion brings the discussion along', async () => {
  const { beckon, slack, done, close } = await setup();
  slack.replies['1799999999.000001'] = [
    { ts: '1799999999.000001', user: 'U2', text: 'login is broken on Safari' },
    { ts: '1799999999.000002', user: 'U3', text: 'only after the last deploy' },
  ];
  await beckon.handleEvent(mention('can you look?', { thread_ts: '1799999999.000001', ts: '1800000099.000001' }));
  await done();
  const reply = slack.texts().find((t) => t?.startsWith('echo:'));
  assert.match(reply, /<@U2>: login is broken on Safari\n<@U3>: only after the last deploy/);
  assert.match(reply, /can you look\?$/);
  await close();
});

test('schedules post a message and run once per matching minute', async () => {
  const { beckon, slack, done, close } = await setup({
    config: { schedules: [{ name: 'Morning report', cron: '0 8 * * *', timezone: 'Asia/Ho_Chi_Minh', project: 'proj', channel: '#proj', prompt: 'report please' }] },
  });
  const at = new Date('2026-11-23T01:00:10Z');
  await beckon.tick(at);
  await beckon.tick(new Date('2026-11-23T01:00:40Z'));
  await beckon.tick(new Date('2026-11-23T02:00:00Z'));
  await done();
  assert.equal(slack.posts().filter((p) => p.text === ':alarm_clock: Morning report').length, 1);
  assert.ok(slack.texts().includes('echo: report please'));
  await close();
});

test('a schedule can post to a member ID, which Slack turns into a DM', async () => {
  const { beckon, slack, state, done, close } = await setup({
    config: { schedules: [{ name: 'DM report', cron: '* * * * *', project: 'proj', channel: 'U1', prompt: 'dm report' }] },
  });
  const post = slack.call.bind(slack);
  slack.call = async (method, body) => {
    const res = await post(method, body);
    return method === 'chat.postMessage' && body.channel === 'U1' ? { ...res, channel: 'DU1' } : res;
  };
  await beckon.tick(new Date('2026-11-23T01:00:00Z'));
  await done();
  assert.equal(Object.values(state.threads)[0].channel, 'DU1');
  assert.ok(slack.texts().includes('echo: dm report'));
  await close();
});

test('runs at most maxParallel turns and queues the rest', async () => {
  const { beckon, slack, done, close } = await setup({ config: { maxParallel: 1 } });
  const a = mention('SLEEP');
  await beckon.handleEvent(a);
  await beckon.handleEvent(mention('second task'));
  assert.equal(beckon.waiting.length, 1);
  assert.ok(slack.posts().some((p) => p.text?.startsWith('Queued:')));
  await new Promise((r) => setTimeout(r, 300));
  await beckon.handleEvent(msg({ text: 'stop', thread_ts: a.ts }));
  await done();
  assert.ok(slack.texts().includes('echo: second task'));
  await close();
});

test('starts a fresh session when the old one cannot be found', async () => {
  const { beckon, slack, state, claudeRuns, done, close } = await setup({ env: { FAKE_CLAUDE_MISSING_SESSION: '1' } });
  const m = mention('first');
  await beckon.handleEvent(m);
  await done();
  const oldId = Object.values(state.threads)[0].sessionId;
  await beckon.handleEvent(msg({ text: 'second', thread_ts: m.ts }));
  await done();
  const runs = claudeRuns();
  assert.equal(runs.length, 3);
  assert.ok(runs[2].argv.includes('--session-id'));
  assert.notEqual(Object.values(state.threads)[0].sessionId, oldId);
  assert.ok(slack.texts().includes('echo: second'));
  await close();
});

test('status lists running work', async () => {
  const { beckon, slack, done, close } = await setup();
  const a = mention('SLEEP');
  await beckon.handleEvent(a);
  await beckon.handleEvent(mention('status'));
  const status = slack.texts().at(-1);
  assert.match(status, /\*\*proj\*\*: \[SLEEP\]\(https:\/\/test\.slack\.com\/archives\/CPROJ\/p/);
  await new Promise((r) => setTimeout(r, 300));
  await beckon.handleEvent(msg({ text: 'stop', thread_ts: a.ts }));
  await done();
  await close();
});
