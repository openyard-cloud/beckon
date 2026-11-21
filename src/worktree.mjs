import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function git(args, { cwd, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`git ${args.join(' ')}: ${(stderr || err.message).trim()}`);
        e.stderr = stderr;
        reject(e);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

async function tryGit(args, opts) {
  try {
    return await git(args, opts);
  } catch {
    return null;
  }
}

// Which commit a new worktree starts from: the remote's copy of the base branch when there is
// a remote (fetched first, so work starts from what is really on GitHub), else the local branch.
export async function resolveBase(repo, baseBranch) {
  const hasOrigin = (await tryGit(['remote', 'get-url', 'origin'], { cwd: repo })) !== null;
  let base = baseBranch;
  if (!base && hasOrigin) {
    const head = await tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repo });
    if (head) base = head.replace(/^origin\//, '');
  }
  if (!base) base = (await tryGit(['symbolic-ref', '--short', 'HEAD'], { cwd: repo })) ?? 'main';
  if (hasOrigin) {
    const fetched = await tryGit(['fetch', '--quiet', 'origin', base], { cwd: repo });
    if (fetched !== null) return { base, ref: `origin/${base}` };
  }
  return { base, ref: base };
}

export async function ensureWorktree({ repo, dir, baseBranch }) {
  if (existsSync(dir)) {
    const inside = await tryGit(['rev-parse', '--is-inside-work-tree'], { cwd: dir });
    if (inside === 'true') return { created: false, ref: null };
  }
  await tryGit(['worktree', 'prune'], { cwd: repo });
  mkdirSync(dirname(dir), { recursive: true });
  const { ref } = await resolveBase(repo, baseBranch);
  await git(['worktree', 'add', '--detach', dir, ref], { cwd: repo });
  return { created: true, ref };
}

// Remove a worktree only when nothing in it would be lost: no uncommitted changes and no
// commits that live only on its detached HEAD. Commits on a branch survive the removal.
export async function removeWorktree({ repo, dir }) {
  if (!existsSync(dir)) return { removed: true };
  const status = await tryGit(['status', '--porcelain'], { cwd: dir });
  if (status === null) {
    await tryGit(['worktree', 'prune'], { cwd: repo });
    return { removed: false, reason: 'not a git worktree' };
  }
  if (status) return { removed: false, reason: 'uncommitted changes' };
  const loose = await tryGit(['rev-list', '--count', 'HEAD', '--not', '--branches', '--remotes'], { cwd: dir });
  if (loose && loose !== '0') return { removed: false, reason: `${loose} commit(s) not on any branch` };
  await git(['worktree', 'remove', dir], { cwd: repo });
  return { removed: true };
}
