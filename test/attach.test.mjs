import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sniffKind, checkAttachment, inTempFolder } from '../src/attach.mjs';
import { SlackApi } from '../src/slack.mjs';
import { tempDir } from './helpers.mjs';

const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));

test('tells images, videos and PDFs by their first bytes', () => {
  assert.equal(sniffKind(bytes([0x89], 'PNG\r\n\x1a\n')), 'image');
  assert.equal(sniffKind(bytes([0xff, 0xd8, 0xff, 0xe0])), 'image');
  assert.equal(sniffKind(bytes('GIF89a')), 'image');
  assert.equal(sniffKind(bytes('RIFF', [1, 2, 3, 4], 'WEBP')), 'image');
  assert.equal(sniffKind(bytes([0, 0, 0, 0x18], 'ftypheic')), 'image');
  assert.equal(sniffKind(bytes([0, 0, 0, 0x18], 'ftypisom')), 'video');
  assert.equal(sniffKind(bytes([0, 0, 0, 0x14], 'ftypqt  ')), 'video');
  assert.equal(sniffKind(bytes([0x1a, 0x45, 0xdf, 0xa3])), 'video');
  assert.equal(sniffKind(bytes('%PDF-1.7')), 'pdf');
  for (const other of ['KEY=value', '{"a":1}', '-----BEGIN', '']) assert.equal(sniffKind(bytes(other)), null);
});

test('checks the file and knows temp folders', () => {
  const dir = tempDir();
  assert.match(checkAttachment(join(dir, 'nope.png')).reason, /does not exist/);
  assert.match(checkAttachment(dir).reason, /not a file/);
  writeFileSync(join(dir, 'empty.png'), '');
  assert.match(checkAttachment(join(dir, 'empty.png')).reason, /empty/);
  writeFileSync(join(dir, 'a.pdf'), '%PDF-1.4\n...');
  const ok = checkAttachment(join(dir, 'a.pdf'));
  assert.equal(ok.kind, 'pdf');
  assert.equal(ok.name, 'a.pdf');
  assert.ok(inTempFolder(ok.path));
  assert.equal(inTempFolder('/Users/someone/Projects/app/shot.png'), false);
  assert.equal(inTempFolder('/tmpfoo/x.png'), false);
});

test('uploads in three steps: an upload URL, the bytes, then the share in the thread', async () => {
  const dir = tempDir();
  const file = join(dir, 'shot.png');
  writeFileSync(file, bytes([0x89], 'PNG', Buffer.alloc(20)));
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    if (url.endsWith('files.getUploadURLExternal')) return { status: 200, json: async () => ({ ok: true, upload_url: 'https://files.slack.com/upload/v1/x', file_id: 'F9' }) };
    if (url.startsWith('https://files.slack.com/')) return { ok: true, status: 200 };
    return { status: 200, json: async () => ({ ok: true }) };
  };
  const api = new SlackApi('xoxb-1', { fetchImpl });
  assert.deepEqual(await api.upload({ channel: 'C1', threadTs: '1.2', path: file, filename: 'shot.png', title: 'Home' }), { id: 'F9' });
  const first = new URLSearchParams(seen[0].init.body);
  assert.equal(first.get('filename'), 'shot.png');
  assert.equal(first.get('length'), '24');
  assert.equal((await seen[1].init.body.arrayBuffer()).byteLength, 24);
  const done = new URLSearchParams(seen[2].init.body);
  assert.ok(seen[2].url.endsWith('files.completeUploadExternal'));
  assert.equal(done.get('channel_id'), 'C1');
  assert.equal(done.get('thread_ts'), '1.2');
  assert.deepEqual(JSON.parse(done.get('files')), [{ id: 'F9', title: 'Home' }]);
});
