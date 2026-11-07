'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const { test, describe, before, after } = require('node:test');
const Engine = require('../src/engine/engine');
const { buildDataset } = require('../src/ingest/build');
const { plan } = require('../src/integrations/plan');
const mcp = require('../src/integrations/mcp');
const { webhookProblem, autoChoice } = require('../src/app');
const { startApp, fixture, J } = require('./helpers');
const { fakeGoogle } = require('./fakeGoogle');

const GOOGLE = { googleClientId: 'cid.apps.googleusercontent.com', googleClientSecret: 'secret', publicUrl: 'https://trueline.example' };

async function connectGoogle(t, code = 'ok') {
  const start = await t.fetch(t.base + '/api/google/start', { redirect: 'manual' });
  const loc = new URL(start.headers.get('location'));
  const state = loc.searchParams.get('state');
  const r = await t.fetch(t.base + '/api/google/callback?code=' + code + '&state=' + encodeURIComponent(state), { redirect: 'manual' });
  return { auth: loc, back: r.headers.get('location') };
}
const harbour = () => {
  const d = require('../samples/harbour/data.js');
  return Engine.create(JSON.parse(JSON.stringify(d.TRUELINE_DATA || d)));
};

describe('sync plan', () => {
  test('bills become calendar dates with reminders, today’s actions become tasks, the brief becomes a doc', () => {
    const e = harbour();
    const p = plan(e);
    assert.ok(p.events.length > 0);
    const pay = p.events.find((x) => /^Pay /.test(x.body.summary));
    assert.ok(pay, 'a bill is on the calendar');
    assert.strictEqual(pay.body.reminders.useDefault, false);
    assert.ok(pay.body.reminders.overrides.some((o) => o.method === 'email'));
    assert.ok(pay.body.end.date > pay.body.start.date);
    assert.ok(p.events.every((x) => x.key && x.hash));
    assert.ok(p.tasks.length > 0 && p.tasks.length <= 15);
    assert.ok(p.tasks.every((x) => x.body.due.startsWith(p.today)));
    assert.match(p.doc.text, /UPCOMING DATES/);
    assert.strictEqual(plan(e).doc.hash, p.doc.hash, 'deterministic');
  });
  test('an empty business plans nothing to do', () => {
    const e = Engine.create(buildDataset({ settings: { company: 'X' }, sources: [] }, { clock: () => Date.parse('2026-11-09T06:30:00Z') }));
    const p = plan(e);
    assert.strictEqual(p.events.length, 0);
    assert.match(p.doc.text, /Nothing due/);
  });
});

describe('MCP handler', () => {
  const e = harbour();
  const call = (msg, eng = e) => mcp.handle(msg, async () => eng);
  test('initialize, list and ping', async () => {
    const i = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    assert.strictEqual(i.result.protocolVersion, '2025-03-26');
    assert.strictEqual((await call({ jsonrpc: '2.0', id: 1, method: 'initialize' })).result.protocolVersion, '2025-06-18');
    assert.deepStrictEqual((await call({ jsonrpc: '2.0', id: 2, method: 'ping' })).result, {});
    assert.strictEqual((await call({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).result.tools.length, mcp.TOOLS.length);
    assert.strictEqual(await call({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  });
  test('every tool answers, with citations, and errors are JSON-RPC errors', async () => {
    const tool = async (name, args, eng) =>
      (await call({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, eng)).result.content[0].text;
    assert.match(await tool('get_brief'), /DO TODAY/);
    assert.strictEqual((await tool('list_priorities', { limit: 2 })).split('\n').filter((l) => /^\d\./.test(l)).length, 2);
    assert.match(await tool('ask', { question: 'what is overdue?' }), /\[[a-z]+_/);
    assert.match(await tool('ask', { question: 'what is the weather' }), /can’t verify|Nothing/);
    assert.match(await tool('cash_outlook'), /low \/ base \/ high/);
    assert.match(await tool('get_brief', {}, null), /No files/);
    const noFc = Object.assign({}, e, { forecast: null });
    assert.match(await tool('cash_outlook', {}, noFc), /needs a bank/);
    assert.strictEqual((await call({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope' } })).error.code, -32602);
    assert.strictEqual((await call({ jsonrpc: '2.0', id: 9, method: 'resources/list' })).error.code, -32601);
    assert.strictEqual((await call({ id: 9 })).error.code, -32600);
    assert.strictEqual((await call(null)).error.id, undefined);
  });
});

describe('guards', () => {
  test('webhook addresses must be public https', () => {
    assert.strictEqual(webhookProblem('https://hooks.zapier.com/abc'), null);
    assert.match(webhookProblem('http://example.com'), /https/);
    assert.match(webhookProblem('nonsense'), /full web address/);
    assert.match(webhookProblem('https://user:pw@example.com'), /credentials/);
    assert.match(webhookProblem('https://localhost/x'), /not reachable/);
    assert.match(webhookProblem('https://db.internal/x'), /not reachable/);
    assert.match(webhookProblem('https://10.0.0.5/x'), /Private/);
    assert.match(webhookProblem('https://192.168.1.1/x'), /Private/);
    assert.match(webhookProblem('https://[::1]/x'), /Private/);
    assert.strictEqual(webhookProblem('https://8.8.8.8/x'), null);
  });
  test('only confident readings are taken without a person', () => {
    assert.deepStrictEqual(autoChoice({ kind: 'emails', tables: [] }), {});
    assert.strictEqual(autoChoice({ kind: null, tables: [] }), null);
    const t = (p) => ({ tables: [{ proposals: [p] }] });
    assert.strictEqual(autoChoice(t({ kind: 'ledger', missing: ['amount'], confidence: 1 })), null);
    assert.strictEqual(autoChoice(t({ kind: 'ledger', missing: [], confidence: 0.5 })), null);
    assert.deepStrictEqual(autoChoice(t({ kind: 'pnl', missing: [], confidence: 0.9, layout: 'wide', mapping: { a: 1 } })), {
      kind: 'pnl',
      table: 0,
      mapping: { a: 1 },
      options: { layout: 'wide' }
    });
    assert.strictEqual(autoChoice({ tables: [{ proposals: [] }] }), null);
  });
});

describe('Google sync end to end (fake Google)', () => {
  let t, g;
  before(async () => {
    g = fakeGoogle();
    t = await startApp({ cfg: GOOGLE, http: g.http, debounceMs: 60000 });
    await t.fetch(t.base + '/api/sample/online-retail-ii', { method: 'POST', headers: J });
  });
  after(() => t.stop());
  const syncNow = async () => (await t.fetch(t.base + '/api/google/sync', { method: 'POST', headers: J })).json();

  test('sync before connecting is refused', async () => {
    const r = await t.fetch(t.base + '/api/google/sync', { method: 'POST', headers: J });
    assert.strictEqual(r.status, 400);
  });
  test('consent asks only for least-privilege scopes, offline, and a state tied to this user', async () => {
    const { auth, back } = await connectGoogle(t);
    assert.strictEqual(auth.host, 'accounts.google.com');
    assert.strictEqual(auth.searchParams.get('access_type'), 'offline');
    assert.strictEqual(auth.searchParams.get('redirect_uri'), 'https://trueline.example/api/google/callback');
    const scopes = auth.searchParams.get('scope').split(' ');
    assert.ok(scopes.includes('https://www.googleapis.com/auth/calendar.app.created'));
    assert.ok(scopes.includes('https://www.googleapis.com/auth/drive.file'));
    assert.ok(!scopes.some((s) => /gmail|auth\/calendar$|auth\/drive$/.test(s)), 'no broad scopes');
    assert.strictEqual(back, '/?google=connected#account');
    const acct = await (await t.fetch(t.base + '/api/account')).json();
    assert.strictEqual(acct.google.connected, true);
    assert.strictEqual(acct.google.account, 'owner@gmail.example');
    const raw = await t.rawAccounts();
    assert.ok(!raw.includes('"rt"') && !raw.includes('refreshToken'), 'refresh token is encrypted at rest');
  });
  test('first sync fills calendar, tasks and doc; a second sync changes nothing', async () => {
    const r = await syncNow();
    assert.ok(r.result.google.events > 0, JSON.stringify(r.result));
    assert.ok(r.result.google.tasks > 0);
    const cal = Object.values(g.calendars)[0];
    assert.strictEqual(Object.keys(cal).length, r.result.google.events);
    assert.match(Object.values(g.docs)[0], /Trueline brief for Online Retail/);
    assert.match(r.account.google.docUrl, /^https:\/\/docs\.google\.com\/document\/d\//);
    assert.ok(r.account.google.calendarUrl);
    const before = g.calls.length;
    const again = await syncNow();
    assert.deepStrictEqual(again.result.google.changes, [
      { created: 0, updated: 0, closed: 0 },
      { created: 0, updated: 0, closed: 0 }
    ]);
    assert.strictEqual(g.calls.length - before, 1, 'only the token refresh');
  });
  test('things the user deleted in Google are put back; things no longer due are removed or ticked off', async () => {
    const cal = Object.values(g.calendars)[0];
    const [first] = Object.keys(cal);
    delete cal[first];
    await t.fetch(t.base + '/api/settings', { method: 'PUT', headers: J, body: JSON.stringify({ company: 'Renamed Ltd' }) });
    const r = await syncNow();
    assert.ok(r.result.google.changes[0].updated > 0);
    assert.ok(r.result.google.changes[0].created >= 1, 'deleted event recreated');
    assert.match(Object.values(g.docs)[0], /Renamed Ltd/);
    await t.fetch(t.base + '/api/settings', { method: 'PUT', headers: J, body: JSON.stringify({ asOf: '2012-06-01' }) });
    const later = await syncNow();
    assert.ok(later.result.google.changes[0].closed > 0);
    assert.ok(
      Object.values(Object.values(g.lists)[0]).some((x) => x.status === 'completed'),
      'tasks ticked off, not deleted'
    );
    await t.fetch(t.base + '/api/settings', { method: 'PUT', headers: J, body: JSON.stringify({ asOf: '2011-11-09' }) });
  });
  test('a whole deleted calendar, list or doc is recreated', async () => {
    g.calendars = {};
    g.lists = {};
    g.docs = {};
    await t.fetch(t.base + '/api/settings', { method: 'PUT', headers: J, body: JSON.stringify({ company: 'Again Ltd' }) });
    const r = await syncNow();
    assert.ok(!r.result.google.error, JSON.stringify(r.result));
    assert.strictEqual(Object.keys(g.calendars).length, 1);
    assert.strictEqual(Object.keys(g.lists).length, 1);
    assert.match(Object.values(g.docs)[0], /Again Ltd/);
  });
  test('a server error is recorded, not thrown; a revoked token asks to reconnect', async () => {
    g.fail = (m, u) => u.pathname === '/token';
    let r = await syncNow();
    assert.match(r.result.google.error, /Google returned 500/);
    assert.strictEqual(r.account.google.needsReconnect, false);
    g.fail = (m, u) => /calendar/.test(u.pathname);
    await t.fetch(t.base + '/api/settings', { method: 'PUT', headers: J, body: JSON.stringify({ company: 'Fails Ltd' }) });
    r = await syncNow();
    assert.strictEqual(r.account.google.lastError, 'boom');
    g.fail = null;
    g.refreshError = 'Token has been expired or revoked.';
    r = await syncNow();
    assert.strictEqual(r.account.google.needsReconnect, true);
    assert.match(r.account.google.lastError, /Connect again/);
    g.refreshError = null;
  });
  test('uploading a file syncs on its own, with no click', async () => {
    const quick = fakeGoogle();
    const t2 = await startApp({ cfg: GOOGLE, http: quick.http, debounceMs: 5 });
    await connectGoogle(t2);
    await t2.ctx.sync.idle();
    const f = new FormData();
    f.append('file', new Blob([fixture('ledger_uk.csv')]), 'ledger_uk.csv');
    f.append('choice', '{}');
    await t2.fetch(t2.base + '/api/upload/commit', { method: 'POST', headers: { 'X-Requested-With': 'trueline' }, body: f });
    for (let i = 0; i < 100 && !Object.keys(quick.docs).length; i++) await new Promise((r) => setTimeout(r, 20));
    await t2.ctx.sync.idle();
    assert.strictEqual(Object.keys(quick.docs).length, 1, 'doc written by the automatic sync');
    const before = quick.calls.length;
    await t2.ctx.sync.runAll();
    assert.ok(quick.calls.length > before, 'the timer path syncs connected users too');
    await t2.stop();
  });
  test('callback edge cases go back to the account page with a reason', async () => {
    const go = async (qs, cookie = true) =>
      (await (cookie ? t.fetch : globalThis.fetch)(t.base + '/api/google/callback?' + qs, { redirect: 'manual' })).headers.get('location');
    assert.match(await go('code=x&state=forged'), /expired/);
    assert.match(await go('code=x&state=x', false), /expired/);
    const state = () =>
      t
        .fetch(t.base + '/api/google/start', { redirect: 'manual' })
        .then((r) => encodeURIComponent(new URL(r.headers.get('location')).searchParams.get('state')));
    assert.match(await go('error=access_denied&state=' + (await state())), /denied/);
    assert.match(await go('code=norefresh&state=' + (await state())), /norefresh/);
    assert.match(await go('code=bad&state=' + (await state())), /failed/);
  });
  test('disconnect revokes and forgets the token', async () => {
    const r = await (await t.fetch(t.base + '/api/google', { method: 'DELETE', headers: J })).json();
    assert.strictEqual(r.google.connected, false);
    assert.ok(g.calls.some((c) => c.endsWith('/revoke')));
    assert.strictEqual((await (await t.fetch(t.base + '/api/google', { method: 'DELETE', headers: J })).json()).google.connected, false);
  });
  test('without a Google client the connect button explains', async () => {
    const t3 = await startApp();
    const r = await t3.fetch(t3.base + '/api/google/start', { redirect: 'manual' });
    assert.match(r.headers.get('location'), /unconfigured/);
    assert.strictEqual((await (await t3.fetch(t3.base + '/api/account')).json()).google.configured, false);
    await t3.stop();
  });
});

describe('inbound, webhooks, keys and MCP over HTTP', () => {
  let t, g;
  before(async () => {
    g = fakeGoogle();
    t = await startApp({ http: g.http, debounceMs: 60000 });
  });
  after(() => t.stop());

  test('an inbound link reads forwarded emails and files with no clicks', async () => {
    const acct = await (await t.fetch(t.base + '/api/inbound', { method: 'POST', headers: J })).json();
    assert.match(acct.inboundUrl, /\/inbound\/in_/);
    const url = acct.inboundUrl;
    const raw = await globalThis.fetch(url, { method: 'POST', headers: { 'Content-Type': 'message/rfc822' }, body: fixture('remittance.eml') });
    assert.strictEqual(raw.status, 201);
    await globalThis.fetch(url, { method: 'POST', headers: { 'Content-Type': 'message/rfc822' }, body: fixture('remittance.eml') });
    const f = new FormData();
    f.append('a', new Blob([fixture('ledger_uk.csv')]), 'ledger_uk.csv');
    f.append('b', new Blob([Buffer.from('just,some\n1,2\n')]), 'odd.csv');
    f.append('c', new Blob([Buffer.from('%PDF')]), 'x.pdf');
    const multi = await (await globalThis.fetch(url, { method: 'POST', body: f })).json();
    assert.deepStrictEqual(
      multi.added.map((s) => s.kind),
      ['ledger']
    );
    assert.strictEqual(multi.skipped.length, 2);
    const ws = await (await t.fetch(t.base + '/api/workspace')).json();
    const box = ws.sources.find((s) => s.file === 'Forwarded inbox');
    assert.strictEqual(box.stats.rows, 1, 'duplicate email dropped');
    assert.strictEqual((await globalThis.fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '' })).status, 400);
    assert.strictEqual((await globalThis.fetch(t.base + '/inbound/in_nope', { method: 'POST', body: new FormData() })).status, 404);
    const bad = new FormData();
    bad.append('c', new Blob([Buffer.from('%PDF')]), 'x.pdf');
    assert.strictEqual((await globalThis.fetch(url, { method: 'POST', body: bad })).status, 422);
    const rotated = await (await t.fetch(t.base + '/api/inbound', { method: 'POST', headers: J })).json();
    assert.notStrictEqual(rotated.inboundUrl, url);
    assert.strictEqual(
      (await globalThis.fetch(url, { method: 'POST', headers: { 'Content-Type': 'message/rfc822' }, body: fixture('remittance.eml') })).status,
      404,
      'old link dead'
    );
    const off = await (await t.fetch(t.base + '/api/inbound', { method: 'DELETE', headers: J })).json();
    assert.strictEqual(off.inboundUrl, null);
  });
  test('the forwarded inbox respects the source limit', async () => {
    const t2 = await startApp({ cfg: { maxSources: 0 } });
    const url = (await (await t2.fetch(t2.base + '/api/inbound', { method: 'POST', headers: J })).json()).inboundUrl;
    const r = await globalThis.fetch(url, { method: 'POST', headers: { 'Content-Type': 'message/rfc822' }, body: fixture('remittance.eml') });
    assert.strictEqual(r.status, 422);
    assert.match((await r.json()).skipped[0].reason, /Source limit/);
    await t2.stop();
  });
  test('webhooks are validated, signed, tested and removable', async () => {
    const add = (url, name) => t.fetch(t.base + '/api/webhooks', { method: 'POST', headers: J, body: JSON.stringify({ url, name }) });
    assert.strictEqual((await add('http://insecure.example/x')).status, 400);
    const r = await (await add('https://hooks.example.com/abc')).json();
    assert.match(r.signingSecret, /^whsec_/);
    const hook = r.account.webhooks[0];
    assert.strictEqual(hook.name, 'hooks.example.com');
    assert.ok(!('sealed' in hook), 'the address stays encrypted on the server');
    const test1 = await (await t.fetch(t.base + '/api/webhooks/' + hook.id + '/test', { method: 'POST', headers: J })).json();
    assert.strictEqual(test1.status, '200');
    const sent = g.hooks[g.hooks.length - 1];
    const expected = 'sha256=' + crypto.createHmac('sha256', r.signingSecret).update(sent.body).digest('hex');
    assert.strictEqual(sent.headers['X-Trueline-Signature'], expected);
    await t.ctx.sync.runNow(t.ctx.accounts && (await t.ctx.accounts.all())[0].id);
    assert.strictEqual(JSON.parse(g.hooks[g.hooks.length - 1].body).event, 'brief.updated');
    g.fail = (m, u) => u.host === 'hooks.example.com';
    const failed = await t.ctx.sync.runNow((await t.ctx.accounts.all())[0].id);
    assert.strictEqual(Object.values(failed.webhooks)[0], '500');
    g.fail = () => {
      throw new Error('network down');
    };
    assert.match((await (await t.fetch(t.base + '/api/webhooks/' + hook.id + '/test', { method: 'POST', headers: J })).json()).status, /failed: network down/);
    assert.match(Object.values((await t.ctx.sync.runNow((await t.ctx.accounts.all())[0].id)).webhooks)[0], /failed/);
    g.fail = null;
    for (let i = 0; i < 4; i++) await add('https://hooks.example.com/' + i);
    assert.strictEqual((await add('https://hooks.example.com/6')).status, 400);
    assert.strictEqual((await t.fetch(t.base + '/api/webhooks/nope/test', { method: 'POST', headers: J })).status, 404);
    assert.strictEqual((await t.fetch(t.base + '/api/webhooks/nope', { method: 'DELETE', headers: J })).status, 404);
    const after = await (await t.fetch(t.base + '/api/webhooks/' + hook.id, { method: 'DELETE', headers: J })).json();
    assert.strictEqual(after.webhooks.length, 4);
  });
  test('API keys: shown once, stored hashed, work for MCP and the brief API, revocable', async () => {
    const created = await (await t.fetch(t.base + '/api/keys', { method: 'POST', headers: J, body: JSON.stringify({ name: 'Claude' }) })).json();
    const key = created.key;
    assert.match(key, /^tl_/);
    assert.ok(!JSON.stringify(created.account).includes(key));
    const raw = await t.rawAccounts();
    assert.ok(!raw.includes(key));
    const auth = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
    const rpc = (body) => globalThis.fetch(t.base + '/mcp', { method: 'POST', headers: auth, body: JSON.stringify(body) });
    const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).json();
    assert.strictEqual(init.result.serverInfo.name, 'trueline');
    assert.strictEqual((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const batch = await (
      await rpc([
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', method: 'x' }
      ])
    ).json();
    assert.strictEqual(batch.length, 1);
    assert.strictEqual((await rpc([{ jsonrpc: '2.0', method: 'x' }])).status, 202);
    const brief = await (await globalThis.fetch(t.base + '/api/v1/brief', { headers: auth })).json();
    assert.ok(brief.subject);
    assert.strictEqual((await globalThis.fetch(t.base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.strictEqual((await globalThis.fetch(t.base + '/mcp')).status, 405);
    const listed = (await (await t.fetch(t.base + '/api/account')).json()).apiKeys[0];
    assert.ok(listed.lastUsedAt, 'last use recorded');
    for (let i = 0; i < 9; i++) await t.fetch(t.base + '/api/keys', { method: 'POST', headers: J, body: '{}' });
    assert.strictEqual((await t.fetch(t.base + '/api/keys', { method: 'POST', headers: J, body: '{}' })).status, 400);
    assert.strictEqual((await t.fetch(t.base + '/api/keys/nope', { method: 'DELETE', headers: J })).status, 404);
    await t.fetch(t.base + '/api/keys/' + listed.id, { method: 'DELETE', headers: J });
    assert.strictEqual((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401, 'revoked');
  });
  test('the brief API with no files says so', async () => {
    const t2 = await startApp();
    const key = (await (await t2.fetch(t2.base + '/api/keys', { method: 'POST', headers: J, body: '{}' })).json()).key;
    const j = await (await globalThis.fetch(t2.base + '/api/v1/brief', { headers: { Authorization: 'Bearer ' + key } })).json();
    assert.strictEqual(j.brief, null);
    await t2.stop();
  });
  test('sync does nothing for an account with nothing connected or no files', async () => {
    const t2 = await startApp();
    const uid = (await t2.ctx.accounts.all())[0].id;
    assert.deepStrictEqual(await t2.ctx.sync.run(uid), { skipped: 'nothing connected' });
    assert.deepStrictEqual(await t2.ctx.sync.run('u_missing'), { skipped: 'no user' });
    await t2.fetch(t2.base + '/api/webhooks', { method: 'POST', headers: J, body: JSON.stringify({ url: 'https://hooks.example.com/z' }) });
    assert.deepStrictEqual(await t2.ctx.sync.run(uid), { skipped: 'no files' });
    await t2.stop();
  });
});
