'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, describe } = require('node:test');
const pino = require('pino');
const { parseEml } = require('../src/ingest/eml');
const { parseOfx } = require('../src/ingest/ofx');
const { normalize } = require('../src/ingest/normalize');
const { ingest, inspect } = require('../src/ingest');
const { tableFromGrid } = require('../src/ingest/tabular');
const { loadSample, listSamples } = require('../src/samples');
const { WorkspaceStore } = require('../src/store/workspaceStore');
const { AccountStore } = require('../src/store/accountStore');
const { createLogger } = require('../src/logger');
const { loadConfig } = require('../src/config');
const { createAuth } = require('../src/auth');
const { startApp } = require('./helpers');
const { parseNumber } = require('../src/ingest/numbers');
const { extractClaims } = require('../src/ingest/extract');

const eml = (headers, body) => parseEml(Buffer.from(headers.join('\n') + '\n\n' + body));
const BASE = ['From: a@b.ie', 'To: c@d.ie', 'Date: Wed, 04 Nov 2026 14:02:00 +0000', 'Subject: Hi'];

describe('eml bodies', () => {
  test('multipart prefers text/plain', () => {
    const m = eml(
      BASE.concat('Content-Type: multipart/alternative; boundary="XX"'),
      '--XX\nContent-Type: text/html\n\n<p>html</p>\n--XX\nContent-Type: text/plain\n\nplain text\n--XX--'
    );
    assert.strictEqual(m.body.trim(), 'plain text');
  });
  test('multipart with only html falls back to stripped html', () => {
    const m = eml(
      BASE.concat('Content-Type: multipart/alternative; boundary=XX'),
      '--XX\nContent-Type: text/html\n\n<style>p{}</style><p>Pay &pound;5 &amp; more&nbsp;now<br>line &lt;2&gt; &quot;q&quot; it&#39;s</p>\n--XX--'
    );
    assert.match(m.body, /Pay &pound;5 & more now/);
    assert.match(m.body, /<2> "q" it's/);
  });
  test('multipart with empty parts gives empty text', () => {
    assert.strictEqual(eml(BASE.concat('Content-Type: multipart/mixed; boundary=XX'), '--XX\nContent-Type: text/plain\n\n\n--XX--').body.trim(), '');
  });
  test('plain html message', () => {
    assert.strictEqual(eml(BASE.concat('Content-Type: text/html'), '<div>Hello</div>').body.trim(), 'Hello');
  });
  test('base64 body and q-encoded subject', () => {
    const m = eml(
      BASE.slice(0, 3).concat('Subject: =?UTF-8?Q?Caf=C3=A9_au_lait?=', 'Content-Transfer-Encoding: base64'),
      Buffer.from('Hello €').toString('base64')
    );
    assert.strictEqual(m.body.trim(), 'Hello €');
    assert.strictEqual(m.subject, 'Café au lait');
  });
  test('missing headers and body do not crash', () => {
    const m = parseEml(Buffer.from('Subject: only'));
    assert.strictEqual(m.subject, 'only');
    assert.strictEqual(m.body, '');
    assert.strictEqual(m.date, null);
  });
  test('folded headers are joined and the first duplicate wins', () => {
    const m = parseEml(Buffer.from('Subject: long\n subject\nSubject: ignored\nDate: Wed, 04 Nov 2026 14:02:00 +0000\n\nx'));
    assert.strictEqual(m.subject, 'long subject');
  });
});

describe('ofx variants', () => {
  test('XML-style tags, missing balance and currency', () => {
    const o = parseOfx(Buffer.from('<OFX><STMTTRN><DTPOSTED>20261101</DTPOSTED><TRNAMT>-5,00</TRNAMT><NAME>X</NAME></STMTTRN></OFX>'));
    assert.strictEqual(o.transactions.length, 1);
    assert.strictEqual(o.balance, null);
    assert.strictEqual(o.transactions[0].id, null);
  });
  test('an OFX with no transactions yields an empty list', () => {
    assert.deepStrictEqual(parseOfx(Buffer.from('<OFX></OFX>')).transactions, []);
  });
});

describe('normalisation edge cases', () => {
  const grid = (rows) => tableFromGrid(rows);
  test('unknown kind throws', () => assert.throws(() => normalize('nope', grid([['a'], ['1']]), {}), /Unknown kind/));
  test('wide-years layout (one row per year, months across)', () => {
    const t = grid([
      ['Year', 'Jan', 'Feb', 'Mar'],
      [2025, 100, 200, 300],
      ['n/a', 1, 2, 3]
    ]);
    const r = normalize('pnl', t, { months: [1, 2, 3] }, { layout: 'wide-years' });
    assert.deepStrictEqual(
      r.records.months.map((m) => m.month),
      ['2025-01', '2025-02', '2025-03']
    );
    assert.ok(r.issues.some((i) => /No year/.test(i.message)));
  });
  test('wide-items without a turnover row finds nothing and says so', () => {
    const t = grid([
      ['Line', 'Jan-25', 'Feb-25'],
      ['Costs', 1, 2]
    ]);
    const r = normalize('pnl', t, { months: [1, 2] }, { layout: 'wide-items' });
    assert.strictEqual(r.records.months.length, 0);
    assert.match(r.notes[0], /No monthly turnover/);
    assert.strictEqual(r.range, null);
  });
  test('long P&L: months without a year and unreadable months are reported', () => {
    const t = grid([
      ['Month', 'Turnover'],
      ['Jan', 100],
      ['bogus', 5],
      ['2025-02', 'x']
    ]);
    const r = normalize('pnl', t, { period: 0, turnover: 1 }, {});
    assert.strictEqual(r.records.months.length, 0);
    assert.ok(r.issues.length >= 2);
  });
  test('P&L scale option multiplies values', () => {
    const t = grid([
      ['Month', 'Turnover'],
      ['2025-01', 5]
    ]);
    assert.strictEqual(normalize('pnl', t, { period: 0, turnover: 1 }, { scale: 1000 }).records.months[0].turnover, 5000);
  });
  test('bank balance direction: oldest-first, newest-first and ambiguous ties', () => {
    const rows = (list) => grid([['Date', 'Amount', 'Balance']].concat(list));
    const asc = normalize(
      'bank',
      rows([
        ['2026-11-01', 10, 110],
        ['2026-11-02', 20, 130],
        ['2026-11-03', 5, 135]
      ]),
      { date: 0, amount: 1, balance: 2 },
      {}
    );
    assert.strictEqual(asc.records.balance, 135);
    const desc = normalize(
      'bank',
      rows([
        ['2026-11-03', 5, 135],
        ['2026-11-02', 20, 130],
        ['2026-11-01', 10, 110]
      ]),
      { date: 0, amount: 1, balance: 2 },
      {}
    );
    assert.strictEqual(desc.records.balance, 135);
    const tieNewestFirst = normalize(
      'bank',
      rows([
        ['2026-11-03', 5, 999],
        ['2026-11-01', 5, 111]
      ]),
      { date: 0, amount: 1, balance: 2 },
      {}
    );
    assert.strictEqual(tieNewestFirst.records.balance, 999, 'falls back to the latest date');
    const tieOldestFirst = normalize(
      'bank',
      rows([
        ['2026-11-01', 5, 111],
        ['2026-11-03', 5, 999]
      ]),
      { date: 0, amount: 1, balance: 2 },
      {}
    );
    assert.strictEqual(tieOldestFirst.records.balance, 999);
  });
  test('bank rows with a bad date or no amount are skipped with reasons', () => {
    const t = grid([
      ['Date', 'Amount', 'Description'],
      ['nope', 5, 'a'],
      ['2026-11-01', '', 'b'],
      ['2026-11-02', 7, 'c']
    ]);
    const r = normalize('bank', t, { date: 0, amount: 1, description: 2 }, {});
    assert.strictEqual(r.records.transactions.length, 1);
    assert.deepStrictEqual(r.issues.map((i) => i.message).sort(), ['Date not recognised', 'No amount']);
    assert.match(r.notes[0], /No balance column/);
  });
  test('ledger: zero amounts, unknown status words, type column, bills by supplier name, partial amounts owed', () => {
    const t = grid([
      ['Doc', 'Name', 'Date', 'Due', 'Amount', 'Owed', 'Status', 'Type'],
      ['A', 'X', '2026-10-01', '2026-10-30', 0, 0, '', ''],
      ['B', 'Y', '2026-10-01', '2026-10-30', 100, 40, '', 'Purchase bill'],
      ['C', 'Z', '2026-10-01', '2026-10-30', 100, '', 'whatever', 'credit memo'],
      ['D', 'W', '2026-10-01', '2026-10-30', 100, '', 'whatever', 'sales invoice'],
      ['E', '', '', '', 100, '', '', '']
    ]);
    const m = { id: 0, party: 1, issued: 2, due: 3, amount: 4, outstanding: 5, status: 6, type: 7 };
    const r = normalize('ledger', t, m, {});
    const byId = Object.fromEntries(r.records.map((x) => [x.id, x]));
    assert.strictEqual(byId.B.type, 'payable');
    assert.strictEqual(byId.B.amount, 40, 'amount still owed replaces the invoice amount');
    assert.strictEqual(byId.D.type, 'receivable');
    assert.ok(!byId.A && !byId.C && !byId.E);
    assert.ok(r.issues.some((i) => /Zero amount/.test(i.message)));
    assert.ok(r.issues.some((i) => /Credit note/.test(i.message)));
    assert.ok(r.issues.some((i) => /No invoice date or due date/.test(i.message)));
    assert.ok(r.notes.some((n) => /status we did not recognise/.test(n)));
  });
  test('ledger: only a due date, only an issue date, outstanding-only amount, unnamed party, payable option', () => {
    const t = grid([
      ['Doc', 'Party', 'Date', 'Due', 'Owed'],
      ['A', '', '', '2026-11-30', 50],
      ['B', 'Q', '2026-10-01', '', 0]
    ]);
    const r = normalize('ledger', t, { id: 0, party: 1, issued: 2, due: 3, outstanding: 4 }, { ledgerType: 'payable', termsDays: 10 });
    const a = r.records.find((x) => x.id === 'A');
    assert.strictEqual(a.issued, '2026-11-20');
    assert.strictEqual(a.party, 'Unnamed supplier');
    assert.strictEqual(a.type, 'payable');
    assert.ok(!r.records.find((x) => x.id === 'B'), 'nothing owed and no invoice amount: nothing to track');
  });
  test('issues are capped so a bad file cannot flood the response', () => {
    const rows = [['Id', 'Party', 'Date', 'Amount']];
    for (let i = 0; i < 100; i++) rows.push(['I' + i, 'P', '2026-10-01', 'bad']);
    const r = normalize('ledger', grid(rows), { id: 0, party: 1, issued: 2, amount: 3 }, {});
    assert.strictEqual(r.issues.length, 25);
    assert.strictEqual(r.stats.skipped, 100);
  });
});

describe('ingest orchestration', () => {
  const csv = (s) => Buffer.from(s);
  test('inspect of an empty-looking workbook or csv is refused', async () => {
    await assert.rejects(inspect(csv('\n\n'), 'x.csv'), /No data|empty/);
  });
  test('a chosen sheet that does not exist is refused', async () => {
    await assert.rejects(ingest(csv('a,b\n1,2\n'), 'x.csv', { kind: 'ledger', mapping: {}, table: 5 }), /sheet does not exist/);
  });
  test('an undetectable file without a kind is refused with advice', async () => {
    await assert.rejects(ingest(csv('foo,bar\n1,2\n'), 'x.csv', {}), /could not tell/);
  });
  test('a valid mapping with no usable rows is refused with the first reason', async () => {
    await assert.rejects(ingest(csv('Id,Party,Date,Amount\nA,P,2026-10-01,bad\n'), 'x.csv', {}), /No usable rows/);
    await assert.rejects(ingest(csv('Date,Amount\nbad,1\n'), 'x.csv', { kind: 'bank', mapping: { date: 0, amount: 1 } }), /No usable rows/);
  });
  test('a requested kind picks the matching proposal, even when another scores higher', async () => {
    const r = await ingest(csv('Date,Description,Amount\n2026-11-01,Pay,10\n'), 'x.csv', { kind: 'bank' });
    assert.strictEqual(r.kind, 'bank');
  });
  test('pnl needs no required-column check when months run across', async () => {
    const r = await ingest(csv('Line,' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'].map((m) => m + '-25').join(',') + '\nTurnover,1,2,3,4,5,6\n'), 'p.csv', {});
    assert.strictEqual(r.records.months.length, 6);
  });
  test('wide P&L with months but no year in the headers', async () => {
    const info = await inspect(csv('Year,Jan,Feb,Mar,Apr,May,Jun\n2025,1,2,3,4,5,6\n'), 'p.csv');
    assert.strictEqual(info.kind, 'pnl');
    assert.strictEqual(info.tables[0].proposals[0].layout, 'wide-years');
  });
  test('inspect reports previews with dates as text', async () => {
    const info = await inspect(csv('Date,Amount,Description\n2026-11-01,5,x\n'), 'b.csv');
    assert.deepStrictEqual(info.tables[0].preview[0], ['2026-11-01', '5', 'x']);
  });
  test('a bank file with only credit or only debit still reads', async () => {
    const r = await ingest(csv('Date,Description,Credit\n01/11/2026,Pay,10\n'), 'b.csv', {});
    assert.strictEqual(r.records.transactions[0].amount, 10);
  });
});

describe('undated emails', () => {
  test('use the upload time and say so', async () => {
    const r = await ingest(Buffer.from('Subject: x\nFrom: a@b.ie\n\nhello'), 'x.eml', {});
    assert.ok(r.records[0].date);
    assert.match(r.notes[0], /no Date header/);
  });
});

describe('number and date corners', () => {
  test('separators', () => {
    assert.strictEqual(parseNumber('1,234'), 1234);
    assert.strictEqual(parseNumber('1,234,567'), 1234567);
    assert.strictEqual(parseNumber('1.234.567'), 1234567);
    assert.strictEqual(parseNumber('12.50'), 12.5);
    assert.strictEqual(parseNumber(NaN), null);
    assert.strictEqual(parseNumber(Infinity), null);
    assert.strictEqual(parseNumber('--'), null);
  });
});

describe('claim extraction corners', () => {
  const ledger = [{ id: 'INV-9', party: 'P', type: 'receivable' }];
  const mk = (body, extra) => Object.assign({ from: 'x@y.ie', date: '2026-11-04T10:00:00Z', subject: '', body }, extra);
  test('dates: "5 Nov", past-dated roll to next year, weekday, no date, bad sent date', () => {
    const get = (b, d) => extractClaims(mk(b, d ? { date: d } : {}), ledger, '').extracted[0];
    assert.strictEqual(get('We will pay INV-9 on 5 Nov.').promisedDate, '2026-11-05');
    assert.strictEqual(get('We will pay INV-9 on 2 Jan.').promisedDate, '2027-01-02');
    assert.strictEqual(get('We will pay INV-9 on Monday.').promisedDate, '2026-11-09');
    assert.strictEqual(get('We will pay INV-9 soon.').promisedDate, undefined);
    assert.strictEqual(get('We will pay INV-9 on Monday.', 'garbage').promisedDate, undefined);
  });
  test('partial payment wording and no duplicates of the same claim', () => {
    const x = extractClaims(mk('We have paid INV-9 today. We have paid INV-9 again. The balance will follow next week.'), ledger, '').extracted;
    assert.strictEqual(x.length, 1);
    assert.strictEqual(x[0].claim, 'partial_paid');
  });
  test('a receivable chased by the other side is a received chase; unknown wording is ignored', () => {
    assert.strictEqual(extractClaims(mk('INV-9 is overdue, please arrange payment.'), ledger, '').extracted[0].kind, 'chase_received');
    assert.deepStrictEqual(extractClaims(mk('Lovely weather for INV-9.'), ledger, '').extracted, []);
    assert.deepStrictEqual(extractClaims(mk('A reminder to be nice about INV-9.', { from: 'me@own.ie' }), ledger, 'own.ie').extracted[0].kind, 'chase_sent');
    assert.deepStrictEqual(extractClaims(mk('Nothing relevant INV-9 mentioned.', { from: 'me@own.ie' }), ledger, '@own.ie').extracted, []);
  });
});

describe('samples', () => {
  test('lists the bundled sample', () => assert.ok(listSamples().some((s) => s.name === 'online-retail-ii')));
  test('rejects bad and missing names', async () => {
    assert.strictEqual(await loadSample('../x', ingest), null);
    assert.strictEqual(await loadSample('does-not-exist', ingest), null);
  });
});

describe('store errors', () => {
  test('a corrupt workspace file is reported, not silently replaced', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-bad-'));
    fs.writeFileSync(path.join(dir, 'workspace.json'), '{not json');
    await assert.rejects(new WorkspaceStore(dir).load(), SyntaxError);
    fs.rmSync(dir, { recursive: true });
  });
  test('ping fails when the data directory is gone', async () => {
    const s = new WorkspaceStore(path.join(os.tmpdir(), 'tl-missing-' + Date.now()));
    await assert.rejects(s.ping());
  });
  test('a file with no sources key loads as empty', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-nosrc-'));
    fs.writeFileSync(path.join(dir, 'workspace.json'), '{"settings":{"company":"Z"}}');
    const ws = await new WorkspaceStore(dir).load();
    assert.deepStrictEqual(ws.sources, []);
    assert.strictEqual(ws.settings.company, 'Z');
    fs.rmSync(dir, { recursive: true });
  });
});

describe('logger and config corners', () => {
  test('logger redacts cookies', () => {
    const lines = [];
    const log = pino({ level: 'info', redact: ['req.headers.cookie'] }, { write: (s) => lines.push(s) });
    log.info({ req: { headers: { cookie: 'secret' } } }, 'x');
    assert.ok(!lines[0].includes('secret'));
    assert.strictEqual(createLogger('warn').level, 'warn');
    assert.strictEqual(createLogger().level, 'info');
  });
  test('config reads env overrides', () => {
    const c = loadConfig({
      COOKIE_SECURE: 'false',
      NODE_ENV: 'production',
      SESSION_SECRET: 'x'.repeat(40),
      ENCRYPTION_KEY: 'e'.repeat(40),
      PUBLIC_URL: 'https://x.example',
      PORT: '8080',
      LOG_LEVEL: 'warn',
      MAX_SOURCES: '5'
    });
    assert.strictEqual(c.cookieSecure, false);
    assert.strictEqual(c.port, 8080);
    assert.strictEqual(c.maxSources, 5);
    assert.strictEqual(loadConfig({ COOKIE_SECURE: 'true' }).cookieSecure, true);
  });
  test('auth without a configured secret generates one for development, and rejects junk cookies', async () => {
    const user = { id: 'u_1', sv: 0 };
    const a = createAuth({ sessionHours: 1, cookieSecure: true }, { get: async (id) => (id === 'u_1' ? user : null) });
    let header;
    a.login({ setHeader: (_k, v) => (header = v) }, user);
    assert.match(header, /Secure/);
    assert.strictEqual(await a.userOf({ headers: { cookie: header.split(';')[0] } }), user);
    assert.strictEqual(await a.userOf({ headers: { cookie: 'tl_session=%E0%A4%A' } }), null, 'malformed encoding is ignored');
    assert.strictEqual(await a.userOf({ headers: { cookie: 'tl_session=a.b.c.d' } }), null);
    a.logout({ setHeader: (_k, v) => (header = v) });
    assert.match(header, /Max-Age=0/);
    let status;
    await new Promise((done) => a.require({ headers: {} }, { status: (s) => ({ json: () => ((status = s), done()) }) }, done));
    assert.strictEqual(status, 401);
  });
});

describe('server process', () => {
  const run = (env) =>
    spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: Object.assign({}, process.env, env), stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = (child) => {
    const out = { text: '' };
    child.stdout.on('data', (d) => (out.text += d));
    child.stderr.on('data', (d) => (out.text += d));
    return out;
  };
  const until = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };

  test('exits non-zero with a readable message on bad production config', async () => {
    const c = run({ NODE_ENV: 'production', SESSION_SECRET: '', ENCRYPTION_KEY: '' });
    const out = collect(c);
    const code = await new Promise((r) => c.on('close', r));
    assert.strictEqual(code, 1);
    assert.match(out.text, /ENCRYPTION_KEY/);
  });

  test('starts, serves health, and shuts down cleanly on SIGTERM', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-srv-'));
    const port = 20000 + Math.floor(Math.random() * 10000);
    const c = run({
      PORT: String(port),
      DATA_DIR: dir,
      SESSION_SECRET: '',
      ENCRYPTION_KEY: '',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      NODE_ENV: 'development',
      HOST: '127.0.0.1'
    });
    const out = collect(c);
    const up = await until(async () => {
      try {
        return (await fetch('http://127.0.0.1:' + port + '/healthz')).ok;
      } catch {
        return false;
      }
    });
    assert.ok(up, out.text);
    assert.match(out.text, /ENCRYPTION_KEY is not set/);
    assert.match(out.text, /Google is not configured/);
    const closed = new Promise((r) => c.on('close', (code) => r(code)));
    c.kill('SIGTERM');
    assert.strictEqual(await closed, 0);
    assert.match(out.text, /shutting down/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('API error paths', () => {
  const H = { 'X-Requested-With': 'trueline', 'Content-Type': 'application/json' };
  let fetch = globalThis.fetch; // swapped for the signed-in fetch inside withApp
  async function withApp(override, fn, cfgOver) {
    const t = await startApp({ cfg: cfgOver, override: override || undefined, signup: !(override && override.accounts) });
    fetch = t.fetch;
    try {
      await fn(t.base);
    } finally {
      fetch = globalThis.fetch;
      await t.stop();
    }
  }
  const form = (name, buf, choice) => {
    const f = new FormData();
    if (buf) f.append('file', new Blob([buf]), name);
    if (choice !== undefined) f.append('choice', choice);
    return f;
  };

  test('unexpected failures are 500 with a request id and no internals', () =>
    withApp(
      {
        workspaceFor: () =>
          Object.assign(new WorkspaceStore(os.tmpdir()), {
            load: async () => {
              throw new Error('disk exploded: /secret/path');
            }
          })
      },
      async (base) => {
        const r = await fetch(base + '/api/workspace');
        assert.strictEqual(r.status, 500);
        const j = await r.json();
        assert.ok(j.requestId);
        assert.ok(!JSON.stringify(j).includes('secret'));
      }
    ));
  test('readyz reports failure when the store is down', () =>
    withApp(
      {
        accounts: Object.assign(new AccountStore(os.tmpdir()), {
          ping: async () => {
            throw new Error('down');
          }
        })
      },
      async (base) => assert.strictEqual((await fetch(base + '/readyz')).status, 500)
    ));
  test('logout, missing file, bad choice JSON, bad sheet, clear workspace', () =>
    withApp(null, async (base) => {
      assert.strictEqual((await fetch(base + '/api/logout', { method: 'POST', headers: H })).status, 200);
      assert.strictEqual(
        (await fetch(base + '/api/upload/inspect', { method: 'POST', headers: { 'X-Requested-With': 'trueline' }, body: form('x', null) })).status,
        400
      );
      assert.strictEqual(
        (await fetch(base + '/api/upload/commit', { method: 'POST', headers: { 'X-Requested-With': 'trueline' }, body: form('x', null) })).status,
        400
      );
      const csv = Buffer.from('Invoice,Customer,Date,Amount\nA,B,2026-10-01,5\n');
      const bad = await fetch(base + '/api/upload/commit', { method: 'POST', headers: { 'X-Requested-With': 'trueline' }, body: form('a.csv', csv, '{oops') });
      assert.strictEqual(bad.status, 400);
      const ok = await fetch(base + '/api/upload/commit', { method: 'POST', headers: { 'X-Requested-With': 'trueline' }, body: form('a.csv', csv, '') });
      assert.strictEqual(ok.status, 201);
      assert.strictEqual((await fetch(base + '/api/workspace', { method: 'DELETE', headers: H })).status, 200);
      const w = await (await fetch(base + '/api/workspace')).json();
      assert.strictEqual(w.sources.length, 0);
    }));
  test('source limit is enforced', () =>
    withApp(
      null,
      async (base) => {
        const csv = (n) => Buffer.from('Invoice,Customer,Date,Amount\nA' + n + ',B,2026-10-01,5\n');
        const up = (n) =>
          fetch(base + '/api/upload/commit', { method: 'POST', headers: { 'X-Requested-With': 'trueline' }, body: form('f' + n + '.csv', csv(n), '') });
        assert.strictEqual((await up(1)).status, 201);
        const second = await up(2);
        assert.strictEqual(second.status, 422);
        assert.match((await second.json()).error, /Source limit/);
      },
      { maxSources: 1 }
    ));
  test('only 20 or fewer files in flight: unknown sample is 404', () =>
    withApp(null, async (base) => assert.strictEqual((await fetch(base + '/api/sample/nope', { method: 'POST', headers: H })).status, 404)));
  test('too many login attempts are rate limited', () =>
    withApp(
      null,
      async (base) => {
        let last;
        for (let i = 0; i < 12; i++)
          last = await fetch(base + '/api/login', { method: 'POST', headers: H, body: JSON.stringify({ email: 'x@y.ie', password: 'x' }) });
        assert.strictEqual(last.status, 429);
      },
      { authAttempts: 10 }
    ));
});
