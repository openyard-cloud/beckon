import { relative, isAbsolute } from 'node:path';
import { oneLine, duration } from './text.mjs';

// Slack's plan block holds at most 50 tasks; the oldest steps fold into one line.
const MAX_TASKS = 50;

function shortPath(p, cwd) {
  if (typeof p !== 'string' || !p) return '';
  if (cwd && isAbsolute(p)) {
    const rel = relative(cwd, p);
    if (!rel.startsWith('..')) return rel || '.';
  }
  return p;
}

// One plain-text line per tool use, as shown in the plan block (which does not render markdown).
export function describeTool(name, input = {}, cwd = '') {
  const s = (v, max = 90) => oneLine(v, max);
  switch (name) {
    case 'Bash':
      return `Run: ${s(input.command)}`;
    case 'Read':
      return `Read ${s(shortPath(input.file_path, cwd))}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${s(shortPath(input.file_path, cwd))}`;
    case 'Write':
      return `Write ${s(shortPath(input.file_path, cwd))}`;
    case 'NotebookEdit':
      return `Edit ${s(shortPath(input.notebook_path, cwd))}`;
    case 'Grep':
      return `Search for "${s(input.pattern, 60)}"`;
    case 'Glob':
      return `Find ${s(input.pattern, 60)}`;
    case 'WebFetch':
      try {
        return `Open ${new URL(input.url).host}`;
      } catch {
        return 'Open a web page';
      }
    case 'WebSearch':
      return `Search the web for "${s(input.query, 60)}"`;
    case 'Task':
    case 'Agent':
      return `Helper agent: ${s(input.description || input.prompt, 70)}`;
    case 'TodoWrite':
    case 'ToolSearch':
    case 'Monitor':
      return null;
    default: {
      const m = name.match(/^mcp__(.+?)__(.+)$/);
      if (m) return `${m[1].replace(/^claude_ai_/, '')}: ${m[2].replace(/_/g, ' ')}`;
      return name;
    }
  }
}

function richText(text) {
  return { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: oneLine(text, 500) }] }] };
}

export class Progress {
  constructor({ cwd = '', startedAt = Date.now() } = {}) {
    this.cwd = cwd;
    this.startedAt = startedAt;
    this.tasks = [];
    this.byId = new Map();
    this.renders = 0;
    this.note = null;
  }

  get steps() {
    return this.tasks.map((t) => t.title);
  }

  addTask(id, title, status = 'in_progress', output = null) {
    const task = { id, title: oneLine(title, 150), status, output };
    this.tasks.push(task);
    this.byId.set(id, task);
    return task;
  }

  setTask(id, status, output) {
    const task = this.byId.get(id);
    if (!task) return false;
    task.status = status;
    if (output !== undefined) task.output = output;
    return true;
  }

  // Feed one stream-json event from claude; returns true when the visible plan changed.
  push(event) {
    let changed = false;
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type !== 'tool_use') continue;
        const line = describeTool(block.name, block.input, this.cwd);
        if (line) {
          this.addTask(block.id ?? `tool-${this.tasks.length}`, line);
          changed = true;
        }
      }
    }
    if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type !== 'tool_result' || !block.tool_use_id) continue;
        if (this.setTask(block.tool_use_id, block.is_error ? 'error' : 'complete')) changed = true;
      }
    }
    return changed;
  }

  // Close out the steps still open when the run ends.
  finish(status) {
    const end = status === 'done' ? 'complete' : 'error';
    for (const t of this.tasks) if (t.status === 'in_progress') t.status = end;
  }

  title(now = Date.now(), status = 'working') {
    const elapsed = duration(now - this.startedAt);
    const base = {
      working: `Working · ${elapsed}`,
      waiting: `Waiting for your approval · ${elapsed}`,
      done: `Done in ${elapsed}`,
      stopped: `Stopped after ${elapsed}`,
      failed: `Failed after ${elapsed}`,
    }[status];
    return this.note && (status === 'working' || status === 'waiting') ? `${base} · ${this.note}` : base;
  }

  planBlock(now = Date.now(), status = 'working') {
    let tasks = this.tasks;
    if (tasks.length > MAX_TASKS) {
      const hidden = tasks.length - (MAX_TASKS - 1);
      tasks = [{ id: 'earlier', title: `${hidden} earlier steps`, status: 'complete' }, ...tasks.slice(-(MAX_TASKS - 1))];
    }
    if (!tasks.length) tasks = [{ id: 'start', title: status === 'working' ? 'Starting' : 'No tool steps', status: status === 'working' ? 'in_progress' : 'complete' }];
    this.renders += 1;
    return {
      type: 'plan',
      block_id: `plan-${this.renders}`,
      title: this.title(now, status),
      tasks: tasks.map((t) => {
        const task = { task_id: String(t.id).slice(0, 200), title: t.title, status: t.status };
        if (t.output) task.output = richText(t.output);
        return task;
      }),
    };
  }

  // Plain text for notifications and clients that cannot show the plan block.
  render(now = Date.now(), status = 'working') {
    const mark = { complete: '✓', error: '✗', in_progress: '…' };
    return [this.title(now, status), ...this.tasks.slice(-12).map((t) => `${mark[t.status] ?? '•'} ${t.title}`)].join('\n');
  }
}
