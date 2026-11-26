import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeArgs, hookSettings, childEnv, runClaude } from '../src/claude.mjs';
import { FAKE_CLAUDE } from './helpers.mjs';

test('first turn names the session, later turns resume it', () => {
  const settings = hookSettings({ nodePath: '/n o/node', hookScript: '/x/hook.mjs', timeoutSeconds: 3660 });
  const first = claudeArgs({ sessionId: 'S', resume: false, model: 'opus', permissionMode: 'acceptEdits', settings, appendPrompt: 'P', name: 'beckon: t' });
  assert.deepEqual(first.slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose']);
  for (const [flag, value] of [['--session-id', 'S'], ['--name', 'beckon: t'], ['--model', 'opus'], ['--permission-mode', 'acceptEdits'], ['--disallowedTools', 'AskUserQuestion'], ['--append-system-prompt', 'P']]) {
    assert.equal(first[first.indexOf(flag) + 1], value, flag);
  }
  const hooks = JSON.parse(first[first.indexOf('--settings') + 1]).hooks;
  assert.equal(hooks.PreToolUse[0].hooks[0].command, '"/n o/node" "/x/hook.mjs" pre');
  assert.equal(hooks.PermissionRequest[0].hooks[0].timeout, 3660);
  assert.equal(hooks.Stop[0].hooks[0].command, '"/n o/node" "/x/hook.mjs" stop');
  const withMcp = claudeArgs({ sessionId: 'S', resume: true, settings, mcpConfig: '/x/mcp.json' });
  assert.equal(withMcp[withMcp.indexOf('--mcp-config') + 1], '/x/mcp.json');
  assert.ok(!first.includes('--mcp-config'));
  const next = claudeArgs({ sessionId: 'S', resume: true, settings });
  assert.equal(next[next.indexOf('--resume') + 1], 'S');
  assert.ok(!next.includes('--session-id') && !next.includes('--name'));
});

test('keeps the subscription in use unless told otherwise', () => {
  const base = { ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDECODE: '1', PATH: '/bin' };
  assert.deepEqual(childEnv(base, { X: '1' }), { PATH: '/bin', X: '1' });
  assert.equal(childEnv(base, {}, { allowApiKey: true }).ANTHROPIC_API_KEY, 'k');
});

test('streams events and returns the result', async () => {
  const events = [];
  const res = await runClaude({ bin: FAKE_CLAUDE, args: ['--session-id', 'abc'], cwd: process.cwd(), env: process.env, prompt: 'hi', onEvent: (e) => events.push(e.type) });
  assert.equal(res.text, 'echo: hi');
  assert.equal(res.isError, false);
  assert.equal(res.sessionId, 'abc');
  assert.equal(res.apiKeySource, 'none');
  assert.deepEqual(events, ['system', 'assistant', 'result']);
});

test('reports a missing binary as an error instead of throwing', async () => {
  const res = await runClaude({ bin: '/nonexistent/claude', args: [], cwd: process.cwd(), env: process.env, prompt: 'x' });
  assert.equal(res.isError, true);
  assert.match(res.spawnError, /ENOENT/);
});

test('an agent run names the agent and loads each skills folder as a plugin', () => {
  const args = claudeArgs({ sessionId: 's', agent: 'qa', pluginDirs: ['/w/.claude/roles/qa', '/x'] });
  assert.equal(args[args.indexOf('--agent') + 1], 'qa');
  assert.deepEqual(args.flatMap((a, i) => (a === '--plugin-dir' ? [args[i + 1]] : [])), ['/w/.claude/roles/qa', '/x']);
  assert.ok(!claudeArgs({ sessionId: 's' }).includes('--agent'));
});
