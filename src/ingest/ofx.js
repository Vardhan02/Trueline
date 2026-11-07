'use strict';

const { decodeText } = require('./files');
const { parseDate } = require('./dates');
const { parseNumber } = require('./numbers');

/** Value of the first <TAG> in a block. Works for both OFX 1.x (SGML, no closing tags) and OFX 2.x (XML). */
function tag(block, name) {
  const m = new RegExp('<' + name + '>([^<\\r\\n]*)', 'i').exec(block);
  return m ? m[1].trim() : null;
}

/** Parse an OFX/QFX bank statement into transactions and the closing balance. */
function parseOfx(buffer) {
  const text = decodeText(buffer);
  const transactions = [];
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  for (const raw of blocks) {
    const block = raw.split(/<\/STMTTRN>/i)[0];
    const amount = parseNumber(tag(block, 'TRNAMT'));
    const date = parseDate(tag(block, 'DTPOSTED'));
    if (amount == null || !date) continue;
    transactions.push({
      id: tag(block, 'FITID'),
      date,
      amount,
      description: [tag(block, 'NAME'), tag(block, 'MEMO')].filter(Boolean).join(' · '),
      reference: tag(block, 'CHECKNUM') || tag(block, 'REFNUM') || null
    });
  }
  const bal = /<LEDGERBAL>([\s\S]*?)(?:<\/LEDGERBAL>|<AVAILBAL>|$)/i.exec(text);
  return {
    transactions,
    balance: bal ? parseNumber(tag(bal[1], 'BALAMT')) : null,
    balanceDate: bal ? parseDate(tag(bal[1], 'DTASOF')) : null,
    currency: tag(text, 'CURDEF')
  };
}

module.exports = { parseOfx };
