'use strict';

/**
 * Parse a money or number cell as it appears in real exports.
 * Handles "1,234.50", "1.234,50", "(500.00)", "-500", "500-", "£1,200" and "1200 EUR".
 * Returns null when the cell is not a number, so callers can count and report skipped rows.
 */
function parseNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = String(value)
    .trim()
    .replace(/\b(EUR|GBP|USD)\b/gi, '');
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s.trim())) {
    negative = true;
    s = s.trim().slice(1, -1);
  }
  s = s.replace(/[€£$\s\u00A0]/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.endsWith('-')) {
    negative = true;
    s = s.slice(0, -1);
  }
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let plain;
  if (lastComma >= 0 && lastDot >= 0) {
    // Whichever separator comes last is the decimal point.
    plain = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // "1,234" and "1,234,567" are thousands; "12,5" and "12,50" are decimals.
    plain = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if ((s.match(/\./g) || []).length > 1) {
    plain = s.replace(/\./g, '');
  } else {
    plain = s;
  }
  const n = Number(plain);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

module.exports = { parseNumber };
