#!/usr/bin/env node
// Stands in for the claude CLI in tests. It prints stream-json like the real one and runs the
// hooks it was given with --settings, so the approval path is exercised end to end.
//   RUN:<command>   try a Bash command through the PreToolUse hook
//   PERM:<command>  try a Bash command that needs permission (PermissionRequest hook)
//   BACKGROUND      end a turn with a background task running, then answer the next input
//   LIVE            wait up to 3 seconds for a message on the input, then say what it heard
//   SLOW            finish after 0.7 seconds
//   SLEEP           wait until killed
//   TABS            open a browser tab, then close it only when the Stop hook asks
//   SECRET          ask beckon for a password with bin/beckon-secret.mjs and report the result
//   ATTACH:<file>   send a file to the thread with bin/beckon-attach.mjs and report the result
//   SECRETRUN       ask beckon for a value for a command (--file --run) and report its output
//   SUBAGENTS       as the lead: start dev and qa as subagents, then report
//   TEAMPLAN        as pm: assign dev and qa; once they have finished, report
//   PINGPONG        answer as the --agent, then tag the other of dev and qa with PINGPONG
//   anything else   reply "echo: <prompt>"
import { execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sessionId = opt('--session-id') ?? opt('--resume');
const settings = JSON.parse(opt('--settings') ?? '{}');
if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, cwd: process.cwd(), apiKey: process.env.ANTHROPIC_API_KEY ?? null }) + '\n');
}

// Input is stream-json: one user message per line, later ones while the run works.
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const textOf = (line) => {
  try {
    return JSON.parse(line).message.content.map((c) => c.text ?? '').join('');
  } catch {
    return line;
  }
};
const firstLine = await lines.next();
const prompt = firstLine.done ? '' : textOf(firstLine.value);
const emit = (e) => process.stdout.write(JSON.stringify({ ...e, session_id: sessionId }) + '\n');

if (process.env.FAKE_CLAUDE_MISSING_SESSION && opt('--resume')) {
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `No conversation found with session ID: ${sessionId}` });
  process.exit(1);
}

emit({ type: 'system', subtype: 'init', model: 'fake', apiKeySource: 'none', cwd: process.cwd() });

function runHook(event, payload) {
  const entry = settings.hooks?.[event]?.[0]?.hooks?.[0];
  if (!entry) return null;
  const out = execSync(entry.command, { input: JSON.stringify({ hook_event_name: event, ...payload }), encoding: 'utf8', shell: '/bin/sh' });
  return out.trim() ? JSON.parse(out) : null;
}

const run = prompt.match(/RUN:(.+)/);
const perm = prompt.match(/PERM:(.+)/);
if (run || perm) {
  const command = (run ?? perm)[1].trim();
  const input = { command };
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input }] } });
  let verdict = 'ran';
  let reason = '';
  const pre = runHook('PreToolUse', { tool_name: 'Bash', tool_input: input });
  const preDecision = pre?.hookSpecificOutput?.permissionDecision;
  if (preDecision === 'deny') {
    verdict = 'denied';
    reason = pre.hookSpecificOutput.permissionDecisionReason;
  } else if (preDecision !== 'allow' && perm) {
    const p = runHook('PermissionRequest', { tool_name: 'Bash', tool_input: input, permission_suggestions: [] });
    const d = p?.hookSpecificOutput?.decision;
    if (d?.behavior !== 'allow') {
      verdict = 'denied';
      reason = d?.message ?? 'no answer';
    }
  }
  emit({ type: 'result', subtype: 'success', is_error: false, result: verdict === 'ran' ? `ran ${command}` : `denied: ${reason}`, num_turns: 2 });
} else if (prompt.includes('ATTACH:')) {
  const { spawnSync } = await import('node:child_process');
  const script = new URL('../../bin/beckon-attach.mjs', import.meta.url).pathname;
  const file = prompt.split('ATTACH:')[1].trim().split(/\s+/)[0];
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a1', name: 'Bash', input: { command: `node ${script} ${file}` } }] } });
  const r = spawnSync(process.execPath, [script, file, '--title', 'Test run'], { encoding: 'utf8', env: process.env });
  emit({ type: 'result', subtype: 'success', is_error: false, result: `attach: ${r.stdout.trim()}`, num_turns: 2 });
} else if (prompt.includes('SECRETRUN')) {
  const { spawnSync } = await import('node:child_process');
  const script = new URL('../../bin/beckon-secret.mjs', import.meta.url).pathname;
  const command = 'echo "$BECKON_SECRET_FILE"; cat "$BECKON_SECRET_FILE"';
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 's1', name: 'Bash', input: { command: `node ${script} --label "API key" --file --run '${command}'` } }] } });
  const r = spawnSync(process.execPath, [script, '--label', 'API key', '--kind', 'multiline', '--file', '--run', command], { encoding: 'utf8', env: process.env });
  emit({ type: 'result', subtype: 'success', is_error: false, result: `secret: ${r.stdout.trim()}`, num_turns: 2 });
} else if (prompt.includes('SECRET')) {
  const { spawnSync } = await import('node:child_process');
  const script = new URL('../../bin/beckon-secret.mjs', import.meta.url).pathname;
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 's1', name: 'Bash', input: { command: `node ${script} --label "Apple ID password"` } }] } });
  const r = spawnSync(process.execPath, [script, '--label', 'Apple ID password', '--kind', 'password', '--app', 'Google Chrome', '--domain', 'apple.com'], { encoding: 'utf8', env: process.env });
  emit({ type: 'result', subtype: 'success', is_error: false, result: `secret: ${r.stdout.trim()}`, num_turns: 2 });
} else if (prompt.includes('TABS')) {
  const tool = (id, name, input, text) => {
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
  };
  tool('t1', 'mcp__claude-in-chrome__tabs_context_mcp', { createIfEmpty: true }, '{"availableTabs":[{"tabId":111,"title":"New Tab","url":"chrome://newtab/"}],"tabGroupId":9}');
  const reminders = [];
  for (let i = 0; i < 3; i++) {
    const stop = runHook('Stop', { stop_hook_active: i > 0 });
    if (stop?.decision !== 'block') break;
    reminders.push(stop.reason);
    if (prompt.includes('STUBBORN')) continue;
    tool(`c${i}`, 'mcp__claude-in-chrome__tabs_close_mcp', { tabId: 111 }, 'Closed tab 111. Group is now empty (auto-removed).');
  }
  emit({ type: 'result', subtype: 'success', is_error: false, result: `reminded ${reminders.length}: ${reminders.join(' | ')}`, num_turns: 2 });
} else if (prompt.includes('BACKGROUND')) {
  // ends a turn while a subagent still works, takes a message, then ends for good
  emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1' }] });
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'started', num_turns: 1 });
  const next = await lines.next();
  emit({ type: 'result', subtype: 'success', is_error: false, result: next.done ? 'input closed early' : `later: ${textOf(next.value)}`, num_turns: 1 });
  await new Promise((r) => setTimeout(r, 400));
  emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'all done', num_turns: 1 });
} else if (prompt.includes('LIVE')) {
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 1' } }] } });
  const next = await Promise.race([lines.next(), new Promise((r) => setTimeout(() => r({ done: true }), 3000))]);
  emit({ type: 'result', subtype: 'success', is_error: false, result: next.done ? 'heard nothing' : `heard: ${textOf(next.value)}`, num_turns: 2 });
} else if (prompt.includes('SLOW')) {
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 1' } }] } });
  await new Promise((r) => setTimeout(r, 700));
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'slow done', num_turns: 2 });
} else if (prompt.includes('SLEEP')) {
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 100' } }] } });
  setInterval(() => {}, 1000);
} else {
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
  const me = opt('--agent');
  if (/SUBAGENTS/.test(prompt)) {
    // the lead starts two project agents as subagents, which run in the background and report
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Plan: dev builds and qa checks together, they touch different files.' }] } });
    emit({ type: 'system', subtype: 'task_started', tool_use_id: 'tu-dev', subagent_type: 'senior-dev', description: 'Build the page' });
    emit({ type: 'system', subtype: 'task_started', tool_use_id: 'tu-qa', subagent_type: 'qa', description: 'Check the page', is_backgrounded: false });
    emit({ type: 'system', subtype: 'task_started', tool_use_id: 'tu-x', subagent_type: 'Explore', description: 'Look around' });
    emit({ type: 'assistant', parent_tool_use_id: 'tu-dev', message: { content: [{ type: 'text', text: 'Working on it' }] } });
    // dev: its last words are only in its own transcript, the notification's output_file
    const devLog = `${process.env.TMPDIR || '/tmp'}/fake-dev-${process.pid}.jsonl`;
    appendFileSync(devLog, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Let me check the routes.' }] } }) + '\n' + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: 'Built the page in PR #7.\nAsk @qa to check it.' } }] } }) + '\n' + '{"type":"user"');
    emit({ type: 'system', subtype: 'task_notification', tool_use_id: 'tu-dev', status: 'completed', output_file: devLog });
    // designer, in the background: its report comes as a message from its session
    emit({ type: 'system', subtype: 'task_started', tool_use_id: 'tu-ui', task_id: 'task-ui', subagent_type: 'designer', description: 'Review the page', is_backgrounded: true });
    emit({ type: 'user', message: { role: 'user', content: 'Another Claude session sent a message:\n<agent-message from="task-ui">\n[Subagent hand-back] Model output. The report follows:\n  Design matches the system.\nagentId: task-ui\n</agent-message>' } });
    emit({ type: 'system', subtype: 'task_notification', tool_use_id: 'tu-ui', status: 'completed' });
    emit({ type: 'system', subtype: 'task_notification', tool_use_id: 'tu-qa', status: 'completed' });
    // qa ran in the foreground: its report is the Agent tool result, framed and indented
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-qa', content: [{ type: 'text', text: '[Subagent hand-back] The text below is the final report. The report follows:\n  Checked: 3 of 3 pass.\n\n  - login ok\nagentId: abc\n<usage>subagent_tokens: 1</usage>' }] }] } });
  }
  const lead = /SUBAGENTS/.test(prompt) ? 'Team done: page built and checked.' : me === 'pm' && /have finished/.test(prompt) ? 'All done, checked.' : me === 'pm' && /TEAMPLAN/.test(prompt) ? 'Plan:\n@dev build it\nwith care\n\n@qa check it' : null;
  const result = lead ?? (/PINGPONG/.test(prompt) ? `done by ${me}\n@${me === 'qa' ? 'dev' : 'qa'} PINGPONG` : `echo: ${prompt.trim()}`);
  emit({ type: 'result', subtype: 'success', is_error: false, result, num_turns: 1 });
  // with background subagents a run can end with an empty result after the real one
  if (/SUBAGENTS/.test(prompt)) emit({ type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 0 });
}
