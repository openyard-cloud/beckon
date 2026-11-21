#!/usr/bin/env node
// Asks beckon for a password or one-time code and waits until it has been typed into the
// focused field. Run by Claude inside a beckon run; the value itself never comes back here.
//
//   beckon-secret --label "Apple ID password" --kind password --app "Google Chrome" --domain apple.com
import { postJson } from '../src/hook.mjs';

const args = process.argv.slice(2);
const payload = { domains: [] };
for (let i = 0; i < args.length; i++) {
  const [flag, value] = [args[i], args[i + 1]];
  if (flag === '--label') payload.label = value;
  else if (flag === '--kind') payload.kind = value;
  else if (flag === '--app') payload.app = value;
  else if (flag === '--domain') payload.domains.push(value);
  else if (flag === '--note') payload.note = value;
  else {
    console.log(JSON.stringify({ status: 'invalid', reason: `unknown argument ${flag}` }));
    process.exit(2);
  }
  i++;
}

const { BECKON_HOOK_URL: url, BECKON_HOOK_TOKEN: token, BECKON_THREAD: thread } = process.env;
if (!url || !token || !thread) {
  console.log(JSON.stringify({ status: 'unavailable', reason: 'not running inside a beckon run' }));
  process.exit(2);
}
try {
  const result = await postJson(url, token, { kind: 'secret', thread, payload });
  console.log(JSON.stringify(result));
  process.exit(result.status === 'filled' ? 0 : 1);
} catch (e) {
  console.log(JSON.stringify({ status: 'failed', reason: `beckon is not reachable (${e.message})` }));
  process.exit(1);
}
