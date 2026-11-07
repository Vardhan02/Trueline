'use strict';

/**
 * Trueline as an MCP server (streamable HTTP, JSON responses). An AI assistant connected with a
 * personal API key can read the brief and ask cited questions; it cannot change anything.
 */
const pkg = require('../../package.json');

const TOOLS = [
  {
    name: 'get_brief',
    description: 'Today’s morning brief: what needs action, cash in the bank and at risk.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_priorities',
    description: 'Ranked list of invoices, bills and tax items with trust labels and the source behind each.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } } }
  },
  {
    name: 'ask',
    description: 'Ask a question about the finances. Every answer cites record ids; unsupported statements are withheld.',
    inputSchema: { type: 'object', properties: { question: { type: 'string', maxLength: 500 } }, required: ['question'] }
  },
  { name: 'cash_outlook', description: 'Three-month cash outlook with low, base and high cases.', inputSchema: { type: 'object', properties: {} } }
];

const text = (t) => ({ content: [{ type: 'text', text: t }] });

function callTool(engine, name, args) {
  if (!engine) return text('No files are connected to this Trueline account yet.');
  const { eur, fd } = engine; // this account's currency and year
  if (name === 'get_brief') return text(engine.briefEmail().body);
  if (name === 'list_priorities') {
    const n = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 50);
    return text(
      engine.ranked
        .slice(0, n)
        .map(
          (i, k) =>
            k +
            1 +
            '. ' +
            i.title +
            ' · ' +
            eur(i.amount) +
            ' · ' +
            (i.when || '') +
            ' · trust: ' +
            i.trust +
            ' · sources: ' +
            i.factIds.join(', ') +
            '\n   → ' +
            i.action
        )
        .join('\n') || 'Nothing ranked.'
    );
  }
  if (name === 'ask') {
    const a = engine.askLocal(String(args.question || '').slice(0, 500));
    const lines = a.claims.filter((c) => c.valid).map((c) => '- ' + c.text + ' [' + c.record_ids.join(', ') + ']');
    return text(
      (lines.length ? lines.join('\n') : 'I can’t verify that from the records.') +
        (a.notes && a.notes.length ? '\n\n' + a.notes.join('\n') : '') +
        '\n\n' +
        a.coverage
    );
  }
  if (name === 'cash_outlook') {
    const f = engine.forecast;
    if (!f) return text('The outlook needs a bank statement and monthly profit and loss.');
    return text(
      'Opening ' +
        eur(f.opening) +
        ' (as of ' +
        fd(engine.data.NOW) +
        '). Confidence: ' +
        f.confidence +
        '.\n' +
        f.months
          .map((m) => m.label + ': closing ' + eur(m.closing.low) + ' / ' + eur(m.closing.base) + ' / ' + eur(m.closing.high) + ' (low / base / high)')
          .join('\n')
    );
  }
  return null;
}

/** Handle one JSON-RPC message. Returns the response object, or null for notifications. */
async function handle(msg, getEngine) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg && msg.id !== undefined ? msg.id : null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request');
  if (msg.id === undefined) return null; // notification, e.g. notifications/initialized
  const params = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'trueline', version: pkg.version },
        instructions: 'Read-only finance brief. Cite the record ids Trueline returns; do not state figures it did not return.'
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const out = callTool(await getEngine(), params.name, params.arguments || {});
      return out ? reply(out) : fail(-32602, 'Unknown tool: ' + params.name);
    }
    default:
      return fail(-32601, 'Method not found: ' + msg.method);
  }
}

module.exports = { handle, TOOLS };
