'use strict';

/**
 * Postgres versions of the stores, for deployments with no lasting disk and several instances at once (Vercel).
 * Same interfaces as accountStore.js / workspaceStore.js, so the app does not know which one it has. The in-process
 * write queues of the file stores become database locks, which hold across every running instance.
 */
const { deepFreeze } = require('./snapshot');
const { AccountDeletedError } = require('./workspaceStore');
const { DEFAULT_SETTINGS } = require('../ingest/build');

const ACCOUNTS_LOCK = 7300002; // advisory lock: account-list changes (sign-up, delete) happen one at a time

/** Columns kept beside the JSON so lookups by email, API key or inbound link use an index. */
const columns = (u) => [u.id, u.email, (u.apiKeys || []).map((k) => k.hash), u.inbound && u.inbound.hash ? u.inbound.hash : null, JSON.stringify(u)];
const UPSERT = `INSERT INTO tl_accounts (id, email, api_key_hashes, inbound_hash, data) VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, api_key_hashes = EXCLUDED.api_key_hashes,
  inbound_hash = EXCLUDED.inbound_hash, data = EXCLUDED.data`;

class PgAccountStore {
  constructor(db) {
    this.db = db;
  }

  async init() {} // tables are created by migrate() before the stores are used

  async one(sql, params) {
    const rows = await this.db.query(sql, params);
    return rows.length ? deepFreeze(JSON.parse(rows[0].data)) : null;
  }

  async all() {
    return (await this.db.query('SELECT data FROM tl_accounts ORDER BY seq')).map((r) => deepFreeze(JSON.parse(r.data)));
  }
  get(id) {
    return this.one('SELECT data FROM tl_accounts WHERE id = $1', [id]);
  }
  byEmail(email) {
    return this.one('SELECT data FROM tl_accounts WHERE email = $1', [email]);
  }
  byApiKeyHash(hash) {
    return this.one('SELECT data FROM tl_accounts WHERE api_key_hashes @> ARRAY[$1::text] ORDER BY seq LIMIT 1', [hash]);
  }
  byInboundHash(hash) {
    return this.one('SELECT data FROM tl_accounts WHERE inbound_hash = $1 ORDER BY seq LIMIT 1', [hash]);
  }

  /**
   * Run fn(users) -> result on the whole list (it may add, remove or change accounts), then save what changed.
   * All rows are locked for the duration, so it is one change at a time across every instance; only accounts whose
   * content differs are written back.
   */
  change(fn) {
    return this.db.tx(async (q) => {
      await q('SELECT pg_advisory_xact_lock($1)', [ACCOUNTS_LOCK]);
      const rows = await q('SELECT id, data FROM tl_accounts ORDER BY seq FOR UPDATE');
      const before = new Map(rows.map((r) => [r.id, r.data]));
      const users = rows.map((r) => JSON.parse(r.data));
      const result = await fn(users);
      const kept = new Set();
      for (const u of users) {
        kept.add(u.id);
        const c = columns(u);
        if (before.get(u.id) !== c[4]) await q(UPSERT, c);
      }
      const removed = [...before.keys()].filter((id) => !kept.has(id));
      if (removed.length) await q('DELETE FROM tl_accounts WHERE id = ANY($1::text[])', [removed]);
      return result;
    });
  }

  /** Apply fn to one user (locking only that row); returns the updated user or null if it no longer exists. */
  updateUser(id, fn) {
    return this.db.tx(async (q) => {
      const rows = await q('SELECT data FROM tl_accounts WHERE id = $1 FOR UPDATE', [id]);
      if (!rows.length) return null;
      const u = JSON.parse(rows[0].data);
      await fn(u);
      await q(UPSERT, columns(u));
      return u;
    });
  }

  async ping() {
    await this.db.query('SELECT 1');
    return true;
  }
}

class PgWorkspaceStore {
  constructor(db, uid) {
    this.db = db;
    this.uid = uid;
  }

  async init() {}

  parse(rows) {
    const ws = rows.length && !rows[0].deleted && rows[0].data ? JSON.parse(rows[0].data) : {};
    return { settings: Object.assign({}, DEFAULT_SETTINGS, ws.settings), sources: ws.sources || [] };
  }

  async load() {
    return this.parse(await this.db.query('SELECT data, deleted FROM tl_workspaces WHERE user_id = $1', [this.uid]));
  }
  loadFresh() {
    return this.load();
  }

  async save(ws) {
    await this.db.query(
      `INSERT INTO tl_workspaces (user_id, data) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now() WHERE NOT tl_workspaces.deleted`,
      [this.uid, JSON.stringify(ws)]
    );
  }

  /** Lock this account's row (created if missing) for the rest of the transaction. */
  async lock(q) {
    await q('INSERT INTO tl_workspaces (user_id, data) VALUES ($1, NULL) ON CONFLICT (user_id) DO NOTHING', [this.uid]);
    return q('SELECT data, deleted FROM tl_workspaces WHERE user_id = $1 FOR UPDATE', [this.uid]);
  }

  /** Run fn(workspace) -> workspace and save it; concurrent updates from any instance wait their turn on the row. */
  update(fn) {
    return this.db.tx(async (q) => {
      const rows = await this.lock(q);
      if (rows[0].deleted) throw new AccountDeletedError();
      const next = await fn(this.parse(rows));
      await q('UPDATE tl_workspaces SET data = $2, updated_at = now() WHERE user_id = $1', [this.uid, JSON.stringify(next)]);
      return next;
    });
  }

  /** Remove the data, after any update in progress. The row stays as a marker so a late update cannot bring it back. */
  destroy() {
    return this.db.tx(async (q) => {
      await this.lock(q);
      await q('UPDATE tl_workspaces SET deleted = true, data = NULL, updated_at = now() WHERE user_id = $1', [this.uid]);
    });
  }

  async ping() {
    await this.db.query('SELECT 1');
    return true;
  }
}

/**
 * express-rate-limit store shared by every instance: one row per client and limit, counted in a single upsert, so
 * limits hold however many copies of the app are running. Each limiter gets its own prefix.
 */
class PgRateLimitStore {
  constructor(db, prefix) {
    this.db = db;
    this.prefix = prefix;
    this.localKeys = false;
    this.windowMs = 60e3;
  }
  init(options) {
    this.windowMs = options.windowMs;
  }
  async increment(key) {
    const rows = await this.db.query(
      `INSERT INTO tl_rate_limits (key, hits, reset_at) VALUES ($1, 1, now() + $2::float8 * interval '1 millisecond')
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE WHEN tl_rate_limits.reset_at <= now() THEN 1 ELSE tl_rate_limits.hits + 1 END,
         reset_at = CASE WHEN tl_rate_limits.reset_at <= now() THEN now() + $2::float8 * interval '1 millisecond' ELSE tl_rate_limits.reset_at END
       RETURNING hits, reset_at`,
      [this.prefix + key, this.windowMs]
    );
    return { totalHits: Number(rows[0].hits), resetTime: new Date(rows[0].reset_at) };
  }
  async get(key) {
    const rows = await this.db.query('SELECT hits, reset_at FROM tl_rate_limits WHERE key = $1 AND reset_at > now()', [this.prefix + key]);
    return rows.length ? { totalHits: Number(rows[0].hits), resetTime: new Date(rows[0].reset_at) } : undefined;
  }
  async decrement(key) {
    await this.db.query('UPDATE tl_rate_limits SET hits = GREATEST(hits - 1, 0) WHERE key = $1 AND reset_at > now()', [this.prefix + key]);
  }
  async resetKey(key) {
    await this.db.query('DELETE FROM tl_rate_limits WHERE key = $1', [this.prefix + key]);
  }
}

/** Drop rate-limit rows whose window ended long ago (run from the daily cron). */
const cleanRateLimits = (db) => db.query("DELETE FROM tl_rate_limits WHERE reset_at < now() - interval '1 day'");

/**
 * One Google sync per account at a time across all instances (two at once could each create the same calendar
 * events). A short lease, so a sync that dies frees the account by itself. A sync asked for while one is running is
 * remembered (`pending`) and run straight after, so no upload is left out of Google.
 */
class PgSyncLock {
  constructor(db, leaseSeconds = 300) {
    this.db = db;
    this.lease = leaseSeconds;
  }
  async take(uid) {
    const rows = await this.db.query(
      `INSERT INTO tl_sync_locks (user_id, locked_until, pending) VALUES ($1, now() + $2::float8 * interval '1 second', false)
       ON CONFLICT (user_id) DO UPDATE SET locked_until = EXCLUDED.locked_until, pending = false
       WHERE tl_sync_locks.locked_until <= now()
       RETURNING user_id`,
      [uid, this.lease]
    );
    return rows.length > 0;
  }
  async acquire(uid) {
    if (await this.take(uid)) return true;
    await this.db.query('UPDATE tl_sync_locks SET pending = true WHERE user_id = $1', [uid]);
    // The holder may have finished between the two statements, before it could see the flag: try once more.
    return this.take(uid);
  }
  /** Free the account; true when another sync was asked for meanwhile and should run now. */
  release(uid) {
    return this.db.tx(async (q) => {
      const rows = await q('SELECT pending FROM tl_sync_locks WHERE user_id = $1 FOR UPDATE', [uid]);
      await q("UPDATE tl_sync_locks SET locked_until = now() - interval '1 second', pending = false WHERE user_id = $1", [uid]);
      return Boolean(rows.length && rows[0].pending);
    });
  }
}

module.exports = { PgAccountStore, PgWorkspaceStore, PgRateLimitStore, PgSyncLock, cleanRateLimits };
