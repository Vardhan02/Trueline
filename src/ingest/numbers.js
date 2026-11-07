'use strict';

/** Strip currency, spaces and sign; returns { s, negative } with s holding only digits and separators, or null. */
function clean(value) {
  let s = String(value)
    .trim()
    .replace(/\b(EUR|GBP|USD|CHF)\b/gi, '');
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s.trim())) {
    negative = true;
    s = s.trim().slice(1, -1);
  }
  s = s.replace(/[€£$\s\u00A0\u202F'’]/g, ''); // spaces, no-break spaces and Swiss apostrophes group thousands
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.endsWith('-')) {
    negative = true;
    s = s.slice(0, -1);
  }
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  return { s, negative };
}

/**
 * Parse a money or number cell as it appears in real exports.
 * Handles "1,234.50", "1.234,50", "(500.00)", "-500", "500-", "£1,200", "1’500.50" and "1200 EUR".
 * `decimalComma` is the column's style when known (see detectDecimalComma): it settles cells such as "1.500",
 * which is 1500 in a column written "1.234,50" but 1.5 in one written "1,234.50".
 * Returns null when the cell is not a number, so callers can count and report skipped rows.
 */
function parseNumber(value, { decimalComma } = {}) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const c = clean(value);
  if (!c) return null;
  const { s } = c;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let plain;
  if (lastComma >= 0 && lastDot >= 0) {
    // Whichever separator comes last is the decimal point.
    plain = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // "1,234" and "1,234,567" are thousands; "12,5" and "12,50" are decimals. A known column style decides "1,234".
    const grouped = /^\d{1,3}(,\d{3})+$/.test(s);
    plain = grouped && decimalComma !== true ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if ((s.match(/\./g) || []).length > 1 || (decimalComma === true && /^\d{1,3}(\.\d{3})+$/.test(s))) {
    plain = s.replace(/\./g, ''); // "2.500.000", or "1.500" in a column that uses a decimal comma
  } else {
    plain = s;
  }
  const n = Number(plain);
  if (!Number.isFinite(n)) return null;
  return c.negative ? -n : n;
}

/**
 * Decide whether a column writes decimals with a comma ("1.234,50") or a point ("1,234.50"), from the values that
 * can only be read one way. Returns true, false, or undefined when nothing in the column settles it.
 */
function detectDecimalComma(values) {
  let comma = 0;
  let point = 0;
  for (const v of values) {
    if (v == null || typeof v === 'number') continue;
    const c = clean(v);
    if (!c) continue;
    const { s } = c;
    if (/\.\d{3},\d+$/.test(s) || /^\d+,\d{1,2}$/.test(s))
      comma++; // "1.234,50", "800,00", "12,5"
    else if (/,\d{3}\.\d+$/.test(s) || /^\d+\.\d{1,2}$/.test(s)) point++; // "1,234.50", "800.00", "12.5"
  }
  if (comma === point) return undefined;
  return comma > point;
}

module.exports = { parseNumber, detectDecimalComma };
