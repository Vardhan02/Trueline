'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pino = require('pino');
const { loadConfig } = require('../src/config');
const { createContext } = require('../src/context');
const { wrapPglite } = require('../src/db');

/** TL_TEST_DB=pglite runs the HTTP tests against the Postgres stores (in-process PGlite) instead of files on disk. */
const usePg = (opts) => opts.pg === true || (opts.pg !== false && process.env.TL_TEST_DB === 'pglite');
async function pglite() {
  const { PGlite } = await import('@electric-sql/pglite');
  return wrapPglite(new PGlite());
}

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));
const PASSWORD = 'a long test password';
const J = { 'X-Requested-With': 'trueline', 'Content-Type': 'application/json' };

/**
 * Start a full app on a random port with its own data folder. By default signs up one user and returns
 * a `fetch` that carries that user's session cookie, so tests read like a signed-in browser.
 */
async function startApp(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-app-'));
  const cfg = Object.assign(loadConfig(Object.assign({ DATA_DIR: dir }, opts.env)), { authAttempts: 200 }, opts.cfg);
  const db = usePg(opts) ? await pglite() : null;
  const ctx = await createContext(cfg, {
    logger: pino({ level: 'silent' }),
    clock: opts.clock,
    http: opts.http,
    debounceMs: opts.debounceMs === undefined ? 5 : opts.debounceMs,
    override: Object.assign({}, opts.override, db ? { db } : {})
  });
  const server = await new Promise((r) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => r(s));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const t = { base, dir, cfg, ctx, cookie: '', db };
  /** Exactly what is stored for accounts (file text, or the rows), to check that no secret is kept in clear. */
  t.rawAccounts = async () =>
    db
      ? JSON.stringify({ users: (await db.query('SELECT data FROM tl_accounts ORDER BY seq')).map((r) => JSON.parse(r.data)) })
      : fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8');
  /** Whether an account still has stored files. */
  t.hasWorkspace = async (uid) =>
    db
      ? (await db.query('SELECT 1 FROM tl_workspaces WHERE user_id = $1 AND NOT deleted AND data IS NOT NULL', [uid])).length > 0
      : fs.existsSync(path.join(dir, 'users', uid));
  t.fetch = (url, o = {}) => globalThis.fetch(url, Object.assign({}, o, { headers: Object.assign({}, t.cookie ? { cookie: t.cookie } : {}, o.headers) }));
  t.signup = async (email = 'owner@example.com', password = PASSWORD) => {
    const r = await globalThis.fetch(base + '/api/signup', { method: 'POST', headers: J, body: JSON.stringify({ email, password }) });
    if (r.status !== 201) throw new Error('signup failed: ' + r.status + ' ' + (await r.text()));
    t.cookie = r.headers.get('set-cookie').split(';')[0];
    return r;
  };
  t.stop = async () => {
    await ctx.sync.idle();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
    if (db) await db.end();
  };
  if (opts.signup !== false) await t.signup();
  return t;
}

module.exports = { fixture, startApp, PASSWORD, J, pglite };
