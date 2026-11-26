#!/usr/bin/env node
// Stands in for the claude CLI in tests. It prints stream-json like the real one and runs the
// hooks it was given with --settings, so the approval path is exercised end to end.
//   RUN:<command>   try a Bash command through the PreToolUse hook
//   PERM:<command>  try a Bash command that needs permission (PermissionRequest hook)
//   SLOW            finish after 0.7 seconds
//   SLEEP           wait until killed
//   TABS            open a browser tab, then close it only when the Stop hook asks
//   SECRET          ask beckon for a password with bin/beckon-secret.mjs and report the result
//   SECRETRUN       ask beckon for a value for a command (--file --run) and report its output
//   TEAMPLAN        as pm: assign dev and qa; once they have finished, report
//   PINGPONG        answer as the --agent, then tag the other of dev and qa with PINGPONG
//   anything else   reply "echo: <prompt>"
import { execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

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

let prompt = '';
for await (const c of process.stdin) prompt += c;
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
  const lead = me === 'pm' && /have finished/.test(prompt) ? 'All done, checked.' : me === 'pm' && /TEAMPLAN/.test(prompt) ? 'Plan:\n@dev build it\nwith care\n\n@qa check it' : null;
  const result = lead ?? (/PINGPONG/.test(prompt) ? `done by ${me}\n@${me === 'qa' ? 'dev' : 'qa'} PINGPONG` : `echo: ${prompt.trim()}`);
  emit({ type: 'result', subtype: 'success', is_error: false, result, num_turns: 1 });
}
