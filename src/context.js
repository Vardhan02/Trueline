'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { AccountStore } = require('./store/accountStore');
const { WorkspaceStore } = require('./store/workspaceStore');
const { createAuth } = require('./auth');
const { createVault } = require('./security');
const { createGoogle } = require('./integrations/google');
const { createSync } = require('./integrations/sync');
const { createApp } = require('./app');

/** In development only: keep a generated encryption key next to the data so restarts can still read stored secrets. */
async function devKey(dir) {
  const file = path.join(dir, '.dev-encryption-key');
  try {
    return (await fs.readFile(file, 'utf8')).trim();
  } catch {
    const key = crypto.randomBytes(32).toString('hex');
    await fs.writeFile(file, key, { mode: 0o600 });
    return key;
  }
}

/** Wire every part together. Tests pass their own http (fake Google), clock and debounce. */
async function createContext(cfg, { logger, clock = Date.now, http = globalThis.fetch, debounceMs, override = {} } = {}) {
  const accounts = override.accounts || new AccountStore(cfg.dataDir);
  await accounts.init();
  const vault = createVault(cfg.encryptionKey || (await devKey(cfg.dataDir)));
  const stores = new Map();
  const workspaceFor =
    override.workspaceFor ||
    ((uid) => {
      if (!/^u_[A-Za-z0-9_-]+$/.test(uid)) throw new Error('Bad user id');
      if (!stores.has(uid)) stores.set(uid, new WorkspaceStore(path.join(cfg.dataDir, 'users', uid)));
      return stores.get(uid);
    });
  const google = createGoogle({
    clientId: cfg.googleClientId,
    clientSecret: cfg.googleClientSecret,
    redirectUri: cfg.publicUrl ? cfg.publicUrl + '/api/google/callback' : 'http://localhost:' + cfg.port + '/api/google/callback',
    http
  });
  const auth = createAuth(cfg, accounts, clock);
  const sync = createSync({ accounts, workspaceFor, vault, google, logger, clock, http, debounceMs });
  const app = createApp({ cfg, accounts, workspaceFor, auth, vault, google, sync, logger, clock });
  return { app, accounts, workspaceFor, auth, vault, google, sync };
}

module.exports = { createContext };
