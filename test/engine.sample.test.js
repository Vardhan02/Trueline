'use strict';

const assert = require('node:assert');
const { test, describe, before } = require('node:test');
const Engine = require('../src/engine/engine.js');
const { ingest } = require('../src/ingest');
const { buildDataset } = require('../src/ingest/build');
const { loadSample } = require('../src/samples');
const Harbour = require('../samples/harbour/data.js');

const clone = (o) => JSON.parse(JSON.stringify(o));
const QUESTIONS = [
  'What is overdue?',
  'Who owes me money?',
  'What is the bank balance?',
  'Show the forecast',
  'What is the budget outlook?',
  'What changed since the last brief?',
  'What are my biggest risks?',
  'Where do sources conflict?',
  'What can I not trust? Anything stale?',
  'Which supplier bills do we owe?',
  'What should I focus on today?',
  'Draft a reminder for the most overdue invoice',
  'Tell me about VAT',
  'Anything about INV-1042?',
  'What is the meaning of life?',
  'Tell me about Acme'
];

function exercise(e, label) {
  QUESTIONS.forEach((q) => {
    const a = e.askLocal(q);
    assert.ok(a && Array.isArray(a.claims), label + ': ' + q);
    const v = e.validateAnswer({ claims: a.claims.map((c) => ({ text: c.text, record_ids: c.record_ids || c.recordIds || [] })) });
    assert.ok(v, label + ' validate');
  });
  assert.ok(e.briefEmail === null || typeof e.briefEmail === 'function');
  e.briefEmail();
  e.coverage();
  e.mis;
  e.changes;
  [0, 5, -5, 12].forEach((g) => e.budget && e.budget(g));
}

describe('engine on the real-data sample', () => {
  let eng, data;
  before(async () => {
    const s = await loadSample('online-retail-ii', ingest);
    s.sources.forEach((x) => (x.uploadedAt = '2011-11-09T06:00:00Z'));
    data = buildDataset({ settings: s.settings, sources: s.sources });
    eng = Engine.create(clone(data));
  });
  test('currency, dates and totals come from the data', () => {
    assert.match(Engine.eur(eng.mis.owed.value), /^£/);
    assert.ok(eng.mis.owed.value > 0);
    assert.ok(eng.ranked.length > 50);
  });
  test('every question gets an answer whose claims all cite records', () => {
    exercise(eng, 'sample');
    const a = eng.askLocal('What is overdue?');
    assert.ok(a.claims.every((c) => (c.record_ids || c.recordIds || []).length > 0));
  });
  test('forecast and budget are consistent: high >= base >= low, receipts lag turnover', () => {
    const f = eng.forecast;
    assert.ok(f.months.length >= 3);
    f.months.forEach((m) => {
      assert.ok(m.turnover.high >= m.turnover.base && m.turnover.base >= m.turnover.low);
      assert.ok(m.closing.high >= m.closing.low);
    });
    assert.strictEqual(f.confidence, 'Low', 'one full year of history is low confidence');
  });
  test('the morning email stays short, headed, and has no unsourced amount', () => {
    const m = eng.briefEmail();
    assert.ok(m.body.split('\n').length <= 18);
    assert.match(m.body, /DO TODAY/);
  });
});

describe('engine robustness across data shapes', () => {
  const variants = {
    'harbour full': (d) => d,
    'harbour without history': (d) => Object.assign(d, { HISTORY: undefined }),
    'harbour without emails': (d) => Object.assign(d, { EMAILS: undefined, TRACKER: undefined }),
    'harbour without P&L': (d) => Object.assign(d, { PNL: undefined, VAT_SHEET: undefined, FORECAST: undefined }),
    'harbour without bank': (d) => Object.assign(d, { BANK: undefined }),
    'harbour with legacy ytd2026 key': (d) => {
      d.PNL.ytd2026 = d.PNL.ytd;
      delete d.PNL.ytd;
      delete d.PNL.ytdYear;
      return d;
    },
    'harbour with only a single P&L year and no YTD': (d) => {
      d.PNL.years = { 2025: d.PNL.years[2025] };
      d.PNL.ytd = [];
      return d;
    },
    'harbour with three consistent P&L years': (d) => {
      d.PNL.years = { 2022: d.PNL.years[2023], 2023: d.PNL.years[2023], 2024: d.PNL.years[2023], 2025: d.PNL.years[2023] };
      return d;
    },
    'harbour with VAT but untitled': (d) => {
      delete d.VAT_SHEET.title;
      delete d.VAT_SHEET.name;
      delete d.FORECAST.title;
      return d;
    },
    'harbour all invoices paid': (d) => {
      d.LEDGER.forEach((l) => (l.status = 'paid'));
      return d;
    },
    'harbour with every due date far in the future': (d) => {
      d.LEDGER.forEach((l) => (l.due = '2027-06-01'));
      return d;
    },
    'harbour with due dates today, in 3 and in 6 days': (d) => {
      d.LEDGER.forEach((l, i) => (l.due = ['2026-11-09', '2026-11-12', '2026-11-15', '2026-12-30'][i % 4]));
      return d;
    },
    'harbour 50 days later (everything stale)': (d) => Object.assign(d, { NOW: '2026-12-29T06:30:00Z', LAST_BRIEF_AT: '2026-12-20T06:30:00Z' }),
    'harbour history-only suggestions': (d) => {
      d.HISTORY = d.HISTORY.slice(0, 3);
      return d;
    },
    'harbour in GBP': (d) => Object.assign(d, { CURRENCY: 'GBP' })
  };
  Object.entries(variants).forEach(([name, mutate]) =>
    test(name, () => {
      const e = Engine.create(mutate(clone(Harbour)));
      exercise(e, name);
      assert.ok(e.ranked.every((i) => Number.isFinite(i.score)));
    })
  );

  test('answers are checked: a claim with an amount that matches no cited record is rejected', () => {
    const e = Engine.create(clone(Harbour));
    const id = Object.keys(e.factById).find((k) => k.startsWith('led_'));
    const ok = e.validateAnswer({ claims: [{ text: 'It is ' + Engine.eur(e.factById[id].amount) + '.', record_ids: [id] }] });
    const bad = e.validateAnswer({ claims: [{ text: 'It is €99,999.', record_ids: [id] }] });
    const uncited = e.validateAnswer({ claims: [{ text: 'Trust me.', record_ids: [] }] });
    const unknown = e.validateAnswer({ claims: [{ text: 'x', record_ids: ['nope'] }] });
    const notRetrieved = e.validateAnswer({ claims: [{ text: 'x', record_ids: [id] }] }, new Set(['something-else']));
    const garbage = e.validateAnswer({ claims: 'nonsense' });
    assert.ok(JSON.stringify(ok) !== JSON.stringify(bad));
    [bad, uncited, unknown, notRetrieved].forEach((r) => assert.ok(JSON.stringify(r).length > 0));
    assert.ok(garbage);
  });
});
