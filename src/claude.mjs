import { spawn } from 'node:child_process';

// Settings passed with --settings: the hooks that route tool use through beckon, plus a Stop
// hook that keeps the run going until it has closed the browser tabs it opened. They add
// to the user's and the repository's own settings rather than replacing them.
export function hookSettings({ nodePath, hookScript, timeoutSeconds }) {
  const q = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
  const command = (kind) => `${q(nodePath)} ${q(hookScript)} ${kind}`;
  return {
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: command('pre'), timeout: timeoutSeconds }] }],
      PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: command('permission'), timeout: timeoutSeconds }] }],
      Stop: [{ hooks: [{ type: 'command', command: command('stop'), timeout: 30 }] }],
    },
  };
}

export function claudeArgs({ sessionId, resume, model, permissionMode, settings, appendPrompt, name, mcpConfig, agent, pluginDirs = [] }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (resume) args.push('--resume', sessionId);
  else {
    args.push('--session-id', sessionId);
    if (name) args.push('--name', name);
  }
  // A project agent: Claude Code runs the session as that agent (its prompt, tools and model),
  // with the agent's own skills loaded as plugins for this run only.
  if (agent) args.push('--agent', agent);
  for (const dir of pluginDirs) args.push('--plugin-dir', dir);
  if (model) args.push('--model', model);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  args.push('--disallowedTools', 'AskUserQuestion');
  if (settings) args.push('--settings', JSON.stringify(settings));
  // Extra MCP servers for this project's runs only, such as screen control, on top of the user's own.
  if (mcpConfig) args.push('--mcp-config', mcpConfig);
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
    // Own process group: a service manager stopping beckon signals beckon's group, and the
    // run (and the builds it started) must not die with it before beckon decides to stop it.
    const child = spawnImpl(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        try { child.kill(sig); } catch { /* already gone */ }
      }
    };
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
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 5000);
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
      // With subagents in the background a run ends with several results, the last ones often
      // empty: keep the last one that says something.
      if (event.type === 'result' && (event.result || !result?.result)) result = event;
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
