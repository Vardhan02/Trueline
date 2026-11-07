'use strict';

const { parseDate, detectDayFirst, parseMonthLabel } = require('./dates');
const { parseNumber, detectDecimalComma } = require('./numbers');
const { norm } = require('./detect');

const MAX_ISSUES = 25;
const PAID_WORDS = new Set(['paid', 'settled', 'closed', 'cleared', 'received', 'complete', 'completed', 'reconciled', 'yes', 'true', 'y']);
const OPEN_WORDS = new Set([
  'open',
  'unpaid',
  'outstanding',
  'overdue',
  'due',
  'pending',
  'part paid',
  'partial',
  'partially paid',
  'awaiting',
  'no',
  'false',
  'n',
  'sent',
  'approved'
]);

/**
 * A number reader for some columns of a table. Whether those columns write "1.234,50" or "1,234.50" is decided once,
 * from the values that can only be read one way, so a bare "1.500" in the same columns is read the same way.
 */
function numberReader(table, cols, options) {
  const used = cols.filter((c) => c != null);
  // A lazy walk over the cells: no copy of the column, and no spread (which overflows the stack past ~150,000 rows).
  function* cells() {
    for (const row of table.rows) for (const c of used) yield row[c];
  }
  const decimalComma = options.decimalComma != null ? options.decimalComma : detectDecimalComma(cells());
  return (v) => parseNumber(v, { decimalComma });
}

const cell = (row, mapping, field) => (mapping[field] == null ? null : row[mapping[field]]);
const text = (v) => (v == null ? '' : String(v).trim());
const shiftDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

/** Collects problems with a cap, so a bad 50,000-row file does not return 50,000 messages. */
class Report {
  constructor() {
    this.issues = [];
    this.notes = [];
    this.counts = {};
  }
  skip(reason, line) {
    this.counts[reason] = (this.counts[reason] || 0) + 1;
    if (this.issues.length < MAX_ISSUES) this.issues.push({ row: line, message: reason });
  }
  count(note) {
    this.counts[note] = (this.counts[note] || 0) + 1;
  }
  summary(templates) {
    Object.entries(templates).forEach(([key, make]) => {
      if (this.counts[key]) this.notes.push(make(this.counts[key]));
    });
  }
}

function range(dates) {
  const d = dates.filter(Boolean).sort();
  return d.length ? { from: d[0], to: d[d.length - 1] } : null;
}

function ledger(table, mapping, options = {}) {
  const r = new Report();
  const col = (f) => (mapping[f] == null ? [] : table.rows.map((row) => row[mapping[f]]));
  const dayFirst = options.dayFirst != null ? options.dayFirst : detectDayFirst(col('issued').concat(col('due')));
  const terms = Number.isFinite(options.termsDays) ? options.termsDays : 30;
  const num = numberReader(table, [mapping.amount, mapping.outstanding], options);
  const byKey = new Map();

  table.rows.forEach((row, idx) => {
    const line = table.lines[idx];
    const id = text(cell(row, mapping, 'id'));
    if (!id) return r.skip('Missing invoice number', line);
    const amount = num(cell(row, mapping, 'amount'));
    const owed = num(cell(row, mapping, 'outstanding'));
    const original = amount != null ? amount : owed;
    if (original == null) return r.skip('Amount is not a number (' + id + ')', line);
    if (original < 0) return r.skip('Credit note ignored (' + id + ')', line);
    if (original === 0 && !owed) return r.skip((amount == null ? 'Nothing owed and no invoice amount' : 'Zero amount') + ' (' + id + ')', line);

    const typeText = norm(cell(row, mapping, 'type'));
    let type = options.ledgerType === 'payable' ? 'payable' : 'receivable';
    if (/bill|purchase|payable|supplier|expense/.test(typeText)) type = 'payable';
    else if (/invoice|sale|receivable|customer/.test(typeText)) type = 'receivable';
    else if (/credit/.test(typeText)) return r.skip('Credit note ignored (' + id + ')', line);

    let issued = parseDate(cell(row, mapping, 'issued'), { dayFirst });
    let due = parseDate(cell(row, mapping, 'due'), { dayFirst });
    if (!issued && !due) return r.skip('No invoice date or due date (' + id + ')', line);
    if (!due) {
      due = shiftDays(issued, terms);
      r.count('assumedDue');
    }
    if (!issued) issued = shiftDays(due, -terms);

    let status = 'open';
    let amountOpen = original;
    const statusText = norm(cell(row, mapping, 'status'));
    if (owed != null && mapping.outstanding != null) {
      status = owed > 0 ? 'open' : 'paid';
      if (owed > 0) amountOpen = owed;
    } else if (statusText) {
      if (PAID_WORDS.has(statusText)) status = 'paid';
      else if (!OPEN_WORDS.has(statusText)) r.count('unknownStatus');
    } else {
      r.count('assumedOpen');
    }
    const party = text(cell(row, mapping, 'party')) || 'Unnamed ' + (type === 'payable' ? 'supplier' : 'customer');
    const key = type + ':' + id;
    if (byKey.has(key)) r.count('duplicates');
    byKey.set(key, { id, type, party, amount: amountOpen, issued, due, status, row: line });
  });

  const records = [...byKey.values()];
  r.summary({
    assumedDue: (n) => 'No due date for ' + n + ' rows: assumed ' + terms + ' days after the invoice date.',
    assumedOpen: (n) => 'No status or amount-owed column: treated ' + n + ' rows as unpaid.',
    unknownStatus: (n) => n + ' rows had a status we did not recognise and were treated as open.',
    duplicates: (n) => n + ' repeated invoice numbers: the last one in the file was kept.'
  });
  return {
    records,
    stats: { rows: table.rows.length, accepted: records.length, skipped: table.rows.length - records.length },
    issues: r.issues,
    notes: r.notes,
    range: range(records.map((x) => x.issued))
  };
}

/** Bank files list newest-first or oldest-first. Check which way the running balance adds up. */
function latestBalance(txs) {
  const withBal = txs.filter((t) => t.balance != null);
  if (!withBal.length) return { balance: null, balanceDate: null };
  const step = (a, b) => Math.abs(b.balance - a.balance - b.amount) < 0.01;
  let asc = 0;
  let desc = 0;
  for (let i = 1; i < Math.min(withBal.length, 60); i++) {
    if (step(withBal[i - 1], withBal[i])) asc++;
    if (step(withBal[i], withBal[i - 1])) desc++;
  }
  let last;
  if (asc !== desc) last = asc > desc ? withBal[withBal.length - 1] : withBal[0];
  else {
    const a = withBal[0].date;
    const z = withBal[withBal.length - 1].date;
    last = a > z ? withBal[0] : withBal[withBal.length - 1];
  }
  return { balance: last.balance, balanceDate: last.date };
}

function bank(table, mapping, options = {}) {
  const r = new Report();
  const dates = mapping.date == null ? [] : table.rows.map((row) => row[mapping.date]);
  const dayFirst = options.dayFirst != null ? options.dayFirst : detectDayFirst(dates);
  const num = numberReader(table, [mapping.amount, mapping.credit, mapping.debit, mapping.balance], options);
  const txs = [];
  table.rows.forEach((row, idx) => {
    const line = table.lines[idx];
    const date = parseDate(cell(row, mapping, 'date'), { dayFirst });
    if (!date) return r.skip('Date not recognised', line);
    let amount = num(cell(row, mapping, 'amount'));
    if (amount == null) {
      const credit = num(cell(row, mapping, 'credit'));
      const debit = num(cell(row, mapping, 'debit'));
      if (credit == null && debit == null) return r.skip('No amount', line);
      amount = Math.abs(credit || 0) - Math.abs(debit || 0);
    }
    txs.push({
      id: text(cell(row, mapping, 'reference')) || null,
      date,
      amount,
      description: text(cell(row, mapping, 'description')),
      reference: text(cell(row, mapping, 'reference')) || null,
      balance: num(cell(row, mapping, 'balance'))
    });
  });
  const { balance, balanceDate } = latestBalance(txs);
  if (balance == null) r.notes.push('No balance column, so the bank balance is unknown. Outlook needs a balance.');
  const records = { transactions: txs.map(({ balance: _b, ...t }) => t), balance, balanceDate };
  return {
    records,
    stats: { rows: table.rows.length, accepted: txs.length, skipped: table.rows.length - txs.length },
    issues: r.issues,
    notes: r.notes,
    range: range(txs.map((t) => t.date))
  };
}

const TURNOVER_ROW = /^(total )?(net )?(turnover|revenue|revenues|sales|income)\b/i;

/** Normalise any of the three P&L layouts to [{ month: "YYYY-MM", turnover }]. */
function pnl(table, mapping, options = {}) {
  const r = new Report();
  const out = new Map();
  const num = numberReader(table, mapping.months || [mapping.turnover], options);
  const put = (year, month, value, line) => {
    const n = num(value);
    if (n == null) return;
    if (year == null) return r.skip('Month has no year', line);
    out.set(year + '-' + String(month).padStart(2, '0'), n * (options.scale || 1));
  };
  const layout = options.layout || 'long';
  table.rows.forEach((row, idx) => {
    const line = table.lines[idx];
    if (layout === 'long') {
      const m = parseMonthLabel(cell(row, mapping, 'period'));
      if (!m) return r.skip('Month not recognised', line);
      put(m.year, m.month, cell(row, mapping, 'turnover'), line);
    } else if (layout === 'wide-items') {
      if (!TURNOVER_ROW.test(text(row[0]))) return;
      mapping.months.forEach((c) => {
        const m = parseMonthLabel(table.headers[c]);
        if (m) put(m.year, m.month, row[c], line);
      });
    } else {
      // wide-years: one row per year, month names across. The year is in a column called Year, or the first cell.
      const year = Number(text(row.find((c, i) => !mapping.months.includes(i) && /^(19|20)\d{2}$/.test(text(c)))));
      if (!year) return r.skip('No year on this row', line);
      mapping.months.forEach((c) => {
        const m = parseMonthLabel(table.headers[c]);
        if (m) put(year, m.month, row[c], line);
      });
    }
  });
  const months = [...out.entries()].sort().map(([month, turnover]) => ({ month, turnover }));
  if (!months.length) r.notes.push('No monthly turnover figures were found.');
  return {
    records: { months },
    stats: { rows: table.rows.length, accepted: months.length, skipped: Math.max(0, table.rows.length - months.length) },
    issues: r.issues,
    notes: r.notes,
    range: months.length ? { from: months[0].month, to: months[months.length - 1].month } : null
  };
}

/** Rows to records for a kind. Returns { records, stats, issues, notes, range }. */
function normalize(kind, table, mapping, options) {
  if (kind === 'ledger') return ledger(table, mapping, options);
  if (kind === 'bank') return bank(table, mapping, options);
  if (kind === 'pnl') return pnl(table, mapping, options);
  throw new Error('Unknown kind: ' + kind);
}

module.exports = { normalize };
