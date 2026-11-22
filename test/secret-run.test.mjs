import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { redact, runWithSecret } from '../src/secret-run.mjs';

const secret = () => Buffer.from('s3cret-value-123');

test('the output is masked, also for trimmed values and lines of multi-line values', () => {
  assert.equal(redact('key=s3cret!', 's3cret!'), 'key=[secret]');
  assert.equal(redact('got abc123xyz', ' abc123xyz\n'), 'got [secret]');
  assert.equal(redact('line: "private_key_line_one"', '{\n"private_key_line_one"\n}'), 'line: [secret]');
});

test('stdin: the command reads it once and its output is masked', async () => {
  const out = await runWithSecret({ command: 'cat; echo; echo "len=$(printf x)"', via: 'stdin', secret: secret(), env: { PATH: process.env.PATH, BECKON_HOOK_TOKEN: 't' } });
  assert.equal(out.exitCode, 0);
  assert.equal(out.stdout, '[secret]\nlen=x\n');
});

test('env: only that variable has it, and the hook token is not passed on', async () => {
  const out = await runWithSecret({ command: 'printf "%s|%s" "$API_KEY" "${BECKON_HOOK_TOKEN:-none}"', via: 'env', name: 'API_KEY', secret: secret(), env: { PATH: process.env.PATH, BECKON_HOOK_TOKEN: 't0ken' } });
  assert.equal(out.stdout, '[secret]|none');
});

test('file: a private temporary file that is gone when the command ends, even when it fails', async () => {
  const out = await runWithSecret({ command: 'echo "$BECKON_SECRET_FILE"; node -e "console.log((require(\'fs\').statSync(process.env.BECKON_SECRET_FILE).mode & 0o777).toString(8))"; cat "$BECKON_SECRET_FILE"; exit 3', via: 'file', secret: secret(), env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const [path, mode, content] = out.stdout.trim().split('\n');
  assert.equal(out.exitCode, 3);
  assert.equal(mode, '600');
  assert.equal(content, '[secret]');
  assert.ok(!existsSync(path), 'the file is deleted');
});

test('a command that does not exist fails cleanly', async () => {
  const out = await runWithSecret({ command: 'definitely-not-a-command-xyz', via: 'stdin', secret: secret(), env: { PATH: process.env.PATH } });
  assert.notEqual(out.exitCode, 0);
  assert.match(out.stderr, /not found/);
});
