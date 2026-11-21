import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchdPlist, systemdUnit } from '../src/service.mjs';

test('launchd plist keeps beckon alive with the login PATH', () => {
  const plist = launchdPlist({ node: '/opt/node', bin: '/b/beckon.mjs', path: '/a:/b&c', home: '/Users/me', logFile: '/l.log' });
  assert.match(plist, /<array>\s*<string>\/opt\/node<\/string>\s*<string>\/b\/beckon.mjs<\/string>\s*<string>start<\/string>/);
  assert.match(plist, /<key>BECKON_CAFFEINATE<\/key><string>1<\/string>/);
  assert.match(plist, /<key>ExitTimeOut<\/key><integer>1860<\/integer>/);
  assert.match(plist, /<key>PATH<\/key><string>\/a:\/b&amp;c<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.doesNotMatch(launchdPlist({ node: 'n', bin: 'b', path: 'p', home: 'h', logFile: 'l', caffeinate: false }), /caffeinate/);
});

test('systemd unit restarts beckon and quotes paths', () => {
  const unit = systemdUnit({ node: '/usr/bin/node', bin: '/opt/my beckon/bin/beckon.mjs', path: '/usr/bin', beckonHome: '/srv/b' });
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/opt\/my beckon\/bin\/beckon.mjs" start/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /TimeoutStopSec=1860/);
  assert.match(unit, /KillMode=mixed/);
  assert.match(unit, /Environment="BECKON_HOME=\/srv\/b"/);
});
