import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hookOutput, runHook } from '../src/hook.mjs';
import { startHookServer } from '../src/hookserver.mjs';

test('formats PreToolUse and PermissionRequest answers', () => {
  assert.equal(hookOutput('pre', { decision: 'none' }), '');
  assert.equal(JSON.parse(hookOutput('pre', { decision: 'allow' })).hookSpecificOutput.permissionDecision, 'allow');
  const deny = JSON.parse(hookOutput('pre', { decision: 'deny', message: 'no' })).hookSpecificOutput;
  assert.deepEqual(deny, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' });
  assert.deepEqual(JSON.parse(hookOutput('permission', { decision: 'allow' })).hookSpecificOutput.decision, { behavior: 'allow' });
  assert.equal(JSON.parse(hookOutput('permission', { decision: 'none' })).hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(hookOutput('stop', { decision: 'none' }), '');
  assert.deepEqual(JSON.parse(hookOutput('stop', { decision: 'block', message: 'close tabs' })), { decision: 'block', reason: 'close tabs' });
});

test('an unreachable daemon lets the run finish instead of blocking Stop', async () => {
  const env = { BECKON_HOOK_URL: 'http://127.0.0.1:9/', BECKON_HOOK_TOKEN: 't', BECKON_THREAD: 'C1:1.2' };
  assert.equal(await runHook('stop', '{}', env), '');
});

test('waits for slow answers instead of timing out', async () => {
  const server = await startHookServer(() => new Promise((r) => setTimeout(() => r({ decision: 'allow' }), 1500)));
  const env = { BECKON_HOOK_URL: server.url, BECKON_HOOK_TOKEN: server.token, BECKON_THREAD: 'C1:1.2' };
  const out = JSON.parse(await runHook('pre', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'x' } }), env));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  await server.close();
});

test('does nothing outside beckon', async () => {
  assert.equal(await runHook('pre', '{}', {}), '');
});

test('asks the daemon and fails closed when it is gone', async () => {
  const seen = [];
  const server = await startHookServer(async (body) => {
    seen.push(body);
    return { decision: 'allow' };
  });
  const env = { BECKON_HOOK_URL: server.url, BECKON_HOOK_TOKEN: server.token, BECKON_THREAD: 'C1:1.2' };
  const out = JSON.parse(await runHook('permission', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }), env));
  assert.equal(out.hookSpecificOutput.decision.behavior, 'allow');
  assert.deepEqual(seen[0], { kind: 'permission', thread: 'C1:1.2', payload: { tool_name: 'Bash', tool_input: { command: 'ls' } } });

  const wrongToken = await runHook('pre', '{}', { ...env, BECKON_HOOK_TOKEN: 'x' });
  assert.equal(JSON.parse(wrongToken).hookSpecificOutput.permissionDecision, 'deny');

  await server.close();
  const gone = JSON.parse(await runHook('pre', '{}', env));
  assert.equal(gone.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(gone.hookSpecificOutput.permissionDecisionReason, /not reachable/);
});
