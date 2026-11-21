import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TabTracker } from '../src/tabs.mjs';

const use = (id, name, input = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, text, is_error = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content: [{ type: 'text', text }] }] } });

test('tracks tabs opened and closed through Claude in Chrome', () => {
  const t = new TabTracker();
  t.push(use('a', 'mcp__claude-in-chrome__tabs_context_mcp', { createIfEmpty: true }));
  t.push(result('a', '{"availableTabs":[{"tabId":1177104552,"title":"New Tab"}],"tabGroupId":1}'));
  t.push(use('b', 'mcp__claude-in-chrome__tabs_create_mcp'));
  t.push(result('b', 'Created new tab. Tab ID: 1177104560'));
  assert.deepEqual(t.open().sort(), ['1177104552', '1177104560']);

  t.push(use('c', 'mcp__claude-in-chrome__tabs_close_mcp', { tabId: 1177104552 }));
  t.push(result('c', 'Closed tab 1177104552.\n\nTab Context:\n- Available tabs:\n  • tabId 1177104560: "x"'));
  assert.deepEqual(t.open(), ['1177104560']);

  t.push(use('d', 'mcp__claude-in-chrome__tabs_close_mcp', { tabId: 1177104560 }));
  t.push(result('d', 'Closed tab 1177104560. Group is now empty (auto-removed).'));
  assert.deepEqual(t.open(), []);
});

test('ignores other tools and failed calls', () => {
  const t = new TabTracker();
  t.push(use('a', 'Bash', { command: 'echo' }));
  t.push(result('a', '{"tabId":5555}'));
  t.push(use('b', 'mcp__claude-in-chrome__tabs_create_mcp'));
  t.push(result('b', 'Tab ID: 7777', true));
  assert.deepEqual(t.open(), []);
});
