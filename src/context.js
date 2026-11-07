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
const { guardedPost } = require('./integrations/netguard');
const { createApp } = require('./app');
const { connectNeon, migrate } = require('./db');
const { PgAccountStore, PgWorkspaceStore, PgRateLimitStore, PgSyncLock } = require('./store/pgStores');

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

/**
 * Where data lives. Files on disk by default (Docker, Render, `npm start`); Postgres when DATABASE_URL is set (Vercel,
 * where there is no lasting disk and several instances run at once). Tests can pass their own database (PGlite).
 */
async function createStorage(cfg, logger, override) {
  if (cfg.storage === 'postgres' || override.db) {
    const db = override.db || connectNeon(cfg.databaseUrl, logger);
    await migrate(db);
    return {
      db,
      accounts: new PgAccountStore(db),
      makeWorkspace: (uid) => new PgWorkspaceStore(db, uid),
      rateLimitStore: (prefix) => new PgRateLimitStore(db, prefix),
      syncLock: new PgSyncLock(db),
      files: false
    };
  }
  return {
    db: null,
    accounts: new AccountStore(cfg.dataDir),
    makeWorkspace: (uid) => new WorkspaceStore(path.join(cfg.dataDir, 'users', uid)),
    rateLimitStore: null, // the limiter's own memory store: one process holds every request
    syncLock: null,
    files: true
  };
}

/**
 * On Vercel, keep a promise running after the response is sent (waitUntil); elsewhere the process simply carries on.
 * This is the runtime hook @vercel/functions' waitUntil uses (a request context on globalThis), read directly: that
 * package brings a dependency chain with a known vulnerability, for three lines of code.
 */
const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
function afterResponseFor(cfg) {
  if (!cfg.serverless) return null;
  return (promise) => {
    const holder = globalThis[VERCEL_REQUEST_CONTEXT];
    const ctx = holder && typeof holder.get === 'function' ? holder.get() : null;
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(promise);
  };
}

/**
 * Wire every part together. Tests pass their own http (fake Google and webhooks), clock and debounce.
 * Without one, Google is called with fetch and webhooks go through the private-network guard.
 */
async function createContext(cfg, { logger, clock = Date.now, http, debounceMs, override = {} } = {}) {
  const webhookHttp = http || guardedPost;
  http = http || globalThis.fetch;
  const storage = await createStorage(cfg, logger, override);
  const accounts = override.accounts || storage.accounts;
  await accounts.init();
  const vault = createVault(cfg.encryptionKey || (await devKey(cfg.dataDir)));
  const stores = new Map();
  const workspaceFor =
    override.workspaceFor ||
    ((uid) => {
      if (!/^u_[A-Za-z0-9_-]+$/.test(uid)) throw new Error('Bad user id');
      if (!stores.has(uid)) stores.set(uid, storage.makeWorkspace(uid));
      return stores.get(uid);
    });
  const google = createGoogle({
    clientId: cfg.googleClientId,
    clientSecret: cfg.googleClientSecret,
    redirectUri: cfg.publicUrl ? cfg.publicUrl + '/api/google/callback' : 'http://localhost:' + cfg.port + '/api/google/callback',
    http
  });
  const auth = createAuth(cfg, accounts, clock);
  const sync = createSync({
    accounts,
    workspaceFor,
    vault,
    google,
    logger,
    clock,
    http: webhookHttp,
    debounceMs,
    lock: storage.syncLock,
    afterResponse: afterResponseFor(cfg)
  });
  const app = createApp({ cfg, accounts, workspaceFor, auth, vault, google, sync, logger, clock, storage });
  return { app, accounts, workspaceFor, auth, vault, google, sync, db: storage.db };
}

module.exports = { createContext };
