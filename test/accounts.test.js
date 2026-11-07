'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test, describe, before, after } = require('node:test');
const sec = require('../src/security');
const { startApp, PASSWORD, J } = require('./helpers');

describe('security primitives', () => {
  test('passwords are salted scrypt hashes and verify only the right password', async () => {
    const small = { N: 1024, r: 8, p: 1, keylen: 32 };
    const a = await sec.hashPassword('correct horse battery', small);
    const b = await sec.hashPassword('correct horse battery', small);
    assert.match(a, /^scrypt\$1024\$8\$1\$/);
    assert.notStrictEqual(a, b, 'random salt');
    assert.ok(!a.includes('correct'));
    assert.ok(await sec.verifyPassword('correct horse battery', a));
    assert.ok(!(await sec.verifyPassword('correct horse batterz', a)));
    assert.ok(!(await sec.verifyPassword('x', 'md5$abc')));
    assert.ok(!(await sec.verifyPassword('x', null)));
    assert.strictEqual(await sec.decoyHash(), await sec.decoyHash(), 'decoy is made once');
  });
  test('the vault encrypts, authenticates and refuses other keys or tampering', () => {
    const v = sec.createVault('k'.repeat(40));
    const sealed = v.seal({ refreshToken: 'secret-token' });
    assert.ok(!sealed.includes('secret'));
    assert.notStrictEqual(sealed, v.seal({ refreshToken: 'secret-token' }), 'random IV');
    assert.deepStrictEqual(v.open(sealed), { refreshToken: 'secret-token' });
    assert.throws(() => sec.createVault('other-key-'.repeat(4)).open(sealed));
    const parts = sealed.split('.');
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('A') ? 'BB' : 'AA');
    assert.throws(() => v.open(parts.join('.')));
    assert.throws(() => v.open('v2.x.y.z'), /Unreadable/);
    assert.throws(() => sec.createVault(''), /encryption key/);
  });
  test('email and password rules', () => {
    assert.ok(sec.validEmail(' Owner@Example.COM '));
    assert.ok(!sec.validEmail('owner@'));
    assert.ok(!sec.validEmail('a b@c.ie'));
    assert.strictEqual(sec.passwordProblem('short'), 'Use at least 10 characters.');
    assert.match(sec.passwordProblem('x'.repeat(201)), /at most/);
    assert.match(sec.passwordProblem('aaaaaaaaaaaa'), /easy/);
    assert.match(sec.passwordProblem('password123'), /easy/);
    assert.match(sec.passwordProblem('me@example.com', 'ME@example.com'), /email/);
    assert.strictEqual(sec.passwordProblem('a long sentence works'), null);
    assert.match(sec.randomToken('tl_'), /^tl_[A-Za-z0-9_-]{32}$/);
  });
});

describe('accounts over HTTP', () => {
  let t;
  before(async () => {
    t = await startApp({ signup: false });
  });
  after(() => t.stop());
  const post = (p, body, extra = {}) => globalThis.fetch(t.base + p, { method: 'POST', headers: Object.assign({}, J, extra), body: JSON.stringify(body) });

  test('without a session the API is closed and the session says so', async () => {
    assert.strictEqual((await globalThis.fetch(t.base + '/api/dataset')).status, 401);
    const s = await (await globalThis.fetch(t.base + '/api/session')).json();
    assert.deepStrictEqual(s, { authed: false, user: null, signup: { open: true, codeRequired: false } });
  });
  test('sign-up validates, stores only a hash, and opens a secure session', async () => {
    assert.strictEqual((await post('/api/signup', { email: 'nope', password: PASSWORD })).status, 400);
    assert.strictEqual((await post('/api/signup', { email: 'a@b.ie', password: 'short' })).status, 400);
    const r = await post('/api/signup', { email: 'Owner@Example.com', password: PASSWORD });
    assert.strictEqual(r.status, 201);
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    const raw = fs.readFileSync(path.join(t.dir, 'accounts.json'), 'utf8');
    assert.ok(!raw.includes(PASSWORD), 'password never stored');
    assert.match(raw, /owner@example\.com/);
    assert.match(raw, /scrypt\$/);
    // Windows has no owner/group/other permission bits; there it reports 666 whatever mode was asked for.
    if (process.platform !== 'win32') assert.strictEqual((fs.statSync(path.join(t.dir, 'accounts.json')).mode & 0o777).toString(8), '600');
    const dup = await post('/api/signup', { email: 'owner@example.com', password: PASSWORD });
    assert.strictEqual(dup.status, 409);
    const s = await (await globalThis.fetch(t.base + '/api/session', { headers: { cookie: cookie.split(';')[0] } })).json();
    assert.deepStrictEqual(s.user, { email: 'owner@example.com' });
  });
  test('login: wrong password and unknown email give the same answer', async () => {
    const a = await post('/api/login', { email: 'owner@example.com', password: 'wrong password!' });
    const b = await post('/api/login', { email: 'nobody@example.com', password: 'wrong password!' });
    assert.strictEqual(a.status, 401);
    assert.deepStrictEqual(await a.json(), await b.json());
    assert.strictEqual(b.status, 401);
    const ok = await post('/api/login', { email: ' OWNER@example.com', password: PASSWORD });
    assert.strictEqual(ok.status, 200);
    t.cookie = ok.headers.get('set-cookie').split(';')[0];
  });
  test('two accounts never see each other’s files', async () => {
    await t.fetch(t.base + '/api/sample/online-retail-ii', { method: 'POST', headers: J });
    const other = await post('/api/signup', { email: 'second@example.com', password: PASSWORD });
    const c2 = other.headers.get('set-cookie').split(';')[0];
    const w2 = await (await globalThis.fetch(t.base + '/api/workspace', { headers: { cookie: c2 } })).json();
    assert.strictEqual(w2.sources.length, 0);
    const w1 = await (await t.fetch(t.base + '/api/workspace')).json();
    assert.ok(w1.sources.length > 0);
  });
  test('changing the password signs out other sessions but keeps this one', async () => {
    const other = (await post('/api/login', { email: 'owner@example.com', password: PASSWORD })).headers.get('set-cookie').split(';')[0];
    const bad = await t.fetch(t.base + '/api/account/password', {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({ current: 'nope', next: 'new long password' })
    });
    assert.strictEqual(bad.status, 401);
    const weak = await t.fetch(t.base + '/api/account/password', { method: 'PUT', headers: J, body: JSON.stringify({ current: PASSWORD, next: 'short' }) });
    assert.strictEqual(weak.status, 400);
    const r = await t.fetch(t.base + '/api/account/password', {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({ current: PASSWORD, next: 'new long password' })
    });
    assert.strictEqual(r.status, 200);
    t.cookie = r.headers.get('set-cookie').split(';')[0];
    assert.strictEqual((await globalThis.fetch(t.base + '/api/dataset', { headers: { cookie: other } })).status, 401, 'old device signed out');
    assert.strictEqual((await t.fetch(t.base + '/api/dataset')).status, 200);
    assert.strictEqual((await post('/api/login', { email: 'owner@example.com', password: PASSWORD })).status, 401);
  });
  test('deleting the account needs the password and removes everything', async () => {
    const acct = await (await t.fetch(t.base + '/api/account')).json();
    assert.strictEqual(acct.email, 'owner@example.com');
    const del = (password) => t.fetch(t.base + '/api/account', { method: 'DELETE', headers: J, body: JSON.stringify({ password }) });
    assert.strictEqual((await del('wrong')).status, 401);
    const users = JSON.parse(fs.readFileSync(path.join(t.dir, 'accounts.json'), 'utf8')).users;
    const uid = users.find((u) => u.email === 'owner@example.com').id;
    assert.ok(fs.existsSync(path.join(t.dir, 'users', uid)));
    assert.strictEqual((await del('new long password')).status, 200);
    assert.ok(!fs.existsSync(path.join(t.dir, 'users', uid)));
    assert.strictEqual((await t.fetch(t.base + '/api/dataset')).status, 401);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(t.dir, 'accounts.json'), 'utf8')).users.length, 1);
  });
});

describe('sign-up controls', () => {
  test('closed sign-up and invite codes', async () => {
    const closed = await startApp({ signup: false, cfg: { allowSignup: false } });
    const r = await globalThis.fetch(closed.base + '/api/signup', {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ email: 'a@b.ie', password: PASSWORD })
    });
    assert.strictEqual(r.status, 403);
    await closed.stop();
    const coded = await startApp({ signup: false, cfg: { signupCode: 'harbour-2026' } });
    const s = await (await globalThis.fetch(coded.base + '/api/session')).json();
    assert.strictEqual(s.signup.codeRequired, true);
    const up = (code) =>
      globalThis.fetch(coded.base + '/api/signup', { method: 'POST', headers: J, body: JSON.stringify({ email: 'a@b.ie', password: PASSWORD, code }) });
    assert.strictEqual((await up('wrong')).status, 403);
    assert.strictEqual((await up(undefined)).status, 403);
    assert.strictEqual((await up('harbour-2026')).status, 201);
    await coded.stop();
  });
  test('the first account adopts a workspace left from before accounts existed', async () => {
    const t = await startApp({ signup: false });
    fs.writeFileSync(path.join(t.dir, 'workspace.json'), JSON.stringify({ settings: { company: 'Legacy Ltd' }, sources: [] }));
    await t.signup();
    const w = await (await t.fetch(t.base + '/api/workspace')).json();
    assert.strictEqual(w.settings.company, 'Legacy Ltd');
    assert.ok(!fs.existsSync(path.join(t.dir, 'workspace.json')));
    await t.signup('second@example.com');
    assert.strictEqual((await (await t.fetch(t.base + '/api/workspace')).json()).settings.company, 'Your company');
    await t.stop();
  });
  test('a development encryption key is created once and reused', async () => {
    const t = await startApp({ signup: false });
    const key = fs.readFileSync(path.join(t.dir, '.dev-encryption-key'), 'utf8');
    const { createContext } = require('../src/context');
    await createContext(t.cfg, { logger: require('pino')({ level: 'silent' }) });
    assert.strictEqual(fs.readFileSync(path.join(t.dir, '.dev-encryption-key'), 'utf8'), key);
    assert.throws(() => t.ctx.workspaceFor('../etc'), /Bad user id/);
    await t.stop();
  });
});
