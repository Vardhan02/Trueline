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
  const all = [...byKey.values()];
  // Customer invoices and supplier bills are numbered independently, so "1001" can be both. Give the bill its own
  // reference so the two are never merged into one item (and one silently dropped).
  const invoiceIds = new Set(all.filter((l) => l.type === 'receivable').map((l) => l.id));
  all.forEach((l) => {
    if (l.type === 'payable' && invoiceIds.has(l.id)) l.ref = l.id + ' (bill)';
  });
  return all;
}

/**
 * An index of normalised phrases ("inv 10", "acme ltd") to the first record that has them, in ledger order. A text
 * is matched by looking up each run of its words, so the cost grows with the text, not with the size of the ledger.
 */
function phraseIndex(records, keyOf, minLength) {
  const map = new Map();
  let maxWords = 0;
  records.forEach((r, order) => {
    const k = keyOf(r);
    if (k.length < minLength || map.has(k)) return;
    map.set(k, { r, order });
    maxWords = Math.max(maxWords, k.split(' ').length);
  });
  /** The record whose phrase is the longest whole-word match in `text` (ties: earliest in the ledger), or undefined. */
  return (text) => {
    const words = text.split(' ').filter(Boolean);
    let best;
    let bestLength = -1;
    for (let i = 0; i < words.length; i++) {
      let phrase = '';
      for (let j = i; j < Math.min(words.length, i + maxWords); j++) {
        phrase = j === i ? words[j] : phrase + ' ' + words[j];
        const hit = map.get(phrase);
        if (hit && (phrase.length > bestLength || (phrase.length === bestLength && hit.order < best.order))) {
          best = hit;
          bestLength = phrase.length;
        }
      }
    }
    return best && best.r;
  };
}

/**
 * Match bank lines to invoices by reference first, then by customer name. Matching is on whole words: a payment for
 * INV-10 must never be credited to INV-1. The longest matching reference wins. Unmatched lines keep their own text.
 */
function matchBank(transactions, ledger) {
  const receivables = ledger.filter((l) => l.type === 'receivable');
  const findRef = phraseIndex(receivables, (l) => norm(l.id), 3); // "1" or "12" would match dates and amounts in any description
  const findName = phraseIndex(
    receivables.filter((l) => l.status === 'open'),
    (l) => norm(l.party),
    3
  );
  const seen = new Map();
  return transactions
    .filter((t) => t.amount > 0)
    .map((t, i) => {
      const text = norm(t.description + ' ' + (t.reference || ''));
      const byRef = findRef(text);
      const byName = byRef || findName(text);
      const hit = byRef || byName;
      // Bank references repeat ("INTEREST", "DD"); every transaction still needs its own id to be cited.
      const base = t.id || 'TX-' + String(i + 1).padStart(4, '0');
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      return {
        id: n > 1 ? base + '-' + n : base,
        date: toIsoDateTime(t.date, '12:00:00'),
        counterparty: hit ? hit.party : t.description || 'Unknown',
        amount: t.amount,
        reference: byRef ? byRef.id : t.reference || '',
        matched: Boolean(hit)
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
  // Latest balance date wins. A statement with no balance date counts as the oldest; ties go to the newest upload.
  const when = (s) => [s.records.balanceDate || '', s.uploadedAt || ''];
  const withBalance = banks
    .filter((s) => typeof s.records.balance === 'number')
    .sort((a, b) => when(a)[0].localeCompare(when(b)[0]) || when(a)[1].localeCompare(when(b)[1]));
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
  byYear.forEach((arr, y) => {
    if (arr.every((v) => v != null)) years[y] = arr;
  });
  const full = Object.keys(years).map(Number);
  if (!full.length) return null;
  // Year to date is the latest partial year after the last full one. Earlier partial years (data that starts or
  // stops mid-year) are not "this year" and must not drive the forecast.
  const lastFull = Math.max(...full);
  let ytdYear = null;
  let ytd = [];
  [...byYear.keys()]
    .filter((y) => y > lastFull)
    .sort()
    .forEach((y) => {
      const arr = byYear.get(y);
      const firstGap = arr.findIndex((v) => v == null);
      const run = arr.slice(0, firstGap);
      if (run.length) {
        ytdYear = y;
        ytd = run;
      }
    });
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
