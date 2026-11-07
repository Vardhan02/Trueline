'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, before, after } = require('node:test');
const { loadConfig } = require('../src/config');
const { WorkspaceStore } = require('../src/store/workspaceStore');
const { fixture, startApp } = require('./helpers');

const FIXED_NOW = Date.parse('2026-11-09T06:00:00Z');

describe('config', () => {
  test('defaults are safe for local use', () => {
    const c = loadConfig({});
    assert.strictEqual(c.port, 3000);
    assert.strictEqual(c.production, false);
    assert.strictEqual(c.cookieSecure, false);
  });
  test('production refuses to start without strong secrets and an https address', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /SESSION_SECRET[\s\S]*ENCRYPTION_KEY[\s\S]*PUBLIC_URL/);
    const ok = loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32), ENCRYPTION_KEY: 'y'.repeat(32), PUBLIC_URL: 'https://trueline.example/' });
    assert.strictEqual(ok.publicUrl, 'https://trueline.example');
    assert.strictEqual(ok.cookieSecure, true);
  });
  test('rejects nonsense values', () => {
    assert.throws(() => loadConfig({ PORT: '99999' }), /PORT/);
    assert.throws(() => loadConfig({ MAX_UPLOAD_MB: '0' }), /MAX_UPLOAD_MB/);
    assert.throws(() => loadConfig({ GOOGLE_CLIENT_ID: 'x' }), /GOOGLE_CLIENT_SECRET/);
    assert.throws(() => loadConfig({ SYNC_HOURS: '0' }), /SYNC_HOURS/);
  });
});

describe('workspace store', () => {
  test('round-trips, survives a restart, and serialises concurrent updates', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-store-'));
    const s = new WorkspaceStore(dir);
    await s.init();
    assert.strictEqual((await s.load()).sources.length, 0);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        s.update((ws) => {
          ws.sources.push({ id: 's' + i });
          return ws;
        })
      )
    );
    const again = new WorkspaceStore(dir);
    assert.strictEqual((await again.load()).sources.length, 20, 'no lost updates');
    assert.deepStrictEqual(fs.readdirSync(dir), ['workspace.json'], 'no temp files left behind');
    fs.rmSync(dir, { recursive: true });
  });
  test('a failing update leaves the file untouched and the queue usable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-store-'));
    const s = new WorkspaceStore(dir);
    await s.init();
    await s.update((ws) => {
      ws.sources.push({ id: 'keep' });
      return ws;
    });
    await assert.rejects(
      s.update(() => {
        throw new Error('boom');
      }),
      /boom/
    );
    await s.update((ws) => {
      ws.sources.push({ id: 'after' });
      return ws;
    });
    assert.deepStrictEqual(
      (await s.load()).sources.map((x) => x.id),
      ['keep', 'after']
    );
    fs.rmSync(dir, { recursive: true });
  });
});

describe('HTTP API', () => {
  let t, base;
  const H = { 'X-Requested-With': 'trueline' };
  const fetch = (u, o) => t.fetch(u, o); // signed in as the test user

  async function start() {
    t = await startApp({ env: { MAX_UPLOAD_MB: '1' }, clock: () => FIXED_NOW });
    base = t.base;
  }
  const stop = () => t.stop();
  const upload = (route, name, buffer, choice) => {
    const f = new FormData();
    f.append('file', new Blob([buffer]), name);
    if (choice) f.append('choice', JSON.stringify(choice));
    return fetch(base + '/api/upload/' + route, { method: 'POST', headers: H, body: f });
  };

  describe('signed in', () => {
    before(() => start());
    after(stop);

    test('health endpoints', async () => {
      assert.strictEqual((await (await fetch(base + '/healthz')).json()).status, 'ok');
      assert.strictEqual((await fetch(base + '/readyz')).status, 200);
    });
    test('security headers are set and the framework is not advertised', async () => {
      const r = await fetch(base + '/');
      assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
      assert.strictEqual(r.headers.get('x-powered-by'), null);
      assert.ok(r.headers.get('x-request-id'));
    });
    test('state-changing calls need the CSRF header', async () => {
      const r = await fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.strictEqual(r.status, 403);
    });
    test('empty workspace gives an empty but valid dataset', async () => {
      const j = await (await fetch(base + '/api/dataset')).json();
      assert.strictEqual(j.dataset.LEDGER.length, 0);
      assert.strictEqual(j.sourceCount, 0);
    });
    test('inspect then commit a ledger, and it shows up in the dataset', async () => {
      const info = await (await upload('inspect', 'ledger_uk.csv', fixture('ledger_uk.csv'))).json();
      assert.strictEqual(info.kind, 'ledger');
      const c = await upload('commit', 'ledger_uk.csv', fixture('ledger_uk.csv'), {});
      assert.strictEqual(c.status, 201);
      const j = await (await fetch(base + '/api/dataset')).json();
      assert.strictEqual(j.dataset.LEDGER.length, 4);
      assert.strictEqual(j.dataset.SOURCES.ledger.file, 'ledger_uk.csv');
    });
    test('re-uploading the same file replaces it instead of duplicating', async () => {
      await upload('commit', 'ledger_uk.csv', fixture('ledger_uk.csv'), {});
      const w = await (await fetch(base + '/api/workspace')).json();
      assert.strictEqual(w.sources.filter((s) => s.file === 'ledger_uk.csv').length, 1);
    });
    test('unsupported files get a 422 with advice', async () => {
      const r = await upload('inspect', 'x.pdf', Buffer.from('%PDF-1.4'));
      assert.strictEqual(r.status, 422);
      assert.match((await r.json()).error, /PDF/);
    });
    test('oversized uploads are refused with 413', async () => {
      const r = await upload('inspect', 'big.csv', Buffer.alloc(2 * 1024 * 1024, 'a'));
      assert.strictEqual(r.status, 413);
    });
    test('settings are validated and bad values ignored', async () => {
      const r = await fetch(base + '/api/settings', {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, H),
        body: JSON.stringify({ company: 'Acme & Co', currency: 'XXX', staleDays: 999, asOf: '2026-11-09', emailDomain: '@Acme.IE' })
      });
      const s = (await r.json()).settings;
      assert.strictEqual(s.company, 'Acme & Co');
      assert.strictEqual(s.currency, 'EUR', 'unknown currency ignored');
      assert.strictEqual(s.staleDays, 7, 'out-of-range value ignored');
      assert.strictEqual(s.emailDomain, 'acme.ie');
      const d = (await (await fetch(base + '/api/dataset')).json()).dataset;
      assert.strictEqual(d.NOW, '2026-11-09T06:30:00Z');
    });
    test('malformed JSON is a 400, not a 500', async () => {
      const r = await fetch(base + '/api/settings', { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: '{nope' });
      assert.strictEqual(r.status, 400);
    });
    test('remove a source, 404 for an unknown one', async () => {
      const w = await (await fetch(base + '/api/workspace')).json();
      assert.strictEqual((await fetch(base + '/api/sources/' + w.sources[0].id, { method: 'DELETE', headers: H })).status, 200);
      assert.strictEqual((await fetch(base + '/api/sources/nope', { method: 'DELETE', headers: H })).status, 404);
    });
    test('the real-data sample loads and produces a brief', async () => {
      const r = await fetch(base + '/api/sample/online-retail-ii', { method: 'POST', headers: H });
      assert.strictEqual(r.status, 201);
      const d = (await (await fetch(base + '/api/dataset')).json()).dataset;
      assert.ok(d.LEDGER.length > 100);
      assert.ok(d.BANK.balance > 0);
      assert.strictEqual(d.CURRENCY, 'GBP');
      assert.strictEqual((await fetch(base + '/api/sample/..%2Fetc', { method: 'POST', headers: H })).status, 404);
    });
    test('unknown API routes are JSON 404s', async () => {
      const r = await fetch(base + '/api/nothing');
      assert.strictEqual(r.status, 404);
      assert.ok((await r.json()).error);
    });
    test('the engine and the UI are served', async () => {
      assert.match(await (await fetch(base + '/engine.js')).text(), /Engine/);
      assert.match(await (await fetch(base + '/app.js')).text(), /boot\(\)/);
    });
  });
});
