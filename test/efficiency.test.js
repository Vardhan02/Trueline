'use strict';

/** Efficiency pass (November 2026): faster paths must give the same answers, stay correct, and stay fast. */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { test, describe } = require('node:test');
const Engine = require('../src/engine/engine');
const { ingest } = require('../src/ingest');
const { buildDataset } = require('../src/ingest/build');
const { AccountStore } = require('../src/store/accountStore');
const { WorkspaceStore } = require('../src/store/workspaceStore');
const { listSamples } = require('../src/samples');
const { startApp, J } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tl-eff-'));

describe('large files', () => {
  test('a 200,000-row file is read (spreading its cells into one call used to overflow the stack)', async () => {
    let csv = 'Invoice No,Customer,Due Date,Amount\n';
    for (let i = 0; i < 200000; i++) csv += 'I' + i + ',C' + (i % 99) + ',2026-11-01,' + (i % 900) + '.5\n';
    const s = await ingest(Buffer.from(csv), 'big.csv', {});
    assert.strictEqual(s.records.length, 200000);
  });
});

describe('account store', () => {
  test('lookups by id, email, API key and inbound link agree with the file, and see writes at once', async () => {
    const dir = tmp();
    const s = new AccountStore(dir);
    await s.change((users) => {
      users.push({ id: 'u_1', email: 'a@x.example', apiKeys: [{ id: 'k', hash: 'h1' }], inbound: { hash: 'in1' } });
      users.push({ id: 'u_2', email: 'b@x.example', apiKeys: [{ id: 'k', hash: 'h2' }], inbound: null });
    });
    assert.strictEqual((await s.get('u_2')).email, 'b@x.example');
    assert.strictEqual((await s.byEmail('a@x.example')).id, 'u_1');
    assert.strictEqual((await s.byApiKeyHash('h2')).id, 'u_2');
    assert.strictEqual((await s.byInboundHash('in1')).id, 'u_1');
    assert.strictEqual(await s.byApiKeyHash('nope'), null);
    await s.updateUser('u_2', (u) => {
      u.apiKeys = [];
      u.email = 'c@x.example';
    });
    assert.strictEqual(await s.byApiKeyHash('h2'), null, 'a revoked key stops working immediately');
    assert.strictEqual((await s.get('u_2')).email, 'c@x.example');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the shared copy cannot be changed by a reader, and a file replaced from outside is read again', async () => {
    const dir = tmp();
    const s = new AccountStore(dir);
    await s.change((users) => users.push({ id: 'u_1', email: 'a@x.example', apiKeys: [] }));
    const u = await s.get('u_1');
    assert.throws(() => {
      u.email = 'mutated@x.example';
    }, TypeError);
    assert.strictEqual((await s.get('u_1')).email, 'a@x.example');
    fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ users: [{ id: 'u_1', email: 'restored@x.example', apiKeys: [] }] }));
    assert.strictEqual((await s.get('u_1')).email, 'restored@x.example');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('many reads at once parse the file once', async () => {
    const dir = tmp();
    const s = new AccountStore(dir);
    await s.change((users) => users.push({ id: 'u_1', email: 'a@x.example', apiKeys: [] }));
    let reads = 0;
    const fresh = s.readFresh.bind(s);
    s.readFresh = () => (reads++, fresh());
    await Promise.all(Array.from({ length: 50 }, () => s.get('u_1')));
    assert.strictEqual(reads, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('workspace store', () => {
  test('load is cached until a write, and update always starts from what is on disk', async () => {
    const dir = tmp();
    const s = new WorkspaceStore(dir);
    await s.update((ws) => Object.assign(ws, { sources: [{ id: 's1', kind: 'ledger', file: 'a.csv', records: [] }] }));
    const a = await s.load();
    const b = await s.load();
    assert.strictEqual(a.sources, b.sources, 'second load reuses the parsed copy');
    assert.throws(() => a.sources.push({}), TypeError);
    a.settings.company = 'mine'; // settings are a fresh copy per load: callers may change them
    assert.notStrictEqual((await s.load()).settings.company, 'mine');
    await s.update((ws) => Object.assign(ws, { sources: ws.sources.concat({ id: 's2', kind: 'bank', file: 'b.csv', records: {} }) }));
    assert.deepStrictEqual(
      (await s.load()).sources.map((x) => x.id),
      ['s1', 's2']
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('engine', () => {
  test('a reference repeated in a question does not also pull in a shorter one from inside it', () => {
    const led = (id, party) => ({ id, type: 'receivable', party, amount: 10, issued: '2026-09-01', due: '2026-10-01', status: 'open', row: 2 });
    const e = Engine.create(
      buildDataset({
        settings: { asOf: '2026-11-07' },
        sources: [{ kind: 'ledger', file: 'l', uploadedAt: '2026-11-07T00:00:00Z', records: [led('1001', 'A'), led('1001 (x)', 'B')] }]
      })
    );
    assert.deepStrictEqual(
      e.retrieve('1001 (x) and again 1001 (x)').items.map((i) => i.ref),
      ['1001 (x)']
    );
    assert.deepStrictEqual(
      e
        .retrieve('1001 and 1001 (x)')
        .items.map((i) => i.ref)
        .sort(),
      ['1001', '1001 (x)']
    );
  });

  test('asking about one invoice among 30,000 takes milliseconds', () => {
    const records = Array.from({ length: 30000 }, (_, i) => ({
      id: 'INV-' + (100000 + i),
      type: 'receivable',
      party: 'Customer ' + (i % 900),
      amount: 100,
      issued: '2026-09-01',
      due: '2026-10-01',
      status: 'open',
      row: i + 2
    }));
    const e = Engine.create(
      buildDataset({ settings: { asOf: '2026-11-07' }, sources: [{ kind: 'ledger', file: 'l', uploadedAt: '2026-11-07T00:00:00Z', records }] })
    );
    e.askLocal('warm up');
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) assert.strictEqual(e.askLocal('What is the status of INV-100005?').claims.length, 1);
    const each = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
    assert.ok(each < 20, each + ' ms per question'); // was ~40 ms with one pattern per invoice; now ~1 ms
  });

  test('cached date formatting follows the year of each brief', () => {
    const mk = (asOf) => Engine.create({ NOW: asOf + 'T06:30:00Z', LEDGER: [] });
    mk('2026-11-07');
    assert.strictEqual(Engine.fd('2025-03-01'), '1 Mar 2025');
    mk('2025-06-01');
    assert.strictEqual(Engine.fd('2025-03-01'), '1 Mar');
  });
});

describe('HTTP', () => {
  test('the dataset is compressed for clients that accept it, and decodes to the same data', async () => {
    const t = await startApp();
    try {
      await t.fetch(t.base + '/api/sample/online-retail-ii', { method: 'POST', headers: J });
      const get = (ae) =>
        new Promise((resolve) =>
          http.get(t.base + '/api/dataset', { headers: Object.assign({ cookie: t.cookie }, ae ? { 'accept-encoding': ae } : {}) }, (r) => {
            const chunks = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () => resolve({ enc: r.headers['content-encoding'] || 'identity', vary: r.headers.vary, body: Buffer.concat(chunks) }));
          })
        );
      const seen = new Set();
      for (const [ae, want] of [
        [null, 'identity'],
        ['gzip', 'gzip'],
        ['gzip, deflate, br', 'br'],
        ['br;q=0, gzip', 'gzip'],
        ['*;q=0', 'identity']
      ]) {
        const r = await get(ae);
        assert.strictEqual(r.enc, want, String(ae));
        assert.strictEqual(r.vary, 'Accept-Encoding');
        const text = want === 'br' ? zlib.brotliDecompressSync(r.body) : want === 'gzip' ? zlib.gunzipSync(r.body) : r.body;
        seen.add(JSON.stringify(JSON.parse(text).dataset.LEDGER));
      }
      assert.strictEqual(seen.size, 1);
    } finally {
      await t.stop();
    }
  });

  test('the samples list is read once and each caller gets its own copy', () => {
    const a = listSamples();
    a[0].title = 'changed';
    assert.notStrictEqual(listSamples()[0].title, 'changed');
  });
});

describe('browser app', () => {
  test('long lists in drawers are shown a page at a time', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.match(app, /const DRAWER_PAGE = 50;/);
    assert.match(app, /function listDrawer\(title, sub, list, limit = DRAWER_PAGE, keep\)/);
    assert.match(app, /\.slice\(0, limit\)/);
    assert.match(app, /data-drawmore/);
  });
});
