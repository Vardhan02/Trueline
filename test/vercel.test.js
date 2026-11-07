'use strict';

/** Running on Vercel: Postgres storage shared by several instances, serverless scheduling, cron, request caps. */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const pino = require('pino');
const { loadConfig } = require('../src/config');
const { createContext } = require('../src/context');
const { PgAccountStore, PgWorkspaceStore, PgSyncLock, PgRateLimitStore } = require('../src/store/pgStores');
const { AccountDeletedError } = require('../src/store/workspaceStore');
const { migrate } = require('../src/db');
const { startApp, pglite, J, PASSWORD, fixture } = require('./helpers');

const MB = 1024 * 1024;
const VERCEL = {
  VERCEL: '1',
  DATABASE_URL: 'postgres://u:p@db.example/neon',
  NODE_ENV: 'production',
  SESSION_SECRET: 's'.repeat(32),
  ENCRYPTION_KEY: 'k'.repeat(32)
};

describe('configuration on Vercel', () => {
  test('defaults suit the platform', () => {
    const c = loadConfig(Object.assign({ VERCEL_PROJECT_PRODUCTION_URL: 'trueline.vercel.app' }, VERCEL));
    assert.strictEqual(c.storage, 'postgres');
    assert.strictEqual(c.serverless, true);
    assert.strictEqual(c.maxUploadMb, 4);
    assert.strictEqual(c.inboundMaxMb, 4);
    assert.strictEqual(c.trustProxy, 1, "Vercel's edge is the one proxy in front");
    assert.strictEqual(c.publicUrl, 'https://trueline.vercel.app');
    assert.strictEqual(loadConfig({}).storage, 'files', 'without DATABASE_URL: files on disk, as before');
    assert.strictEqual(loadConfig({}).inboundMaxMb, 25);
  });

  test('what cannot work on Vercel is refused at start with the fix named', () => {
    const without = Object.assign({}, VERCEL, { DATABASE_URL: '' });
    assert.throws(() => loadConfig(Object.assign({ PUBLIC_URL: 'https://x.example' }, without)), /DATABASE_URL must be set on Vercel/);
    assert.throws(() => loadConfig(Object.assign({ PUBLIC_URL: 'https://x.example', MAX_UPLOAD_MB: '10' }, VERCEL)), /at most 4 on Vercel/);
    assert.throws(() => loadConfig({ DATABASE_URL: 'mysql://x' }), /postgres:\/\//);
  });

  test('the entry point answers 503 naming the missing setting, never its value', async () => {
    const saved = Object.assign({}, process.env);
    Object.assign(process.env, { VERCEL: '1', DATABASE_URL: '', NODE_ENV: 'production', SESSION_SECRET: '', ENCRYPTION_KEY: 'secret-value-'.repeat(3) });
    delete require.cache[require.resolve('../api/index.js')];
    try {
      const handler = require('../api/index.js');
      const res = { headers: {}, setHeader: (k, v) => (res.headers[k] = v), end: (b) => (res.body = b) };
      await handler({}, res);
      assert.strictEqual(res.statusCode, 503);
      assert.match(res.body, /DATABASE_URL/);
      assert.ok(!res.body.includes('secret-value'), 'no setting values in the answer');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe('Postgres stores', () => {
  test('accounts: lookups use the indexed columns; a change writes only what changed; emails stay unique', async () => {
    const db = await pglite();
    await migrate(db);
    await migrate(db); // safe to run again
    const s = new PgAccountStore(db);
    await s.change((users) => {
      users.push({ id: 'u_1', email: 'a@x.example', apiKeys: [{ id: 'k', hash: 'h1' }], inbound: { hash: 'in1' } });
      users.push({
        id: 'u_2',
        email: 'b@x.example',
        apiKeys: [
          { id: 'k', hash: 'h2' },
          { id: 'k2', hash: 'h3' }
        ],
        inbound: null
      });
    });
    assert.strictEqual((await s.byApiKeyHash('h3')).id, 'u_2');
    assert.strictEqual((await s.byInboundHash('in1')).id, 'u_1');
    assert.strictEqual((await s.byEmail('b@x.example')).id, 'u_2');
    assert.deepStrictEqual(
      (await s.all()).map((u) => u.id),
      ['u_1', 'u_2'],
      'sign-up order kept'
    );
    const read = await s.get('u_1');
    assert.throws(() => {
      read.email = 'changed@x.example'; // read-only, as with the file store: change accounts only through change()
    }, TypeError);
    await s.updateUser('u_2', (u) => (u.apiKeys = []));
    assert.strictEqual(await s.byApiKeyHash('h3'), null, 'revoked keys stop working at once');
    await assert.rejects(
      s.change((users) => users.push({ id: 'u_3', email: 'a@x.example', apiKeys: [] })),
      /duplicate key|unique/i
    );
    assert.strictEqual((await s.all()).length, 2, 'a failed change saves nothing');
    await s.change((users) => users.splice(0, 1));
    assert.deepStrictEqual(
      (await s.all()).map((u) => u.id),
      ['u_2']
    );
    await db.end();
  });

  test('workspaces: updates queue on the row; a deletion is final even for a save that was waiting', async () => {
    const db = await pglite();
    await migrate(db);
    const s = new PgWorkspaceStore(db, 'u_x');
    assert.deepStrictEqual((await s.load()).sources, []);
    await s.update((w) => Object.assign(w, { sources: [{ id: 's1' }] }));
    await Promise.all([1, 2, 3].map((n) => s.update((w) => Object.assign(w, { sources: w.sources.concat({ id: 'n' + n }) }))));
    assert.strictEqual((await s.load()).sources.length, 4, 'no update lost');
    await s.destroy();
    await assert.rejects(
      s.update((w) => w),
      (e) => e instanceof AccountDeletedError
    );
    assert.deepStrictEqual((await s.load()).sources, []);
    await s.save({ settings: {}, sources: [{ id: 'late' }] });
    assert.deepStrictEqual((await s.load()).sources, [], 'a plain save cannot bring it back either');
    await db.end();
  });

  test('sync lock: one sync per account at a time, and a sync asked for meanwhile runs afterwards', async () => {
    const db = await pglite();
    await migrate(db);
    const a = new PgSyncLock(db);
    const b = new PgSyncLock(db); // another instance
    assert.strictEqual(await a.acquire('u_1'), true);
    assert.strictEqual(await b.acquire('u_1'), false, 'busy elsewhere');
    assert.strictEqual(await b.acquire('u_2'), true, 'other accounts are not blocked');
    assert.strictEqual(await a.release('u_1'), true, 'the holder learns that another sync was asked for');
    assert.strictEqual(await a.acquire('u_1'), true);
    assert.strictEqual(await a.release('u_1'), false);
    const short = new PgSyncLock(db, 0.01); // a sync that died: its lease runs out
    assert.strictEqual(await short.acquire('u_3'), true);
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(await b.acquire('u_3'), true);
    await db.end();
  });

  test('rate limits are counted once for all instances', async () => {
    const db = await pglite();
    await migrate(db);
    const one = new PgRateLimitStore(db, 'auth:');
    const two = new PgRateLimitStore(db, 'auth:');
    const other = new PgRateLimitStore(db, 'upload:');
    [one, two, other].forEach((s) => s.init({ windowMs: 60e3 }));
    assert.strictEqual((await one.increment('1.2.3.4')).totalHits, 1);
    assert.strictEqual((await two.increment('1.2.3.4')).totalHits, 2);
    assert.strictEqual((await other.increment('1.2.3.4')).totalHits, 1, 'each limit has its own count');
    await one.decrement('1.2.3.4');
    assert.strictEqual((await two.get('1.2.3.4')).totalHits, 1);
    await two.resetKey('1.2.3.4');
    assert.strictEqual(await one.get('1.2.3.4'), undefined);
    const quick = new PgRateLimitStore(db, 'q:');
    quick.init({ windowMs: 20 });
    await quick.increment('k');
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual((await quick.increment('k')).totalHits, 1, 'a new window starts from one');
    await db.end();
  });
});

describe('two instances, one database', () => {
  test('sign-in limits hold across instances, and an account made on one is usable on the other', async () => {
    const db = await pglite();
    const make = async () => {
      const cfg = Object.assign(loadConfig({ DATA_DIR: fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tl-v-')) }), { authAttempts: 3 });
      const ctx = await createContext(cfg, { logger: pino({ level: 'silent' }), override: { db } });
      const server = await new Promise((r) => {
        const s = ctx.app.listen(0, '127.0.0.1', () => r(s));
      });
      return { base: 'http://127.0.0.1:' + server.address().port, server, ctx };
    };
    const a = await make();
    const b = await make();
    try {
      const up = await globalThis.fetch(a.base + '/api/signup', {
        method: 'POST',
        headers: J,
        body: JSON.stringify({ email: 'one@example.com', password: PASSWORD })
      });
      assert.strictEqual(up.status, 201);
      const cookie = up.headers.get('set-cookie').split(';')[0];
      // Sessions are signed with a per-process secret in tests; check the account itself is visible to instance B.
      assert.strictEqual((await b.ctx.accounts.byEmail('one@example.com')).email, 'one@example.com');
      assert.ok(cookie);
      const wrong = (base) =>
        globalThis.fetch(base + '/api/login', { method: 'POST', headers: J, body: JSON.stringify({ email: 'one@example.com', password: 'wrong password!!' }) });
      const codes = [];
      for (const base of [a.base, b.base, a.base, b.base]) codes.push((await wrong(base)).status);
      assert.deepStrictEqual(codes, [401, 401, 429, 429], 'the second instance sees the first one’s attempts');
    } finally {
      for (const x of [a, b]) await new Promise((r) => x.server.close(r));
      await db.end();
    }
  });
});

describe('serverless behaviour', () => {
  test('a sync scheduled during a request runs after the response, once per account', async () => {
    const { createSync } = require('../src/integrations/sync');
    const handed = [];
    let runs = 0;
    const sync = createSync({
      accounts: {
        get: async () => {
          runs++;
          return null;
        }
      },
      workspaceFor: () => ({}),
      vault: {},
      google: {},
      logger: pino({ level: 'silent' }),
      afterResponse: (p) => handed.push(p)
    });
    sync.schedule('u_1');
    sync.schedule('u_1');
    sync.schedule('u_2');
    assert.strictEqual(handed.length, 2, 'one per account, not one per call');
    await Promise.all(handed);
    assert.strictEqual(runs, 2);
  });

  test('the cron route needs CRON_SECRET and refreshes everyone', async () => {
    const off = await startApp({ signup: false });
    const on = await startApp({ cfg: { cronSecret: 'c'.repeat(32) } });
    try {
      assert.strictEqual((await globalThis.fetch(off.base + '/cron/sync')).status, 404, 'no secret configured: no route');
      assert.strictEqual((await globalThis.fetch(on.base + '/cron/sync', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
      let all = 0;
      const runAll = on.ctx.sync.runAll;
      on.ctx.sync.runAll = async () => {
        all++;
        return runAll();
      };
      const r = await globalThis.fetch(on.base + '/cron/sync', { headers: { Authorization: 'Bearer ' + 'c'.repeat(32) } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual((await r.json()).ok, true);
      assert.strictEqual(all, 1);
    } finally {
      await off.stop();
      await on.stop();
    }
  });

  test('the inbound link takes at most 4 MB per request on Vercel', async () => {
    const t = await startApp({ cfg: { inboundMaxMb: 4, maxUploadMb: 4 } });
    try {
      const url = (await (await t.fetch(t.base + '/api/inbound', { method: 'POST', headers: J })).json()).inboundUrl.replace(/^https?:\/\/[^/]+/, t.base);
      const big = await globalThis.fetch(url, { method: 'POST', headers: { 'Content-Type': 'message/rfc822' }, body: Buffer.alloc(4 * MB + 1, 'a') });
      assert.strictEqual(big.status, 413);
      assert.match((await big.json()).error, /at most 4 MB in total/);
      const ok = await globalThis.fetch(url, { method: 'POST', headers: { 'Content-Type': 'message/rfc822' }, body: fixture('remittance.eml') });
      assert.strictEqual(ok.status, 201);
    } finally {
      await t.stop();
    }
  });
});

describe('vercel.json', () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));

  test('static files get exactly the security headers the app sends (Helmet), so the CDN is not a weaker path', async () => {
    const t = await startApp({ cfg: { production: true }, signup: false });
    try {
      const r = await globalThis.fetch(t.base + '/app.css');
      const fromVercel = Object.fromEntries(vercel.headers[0].headers.map((h) => [h.key.toLowerCase(), h.value]));
      for (const [k, v] of Object.entries(fromVercel)) assert.strictEqual(r.headers.get(k), v, k);
      for (const k of ['content-security-policy', 'strict-transport-security', 'x-frame-options', 'x-content-type-options', 'referrer-policy'])
        assert.ok(k in fromVercel, k + ' is set for static files');
    } finally {
      await t.stop();
    }
  });

  test('everything that is not a static file goes to the app, which carries what it reads at run time', () => {
    assert.deepStrictEqual(vercel.rewrites, [{ source: '/(.*)', destination: '/api/index' }]);
    assert.strictEqual(vercel.outputDirectory, 'public');
    const include = vercel.functions['api/index.js'].includeFiles;
    for (const p of ['samples/**', 'src/**', 'package.json']) assert.ok(include.includes(p), p);
    assert.deepStrictEqual(vercel.crons, [{ path: '/cron/sync', schedule: '0 6 * * *' }], 'daily: the most the Hobby plan allows');
  });
});

describe('Neon connection and the locked sync', () => {
  test('a transaction commits on success, rolls back on error, and always returns the connection', async () => {
    const log = [];
    const fakeDriver = require.resolve('@neondatabase/serverless');
    const saved = require.cache[fakeDriver];
    class Pool {
      constructor(opts) {
        log.push('pool ' + opts.connectionString);
      }
      on() {}
      async query(sql) {
        log.push('query ' + sql);
        return { rows: [{ one: 1 }] };
      }
      async connect() {
        return {
          query: async (sql) => {
            log.push(sql);
            if (sql === 'BAD') throw new Error('bad sql');
            return { rows: [] };
          },
          release: () => log.push('release')
        };
      }
      async end() {
        log.push('end');
      }
    }
    require.cache[fakeDriver] = { id: fakeDriver, filename: fakeDriver, loaded: true, exports: { Pool } };
    try {
      const { connectNeon } = require('../src/db');
      const db = connectNeon('postgres://x', null);
      assert.deepStrictEqual(await db.query('SELECT 1'), [{ one: 1 }]);
      assert.strictEqual(await db.tx(async (q) => (await q('GOOD'), 'done')), 'done');
      await assert.rejects(
        db.tx((q) => q('BAD')),
        /bad sql/
      );
      await db.end();
      assert.deepStrictEqual(log, ['pool postgres://x', 'query SELECT 1', 'BEGIN', 'GOOD', 'COMMIT', 'release', 'BEGIN', 'BAD', 'ROLLBACK', 'release', 'end']);
    } finally {
      if (saved) require.cache[fakeDriver] = saved;
      else delete require.cache[fakeDriver];
    }
  });

  test('with a shared lock: busy elsewhere is skipped, and a sync asked for meanwhile runs again', async () => {
    const { createSync } = require('../src/integrations/sync');
    let runs = 0;
    const answers = [true, false, true, true]; // acquire: yes, (released with "again"), yes …
    const releases = [true, false];
    const lock = { acquire: async () => answers.shift(), release: async () => releases.shift() };
    const sync = createSync({
      accounts: {
        get: async () => {
          runs++;
          return null;
        }
      },
      workspaceFor: () => ({}),
      vault: {},
      google: {},
      logger: pino({ level: 'silent' }),
      lock
    });
    assert.deepStrictEqual(await sync.runNow('u_1'), { skipped: 'already syncing; this change will be included' });
    assert.strictEqual(runs, 1, 'ran once, was told to go again, then found the account busy elsewhere');
    const busy = createSync({
      accounts: {},
      workspaceFor: () => ({}),
      vault: {},
      google: {},
      logger: pino({ level: 'silent' }),
      lock: { acquire: async () => false }
    });
    assert.match((await busy.runNow('u_1')).skipped, /already syncing/);
  });
});

describe('waitUntil on Vercel', () => {
  test('a sync scheduled during a request is handed to the Vercel runtime to finish after the response', async () => {
    const KEY = Symbol.for('@vercel/request-context');
    const handed = [];
    globalThis[KEY] = { get: () => ({ waitUntil: (p) => handed.push(p) }) };
    const db = await pglite();
    try {
      const cfg = Object.assign(loadConfig({ DATA_DIR: fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tl-w-')) }), { serverless: true });
      const ctx = await createContext(cfg, { logger: pino({ level: 'silent' }), override: { db } });
      ctx.sync.schedule('u_nobody');
      assert.strictEqual(handed.length, 1);
      assert.deepStrictEqual(await handed[0], { skipped: 'no user' }, 'the handed-over work is the sync itself, and it settles');
      delete globalThis[KEY];
      ctx.sync.schedule('u_other'); // outside Vercel's runtime: nothing to hand to, and nothing breaks
      assert.strictEqual(handed.length, 1);
    } finally {
      delete globalThis[KEY];
      await db.end();
    }
  });
});
