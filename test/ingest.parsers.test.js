'use strict';

const assert = require('node:assert');
const { test, describe } = require('node:test');
const { parseNumber } = require('../src/ingest/numbers');
const { parseDate, detectDayFirst, parseMonthLabel } = require('../src/ingest/dates');
const { identifyFile, decodeText, UnsupportedFileError } = require('../src/ingest/files');
const { readDelimited, readWorkbook, detectDelimiter } = require('../src/ingest/tabular');
const { parseOfx } = require('../src/ingest/ofx');
const { parseEml } = require('../src/ingest/eml');
const { fixture } = require('./helpers');

describe('parseNumber', () => {
  const cases = [
    ['1,234.50', 1234.5],
    ['1.234,50', 1234.5],
    ['(500.00)', -500],
    ['-500', -500],
    ['500-', -500],
    ['£1,200', 1200],
    ['€ 1 200,00', 1200],
    ['12,5', 12.5],
    ['1200 EUR', 1200],
    [42, 42],
    ['', null],
    ['abc', null],
    [null, null]
  ];
  cases.forEach(([input, expected]) => test(JSON.stringify(input) + ' -> ' + expected, () => assert.strictEqual(parseNumber(input), expected)));
});

describe('parseDate', () => {
  test('common formats', () => {
    ['2026-11-09', '09/11/2026', '9 Nov 2026', 'Nov 9, 2026', '20261109120000', '09.11.2026'].forEach((v) => assert.strictEqual(parseDate(v), '2026-11-09', v));
  });
  test('Excel serial and Date objects', () => {
    assert.strictEqual(parseDate(46335), '2026-11-09');
    assert.strictEqual(parseDate(new Date(Date.UTC(2026, 10, 9))), '2026-11-09');
  });
  test('rejects impossible dates', () => {
    assert.strictEqual(parseDate('31/02/2026'), null);
    assert.strictEqual(parseDate('hello'), null);
  });
  test('day-first is guessed from the column', () => {
    assert.strictEqual(detectDayFirst(['13/01/2026', '02/03/2026']), true);
    assert.strictEqual(detectDayFirst(['01/13/2026', '03/02/2026']), false);
    assert.strictEqual(parseDate('03/04/2026', { dayFirst: true }), '2026-04-03');
    assert.strictEqual(parseDate('03/04/2026', { dayFirst: false }), '2026-03-04');
  });
  test('month labels', () => {
    assert.deepStrictEqual(parseMonthLabel('Jan-25'), { year: 2025, month: 1 });
    assert.deepStrictEqual(parseMonthLabel('2025-03'), { year: 2025, month: 3 });
    assert.strictEqual(parseMonthLabel('Turnover'), null);
  });
});

describe('file identification', () => {
  test('recognises each supported type by content', () => {
    assert.strictEqual(identifyFile(fixture('ledger_uk.csv'), 'a.csv'), 'csv');
    assert.strictEqual(identifyFile(fixture('ledger.xlsx'), 'a.xlsx'), 'xlsx');
    assert.strictEqual(identifyFile(fixture('statement.ofx'), 'a.ofx'), 'ofx');
    assert.strictEqual(identifyFile(fixture('remittance.eml'), 'a.eml'), 'eml');
  });
  test('refuses what it cannot read, with advice', () => {
    assert.throws(() => identifyFile(Buffer.from('%PDF-1.4 x'), 'a.pdf'), /PDFs are not supported/);
    assert.throws(() => identifyFile(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0]), 'a.xls'), /\.xls/);
    assert.throws(() => identifyFile(fixture('fake.xlsx'), 'fake.xlsx'), /not a valid \.xlsx/);
    assert.throws(() => identifyFile(fixture('garbage.bin'), 'x.csv'), UnsupportedFileError);
    assert.throws(() => identifyFile(Buffer.alloc(0), 'x.csv'), /empty/);
    assert.throws(() => identifyFile(Buffer.from('a,b'), 'x.docx'), /Unsupported file type/);
  });
  test('a renamed zip is not trusted as xlsx', () => {
    assert.throws(() => identifyFile(Buffer.from([0x50, 0x4b, 3, 4, 0]), 'x.csv'), /zip archive/);
  });
  test('decodes UTF-8 with BOM and Windows-1252', () => {
    assert.strictEqual(decodeText(Buffer.from('﻿hello')), 'hello');
    assert.match(decodeText(fixture('ledger_cp1252.csv')), /Café Zürich/);
  });
});

describe('tabular readers', () => {
  test('detects delimiters', () => {
    assert.strictEqual(detectDelimiter('a;b;c\n1;2;3'), ';');
    assert.strictEqual(detectDelimiter('a\tb\n1\t2'), '\t');
    assert.strictEqual(detectDelimiter('a,b,c\n1,2,3'), ',');
  });
  test('reads CSV and keeps original line numbers', () => {
    const t = readDelimited(fixture('ledger_uk.csv'));
    assert.deepStrictEqual(t.headers.slice(0, 3), ['Invoice No', 'Customer', 'Invoice Date']);
    assert.strictEqual(t.rows.length, 8);
    assert.strictEqual(t.lines[0], 2);
  });
  test('reads every sheet of a workbook and skips title rows above the header', async () => {
    const sheets = await readWorkbook(fixture('ledger.xlsx'));
    assert.strictEqual(sheets[0].headers[0], 'Invoice Number');
    assert.strictEqual(sheets[0].rows.length, 2);
    assert.strictEqual(sheets[0].lines[0], 4);
  });
});

describe('OFX and EML', () => {
  test('OFX transactions, signs and balance', () => {
    const o = parseOfx(fixture('statement.ofx'));
    assert.strictEqual(o.transactions.length, 2);
    assert.deepStrictEqual(
      o.transactions.map((t) => t.amount),
      [18400, -2000]
    );
    assert.strictEqual(o.transactions[0].date, '2026-11-01');
    assert.strictEqual(o.balance, 23000);
    assert.strictEqual(o.currency, 'EUR');
  });
  test('EML headers and body', () => {
    const m = parseEml(fixture('remittance.eml'));
    assert.strictEqual(m.from, 'ap@acme.ie');
    assert.strictEqual(m.subject, 'Remittance advice: INV-1001');
    assert.ok(m.date.startsWith('2026-11-04T14:02'));
    assert.match(m.body, /released payment of €18,400 for INV-1001/);
  });
  test('EML decodes quoted-printable and encoded subjects', () => {
    const raw =
      'From: a@b.ie\nTo: c@d.ie\nDate: Wed, 04 Nov 2026 14:02:00 +0000\nSubject: =?UTF-8?B?Q2Fmw6k=?=\nContent-Transfer-Encoding: quoted-printable\n\nPay =E2=82=AC100 now';
    const m = parseEml(Buffer.from(raw));
    assert.strictEqual(m.subject, 'Café');
    assert.strictEqual(m.body.trim(), 'Pay €100 now');
  });
});
