import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, parseEnvFile } from '../src/config.mjs';
import { CONFIG_TEMPLATE } from '../src/setup.mjs';

test('the init template is valid', () => {
  const { errors, config } = validateConfig(CONFIG_TEMPLATE);
  assert.deepEqual(errors, []);
  assert.equal(config.projects.myapp.path, join(homedir(), 'code/myapp'));
  assert.equal(config.defaultProject, 'myapp');
  assert.equal(config.projects.myapp.permissionMode, 'acceptEdits');
});

test('reports each problem with where it is', () => {
  const { errors } = validateConfig({
    users: ['alice'],
    projects: {
      a: { path: 'relative', channels: ['#x'], permissionMode: 'yolo', alwaysAsk: ['('] },
      b: { path: '/abs', channels: ['#x'] },
    },
    defaultProject: 'zzz',
    schedules: [{ cron: '0 8 * * *', project: 'nope', channel: '#x', prompt: 'p', timezone: 'Mars/Base' }],
    maxParallel: 0,
  });
  const text = errors.join('\n');
  for (const needle of ['not a Slack member ID', 'projects.a.path', 'permissionMode', 'alwaysAsk[0]', '#x is already linked', 'defaultProject', 'schedules[0].project', 'Mars/Base', 'maxParallel']) {
    assert.ok(text.includes(needle), `missing: ${needle}\n${text}`);
  }
});

test('alwaysAsk accepts strings and objects', () => {
  const { config, errors } = validateConfig({
    users: ['U1'],
    projects: { a: { path: '/a', alwaysAsk: ['playwright', { tool: '^Write$', match: 'migrations/', label: 'migration' }] } },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(config.projects.a.alwaysAsk, [
    { tool: '^Bash$', match: 'playwright', label: 'project rule' },
    { tool: '^Write$', match: 'migrations/', label: 'migration' },
  ]);
});

test('reads env files', () => {
  assert.deepEqual(parseEnvFile('# c\nA=1\nexport B="two words"\nC=\'x=y\'\n bad line\n'), { A: '1', B: 'two words', C: 'x=y' });
});
