'use strict';

const { parse } = require('csv-parse/sync');
const { decodeText } = require('./files');

const MAX_HEADER_SCAN = 20;

/** Pick the delimiter that splits the first lines into the most consistent number of columns. */
function detectDelimiter(text) {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 10);
  let best = ',';
  let bestScore = 0;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const min = Math.min(...counts);
    const score = min > 0 ? min * 100 + counts.filter((c) => c === counts[0]).length : 0;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

const isBlank = (c) => c == null || String(c).trim() === '';
const isNumeric = (c) => typeof c === 'number' || /^[-+(]?[€£$]?\s?[\d.,]+\)?$/.test(String(c).trim());

/** Bank and accounting exports often start with title lines. The header is the first wide row of mostly text. */
function findHeaderRow(rows) {
  const scan = rows.slice(0, MAX_HEADER_SCAN);
  const widths = scan.map((r) => r.filter((c) => !isBlank(c)).length);
  const widest = Math.max(0, ...widths);
  if (widest < 2) return 0;
  for (let i = 0; i < scan.length; i++) {
    if (widths[i] < Math.max(2, Math.ceil(widest * 0.6))) continue;
    const cells = scan[i].filter((c) => !isBlank(c));
    if (cells.filter((c) => !isNumeric(c)).length / cells.length >= 0.6) return i;
  }
  return 0;
}

function uniqueHeaders(row) {
  const seen = new Map();
  return row.map((cell, i) => {
    let h = isBlank(cell) ? 'Column ' + (i + 1) : String(cell).trim();
    const n = (seen.get(h) || 0) + 1;
    seen.set(h, n);
    if (n > 1) h += ' (' + n + ')';
    return h;
  });
}

/** Turn a grid of cells into { headers, rows, headerRow } and drop empty rows and empty trailing columns. */
function tableFromGrid(grid, name) {
  const numbered = grid.map((r, i) => ({ r, line: i + 1 })).filter((x) => x.r.some((c) => !isBlank(c)));
  const rows = numbered.map((x) => x.r);
  const headerRow = findHeaderRow(rows);
  const header = rows[headerRow] || [];
  let width = header.length;
  while (width > 0 && isBlank(header[width - 1]) && rows.slice(headerRow + 1).every((r) => isBlank(r[width - 1]))) width--;
  return {
    name: name || null,
    headers: uniqueHeaders(header.slice(0, width)),
    rows: rows.slice(headerRow + 1).map((r) => Array.from({ length: width }, (_, i) => (r[i] === undefined ? null : r[i]))),
    lines: numbered.slice(headerRow + 1).map((x) => x.line), // original row numbers, for error messages
    headerRow: headerRow + 1
  };
}

function readDelimited(buffer) {
  const text = decodeText(buffer);
  const delimiter = detectDelimiter(text);
  const grid = parse(text, { delimiter, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, trim: true });
  return Object.assign(tableFromGrid(grid), { delimiter });
}

/** Read every sheet of an .xlsx workbook. read-excel-file is ESM-first, so it is loaded lazily. */
async function readWorkbook(buffer) {
  const { default: readExcel } = await import('read-excel-file/node');
  const sheets = await readExcel(buffer);
  return sheets.map((s) => tableFromGrid(s.data, s.sheet)).filter((t) => t.headers.length > 0);
}

module.exports = { readDelimited, readWorkbook, tableFromGrid, detectDelimiter, findHeaderRow };
