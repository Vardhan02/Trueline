'use strict';

/**
 * Postgres access for deployments without a lasting disk (Vercel). The rest of the app sees two calls:
 *   db.query(sql, params) -> rows
 *   db.tx(async (q) => …)  -> runs q(sql, params) calls in one transaction, committed or rolled back as a whole
 * Production uses Neon's serverless driver; tests use PGlite (real Postgres in-process) through the same interface.
 */

/** Neon (or any Postgres reachable over Neon's driver). One small pool per running instance. */
function connectNeon(url, logger) {
  const { Pool } = require('@neondatabase/serverless');
  const pool = new Pool({ connectionString: url, max: 5 });
  pool.on('error', (err) => logger && logger.warn({ err: err.message }, 'postgres pool error')); // an idle connection dropped
  return {
    query: async (sql, params) => (await pool.query(sql, params)).rows,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(async (sql, params) => (await client.query(sql, params)).rows);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    end: () => pool.end()
  };
}

/** The same interface over a PGlite instance (tests and local trials without a database server). */
function wrapPglite(pg) {
  return {
    query: async (sql, params) => (await pg.query(sql, params)).rows,
    tx: (fn) => pg.transaction((t) => fn(async (sql, params) => (await t.query(sql, params)).rows)),
    end: () => pg.close()
  };
}

const MIGRATION_LOCK = 7300001; // advisory lock id: several instances starting at once create the tables one at a time

/** Create the tables if they are missing. Safe to run on every start. */
async function migrate(db) {
  await db.tx(async (q) => {
    await q('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await q(`CREATE TABLE IF NOT EXISTS tl_accounts (
      id text PRIMARY KEY,
      seq bigserial,
      email text NOT NULL UNIQUE,
      api_key_hashes text[] NOT NULL DEFAULT '{}',
      inbound_hash text,
      data text NOT NULL
    )`);
    await q('CREATE INDEX IF NOT EXISTS tl_accounts_api_keys ON tl_accounts USING gin (api_key_hashes)');
    await q('CREATE INDEX IF NOT EXISTS tl_accounts_inbound ON tl_accounts (inbound_hash)');
    await q(`CREATE TABLE IF NOT EXISTS tl_workspaces (
      user_id text PRIMARY KEY,
      data text,
      deleted boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q('CREATE TABLE IF NOT EXISTS tl_rate_limits (key text PRIMARY KEY, hits integer NOT NULL, reset_at timestamptz NOT NULL)');
    await q(`CREATE TABLE IF NOT EXISTS tl_sync_locks (
      user_id text PRIMARY KEY,
      locked_until timestamptz NOT NULL,
      pending boolean NOT NULL DEFAULT false
    )`);
  });
}

module.exports = { connectNeon, wrapPglite, migrate };
