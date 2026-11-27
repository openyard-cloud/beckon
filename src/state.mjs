import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// Threads beckon knows, saved to disk so a restart keeps each Slack thread tied to its Claude
// session and worktree.
export class StateStore {
  constructor(file) {
    this.file = file;
    this.data = { threads: {}, schedules: {}, watches: {}, connections: {}, account: null };
    if (file && existsSync(file)) {
      try {
        const loaded = JSON.parse(readFileSync(file, 'utf8'));
        this.data = { threads: loaded.threads ?? {}, schedules: loaded.schedules ?? {}, watches: loaded.watches ?? {}, connections: Array.isArray(loaded.connections?.servers) ? loaded.connections : {}, account: loaded.account ?? null };
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

  // The connectors and MCP servers runs start with (they belong to the account, not a project).
  get connections() {
    return this.data.connections;
  }

  set connections(v) {
    this.data.connections = v;
  }

  // The Claude account the runs use: who, which plan, when the sign-in runs out.
  get account() {
    return this.data.account;
  }

  set account(v) {
    this.data.account = v;
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
