import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { git, ensureWorktree, removeWorktree } from '../src/worktree.mjs';
import { tempDir } from './helpers.mjs';

async function makeRepo() {
  const root = tempDir();
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  await git(['init', '--bare', '-b', 'main', origin]);
  await git(['clone', origin, repo]);
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T']]) await git(['config', k, v], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'one');
  await git(['add', '.'], { cwd: repo });
  await git(['commit', '-m', 'one'], { cwd: repo });
  await git(['push', 'origin', 'main'], { cwd: repo });
  return { root, repo };
}

test('creates a worktree from the remote base branch and keeps work that would be lost', async () => {
  const { root, repo } = await makeRepo();
  const dir = join(root, 'wt', 'one');
  const made = await ensureWorktree({ repo, dir, baseBranch: null });
  assert.deepEqual(made, { created: true, ref: 'origin/main' });
  assert.ok(existsSync(join(dir, 'a.txt')));
  assert.equal((await ensureWorktree({ repo, dir, baseBranch: null })).created, false);

  writeFileSync(join(dir, 'b.txt'), 'new');
  assert.deepEqual(await removeWorktree({ repo, dir }), { removed: false, reason: 'uncommitted changes' });
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T']]) await git(['config', k, v], { cwd: dir });
  await git(['add', '.'], { cwd: dir });
  await git(['commit', '-m', 'two'], { cwd: dir });
  assert.deepEqual(await removeWorktree({ repo, dir }), { removed: false, reason: '1 commit(s) not on any branch' });

  await git(['switch', '-c', 'feature'], { cwd: dir });
  assert.deepEqual(await removeWorktree({ repo, dir }), { removed: true });
  assert.ok(!existsSync(dir));
  assert.equal(await git(['rev-parse', '--verify', '--quiet', 'feature'], { cwd: repo }) !== '', true);
});
