import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Progress } from './progress.mjs';
import { slackToPlain, chunkMarkdown, oneLine, duration } from './text.mjs';
import { matchRule, inputText } from './policy.mjs';
import { claudeArgs, hookSettings, runClaude as defaultRunClaude, childEnv } from './claude.mjs';
import { ensureWorktree as defaultEnsureWorktree, removeWorktree as defaultRemoveWorktree } from './worktree.mjs';
import { parseCron, cronMatches, minuteKey } from './cron.mjs';

const REFRESH_MS = 2000;
const TICK_MS = 15_000;
const GC_MS = 6 * 60 * 60 * 1000;
const STOP_WORDS = /^(stop|cancel|abort)[.!]*$/i;
const PROJECT_PREFIX = /^([a-z0-9][a-z0-9._-]*):\s*/i;

function escapeMrkdwn(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function section(text) {
  return { type: 'section', text: { type: 'mrkdwn', text: text.length > 2900 ? text.slice(0, 2899) + '…' : text } };
}

function button(text, actionId, value, style) {
  const b = { type: 'button', text: { type: 'plain_text', text }, action_id: actionId, value };
  if (style) b.style = style;
  return b;
}

export function defaultRunSetup(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (c) => { out = (out + c).slice(-3000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), 15 * 60 * 1000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: out }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: e.message }); });
  });
}

export class Beckon {
  constructor({
    config,
    slack,
    state,
    worktreesDir,
    nodePath = process.execPath,
    hookScript,
    env = process.env,
    log = () => {},
    runClaude = defaultRunClaude,
    ensureWorktree = defaultEnsureWorktree,
    removeWorktree = defaultRemoveWorktree,
    runSetup = defaultRunSetup,
    now = () => Date.now(),
  }) {
    Object.assign(this, { config, slack, state, worktreesDir, nodePath, hookScript, env, log, runClaude, ensureWorktree, removeWorktree, runSetup, now });
    this.hook = null;
    this.botUserId = null;
    this.teamUrl = null;
    this.channelProjects = new Map();
    this.channelIds = new Map();
    this.running = new Map();
    this.pending = new Map();
    this.waiting = [];
    this.approvals = new Map();
    this.seen = new Set();
    this.timers = [];
    this.crons = [];
    this.warnedApiKey = false;
    this.draining = false;
  }

  async start({ hook, background = true } = {}) {
    this.hook = hook;
    const auth = await this.slack.call('auth.test');
    this.botUserId = auth.user_id;
    this.teamUrl = auth.url ?? null;
    await this.resolveChannels();
    for (const s of this.config.schedules) {
      try {
        this.crons.push({ ...s, parsed: parseCron(s.cron) });
      } catch (e) {
        this.log(`Schedule "${s.name}" is skipped: ${e.message}`);
      }
    }
    if (background) {
      this.timers.push(setInterval(() => this.tick().catch((e) => this.log(`Schedule check failed: ${e.message}`)), TICK_MS));
      this.timers.push(setInterval(() => this.gc().catch((e) => this.log(`Cleanup failed: ${e.message}`)), GC_MS));
      this.gc().catch((e) => this.log(`Cleanup failed: ${e.message}`));
    }
    this.log(`Connected to Slack as <@${this.botUserId}>; projects: ${Object.keys(this.config.projects).join(', ')}`);
  }

  // Stop taking new work, let running turns finish (approvals still work), then stop whatever
  // is left. Used when the service is restarted, so a restart does not cut a deploy in half.
  async shutdownGracefully(graceMs) {
    this.draining = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.waiting = [];
    this.pending.clear();
    const runs = [...this.running.entries()];
    if (runs.length && graceMs > 0) {
      this.log(`Waiting up to ${duration(graceMs)} for ${runs.length} running task(s) before stopping`);
      for (const [key] of runs) {
        const t = this.state.threads[key];
        await this.post(t.channel, t.threadTs, `beckon is restarting. It will let this run finish (up to ${duration(graceMs)}) before it stops.`).catch(() => {});
      }
      let timer;
      await Promise.race([
        Promise.allSettled(runs.map(([, r]) => r.done)),
        new Promise((r) => { timer = setTimeout(r, graceMs); timer.unref?.(); }),
      ]);
      clearTimeout(timer);
    }
    await this.stopAll();
  }

  async stopAll() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const [key, run] of this.running) {
      run.stoppedBy = 'shutdown';
      run.abort.abort();
      this.denyApprovals(key, 'beckon is shutting down.');
    }
    const waits = [...this.running.values()].map((r) => r.done);
    await Promise.allSettled(waits);
    this.state.save();
  }

  async resolveChannels() {
    const wanted = new Set();
    for (const p of Object.values(this.config.projects)) for (const c of p.channels) wanted.add(c);
    for (const s of this.config.schedules) wanted.add(s.channel);
    const names = [...wanted].filter((c) => c.startsWith('#'));
    const byName = new Map();
    if (names.length) {
      let cursor;
      do {
        const page = await this.slack.call('conversations.list', {
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 1000,
          cursor,
        });
        for (const ch of page.channels ?? []) byName.set(`#${ch.name}`, ch.id);
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
    }
    for (const c of wanted) {
      const id = c.startsWith('#') ? byName.get(c) : c;
      if (!id) {
        this.log(`Channel ${c} was not found. For a private channel, invite beckon to it first.`);
        continue;
      }
      this.channelIds.set(c, id);
    }
    for (const p of Object.values(this.config.projects)) {
      for (const c of p.channels) {
        const id = this.channelIds.get(c);
        if (id) this.channelProjects.set(id, p.name);
      }
    }
  }

  allowed(user) {
    return this.config.users.includes(user);
  }

  threadLink(channel, threadTs) {
    if (!this.teamUrl) return null;
    return `${this.teamUrl.replace(/\/?$/, '/')}archives/${channel}/p${threadTs.replace('.', '')}`;
  }

  async post(channel, threadTs, text, blocks) {
    const body = { channel, text, unfurl_links: false, unfurl_media: false };
    if (threadTs) body.thread_ts = threadTs;
    if (blocks) body.blocks = blocks;
    return this.slack.call('chat.postMessage', body);
  }

  async postMarkdown(channel, threadTs, markdown) {
    for (const piece of chunkMarkdown(markdown)) {
      await this.post(channel, threadTs, oneLine(piece, 300), [{ type: 'markdown', text: piece }]);
    }
  }

  async react(channel, ts, name) {
    try {
      await this.slack.call('reactions.add', { channel, timestamp: ts, name });
    } catch {
      /* reactions are a courtesy */
    }
  }

  // ---- incoming Slack events ----

  async handleEvent(ev) {
    if (ev.type !== 'app_mention' && ev.type !== 'message') return;
    if (ev.bot_id || !ev.user || ev.user === this.botUserId) return;
    if (ev.subtype && ev.subtype !== 'file_share' && ev.subtype !== 'thread_broadcast') return;
    const seenKey = `${ev.channel}:${ev.ts}`;
    if (this.seen.has(seenKey)) return;
    this.seen.add(seenKey);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value);

    const mentioned = ev.type === 'app_mention' || String(ev.text ?? '').includes(`<@${this.botUserId}>`);
    const isDM = ev.channel_type === 'im' || String(ev.channel).startsWith('D');
    const key = ev.thread_ts ? `${ev.channel}:${ev.thread_ts}` : null;
    const known = key && this.state.threads[key];
    if (!mentioned && !isDM && !known) return;
    if (!this.allowed(ev.user)) {
      this.log(`Ignored a message from ${ev.user}, who is not in "users"`);
      return;
    }

    const text = slackToPlain(ev.text, this.botUserId);
    if (this.draining) {
      if (!(known && STOP_WORDS.test(text))) {
        await this.post(ev.channel, ev.thread_ts ?? ev.ts, 'beckon is restarting. Send this again in a minute.').catch(() => {});
        return;
      }
    }
    if (known) {
      if (STOP_WORDS.test(text)) return this.stop(key, ev.user);
      if (!text) return;
      await this.react(ev.channel, ev.ts, 'eyes');
      return this.enqueue(key, { text, user: ev.user });
    }

    const replyTs = ev.thread_ts ?? ev.ts;
    if (/^(status)$/i.test(text)) return this.postStatus(ev.channel, replyTs);
    if (!text || /^(help|\?)$/i.test(text)) return this.postHelp(ev.channel, replyTs);

    let projectName = null;
    let body = text;
    const prefix = text.match(PROJECT_PREFIX);
    if (prefix && this.config.projects[prefix[1]]) {
      projectName = prefix[1];
      body = text.slice(prefix[0].length);
    } else {
      projectName = this.channelProjects.get(ev.channel) ?? (isDM ? this.config.defaultProject : null);
    }
    if (!projectName) {
      const names = Object.keys(this.config.projects).map((n) => `\`${n}\``).join(', ');
      await this.post(ev.channel, replyTs, `This channel is not linked to a project. Start your message with the project name, like \`${Object.keys(this.config.projects)[0]}: ...\`. Projects: ${names}.`);
      return;
    }

    let prompt = body;
    if (ev.thread_ts) {
      const context = await this.threadContext(ev.channel, ev.thread_ts, ev.ts);
      if (context) prompt = `${context}\n\n${body}`;
    }
    await this.react(ev.channel, ev.ts, 'eyes');
    return this.startThread({ channel: ev.channel, threadTs: replyTs, project: projectName, text: prompt, title: body, user: ev.user });
  }

  async threadContext(channel, threadTs, beforeTs) {
    try {
      const res = await this.slack.call('conversations.replies', { channel, ts: threadTs, limit: 50 });
      const lines = [];
      for (const m of res.messages ?? []) {
        if (Number(m.ts) >= Number(beforeTs)) break;
        const who = m.user ? `<@${m.user}>` : (m.username ?? 'a bot');
        lines.push(`${who}: ${slackToPlain(m.text, this.botUserId).slice(0, 1500)}`);
      }
      if (!lines.length) return '';
      let joined = lines.join('\n');
      if (joined.length > 12000) joined = '…' + joined.slice(-12000);
      return `Earlier messages in this Slack thread, oldest first:\n${joined}\n\nThe request:`;
    } catch (e) {
      this.log(`Could not read the thread for context: ${e.message}`);
      return '';
    }
  }

  async postHelp(channel, threadTs) {
    const projects = Object.values(this.config.projects)
      .map((p) => `\`${p.name}\`${p.channels.length ? ` (${p.channels.join(', ')})` : ''}`)
      .join(', ');
    await this.postMarkdown(channel, threadTs, [
      '**beckon** runs Claude Code on its host machine for you.',
      '',
      `- Mention me with a task in a project's channel, or DM me. Start with \`project:\` to pick another project. Projects: ${projects}.`,
      '- Each task gets its own thread and its own git worktree. Reply in the thread to continue.',
      '- Reply `stop` in a thread to stop it. Mention me with `status` to see what is running.',
      '- Risky actions (deploys, pushes to main, merges, migrations, publishing) wait for an approval button.',
    ].join('\n'));
  }

  async postStatus(channel, threadTs) {
    const lines = [];
    for (const [key, run] of this.running) {
      const t = this.state.threads[key];
      const link = this.threadLink(t.channel, t.threadTs);
      const title = link ? `[${t.title}](${link})` : t.title;
      lines.push(`- **${t.project}**: ${title} (${run.status === 'waiting' ? 'waiting for approval' : 'working'}, ${duration(this.now() - run.progress.startedAt)})`);
    }
    for (const key of this.waiting) {
      const t = this.state.threads[key];
      lines.push(`- **${t.project}**: ${t.title} (queued)`);
    }
    await this.postMarkdown(channel, threadTs, lines.length ? lines.join('\n') : 'Nothing is running.');
  }

  // ---- threads and turns ----

  startThread({ channel, threadTs, project, text, title, user }) {
    const key = `${channel}:${threadTs}`;
    const t = {
      project,
      channel,
      threadTs,
      sessionId: randomUUID(),
      started: false,
      worktree: join(this.worktreesDir, project, threadTs.replace('.', '-')),
      createdAt: this.now(),
      lastActive: this.now(),
      createdBy: user,
      title: oneLine(title ?? text, 60),
      allowAll: false,
    };
    this.state.threads[key] = t;
    this.state.save();
    return this.enqueue(key, { text, user });
  }

  enqueue(key, msg) {
    const list = this.pending.get(key) ?? [];
    list.push(msg);
    this.pending.set(key, list);
    if (this.running.has(key)) {
      const t = this.state.threads[key];
      return this.post(t.channel, t.threadTs, 'Got it. I will read this when the current step finishes.').catch(() => {});
    }
    return this.schedule(key);
  }

  schedule(key) {
    if (this.running.has(key) || this.waiting.includes(key)) return;
    if (this.running.size >= this.config.maxParallel) {
      this.waiting.push(key);
      const t = this.state.threads[key];
      return this.post(t.channel, t.threadTs, `Queued: ${this.running.size} tasks are already running. I will start when one finishes.`).catch(() => {});
    }
    this.runTurn(key).catch((e) => this.log(`Turn in ${key} failed: ${e.stack ?? e.message}`));
  }

  drain() {
    while (this.waiting.length && this.running.size < this.config.maxParallel) {
      const key = this.waiting.shift();
      if (this.pending.get(key)?.length) this.runTurn(key).catch((e) => this.log(`Turn in ${key} failed: ${e.stack ?? e.message}`));
    }
  }

  systemPrompt(t, project, user, ref) {
    const lines = [
      `You are working through beckon: this request came from Slack${user && user !== 'schedule' ? `, from <@${user}>` : ' on a schedule'}, and your final message is posted back to the Slack thread as markdown.`,
      '- Keep the final message short: what you did, links to what you opened (pull requests, deploys), and anything that needs a decision.',
      '- Nobody can answer questions during a run. If you need a decision, end the turn and ask; the answer arrives as the next message.',
      `- You are in a git worktree of the "${project.name}" repository (${project.path})${ref ? `, started from ${ref} on a detached HEAD` : ''}. Create a branch before committing, following the repository's own conventions.`,
      '- Deploys, pushes to main branches, merges, migrations, publishing and similar actions are sent to the user for approval in Slack. If one is denied, do not reach the same result another way.',
    ];
    if (project.instructions) lines.push('', project.instructions);
    return lines.join('\n');
  }

  async runTurn(key) {
    const t = this.state.threads[key];
    const project = this.config.projects[t.project];
    const msgs = this.pending.get(key) ?? [];
    this.pending.delete(key);
    if (!msgs.length || !project) return;

    let finish;
    const run = {
      abort: new AbortController(),
      progress: new Progress({ cwd: t.worktree, startedAt: this.now() }),
      progressTs: null,
      status: 'working',
      stoppedBy: null,
      lastUpdate: 0,
      refreshTimer: null,
      ticker: null,
      done: new Promise((r) => { finish = r; }),
    };
    this.running.set(key, run);

    try {
      const first = await this.post(t.channel, t.threadTs, 'Working…', this.progressBlocks(key, run));
      run.progressTs = first.ts;
      run.ticker = setInterval(() => this.refresh(key), 30_000);
      run.ticker.unref?.();

      let ref = t.ref ?? null;
      try {
        const wt = await this.ensureWorktree({ repo: project.path, dir: t.worktree, baseBranch: project.baseBranch });
        if (wt.created) {
          ref = wt.ref;
          t.ref = wt.ref;
          t.worktreeRemoved = false;
          if (project.setup) {
            const setup = await this.runSetup(project.setup, t.worktree);
            if (!setup.ok) {
              await this.postMarkdown(t.channel, t.threadTs, `The setup command \`${project.setup}\` failed; continuing anyway.\n\`\`\`\n${setup.output.slice(-1500)}\n\`\`\``);
            }
          }
        }
      } catch (e) {
        run.status = 'failed';
        await this.postMarkdown(t.channel, t.threadTs, `Could not prepare a worktree of \`${project.path}\`:\n\`\`\`\n${e.message.slice(0, 2000)}\n\`\`\``);
        return;
      }

      const prompt = msgs.map((m) => m.text).join('\n\n');
      let res = await this.turn(key, t, project, prompt, msgs[0].user, ref, run);
      if (res.isError && t.started && /No conversation found/i.test(`${res.text}\n${res.stderr}`)) {
        t.sessionId = randomUUID();
        t.started = false;
        res = await this.turn(key, t, project, prompt, msgs[0].user, ref, run);
      }

      run.status = res.aborted ? 'stopped' : res.isError ? 'failed' : 'done';
      if (res.apiKeySource && res.apiKeySource !== 'none' && !this.warnedApiKey) {
        this.warnedApiKey = true;
        await this.post(t.channel, t.threadTs, `Note: this run used ${res.apiKeySource} instead of your Claude subscription login.`).catch(() => {});
      }
      if (res.aborted) {
        const who = run.stoppedBy && run.stoppedBy !== 'shutdown' ? ` by <@${run.stoppedBy}>` : run.stoppedBy === 'shutdown' ? ' because beckon shut down' : '';
        await this.post(t.channel, t.threadTs, `Stopped${who}. Reply in this thread to continue from here.`);
      } else if (res.text) {
        await this.postMarkdown(t.channel, t.threadTs, res.text);
      } else if (res.isError) {
        const detail = (res.spawnError ?? res.stderr ?? '').trim() || `claude exited with code ${res.exitCode}`;
        await this.postMarkdown(t.channel, t.threadTs, `Claude stopped with an error:\n\`\`\`\n${detail.slice(-2000)}\n\`\`\``);
      }
    } catch (e) {
      run.status = 'failed';
      this.log(`Turn in ${key} failed: ${e.stack ?? e.message}`);
      await this.post(t.channel, t.threadTs, `Something went wrong in beckon: ${e.message}`).catch(() => {});
    } finally {
      clearInterval(run.ticker);
      clearTimeout(run.refreshTimer);
      this.denyApprovals(key, 'The run ended.');
      if (run.progressTs) await this.updateProgress(key, run, true).catch(() => {});
      this.running.delete(key);
      t.lastActive = this.now();
      this.state.save();
      finish();
      if (this.pending.get(key)?.length) this.schedule(key);
      this.drain();
    }
  }

  async turn(key, t, project, prompt, user, ref, run) {
    const settings = hookSettings({
      nodePath: this.nodePath,
      hookScript: this.hookScript,
      timeoutSeconds: this.config.approvalTimeoutMinutes * 60 + 60,
    });
    const args = claudeArgs({
      sessionId: t.sessionId,
      resume: t.started,
      model: project.model,
      permissionMode: project.permissionMode,
      settings,
      appendPrompt: this.systemPrompt(t, project, user, ref),
      name: `beckon: ${t.title}`,
    });
    const env = childEnv(this.env, {
      BECKON_HOOK_URL: this.hook?.url ?? '',
      BECKON_HOOK_TOKEN: this.hook?.token ?? '',
      BECKON_THREAD: key,
    }, { allowApiKey: this.config.allowApiKey });
    const res = await this.runClaude({
      bin: this.config.claudePath,
      args,
      cwd: t.worktree,
      env,
      prompt,
      signal: run.abort.signal,
      onEvent: (e) => {
        if (run.progress.push(e)) this.refresh(key);
      },
    });
    if (res.sessionId) t.started = true;
    this.state.save();
    return res;
  }

  progressBlocks(key, run) {
    const status = run.status;
    const text = run.progress.render(this.now(), status)
      .split('\n')
      .map((line, i) => (i === 0 ? line : escapeMrkdwn(line)))
      .join('\n');
    const blocks = [section(text)];
    if (status === 'working' || status === 'waiting') {
      blocks.push({ type: 'actions', elements: [button('Stop', 'beckon_stop', key, 'danger')] });
    }
    return blocks;
  }

  refresh(key) {
    const run = this.running.get(key);
    if (!run?.progressTs) return;
    const wait = run.lastUpdate + REFRESH_MS - this.now();
    if (wait > 0) {
      if (!run.refreshTimer) {
        run.refreshTimer = setTimeout(() => {
          run.refreshTimer = null;
          this.refresh(key);
        }, wait);
        run.refreshTimer.unref?.();
      }
      return;
    }
    this.updateProgress(key, run).catch((e) => this.log(`Progress update failed: ${e.message}`));
  }

  async updateProgress(key, run) {
    const t = this.state.threads[key];
    run.lastUpdate = this.now();
    await this.slack.call('chat.update', {
      channel: t.channel,
      ts: run.progressTs,
      text: oneLine(run.progress.render(this.now(), run.status), 200),
      blocks: this.progressBlocks(key, run),
    });
  }

  stop(key, user) {
    const run = this.running.get(key);
    const t = this.state.threads[key];
    if (run) {
      run.stoppedBy = user;
      run.abort.abort();
      this.denyApprovals(key, 'The user stopped this run.');
      return;
    }
    if (this.pending.get(key)?.length) {
      this.pending.delete(key);
      this.waiting = this.waiting.filter((k) => k !== key);
      return this.post(t.channel, t.threadTs, 'Dropped the queued message.').catch(() => {});
    }
    if (t) return this.post(t.channel, t.threadTs, 'Nothing is running in this thread.').catch(() => {});
  }

  // ---- approvals ----

  async onHook({ kind, thread: key, payload }) {
    const t = this.state.threads[key];
    const run = this.running.get(key);
    if (!t || !run) return { decision: 'deny', message: 'This beckon thread is not running.' };
    const project = this.config.projects[t.project];
    const tool = payload?.tool_name ?? 'unknown tool';
    const input = payload?.tool_input ?? {};
    if (kind === 'pre') {
      const rule = matchRule(tool, input, project?.alwaysAsk ?? []);
      if (!rule) return { decision: 'none' };
      return this.ask(key, t, run, tool, input, rule.label, false);
    }
    if (kind === 'permission') {
      if (t.allowAll) return { decision: 'allow' };
      return this.ask(key, t, run, tool, input, 'needs your permission', true);
    }
    return { decision: 'deny', message: `Unknown hook kind ${kind}` };
  }

  async ask(key, t, run, tool, input, label, offerAllowAll) {
    const id = randomUUID();
    const text = inputText(tool, input);
    const shown = text.length > 2400 ? text.slice(0, 2400) + '\n…' : text;
    const mentions = this.config.users.map((u) => `<@${u}>`).join(' ');
    const what = tool === 'Bash' ? `\`\`\`${escapeMrkdwn(shown)}\`\`\`` : `*${escapeMrkdwn(tool)}*\n\`\`\`${escapeMrkdwn(shown)}\`\`\``;
    const body = `:raised_hand: ${mentions} approval needed: ${escapeMrkdwn(label)}\n${what}`;
    const buttons = [button('Allow', 'beckon_allow', id, 'primary')];
    if (offerAllowAll) buttons.push(button('Allow everything in this thread', 'beckon_allow_all', id));
    buttons.push(button('Deny', 'beckon_deny', id, 'danger'));

    const posted = await this.post(t.channel, t.threadTs, `Approval needed: ${label}`, [section(body), { type: 'actions', elements: buttons }]);
    run.status = 'waiting';
    this.refresh(key);

    return new Promise((resolve) => {
      const minutes = this.config.approvalTimeoutMinutes;
      const timer = setTimeout(() => this.settleApproval(id, 'deny', null, { timedOut: true }), minutes * 60_000);
      timer.unref?.();
      this.approvals.set(id, { resolve, key, channel: t.channel, ts: posted.ts, body, timer, label });
    });
  }

  async settleApproval(id, decision, user, { allowAll = false, timedOut = false, reason = null } = {}) {
    const a = this.approvals.get(id);
    if (!a) return false;
    this.approvals.delete(id);
    clearTimeout(a.timer);
    const t = this.state.threads[a.key];
    if (allowAll && t) {
      t.allowAll = true;
      this.state.save();
    }
    const run = this.running.get(a.key);
    if (run && run.status === 'waiting' && ![...this.approvals.values()].some((x) => x.key === a.key)) {
      run.status = 'working';
      this.refresh(a.key);
    }
    let note;
    if (timedOut) note = `:hourglass: No answer in ${this.config.approvalTimeoutMinutes} minutes, so it was denied.`;
    else if (reason) note = `:no_entry_sign: Denied: ${reason}`;
    else if (decision === 'allow') note = `:white_check_mark: Allowed${allowAll ? ' (and everything else in this thread)' : ''} by <@${user}>`;
    else note = `:no_entry_sign: Denied by <@${user}>`;
    this.slack.call('chat.update', {
      channel: a.channel,
      ts: a.ts,
      text: note,
      blocks: [section(a.body), { type: 'context', elements: [{ type: 'mrkdwn', text: note }] }],
    }).catch((e) => this.log(`Could not update the approval message: ${e.message}`));

    if (decision === 'allow') {
      a.resolve({ decision: 'allow', message: `Approved in Slack by ${user}.` });
    } else {
      const why = timedOut ? 'Nobody answered the approval request in Slack in time.' : reason ?? 'The user denied this in Slack.';
      a.resolve({ decision: 'deny', message: `${why} Do not reach the same result another way; say what you needed and stop.` });
    }
    return true;
  }

  denyApprovals(key, reason) {
    for (const [id, a] of this.approvals) if (a.key === key) this.settleApproval(id, 'deny', null, { reason });
  }

  async handleInteractive(payload) {
    if (payload?.type !== 'block_actions') return;
    const action = payload.actions?.[0];
    const user = payload.user?.id;
    if (!action) return;
    if (!this.allowed(user)) {
      const channel = payload.channel?.id;
      if (channel) {
        await this.slack.call('chat.postEphemeral', { channel, user, text: 'Only the people listed in beckon\'s config can do that.' }).catch(() => {});
      }
      return;
    }
    switch (action.action_id) {
      case 'beckon_stop':
        return this.stop(action.value, user);
      case 'beckon_allow':
        return this.settleApproval(action.value, 'allow', user);
      case 'beckon_allow_all':
        return this.settleApproval(action.value, 'allow', user, { allowAll: true });
      case 'beckon_deny':
        return this.settleApproval(action.value, 'deny', user);
      default:
    }
  }

  // ---- schedules and cleanup ----

  async tick(date = new Date(this.now())) {
    for (const s of this.crons) {
      if (!cronMatches(s.parsed, date, s.timezone)) continue;
      const mk = minuteKey(date, s.timezone);
      if (this.state.schedules[s.name] === mk) continue;
      this.state.schedules[s.name] = mk;
      this.state.save();
      const channel = this.channelIds.get(s.channel) ?? (s.channel.startsWith('#') ? null : s.channel);
      if (!channel) {
        this.log(`Schedule "${s.name}": channel ${s.channel} was not found`);
        continue;
      }
      const posted = await this.post(channel, null, `:alarm_clock: ${s.name}`);
      await this.startThread({ channel: posted.channel ?? channel, threadTs: posted.ts, project: s.project, text: s.prompt, title: s.name, user: 'schedule' });
    }
  }

  async gc() {
    const cutoff = this.now() - this.config.keepDays * 86_400_000;
    for (const [key, t] of Object.entries(this.state.threads)) {
      if (this.running.has(key) || t.worktreeRemoved || t.lastActive > cutoff) continue;
      const project = this.config.projects[t.project];
      if (!project) continue;
      const res = await this.removeWorktree({ repo: project.path, dir: t.worktree });
      if (res.removed) {
        t.worktreeRemoved = true;
        delete t.ref;
        this.log(`Removed the idle worktree ${t.worktree}`);
      } else {
        this.log(`Kept the idle worktree ${t.worktree}: ${res.reason}`);
      }
    }
    this.state.save();
  }
}
