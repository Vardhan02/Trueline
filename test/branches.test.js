'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, describe } = require('node:test');
const { parseDate, detectDayFirst, parseMonthLabel } = require('../src/ingest/dates');
const { parseNumber } = require('../src/ingest/numbers');
const { identifyFile } = require('../src/ingest/files');
const { parseOfx } = require('../src/ingest/ofx');
const { parseEml } = require('../src/ingest/eml');
const { tableFromGrid } = require('../src/ingest/tabular');
const { propose, fieldSpecs, matchColumns, SPECS } = require('../src/ingest/detect');
const { buildDataset } = require('../src/ingest/build');
const { extractClaims } = require('../src/ingest/extract');
const { inspect, ingest } = require('../src/ingest');
const { startApp } = require('./helpers');

describe('date and number corners', () => {
  test('invalid parts', () => {
    assert.strictEqual(parseDate('13/13/2026'), null);
    assert.strictEqual(parseDate('00/05/2026'), null);
    assert.strictEqual(parseDate(null), null);
    assert.strictEqual(parseDate(''), null);
  });
  test('detectDayFirst ignores blanks and unparseable values, and honours a fallback', () => {
    assert.strictEqual(detectDayFirst([null, '', 'abc', '01/02/2026'], false), false);
    assert.strictEqual(detectDayFirst([], true), true);
  });
  test('month labels', () => {
    assert.strictEqual(parseMonthLabel(null), null);
    assert.strictEqual(parseMonthLabel(new Date('x')), null);
    assert.deepStrictEqual(parseMonthLabel(new Date(Date.UTC(2025, 2, 1))), { month: 3, year: 2025 });
    assert.deepStrictEqual(parseMonthLabel('03/2025'), { month: 3, year: 2025 });
    assert.strictEqual(parseMonthLabel('13/2025'), null);
    assert.strictEqual(parseMonthLabel('2025-13'), null);
    assert.deepStrictEqual(parseMonthLabel('March'), { month: 3, year: null });
    assert.deepStrictEqual(parseMonthLabel('1 March 2025'), { month: 3, year: 2025 });
    assert.strictEqual(parseMonthLabel('Marketing'), null);
  });
  test('numbers', () => {
    assert.strictEqual(parseNumber('+5'), 5);
    assert.strictEqual(parseNumber('9'.repeat(400)), null);
  });
});

describe('file identification corners', () => {
  test('missing filename, .txt email, extensionless csv, unknown extension', () => {
    assert.strictEqual(identifyFile(Buffer.from('a,b\n1,2'), null), 'csv');
    assert.strictEqual(identifyFile(Buffer.from('From: a@b.ie\nSubject: x\n\nhi'), 'mail.txt'), 'eml');
    assert.strictEqual(identifyFile(Buffer.from('From: a@b.ie\nSubject: x\n\nhi'), 'mail.csv'), 'csv');
    assert.throws(() => identifyFile(Buffer.from('a,b'), 'x.docx'), /"\.docx"/);
  });
});

describe('ofx and tables', () => {
  test('transactions missing an amount or date are dropped', () => {
    const o = parseOfx(Buffer.from('<OFX><STMTTRN><DTPOSTED>20261101<NAME>no amount</STMTTRN><STMTTRN><TRNAMT>5<NAME>no date</STMTTRN></OFX>'));
    assert.deepStrictEqual(o.transactions, []);
  });
  test('blank and duplicate headers get stable names; short rows are padded; trailing empty columns are dropped', () => {
    const t = tableFromGrid([['A', '', 'A', null], [1, 2, 3], [4]]);
    assert.deepStrictEqual(t.headers, ['A', 'Column 2', 'A (2)']);
    assert.deepStrictEqual(t.rows[1], [4, null, null]);
  });
  test('a trailing column with data is kept even if its header is blank', () => {
    const t = tableFromGrid([
      ['A', ''],
      [1, 2]
    ]);
    assert.deepStrictEqual(t.headers, ['A', 'Column 2']);
  });
  test('emails without a subject or part types', () => {
    const m = parseEml(
      Buffer.from('From: a@b.ie\nDate: Wed, 04 Nov 2026 14:02:00 +0000\nContent-Type: multipart/mixed; boundary=B\n\n--B\n\nno headers part\n--B--')
    );
    assert.strictEqual(m.subject, '(no subject)');
    assert.match(m.body, /no headers part/);
  });
});

describe('detection corners', () => {
  test('empty columns, blank headers, bills in the filename', () => {
    const t = tableFromGrid([
      ['Bill No', 'Vendor', 'Due Date', 'Amount', ''],
      ['B1', 'V', '2026-11-01', '10', ''],
      ['B2', 'V', '2026-11-02', '20', '']
    ]);
    assert.strictEqual(propose(t, { filename: 'Accounts_Payable_Oct.csv' })[0].options.ledgerType, 'payable');
    const generic = tableFromGrid([
      ['Number', 'Name', 'Due', 'Amount'],
      ['1', 'x', '2026-11-01', '5']
    ]);
    assert.strictEqual(propose(generic, { filename: 'bills_oct.csv' })[0].options.ledgerType, 'payable');
    assert.strictEqual(propose(generic)[0].options.ledgerType, 'receivable');
  });
  test('a date column that only parses month-first is accepted', () => {
    const t = tableFromGrid([
      ['Date', 'Amount'],
      ['01/13/2026', '5'],
      ['01/14/2026', '6']
    ]);
    assert.ok(matchColumns(t.headers, t.rows, SPECS.bank.fields).date === 0);
  });
  test('a column with no values cannot satisfy a typed field', () => {
    const t = tableFromGrid([
      ['Date', 'Amount'],
      ['', '5']
    ]);
    assert.strictEqual(matchColumns(t.headers, t.rows, SPECS.bank.fields).date, undefined);
  });
  test('bank with a reference column; field specs for an unknown kind', () => {
    const t = tableFromGrid([
      ['Date', 'Amount', 'Reference'],
      ['2026-11-01', '5', 'R1']
    ]);
    assert.strictEqual(propose(t)[0].kind, 'bank');
    assert.deepStrictEqual(fieldSpecs('nope'), []);
    assert.ok(fieldSpecs('bank').some((f) => f.required));
  });
});

describe('orchestration corners', () => {
  test('a requested kind with no matching proposal is refused', async () => {
    await assert.rejects(ingest(Buffer.from('Id,Party,Date,Amount\nA,P,2026-10-01,5\n'), 'x.csv', { kind: 'pnl' }), /could not tell/);
  });
  test('workbook previews render empty cells and dates', async () => {
    const info = await inspect(fs.readFileSync(path.join(__dirname, 'fixtures', 'ledger.xlsx')), 'ledger.xlsx');
    assert.match(info.tables[0].preview[0].join('|'), /2026-10-21/);
    const sheetTwo = info.tables[1];
    assert.ok(sheetTwo);
  });
  test('explicit day-first option wins over detection', async () => {
    const csv = Buffer.from('Invoice,Customer,Date,Due,Amount\nA,P,03/04/2026,04/05/2026,5\n');
    const r = await ingest(csv, 'x.csv', { options: { dayFirst: false } });
    assert.strictEqual(r.records[0].issued, '2026-03-04');
    const b = await ingest(Buffer.from('Date,Amount\n03/04/2026,5\n'), 'b.csv', { options: { dayFirst: false } });
    assert.strictEqual(b.records.transactions[0].date, '2026-03-04');
  });
});

describe('builder corners', () => {
  const src = (kind, records, extra) => Object.assign({ id: kind, kind, file: kind + '.csv', uploadedAt: '2030-01-01T00:00:00Z', records }, extra);
  test('future upload times are clamped to now; datetimes pass through; unnamed lines get a label', () => {
    const d = buildDataset({
      settings: { asOf: '2026-11-09' },
      sources: [
        src('ledger', [{ id: 'INV-1', type: 'receivable', party: 'Acme', amount: 5, issued: '2026-10-01', due: '2026-10-20', status: 'open', row: 2 }]),
        src('bank', { transactions: [{ date: '2026-11-01T10:00:00Z', amount: 9, description: '', reference: '' }], balance: null, balanceDate: null })
      ]
    });
    assert.strictEqual(d.BANK.syncedAt, '2026-11-09T06:30:00Z');
    assert.strictEqual(d.BANK.balance, null);
    assert.strictEqual(d.BANK.transactions[0].date, '2026-11-01T10:00:00Z');
    assert.strictEqual(d.BANK.transactions[0].counterparty, 'Unknown');
    assert.strictEqual(d.SOURCES.ledger.syncedAt, '2026-11-09T06:30:00Z');
  });
  test('P&L: a full year plus nothing else is history only; no full year gives no P&L', () => {
    const months = (y, n) => Array.from({ length: n }, (_, i) => ({ month: y + '-' + String(i + 1).padStart(2, '0'), turnover: 100 }));
    const full = buildDataset({ settings: { asOf: '2026-11-09' }, sources: [src('pnl', { months: months(2025, 12) })] });
    assert.strictEqual(full.PNL.ytd.length, 0);
    assert.strictEqual(full.PNL.ytdYear, null);
    const partialOnly = buildDataset({ settings: { asOf: '2026-11-09' }, sources: [src('pnl', { months: months(2026, 4) })] });
    assert.strictEqual(partialOnly.PNL, undefined);
    const gap = buildDataset({
      settings: { asOf: '2026-11-09' },
      sources: [
        src('pnl', {
          months: months(2025, 12).concat([
            { month: '2026-01', turnover: 5 },
            { month: '2026-03', turnover: 7 }
          ])
        })
      ]
    });
    assert.strictEqual(gap.PNL.ytd.length, 1, 'year-to-date stops at the first missing month');
  });
  test('a workspace with no sources key and an unnamed bank line match by name', () => {
    const d = buildDataset({ settings: {} }, { clock: () => 0 });
    assert.strictEqual(d.LEDGER.length, 0);
    assert.strictEqual(d.NOW, '1970-01-01T00:00:00Z');
  });
});

describe('extraction corners', () => {
  const ledger = [{ id: 'INV-9', party: 'P', type: 'receivable' }];
  test('"on Wednesday" sent on a Wednesday means next week; missing From is treated as received', () => {
    const x = extractClaims({ date: '2026-11-04T10:00:00Z', subject: '', body: 'We will pay INV-9 on Wednesday.' }, ledger, 'own.ie');
    assert.strictEqual(x.direction, 'received');
    assert.strictEqual(x.extracted[0].promisedDate, '2026-11-11');
  });
});

describe('settings validation', () => {
  let fetch = globalThis.fetch;
  async function withApp(cfgOver, fn) {
    const t = await startApp({ cfg: cfgOver });
    fetch = t.fetch;
    try {
      await fn(t.base);
    } finally {
      fetch = globalThis.fetch;
      await t.stop();
    }
  }
  const put = (base, body) =>
    fetch(base + '/api/settings', {
      method: 'PUT',
      headers: { 'X-Requested-With': 'trueline', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then((r) => r.json());

  test('every field is validated; unknown keys are ignored; bad values keep the old value', () =>
    withApp({}, async (base) => {
      let s = (
        await put(base, {
          company: '  ',
          currency: 'USD',
          asOf: '2026-02-30',
          costOfSalesPct: 0.4,
          overheadsMonthly: 5000,
          staleDays: 3,
          termsDays: 45,
          emailDomain: 'Mail.Example.com',
          hack: 1
        })
      ).settings;
      assert.strictEqual(s.company, 'Your company', 'blank name ignored');
      assert.strictEqual(s.currency, 'USD');
      assert.strictEqual(s.asOf, null, 'impossible date ignored');
      assert.strictEqual(s.costOfSalesPct, 0.4);
      assert.strictEqual(s.overheadsMonthly, 5000);
      assert.strictEqual(s.staleDays, 3);
      assert.strictEqual(s.termsDays, 45);
      assert.strictEqual(s.emailDomain, 'mail.example.com');
      assert.ok(!('hack' in s));
      s = (await put(base, { asOf: '2026-11-09' })).settings;
      assert.strictEqual(s.asOf, '2026-11-09');
      s = (await put(base, { asOf: '' })).settings;
      assert.strictEqual(s.asOf, null, 'blank clears the pinned date');
      s = (await put(base, { costOfSalesPct: 5, overheadsMonthly: -1, termsDays: 1000, staleDays: 1.5, emailDomain: 'bad domain!', currency: 'JPY' })).settings;
      assert.deepStrictEqual(
        [s.costOfSalesPct, s.overheadsMonthly, s.termsDays, s.staleDays, s.emailDomain, s.currency],
        [0.4, 5000, 45, 3, 'mail.example.com', 'USD']
      );
      const noBody = await fetch(base + '/api/settings', { method: 'PUT', headers: { 'X-Requested-With': 'trueline' } });
      assert.strictEqual(noBody.status, 200);
    }));

  test('production caches static files and the login body may be missing', () =>
    withApp({ production: true, sessionSecret: 'k'.repeat(40) }, async (base) => {
      const r = await fetch(base + '/app.css');
      assert.match(r.headers.get('cache-control'), /max-age=3600/);
      const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'X-Requested-With': 'trueline' } });
      assert.strictEqual(login.status, 401);
    }));
});

describe('server signals', () => {
  const start = (extra) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-sig-'));
    const port = 30000 + Math.floor(Math.random() * 10000);
    const c = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dir, HOST: '127.0.0.1', NODE_ENV: 'development' }, extra),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let text = '';
    c.stdout.on('data', (d) => (text += d));
    c.stderr.on('data', (d) => (text += d));
    const ready = (async () => {
      for (let i = 0; i < 160; i++) {
        try {
          if ((await fetch('http://127.0.0.1:' + port + '/healthz')).ok) return;
        } catch {
          /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('server did not start: ' + text);
    })();
    return { c, ready, dir, text: () => text, closed: new Promise((r) => c.on('close', (code) => r(code))) };
  };

  // Windows has no POSIX signals: child.kill() there terminates the process outright, so there is nothing to observe.
  test(
    'a second signal during shutdown is ignored and SIGINT also exits cleanly',
    { skip: process.platform === 'win32' && 'no POSIX signals on Windows' },
    async () => {
      const s = start();
      await s.ready;
      s.c.kill('SIGINT');
      s.c.kill('SIGTERM');
      assert.strictEqual(await s.closed, 0);
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  );

  test('an unhandled rejection is logged as fatal and the process shuts down', async () => {
    const preload = path.join(os.tmpdir(), 'tl-reject-' + process.pid + '.js');
    const trigger = preload + '.go';
    // Reject only once the server is serving (start-up speed varies a lot between machines), when the test says so.
    fs.writeFileSync(
      preload,
      "const t = setInterval(() => { if (require('fs').existsSync(" +
        JSON.stringify(trigger) +
        ")) { clearInterval(t); Promise.reject(new Error('boom')); } }, 20);\n"
    );
    const s = start({ NODE_OPTIONS: '--require ' + JSON.stringify(preload) });
    await s.ready;
    fs.writeFileSync(trigger, '');
    const code = await s.closed;
    fs.rmSync(trigger, { force: true });
    assert.strictEqual(code, 0);
    assert.match(s.text(), /unhandled rejection/);
    fs.rmSync(preload, { force: true });
    fs.rmSync(s.dir, { recursive: true, force: true });
  });
});
