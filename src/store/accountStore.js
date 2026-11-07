'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * All accounts in one JSON file (accounts.json), written atomically and one change at a time.
 * Passwords are scrypt hashes; anything secret inside `sealed` is AES-GCM ciphertext; API keys are SHA-256.
 * Good for one server and hundreds of users; swap for a database before thousands.
 */
class AccountStore {
  constructor(dir) {
    this.dir = dir;
    this.path = path.join(dir, 'accounts.json');
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async all() {
    try {
      return JSON.parse(await fs.readFile(this.path, 'utf8')).users || [];
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async get(id) {
    return (await this.all()).find((u) => u.id === id) || null;
  }

  async byEmail(email) {
    return (await this.all()).find((u) => u.email === email) || null;
  }

  /** Run fn(users) -> result, saving the (mutated) list, one change at a time. */
  change(fn) {
    const run = this.queue.then(async () => {
      const users = await this.all();
      const result = await fn(users);
      const tmp = this.path + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
      await fs.writeFile(tmp, JSON.stringify({ users }), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, this.path);
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** Apply fn to one user; returns the updated user or null if it no longer exists. */
  updateUser(id, fn) {
    return this.change(async (users) => {
      const u = users.find((x) => x.id === id);
      if (!u) return null;
      await fn(u);
      return u;
    });
  }

  async ping() {
    await fs.access(this.dir);
    return true;
  }
}

module.exports = { AccountStore };
