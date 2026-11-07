'use strict';

/**
 * Honest back-test of the turnover outlook on the real Online Retail II monthly turnover.
 * For each month of 2011, the outlook is built using only what was known on the 1st (2010 history + 2011 months so far),
 * and its next-month base case and low-high range are compared with what really happened.
 * Usage: node scripts/backtest.js
 */
const fs = require('node:fs');
const path = require('node:path');
const Engine = require('../src/engine/engine');

const csv = fs
  .readFileSync(path.join(__dirname, '..', 'samples', 'online-retail-ii', 'pnl_monthly_turnover_REAL.csv'), 'utf8')
  .trim()
  .split('\n')
  .slice(1);
const turnover = Object.fromEntries(csv.map((l) => l.split(',')).map(([m, v]) => [m, Number(v)]));
const year = (y, n) => Array.from({ length: n }, (_, i) => turnover[y + '-' + String(i + 1).padStart(2, '0')]);
const pad = (n) => String(n).padStart(2, '0');

function backtest() {
  const rows = [];
  for (let known = 2; known <= 9; known++) {
    const data = {
      NOW: '2011-' + pad(known + 1) + '-01T06:30:00Z',
      LEDGER: [],
      BANK: { syncedAt: '2011-' + pad(known + 1) + '-01T06:00:00Z', balance: 0, transactions: [] },
      PNL: { years: { 2010: year(2010, 12) }, ytdYear: 2011, ytd: year(2011, known), costOfSalesPct: 0.6, overheadsMonthly: 0 },
      SOURCES: {
        ledger: { id: 'ledger', type: 'ledger', name: 'Ledger', short: 'ledger', file: 'x', syncedAt: '2011-' + pad(known + 1) + '-01T06:00:00Z' },
        bank: { id: 'bank', type: 'bank', name: 'Bank', short: 'bank', file: 'x', syncedAt: '2011-' + pad(known + 1) + '-01T06:00:00Z' },
        pnl: { id: 'pnl', type: 'sheet', name: 'P&L', short: 'P&L', file: 'x', syncedAt: '2011-' + pad(known + 1) + '-01T06:00:00Z' }
      }
    };
    const m = Engine.create(data).forecast.months[0].turnover;
    const actual = turnover['2011-' + pad(known + 1)];
    rows.push({
      month: '2011-' + pad(known + 1),
      predicted: Math.round(m.base),
      low: Math.round(m.low),
      high: Math.round(m.high),
      actual,
      error: (m.base - actual) / actual,
      inRange: actual >= m.low && actual <= m.high
    });
  }
  return rows;
}

function summarise(rows) {
  const mape = rows.reduce((s, r) => s + Math.abs(r.error), 0) / rows.length;
  return { months: rows.length, meanAbsolutePctError: mape, withinRange: rows.filter((r) => r.inRange).length };
}

module.exports = { backtest, summarise };

/* node:coverage disable */
if (require.main === module) {
  const rows = backtest();
  rows.forEach((r) =>
    process.stdout.write(
      r.month +
        '  predicted ' +
        r.predicted +
        '  actual ' +
        r.actual +
        '  error ' +
        (r.error * 100).toFixed(1) +
        '%  ' +
        (r.inRange ? 'inside' : 'OUTSIDE') +
        ' range ' +
        r.low +
        '-' +
        r.high +
        '\n'
    )
  );
  const s = summarise(rows);
  process.stdout.write(
    '\nMean absolute error ' +
      (s.meanAbsolutePctError * 100).toFixed(1) +
      '% over ' +
      s.months +
      ' months; actual inside the stated range in ' +
      s.withinRange +
      ' of ' +
      s.months +
      '.\n'
  );
}
