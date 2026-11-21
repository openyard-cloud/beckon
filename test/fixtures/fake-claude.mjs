#!/usr/bin/env node
// Stands in for the claude CLI in tests. It prints stream-json like the real one and runs the
// hooks it was given with --settings, so the approval path is exercised end to end.
//   RUN:<command>   try a Bash command through the PreToolUse hook
//   PERM:<command>  try a Bash command that needs permission (PermissionRequest hook)
//   SLOW            finish after 0.7 seconds
//   SLEEP           wait until killed
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
} else if (prompt.includes('SLOW')) {
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 1' } }] } });
  await new Promise((r) => setTimeout(r, 700));
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'slow done', num_turns: 2 });
} else if (prompt.includes('SLEEP')) {
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 100' } }] } });
  setInterval(() => {}, 1000);
} else {
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: `echo: ${prompt.trim()}`, num_turns: 1 });
}
