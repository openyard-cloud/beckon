import { spawn } from 'node:child_process';

// Settings passed with --settings: the two hooks that route tool use through beckon. They add
// to the user's and the repository's own settings rather than replacing them.
export function hookSettings({ nodePath, hookScript, timeoutSeconds }) {
  const q = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
  const command = (kind) => `${q(nodePath)} ${q(hookScript)} ${kind}`;
  return {
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: command('pre'), timeout: timeoutSeconds }] }],
      PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: command('permission'), timeout: timeoutSeconds }] }],
    },
  };
}

export function claudeArgs({ sessionId, resume, model, permissionMode, settings, appendPrompt, name }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (resume) args.push('--resume', sessionId);
  else {
    args.push('--session-id', sessionId);
    if (name) args.push('--name', name);
  }
  if (model) args.push('--model', model);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  args.push('--disallowedTools', 'AskUserQuestion');
  if (settings) args.push('--settings', JSON.stringify(settings));
  if (appendPrompt) args.push('--append-system-prompt', appendPrompt);
  return args;
}

export function childEnv(base, extra, { allowApiKey = false } = {}) {
  const env = { ...base, ...extra };
  if (!allowApiKey) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

// Run one turn of claude and resolve with its final result. Events are passed to onEvent as
// they arrive. Aborting the signal stops the process (SIGTERM, then SIGKILL after 5 seconds).
export function runClaude({ bin = 'claude', args, cwd, env, prompt, onEvent = () => {}, signal, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawnImpl(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let stderr = '';
    let result = null;
    let sessionId = null;
    let apiKeySource = null;
    let killTimer = null;
    let settled = false;

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        text: result?.result ?? '',
        isError: result ? Boolean(result.is_error) || result.subtype !== 'success' : true,
        subtype: result?.subtype ?? null,
        sessionId: result?.session_id ?? sessionId,
        numTurns: result?.num_turns ?? null,
        durationMs: Date.now() - started,
        apiKeySource,
        stderr: stderr.slice(-4000),
        aborted: Boolean(signal?.aborted),
        ...extra,
      });
    };

    const onAbort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      killTimer.unref?.();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const handleLine = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === 'system' && event.subtype === 'init') {
        sessionId = event.session_id ?? sessionId;
        apiKeySource = event.apiKeySource ?? null;
      }
      if (event.type === 'result') result = event;
      try {
        onEvent(event);
      } catch {
        /* a display problem must not stop the run */
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-16000);
    });
    child.on('error', (e) => finish({ exitCode: null, spawnError: e.message }));
    child.on('close', (code) => {
      if (buffer) handleLine(buffer);
      finish({ exitCode: code });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}
