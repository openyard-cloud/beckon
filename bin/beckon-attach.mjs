#!/usr/bin/env node
// Sends a screenshot, a screen recording or a PDF to the Slack thread of this beckon run. Run by
// Claude inside a beckon run when someone asks to see one:
//   beckon-attach /tmp/checkout.mp4 --title "Checkout on iPhone 15" --comment "The pay button now works"
// Only images, videos and PDFs go (checked by their content). A file in a temporary folder is
// deleted once it is in Slack.
import { resolve } from 'node:path';
import { postJson } from '../src/hook.mjs';

const say = (result, code) => {
  console.log(JSON.stringify(result));
  process.exit(code);
};

const args = process.argv.slice(2);
const payload = {};
for (let i = 0; i < args.length; i++) {
  const [flag, value] = [args[i], args[i + 1]];
  if (!flag.startsWith('--')) {
    if (payload.path) say({ status: 'invalid', reason: 'send one file per command' }, 2);
    payload.path = resolve(flag);
    continue;
  }
  if (value === undefined || value.startsWith('--')) say({ status: 'invalid', reason: `${flag} needs a value` }, 2);
  if (flag === '--title') payload.title = value;
  else if (flag === '--comment') payload.comment = value;
  else say({ status: 'invalid', reason: `unknown argument ${flag}` }, 2);
  i++;
}
if (!payload.path) say({ status: 'invalid', reason: 'usage: beckon-attach <file> [--title "..."] [--comment "..."]' }, 2);

const { BECKON_HOOK_URL: url, BECKON_HOOK_TOKEN: token, BECKON_THREAD: thread } = process.env;
if (!url || !token || !thread) say({ status: 'unavailable', reason: 'not running inside a beckon run' }, 2);

try {
  const result = await postJson(url, token, { kind: 'attach', thread, payload });
  say(result, result.status === 'uploaded' ? 0 : 1);
} catch (e) {
  say({ status: 'failed', reason: `beckon is not reachable (${e.message})` }, 1);
}
