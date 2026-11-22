#!/usr/bin/env node
// Asks beckon for a secret. Run by Claude inside a beckon run. The person enters the value on
// their phone; it never comes back to Claude.
//
// Into the focused field (typed by beckon after checking the field):
//   beckon-secret --label "Apple ID password" --kind password --app "Google Chrome" --domain apple.com
//
// For one command (this process makes the key pair, so only it can open the value; the command
// gets it once, on stdin by default, and it is wiped when the command ends):
//   beckon-secret --label "Stripe key" --run 'gh secret set STRIPE_KEY'
//   beckon-secret --label "Stripe key" --env STRIPE_KEY --run 'node scripts/check-key.mjs'
//   beckon-secret --label "Play service account" --kind multiline --file --run 'fastlane supply --json_key "$BECKON_SECRET_FILE"'
import { postJson } from '../src/hook.mjs';
import { newKeyPair, decrypt } from '../src/passkeys.mjs';
import { runWithSecret } from '../src/secret-run.mjs';

const say = (result, code) => {
  console.log(JSON.stringify(result, null, result.stdout || result.stderr ? 2 : 0));
  process.exit(code);
};

const args = process.argv.slice(2);
const payload = { domains: [] };
let run = null;
for (let i = 0; i < args.length; i++) {
  const [flag, value] = [args[i], args[i + 1]];
  const needsValue = flag !== '--file';
  if (needsValue && (value === undefined || value.startsWith('--'))) say({ status: 'invalid', reason: `${flag} needs a value` }, 2);
  if (flag === '--label') payload.label = value;
  else if (flag === '--kind') payload.kind = value;
  else if (flag === '--app') payload.app = value;
  else if (flag === '--domain') payload.domains.push(value);
  else if (flag === '--note') payload.note = value;
  else if (flag === '--run') (run ??= {}).command = value;
  else if (flag === '--env') Object.assign((run ??= {}), { via: 'env', name: value });
  else if (flag === '--file') Object.assign((run ??= {}), { via: 'file' });
  else say({ status: 'invalid', reason: `unknown argument ${flag}` }, 2);
  if (needsValue) i++;
}
if (run && !run.command) say({ status: 'invalid', reason: '--env and --file go with --run "<command>"' }, 2);

const { BECKON_HOOK_URL: url, BECKON_HOOK_TOKEN: token, BECKON_THREAD: thread } = process.env;
if (!url || !token || !thread) say({ status: 'unavailable', reason: 'not running inside a beckon run' }, 2);

let keys = null;
if (run) {
  keys = newKeyPair();
  Object.assign(payload, { run, publicKey: keys.publicKey });
  delete payload.domains;
}

let result;
try {
  result = await postJson(url, token, { kind: 'secret', thread, payload });
} catch (e) {
  say({ status: 'failed', reason: `beckon is not reachable (${e.message})` }, 1);
}
if (!run) say(result, result.status === 'filled' ? 0 : 1);
if (result.status !== 'delivered' || !result.sealed) {
  keys.ecdh = null;
  say({ status: result.status, reason: result.reason }, 1);
}

let secret;
try {
  secret = decrypt({ ecdh: keys.ecdh, ...result.sealed });
} catch {
  say({ status: 'failed', reason: 'the value could not be decrypted' }, 1);
} finally {
  keys.ecdh = null;
}
const out = await runWithSecret({ command: run.command, via: run.via ?? 'stdin', name: run.name, secret });
secret.fill(0);
say({
  status: out.exitCode === 0 ? 'done' : 'command failed',
  exitCode: out.exitCode,
  note: 'The value was used once and wiped; the link no longer works.',
  stdout: out.stdout || undefined,
  stderr: out.stderr || undefined,
}, out.exitCode === 0 ? 0 : 1);
