import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addProject, removeProject, linkChannel, unlinkChannel, setDefault, findName, writeRaw } from '../src/projects.mjs';
import { validateConfig } from '../src/config.mjs';
import { tempDir } from './helpers.mjs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const base = () => ({ users: ['U1'], projects: { app: { path: '/a', channels: ['C1'] } } });

test('finds projects whatever the case', () => {
  assert.equal(findName({ PickCourt: {} }, 'pickcourt'), 'PickCourt');
  assert.equal(findName({ a: {} }, 'b'), null);
});

test('adds a project unless the name or a channel is taken', () => {
  const raw = base();
  assert.equal(addProject(raw, { name: 'web', path: '/w', channels: ['C2'] }), null);
  assert.deepEqual(raw.projects.web, { path: '/w', channels: ['C2'] });
  assert.match(addProject(raw, { name: 'WEB', path: '/x' }), /already a project called `web`/);
  assert.match(addProject(raw, { name: 'x', path: '/x', channels: ['C1'] }), /already linked to `app`/);
  assert.match(addProject(raw, { name: 'bad name', path: '/x' }), /cannot be a project name/);
});

test('links move a channel; unlink and default', () => {
  const raw = base();
  addProject(raw, { name: 'web', path: '/w' });
  assert.equal(linkChannel(raw, 'C1', 'WEB'), null);
  assert.deepEqual(raw.projects.app.channels, []);
  assert.deepEqual(raw.projects.web.channels, ['C1']);
  assert.equal(unlinkChannel(raw, 'C1'), null);
  assert.match(unlinkChannel(raw, 'C1'), /not linked/);
  assert.equal(setDefault(raw, 'Web'), null);
  assert.equal(raw.defaultProject, 'web');
});

test('removing keeps at least one project and schedules intact', () => {
  const raw = base();
  assert.match(removeProject(raw, 'app'), /only project/);
  addProject(raw, { name: 'web', path: '/w' });
  raw.schedules = [{ name: 'daily', project: 'web' }];
  assert.match(removeProject(raw, 'web'), /schedule "daily"/);
  raw.schedules = [];
  raw.defaultProject = 'web';
  assert.equal(removeProject(raw, 'web'), null);
  assert.equal(raw.defaultProject, undefined);
});

test('writes only valid configs', () => {
  const file = join(tempDir(), 'config.json');
  assert.ok(writeRaw(file, { users: ['U1'], projects: {} }).errors.length);
  const ok = writeRaw(file, base());
  assert.equal(ok.config.projects.app.path, '/a');
  assert.equal(readFileSync(file, 'utf8'), ok.text);
});

test('project names must differ by more than case', () => {
  const { errors } = validateConfig({ users: ['U1'], projects: { app: { path: '/a' }, App: { path: '/b' } } });
  assert.ok(errors.some((e) => /names ignore case/.test(e)));
});
