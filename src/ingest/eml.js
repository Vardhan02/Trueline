'use strict';

const { decodeText } = require('./files');

/** Bytes to text in the charset the email declares ("iso-8859-1", "windows-1252", …); UTF-8 when unknown. */
function decodeBytes(buf, charset) {
  const cs = String(charset || 'utf-8')
    .trim()
    .toLowerCase();
  try {
    return new TextDecoder(cs === 'us-ascii' || cs === 'ascii' ? 'windows-1252' : cs).decode(buf);
  } catch {
    return buf.toString('utf8'); // a charset the runtime does not know
  }
}
const qpBytes = (s) =>
  Buffer.from(
    s.replace(/=([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))),
    'latin1'
  );

function decodeWords(s) {
  return (
    String(s)
      // RFC 2047: whitespace between two encoded words is not part of the text ("=?..?= =?..?=" is one word split in two).
      .replace(/(\?=)\s+(?==\?)/g, '$1')
      .replace(/=\?([\w-]+)(?:\*[\w-]+)?\?([bq])\?([^?]*)\?=/gi, (_, cs, enc, data) =>
        decodeBytes(enc.toLowerCase() === 'b' ? Buffer.from(data, 'base64') : qpBytes(data.replace(/_/g, ' ')), cs)
      )
  );
}

function decodeBody(body, encoding, charset) {
  const e = String(encoding || '').toLowerCase();
  if (e === 'base64') return decodeBytes(Buffer.from(body.replace(/\s+/g, ''), 'base64'), charset);
  if (e === 'quoted-printable') return decodeBytes(qpBytes(body.replace(/=\r?\n/g, '')), charset);
  return body;
}

function splitHeaders(text) {
  const idx = text.search(/\r?\n\r?\n/);
  const head = idx < 0 ? text : text.slice(0, idx);
  const body = idx < 0 ? '' : text.slice(idx).replace(/^\r?\n\r?\n/, '');
  const headers = {};
  head
    .replace(/\r?\n[ \t]+/g, ' ')
    .split(/\r?\n/)
    .forEach((line) => {
      const m = /^([^:]+):\s*(.*)$/.exec(line);
      if (m && !(m[1].toLowerCase() in headers)) headers[m[1].toLowerCase()] = m[2];
    });
  return { headers, body };
}

const stripHtml = (h) =>
  h
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => safeChar(parseInt(h, 16), m))
    .replace(/&#(\d{1,7});/g, (m, d) => safeChar(Number(d), m))
    .replace(/&([a-z]+);/gi, (m, name) => (ENTITIES[name.toLowerCase()] != null ? ENTITIES[name.toLowerCase()] : m));
// Named entities that matter for money and punctuation in remittance emails. "&amp;" last-resolved is fine: one pass only.
const ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  pound: '£',
  euro: '€',
  dollar: '$',
  cent: '¢',
  yen: '¥',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“'
};
const safeChar = (code, fallback) => (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback);

const MAX_DEPTH = 12;

/** Pull readable text out of a (possibly multipart) message. Prefers text/plain, falls back to stripped HTML. */
function bodyText(headers, body, depth = 0, ctx = {}) {
  if (depth > MAX_DEPTH) return ''; // real mail nests a few levels; thousands is a crafted file
  const type = headers['content-type'] || 'text/plain';
  const boundary = /boundary="?([^";\s]+)"?/i.exec(type);
  if (/multipart\//i.test(type) && boundary) {
    const parts = body
      .split('--' + boundary[1])
      .slice(1)
      .filter((p) => !p.startsWith('--'))
      .map((p) => {
        const raw = p.replace(/^\r?\n/, '');
        // A part that starts with a blank line has no headers of its own: it is all body.
        return /^\r?\n/.test(raw) ? { headers: {}, body: raw.replace(/^\r?\n/, '') } : splitHeaders(raw);
      });
    const texts = parts.map((p) => ({ type: p.headers['content-type'] || 'text/plain', text: bodyText(p.headers, p.body, depth + 1, ctx) }));
    const plain = texts.find((t) => /text\/plain/i.test(t.type) && t.text.trim());
    // Otherwise HTML or a nested part, never an attachment (a PDF decoded as text is noise).
    const readable = texts.find((t) => /^\s*(text\/|multipart\/)/i.test(t.type) && t.text.trim());
    // An email forwarded as an attachment carries the remittance itself: keep its text too.
    const attached = texts.filter((t) => /^\s*message\/rfc822/i.test(t.type) && t.text.trim()).map((t) => t.text);
    return [(plain || readable || { text: '' }).text]
      .concat(attached)
      .filter((x) => x.trim())
      .join('\n\n');
  }
  if (/^\s*message\/rfc822/i.test(type)) {
    const inner = splitHeaders(decodeBody(body, headers['content-transfer-encoding']));
    if (!ctx.attached) ctx.attached = inner.headers; // the original of an email forwarded as an attachment
    return bodyText(inner.headers, inner.body, depth + 1, ctx);
  }
  if (!/^\s*text\//i.test(type)) return ''; // an attachment sent as the whole message body
  const charset = (/charset="?([^";\s]+)"?/i.exec(type) || [])[1];
  const decoded = decodeBody(body, headers['content-transfer-encoding'], charset);
  return /text\/html/i.test(type) ? stripHtml(decoded) : decoded;
}

/**
 * The address in a From/To header. The address is in the last <…> (a display name may itself contain "<…>"),
 * else the first thing that looks like an address, else the header as written.
 */
function address(h) {
  const v = String(h || '');
  const angled = v.match(/<([^<>]+)>/g);
  if (angled) return angled[angled.length - 1].slice(1, -1).trim();
  const bare = /[^\s<>(),;:"]+@[^\s<>(),;:"]+/.exec(v);
  return (bare ? bare[0] : v).trim();
}

/** A header date as ISO, or null. A date with no time zone (Outlook's "Sent:" line) is read as UTC, not server time. */
function isoDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  const hasZone = /([+-]\d{2}:?\d{2}|\bGMT|\bUTC|Z|\(\w+\))\s*$/i.test(s);
  const d = new Date(hasZone ? s : s + ' UTC');
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The header block of a message forwarded inline: Gmail ("---------- Forwarded message ---------"),
 * Outlook ("-----Original Message-----", with "Sent:" for the date) and Apple Mail ("Begin forwarded message:").
 */
function inlineForward(text) {
  const m = /(?:^|\n)[ \t>]*(?:-{2,}\s*(?:Forwarded message|Original Message)\s*-{2,}|Begin forwarded message:)[ \t]*\r?\n([\s\S]*)/i.exec(text);
  if (!m) return null;
  const head = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) {
      if (Object.keys(head).length) break;
      continue;
    }
    const h = /^[ \t>]*\*?(From|Date|Sent|To|Subject)\*?:\s*(.*)$/i.exec(line);
    if (!h) break;
    const k = h[1].toLowerCase() === 'sent' ? 'date' : h[1].toLowerCase();
    if (!(k in head)) head[k] = h[2];
  }
  return head.from ? head : null;
}

/**
 * Parse a .eml file into { from, to, date, subject, body }. For a forwarded email the original sender, date and subject
 * are what matter (it is the customer's remittance, not your forward), so those are used and the forwarder is kept
 * as forwardedBy.
 */
function parseEml(buffer) {
  const { headers, body } = splitHeaders(decodeText(buffer));
  const ctx = {};
  const out = {
    from: address(headers.from),
    to: address(headers.to),
    date: isoDate(headers.date),
    subject: decodeWords(headers.subject || '(no subject)'),
    body: bodyText(headers, body, 0, ctx).replace(/\r\n/g, '\n').trim()
  };
  const original = ctx.attached && ctx.attached.from ? ctx.attached : inlineForward(out.body);
  const sender = original && address(decodeWords(original.from));
  if (sender && sender !== out.from) {
    out.forwardedBy = out.from;
    out.from = sender;
    if (original.to) out.to = address(decodeWords(original.to));
    out.date = isoDate(original.date) || out.date;
    if (original.subject) out.subject = decodeWords(original.subject);
  }
  return out;
}

module.exports = { parseEml };
