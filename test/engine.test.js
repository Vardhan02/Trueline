'use strict';

const assert = require('node:assert');
const { test: t } = require('node:test');
const Engine = require('../src/engine/engine.js');
const DATA = require('../samples/harbour/data.js');
const Demo = require('../samples/harbour/demo.js');
const clone = (o) => JSON.parse(JSON.stringify(o));

const eng = Engine.create(clone(DATA));

t('every extracted quote is an exact sentence from its email', () => {
  DATA.EMAILS.forEach((e) => e.extracted.forEach((x) => assert(e.body.includes(x.quote), e.id + ' quote not in body')));
});
t('trust states', () => {
  const s = (r) => eng.byRef[r].trust;
  assert.strictEqual(s('INV-1042'), 'conflict');
  assert.strictEqual(s('INV-1029'), 'conflict');
  assert(eng.byRef['INV-1042'].unreceived, 'Acme: claimed paid, not in bank');
  assert(eng.byRef['INV-1029'].confirmed, 'Marlow: bank confirms, ledger behind');
  assert.strictEqual(eng.byRef['INV-1042'].strongest, 'bank feed');
  assert.strictEqual(s('INV-1017'), 'agree');
  assert.strictEqual(s('INV-1033'), 'agree');
  assert.strictEqual(s('INV-1055'), 'agree');
  assert.strictEqual(s('BILL-221'), 'agree');
  assert.strictEqual(s('BILL-224'), 'record');
  assert.strictEqual(s('VAT-SEP-OCT'), 'agree');
  assert.strictEqual(s('INFO-STELLAR-PRICE'), 'stale');
  assert.strictEqual(s('FORECAST-Q4'), 'stale');
});
t('ranking order and buckets', () => {
  assert.strictEqual(eng.ranked[0].ref, 'INV-1042');
  assert(eng.buckets[0].items.map((i) => i.ref).includes('INV-1017'));
  assert(eng.ranked.every((i) => !['INFO-STELLAR-PRICE', 'FORECAST-Q4'].includes(i.ref)));
});
t('stale and single-source items are listed as unverified, not ranked', () => {
  assert.deepStrictEqual(eng.unverified.map((i) => i.ref).sort(), ['FORECAST-Q4', 'INFO-STELLAR-PRICE']);
});
t('MIS numbers', () => {
  assert.strictEqual(eng.mis.owed.value, 37750); // 41,750 in the ledger minus 4,000 already in the bank
  assert.strictEqual(eng.mis.owed.lag, 4000);
  assert.strictEqual(eng.mis.overdue.value, 31500); // cash at risk
  assert.strictEqual(eng.mis.overdue.unreceived, 18400);
  assert.strictEqual(eng.mis.bank.value, 48230);
  assert.strictEqual(eng.mis.payOut.value, 7900);
});
t('validator accepts good citations', () => {
  const a = eng.askLocal('what is overdue?');
  assert(a.claims.length > 0 && a.claims.every((c) => c.valid), JSON.stringify(a.claims.filter((c) => !c.valid)));
});
t('validator rejects uncited, unknown and mismatched claims', () => {
  const r = eng.validateAnswer({
    claims: [
      { text: 'Acme owes us money.', record_ids: [] },
      { text: 'Acme owes €1,000.', record_ids: ['led_INV-1042'] },
      { text: 'Invented.', record_ids: ['nope'] },
      { text: 'Acme owes €18,400.', record_ids: ['led_INV-1042'] }
    ]
  });
  assert.deepStrictEqual(
    r.claims.map((c) => c.valid),
    [false, false, false, true]
  );
});
t('every local answer to the demo questions is fully cited', () => {
  [
    'what changed since friday',
    'any conflicts?',
    'tell me about acme',
    'when is the vat due',
    'what can you not verify',
    'what are my bills',
    'draft a chase for brightwave',
    'what should I focus on',
    'chase marlow',
    'who owes me money',
    'how much is in the bank',
    'where is my cash at risk'
  ].forEach((q) => {
    const a = eng.askLocal(q);
    assert(
      a.claims.every((c) => c.valid),
      q + ' -> ' + JSON.stringify(a.claims.filter((c) => !c.valid))
    );
    assert(a.claims.length || a.notes.length, q);
  });
});
t('unknown topic abstains instead of answering', () => {
  const a = eng.askLocal('what is the weather in Cork');
  assert.strictEqual(a.claims.length, 0);
  assert(a.notes.length === 1);
});
t('draft is produced for a clean overdue invoice and withheld for a conflict', () => {
  assert(eng.askLocal('draft a chase email for brightwave').draft.includes('INV-1017'));
  assert(!eng.askLocal('draft a chase email for acme').draft);
});
t('changing the data changes the brief (the engine is real)', () => {
  const e2 = Engine.create(Demo.applyAcmePaid(clone(DATA)));
  assert(e2.byRef['INV-1042'].confirmed && !e2.byRef['INV-1042'].unreceived);
  assert(e2.byRef['INV-1042'].score < 50, 'drops out of Act today once the bank shows the money');
  assert.strictEqual(e2.mis.overdue.value, 31500 - 18400);
  assert.strictEqual(e2.mis.bank.value, 48230 + 18400);
});
t('seasonal shares sum to 1 and the scenarios are ordered', () => {
  assert(Math.abs(eng.model.shares.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  eng.forecast.months.forEach((m) => assert(m.closing.low <= m.closing.base && m.closing.base <= m.closing.high, m.label));
  assert.strictEqual(eng.forecast.opening, 48230);
});
t('budget is the annual figure split by the seasonal shares', () => {
  const b = eng.budget(0.1);
  assert(Math.abs(b.months.reduce((a, m) => a + m.amount, 0) - b.annual) < 1);
  assert(Math.abs(b.annual - eng.model.annual * 1.1) < 1);
  assert.strictEqual(b.peak, 'Dec');
});
t('forecast answers validate; a wrong derived number is rejected', () => {
  const a = eng.askLocal('what is the outlook for the next 90 days?');
  assert(a.claims.length === 2 && a.claims.every((c) => c.valid), JSON.stringify(a.claims));
  const bad = eng.validateAnswer({ claims: [{ text: 'The balance ends at €99,999.', record_ids: eng.forecast.basisIds }], notes: [] });
  assert(!bad.claims[0].valid);
});
t('suggestions always show their sample size and only use own history', () => {
  eng.ranked.concat(eng.unverified).forEach((i) => {
    if (i.suggestion) {
      assert(i.suggestion.n >= 0);
      assert(i.suggestion.evidence.every((id) => eng.factById[id]));
    }
  });
  const c = eng.byRef['BILL-224'];
  assert(!c.suggestion || c.suggestion.evidence.every((id) => !/Stellar/.test(eng.factById[id].summary)));
  assert(eng.byRef['INV-1017'].suggestion.button.body.includes('INV-1017'));
});
t('morning email is short and headed', () => {
  const m = eng.briefEmail();
  assert(m.body.split('\n').length <= 18, 'too long: ' + m.body.split('\n').length + ' lines');
  assert(/^DO TODAY/.test(m.body) && /CASH/.test(m.body) && /INV-1042|Acme/.test(m.body) && m.rows.length === 4);
  assert(
    m.rows.every((r) => r.action.length < 70),
    'actions are one short line'
  );
});
