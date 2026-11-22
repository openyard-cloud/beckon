import test from 'node:test';
import assert from 'node:assert/strict';
import { Progress } from '../src/progress.mjs';

const use = (id, command) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const result = (id, is_error = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error }] } });

function runWithOneFailedTool() {
  const p = new Progress();
  p.push(use('t1', 'pip install x'));
  p.push(result('t1', true));
  p.push(use('t2', 'pip install --user x'));
  p.push(result('t2'));
  p.addTask('api-key', 'Billed through an API key', 'error');
  return p;
}

test('a failed tool call does not mark a finished run as failed; beckon steps keep their error', () => {
  const p = runWithOneFailedTool();
  p.finish('done');
  const tasks = p.planBlock(Date.now(), 'done').tasks;
  assert.equal(tasks[0].status, 'complete');
  assert.match(JSON.stringify(tasks[0].output), /carried on/);
  assert.equal(tasks[1].status, 'complete');
  assert.equal(tasks[2].status, 'error');
});

test('a failed tool call stays an error when the run failed or was stopped', () => {
  for (const status of ['failed', 'stopped']) {
    const p = runWithOneFailedTool();
    p.finish(status);
    assert.equal(p.planBlock(Date.now(), status).tasks[0].status, 'error');
  }
});
