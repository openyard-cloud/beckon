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
  return '';
}

export async function runHook(kind, stdinText, env = process.env, fetchImpl = globalThis.fetch) {
  const url = env.BECKON_HOOK_URL;
  const token = env.BECKON_HOOK_TOKEN;
  const thread = env.BECKON_THREAD;
  if (!url || !token || !thread) return '';

  let payload;
  try {
    payload = JSON.parse(stdinText);
  } catch {
    return hookOutput(kind, { decision: 'deny', message: 'beckon could not read the hook input.' });
  }

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind, thread, payload }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return hookOutput(kind, await res.json());
  } catch (e) {
    if (kind === 'pre') {
      return hookOutput(kind, { decision: 'deny', message: `beckon is not reachable (${e.message}), so nothing runs without approval.` });
    }
    return hookOutput(kind, { decision: 'deny', message: `beckon is not reachable (${e.message}).` });
  }
}
