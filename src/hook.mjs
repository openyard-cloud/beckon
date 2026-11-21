import { request } from 'node:http';

// The hook Claude Code runs before each tool use (PreToolUse) and whenever it would show a
// permission prompt (PermissionRequest). It asks the beckon daemon what to do. If the daemon
// cannot be reached the answer is "deny": an unanswered approval must never turn into a yes.

export function hookOutput(kind, answer) {
  const decision = answer?.decision;
  const message = answer?.message || 'Denied by beckon.';
  if (kind === 'pre') {
    if (decision !== 'allow' && decision !== 'deny') return '';
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: decision === 'allow' ? (answer.message || 'Approved in Slack.') : message,
      },
    });
  }
  if (kind === 'permission') {
    const behavior = decision === 'allow' ? 'allow' : 'deny';
    const out = { behavior };
    if (behavior === 'deny') out.message = message;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: out } });
  }
  if (kind === 'stop') {
    if (decision !== 'block') return '';
    return JSON.stringify({ decision: 'block', reason: answer.message });
  }
  return '';
}

// node:http rather than fetch: fetch gives up on a response after 5 minutes, and an approval
// can take much longer than that to be answered.
export function postJson(url, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

export async function runHook(kind, stdinText, env = process.env, post = postJson) {
  const url = env.BECKON_HOOK_URL;
  const token = env.BECKON_HOOK_TOKEN;
  const thread = env.BECKON_THREAD;
  if (!url || !token || !thread) return '';

  let payload;
  try {
    payload = JSON.parse(stdinText);
  } catch {
    if (kind === 'stop') return '';
    return hookOutput(kind, { decision: 'deny', message: 'beckon could not read the hook input.' });
  }

  try {
    return hookOutput(kind, await post(url, token, { kind, thread, payload }));
  } catch (e) {
    // The Stop hook only asks for tidying up, so an unreachable daemon lets the run finish.
    if (kind === 'stop') return '';
    if (kind === 'pre') {
      return hookOutput(kind, { decision: 'deny', message: `beckon is not reachable (${e.message}), so nothing runs without approval.` });
    }
    return hookOutput(kind, { decision: 'deny', message: `beckon is not reachable (${e.message}).` });
  }
}
