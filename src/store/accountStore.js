'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { FileSnapshot } = require('./snapshot');

/**
 * All accounts in one JSON file (accounts.json), written atomically and one change at a time.
 * Passwords are scrypt hashes; anything secret inside `sealed` is AES-GCM ciphertext; API keys are SHA-256.
 *
 * Reads come from a parsed, indexed copy that is reused while the file is unchanged (see snapshot.js): finding a user
 * by id, email, API key or inbound link is a map lookup instead of parsing the file and scanning every account.
 * The users returned are shared and frozen: read them, and change accounts only through change() / updateUser().
 * Good for one server and many hundreds of users; swap for a database before tens of thousands.
 */
class AccountStore {
  constructor(dir) {
    this.dir = dir;
    this.path = path.join(dir, 'accounts.json');
    this.queue = Promise.resolve();
    this.snapshot = new FileSnapshot(this.path);
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  /** Parse the file as it is on disk now: a private, changeable copy. */
  async readFresh() {
    try {
      return JSON.parse(await fs.readFile(this.path, 'utf8')).users || [];
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /** The shared copy with its lookup tables. */
  index() {
    return this.snapshot.get(async (missing) => {
      const users = missing ? [] : await this.readFresh();
      const byId = new Map();
      const byEmail = new Map();
      const byApiKey = new Map();
      const byInbound = new Map();
      for (const u of users) {
        if (!byId.has(u.id)) byId.set(u.id, u);
        if (!byEmail.has(u.email)) byEmail.set(u.email, u);
        for (const k of u.apiKeys || []) if (!byApiKey.has(k.hash)) byApiKey.set(k.hash, u);
        if (u.inbound && u.inbound.hash && !byInbound.has(u.inbound.hash)) byInbound.set(u.inbound.hash, u);
      }
      return { users, byId, byEmail, byApiKey, byInbound };
    });
  }

  async all() {
    return (await this.index()).users;
  }

  async get(id) {
    return (await this.index()).byId.get(id) || null;
  }

  async byEmail(email) {
    return (await this.index()).byEmail.get(email) || null;
  }

  /** The account that owns the API key with this SHA-256 hash, or null. */
  async byApiKeyHash(hash) {
    return (await this.index()).byApiKey.get(hash) || null;
  }

  /** The account whose inbound link has this SHA-256 hash, or null. */
  async byInboundHash(hash) {
    return (await this.index()).byInbound.get(hash) || null;
  }

  /** Run fn(users) -> result, saving the (mutated) list, one change at a time. fn gets a fresh copy it may change. */
  change(fn) {
    const run = this.queue.then(async () => {
      const users = await this.readFresh();
      const result = await fn(users);
      const tmp = this.path + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
      await fs.writeFile(tmp, JSON.stringify({ users }), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, this.path);
      this.snapshot.clear();
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
