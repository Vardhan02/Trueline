'use strict';

/**
 * Rule-based extraction of payment claims from emails. No model involved: a claim is only produced when
 * a sentence in the email contains a known invoice or bill number, and the quote is that exact sentence,
 * so every claim can be checked against the original text.
 */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const MONEY = /[€£$]\s?(\d[\d,]*(?:\.\d{1,2})?)/;
const DAY_MS = 864e5;

const iso = (d) => d.toISOString().slice(0, 10);

function sentences(body) {
  return String(body)
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveDate(sentence, sentDate) {
  const base = new Date(sentDate);
  if (Number.isNaN(base.getTime())) return null;
  const dm = sentence.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i);
  if (dm) {
    const year = base.getUTCFullYear();
    const d = new Date(Date.UTC(year, MONTHS[dm[2].toLowerCase()] - 1, Number(dm[1])));
    if (d.getTime() < base.getTime() - 180 * DAY_MS) d.setUTCFullYear(year + 1);
    return iso(d);
  }
  const wd = sentence.match(/\b(?:on |by |this |next )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (wd) {
    const target = WEEKDAYS[wd[1].toLowerCase()];
    const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
    const ahead = (target - start.getUTCDay() + 7) % 7 || 7;
    return iso(new Date(start.getTime() + ahead * DAY_MS));
  }
  return null;
}

const PAID =
  /\b(released|remitted|sent|made|processed|settled|paid|transferred)\b[^.]*(\bpayment|[€£$])|\b(payment|remittance)\b[^.]*\b(sent|made|released|processed)\b|\bhas been paid\b|\bwe(?:'ve| have) paid\b/i;
const PARTIAL = /\b(balance|remainder|remaining)\b[^.]*\b(follow|next|later)\b|\bpart[- ]?payment\b|\bon account\b|\bpartial\b/i;
const PROMISE =
  /\bwe(?:'ll| will)\s+(?:pay|settle|make payment|process)|\bwill be (?:paid|settled)|\bpayment (?:will|is scheduled|is due)|\bplan to pay|\bpromise/i;
const NOTICE = /\b(second|final|third|first)\s+notice\b|\bfalls? due\b|\bis due\b|\bplease arrange payment\b|\bpayment is requested\b|\boverdue\b/i;
const CHASE = /\b(overdue|unpaid|outstanding|reminder|past due)\b/i;

/**
 * @param {{from,to,date,subject,body}} mail  parsed email (date ISO)
 * @param {Array<{id,party,type}>} ledger     known invoices and bills
 * @param {string} ownDomain                  your email domain, to tell sent from received
 * @returns {{direction:'sent'|'received', extracted:Array}}
 */
function extractClaims(mail, ledger, ownDomain) {
  const own = String(ownDomain || '')
    .toLowerCase()
    .replace(/^@/, '');
  const direction =
    own &&
    String(mail.from || '')
      .toLowerCase()
      .includes('@' + own)
      ? 'sent'
      : 'received';
  const byId = new Map(ledger.map((l) => [l.id.toLowerCase(), l]));
  const ids = [...byId.keys()].sort((a, b) => b.length - a.length);
  const extracted = [];
  const seen = new Set();

  // A claim sentence often does not repeat the invoice number ("We will pay this on Friday."), so fall back to the
  // most recent number mentioned earlier in the body, then to the subject line.
  const findId = (text) => ids.find((i) => text.toLowerCase().includes(i));
  let lastId = findId(String(mail.subject || ''));
  sentences(mail.body).forEach((sentence) => {
    const own = findId(sentence);
    if (own) lastId = own;
    const id = own || lastId;
    if (!id) return;
    const rec = byId.get(id);
    const m = sentence.match(MONEY);
    const amount = m ? Number(m[1].replace(/,/g, '')) : undefined;
    let claim = null;
    if (direction === 'sent') {
      if (CHASE.test(sentence)) claim = { kind: 'chase_sent', claim: 'outstanding' };
    } else if (PROMISE.test(sentence)) {
      claim = { kind: 'promise_to_pay', claim: 'outstanding', promisedDate: resolveDate(sentence, mail.date) || undefined };
    } else if (PAID.test(sentence)) {
      claim = { kind: 'payment_claim', claim: PARTIAL.test(mail.body) ? 'partial_paid' : 'paid' };
    } else if (NOTICE.test(sentence)) {
      claim = {
        kind: rec.type === 'payable' ? 'supplier_notice' : 'chase_received',
        claim: 'outstanding',
        dueDate: resolveDate(sentence, mail.date) || undefined
      };
    }
    if (!claim || seen.has(claim.kind + id)) return;
    seen.add(claim.kind + id);
    const out = Object.assign(
      { kind: claim.kind, ref: rec.id, party: rec.party, claim: claim.claim },
      amount != null ? { amount } : {},
      claim.promisedDate ? { promisedDate: claim.promisedDate } : {},
      claim.dueDate ? { dueDate: claim.dueDate } : {},
      { quote: sentence }
    );
    extracted.push(out);
  });
  return { direction, extracted };
}

module.exports = { extractClaims, sentences };
