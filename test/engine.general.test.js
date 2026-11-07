'use strict';

const assert = require('node:assert');
const { test, describe } = require('node:test');
const Engine = require('../src/engine/engine.js');

const NOW = '2026-11-09T06:30:00Z';
const ledger = (extra) =>
  Object.assign({ id: 'INV-1', type: 'receivable', party: 'Acme', amount: 1000, issued: '2026-10-01', due: '2026-10-20', status: 'open', row: 2 }, extra);

describe('engine with partial data', () => {
  test('an empty workspace does not throw and has nothing to rank', () => {
    const e = Engine.create({ NOW, LEDGER: [] });
    assert.strictEqual(e.ranked.length, 0);
    assert.match(e.coverage(), /No sources connected/);
  });
  test('ledger only: ranks overdue invoices, no cash, no forecast', () => {
    const e = Engine.create({
      NOW,
      LEDGER: [ledger()],
      SOURCES: { ledger: { id: 'ledger', type: 'ledger', name: 'Ledger', short: 'ledger', file: 'ar.csv', syncedAt: NOW } }
    });
    assert.strictEqual(e.ranked.length, 1);
    assert.strictEqual(e.byRef['INV-1'].trust, 'record');
    assert.strictEqual(e.forecast, null);
    assert.ok(e.briefEmail());
  });
  test('per-record file names appear in the origin of every fact', () => {
    const e = Engine.create({
      NOW,
      LEDGER: [ledger({ file: 'march.csv' })],
      SOURCES: { ledger: { id: 'ledger', type: 'ledger', name: 'Ledger', short: 'ledger', file: 'x.csv', syncedAt: NOW } }
    });
    assert.match(e.factById['led_INV-1'].origin, /^march\.csv · row 2$/);
  });
  test('bank without a balance does not invent one', () => {
    const e = Engine.create({
      NOW,
      LEDGER: [ledger()],
      BANK: { syncedAt: NOW, balance: null, transactions: [] },
      SOURCES: {
        ledger: { id: 'ledger', type: 'ledger', name: 'Ledger', short: 'ledger', file: 'a', syncedAt: NOW },
        bank: { id: 'bank', type: 'bank', name: 'Bank', short: 'bank', file: 'b', syncedAt: NOW }
      }
    });
    assert.strictEqual(e.factById.bnk_balance, undefined);
  });
  test('the stale threshold is configurable', () => {
    const src = { ledger: { id: 'ledger', type: 'ledger', name: 'Ledger', short: 'ledger', file: 'a', syncedAt: '2026-11-01T06:30:00Z' } };
    const strict = Engine.create({ NOW, STALE_DAYS: 3, LEDGER: [ledger()], SOURCES: src });
    assert.strictEqual(strict.ageOf(strict.factById['led_INV-1']).cls, 'old');
    const lax = Engine.create({ NOW, STALE_DAYS: 30, LEDGER: [ledger()], SOURCES: src });
    assert.notStrictEqual(lax.ageOf(lax.factById['led_INV-1']).cls, 'old');
  });
});

describe('currency', () => {
  const sources = { ledger: { id: 'ledger', type: 'ledger', name: 'Ledger', short: 'ledger', file: 'a', syncedAt: NOW } };
  test('amounts use the workspace currency symbol', () => {
    Engine.create({ NOW, CURRENCY: 'GBP', LEDGER: [ledger()], SOURCES: sources });
    assert.strictEqual(Engine.eur(1234), '£1,234');
    Engine.create({ NOW, CURRENCY: 'USD', LEDGER: [ledger()], SOURCES: sources });
    assert.strictEqual(Engine.eur(1234), '$1,234');
    Engine.create({ NOW, CURRENCY: 'EUR', LEDGER: [ledger()], SOURCES: sources });
    assert.strictEqual(Engine.eur(-50), '-€50');
  });
  test('dates from another year show the year', () => {
    Engine.create({ NOW, LEDGER: [ledger()], SOURCES: sources });
    assert.strictEqual(Engine.fd('2026-10-20'), '20 Oct');
    assert.match(Engine.fd('2025-10-20'), /2025/);
  });
});
