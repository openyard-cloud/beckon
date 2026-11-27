import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLsof, parsePs, parseSimulators, parseEmulators, parseContainers, scan, newSince, describe, summary } from '../src/leftovers.mjs';

test('reads lsof, ps, simctl, adb and docker output', () => {
  assert.deepEqual([...parseLsof('p12\nfcwd\nn/a/b\np13\nf10\nn*:3000\nf11\nn127.0.0.1:3001\n')], [[12, ['/a/b']], [13, ['*:3000', '127.0.0.1:3001']]]);
  assert.deepEqual(parsePs('  12     1 node server.js --port 3\n'), new Map([[12, { pid: 12, ppid: 1, command: 'node server.js --port 3' }]]));
  const sims = JSON.stringify({ devices: { 'iOS-18': [{ udid: 'U1', name: 'iPhone 16', state: 'Booted' }, { udid: 'U2', name: 'iPad', state: 'Shutdown' }] } });
  assert.deepEqual(parseSimulators(sims), [{ id: 'U1', label: 'iPhone 16' }]);
  assert.deepEqual(parseSimulators('not json'), []);
  assert.deepEqual(parseEmulators('List of devices attached\nemulator-5554\tdevice\nR58M\tdevice\n\n'), [{ id: 'emulator-5554', label: 'emulator-5554' }]);
  assert.deepEqual(parseContainers('abc\tpg\tpostgres:16\n'), [{ id: 'abc', label: 'pg (postgres:16)' }]);
});

test('a scan finds processes working in the worktree or carrying the thread, with their ports', async () => {
  const outputs = {
    'lsof -a -d cwd -Fpn': 'p10\nfcwd\nn/wt/t1/apps/web\np11\nfcwd\nn/wt/t10\np12\nfcwd\nn/elsewhere\np13\nfcwd\nn/wt/t1\n',
    'lsof -nP -iTCP -sTCP:LISTEN -Fpn': 'p10\nf3\nn*:3000\np12\nf3\nn127.0.0.1:8080\np14\nf3\nn*:9999\n',
    'ps -wwE -o pid=,command= -p 12,14': '12 python3 -m http.server 8080 PATH=/bin BECKON_THREAD=C1:1.2\n14 other HOME=/x\n',
    'ps -o pid=,ppid=,command= -p 10,13,12': '10 1 next-server\n13 1 node /beckon/bin/beckon-hook.mjs stop\n12 1 python3 -m http.server 8080\n',
  };
  const exec = (cmd, args, opts, cb) => {
    const key = `${cmd} ${args.join(' ')}`;
    if (key in outputs) return cb(null, outputs[key]);
    cb(Object.assign(new Error('not found'), { code: 'ENOENT' }), '');
  };
  const r = await scan({ dir: '/wt/t1', thread: 'C1:1.2', exec, platform: 'linux', skip: ['/beckon/bin/beckon-hook.mjs'] });
  assert.deepEqual(r.processes.map((p) => [p.pid, p.ports]), [[10, ['3000']], [12, ['8080']]]);
  assert.deepEqual([r.containers, r.simulators, r.emulators], [[], [], []]);
});

test('only what is new counts, each process tree once', () => {
  const p = (pid, ppid, command, ports = []) => ({ pid, ppid, command, ports });
  const before = { processes: [p(1, 0, 'claude')], containers: [{ id: 'old', label: 'old' }], simulators: [], emulators: [] };
  const after = { processes: [p(1, 0, 'claude'), p(5, 1, 'pnpm dev', ['3000']), p(6, 5, 'next-server')], containers: [{ id: 'old', label: 'old' }, { id: 'new', label: 'db (postgres)' }], simulators: [], emulators: [{ id: 'emulator-5554', label: 'emulator-5554' }] };
  const l = newSince(before, after);
  assert.deepEqual(l.processes.map((x) => x.pid), [5]);
  assert.deepEqual(l.all.map((x) => x.pid), [5, 6]);
  assert.match(describe(l), /process 5 on port 3000: pnpm dev \(stop: kill 5\)\n- Docker container db \(postgres\).*\n- Android emulator emulator-5554 \(stop: adb -s emulator-5554 emu kill\)/);
  assert.equal(summary(l), 'port 3000 (pnpm), container db (postgres), emulator emulator-5554');
});
