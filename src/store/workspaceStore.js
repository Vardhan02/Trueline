'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DEFAULT_SETTINGS } = require('../ingest/build');

const FILE = 'workspace.json';

/**
 * One workspace per account, stored as a single JSON file in that account's folder. Writes are atomic (temp file + rename)
 * and serialised through a promise queue so two uploads cannot clobber each other.
 */
class WorkspaceStore {
  constructor(dir) {
    this.dir = dir;
    this.path = path.join(dir, FILE);
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async load() {
    try {
      const ws = JSON.parse(await fs.readFile(this.path, 'utf8'));
      return { settings: Object.assign({}, DEFAULT_SETTINGS, ws.settings), sources: ws.sources || [] };
    } catch (err) {
      if (err.code === 'ENOENT') return { settings: Object.assign({}, DEFAULT_SETTINGS), sources: [] };
      throw err;
    }
  }

  async save(ws) {
    await fs.mkdir(this.dir, { recursive: true }); // a new account's folder is created on its first save
    const tmp = this.path + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(ws), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, this.path);
  }

  /** Run fn(workspace) -> workspace, saving the result, one at a time. */
  update(fn) {
    const run = this.queue.then(async () => {
      const next = await fn(await this.load());
      await this.save(next);
      return next;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async ping() {
    await fs.access(this.dir);
    return true;
  }
}

module.exports = { WorkspaceStore };
