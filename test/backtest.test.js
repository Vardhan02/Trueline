'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { backtest, summarise } = require('../scripts/backtest');

test('back-test on real turnover stays honest: bounded error and a range that usually holds', () => {
  const rows = backtest();
  const s = summarise(rows);
  assert.equal(s.months, 8);
  assert.ok(s.meanAbsolutePctError < 0.2, 'mean error ' + s.meanAbsolutePctError);
  assert.ok(s.withinRange >= 6, 'range held ' + s.withinRange + ' of 8');
});
