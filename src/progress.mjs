import { relative, isAbsolute } from 'node:path';
import { codeSpan, oneLine, duration } from './text.mjs';

const SHOWN_STEPS = 12;

function shortPath(p, cwd) {
  if (typeof p !== 'string' || !p) return '';
  if (cwd && isAbsolute(p)) {
    const rel = relative(cwd, p);
    if (!rel.startsWith('..')) return rel || '.';
  }
  return p;
}

export function describeTool(name, input = {}, cwd = '') {
  switch (name) {
    case 'Bash':
      return `Run ${codeSpan(input.command, 90)}`;
    case 'Read':
      return `Read ${codeSpan(shortPath(input.file_path, cwd))}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${codeSpan(shortPath(input.file_path, cwd))}`;
    case 'Write':
      return `Write ${codeSpan(shortPath(input.file_path, cwd))}`;
    case 'NotebookEdit':
      return `Edit ${codeSpan(shortPath(input.notebook_path, cwd))}`;
    case 'Grep':
      return `Search for ${codeSpan(input.pattern, 60)}`;
    case 'Glob':
      return `Find ${codeSpan(input.pattern, 60)}`;
    case 'WebFetch':
      try {
        return `Open ${new URL(input.url).host}`;
      } catch {
        return 'Open a web page';
      }
    case 'WebSearch':
      return `Search the web for ${codeSpan(input.query, 60)}`;
    case 'Task':
    case 'Agent':
      return `Start a helper agent: ${oneLine(input.description || input.prompt, 70)}`;
    case 'TodoWrite':
      return null;
    default: {
      const m = name.match(/^mcp__(.+?)__(.+)$/);
      if (m) return `${m[1]}: ${m[2].replace(/_/g, ' ')}`;
      return name;
    }
  }
}

export class Progress {
  constructor({ cwd = '', startedAt = Date.now() } = {}) {
    this.cwd = cwd;
    this.startedAt = startedAt;
    this.steps = [];
    this.waiting = null;
    this.sessionId = null;
    this.model = null;
  }

  // Feed one stream-json event from claude; returns true when the visible text changed.
  push(event) {
    if (event.type === 'system' && event.subtype === 'init') {
      this.sessionId = event.session_id ?? this.sessionId;
      this.model = event.model ?? this.model;
      return false;
    }
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      let changed = false;
      for (const block of event.message.content) {
        if (block.type !== 'tool_use') continue;
        const line = describeTool(block.name, block.input, this.cwd);
        if (line) {
          this.steps.push(line);
          changed = true;
        }
      }
      return changed;
    }
    return false;
  }

  render(now = Date.now(), status = 'working') {
    const elapsed = duration(now - this.startedAt);
    const head = {
      working: `:hourglass_flowing_sand: Working · ${elapsed}`,
      waiting: `:raised_hand: Waiting for your approval · ${elapsed}`,
      done: `:white_check_mark: Done in ${elapsed}`,
      stopped: `:octagonal_sign: Stopped after ${elapsed}`,
      failed: `:x: Failed after ${elapsed}`,
    }[status];
    const lines = [head];
    const hidden = this.steps.length - SHOWN_STEPS;
    if (hidden > 0) lines.push(`_…${hidden} earlier step${hidden === 1 ? '' : 's'}_`);
    for (const s of this.steps.slice(-SHOWN_STEPS)) lines.push(`• ${s}`);
    return lines.join('\n');
  }
}
