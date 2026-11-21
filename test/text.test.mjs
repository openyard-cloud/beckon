import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slackToPlain, chunkMarkdown, duration, codeSpan } from '../src/text.mjs';

test('turns Slack markup into plain text', () => {
  assert.equal(
    slackToPlain('<@UBOT> fix <https://x.com/a|the bug> in <#C1|web> &amp; tell <@U2> &lt;now&gt; <https://y.com>', 'UBOT'),
    'fix the bug (https://x.com/a) in #web & tell <@U2> <now> https://y.com',
  );
});

test('splits long markdown and keeps code fences balanced', () => {
  const code = '```js\n' + 'x = 1;\n'.repeat(400) + '```';
  const text = 'intro\n\n' + code + '\n\nend';
  const pieces = chunkMarkdown(text, 1000);
  assert.ok(pieces.length > 2);
  for (const p of pieces) {
    assert.ok(p.length <= 1010, `piece of ${p.length}`);
    assert.equal((p.match(/^```/gm) ?? []).length % 2, 0, p.slice(0, 40));
  }
  assert.ok(pieces.at(-1).endsWith('end'));
  assert.deepEqual(chunkMarkdown('short'), ['short']);
});

test('formats durations and code spans', () => {
  assert.equal(duration(5_000), '5s');
  assert.equal(duration(125_000), '2m 05s');
  assert.equal(duration(3_720_000), '1h 02m');
  assert.equal(codeSpan('echo `hi`'), "`echo 'hi'`");
});
