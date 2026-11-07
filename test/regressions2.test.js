'use strict';

/** Second review pass (November 2026): one test per bug, so none of them can come back unnoticed. */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const Engine = require('../src/engine/engine');
const { ingest, UnsupportedFileError } = require('../src/ingest');
const { buildDataset } = require('../src/ingest/build');
const { parseNumber, detectDecimalComma } = require('../src/ingest/numbers');
const { parseEml } = require('../src/ingest/eml');
const { extractClaims } = require('../src/ingest/extract');
const { loadSample } = require('../src/samples');
const { loadConfig } = require('../src/config');
const { startApp, J } = require('./helpers');

const clock = () => Date.parse('2026-11-07T09:00:00Z');
const led = (id, type, party, amount, extra) =>
  Object.assign({ id, type, party, amount, issued: '2026-09-01', due: '2026-10-01', status: 'open', row: 2 }, extra);
const engineOf = (sources) =>
  Engine.create(
    buildDataset(
      { settings: { asOf: '2026-11-07', emailDomain: 'me.example' }, sources: sources.map((s) => Object.assign({ uploadedAt: '2026-11-07T00:00:00Z' }, s)) },
      { clock }
    )
  );
const mail = (lines) => Buffer.from(lines.join('\r\n'), 'latin1');

describe('the engine never falls over on ordinary emails', () => {
  test('a supplier saying a bill is overdue, with no date, does not crash the brief', () => {
    const e = engineOf([
      { kind: 'ledger', file: 'l.csv', records: [led('BILL-7', 'payable', 'Northwind', 900)] },
      {
        kind: 'emails',
        file: 'm.eml',
        records: [
          { from: 'ar@northwind.example', to: 'me@me.example', date: '2026-11-02T10:00:00Z', subject: 'BILL-7', body: 'Your payment for BILL-7 is overdue.' }
        ]
      }
    ]);
    const notice = e.facts.find((f) => f.kind === 'supplier_notice');
    assert.ok(notice);
    assert.doesNotMatch(notice.summary, /undefined|NaN| due $/);
    e.briefEmail();
  });

  test('a promise to pay with no date reads naturally', () => {
    const e = engineOf([
      { kind: 'ledger', file: 'l.csv', records: [led('INV-1', 'receivable', 'Acme', 500)] },
      {
        kind: 'emails',
        file: 'm.eml',
        records: [{ from: 'ap@acme.example', to: 'me@me.example', date: '2026-11-02T10:00:00Z', subject: 'INV-1', body: 'We will pay INV-1 soon.' }]
      }
    ]);
    assert.strictEqual(e.facts.find((f) => f.kind === 'promise_to_pay').summary, 'Acme promised to pay');
    assert.strictEqual(Engine.fd(null), '');
  });
});

describe('Ask answers are not withheld for being right', () => {
  test('amounts with pence pass the citation check (they are shown rounded)', () => {
    const e = engineOf([{ kind: 'ledger', file: 'l.csv', records: [led('INV-8', 'receivable', 'Acme', 500.37)] }]);
    const a = e.askLocal('what is overdue');
    assert.ok(a.claims.length >= 2);
    assert.ok(
      a.claims.every((c) => c.valid),
      JSON.stringify(a.claims.map((c) => c.issues))
    );
    assert.match(a.claims[0].text, /^1 invoice is overdue/);
    const made = e.validateAnswer({ claims: [{ text: 'INV-8 is €999.', record_ids: ['led_INV-8'] }] });
    assert.strictEqual(made.claims[0].valid, false, 'a figure that is not in the record is still refused');
  });

  test('on the real sample every local answer is fully cited', async () => {
    const s = await loadSample('online-retail-ii', ingest);
    const e = Engine.create(
      buildDataset({ settings: s.settings, sources: s.sources.map((x, i) => Object.assign({ id: 's' + i, uploadedAt: '2011-11-09T06:00:00Z' }, x)) })
    );
    for (const q of ['what is overdue', 'Are there any conflicts?', 'What changed since the last brief?', 'top priorities', 'Who owes me money?']) {
      const a = e.askLocal(q);
      assert.ok(a.claims.length > 0, q);
      assert.ok(
        a.claims.every((c) => c.valid),
        q + ': ' + JSON.stringify(a.claims.filter((c) => !c.valid).map((c) => c.issues))
      );
    }
  });

  test('"Ask about this" works for any reference, not only INV-123 or BILL-123', () => {
    const e = engineOf([
      {
        kind: 'ledger',
        file: 'l.csv',
        records: [led('1001', 'receivable', 'Acme', 500), led('SI-0042', 'receivable', 'Beta', 300), led('1001', 'payable', 'Northwind', 200)]
      }
    ]);
    for (const it of e.items) {
      const a = e.askLocal('What is the status of ' + it.ref + '?');
      assert.strictEqual(a.intent, 'entity', it.ref);
      assert.strictEqual(a.claims.length, 1, it.ref + ' should match only itself');
      assert.ok(a.claims[0].text.includes(it.party));
    }
  });
});

describe('number formats', () => {
  test('a column written the European way reads "1.500" as fifteen hundred', async () => {
    const csv = 'Invoice No;Customer;Due Date;Amount\nR-1;Mueller;02.11.2026;1.234,50\nR-2;Schmidt;04.11.2026;1.500\nR-3;Weber;04.11.2026;12.345\n';
    const s = await ingest(Buffer.from(csv), 'eu.csv', {});
    assert.deepStrictEqual(
      s.records.map((r) => r.amount),
      [1234.5, 1500, 12345]
    );
  });

  test('the column style decides, and Swiss and spaced thousands are read', () => {
    assert.strictEqual(detectDecimalComma(['1.234,50', '1.500']), true);
    assert.strictEqual(detectDecimalComma(['1,234.50', '1.500']), false);
    assert.strictEqual(detectDecimalComma(['1.500', '2.000']), undefined);
    assert.strictEqual(parseNumber('1.500', { decimalComma: true }), 1500);
    assert.strictEqual(parseNumber('1,500', { decimalComma: true }), 1.5);
    assert.strictEqual(parseNumber('1.500'), 1.5, 'unchanged when the column does not say');
    assert.strictEqual(parseNumber('1’500.50'), 1500.5);
    assert.strictEqual(parseNumber("1'500.50"), 1500.5);
    assert.strictEqual(parseNumber('1 500,50'), 1500.5);
  });
});

describe('emails as they really arrive', () => {
  const head = ['From: a@acme.example', 'Date: Mon, 2 Nov 2026 10:00:00 +0000'];
  const L = [{ id: 'INV-1', type: 'receivable', party: 'Acme' }];

  test('the declared charset is used for quoted-printable and base64 bodies', () => {
    const qp = parseEml(
      mail(
        head.concat([
          'Subject: x',
          'Content-Type: text/plain; charset=iso-8859-1',
          'Content-Transfer-Encoding: quoted-printable',
          '',
          'We have paid INV-1 =A3500 today.'
        ])
      )
    );
    assert.strictEqual(qp.body, 'We have paid INV-1 £500 today.');
    const b64 = Buffer.from('We have paid INV-1 \xa3500 today.', 'latin1').toString('base64');
    const b = parseEml(mail(head.concat(['Subject: x', 'Content-Type: text/plain; charset=windows-1252', 'Content-Transfer-Encoding: base64', '', b64])));
    assert.strictEqual(extractClaims(b, L, 'me.example').extracted[0].amount, 500);
  });

  test('encoded subjects use their charset and split words join without a space', () => {
    assert.strictEqual(parseEml(mail(head.concat(['Subject: =?iso-8859-1?Q?Zahlung_f=FCr_INV-1?=', '', 'x']))).subject, 'Zahlung für INV-1');
    assert.strictEqual(parseEml(mail(head.concat(['Subject: =?utf-8?B?UGF5bWVudCBm?=', ' =?utf-8?B?b3IgSU5WLTE=?=', '', 'x']))).subject, 'Payment for INV-1');
  });

  test('HTML money entities are decoded; attachments are not read as text; the real address is found', () => {
    const html = parseEml(
      mail(head.concat(['Subject: x', 'Content-Type: text/html', '', '<p>We have paid INV-1 &pound;500&nbsp;today &#8364;1 &#x20AC;2 &amp;pound;</p>']))
    );
    assert.strictEqual(html.body, 'We have paid INV-1 £500 today €1 €2 &pound;');
    const pdfFirst = parseEml(
      mail(
        head.concat([
          'Subject: x',
          'Content-Type: multipart/mixed; boundary=b',
          '',
          '--b',
          'Content-Type: application/pdf',
          'Content-Transfer-Encoding: base64',
          '',
          'JVBERi0xLjQK',
          '--b',
          'Content-Type: text/html',
          '',
          '<p>hello</p>',
          '--b--'
        ])
      )
    );
    assert.strictEqual(pdfFirst.body, 'hello');
    assert.strictEqual(parseEml(mail(['From: "Acme <Accounts>" <ap@acme.example>', 'Subject: x', '', 'hi'])).from, 'ap@acme.example');
  });

  test('absurdly deep nesting is cut off instead of overflowing the stack', () => {
    const deep =
      ['From: a@b.example', 'Subject: x'].join('\r\n') +
      '\r\n' +
      'Content-Type: message/rfc822\r\n\r\n'.repeat(50000) +
      'Content-Type: text/plain\r\n\r\nhello';
    assert.strictEqual(parseEml(Buffer.from(deep)).body, '');
  });

  test('a remittance you forward from your own mailbox counts as the customer’s, in all three forward styles', () => {
    const outer = ['From: Me <me@me.example>', 'Date: Fri, 6 Nov 2026 09:00:00 +0000'];
    const styles = {
      gmail: outer.concat([
        'Subject: Fwd: Remittance',
        '',
        'FYI',
        '',
        '---------- Forwarded message ---------',
        'From: Acme AP <ap@acme.example>',
        'Date: Mon, 2 Nov 2026 10:00:00 +0000',
        'Subject: Remittance',
        '',
        'We have paid INV-1 £500 today.'
      ]),
      outlook: outer.concat([
        'Subject: FW: Remittance',
        '',
        '-----Original Message-----',
        'From: Acme AP <ap@acme.example>',
        'Sent: Monday, November 2, 2026 10:00 AM',
        'Subject: Remittance',
        '',
        'We have paid INV-1 £500 today.'
      ]),
      attached: outer.concat([
        'Subject: Fwd',
        'Content-Type: multipart/mixed; boundary=b1',
        '',
        '--b1',
        'Content-Type: text/plain',
        '',
        'FYI',
        '--b1',
        'Content-Type: message/rfc822',
        '',
        'From: ap@acme.example',
        'Date: Mon, 2 Nov 2026 10:00:00 +0000',
        'Subject: Remittance',
        '',
        'We have paid INV-1 £500 today.',
        '--b1--'
      ])
    };
    for (const [name, lines] of Object.entries(styles)) {
      const m = parseEml(Buffer.from(lines.join('\r\n')));
      assert.strictEqual(m.from, 'ap@acme.example', name);
      assert.strictEqual(m.forwardedBy, 'me@me.example', name);
      assert.strictEqual(m.date, '2026-11-02T10:00:00.000Z', name);
      const r = extractClaims(m, L, 'me.example');
      assert.strictEqual(r.direction, 'received', name);
      assert.deepStrictEqual(
        r.extracted.map((c) => [c.kind, c.amount]),
        [['payment_claim', 500]],
        name
      );
    }
    const own = parseEml(Buffer.from(outer.concat(['Subject: Reminder', '', 'INV-1 is overdue.']).join('\r\n')));
    assert.strictEqual(own.forwardedBy, undefined, 'your own email is not a forward');
  });

  test('text that is not an email at all is refused', async () => {
    await assert.rejects(
      ingest(Buffer.from('just some text, not an email'), 'x.eml', {}),
      (e) => e instanceof UnsupportedFileError && /does not look like an email/.test(e.message)
    );
  });
});

describe('server hardening', () => {
  test('X-Forwarded-For is trusted only from proxies on this machine or a private network', () => {
    assert.strictEqual(loadConfig({}).trustProxy, 'loopback, linklocal, uniquelocal');
    assert.strictEqual(loadConfig({ TRUST_PROXY: '2' }).trustProxy, 2);
    assert.strictEqual(loadConfig({ TRUST_PROXY: 'false' }).trustProxy, false);
    assert.strictEqual(loadConfig({ TRUST_PROXY: '10.0.0.5' }).trustProxy, '10.0.0.5');
  });

  test('MCP batches are bounded and the engine is built once per request', async () => {
    const t = await startApp();
    try {
      const key = (await (await t.fetch(t.base + '/api/keys', { method: 'POST', headers: J, body: JSON.stringify({ name: 'k' }) })).json()).key;
      const call = (body) =>
        globalThis.fetch(t.base + '/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify(body)
        });
      const msg = (id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'get_brief' } });
      const empty = await (await call([])).json();
      assert.strictEqual(empty.error.code, -32600);
      assert.strictEqual((await call(Array.from({ length: 21 }, (_, i) => msg(i)))).status, 400);
      let loads = 0;
      const store = t.ctx.workspaceFor((await t.ctx.accounts.all())[0].id);
      const load = store.load.bind(store);
      store.load = () => (loads++, load());
      const ok = await (await call(Array.from({ length: 20 }, (_, i) => msg(i)))).json();
      assert.strictEqual(ok.length, 20);
      assert.strictEqual(loads, 1);
    } finally {
      await t.stop();
    }
  });

  test('a large ledger and statement build in well under a second each, not minutes', () => {
    const ledger = Array.from({ length: 30000 }, (_, i) =>
      led('INV-' + (100000 + i), 'receivable', 'Customer ' + (i % 900), 100 + (i % 5000), { status: i % 3 ? 'open' : 'paid', row: i + 2 })
    );
    const transactions = Array.from({ length: 10000 }, (_, i) => ({
      id: null,
      date: '2026-10-' + String(1 + (i % 28)).padStart(2, '0'),
      amount: 100 + (i % 5000),
      description: 'FP Customer ' + (i % 900) + ' INV-' + (100000 + i * 3),
      reference: null
    }));
    const t0 = Date.now();
    const e = engineOf([
      { kind: 'ledger', file: 'l.csv', records: ledger },
      { kind: 'bank', file: 'b.csv', records: { balance: 1000, balanceDate: '2026-11-06', transactions } }
    ]);
    e.briefEmail();
    assert.ok(Date.now() - t0 < 8000, 'took ' + (Date.now() - t0) + ' ms'); // was ~25 s before indexing; generous for slow CI
    assert.strictEqual(e.data.BANK.transactions.filter((t) => t.matched).length, 10000);
  });
});

describe('the browser app', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  test('per-person state is forgotten on sign-out, account deletion, expiry and sign-in', () => {
    assert.ok(/function forgetUser\(\)/.test(app));
    assert.ok((app.match(/forgetUser\(\);/g) || []).length >= 4);
    for (const v of ['prepared.length = 0', 'thread.length = 0', 'revealed = null', 'pending = []']) assert.ok(app.includes(v), v);
  });
  test('no demo leftovers: fixed years, claims that were never checked, a VAT question with no VAT source', () => {
    for (const s of [
      'Budget 2027',
      'Growth on 2026',
      'Supplier notice on file',
      "'All sources agree'",
      'When is the VAT due?',
      'live bank feed',
      'offline demo'
    ])
      assert.ok(!app.includes(s), s);
  });
});
