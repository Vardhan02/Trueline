'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DEFAULT_SETTINGS } = require('../ingest/build');
const { FileSnapshot } = require('./snapshot');

const FILE = 'workspace.json';

/**
 * Parsed workspaces kept in memory, most recently used last. A workspace can be several megabytes, so only a few
 * are kept: memory stays bounded however many accounts there are, and the busiest ones are served without parsing.
 */
const MAX_CACHED = 16;
const recent = new Map();
function touch(store) {
  recent.delete(store);
  recent.set(store, true);
  while (recent.size > MAX_CACHED) {
    const oldest = recent.keys().next().value;
    recent.delete(oldest);
    oldest.snapshot.clear();
  }
}

/**
 * One workspace per account, stored as a single JSON file in that account's folder. Writes are atomic (temp file + rename)
 * and serialised through a promise queue so two uploads cannot clobber each other.
 * load() returns shared, frozen sources (see snapshot.js): read them, and change the workspace only through update().
 */
class WorkspaceStore {
  constructor(dir) {
    this.dir = dir;
    this.path = path.join(dir, FILE);
    this.queue = Promise.resolve();
    this.snapshot = new FileSnapshot(this.path);
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  /** The workspace as it is on disk now: a private, changeable copy. */
  async loadFresh() {
    try {
      const ws = JSON.parse(await fs.readFile(this.path, 'utf8'));
      return { settings: Object.assign({}, DEFAULT_SETTINGS, ws.settings), sources: ws.sources || [] };
    } catch (err) {
      if (err.code === 'ENOENT') return { settings: Object.assign({}, DEFAULT_SETTINGS), sources: [] };
      throw err;
    }
  }

  async load() {
    const ws = await this.snapshot.get(() => this.loadFresh());
    touch(this);
    return { settings: Object.assign({}, ws.settings), sources: ws.sources };
  }

  async save(ws) {
    await fs.mkdir(this.dir, { recursive: true }); // a new account's folder is created on its first save
    const tmp = this.path + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(ws), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, this.path);
    this.snapshot.clear();
  }

  /** Run fn(workspace) -> workspace, saving the result, one at a time. fn gets a fresh copy it may change. */
  update(fn) {
    const run = this.queue.then(async () => {
      if (this.deleted) throw new AccountDeletedError();
      const next = await fn(await this.loadFresh());
      await this.save(next);
      return next;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Delete the account's folder. It waits its turn in the same queue as writes, so an upload that was already saving
   * finishes first and is then removed with everything else, and any write queued after it is refused instead of
   * quietly creating the folder again for an account that no longer exists.
   */
  destroy() {
    const run = this.queue.then(async () => {
      this.deleted = true;
      await fs.rm(this.dir, { recursive: true, force: true });
      this.snapshot.clear();
      recent.delete(this);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async ping() {
    await fs.access(this.dir);
    return true;
  }
}

/** A write for an account deleted meanwhile (e.g. an upload that was still waiting its turn). */
class AccountDeletedError extends Error {
  constructor() {
    super('This account has been deleted.');
    this.status = 410;
    this.expose = true; // safe to show: the person deleted it themselves
  }
}

module.exports = { WorkspaceStore, AccountDeletedError };
