'use strict';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => (n < 10 ? '0' + n : String(n));

function monthNumber(name) {
  return MONTHS.indexOf(String(name).slice(0, 3).toLowerCase()) + 1;
}

function build(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1) return null; // e.g. 31 Feb
  return year + '-' + pad(month) + '-' + pad(day);
}

const fullYear = (y) => (y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y);

/**
 * Parse a date cell to "YYYY-MM-DD", or null. Accepts ISO, DD/MM/YYYY (or MM/DD/YYYY when dayFirst is false),
 * "9 Nov 2026", "Nov 9, 2026", OFX "20261109120000", JS Dates and Excel serial numbers.
 */
function parseDate(value, { dayFirst = true } = {}) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    if (value > 20000 && value < 80000) return new Date(Date.UTC(1899, 11, 30) + value * 864e5).toISOString().slice(0, 10);
    return null;
  }
  const s = String(value).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return build(+m[1], +m[2], +m[3]);
  m = /^(\d{4})(\d{2})(\d{2})(?:\d{4,6}.*)?$/.exec(s);
  if (m) return build(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[T\s].*)?$/.exec(s);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    return dayFirst ? build(fullYear(+m[3]), b, a) : build(fullYear(+m[3]), a, b);
  }
  m = /^(\d{1,2})[\s\-/]([A-Za-z]{3,9})\.?[\s\-/,]*(\d{2,4})$/.exec(s);
  if (m && monthNumber(m[2])) return build(fullYear(+m[3]), monthNumber(m[2]), +m[1]);
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
  if (m && monthNumber(m[1])) return build(+m[3], monthNumber(m[1]), +m[2]);
  return null;
}

/** Decide whether ambiguous "03/04/2026" dates are day-first by looking for an unambiguous value in the column. */
function detectDayFirst(values, fallback = true) {
  for (const v of values) {
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/.exec(String(v == null ? '' : v).trim());
    if (!m) continue;
    if (+m[1] > 12) return true;
    if (+m[2] > 12) return false;
  }
  return fallback;
}

/**
 * Read a month label such as "Jan-24", "January 2024", "2024-01", "01/2024" or just "Jan".
 * Returns { month: 1-12, year: number|null } or null.
 */
/** Whole month names and the usual abbreviations only, so "Marketing" or "Decorations" are not read as months. */
const MONTH_WORD = /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)$/i;

function parseMonthLabel(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : { month: value.getUTCMonth() + 1, year: value.getUTCFullYear() };
  if (value == null) return null;
  const s = String(value).trim();
  let m = /^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?$/.exec(s);
  if (m && +m[2] >= 1 && +m[2] <= 12) return { month: +m[2], year: +m[1] };
  m = /^(\d{1,2})[-/](\d{4})$/.exec(s);
  if (m && +m[1] >= 1 && +m[1] <= 12) return { month: +m[1], year: +m[2] };
  m = /^([A-Za-z]{3,9})\.?[\s\-/']*(\d{2,4})?$/.exec(s);
  if (m && MONTH_WORD.test(m[1])) {
    return { month: monthNumber(m[1]), year: m[2] ? fullYear(+m[2]) : null };
  }
  const full = parseDate(s);
  if (full) return { month: +full.slice(5, 7), year: +full.slice(0, 4) };
  return null;
}

module.exports = { parseDate, detectDayFirst, parseMonthLabel, monthNumber };
