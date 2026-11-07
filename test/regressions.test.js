'use strict';

/** One test per bug found in the November 2026 review, so none of them can come back unnoticed. */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const Engine = require('../src/engine/engine');
const { inspect, ingest, UnsupportedFileError } = require('../src/ingest');
const { buildDataset, matchBank } = require('../src/ingest/build');
const { extractClaims } = require('../src/ingest/extract');
const { autoChoice, webhookProblem } = require('../src/app');
const { isPrivateIp, guardedPost } = require('../src/integrations/netguard');
const { startApp, J } = require('./helpers');
const { fakeGoogle } = require('./fakeGoogle');

const clock = () => Date.parse('2026-11-07T09:00:00Z');
const src = (kind, records, extra) => Object.assign({ id: 's_' + kind, kind, file: kind + '.csv', uploadedAt: '2026-11-07T00:00:00Z', records }, extra);
const led = (id, type, party, amount, due = '2026-10-31') => ({ id, type, party, amount, issued: '2026-10-01', due, status: 'open', row: 2 });
const engineOf = (sources, settings = {}) => Engine.create(buildDataset({ settings: Object.assign({ asOf: '2026-11-07' }, settings), sources }, { clock }));
const upload = (t, name, body) => {
  const f = new FormData();
  f.append('file', new Blob([body]), name);
  return t.fetch(t.base + '/api/upload/commit', { method: 'POST', headers: { 'X-Requested-With': 'trueline' }, body: f });
};

describe('matching is on whole references', () => {
  const ledger = [led('INV-1', 'receivable', 'Acme', 100), led('INV-10', 'receivable', 'Zed Ltd', 1000)];

  test('a payment for INV-10 is never credited to INV-1', () => {
    const [m] = matchBank([{ date: '2026-11-01', amount: 1000, description: 'Payment INV-10 thanks', reference: '' }], ledger);
    assert.strictEqual(m.reference, 'INV-10');
    assert.strictEqual(m.counterparty, 'Zed Ltd');
  });

  test('a customer name inside a longer word does not match, and very short numbers are not used', () => {
    const l = [led('12', 'receivable', 'Acme', 100)];
    const [m] = matchBank([{ date: '2026-11-01', amount: 5, description: 'ACMECORP card 12 Nov', reference: '' }], l);
    assert.strictEqual(m.matched, false);
    assert.strictEqual(m.reference, '');
  });

  test('emails: "INV-1" is not read inside "INV-10"', () => {
    const mail = { from: 'ap@zed.example', date: '2026-11-02T10:00:00Z', subject: 'Payment', body: 'We have paid INV-10 £1,000 today.' };
    const out = extractClaims(mail, [led('INV-1', 'receivable', 'Acme', 100)], 'me.example');
    assert.deepStrictEqual(out.extracted, []);
  });

  test('repeated bank references still give every transaction its own id', () => {
    const tx = (d, a) => ({ id: 'DD', date: d, amount: a, description: 'Interest', reference: 'DD' });
    const ids = matchBank([tx('2026-11-01', 1), tx('2026-11-02', 2), tx('2026-11-03', 3)], []).map((m) => m.id);
    assert.deepStrictEqual(ids, ['DD', 'DD-2', 'DD-3']);
  });
});

describe('the engine keeps every record apart', () => {
  test('an invoice and a bill with the same number are two items, each citing its own row', () => {
    const e = engineOf([src('ledger', [led('1001', 'receivable', 'Customer A', 500), Object.assign(led('1001', 'payable', 'Supplier B', 9000), { row: 3 })])]);
    const kinds = e.items.map((i) => i.type + ':' + i.ref + ':' + i.amount).sort();
    assert.deepStrictEqual(kinds, ['payable:1001 (bill):9000', 'receivable:1001:500']);
    const ids = e.facts.map((f) => f.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'no two facts share an id');
  });

  test('an email from the supplier about the shared number goes to the bill', () => {
    const ledger = buildDataset(
      { settings: {}, sources: [src('ledger', [led('1001', 'receivable', 'Customer A', 500), led('1001', 'payable', 'Northwind Supplies', 900)])] },
      { clock }
    ).LEDGER;
    const mail = {
      from: 'ar@northwind.example',
      date: '2026-11-02T10:00:00Z',
      subject: 'Final notice',
      body: 'Northwind Supplies: invoice 1001 is overdue. Please arrange payment.'
    };
    const [c] = extractClaims(mail, ledger, 'me.example').extracted;
    assert.strictEqual(c.ref, '1001 (bill)');
    assert.strictEqual(c.kind, 'supplier_notice');
  });

  test('bank credits matched to nothing do not become "unverified" items', () => {
    const bank = {
      balance: 5000,
      balanceDate: '2026-11-06',
      transactions: [{ id: 'FP1', date: '2026-11-01', amount: 40, description: 'Refund from shop', reference: 'FP1' }]
    };
    const e = engineOf([src('ledger', [led('INV-1', 'receivable', 'Acme', 100)]), src('bank', bank)]);
    assert.deepStrictEqual(e.unverified, []);
    assert.ok(
      e.facts.some((f) => f.kind === 'bank_credit'),
      'the credit is still a cited fact'
    );
  });

  test('invoice numbers like "constructor" or "__proto__" do not break the brief', () => {
    const e = engineOf([
      src(
        'ledger',
        ['constructor', '__proto__', 'toString'].map((id) => led(id, 'receivable', 'Acme ' + id, 10))
      )
    ]);
    assert.strictEqual(e.items.length, 3);
    assert.ok(e.byRef.constructor && e.byRef.constructor.party === 'Acme constructor');
    e.briefEmail();
    e.askLocal('what is overdue');
  });
});

describe('dataset building', () => {
  const months = (y, n, v = 1000) => Array.from({ length: n }, (_, i) => ({ month: y + '-' + String(i + 1).padStart(2, '0'), turnover: v }));

  test('an earlier partial P&L year is not taken as this year to date', () => {
    const d = buildDataset({ settings: {}, sources: [src('pnl', { months: [...months(2024, 6), ...months(2025, 12), ...months(2026, 3)] })] }, { clock });
    assert.strictEqual(d.PNL.ytdYear, 2026);
    assert.strictEqual(d.PNL.ytd.length, 3);
    const only = buildDataset({ settings: {}, sources: [src('pnl', { months: [...months(2024, 6), ...months(2025, 12)] })] }, { clock });
    assert.strictEqual(only.PNL.ytdYear, null);
  });

  test('the newest dated bank balance wins over a statement with no balance date', () => {
    const d = buildDataset(
      {
        settings: {},
        sources: [
          src('bank', { balance: 111, balanceDate: '2026-11-06', transactions: [] }, { file: 'new.csv' }),
          src('bank', { balance: 999, balanceDate: null, transactions: [] }, { file: 'old.ofx', uploadedAt: '2026-11-08T00:00:00Z' })
        ]
      },
      { clock }
    );
    assert.strictEqual(d.BANK.balance, 111);
  });
});

describe('uploads', () => {
  test('a ledger with only an "amount due" column is accepted end to end', async () => {
    const csv = Buffer.from('Invoice No,Customer,Due Date,Amount Due\nINV-1,Acme,2026-11-01,100\nINV-2,Beta,2026-12-01,0\n');
    const choice = autoChoice(await inspect(csv, 'ledger.csv'));
    assert.ok(choice, 'confident without asking');
    const s = await ingest(csv, 'ledger.csv', choice);
    assert.deepStrictEqual(
      s.records.map((r) => [r.id, r.amount, r.status]),
      [['INV-1', 100, 'open']]
    );
    assert.match(s.issues[0].message, /Nothing owed/);
  });

  test('a ledger with neither column names both in the error', async () => {
    await assert.rejects(
      ingest(Buffer.from('Invoice No,Customer\nINV-1,Acme\n'), 'l.csv', { kind: 'ledger', mapping: { id: 0, party: 1 } }),
      /Invoice amount \(or amount still owed\)/
    );
  });

  test('broken files are refused with advice, not a server error', async () => {
    await assert.rejects(
      ingest(Buffer.from('a,b\n"unterminated,1\n'), 'x.csv', {}),
      (e) => e instanceof UnsupportedFileError && /could not be read as a table/.test(e.message)
    );
    const notReallyExcel = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 7)]);
    await assert.rejects(ingest(notReallyExcel, 'x.xlsx', {}), (e) => e instanceof UnsupportedFileError && /Excel file could not be read/.test(e.message));
    await assert.rejects(ingest(Buffer.from('OFXHEADER:100\n<OFX></OFX>'), 'empty.ofx', {}), /No transactions or balance/);
  });
});

describe('webhooks cannot reach private networks', () => {
  test('private, loopback, link-local and mapped addresses are recognised', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      '::ffff:7f00:1',
      '::ffff:127.0.0.1',
      '64:ff9b::a9fe:a9fe',
      'fd00::1',
      'fe80::1%eth0',
      '0.0.0.0'
    ])
      assert.strictEqual(isPrivateIp(ip), true, ip);
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.strictEqual(isPrivateIp(ip), false, ip);
    assert.strictEqual(isPrivateIp('not-an-ip'), true);
    assert.match(webhookProblem('https://[::ffff:a9fe:a9fe]/x'), /Private/);
  });

  test('a name that resolves to a private address is refused when sending', async () => {
    await assert.rejects(guardedPost('https://localhost:1/hook', { body: '{}' }), /private network/);
    await assert.rejects(guardedPost('https://[::1]:1/hook', { body: '{}' }), /private network/);
    await assert.rejects(guardedPost('http://example.com/hook', { body: '{}' }), /https/);
  });

  test('without a test transport, the app sends webhooks through the guard', async () => {
    const t = await startApp(); // no http override: production wiring
    try {
      const { vault, sync } = t.ctx;
      const hook = { id: 'h_x', sealed: vault.seal({ url: 'https://localhost:9/hook', secret: 's' }) };
      await assert.rejects(sync.testWebhook({ email: 'a@b.example' }, hook), /private network/);
    } finally {
      await t.stop();
    }
  });
});

describe('HTTP', () => {
  test('client errors from Express keep their status instead of becoming 500s', async () => {
    const t = await startApp();
    try {
      const bad = await t.fetch(t.base + '/api/sources/%E0', { method: 'DELETE', headers: J });
      assert.strictEqual(bad.status, 400);
      assert.ok((await bad.json()).error);
      const eng = await t.fetch(t.base + '/engine.js');
      assert.strictEqual(eng.status, 200);
      assert.match(await eng.text(), /Engine/);
    } finally {
      await t.stop();
    }
  });

  test('the engine is served even when the app lives under a dot-folder', () => {
    // send() refuses dot-folders in a bare absolute path; serving relative to `root` is what makes it work.
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    assert.match(app, /sendFile\(path\.basename\(ENGINE\), \{ root: path\.dirname\(ENGINE\) \}/);
  });

  test('settings: blank means default, and non-numbers are refused', async () => {
    const t = await startApp();
    try {
      const put = async (o) => (await (await t.fetch(t.base + '/api/settings', { method: 'PUT', headers: J, body: JSON.stringify(o) })).json()).settings;
      await put({ company: 'Acme', costOfSalesPct: 0.4, staleDays: 9, emailDomain: '@Acme.example' });
      const s = await put({ company: '', costOfSalesPct: null, overheadsMonthly: '', staleDays: true, termsDays: [], emailDomain: 5 });
      assert.strictEqual(s.company, 'Your company');
      assert.strictEqual(s.costOfSalesPct, 0.6);
      assert.strictEqual(s.overheadsMonthly, 0);
      assert.strictEqual(s.staleDays, 9, 'true is not a number');
      assert.strictEqual(s.termsDays, 30, '[] is not a number');
      assert.strictEqual(s.emailDomain, 'acme.example', 'a number is not a domain');
      assert.strictEqual((await put({ company: null })).company, 'Your company');
    } finally {
      await t.stop();
    }
  });

  test('re-uploading a file at the source limit replaces it', async () => {
    const t = await startApp({ cfg: { maxSources: 2 } });
    try {
      const L = 'Invoice No,Customer,Invoice Date,Due Date,Amount,Status\nINV-1,Acme,2026-10-01,2026-10-31,100,Open\n';
      assert.strictEqual((await upload(t, 'a.csv', L)).status, 201);
      assert.strictEqual((await upload(t, 'b.csv', L)).status, 201);
      assert.strictEqual((await upload(t, 'a.csv', L)).status, 201);
      assert.strictEqual((await upload(t, 'c.csv', L)).status, 422);
    } finally {
      await t.stop();
    }
  });

  test('a forwarded email with no Date header is not stored twice', async () => {
    const t = await startApp();
    try {
      const url = (await (await t.fetch(t.base + '/api/inbound', { method: 'POST', headers: J })).json()).inboundUrl.replace(/^https?:\/\/[^/]+/, t.base);
      const mail = 'From: ap@acme.example\nSubject: Remittance\n\nPaid INV-1 today.\n';
      for (let i = 0; i < 2; i++) await globalThis.fetch(url, { method: 'POST', headers: { 'Content-Type': 'message/rfc822' }, body: mail });
      const ws = await (await t.fetch(t.base + '/api/workspace')).json();
      assert.strictEqual(ws.sources.find((s) => s.kind === 'emails').stats.rows, 1);
    } finally {
      await t.stop();
    }
  });
});

describe('Google sync', () => {
  const GOOGLE = { googleClientId: 'cid.apps.googleusercontent.com', googleClientSecret: 'secret', publicUrl: 'https://trueline.example' };
  async function connected(g) {
    const t = await startApp({ cfg: GOOGLE, http: g.http, debounceMs: 60000 });
    const start = await t.fetch(t.base + '/api/google/start', { redirect: 'manual' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    await t.fetch(t.base + '/api/google/callback?code=ok&state=' + encodeURIComponent(state), { redirect: 'manual' });
    await t.fetch(t.base + '/api/sample/online-retail-ii', { method: 'POST', headers: J });
    t.syncNow = async () => (await (await t.fetch(t.base + '/api/google/sync', { method: 'POST', headers: J })).json()).result;
    return t;
  }

  test('a sync that fails halfway does not leave a duplicate calendar or events', async () => {
    const g = fakeGoogle();
    const t = await connected(g);
    try {
      let inserts = 0;
      g.fail = (method, u) => method === 'POST' && /\/events$/.test(u.pathname) && ++inserts === 4;
      assert.ok((await t.syncNow()).google.error);
      g.fail = null;
      const ok = await t.syncNow();
      assert.strictEqual(Object.keys(g.calendars).length, 1, 'one Trueline calendar');
      const events = Object.values(Object.values(g.calendars)[0]).map((e) => e.summary);
      assert.strictEqual(events.length, ok.google.events);
      assert.strictEqual(new Set(events).size, events.length, 'no duplicate events');
      assert.strictEqual(Object.keys(g.lists).length, 1);
    } finally {
      await t.stop();
    }
  });

  test('removing every file takes Trueline’s dates and tasks out of Google, once', async () => {
    const g = fakeGoogle();
    const t = await connected(g);
    try {
      await t.syncNow();
      const cal = Object.values(g.calendars)[0];
      assert.ok(Object.keys(cal).length > 0);
      await t.fetch(t.base + '/api/workspace', { method: 'DELETE', headers: J });
      const r = await t.syncNow();
      assert.strictEqual(r.google.events, 0);
      assert.strictEqual(Object.keys(cal).length, 0);
      assert.ok(Object.values(Object.values(g.lists)[0]).every((x) => x.status === 'completed'));
      assert.match(Object.values(g.docs)[0], /No files are connected/);
      assert.deepStrictEqual(await t.syncNow(), { skipped: 'no files' }, 'nothing left to clean up');
    } finally {
      await t.stop();
    }
  });
});

describe('the browser UI escapes references', () => {
  test('no invoice reference or fact id reaches HTML unescaped', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const lines = app.split('\n');
    const insideEsc = (n) => /esc\($/.test(lines[n - 1].trim()); // the line continues an esc( opened on the line above
    const raw = lines
      .map((l, i) => [i + 1, l])
      .filter(([n, l]) => /(^|[^.\w])(i|it|f)\.(ref|id)\s*\+\s*('|$)/.test(l) && !/esc\((i|it|f)\.(ref|id)\)/.test(l) && !insideEsc(n - 1));
    assert.deepStrictEqual(raw, []);
  });
});
