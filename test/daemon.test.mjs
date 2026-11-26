import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Beckon } from '../src/daemon.mjs';
import { validateConfig } from '../src/config.mjs';
import { StateStore } from '../src/state.mjs';
import { startHookServer } from '../src/hookserver.mjs';
import { SecretBroker } from '../src/secrets.mjs';
import { PasskeyStore } from '../src/passkeys.mjs';
import { makeAuthenticator, registration, submission } from './phone.mjs';
import { fileURLToPath } from 'node:url';
import { FakeSlack, FAKE_CLAUDE, HOOK_SCRIPT, tempDir, waitFor } from './helpers.mjs';

async function setup({ config: extra = {}, env: extraEnv = {}, withFile = false, beckonOptions = {} } = {}) {
  const home = tempDir();
  const raw = {
    users: ['U1'],
    projects: {
      proj: { path: home, channels: ['#proj'], alwaysAsk: ['playwright test'] },
      other: { path: home, channels: [] },
    },
    defaultProject: 'proj',
    claudePath: FAKE_CLAUDE,
    approvalTimeoutMinutes: 1,
    ...extra,
  };
  const { config, errors } = validateConfig(raw);
  assert.deepEqual(errors, []);
  const configFile = withFile ? join(home, 'config.json') : null;
  if (configFile) writeFileSync(configFile, JSON.stringify(raw, null, 2));
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
    configFile,
    ...beckonOptions,
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
  return { beckon, slack, state, claudeRuns, done, close, home, configFile };
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

  const final = slack.posts().at(-1);
  assert.equal(final.blocks[0].type, 'plan');
  assert.match(final.blocks[0].title, /^Done in/);
  assert.equal(final.text, 'echo: and again', 'the notification shows the summary line');
  assert.ok(!final.blocks.some((b) => b.type === 'actions'), 'no Stop button once the run ends');
  assert.equal(slack.find('chat.delete').length, 2, 'each live progress message is replaced by the final one');
  await close();
});

test('an approval button from a run that no longer exists says so instead of doing nothing', async () => {
  const { beckon, slack, close } = await setup();
  const stale = { ...click('beckon_allow', 'gone-approval-id'), message: { ts: '111.222' } };
  assert.equal(await beckon.handleInteractive(stale), false);
  const [update] = slack.find('chat.update', (b) => b.ts === '111.222');
  await close();
  assert.ok(update, 'the stale approval message is updated');
  assert.match(update.body.text, /already ended/);
  assert.deepEqual(update.body.blocks, [], 'its buttons are removed');
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

test('a mention by the bot ID, as Slack on a phone sometimes sends, counts as a mention', async () => {
  const { beckon, slack, claudeRuns, done, close } = await setup();
  await beckon.handleEvent(msg({ text: '<@BBOT> check the ads' }));
  await done();
  assert.equal(claudeRuns().length, 1);
  assert.ok(slack.texts().includes('echo: check the ads'), 'the mention is dropped from what Claude reads');
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

  const askTs = slack.posts().indexOf(ask);
  await beckon.handleInteractive(click('beckon_allow', approvalId(slack)));
  await done();
  assert.ok(slack.texts().includes('ran npx vercel --prod'));
  assert.ok(slack.find('chat.delete').some((c) => c.body.ts === `1700000000.${String(askTs + 1).padStart(6, '0')}`), 'the approval question is removed once answered');
  const plan = slack.posts().at(-1).blocks[0];
  const step = plan.tasks.find((x) => x.title.startsWith('Approval: deploy'));
  assert.equal(step.status, 'complete');
  assert.match(step.output.elements[0].elements[0].text, /allowed in Slack/);
  await close();
});

test('a run that leaves its browser tabs open is sent back to close them', async () => {
  const { beckon, slack, done, close } = await setup();
  await beckon.handleEvent(mention('TABS'));
  await done();
  const reply = slack.texts().find((t) => t?.startsWith('reminded'));
  assert.match(reply, /^reminded 1: .*tabId 111/);

  await beckon.handleEvent(mention('TABS STUBBORN'));
  await done();
  assert.ok(slack.texts().some((t) => t?.startsWith('reminded 2:')), 'gives up after two reminders');

  await beckon.handleEvent(mention('hello'));
  await done();
  assert.ok(slack.texts().some((t) => t === 'echo: hello'), 'runs without tabs are not held up');
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
  assert.ok(slack.find('reactions.add').some((c) => c.body.name === 'hourglass_flowing_sand'), 'a queued task gets an hourglass, not a message');
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

test('a restart lets running work finish and turns new work away', async () => {
  const { beckon, slack, claudeRuns, close } = await setup();
  await beckon.handleEvent(mention('SLOW'));
  await waitFor(() => claudeRuns().length === 1);
  const run = await waitFor(() => [...beckon.running.values()][0]);
  const stopping = beckon.shutdownGracefully(10_000);
  assert.match(run.progress.title(Date.now(), 'working'), /beckon restarts after this run/);
  await beckon.handleEvent(mention('new work'));
  await stopping;
  assert.ok(slack.texts().includes('slow done'), 'the running task finished');
  assert.ok(slack.texts().includes('beckon is restarting. Send this again in a minute.'));
  assert.equal(claudeRuns().length, 1, 'no new work started');
  await close();
});

test('a restart stops work that outlasts the grace period', async () => {
  const { beckon, slack, close } = await setup();
  await beckon.handleEvent(mention('SLEEP'));
  await new Promise((r) => setTimeout(r, 300));
  await beckon.shutdownGracefully(300);
  assert.ok(slack.texts().some((t) => t?.startsWith('Stopped because beckon shut down')));
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

test('the summary line is the notification text and bold at the top of the answer', async () => {
  const { emphasizeSummary } = await import('../src/daemon.mjs');
  assert.equal(emphasizeSummary('Pushed the fix.\n\nDetails.'), '**Pushed the fix.**\n\nDetails.');
  assert.equal(emphasizeSummary('# Heading\ntext'), '# Heading\ntext');
  assert.equal(emphasizeSummary('- a list'), '- a list');
});

const lastText = (slack) => slack.posts().at(-1).blocks?.[0]?.text?.text ?? slack.posts().at(-1).text;

test('projects can be added, linked, defaulted and removed from Slack', async () => {
  const { beckon, slack, configFile, home, done, close } = await setup({ withFile: true });
  const repo = join(home, 'hush');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);

  await beckon.handleEvent(mention('add project hush /nope/missing'));
  assert.match(lastText(slack), /Not added: .*does not exist/);

  await beckon.handleEvent(mention(`add project Hush ${repo} <#CHUSH|hush-agent>`));
  assert.match(lastText(slack), /Added project \*Hush\*.*<#CHUSH>/);
  let saved = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.deepEqual(saved.projects.Hush, { path: repo, channels: ['CHUSH'] });
  assert.equal(beckon.channelProjects.get('CHUSH'), 'Hush', 'applied without a restart');

  await beckon.handleEvent(mention('add project hush ~/x'));
  assert.match(lastText(slack), /Not added: there is already a project called `Hush`/);

  await beckon.handleEvent(mention('hush: say hi', { channel: 'CPROJ' }));
  await done();
  assert.equal(Object.values(beckon.state.threads).at(-1).project, 'Hush', 'prefixes ignore case');

  await beckon.handleEvent(mention('link other', { channel: 'CHUSH' }));
  assert.match(lastText(slack), /<#CHUSH> now go to \*other\*/);
  saved = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.deepEqual(saved.projects.Hush.channels, []);
  assert.deepEqual(saved.projects.other.channels, ['CHUSH']);

  await beckon.handleEvent(mention('default hush'));
  assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).defaultProject, 'Hush');

  await beckon.handleEvent(mention('projects'));
  assert.match(lastText(slack), /\*Hush\* \(default\)/);

  await beckon.handleEvent(mention('remove project hush'));
  assert.match(lastText(slack), /Removed project \*Hush\*.*no default project/);
  saved = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(saved.projects.Hush, undefined);
  assert.equal(saved.defaultProject, undefined);
  await close();
});

test('ordinary tasks that start like a command still go to Claude', async () => {
  const { beckon, slack, done, close } = await setup({ withFile: true });
  await beckon.handleEvent(mention('link the PR to the issue'));
  await beckon.handleEvent(mention('add a project page to the site'));
  await done();
  assert.ok(slack.texts().includes('echo: link the PR to the issue'));
  assert.ok(slack.texts().includes('echo: add a project page to the site'));
  await close();
});

test('an invalid edit is refused and the file is left alone', async () => {
  const { beckon, slack, configFile, close } = await setup({ withFile: true, config: { schedules: [{ name: 'daily', cron: '0 8 * * *', project: 'other', channel: 'CPROJ', prompt: 'x' }] } });
  const before = readFileSync(configFile, 'utf8');
  await beckon.handleEvent(mention('remove project other'));
  assert.match(lastText(slack), /used by the schedule "daily"/);
  assert.equal(readFileSync(configFile, 'utf8'), before);
  await close();
});

test('a reply in a thread whose project was removed says so', async () => {
  const { beckon, slack, done, close } = await setup({ withFile: true });
  const first = mention('other: hi');
  await beckon.handleEvent(first);
  await done();
  await beckon.handleEvent(mention('remove project other'));
  await beckon.handleEvent(msg({ text: 'and again', thread_ts: first.ts }));
  assert.match(lastText(slack), /no longer in beckon/);
  await close();
});

test('a secret goes from the phone into the field, and Claude only learns the outcome', async () => {
  const relay = { records: new Map(), handlers: {}, open(id, kind, meta) { this.records.set(id, meta); }, close() {} };
  const typed = [];
  const broker = new SecretBroker({
    relayUrl: 'https://relay.example.workers.dev',
    relay,
    passkeys: new PasskeyStore(join(tempDir(), 'passkeys.json')),
    readFocus: async () => ({ app: 'Google Chrome', bundleId: 'com.google.Chrome', role: 'AXTextField', subrole: 'AXSecureTextField', url: 'https://appleid.apple.com/' }),
    typeSecret: async ({ secret }) => { typed.push(Buffer.from(secret).toString()); },
  });
  const { beckon, slack, claudeRuns, done, close } = await setup({
    beckonOptions: { secrets: broker, secretScript: fileURLToPath(new URL('../bin/beckon-secret.mjs', import.meta.url)) },
  });

  // Without a passkey, Claude is told to stop and the thread says how to add one.
  await beckon.handleEvent(mention('SECRET'));
  await done();
  assert.match(slack.texts().find((t) => t?.startsWith('secret:')), /"status":"unavailable"/);
  assert.ok(slack.posts().some((p) => p.text === 'Passkey needed'));

  // `passkey` DMs an enrollment link; the phone registers.
  await beckon.handleEvent(msg({ channel: 'D1', channel_type: 'im', text: 'passkey' }));
  const enrollDm = slack.posts().find((p) => p.channel === 'U1' && p.text === 'Add a passkey for beckon');
  const enrollUrl = enrollDm.blocks[1].elements[0].url;
  const enrollId = new URL(enrollUrl).pathname.split('/')[2];
  const auth = makeAuthenticator();
  assert.equal((await relay.handlers.enrolled(enrollId, registration(auth, { challenge: relay.records.get(enrollId).challenge, origin: 'https://relay.example.workers.dev' }))).status, 'enrolled');

  await beckon.handleEvent(mention('SECRET again'));
  const dm = await waitFor(() => slack.posts().find((p) => p.channel === 'U1' && p.text?.startsWith('Enter Apple ID password')));
  const link = dm.blocks.find((b) => b.type === 'actions').elements.find((e) => e.action_id === 'beckon_secret_open').url;
  const notice = slack.posts().filter((p) => p.text?.startsWith('Secret needed')).at(-1);
  assert.ok(notice && !JSON.stringify(notice).includes(new URL(link).hash), 'the thread does not get the link');
  assert.match(claudeRuns().at(-1).argv[claudeRuns().at(-1).argv.indexOf('--append-system-prompt') + 1], /beckon-secret\.mjs/);

  const id = new URL(link).pathname.split('/')[2];
  const body = await submission({ url: link, meta: relay.records.get(id), secret: 's3cret', authenticator: auth });
  assert.equal((await relay.handlers.submit(id, body)).status, 'filled');
  await done();
  assert.deepEqual(typed, ['s3cret']);
  assert.match(slack.texts().filter((t) => t?.startsWith('secret:')).at(-1), /"status":"filled"/);
  assert.ok(!slack.calls.some((c) => JSON.stringify(c.body).includes('s3cret')), 'the value never reaches Slack');
  assert.ok(slack.find('chat.update').some((c) => /filled in/.test(JSON.stringify(c.body.blocks))));
  await close();
});

test('a value for a command reaches only that command, once, and Claude sees it masked', async () => {
  const relay = { records: new Map(), handlers: {}, open(id, kind, meta) { this.records.set(id, meta); }, close() {} };
  const logs = [];
  const broker = new SecretBroker({
    relayUrl: 'https://relay.example.workers.dev',
    relay,
    passkeys: new PasskeyStore(join(tempDir(), 'passkeys.json')),
    readFocus: async () => ({ error: 'no focus check for a command' }),
    typeSecret: async () => { throw new Error('nothing is typed for a command'); },
    log: (m) => logs.push(m),
  });
  const auth = makeAuthenticator();
  const enrollment = broker.createEnrollment('Thi (beckon)');
  await relay.handlers.enrolled(enrollment.id, registration(auth, { challenge: relay.records.get(enrollment.id).challenge, origin: 'https://relay.example.workers.dev' }));
  const { beckon, slack, done, close } = await setup({
    beckonOptions: { secrets: broker, secretScript: fileURLToPath(new URL('../bin/beckon-secret.mjs', import.meta.url)), log: (m) => logs.push(m) },
  });

  await beckon.handleEvent(mention('SECRETRUN'));
  const dm = await waitFor(() => slack.posts().find((p) => p.channel === 'U1' && p.text === 'Enter API key for beckon'));
  assert.match(JSON.stringify(dm.blocks), /as a temporary file/);
  assert.match(JSON.stringify(dm.blocks), /BECKON_SECRET_FILE/, 'the DM shows which command gets it');
  const link = dm.blocks.find((b) => b.type === 'actions').elements.find((e) => e.action_id === 'beckon_secret_open').url;
  const id = new URL(link).pathname.split('/')[2];
  const meta = relay.records.get(id);
  assert.equal(meta.run.via, 'file');

  const secret = '{"private_key":"sk-very-secret-9f8e7d"}';
  const body = await submission({ url: link, meta, secret, authenticator: auth });
  assert.equal((await relay.handlers.submit(id, body)).status, 'delivered');
  await done();
  const reply = slack.texts().filter((t) => t?.startsWith('secret:')).at(-1);
  const result = JSON.parse(reply.slice('secret: '.length));
  assert.equal(result.status, 'done');
  const [path, shown] = result.stdout.trim().split('\n');
  assert.equal(shown, '[secret]', 'Claude sees the output with the value masked');
  assert.ok(!existsSync(path), 'the temporary file is gone');
  assert.ok(!slack.calls.some((c) => JSON.stringify(c.body).includes('sk-very-secret')), 'the value never reaches Slack');
  assert.ok(!logs.join('\n').includes('sk-very-secret'), 'nor the log');
  assert.ok(slack.find('chat.update').some((c) => /handed to the command once/.test(JSON.stringify(c.body.blocks))));
  assert.equal((await relay.handlers.submit(id, body)).status, 'expired', 'the link works once');
  await close();
});

test('without secret handoff set up, Claude is told to ask for a manual sign-in', async () => {
  const { beckon, slack, done, close } = await setup();
  await beckon.handleEvent(mention('SECRET'));
  await done();
  assert.match(slack.texts().find((t) => t?.startsWith('secret:')), /"status":"unavailable"/);
  await close();
});

test('a watched channel investigates a matching bot alert in its thread, once per incident', async () => {
  const { beckon, slack, state, claudeRuns, done, close } = await setup({
    config: { watches: [{ name: 'alerts', channel: 'CALERT', project: 'proj', match: 'LỖI|:red_circle:', cooldownMinutes: 60 }] },
  });
  let now = Date.parse('2026-11-25T06:00:00Z');
  beckon.now = () => now;
  const alert = (text, extra) => ({ type: 'message', channel: 'CALERT', channel_type: 'channel', bot_id: 'BMON', username: 'Pickcourt Leads', ts: `1800000100.${String(++tsN).padStart(6, '0')}`, text, ...extra });

  // recoveries, other bots' chatter and our own posts start nothing
  await beckon.handleEvent(alert(':large_green_circle: Web pickcourt.com đã phục hồi'));
  await beckon.handleEvent(alert(':red_circle: LỖI', { bot_id: 'BBOT' }));
  assert.equal(Object.keys(state.threads).length, 0);

  const first = alert(':red_circle: Web <https://pickcourt.com|pickcourt.com> LỖI: 503 (bắt đầu thấy lúc 13:08)', { subtype: 'bot_message' });
  await beckon.handleEvent(first);
  await beckon.handleEvent(first); // Slack can deliver an event twice
  await done();
  const key = `CALERT:${first.ts}`;
  assert.equal(state.threads[key].project, 'proj');
  assert.ok(slack.find('reactions.add').some((c) => c.body.timestamp === first.ts && c.body.name === 'eyes'));
  const runs = claudeRuns();
  assert.equal(runs.length, 1);
  const echoed = slack.texts().find((t) => t?.startsWith('echo:'));
  assert.match(echoed, /Find out what went wrong/);
  assert.match(echoed, /<alert>\n:red_circle: Web pickcourt.com \(https:\/\/pickcourt.com\) LỖI: 503/);

  // the same outage flapping 40 minutes later links to the investigation
  now += 40 * 60_000;
  const again = alert(':red_circle: Web pickcourt.com LỖI: 503 (13:52)');
  await beckon.handleEvent(again);
  await done();
  assert.equal(claudeRuns().length, 1);
  assert.match(slack.posts().find((p) => p.thread_ts === again.ts).text, /Already looking into this alert in <https:\/\/test.slack.com\/archives\/CALERT\/p1800000100/);

  // quiet for longer than the cooldown: a new incident gets its own run
  now += 61 * 60_000;
  const later = alert(':red_circle: Web pickcourt.com LỖI: 500 (15:01)');
  await beckon.handleEvent(later);
  await done();
  assert.equal(claudeRuns().length, 2);
  assert.ok(state.threads[`CALERT:${later.ts}`]);

  // a reply in the alert thread from a listed member continues that session
  await beckon.handleEvent(msg({ channel: 'CALERT', thread_ts: first.ts, text: 'fix it' }));
  await done();
  assert.equal(claudeRuns().length, 3);
  await close();
});

test('a watch can be limited to some senders, and a mention in the channel is still a request', async () => {
  const { beckon, state, done, close } = await setup({
    config: { watches: [{ channel: 'CALERT', project: 'proj', match: 'error', from: ['Uptime Bot'] }] },
  });
  const ts = () => `1800000200.${String(++tsN).padStart(6, '0')}`;
  await beckon.handleEvent({ type: 'message', channel: 'CALERT', bot_id: 'BX', username: 'Someone else', text: 'error everywhere', ts: ts() });
  assert.equal(Object.keys(state.threads).length, 0);
  const hit = { type: 'message', channel: 'CALERT', bot_id: 'BUP', bot_profile: { name: 'Uptime Bot' }, text: '', attachments: [{ fallback: 'API error rate 12%' }], ts: ts() };
  await beckon.handleEvent(hit);
  assert.ok(state.threads[`CALERT:${hit.ts}`]);
  await beckon.handleEvent(msg({ channel: 'CALERT', type: 'app_mention', text: '<@UBOT> proj: why the error?' }));
  await done();
  assert.equal(Object.keys(state.threads).length, 2);
  await close();
});

test('a project agent takes tasks by name, by channel or by default, and a thread can be handed on', async () => {
  const { beckon, slack, state, claudeRuns, done, close } = await setup({
    config: {
      projects: {
        proj: {
          path: '/tmp',
          channels: ['#proj', 'CDESIGN'],
          agents: {
            dev: { agent: 'senior-dev', skills: '.claude/roles/dev', description: 'builds it' },
            qa: { skills: ['.claude/roles/qa', '/nowhere/skills'] },
            designer: { channels: ['CDESIGN'], model: 'opus' },
          },
          defaultAgent: 'dev',
        },
        other: { path: '/tmp', channels: [] },
      },
    },
  });
  // the worktrees exist only once a run starts; make the qa skills folder in them on creation
  const origEnsure = beckon.ensureWorktree;
  beckon.ensureWorktree = async (o) => {
    const r = await origEnsure(o);
    mkdirSync(join(o.dir, '.claude/roles/qa'), { recursive: true });
    return r;
  };
  const named = mention('QA: check the booking flow');
  await beckon.handleEvent(named);
  await done();
  let run = claudeRuns().at(-1);
  assert.equal(run.argv[run.argv.indexOf('--agent') + 1], 'qa');
  const dirs = run.argv.flatMap((a, i) => (a === '--plugin-dir' ? [run.argv[i + 1]] : []));
  assert.equal(dirs.length, 1, 'a skills folder that is not there is left out');
  assert.ok(dirs[0].endsWith(join('.claude', 'roles', 'qa')) && dirs[0].includes(join('wt', 'proj')));
  assert.ok(slack.texts().includes('echo: check the booking flow'), 'the name is not part of the task');
  assert.ok(slack.posts().some((p) => p.username === 'QA'), 'the agent posts under its own name');
  assert.ok(!slack.posts().some((p) => p.blocks?.some((b) => b.type === 'context' && /agent/.test(b.elements?.[0]?.text ?? ''))), 'no extra agent line once the name shows');
  const prompt = run.argv[run.argv.indexOf('--append-system-prompt') + 1];
  assert.match(prompt, /project's \*qa\* agent/);
  assert.match(prompt, /other agents work in the same Slack channel: @dev \(builds it\), @designer/);

  // a reply that names another agent hands the thread over, same session
  await beckon.handleEvent(msg({ text: 'dev: fix what QA found', thread_ts: named.ts }));
  await done();
  run = claudeRuns().at(-1);
  assert.equal(run.argv[run.argv.indexOf('--agent') + 1], 'senior-dev');
  assert.ok(run.argv.includes('--resume'));
  assert.equal(state.threads[`CPROJ:${named.ts}`].agent, 'dev');
  assert.ok(slack.texts().includes('echo: fix what QA found'));

  // no name: the project's default agent; in #design, the designer
  await beckon.handleEvent(mention('just do it'));
  await done();
  run = claudeRuns().at(-1);
  assert.equal(run.argv[run.argv.indexOf('--agent') + 1], 'senior-dev');
  await beckon.handleEvent(mention('make it pretty', { channel: 'CDESIGN' }));
  await done();
  run = claudeRuns().at(-1);
  assert.equal(run.argv[run.argv.indexOf('--agent') + 1], 'designer');
  assert.equal(run.argv[run.argv.indexOf('--model') + 1], 'opus');

  // a project without agents runs plain Claude Code
  await beckon.handleEvent(mention('other: hello'));
  await done();
  run = claudeRuns().at(-1);
  assert.ok(!run.argv.includes('--agent'));
  await close();
});

test('agents are tagged with @name, post under their own name, and hand a thread on at most maxHandoffs times in a row', async () => {
  const { beckon, slack, state, claudeRuns, done, close } = await setup({
    config: {
      projects: { proj: { path: '/tmp', channels: ['#proj'], agents: { dev: {}, qa: { icon: ':test_tube:' } } } },
      maxHandoffs: 3,
    },
  });
  try {
    // a plain message in the channel that tags an agent is a task; one that tags nobody is not
    await beckon.handleEvent(msg({ text: 'just chatting' }));
    const tagged = msg({ text: '@qa check the login page' });
    await beckon.handleEvent(tagged);
    await done();
    assert.equal(claudeRuns().length, 1);
    assert.equal(state.threads[`CPROJ:${tagged.ts}`].agent, 'qa');
    assert.ok(slack.texts().includes('echo: check the login page'));
    const answer = slack.posts().find((p) => p.text === 'echo: check the login page');
    assert.equal(answer.username, 'QA');
    assert.equal(answer.icon_emoji, ':test_tube:');

    // dev and qa tag each other: three hand-overs, then beckon stops and says so
    const ping = msg({ text: '@dev PINGPONG' });
    await beckon.handleEvent(ping);
    await waitFor(() => slack.posts().some((p) => /Not handing this to \*dev\*/.test(p.text)));
    await done();
    const agents = claudeRuns().slice(1).map((r) => r.argv[r.argv.indexOf('--agent') + 1]);
    assert.deepEqual(agents, ['dev', 'qa', 'dev', 'qa']);
    const t = state.threads[`CPROJ:${ping.ts}`];
    assert.equal(t.handoffs, 3);
    const handed = claudeRuns()[2];
    assert.match(handed.argv[handed.argv.indexOf('--append-system-prompt') + 1], /from the project's dev agent, which handed this thread to you/);
    assert.ok(slack.posts().some((p) => p.username === 'DEV' && p.text === 'done by dev'));

    // a person's reply starts the count again
    await beckon.handleEvent(msg({ text: 'thanks, carry on', thread_ts: ping.ts }));
    await done();
    assert.equal(t.handoffs, 0);
  } finally {
    await close();
  }
});

test('agents with their own Slack apps: a mention of the app is a task for it, it posts through its app, and hand-overs mention it for real', async () => {
  const { beckon, slack, state, claudeRuns, done, close } = await setup({
    config: {
      projects: { proj: { path: '/tmp', channels: ['#proj'], agents: { pm: { slackApp: 'main' }, qa: { slackApp: 'QA' }, dev: { slackApp: 'be' } }, defaultAgent: 'pm' } },
      maxHandoffs: 1,
    },
  });
  try {
    const qaSlack = new FakeSlack({ userId: 'UQA', botId: 'BQA', user: 'beckon-qa' });
    const beSlack = new FakeSlack({ userId: 'UBE', botId: 'BBE', user: 'beckon-be' });
    await beckon.addApp('QA', qaSlack);
    await beckon.addApp('BE', beSlack);

    // the same message arrives through every app's connection; it runs once, as qa, through QA's app
    const ask = msg({ text: '<@UQA> check the login page' });
    await beckon.handleEvent(ask, 'BE');
    await beckon.handleEvent({ ...ask, type: 'app_mention' }, 'QA');
    await beckon.handleEvent(ask);
    await done();
    assert.equal(claudeRuns().length, 1);
    assert.equal(state.threads[`CPROJ:${ask.ts}`].agent, 'qa');
    const qaPosts = qaSlack.posts();
    assert.ok(qaPosts.some((p) => p.text === 'echo: check the login page'));
    assert.ok(qaPosts.every((p) => !p.username), 'an agent with its own app posts as itself, no custom name');
    assert.ok(!slack.posts().some((p) => p.text === 'echo: check the login page'));
    assert.ok(qaSlack.find('chat.delete').length >= 1, 'its own progress message is removed through its app');

    // beckon's own app is the pm, as itself
    const plan = mention('plan the next sprint');
    await beckon.handleEvent(plan);
    await done();
    assert.equal(state.threads[`CPROJ:${plan.ts}`].agent, 'pm');
    const pmAnswer = slack.posts().find((p) => p.text === 'echo: plan the next sprint');
    assert.ok(pmAnswer && !pmAnswer.username);

    // dev hands to qa: the tag in its answer becomes a real mention of QA's app
    const ping = msg({ text: '<@UBE> PINGPONG' });
    await beckon.handleEvent(ping);
    await waitFor(() => slack.posts().some((p) => /Not handing this to \*dev\*/.test(p.text)));
    await done();
    const devAnswer = beSlack.posts().find((p) => /done by dev/.test(JSON.stringify(p.blocks)));
    assert.match(JSON.stringify(devAnswer.blocks), /<@UQA> PINGPONG/);
    assert.ok(qaSlack.posts().some((p) => p.text === 'done by qa'));

    // a DM to QA's app is answered by QA, in that DM
    await beckon.handleEvent({ type: 'message', channel: 'DQA1', channel_type: 'im', user: 'U1', ts: '1800000099.000001', text: 'hello qa' }, 'QA');
    await done();
    assert.equal(state.threads['DQA1:1800000099.000001'].agent, 'qa');
    assert.ok(qaSlack.posts().some((p) => p.channel === 'DQA1' && p.text === 'echo: hello qa'));
  } finally {
    await close();
  }
});

test('a lead agent plans, its team works through the tasks one after another, and the lead reports back', async () => {
  const { beckon, slack, state, claudeRuns, done, close } = await setup({
    config: {
      projects: { proj: { path: '/tmp', channels: ['#proj'], agents: { pm: {}, dev: {}, qa: {} }, defaultAgent: 'pm', lead: 'pm' } },
      maxHandoffs: 5,
    },
  });
  try {
    const ask = mention('TEAMPLAN ship the booking page');
    await beckon.handleEvent(ask);
    await waitFor(() => slack.posts().some((p) => /All done, checked/.test(p.text)));
    await done();
    const runs = claudeRuns();
    assert.deepEqual(runs.map((r) => r.argv[r.argv.indexOf('--agent') + 1]), ['pm', 'dev', 'qa', 'pm']);
    assert.ok(slack.texts().includes('echo: build it\nwith care'), 'a task keeps the lines under its tag');
    assert.ok(slack.texts().includes('echo: check it'));
    const devPrompt = runs[1].argv[runs[1].argv.indexOf('--append-system-prompt') + 1];
    assert.match(devPrompt, /team led by @pm, which gave you this task/);
    const leadPrompt = runs[0].argv[runs[0].argv.indexOf('--append-system-prompt') + 1];
    assert.match(leadPrompt, /You lead this project's team: dev \(subagent_type "dev"\), qa/);
    const report = slack.posts().find((p) => /All done, checked/.test(p.text));
    assert.match(report.text, /^<@U1> All done/, 'the report mentions the person who asked');
    const t = state.threads[`CPROJ:${ask.ts}`];
    assert.equal(t.handoffs, 3);
    assert.equal(t.leadRun, false);
    assert.deepEqual(t.queue, []);

    // a person's direct task to a member ends with that member: the lead does not take over
    const direct = mention('qa: look at the login page');
    await beckon.handleEvent(direct);
    await done();
    assert.equal(claudeRuns().length, 5);
    assert.equal(state.threads[`CPROJ:${direct.ts}`].agent, 'qa');
  } finally {
    await close();
  }
});

test('a lead\'s team stops after maxHandoffs agent turns without a person', async () => {
  const { beckon, slack, claudeRuns, done, close } = await setup({
    config: {
      projects: { proj: { path: '/tmp', channels: ['#proj'], agents: { pm: {}, dev: {}, qa: {} }, defaultAgent: 'pm', lead: 'pm' } },
      maxHandoffs: 2,
    },
  });
  try {
    await beckon.handleEvent(mention('TEAMPLAN ship it'));
    await waitFor(() => slack.posts().some((p) => /Stopped passing work on: 2 agent turns/.test(p.text)));
    await done();
    assert.deepEqual(claudeRuns().map((r) => r.argv[r.argv.indexOf('--agent') + 1]), ['pm', 'dev', 'qa']);
  } finally {
    await close();
  }
});

test('the lead runs its team as subagents: each member posts under its own app, the lead loads their skills and reports', async () => {
  const skills = { pm: tempDir(), dev: tempDir(), qa: tempDir() };
  const { beckon, slack, claudeRuns, done, close } = await setup({
    config: {
      projects: {
        proj: {
          path: '/tmp',
          channels: ['#proj'],
          agents: { pm: { slackApp: 'main', skills: skills.pm }, dev: { agent: 'senior-dev', slackApp: 'BE', skills: skills.dev }, qa: { slackApp: 'QA', skills: [skills.qa, skills.pm] } },
          defaultAgent: 'pm',
          lead: 'pm',
        },
      },
    },
  });
  try {
    const qaSlack = new FakeSlack({ userId: 'UQA', botId: 'BQA' });
    const beSlack = new FakeSlack({ userId: 'UBE', botId: 'BBE' });
    await beckon.addApp('QA', qaSlack);
    await beckon.addApp('BE', beSlack);

    await beckon.handleEvent(mention('SUBAGENTS ship the booking page'));
    await done();
    assert.equal(claudeRuns().length, 1, 'one session: the team ran inside it');
    const run = claudeRuns()[0];
    const prompt = run.argv[run.argv.indexOf('--append-system-prompt') + 1];
    assert.match(prompt, /dev \(subagent_type "senior-dev"\)/);
    const dirs = run.argv.flatMap((a, i) => (a === '--plugin-dir' ? [run.argv[i + 1]] : []));
    assert.deepEqual(dirs, [skills.pm, skills.dev, skills.qa], 'the lead loads every member skill folder, once each');
    assert.match(prompt, /in the same message, so they run at the same time/);

    // each member: a "working on" message under its app, then replaced by its last words
    const beStart = beSlack.posts().find((p) => p.text === 'Build the page…');
    assert.ok(beStart, 'dev posts through its own app when it starts');
    const beDone = beSlack.find('chat.update').map((c) => c.body).find((b) => /Built the page in PR #7/.test(JSON.stringify(b.blocks)));
    assert.ok(beDone, 'dev\'s report replaces its working message');
    assert.match(JSON.stringify(beDone.blocks), /<@UQA> to check it/, 'its @qa is a real mention');
    assert.ok(!JSON.stringify(beDone.blocks).includes('Working on it'), 'only its last words');
    const qaDone = qaSlack.find('chat.update').map((c) => c.body).find((b) => /Checked: 3 of 3 pass/.test(JSON.stringify(b.blocks)));
    assert.ok(qaDone, 'a foreground member posts the report from the Agent tool result');
    assert.ok(/login ok/.test(JSON.stringify(qaDone.blocks)) && !/agentId|usage|hand-back/.test(JSON.stringify(qaDone.blocks)), 'only the report, without the frame');
    assert.ok(!slack.posts().some((p) => /Look around/.test(p.text)), 'a subagent that is not a project agent gets no message');

    const report = slack.posts().find((p) => /Team done/.test(p.text));
    assert.match(report.text, /^<@U1> Team done/, 'the lead\'s report mentions the person who asked');
  } finally {
    await close();
  }
});
