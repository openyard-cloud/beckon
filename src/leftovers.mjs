import { execFile } from 'node:child_process';
import { sep } from 'node:path';

// What a run leaves behind: processes still running in its worktree (dev servers, watchers,
// `wrangler tail`), ports it listens on, Docker containers, booted iOS simulators and Android
// emulators. beckon takes a snapshot when the run starts using tools and compares it with
// another when Claude is about to finish, so only what appeared during the run counts.

const run = (exec, cmd, args, env) => new Promise((resolve) => {
  exec(cmd, args, { env, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout ?? '')));
});

// lsof -F output: a "p<pid>" line, then field lines for that process.
export function parseLsof(text) {
  const out = new Map();
  let pid = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
      if (!out.has(pid)) out.set(pid, []);
    } else if (line.startsWith('n') && pid) out.get(pid).push(line.slice(1));
  }
  return out;
}

export function parsePs(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) out.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), command: m[3].trim() });
  }
  return out;
}

export function parseSimulators(text) {
  try {
    return Object.values(JSON.parse(text).devices ?? {}).flat()
      .filter((d) => d.state === 'Booted')
      .map((d) => ({ id: d.udid, label: d.name }));
  } catch {
    return [];
  }
}

export function parseEmulators(text) {
  return text.split('\n').map((l) => l.trim().split(/\s+/)).filter(([id, state]) => /^emulator-\d+$/.test(id ?? '') && state).map(([id]) => ({ id, label: id }));
}

export function parseContainers(text) {
  return text.split('\n').filter(Boolean).map((l) => {
    const [id, name, image] = l.split('\t');
    return { id, label: `${name} (${image})` };
  });
}

const inside = (path, dir) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

// One look at the machine for a run whose worktree is `dir` and whose thread is `thread`.
// `skip` matches commands that are beckon's own (its hook scripts).
export async function scan({ dir, thread, env = process.env, exec = execFile, platform = process.platform, skip = [] }) {
  const [cwds, listening, containers, sims, emus] = await Promise.all([
    run(exec, 'lsof', ['-a', '-d', 'cwd', '-Fpn'], env),
    run(exec, 'lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], env),
    run(exec, 'docker', ['ps', '--no-trunc', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}'], env),
    platform === 'darwin' ? run(exec, 'xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], env) : '',
    run(exec, 'adb', ['devices'], env),
  ]);
  const ports = new Map([...parseLsof(listening)].map(([pid, names]) => [pid, [...new Set(names.map((n) => n.replace(/^.*:/, '')))]]));
  const pids = new Set();
  for (const [pid, [cwd]] of parseLsof(cwds)) if (cwd && inside(cwd, dir)) pids.add(pid);
  // A server started from another folder still carries the run's BECKON_THREAD.
  const others = [...ports.keys()].filter((p) => !pids.has(p));
  if (others.length && thread) {
    const envs = await run(exec, 'ps', ['-wwE', '-o', 'pid=,command=', '-p', others.join(',')], env);
    for (const line of envs.split('\n')) {
      const m = line.match(/^\s*(\d+)\s/);
      if (m && line.includes(` BECKON_THREAD=${thread}`)) pids.add(Number(m[1]));
    }
  }
  pids.delete(process.pid);
  let processes = [];
  if (pids.size) {
    const ps = parsePs(await run(exec, 'ps', ['-o', 'pid=,ppid=,command=', '-p', [...pids].join(',')], env));
    processes = [...ps.values()]
      .filter((p) => !skip.some((s) => s && p.command.includes(s)))
      .map((p) => ({ ...p, ports: ports.get(p.pid) ?? [] }));
  }
  return { processes, containers: parseContainers(containers), simulators: parseSimulators(sims), emulators: parseEmulators(emus) };
}

// What is in `after` and not in `before`. A process counts once: its children go with it.
export function newSince(before, after) {
  const had = (list, key) => new Set((list ?? []).map((x) => x[key]));
  const oldPids = had(before?.processes, 'pid');
  const fresh = after.processes.filter((p) => !oldPids.has(p.pid));
  const freshPids = new Set(fresh.map((p) => p.pid));
  const top = fresh.filter((p) => !freshPids.has(p.ppid));
  const pick = (kind) => after[kind].filter((x) => !had(before?.[kind], 'id').has(x.id));
  return { processes: top, all: fresh, containers: pick('containers'), simulators: pick('simulators'), emulators: pick('emulators') };
}

export const isEmpty = (l) => !l.processes.length && !l.containers.length && !l.simulators.length && !l.emulators.length;

const short = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The lines Claude gets: what is running, and the command that stops it.
export function describe(l) {
  const lines = [];
  for (const p of l.processes) lines.push(`- process ${p.pid}${p.ports.length ? ` on port ${p.ports.join(', ')}` : ''}: ${short(p.command)} (stop: kill ${p.pid})`);
  for (const c of l.containers) lines.push(`- Docker container ${c.label} (stop: docker stop ${c.id.slice(0, 12)}, and docker rm it if you created it)`);
  for (const s of l.simulators) lines.push(`- iOS simulator ${s.label}, booted (stop: xcrun simctl shutdown ${s.id})`);
  for (const e of l.emulators) lines.push(`- Android emulator ${e.label} (stop: adb -s ${e.id} emu kill)`);
  return lines.join('\n');
}

// A short summary for people: "port 3000 (next-server), simulator iPhone 16".
export function summary(l) {
  return [
    ...l.processes.map((p) => (p.ports.length ? `port ${p.ports.join(', ')} (${short(p.command.split(/\s+/)[0].split('/').pop(), 30)})` : short(p.command.split(/\s+/)[0].split('/').pop(), 30))),
    ...l.containers.map((c) => `container ${c.label}`),
    ...l.simulators.map((s) => `simulator ${s.label}`),
    ...l.emulators.map((e) => `emulator ${e.label}`),
  ].join(', ');
}

// Stops processes: SIGTERM, then SIGKILL for those still there after a few seconds.
export async function stopProcesses(pids, { wait = 3000 } = {}) {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  await new Promise((r) => setTimeout(r, wait));
  for (const pid of pids) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}
