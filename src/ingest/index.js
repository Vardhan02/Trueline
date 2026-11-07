'use strict';

const { identifyFile, UnsupportedFileError } = require('./files');
const { readDelimited, readWorkbook } = require('./tabular');
const { parseOfx } = require('./ofx');
const { parseEml } = require('./eml');
const { propose, fieldSpecs } = require('./detect');
const { normalize } = require('./normalize');

const PREVIEW_ROWS = 5;

async function readTables(buffer, type) {
  if (type === 'csv') return [readDelimited(buffer)].filter((t) => t.headers.length > 0);
  return readWorkbook(buffer);
}

const cellText = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '' : String(v));

/**
 * Step 1 of an upload: look at the file and say what we think it is. Nothing is saved.
 * Returns { type, kind, confidence, tables:[{name,headers,preview,proposals}], fields } or a no-table result for ofx/eml.
 */
async function inspect(buffer, filename) {
  const type = identifyFile(buffer, filename);
  if (type === 'ofx') {
    const o = parseOfx(buffer);
    return { type, kind: 'bank', confidence: 1, tables: [], summary: o.transactions.length + ' transactions' };
  }
  if (type === 'eml') {
    const m = parseEml(buffer);
    return { type, kind: 'emails', confidence: 1, tables: [], summary: m.subject || '(no subject)' };
  }
  const tables = await readTables(buffer, type);
  if (!tables.length) throw new UnsupportedFileError('No data found in this file.');
  const described = tables.map((t, index) => {
    const proposals = propose(t, { filename });
    return { index, name: t.name, headers: t.headers, rowCount: t.rows.length, preview: t.rows.slice(0, PREVIEW_ROWS).map((r) => r.map(cellText)), proposals };
  });
  const best = described.map((t) => ({ t, p: t.proposals[0] })).sort((a, b) => b.p.confidence - a.p.confidence)[0];
  return {
    type,
    kind: best.p.kind,
    confidence: best.p.confidence,
    table: best.t.index,
    tables: described,
    fields: { ledger: fieldSpecs('ledger'), bank: fieldSpecs('bank'), pnl: fieldSpecs('pnl') }
  };
}

/**
 * Step 2: turn the file into records using the (possibly user-corrected) choice.
 * choice: { kind, table?, mapping?, options? }. Returns a source ready to store (without id/uploadedAt).
 */
async function ingest(buffer, filename, choice = {}) {
  const type = identifyFile(buffer, filename);
  if (type === 'ofx') {
    const o = parseOfx(buffer);
    const records = {
      transactions: o.transactions.map((t) => ({ id: t.id, date: t.date, amount: t.amount, description: t.description, reference: t.reference })),
      balance: o.balance,
      balanceDate: o.balanceDate
    };
    if (!o.transactions.length && o.balance == null) throw new UnsupportedFileError('No transactions or balance were found in this bank file.');
    const dates = o.transactions.map((t) => t.date).sort();
    return {
      kind: 'bank',
      file: filename,
      records,
      stats: { rows: o.transactions.length, accepted: o.transactions.length, skipped: 0 },
      issues: [],
      notes: o.balance == null ? ['No balance in this file.'] : [],
      range: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null
    };
  }
  if (type === 'eml') {
    const m = parseEml(buffer);
    if (!m.from && !m.date && m.subject === '(no subject)')
      throw new UnsupportedFileError('This does not look like an email: it has no From, Date or Subject line. Forward the original message.');
    const notes = [];
    if (!m.date) {
      m.date = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      m.dateAssumed = true; // so a resend of the same email is still recognised as a duplicate
      notes.push('This email has no Date header, so the upload time was used.');
    }
    return {
      kind: 'emails',
      file: filename,
      records: [m],
      stats: { rows: 1, accepted: 1, skipped: 0 },
      issues: [],
      notes,
      range: { from: m.date.slice(0, 10), to: m.date.slice(0, 10) }
    };
  }
  const tables = await readTables(buffer, type);
  const table = tables[choice.table || 0];
  if (!table) throw new UnsupportedFileError('That sheet does not exist.');
  let { kind, mapping, options } = choice;
  let proposal;
  if (!kind || !mapping) {
    proposal = propose(table, { filename }).find((p) => !kind || p.kind === kind) || { kind: null };
    kind = kind || proposal.kind;
    mapping = mapping || proposal.mapping;
    options = Object.assign({}, proposal.layout ? { layout: proposal.layout } : {}, proposal.options, options);
  }
  if (!kind || !mapping) throw new UnsupportedFileError('We could not tell what this file contains. Choose its type and match the columns.');
  const specs = fieldSpecs(kind).filter((f) => f.required);
  // A ledger can give either the invoice amount or only what is still owed; normalize() reads whichever is there.
  const covered = (f) => (kind === 'pnl' && mapping.months) || (kind === 'ledger' && f.field === 'amount' && mapping.outstanding != null);
  const missing = specs
    .filter((f) => mapping[f.field] == null && !covered(f))
    .map((f) => (kind === 'ledger' && f.field === 'amount' ? f.label + ' (or amount still owed)' : f.label));
  if (missing.length) throw new UnsupportedFileError('Missing columns: ' + missing.join(', ') + '.');
  const result = normalize(kind, table, mapping, options);
  const empty = (kind === 'bank' ? result.records.transactions.length : kind === 'pnl' ? result.records.months.length : result.records.length) === 0;
  if (empty) throw new UnsupportedFileError('No usable rows were found. ' + (result.notes[0] || (result.issues[0] ? result.issues[0].message : '')));
  return Object.assign({ kind, file: filename }, result);
}

module.exports = { inspect, ingest, UnsupportedFileError };
