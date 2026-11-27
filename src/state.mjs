import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// Threads beckon knows, saved to disk so a restart keeps each Slack thread tied to its Claude
// session and worktree.
export class StateStore {
  constructor(file) {
    this.file = file;
    this.data = { threads: {}, schedules: {}, watches: {}, connections: {} };
    if (file && existsSync(file)) {
      try {
        const loaded = JSON.parse(readFileSync(file, 'utf8'));
        this.data = { threads: loaded.threads ?? {}, schedules: loaded.schedules ?? {}, watches: loaded.watches ?? {}, connections: loaded.connections ?? {} };
      } catch {
        renameSync(file, `${file}.broken-${Date.now()}`);
      }
    }
  }

  get threads() {
    return this.data.threads;
  }

  get schedules() {
    return this.data.schedules;
  }

  get watches() {
    return this.data.watches;
  }

  // Per project: the MCP servers and connectors the last run saw, with their status.
  get connections() {
    return this.data.connections;
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
