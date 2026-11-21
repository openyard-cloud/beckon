import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, cronMatches, minuteKey } from '../src/cron.mjs';

test('matches weekday mornings in a time zone', () => {
  const c = parseCron('0 8 * * 1-5');
  // 2026-11-23 is a Monday. 08:00 in Ho Chi Minh City is 01:00 UTC.
  assert.ok(cronMatches(c, new Date('2026-11-23T01:00:00Z'), 'Asia/Ho_Chi_Minh'));
  assert.ok(!cronMatches(c, new Date('2026-11-23T08:00:00Z'), 'Asia/Ho_Chi_Minh'));
  assert.ok(cronMatches(c, new Date('2026-11-23T08:00:00Z'), 'UTC'));
  // Saturday
  assert.ok(!cronMatches(c, new Date('2026-11-28T01:00:00Z'), 'Asia/Ho_Chi_Minh'));
});

test('steps, lists and Sunday as 0 or 7', () => {
  const every15 = parseCron('*/15 * * * *');
  assert.ok(cronMatches(every15, new Date('2026-11-23T10:45:00Z')));
  assert.ok(!cronMatches(every15, new Date('2026-11-23T10:46:00Z')));
  const sunday = parseCron('30 9 * * 7');
  assert.ok(cronMatches(sunday, new Date('2026-11-22T09:30:00Z')));
  const list = parseCron('0 9,17 1,15 * *');
  assert.ok(cronMatches(list, new Date('2026-12-15T17:00:00Z')));
  assert.ok(!cronMatches(list, new Date('2026-12-16T17:00:00Z')));
});

test('when both day fields are set, either one matches', () => {
  const c = parseCron('0 0 1 * 1');
  assert.ok(cronMatches(c, new Date('2026-12-01T00:00:00Z')));
  assert.ok(cronMatches(c, new Date('2026-11-23T00:00:00Z')));
  assert.ok(!cronMatches(c, new Date('2026-11-24T00:00:00Z')));
});

test('rejects malformed expressions', () => {
  assert.throws(() => parseCron('0 8 * *'), /5 fields/);
  assert.throws(() => parseCron('61 * * * *'), /out of range/);
  assert.throws(() => parseCron('a * * * *'), /not understood/);
});

test('minute keys differ per minute', () => {
  assert.notEqual(minuteKey(new Date('2026-11-23T01:00:00Z')), minuteKey(new Date('2026-11-23T01:01:00Z')));
});
