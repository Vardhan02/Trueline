'use strict';

/**
 * Turns a workspace (settings + uploaded sources) into the dataset the engine reads.
 * Pure function: same workspace in, same dataset out. Nothing here touches disk or the network.
 */

const { extractClaims } = require('./extract');

const DEFAULT_SETTINGS = Object.freeze({
  company: 'Your company',
  currency: 'EUR',
  asOf: null, // 'YYYY-MM-DD' to pin the "today" date, or null to use the real clock
  costOfSalesPct: 0.6,
  overheadsMonthly: 0,
  staleDays: 7,
  termsDays: 30,
  emailDomain: ''
});

const SOURCE_NAMES = {
  ledger: ['Accounting ledger', 'ledger'],
  bank: ['Bank feed', 'bank'],
  pnl: ['P&L workings', 'P&L'],
  emails: ['Finance inbox', 'email']
};

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const toIsoDateTime = (d, fallbackTime) => (d.length === 10 ? d + 'T' + fallbackTime + 'Z' : d);

function resolveNow(settings, clock) {
  if (settings.asOf) return settings.asOf + 'T06:30:00Z';
  return new Date(clock()).toISOString().replace(/\.\d+Z$/, 'Z');
}

function collectLedger(sources) {
  const byKey = new Map();
  sources
    .filter((s) => s.kind === 'ledger')
    .forEach((s) => {
      s.records.forEach((r) =>
        byKey.set(r.type + ':' + r.id, {
          id: r.id,
          type: r.type,
          party: r.party,
          amount: r.amount,
          issued: r.issued,
          due: r.due,
          status: r.status,
          row: r.row,
          file: s.file
        })
      );
    });
  return [...byKey.values()];
}

/** Match bank lines to invoices by reference first, then by customer name plus amount. Unmatched lines keep their own text. */
function matchBank(transactions, ledger) {
  const open = ledger.filter((l) => l.type === 'receivable' && l.status === 'open');
  return transactions
    .filter((t) => t.amount > 0)
    .map((t, i) => {
      const text = norm(t.description + ' ' + (t.reference || ''));
      const byRef = ledger.find((l) => l.type === 'receivable' && text.includes(norm(l.id)));
      const byName = byRef || open.find((l) => norm(l.party).length >= 3 && text.includes(norm(l.party)));
      const hit = byRef || byName;
      return {
        id: t.id || 'TX-' + String(i + 1).padStart(4, '0'),
        date: toIsoDateTime(t.date, '12:00:00'),
        counterparty: hit ? hit.party : t.description || 'Unknown',
        amount: t.amount,
        reference: byRef ? byRef.id : t.reference || ''
      };
    });
}

function collectBank(sources, ledger, now) {
  const banks = sources.filter((s) => s.kind === 'bank');
  if (!banks.length) return null;
  const seen = new Set();
  const txs = [];
  banks.forEach((s) =>
    s.records.transactions.forEach((t) => {
      const key = [t.date, t.amount, t.description, t.reference].join('|');
      if (!seen.has(key)) {
        seen.add(key);
        txs.push(t);
      }
    })
  );
  const withBalance = banks
    .filter((s) => typeof s.records.balance === 'number')
    .sort((a, b) => String(a.records.balanceDate).localeCompare(String(b.records.balanceDate)));
  const last = withBalance[withBalance.length - 1];
  const syncedAt = banks
    .map((s) => s.uploadedAt)
    .sort()
    .pop();
  return { syncedAt: syncedAt > now ? now : syncedAt, balance: last ? last.records.balance : null, transactions: matchBank(txs, ledger) };
}

/** Full calendar years become seasonality history. A trailing partial year becomes year-to-date. */
function collectPnl(sources, settings) {
  const pnls = sources.filter((s) => s.kind === 'pnl');
  if (!pnls.length) return null;
  const all = new Map();
  pnls.forEach((s) => s.records.months.forEach((m) => all.set(m.month, m.turnover)));
  const byYear = new Map();
  [...all.entries()].sort().forEach(([month, v]) => {
    const [y, m] = month.split('-').map(Number);
    if (!byYear.has(y)) byYear.set(y, new Array(12).fill(null));
    byYear.get(y)[m - 1] = v;
  });
  const years = {};
  let ytdYear = null;
  let ytd = [];
  [...byYear.keys()].sort().forEach((y) => {
    const arr = byYear.get(y);
    if (arr.every((v) => v != null)) years[y] = arr;
    else {
      const firstGap = arr.findIndex((v) => v == null);
      const run = arr.slice(0, firstGap === -1 ? 12 : firstGap);
      if (run.length) {
        ytdYear = y;
        ytd = run;
      }
    }
  });
  if (!Object.keys(years).length) return null;
  return { years, ytdYear, ytd, costOfSalesPct: settings.costOfSalesPct, overheadsMonthly: settings.overheadsMonthly };
}

function collectEmails(sources, ledger, settings) {
  const out = [];
  sources
    .filter((s) => s.kind === 'emails')
    .forEach((s) =>
      s.records.forEach((mail) => {
        const { direction, extracted } = extractClaims(mail, ledger, settings.emailDomain);
        out.push({ id: 'E' + (out.length + 1), direction, from: mail.from, to: mail.to, date: mail.date, subject: mail.subject, body: mail.body, extracted });
      })
    );
  return out.sort((a, b) => b.date.localeCompare(a.date)).map((e, i) => Object.assign(e, { id: 'E' + (i + 1) }));
}

function syncedOf(sources, kind, fallback) {
  const times = sources
    .filter((s) => s.kind === kind)
    .map((s) => s.uploadedAt)
    .sort();
  return times.length ? times[times.length - 1] : fallback;
}

/**
 * @param {{settings:object, sources:Array}} workspace
 * @param {{clock?:()=>number}} [opts]  injectable clock for tests
 */
function buildDataset(workspace, opts = {}) {
  const clock = opts.clock || Date.now;
  const settings = Object.assign({}, DEFAULT_SETTINGS, workspace.settings);
  const sources = workspace.sources || [];
  const now = resolveNow(settings, clock);
  const ledger = collectLedger(sources);
  const bank = collectBank(sources, ledger, now);
  const pnl = collectPnl(sources, settings);
  const emails = collectEmails(sources, ledger, settings);

  const clamp = (t) => (t > now ? now : t);
  const files = (kind) =>
    sources
      .filter((s) => s.kind === kind)
      .map((s) => s.file)
      .join(', ');
  const data = {
    COMPANY: settings.company,
    CURRENCY: settings.currency,
    NOW: now,
    STALE_DAYS: settings.staleDays,
    SOURCES: {},
    LEDGER: ledger,
    EMAILS: emails
  };
  const add = (id, kind, type, fallbackFile) => {
    const [name, short] = SOURCE_NAMES[kind];
    data.SOURCES[id] = { id, type, name, short, file: files(kind) || fallbackFile, syncedAt: clamp(syncedOf(sources, kind, now)) };
  };
  if (ledger.length) add('ledger', 'ledger', 'ledger');
  else add('ledger', 'ledger', 'ledger', 'no file yet');
  if (bank) {
    data.BANK = bank;
    add('bank', 'bank', 'bank');
  }
  if (pnl) {
    data.PNL = pnl;
    add('pnl', 'pnl', 'sheet');
  }
  if (emails.length) add('inbox', 'emails', 'email');
  return data;
}

module.exports = { buildDataset, matchBank, DEFAULT_SETTINGS };
