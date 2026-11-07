'use strict';

const { parseDate, parseMonthLabel } = require('./dates');
const { parseNumber } = require('./numbers');

const norm = (h) =>
  String(h == null ? '' : h)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * What we look for in each kind of file. `syn` lists header names in order of preference (already normalised),
 * `type` is what the column should contain, so a column called "Date" that holds names is not accepted as a date.
 */
const SPECS = {
  ledger: {
    label: 'Invoices and bills (ledger)',
    fields: {
      id: {
        label: 'Invoice or bill number',
        type: 'text',
        required: true,
        syn: [
          'invoice number',
          'invoice no',
          'invoice num',
          'invoice id',
          'invoice',
          'inv no',
          'inv number',
          'inv',
          'bill number',
          'bill no',
          'bill',
          'document number',
          'document no',
          'doc no',
          'doc number',
          'reference',
          'ref',
          'number',
          'no'
        ]
      },
      party: {
        label: 'Customer or supplier',
        type: 'text',
        required: true,
        syn: [
          'customer name',
          'customer',
          'client name',
          'client',
          'supplier name',
          'supplier',
          'vendor name',
          'vendor',
          'creditor',
          'debtor',
          'account name',
          'contact',
          'payee',
          'company',
          'name'
        ]
      },
      amount: {
        label: 'Invoice amount',
        type: 'number',
        required: true,
        syn: ['invoice amount', 'invoice total', 'gross amount', 'gross', 'total amount', 'total', 'amount', 'value']
      },
      outstanding: {
        label: 'Amount still owed',
        type: 'number',
        syn: ['amount outstanding', 'outstanding amount', 'outstanding', 'balance due', 'amount due', 'open amount', 'remaining', 'unpaid', 'balance']
      },
      issued: {
        label: 'Invoice date',
        type: 'date',
        syn: ['invoice date', 'issue date', 'issued', 'document date', 'doc date', 'tax point', 'created', 'date']
      },
      due: { label: 'Due date', type: 'date', syn: ['due date', 'date due', 'payment due', 'pay by', 'due'] },
      status: { label: 'Status (paid or open)', type: 'text', syn: ['payment status', 'status', 'state', 'paid', 'settled'] },
      type: { label: 'Type (invoice or bill)', type: 'text', syn: ['document type', 'doc type', 'transaction type', 'type', 'kind'] }
    }
  },
  bank: {
    label: 'Bank transactions',
    fields: {
      date: {
        label: 'Date',
        type: 'date',
        required: true,
        syn: ['transaction date', 'posting date', 'posted date', 'booking date', 'value date', 'trans date', 'date posted', 'date']
      },
      description: {
        label: 'Description',
        type: 'text',
        syn: [
          'transaction description',
          'description',
          'narrative',
          'transaction details',
          'details',
          'particulars',
          'counterparty',
          'payee',
          'memo',
          'merchant',
          'name'
        ]
      },
      amount: { label: 'Amount (money in is positive)', type: 'number', syn: ['transaction amount', 'amount', 'value', 'amt'] },
      credit: { label: 'Money in (credit)', type: 'number', syn: ['credit amount', 'credits', 'credit', 'paid in', 'money in', 'deposits', 'deposit', 'cr'] },
      debit: {
        label: 'Money out (debit)',
        type: 'number',
        syn: ['debit amount', 'debits', 'debit', 'paid out', 'money out', 'withdrawals', 'withdrawal', 'dr']
      },
      balance: { label: 'Balance after transaction', type: 'number', syn: ['running balance', 'closing balance', 'account balance', 'balance'] },
      reference: { label: 'Reference', type: 'text', syn: ['payment reference', 'transaction reference', 'transaction id', 'fitid', 'reference', 'ref'] }
    }
  },
  pnl: {
    label: 'Monthly profit and loss',
    fields: {
      period: { label: 'Month', type: 'month', required: true, syn: ['year month', 'month end', 'month', 'period', 'date'] },
      turnover: {
        label: 'Turnover or revenue',
        type: 'number',
        required: true,
        syn: ['total turnover', 'turnover', 'net sales', 'total revenue', 'total sales', 'revenue', 'sales', 'income']
      }
    }
  }
};

const SAMPLE_ROWS = 200;

function columnShare(rows, col, test) {
  let seen = 0;
  let ok = 0;
  for (let i = 0; i < rows.length && seen < SAMPLE_ROWS; i++) {
    const v = rows[i][col];
    if (v == null || String(v).trim() === '') continue;
    seen++;
    if (test(v)) ok++;
  }
  return seen === 0 ? 0 : ok / seen;
}

const TESTS = {
  number: (v) => parseNumber(v) != null,
  date: (v) => parseDate(v, { dayFirst: true }) != null || parseDate(v, { dayFirst: false }) != null,
  month: (v) => parseMonthLabel(v) != null && parseMonthLabel(v).year != null,
  text: () => true
};

/** Greedy best-match of headers to fields: strongest header match first, and each column is used once. */
function matchColumns(headers, rows, fields) {
  const normed = headers.map(norm);
  const pairs = [];
  Object.entries(fields).forEach(([field, spec]) => {
    spec.syn.forEach((syn, rank) => {
      normed.forEach((h, col) => {
        if (!h) return;
        let score = 0;
        if (h === syn) score = 3;
        else if (new RegExp('(^| )' + syn + '( |$)').test(h)) score = 2;
        else if (h.length >= 4 && syn.includes(h)) score = 1;
        if (score) pairs.push({ field, col, score, rank });
      });
    });
  });
  pairs.sort((a, b) => b.score - a.score || a.rank - b.rank);
  const mapping = {};
  const used = new Set();
  const typeOk = new Map();
  pairs.forEach((p) => {
    if (mapping[p.field] != null || used.has(p.col)) return;
    const key = p.field + ':' + p.col;
    if (!typeOk.has(key)) typeOk.set(key, columnShare(rows, p.col, TESTS[fields[p.field].type]) >= 0.6);
    if (!typeOk.get(key)) return;
    mapping[p.field] = p.col;
    used.add(p.col);
  });
  return mapping;
}

const has = (m, f) => m[f] != null;

function scoreLedger(m) {
  const amount = has(m, 'amount') ? 3 : has(m, 'outstanding') ? 2 : 0;
  const score =
    (has(m, 'id') ? 3 : 0) +
    (has(m, 'party') ? 3 : 0) +
    amount +
    (has(m, 'due') ? 2 : 0) +
    (has(m, 'issued') ? 1 : 0) +
    (has(m, 'status') || has(m, 'outstanding') ? 1 : 0);
  const missing = [];
  if (!has(m, 'id')) missing.push('id');
  if (!has(m, 'party')) missing.push('party');
  if (!amount) missing.push('amount');
  return { score, max: 13, missing };
}

function scoreBank(m) {
  const money = has(m, 'amount') ? 3 : has(m, 'credit') || has(m, 'debit') ? 3 : 0;
  const score =
    (has(m, 'date') ? 3 : 0) +
    money +
    (has(m, 'description') ? 2 : 0) +
    (has(m, 'balance') ? 1.5 : 0) +
    (has(m, 'reference') ? 0.5 : 0) +
    (has(m, 'credit') && has(m, 'debit') ? 1 : 0);
  const missing = [];
  if (!has(m, 'date')) missing.push('date');
  if (!money) missing.push('amount');
  return { score, max: 10, missing };
}

/** A P&L can be one row per month, one row per year with month columns, or line items with dated month columns. */
function detectPnl(table) {
  const { headers, rows } = table;
  const monthCols = headers.map((h, i) => ({ i, m: parseMonthLabel(h) })).filter((x) => x.m);
  if (monthCols.length >= 6) {
    const withYear = monthCols.filter((x) => x.m.year != null).length;
    return {
      kind: 'pnl',
      layout: withYear >= monthCols.length * 0.6 ? 'wide-items' : 'wide-years',
      confidence: 0.8,
      mapping: { months: monthCols.map((x) => x.i) },
      missing: [],
      notes: []
    };
  }
  const m = matchColumns(headers, rows, SPECS.pnl.fields);
  if (has(m, 'period') && has(m, 'turnover')) return { kind: 'pnl', layout: 'long', confidence: 0.85, mapping: m, missing: [], notes: [] };
  return null;
}

function guessLedgerType(headers, mapping, filename) {
  const party = has(mapping, 'party') ? norm(headers[mapping.party]) : '';
  if (/supplier|vendor|creditor|payee/.test(party)) return 'payable';
  if (/customer|client|debtor/.test(party)) return 'receivable';
  if (/\b(bills?|payables?|purchases?|suppliers?|creditors?|ap)\b/i.test(String(filename || '').replace(/[_.-]/g, ' '))) return 'payable';
  return 'receivable';
}

/**
 * Look at a table and say what it probably is. Returns ranked proposals; the first is the best guess.
 * Each proposal: { kind, confidence 0-1, mapping { field: columnIndex }, missing[], notes[], options }.
 */
function propose(table, { filename } = {}) {
  const { headers, rows } = table;
  const out = [];
  const pnl = detectPnl(table);
  if (pnl) out.push(pnl);

  const ledgerMap = matchColumns(headers, rows, SPECS.ledger.fields);
  const l = scoreLedger(ledgerMap);
  const bankMap = matchColumns(headers, rows, SPECS.bank.fields);
  const b = scoreBank(bankMap);
  // Ledgers have invoice numbers and due dates; bank statements have descriptions, balances and credit/debit columns.
  const ledgerBias = has(ledgerMap, 'due') && has(ledgerMap, 'id') ? 1.5 : 0;
  const bankBias =
    (has(bankMap, 'balance') ? 1 : 0) +
    (has(bankMap, 'credit') && has(bankMap, 'debit') ? 1.5 : 0) +
    (has(bankMap, 'description') && !has(ledgerMap, 'id') ? 1 : 0);
  if (l.score > 0) {
    out.push({
      kind: 'ledger',
      confidence: l.missing.length ? Math.min(0.4, l.score / l.max) : Math.min(1, (l.score + ledgerBias) / l.max),
      mapping: ledgerMap,
      missing: l.missing,
      notes: [],
      options: { ledgerType: guessLedgerType(headers, ledgerMap, filename) }
    });
  }
  if (b.score > 0) {
    out.push({
      kind: 'bank',
      confidence: b.missing.length ? Math.min(0.4, b.score / b.max) : Math.min(1, (b.score + bankBias) / b.max),
      mapping: bankMap,
      missing: b.missing,
      notes: [],
      options: {}
    });
  }
  out.sort((x, y) => y.confidence - x.confidence);
  if (!out.length)
    return [
      {
        kind: null,
        confidence: 0,
        mapping: {},
        missing: [],
        notes: ['We could not tell what this file is. Check it has a header row, then choose what it contains.'],
        options: {}
      }
    ];
  return out;
}

/** The fields a user can map for a kind, for the confirm screen. */
function fieldSpecs(kind) {
  const spec = SPECS[kind];
  if (!spec) return [];
  return Object.entries(spec.fields).map(([field, s]) => ({ field, label: s.label, required: !!s.required, type: s.type }));
}

module.exports = { propose, fieldSpecs, matchColumns, SPECS, norm };
