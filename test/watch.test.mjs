import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { watchConfig } from '../src/start.mjs';
import { tempDir, waitFor } from './helpers.mjs';

test('a changed config file is applied; a broken one is ignored', async () => {
  const file = join(tempDir(), 'config.json');
  const good = (path) => JSON.stringify({ users: ['U1'], projects: { app: { path } } });
  writeFileSync(file, good('/a'));
  const applied = [];
  const beckon = { configText: good('/a'), applyConfig: async (c, text) => { applied.push(c); beckon.configText = text; } };
  const watcher = watchConfig(file, beckon, { debounceMs: 50 });

  writeFileSync(file, '{ not json');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(applied.length, 0);

  writeFileSync(file, good('/b'));
  await waitFor(() => applied.length === 1);
  assert.equal(applied[0].projects.app.path, '/b');

  writeFileSync(file, good('/b'));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(applied.length, 1, 'unchanged text is not applied again');
  watcher.close();
});
