'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pino = require('pino');
const { loadConfig } = require('../src/config');
const { createContext } = require('../src/context');

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
  const ctx = await createContext(cfg, {
    logger: pino({ level: 'silent' }),
    clock: opts.clock,
    http: opts.http,
    debounceMs: opts.debounceMs === undefined ? 5 : opts.debounceMs,
    override: opts.override
  });
  const server = await new Promise((r) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => r(s));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const t = { base, dir, cfg, ctx, cookie: '' };
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
  };
  if (opts.signup !== false) await t.signup();
  return t;
}

module.exports = { fixture, startApp, PASSWORD, J };
