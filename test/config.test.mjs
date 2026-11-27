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

test('watches need a channel, a known project and a valid match', () => {
  const { errors, config } = validateConfig({
    users: ['U1'],
    projects: { a: { path: '/a' } },
    watches: [{ channel: '#alerts', project: 'a', match: 'LỖI' }, { channel: '#x', project: 'nope', match: '(' , cooldownMinutes: -1 }],
  });
  for (const needle of ['watches[1].project', 'watches[1].match', 'watches[1].cooldownMinutes']) assert.ok(errors.some((e) => e.includes(needle)), needle);
  assert.equal(errors.length, 3);
  assert.deepEqual(config.watches[0], { name: '#alerts alerts', channel: '#alerts', project: 'a', match: 'LỖI', from: null, prompt: null, cooldownMinutes: 60, agent: null });
});

test('project agents: names, skills folders, channels of the project, and references from schedules and watches', () => {
  const { errors, config } = validateConfig({
    users: ['U1'],
    projects: {
      a: {
        path: '/a',
        channels: ['#a', '#design'],
        agents: {
          pm: { skills: '~/skills/pm', description: 'plans' },
          dev: { agent: 'senior-dev' },
          Dev: {},
          'bad name': {},
          qa: { skills: [1], channels: ['#elsewhere'], permissionMode: 'yolo' },
          designer: { channels: ['#design'] },
        },
        defaultAgent: 'nobody',
      },
    },
    schedules: [{ cron: '0 8 * * *', project: 'a', channel: '#a', prompt: 'report', agent: 'pm' }],
    watches: [{ channel: '#a', project: 'a', match: 'x', agent: 'ghost' }],
  });
  for (const needle of ['agents.Dev: "dev" already', 'agents.bad name', 'agents.qa.skills', 'agents.qa.channels: #elsewhere', 'agents.qa.permissionMode', 'defaultAgent: "nobody"', 'watches[0].agent: "ghost"']) {
    assert.ok(errors.some((e) => e.includes(needle)), `${needle} in ${JSON.stringify(errors)}`);
  }
  assert.equal(errors.length, 7);
  const a = config.projects.a.agents;
  assert.equal(a.pm.skills[0], join(homedir(), 'skills/pm'));
  assert.equal(a.dev.agent, 'senior-dev');
  assert.equal(a.designer.agent, 'designer');
  assert.deepEqual(a.designer.channels, ['#design']);
  assert.equal(config.schedules[0].agent, 'pm');
  assert.equal(config.projects.a.defaultAgent, null);
});

test('an agent can be defined in the config with a prompt; an old slackApp is ignored', () => {
  const { errors, config } = validateConfig({
    users: ['U1'],
    projects: { a: { path: '/a', agents: { qa: { description: 'Tests', prompt: 'You test.' }, pm: { slackApp: 'main' }, x: { prompt: 5 } } } },
  });
  assert.deepEqual(errors.length, 1);
  assert.match(errors[0], /agents\.x\.prompt/);
  assert.equal(config.projects.a.agents.qa.prompt, 'You test.');
  assert.equal(config.projects.a.agents.pm.prompt, null);
  assert.equal(config.projects.a.agents.pm.slackApp, undefined);
});

test('a project lead must be one of its agents', () => {
  const ok = validateConfig({ users: ['U1'], projects: { a: { path: '/a', agents: { pm: {}, qa: {} }, lead: 'pm' } } });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.config.projects.a.lead, 'pm');
  const bad = validateConfig({ users: ['U1'], projects: { a: { path: '/a', agents: { qa: {} }, lead: 'pm' } } });
  assert.match(bad.errors.join(' '), /a\.lead: "pm" is not one of this project's agents/);
});
