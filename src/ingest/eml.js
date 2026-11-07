'use strict';

const { decodeText } = require('./files');

function decodeWords(s) {
  return String(s).replace(/=\?([\w-]+)\?([bq])\?([^?]*)\?=/gi, (_, _cs, enc, data) =>
    enc.toLowerCase() === 'b'
      ? Buffer.from(data, 'base64').toString('utf8')
      : Buffer.from(
          data.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16))),
          'latin1'
        ).toString('utf8')
  );
}

function decodeBody(body, encoding) {
  const e = String(encoding || '').toLowerCase();
  if (e === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (e === 'quoted-printable') {
    const bytes = body.replace(/=\r?\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(bytes, 'latin1').toString('utf8');
  }
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
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');

/** Pull readable text out of a (possibly multipart) message. Prefers text/plain, falls back to stripped HTML. */
function bodyText(headers, body) {
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
    const texts = parts.map((p) => ({ type: p.headers['content-type'] || 'text/plain', text: bodyText(p.headers, p.body) }));
    const plain = texts.find((t) => /text\/plain/i.test(t.type) && t.text.trim());
    return (plain || texts.find((t) => t.text.trim()) || { text: '' }).text;
  }
  const decoded = decodeBody(body, headers['content-transfer-encoding']);
  return /text\/html/i.test(type) ? stripHtml(decoded) : decoded;
}

/** Parse a .eml file into { from, to, date, subject, body }. */
function parseEml(buffer) {
  const { headers, body } = splitHeaders(decodeText(buffer));
  const date = headers.date ? new Date(headers.date) : null;
  return {
    from: (/<([^>]+)>/.exec(headers.from || '') || [null, headers.from || ''])[1].trim(),
    to: (/<([^>]+)>/.exec(headers.to || '') || [null, headers.to || ''])[1].trim(),
    date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    subject: decodeWords(headers.subject || '(no subject)'),
    body: bodyText(headers, body).replace(/\r\n/g, '\n').trim()
  };
}

module.exports = { parseEml };
