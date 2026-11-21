// Tracks the browser tabs a run opened through Claude in Chrome, from the tool results in the
// run's event stream. Claude in Chrome keeps the agent's tabs in a tab group of their own, so
// every tab it reports is one the agent opened, never one the user had open already.

const CHROME = /^mcp__.*chrome.*__/i;

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
}

export class TabTracker {
  constructor() {
    this.tools = new Map(); // tool_use_id -> tool name, for Claude in Chrome calls
    this.tabs = new Set();
  }

  push(event) {
    const content = event?.message?.content;
    if (!Array.isArray(content)) return;
    if (event.type === 'assistant') {
      for (const b of content) {
        if (b?.type === 'tool_use' && CHROME.test(b.name ?? '')) this.tools.set(b.id, b.name);
      }
    } else if (event.type === 'user') {
      for (const b of content) {
        if (b?.type !== 'tool_result') continue;
        const name = this.tools.get(b.tool_use_id);
        if (!name) continue;
        this.tools.delete(b.tool_use_id);
        if (!b.is_error) this.read(name, resultText(b.content));
      }
    }
  }

  read(name, text) {
    for (const m of text.matchAll(/Closed tab (\d+)/g)) this.tabs.delete(m[1]);
    if (/Group is now empty/i.test(text)) this.tabs.clear();
    // tabs_context lists the agent's whole tab group, so it replaces what is known.
    const listed = [...text.matchAll(/"tabId"\s*:\s*(\d+)/g)].map((m) => m[1]);
    if (/tabs_context/.test(name) && /availableTabs/.test(text)) this.tabs = new Set(listed);
    else for (const id of listed) this.tabs.add(id);
    if (/tabs_create/.test(name)) {
      for (const m of text.matchAll(/\btab(?:\s*id)?\s*[:#]?\s*(\d{4,})/gi)) this.tabs.add(m[1]);
    }
  }

  open() {
    return [...this.tabs];
  }
}
