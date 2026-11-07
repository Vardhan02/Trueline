'use strict';

/** The four smaller issues from the November 2026 review, plus the account-deletion bug found while fixing them. */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { test, describe } = require('node:test');
const Engine = require('../src/engine/engine');
const { buildDataset } = require('../src/ingest/build');
const { plan } = require('../src/integrations/plan');
const mcp = require('../src/integrations/mcp');
const { WorkspaceStore, AccountDeletedError } = require('../src/store/workspaceStore');
const { slots, INBOUND_MAX_BYTES } = require('../src/app');
const { startApp, fixture, J, PASSWORD } = require('./helpers');

const MB = 1024 * 1024;

describe('sign-up', () => {
  test('tries are limited per email as well as per IP address', async () => {
    const t = await startApp({ cfg: { authAttempts: 3 }, signup: false });
    try {
      // A different IP each time (the test client is a trusted local proxy), so only the per-email limit can stop it.
      const signup = (i) =>
        globalThis.fetch(t.base + '/api/signup', {
          method: 'POST',
          headers: Object.assign({ 'X-Forwarded-For': '203.0.113.' + i }, J),
          body: JSON.stringify({ email: 'target@example.com', password: 'short' })
        });
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await signup(i)).status);
      assert.deepStrictEqual(codes, [400, 400, 400, 429, 429]);
      const other = await globalThis.fetch(t.base + '/api/signup', {
        method: 'POST',
        headers: Object.assign({ 'X-Forwarded-For': '203.0.113.99' }, J),
        body: JSON.stringify({ email: 'someone.else@example.com', password: PASSWORD })
      });
      assert.strictEqual(other.status, 201, 'other addresses are unaffected');
    } finally {
      await t.stop();
    }
  });

  test('a taken email and a new one take about as long (both hash the password)', async () => {
    const t = await startApp();
    try {
      const time = async (email, i) => {
        const s = process.hrtime.bigint();
        const r = await globalThis.fetch(t.base + '/api/signup', {
          method: 'POST',
          headers: Object.assign({ 'X-Forwarded-For': '198.51.100.' + i }, J),
          body: JSON.stringify({ email, password: PASSWORD })
        });
        await r.text();
        return Number(process.hrtime.bigint() - s);
      };
      const taken = [];
      const fresh = [];
      for (let i = 0; i < 5; i++) {
        taken.push(await time('owner@example.com', i));
        fresh.push(await time('new' + i + '@example.com', 50 + i));
      }
      const median = (a) => a.sort((x, y) => x - y)[2];
      assert.ok(median(taken) > median(fresh) * 0.6, 'taken ' + median(taken) / 1e6 + ' ms vs new ' + median(fresh) / 1e6 + ' ms');
    } finally {
      await t.stop();
    }
  });
});

describe('each engine formats with its own currency and year', () => {
  const ws = (currency, asOf) => ({
    settings: { currency, asOf },
    sources: [
      {
        kind: 'ledger',
        file: 'l.csv',
        uploadedAt: asOf + 'T00:00:00Z',
        records: [{ id: 'B-1', type: 'payable', party: 'Supplier', amount: 1234, issued: asOf, due: asOf, status: 'open', row: 2 }]
      }
    ]
  });

  test('a calendar plan and an MCP answer use their own workspace even after another engine was built', async () => {
    const gbp = Engine.create(buildDataset(ws('GBP', '2026-11-07')));
    const usd = Engine.create(buildDataset(ws('USD', '2011-11-09'))); // built later: used to change everyone's formatting
    assert.match(plan(gbp).events[0].body.summary, /£1,234/);
    assert.match(plan(usd).events[0].body.summary, /\$1,234/);
    const brief = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_priorities' } }, async () => gbp);
    assert.match(brief.result.content[0].text, /£1,234/);
    assert.strictEqual(gbp.fd('2025-03-01'), '1 Mar 2025');
    assert.strictEqual(usd.fd('2011-03-01'), '1 Mar');
    assert.strictEqual(gbp.eur(5), '£5');
    assert.strictEqual(Engine.eur(5), '$5', 'Engine.eur still follows the latest engine, for the browser page');
  });
});

describe('deleting an account', () => {
  test('a save that was still waiting cannot bring the folder back', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-del-'));
    const s = new WorkspaceStore(path.join(dir, 'users', 'u_x'));
    let release;
    const slow = s.update(async (w) => {
      await new Promise((r) => (release = r)); // an upload in the middle of saving
      return Object.assign(w, { sources: [{ id: 's1' }] });
    });
    const destroyed = s.destroy();
    const late = s.update((w) => Object.assign(w, { sources: [{ id: 's2' }] })); // queued behind the deletion
    while (!release) await new Promise((r) => setTimeout(r, 5)); // until the first save is really under way
    release();
    await slow;
    await destroyed;
    await assert.rejects(late, (e) => e instanceof AccountDeletedError && e.status === 410);
    assert.strictEqual(fs.existsSync(path.join(dir, 'users', 'u_x')), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a second delete request never removes someone else’s account', async () => {
    const t = await startApp();
    try {
      const other = await globalThis.fetch(t.base + '/api/signup', {
        method: 'POST',
        headers: Object.assign({ 'X-Forwarded-For': '198.51.100.7' }, J),
        body: JSON.stringify({ email: 'other@example.com', password: PASSWORD })
      });
      assert.strictEqual(other.status, 201);
      const del = () => t.fetch(t.base + '/api/account', { method: 'DELETE', headers: J, body: JSON.stringify({ password: PASSWORD }) });
      await Promise.all([del(), del()]); // a double click
      const left = (await t.ctx.accounts.all()).map((u) => u.email);
      assert.deepStrictEqual(left, ['other@example.com']);
    } finally {
      await t.stop();
    }
  });
});

describe('inbound link memory', () => {
  test('one request may carry 25 MB in total; more is refused while it streams in', async () => {
    const t = await startApp({ cfg: { maxUploadMb: 10 } });
    try {
      const url = (await (await t.fetch(t.base + '/api/inbound', { method: 'POST', headers: J })).json()).inboundUrl.replace(/^https?:\/\/[^/]+/, t.base);
      const f = new FormData();
      for (let i = 0; i < 3; i++) f.append('f' + i, new Blob([Buffer.alloc(9 * MB, 'a')]), 'big' + i + '.csv'); // each under 10 MB, 27 MB together
      const big = await globalThis.fetch(url, { method: 'POST', body: f });
      assert.strictEqual(big.status, 413);
      assert.match((await big.json()).error, /25 MB in total/);
      const raw = await globalThis.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'message/rfc822' },
        body: Buffer.alloc(INBOUND_MAX_BYTES + 1, 'a')
      });
      assert.strictEqual(raw.status, 413);
      assert.match((await raw.json()).error, /25 MB in total/);
      const ok = await globalThis.fetch(url, { method: 'POST', headers: { 'Content-Type': 'message/rfc822' }, body: fixture('remittance.eml') });
      assert.strictEqual(ok.status, 201, 'normal forwarding still works');
      const wrong = await globalThis.fetch(t.base + '/inbound/in_wrong', {
        method: 'POST',
        headers: { 'Content-Type': 'message/rfc822' },
        body: Buffer.alloc(INBOUND_MAX_BYTES + 1, 'a')
      });
      assert.strictEqual(wrong.status, 404, 'a wrong link is refused before the body is read');
    } finally {
      await t.stop();
    }
  });

  test('at most two inbound requests are read at once; the rest wait their turn and none is lost', async () => {
    const gate = slots(2);
    let active = 0;
    let peak = 0;
    const done = [];
    const reqs = Array.from({ length: 6 }, (_, i) => {
      const res = new EventEmitter();
      return new Promise((resolve) =>
        gate({}, res, () => {
          active++;
          peak = Math.max(peak, active);
          setTimeout(() => {
            active--;
            done.push(i);
            res.emit('finish');
            resolve();
          }, 5);
        })
      );
    });
    await Promise.all(reqs);
    assert.strictEqual(peak, 2);
    assert.deepStrictEqual(
      done.slice().sort((a, b) => a - b),
      [0, 1, 2, 3, 4, 5]
    );
  });

  test('a request that gives up while waiting frees its place', async () => {
    const gate = slots(1);
    const first = new EventEmitter();
    gate({}, first, () => {});
    const quitter = new EventEmitter();
    let quitterRan = false;
    gate({}, quitter, () => (quitterRan = true));
    quitter.emit('close'); // client went away while waiting
    let thirdRan = false;
    gate({}, new EventEmitter(), () => (thirdRan = true));
    first.emit('finish');
    assert.strictEqual(quitterRan, false);
    assert.strictEqual(thirdRan, true);
  });
});
