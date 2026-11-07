'use strict';

const assert = require('node:assert');
const { test, describe } = require('node:test');
const { inspect, ingest } = require('../src/ingest');
const { extractClaims } = require('../src/ingest/extract');
const { buildDataset, matchBank } = require('../src/ingest/build');
const { fixture } = require('./helpers');

describe('detection', () => {
  const kindOf = async (f) => (await inspect(fixture(f), f)).kind;
  test('classifies each fixture', async () => {
    assert.strictEqual(await kindOf('ledger_uk.csv'), 'ledger');
    assert.strictEqual(await kindOf('ledger_eu.csv'), 'ledger');
    assert.strictEqual(await kindOf('ledger.xlsx'), 'ledger');
    assert.strictEqual(await kindOf('bank_credit_debit.csv'), 'bank');
    assert.strictEqual(await kindOf('bank_newest_first.csv'), 'bank');
    assert.strictEqual(await kindOf('pnl_long.csv'), 'pnl');
    assert.strictEqual(await kindOf('pnl_wide.csv'), 'pnl');
    assert.strictEqual(await kindOf('pnl.xlsx'), 'pnl');
    assert.strictEqual(await kindOf('statement.ofx'), 'bank');
    assert.strictEqual(await kindOf('remittance.eml'), 'emails');
  });
  test('an unrecognisable table is reported, not guessed', async () => {
    const info = await inspect(Buffer.from('foo,bar\n1,2\n3,4\n'), 'x.csv');
    assert.strictEqual(info.kind, null);
  });
  test('a supplier file is a payables ledger', async () => {
    const csv = Buffer.from('Bill No,Supplier,Bill Date,Due Date,Amount\nB-1,Stellar,01/10/2026,31/10/2026,500\n');
    const r = await ingest(csv, 'bills.csv', {});
    assert.strictEqual(r.records[0].type, 'payable');
  });
});

describe('ledger normalisation', () => {
  test('keeps good rows, reports bad ones with line numbers', async () => {
    const r = await ingest(fixture('ledger_uk.csv'), 'ledger_uk.csv', {});
    assert.deepStrictEqual(
      r.records.map((x) => x.id),
      ['INV-1001', 'INV-1002', 'INV-1003', 'INV-1004']
    );
    assert.strictEqual(r.records[0].amount, 18400);
    assert.strictEqual(r.records.find((x) => x.id === 'INV-1002').amount, 9900, 'last duplicate wins');
    assert.strictEqual(r.records.find((x) => x.id === 'INV-1003').status, 'paid');
    const msgs = r.issues.map((i) => i.row + ':' + i.message);
    assert.ok(msgs.some((m) => m.startsWith('6:Missing invoice number')));
    assert.ok(msgs.some((m) => /^7:Credit note ignored/.test(m)));
    assert.ok(msgs.some((m) => /^8:Amount is not a number/.test(m)));
    assert.strictEqual(r.range.from, '2026-09-10');
  });
  test('European formats', async () => {
    const r = await ingest(fixture('ledger_eu.csv'), 'ledger_eu.csv', {});
    assert.strictEqual(r.records[0].amount, 1234.5);
    assert.strictEqual(r.records[0].due, '2026-11-02');
    assert.strictEqual(r.records[1].status, 'paid');
  });
  test('Excel dates and amount-owed column', async () => {
    const r = await ingest(fixture('ledger.xlsx'), 'ledger.xlsx', {});
    assert.strictEqual(r.records[0].due, '2026-11-20');
    assert.deepStrictEqual(
      r.records.map((x) => x.status),
      ['open', 'paid']
    );
  });
  test('missing due date falls back to the configured terms and says so', async () => {
    const csv = Buffer.from('Invoice,Customer,Date,Amount\nINV-1,Acme,2026-10-01,100\n');
    const r = await ingest(csv, 'x.csv', { options: { termsDays: 45 } });
    assert.strictEqual(r.records[0].due, '2026-11-15');
    assert.ok(r.notes.some((n) => /assumed 45 days/.test(n)));
  });
  test('user-supplied mapping overrides detection', async () => {
    const csv = Buffer.from('A,B,C,D\nINV-1,Acme,2026-10-01,100\n');
    const r = await ingest(csv, 'x.csv', { kind: 'ledger', mapping: { id: 0, party: 1, issued: 2, amount: 3 } });
    assert.strictEqual(r.records[0].amount, 100);
  });
  test('required columns missing is an actionable error', async () => {
    await assert.rejects(ingest(Buffer.from('A,B\n1,2\n'), 'x.csv', { kind: 'ledger', mapping: { id: 0 } }), /Missing columns/);
  });
});

describe('bank normalisation', () => {
  test('credit and debit columns become signed amounts, balance is the latest', async () => {
    const r = await ingest(fixture('bank_credit_debit.csv'), 'b.csv', {});
    assert.deepStrictEqual(
      r.records.transactions.map((t) => t.amount),
      [18400, -2000, 4000]
    );
    assert.strictEqual(r.records.balance, 27000);
    assert.strictEqual(r.records.balanceDate, '2026-11-03');
  });
  test('newest-first statements give the same balance', async () => {
    const r = await ingest(fixture('bank_newest_first.csv'), 'b.csv', {});
    assert.strictEqual(r.records.balance, 27000);
  });
  test('OFX', async () => {
    const r = await ingest(fixture('statement.ofx'), 's.ofx', {});
    assert.strictEqual(r.kind, 'bank');
    assert.strictEqual(r.records.balance, 23000);
  });
});

describe('profit and loss normalisation', () => {
  test('long, wide and xlsx layouts agree on structure', async () => {
    const long = await ingest(fixture('pnl_long.csv'), 'p.csv', {});
    assert.strictEqual(long.records.months.length, 22);
    assert.deepStrictEqual(long.records.months[0], { month: '2025-01', turnover: 41000 });
    const wide = await ingest(fixture('pnl_wide.csv'), 'w.csv', {});
    assert.strictEqual(wide.records.months.length, 12);
    assert.strictEqual(wide.records.months[0].turnover, 40000, 'turnover row used, not cost of sales');
    const x = await ingest(fixture('pnl.xlsx'), 'p.xlsx', {});
    assert.strictEqual(x.records.months[11].month, '2025-12');
  });
});

describe('email claim extraction', () => {
  const ledger = [
    { id: 'INV-1042', party: 'Acme Ltd', type: 'receivable' },
    { id: 'BILL-221', party: 'Stellar', type: 'payable' }
  ];
  const mail = (body, extra) => Object.assign({ from: 'ap@acme.ie', to: 'finance@us.ie', date: '2026-11-04T14:02:00Z', subject: '', body }, extra);

  test('payment claim quotes the exact sentence', () => {
    const m = mail("Hi,\n\nWe've released payment of €18,400 for INV-1042 today. Thanks.");
    const { direction, extracted } = extractClaims(m, ledger, 'us.ie');
    assert.strictEqual(direction, 'received');
    assert.strictEqual(extracted[0].kind, 'payment_claim');
    assert.strictEqual(extracted[0].amount, 18400);
    assert.ok(m.body.includes(extracted[0].quote));
  });
  test('promise resolves "Friday" relative to the sent date and uses the subject for the reference', () => {
    const m = mail('Sorry for the delay. We will pay this on Friday.', { subject: 'Re: INV-1042' });
    const x = extractClaims(m, ledger, 'us.ie').extracted[0];
    assert.strictEqual(x.kind, 'promise_to_pay');
    assert.strictEqual(x.promisedDate, '2026-11-06');
  });
  test('sent reminders are chases; supplier notices are recognised', () => {
    const sent = extractClaims(mail('A reminder that INV-1042 is overdue.', { from: 'finance@us.ie' }), ledger, 'us.ie');
    assert.strictEqual(sent.direction, 'sent');
    assert.strictEqual(sent.extracted[0].kind, 'chase_sent');
    const notice = extractClaims(mail('Second notice: BILL-221 falls due on 12 Nov.'), ledger, 'us.ie').extracted[0];
    assert.strictEqual(notice.kind, 'supplier_notice');
    assert.strictEqual(notice.dueDate, '2026-11-12');
  });
  test('ignores emails that mention no known invoice', () => {
    assert.deepStrictEqual(extractClaims(mail('Top stories this week.'), ledger, 'us.ie').extracted, []);
  });
});

describe('dataset builder', () => {
  const NOW = '2026-11-09T06:00:00Z';
  async function workspace() {
    const sources = [];
    for (const [f, kind] of [
      ['ledger_uk.csv', 'ledger'],
      ['bank_credit_debit.csv', 'bank'],
      ['pnl_long.csv', 'pnl'],
      ['remittance.eml', 'emails']
    ]) {
      sources.push(Object.assign({ id: f, uploadedAt: NOW }, await ingest(fixture(f), f, { kind })));
    }
    return { settings: { company: 'Test Co', currency: 'GBP', asOf: '2026-11-09', emailDomain: 'us.ie' }, sources };
  }

  test('assembles ledger, bank, P&L and emails', async () => {
    const d = buildDataset(await workspace());
    assert.strictEqual(d.COMPANY, 'Test Co');
    assert.strictEqual(d.NOW, '2026-11-09T06:30:00Z');
    assert.strictEqual(d.LEDGER.length, 4);
    assert.strictEqual(d.BANK.balance, 27000);
    assert.strictEqual(d.PNL.ytdYear, 2026);
    assert.strictEqual(d.PNL.ytd.length, 10);
    assert.ok(d.PNL.years[2025]);
    assert.strictEqual(d.EMAILS[0].direction, 'received');
    assert.deepStrictEqual(Object.keys(d.SOURCES).sort(), ['bank', 'inbox', 'ledger', 'pnl']);
  });
  test('bank credits are matched to invoices by reference, then by customer name', async () => {
    const d = buildDataset(await workspace());
    const acme = d.BANK.transactions.find((t) => t.amount === 18400);
    assert.strictEqual(acme.reference, 'INV-1001');
    assert.strictEqual(acme.counterparty, 'Acme Ltd');
    const marlow = d.BANK.transactions.find((t) => t.amount === 4000);
    assert.strictEqual(marlow.counterparty, 'Marlow Design');
    assert.ok(
      d.BANK.transactions.every((t) => t.amount > 0),
      'only money in is passed to the engine'
    );
  });
  test('matching never links an unrelated line', () => {
    const out = matchBank(
      [{ date: '2026-11-01', amount: 50, description: 'Coffee', reference: null }],
      [{ id: 'INV-1', party: 'Acme', type: 'receivable', status: 'open' }]
    );
    assert.strictEqual(out[0].reference, '');
    assert.strictEqual(out[0].counterparty, 'Coffee');
  });
  test('is deterministic and does not mutate the workspace', async () => {
    const ws = await workspace();
    const before = JSON.stringify(ws);
    assert.deepStrictEqual(buildDataset(ws), buildDataset(ws));
    assert.strictEqual(JSON.stringify(ws), before);
  });
  test('uses the injected clock when no as-of date is set', () => {
    const d = buildDataset({ settings: {}, sources: [] }, { clock: () => Date.parse('2027-01-02T10:00:00Z') });
    assert.strictEqual(d.NOW, '2027-01-02T10:00:00Z');
  });
});
