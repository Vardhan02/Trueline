'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const net = require('node:net');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { inspect, ingest, UnsupportedFileError } = require('./ingest');
const { buildDataset } = require('./ingest/build');
const { loadSample, listSamples } = require('./samples');
const Engine = require('./engine/engine');
const mcp = require('./integrations/mcp');
const sec = require('./security');

const PUBLIC = path.join(__dirname, '..', 'public');
const ENGINE = path.join(__dirname, 'engine', 'engine.js');
/** Rejects "2026-02-30": Date.parse alone would roll it over to March. */
const isRealDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

const SETTING_KEYS = {
  company: (v) => String(v).trim().slice(0, 80) || undefined,
  currency: (v) => (['EUR', 'GBP', 'USD'].includes(v) ? v : undefined),
  asOf: (v) => (v === null || v === '' ? null : isRealDate(v) ? v : undefined),
  costOfSalesPct: (v) => (Number(v) >= 0 && Number(v) <= 1 ? Number(v) : undefined),
  overheadsMonthly: (v) => (Number(v) >= 0 && Number(v) < 1e9 ? Number(v) : undefined),
  staleDays: (v) => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 60 ? Number(v) : undefined),
  termsDays: (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 180 ? Number(v) : undefined),
  emailDomain: (v) => (/^[a-z0-9.-]{0,80}$/i.test(String(v).replace(/^@/, '')) ? String(v).replace(/^@/, '').toLowerCase() : undefined)
};
const MAX_KEYS = 10;
const MAX_HOOKS = 5;

const summary = (s) => ({ id: s.id, kind: s.kind, file: s.file, uploadedAt: s.uploadedAt, stats: s.stats, notes: s.notes, issues: s.issues, range: s.range });

/** Wrap async handlers so a rejected promise reaches the error handler instead of hanging the request. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

class InputError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Webhooks must be public https addresses: no localhost, no private networks (basic SSRF guard). */
function webhookProblem(raw) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch {
    return 'Enter a full web address starting with https://';
  }
  if (u.protocol !== 'https:') return 'Use an https:// address.';
  if (u.username || u.password) return 'Put credentials in the service, not the address.';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /\.(local|internal|localhost)$/.test(host)) return 'That address is not reachable from the internet.';
  if (net.isIP(host)) {
    const priv =
      /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host) || /^(::1?|f[cd]|fe80)/.test(host);
    if (priv) return 'Private network addresses are not allowed.';
  }
  return null;
}

/** Pick the confident reading of a file, or null when a person should check the columns first. */
function autoChoice(info) {
  if (!info.tables.length) return info.kind ? {} : null;
  const idx = info.table || 0;
  const p = info.tables[idx].proposals[0];
  if (!p || !p.kind || p.missing.length || p.confidence < 0.7) return null;
  return { kind: p.kind, table: idx, mapping: p.mapping || {}, options: Object.assign({}, p.layout ? { layout: p.layout } : {}, p.options) };
}

function createApp({ cfg, accounts, workspaceFor, auth, vault, google, sync, logger, clock = Date.now }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  const now = () => new Date(clock()).toISOString().replace(/\.\d+Z$/, 'Z');
  const baseUrl = (req) => cfg.publicUrl || req.protocol + '://' + req.get('host');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          formAction: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"]
        }
      },
      hsts: cfg.production
    })
  );
  app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    const start = process.hrtime.bigint();
    res.on('finish', () =>
      logger.info(
        { id: req.id, method: req.method, url: req.originalUrl.split('?')[0], status: res.statusCode, ms: Number(process.hrtime.bigint() - start) / 1e6 },
        'request'
      )
    );
    next();
  });

  // Health checks: unauthenticated, no data.
  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  app.get(
    '/readyz',
    wrap(async (req, res) => {
      await accounts.ping();
      res.json({ status: 'ready' });
    })
  );

  app.use(express.json({ limit: '100kb' }));

  const limiter = (windowMs, limit, error) => rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, message: { error } });
  const loginLimit = limiter(15 * 60e3, cfg.authAttempts, 'Too many attempts. Try again in a few minutes.');
  const uploadLimit = limiter(60e3, 30, 'Too many uploads. Wait a minute.');
  const machineLimit = limiter(60e3, 60, 'Too many requests. Slow down.');
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: cfg.maxUploadMb * 1024 * 1024, files: 1 } });
  const uploadMany = multer({ storage: multer.memoryStorage(), limits: { fileSize: cfg.maxUploadMb * 1024 * 1024, files: 10 } });

  async function engineFor(uid) {
    const ws = await workspaceFor(uid).load();
    return ws.sources.length ? Engine.create(buildDataset(ws, { clock })) : null;
  }
  /** Forwarded emails pile into one rolling "Forwarded inbox" source (newest 500, duplicates dropped) instead of one source each. */
  const INBOX = 'Forwarded inbox';
  async function addInboundEmail(uid, source) {
    const stored = await workspaceFor(uid).update((ws) => {
      let box = ws.sources.find((s) => s.kind === 'emails' && s.file === INBOX);
      if (!box) {
        if (ws.sources.length >= cfg.maxSources) throw new UnsupportedFileError('Source limit reached (' + cfg.maxSources + '). Remove one first.');
        box = { id: 's_' + crypto.randomBytes(4).toString('hex'), kind: 'emails', file: INBOX, records: [], issues: [], notes: [], stats: {} };
        ws.sources.push(box);
      }
      const key = (r) => [r.from, r.date, r.subject].join('|');
      const seen = new Set(box.records.map(key));
      box.records = box.records
        .concat(source.records.filter((r) => !seen.has(key(r))))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
        .slice(-500);
      const dates = box.records.map((r) => String(r.date).slice(0, 10));
      Object.assign(box, {
        uploadedAt: now(),
        stats: { rows: box.records.length, accepted: box.records.length, skipped: 0 },
        range: { from: dates[0], to: dates[dates.length - 1] }
      });
      return ws;
    });
    sync.schedule(uid);
    return stored.sources.find((s) => s.file === INBOX);
  }

  async function addSource(uid, source) {
    const stored = await workspaceFor(uid).update((ws) => {
      if (ws.sources.length >= cfg.maxSources) throw new UnsupportedFileError('Source limit reached (' + cfg.maxSources + '). Remove one first.');
      const replaced = ws.sources.filter((s) => s.kind === source.kind && s.file === source.file);
      ws.sources = ws.sources.filter((s) => !replaced.includes(s)); // re-uploading a file replaces it
      ws.sources.push(Object.assign({ id: 's_' + crypto.randomBytes(4).toString('hex'), uploadedAt: now() }, source));
      return ws;
    });
    sync.schedule(uid);
    return stored.sources[stored.sources.length - 1];
  }

  /** Before accounts, a deployment had one shared workspace. The first account to sign up takes it over. */
  async function adoptLegacy(uid) {
    const legacy = path.join(cfg.dataDir, 'workspace.json');
    try {
      await fs.access(legacy);
    } catch {
      return;
    }
    await workspaceFor(uid).init();
    await fs.rename(legacy, path.join(workspaceFor(uid).dir, 'workspace.json'));
    logger.info({ uid }, 'moved the pre-accounts workspace into the first account');
  }

  /* ---- machine endpoints: bearer API key or secret link, no cookies, no CSRF header ---- */
  async function bearerUser(req) {
    const m = /^Bearer\s+(tl_[A-Za-z0-9_-]{20,})$/.exec(req.get('Authorization') || '');
    if (!m) return null;
    const h = sec.sha256(m[1]);
    const user = (await accounts.all()).find((u) => (u.apiKeys || []).some((k) => k.hash === h));
    if (!user) return null;
    const key = user.apiKeys.find((k) => k.hash === h);
    if (!key.lastUsedAt || clock() - Date.parse(key.lastUsedAt) > 3600e3) {
      await accounts.updateUser(user.id, (u) => (u.apiKeys || []).filter((k) => k.hash === h).forEach((k) => (k.lastUsedAt = now())));
    }
    return user;
  }
  const needKey = (fn) =>
    wrap(async (req, res) => {
      const user = await bearerUser(req);
      if (!user) return res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'A valid Trueline API key is required.' });
      return fn(req, res, user);
    });

  app.get(
    '/api/v1/brief',
    machineLimit,
    needKey(async (req, res, user) => {
      const eng = await engineFor(user.id);
      if (!eng) return res.json({ brief: null, note: 'No files connected yet.' });
      const m = eng.briefEmail();
      res.json({ asOf: eng.data.NOW, subject: m.subject, doToday: m.rows, cash: m.cash, text: m.body, coverage: eng.coverage() });
    })
  );
  app.post(
    '/mcp',
    machineLimit,
    needKey(async (req, res, user) => {
      const body = req.body;
      const getEngine = () => engineFor(user.id);
      if (Array.isArray(body)) {
        const out = (await Promise.all(body.map((m) => mcp.handle(m, getEngine)))).filter(Boolean);
        return out.length ? res.json(out) : res.status(202).end();
      }
      const out = await mcp.handle(body, getEngine);
      return out ? res.json(out) : res.status(202).end();
    })
  );
  app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST (MCP streamable HTTP, JSON responses).' }));

  // Inbound: forward bills, remittances and statements here (from an email-to-webhook service, Zapier, Make…).
  app.post(
    '/inbound/:token',
    machineLimit,
    (req, res, next) =>
      /^message\/rfc822|^text\/plain/.test(req.get('Content-Type') || '')
        ? express.raw({ type: () => true, limit: cfg.maxUploadMb * 1024 * 1024 })(req, res, next)
        : next(),
    uploadMany.any(),
    wrap(async (req, res) => {
      const h = sec.sha256(req.params.token);
      const user = (await accounts.all()).find((u) => u.inbound && u.inbound.hash === h);
      if (!user) return res.status(404).json({ error: 'Unknown inbound link.' });
      const files = (req.files || []).map((f) => ({ name: f.originalname, buffer: f.buffer }));
      if (Buffer.isBuffer(req.body) && req.body.length) files.push({ name: 'inbound-' + now().replace(/[:]/g, '') + '.eml', buffer: req.body });
      if (!files.length) return res.status(400).json({ error: 'Send at least one file, or a raw email as message/rfc822.' });
      const added = [],
        skipped = [];
      for (const f of files) {
        try {
          const choice = autoChoice(await inspect(f.buffer, f.name));
          if (!choice) {
            skipped.push({ file: f.name, reason: 'Columns need checking. Upload it in the app once and later copies will be read the same way.' });
            continue;
          }
          const source = await ingest(f.buffer, f.name, choice);
          added.push(summary(await (source.kind === 'emails' ? addInboundEmail(user.id, source) : addSource(user.id, source))));
        } catch (e) {
          if (!(e instanceof UnsupportedFileError)) throw e;
          skipped.push({ file: f.name, reason: e.message });
        }
      }
      res.status(added.length ? 201 : 422).json({ added, skipped });
    })
  );

  /* ---- browser API: session cookie + CSRF header ---- */
  const api = express.Router();
  // CSRF: browsers cannot add a custom header cross-site without a CORS preflight, which we never allow.
  api.use((req, res, next) =>
    req.method !== 'GET' && req.get('X-Requested-With') !== 'trueline' ? res.status(403).json({ error: 'Missing X-Requested-With header.' }) : next()
  );

  api.get(
    '/session',
    wrap(async (req, res) => {
      const u = await auth.userOf(req);
      res.json({ authed: Boolean(u), user: u ? { email: u.email } : null, signup: { open: cfg.allowSignup, codeRequired: Boolean(cfg.signupCode) } });
    })
  );
  api.post(
    '/signup',
    loginLimit,
    wrap(async (req, res) => {
      const b = req.body || {};
      if (!cfg.allowSignup) throw new InputError(403, 'New accounts are closed on this server. Ask the administrator.');
      if (cfg.signupCode && !(typeof b.code === 'string' && sec.sha256(b.code) === sec.sha256(cfg.signupCode)))
        throw new InputError(403, 'That invite code is not right.');
      const email = sec.normalEmail(b.email);
      if (!sec.validEmail(email)) throw new InputError(400, 'Enter a valid email address.');
      const problem = sec.passwordProblem(b.password, email);
      if (problem) throw new InputError(400, problem);
      const pw = await sec.hashPassword(b.password);
      let isFirst = false;
      const user = await accounts.change((users) => {
        if (users.some((u) => u.email === email)) throw new InputError(409, 'An account with that email already exists. Sign in instead.');
        const u = {
          id: 'u_' + crypto.randomBytes(9).toString('hex'),
          email,
          pw,
          sv: 0,
          createdAt: now(),
          apiKeys: [],
          webhooks: [],
          google: null,
          inbound: null
        };
        isFirst = users.length === 0;
        users.push(u);
        return u;
      });
      if (isFirst) await adoptLegacy(user.id);
      auth.login(res, user);
      res.status(201).json({ ok: true, user: { email } });
    })
  );
  api.post(
    '/login',
    loginLimit,
    wrap(async (req, res) => {
      const b = req.body || {};
      const user = await accounts.byEmail(sec.normalEmail(b.email));
      // An unknown email still costs one hash check, so response time does not reveal who has an account.
      const ok = await sec.verifyPassword(String(b.password || ''), user ? user.pw : await sec.decoyHash());
      if (!ok || !user) throw new InputError(401, 'Wrong email or password.');
      auth.login(res, user);
      res.json({ ok: true, user: { email: user.email } });
    })
  );
  api.post('/logout', (req, res) => {
    auth.logout(res);
    res.json({ ok: true });
  });

  // Google sends the browser back here after consent. A navigation, so redirects instead of JSON.
  api.get(
    '/google/callback',
    wrap(async (req, res) => {
      const back = (status) => res.redirect(303, '/?google=' + status + '#account');
      const user = await auth.userOf(req);
      const uid = auth.checkState(req.query.state);
      if (!user || !uid || uid !== user.id) return back('expired');
      if (req.query.error || !req.query.code) return back('denied');
      try {
        const tok = await google.exchange(String(req.query.code));
        if (!tok.refresh_token) return back('norefresh');
        const info = await google.userinfo(tok.access_token).catch(() => ({}));
        await accounts.updateUser(user.id, (u) => {
          u.google = {
            sealed: vault.seal({ refreshToken: tok.refresh_token }),
            account: info.email || null,
            connectedAt: now(),
            state: null,
            lastSync: null,
            lastError: null,
            scope: tok.scope || ''
          };
        });
      } catch (e) {
        logger.warn({ err: e.message }, 'google connect failed');
        return back('failed');
      }
      sync.schedule(user.id);
      return back('connected');
    })
  );

  api.use(auth.require);
  const wsOf = (req) => workspaceFor(req.user.id);

  api.get(
    '/workspace',
    wrap(async (req, res) => {
      const ws = await wsOf(req).load();
      res.json({ settings: ws.settings, sources: ws.sources.map(summary), samples: listSamples(), limits: { maxUploadMb: cfg.maxUploadMb } });
    })
  );

  api.get(
    '/dataset',
    wrap(async (req, res) => {
      const ws = await wsOf(req).load();
      res.setHeader('Cache-Control', 'no-store');
      res.json({ dataset: buildDataset(ws, { clock }), sourceCount: ws.sources.length });
    })
  );

  api.put(
    '/settings',
    wrap(async (req, res) => {
      const patch = {};
      Object.entries(req.body || {}).forEach(([k, v]) => {
        if (!SETTING_KEYS[k]) return;
        const clean = SETTING_KEYS[k](v);
        if (clean !== undefined) patch[k] = clean;
      });
      const ws = await wsOf(req).update((w) => Object.assign(w, { settings: Object.assign(w.settings, patch) }));
      sync.schedule(req.user.id);
      res.json({ settings: ws.settings });
    })
  );

  api.post(
    '/upload/inspect',
    uploadLimit,
    upload.single('file'),
    wrap(async (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'Choose a file to upload.' });
      res.json(await inspect(req.file.buffer, req.file.originalname));
    })
  );

  api.post(
    '/upload/commit',
    uploadLimit,
    upload.single('file'),
    wrap(async (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'Choose a file to upload.' });
      let choice;
      try {
        choice = req.body.choice ? JSON.parse(req.body.choice) : {};
      } catch {
        return res.status(400).json({ error: 'Invalid choice.' });
      }
      const source = await ingest(req.file.buffer, req.file.originalname, choice);
      res.status(201).json({ source: summary(await addSource(req.user.id, source)) });
    })
  );

  api.delete(
    '/sources/:id',
    wrap(async (req, res) => {
      let found = false;
      await wsOf(req).update((ws) => {
        const n = ws.sources.length;
        ws.sources = ws.sources.filter((s) => s.id !== req.params.id);
        found = ws.sources.length < n;
        return ws;
      });
      if (found) sync.schedule(req.user.id);
      res.status(found ? 200 : 404).json(found ? { ok: true } : { error: 'No such source.' });
    })
  );

  api.post(
    '/sample/:name',
    wrap(async (req, res) => {
      const sample = await loadSample(req.params.name, ingest);
      if (!sample) return res.status(404).json({ error: 'No such sample.' });
      const stamp = now();
      await wsOf(req).update(() => ({
        settings: sample.settings,
        sources: sample.sources.map((s, i) => Object.assign({ id: 's_sample' + i, uploadedAt: stamp }, s))
      }));
      sync.schedule(req.user.id);
      res.status(201).json({ ok: true, sources: sample.sources.length });
    })
  );

  api.delete(
    '/workspace',
    wrap(async (req, res) => {
      await wsOf(req).update((ws) => ({ settings: ws.settings, sources: [] }));
      res.json({ ok: true });
    })
  );

  /* ---- account ---- */
  const accountView = (u, req) => ({
    email: u.email,
    createdAt: u.createdAt,
    google: {
      configured: google.configured,
      connected: Boolean(u.google && u.google.sealed),
      account: u.google ? u.google.account : null,
      lastSync: u.google ? u.google.lastSync : null,
      lastError: u.google ? u.google.lastError : null,
      needsReconnect: Boolean(u.google && u.google.needsReconnect),
      counts: (u.google && u.google.counts) || null,
      docUrl: u.google && u.google.state && u.google.state.docId ? 'https://docs.google.com/document/d/' + u.google.state.docId + '/edit' : null,
      calendarUrl:
        u.google && u.google.state && u.google.state.calendarId
          ? 'https://calendar.google.com/calendar/r?cid=' + encodeURIComponent(u.google.state.calendarId)
          : null
    },
    webhooks: (u.webhooks || []).map((h) => ({
      id: h.id,
      name: h.name,
      host: h.host,
      createdAt: h.createdAt,
      lastStatus: h.lastStatus || null,
      lastAt: h.lastAt || null
    })),
    apiKeys: (u.apiKeys || []).map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt || null })),
    inboundUrl: u.inbound ? baseUrl(req) + '/inbound/' + vault.open(u.inbound.sealed) : null,
    mcpUrl: baseUrl(req) + '/mcp',
    briefApiUrl: baseUrl(req) + '/api/v1/brief'
  });
  const reload = async (req) => accountView(await accounts.get(req.user.id), req);

  api.get(
    '/account',
    wrap(async (req, res) => res.json(await reload(req)))
  );
  api.put(
    '/account/password',
    loginLimit,
    wrap(async (req, res) => {
      const b = req.body || {};
      if (!(await sec.verifyPassword(String(b.current || ''), req.user.pw))) throw new InputError(401, 'Your current password is not right.');
      const problem = sec.passwordProblem(b.next, req.user.email);
      if (problem) throw new InputError(400, problem);
      const pw = await sec.hashPassword(b.next);
      const u = await accounts.updateUser(req.user.id, (x) => {
        x.pw = pw;
        x.sv = (x.sv || 0) + 1; // signs out every other device
      });
      auth.login(res, u);
      res.json({ ok: true });
    })
  );
  api.delete(
    '/account',
    loginLimit,
    wrap(async (req, res) => {
      if (!(await sec.verifyPassword(String((req.body || {}).password || ''), req.user.pw))) throw new InputError(401, 'Your password is not right.');
      if (req.user.google && req.user.google.sealed) await google.revoke(vault.open(req.user.google.sealed).refreshToken);
      await accounts.change((users) =>
        users.splice(
          users.findIndex((u) => u.id === req.user.id),
          1
        )
      );
      await fs.rm(workspaceFor(req.user.id).dir, { recursive: true, force: true });
      auth.logout(res);
      res.json({ ok: true });
    })
  );

  /* ---- connections ---- */
  api.get('/google/start', (req, res) => {
    if (!google.configured) return res.redirect(303, '/?google=unconfigured#account');
    res.redirect(303, google.authUrl(auth.stateFor(req.user.id)));
  });
  api.post(
    '/google/sync',
    wrap(async (req, res) => {
      if (!req.user.google || !req.user.google.sealed) throw new InputError(400, 'Connect Google first.');
      const result = await sync.runNow(req.user.id);
      res.json({ result, account: await reload(req) });
    })
  );
  api.delete(
    '/google',
    wrap(async (req, res) => {
      if (req.user.google && req.user.google.sealed) await google.revoke(vault.open(req.user.google.sealed).refreshToken);
      await accounts.updateUser(req.user.id, (u) => (u.google = null));
      res.json(await reload(req));
    })
  );

  api.post(
    '/webhooks',
    wrap(async (req, res) => {
      const b = req.body || {};
      const problem = webhookProblem(b.url);
      if (problem) throw new InputError(400, problem);
      if ((req.user.webhooks || []).length >= MAX_HOOKS) throw new InputError(400, 'Up to ' + MAX_HOOKS + ' webhooks. Remove one first.');
      const secret = sec.randomToken('whsec_');
      const hook = {
        id: 'h_' + crypto.randomBytes(6).toString('hex'),
        name:
          String(b.name || '')
            .trim()
            .slice(0, 60) || new URL(b.url).hostname,
        host: new URL(b.url).hostname,
        sealed: vault.seal({ url: String(b.url), secret }),
        createdAt: now()
      };
      await accounts.updateUser(req.user.id, (u) => (u.webhooks = (u.webhooks || []).concat(hook)));
      sync.schedule(req.user.id);
      res.status(201).json({ signingSecret: secret, account: await reload(req) });
    })
  );
  api.post(
    '/webhooks/:id/test',
    wrap(async (req, res) => {
      const hook = (req.user.webhooks || []).find((h) => h.id === req.params.id);
      if (!hook) throw new InputError(404, 'No such webhook.');
      let status;
      try {
        status = String(await sync.testWebhook(req.user, hook));
      } catch (e) {
        status = 'failed: ' + e.message;
      }
      await accounts.updateUser(req.user.id, (u) =>
        (u.webhooks || []).filter((h) => h.id === hook.id).forEach((h) => Object.assign(h, { lastStatus: status, lastAt: now() }))
      );
      res.json({ status, account: await reload(req) });
    })
  );
  api.delete(
    '/webhooks/:id',
    wrap(async (req, res) => {
      if (!(req.user.webhooks || []).some((h) => h.id === req.params.id)) throw new InputError(404, 'No such webhook.');
      await accounts.updateUser(req.user.id, (u) => (u.webhooks = u.webhooks.filter((h) => h.id !== req.params.id)));
      res.json(await reload(req));
    })
  );

  api.post(
    '/keys',
    wrap(async (req, res) => {
      if ((req.user.apiKeys || []).length >= MAX_KEYS) throw new InputError(400, 'Up to ' + MAX_KEYS + ' keys. Revoke one first.');
      const key = sec.randomToken('tl_', 30);
      const rec = {
        id: 'k_' + crypto.randomBytes(6).toString('hex'),
        name:
          String((req.body || {}).name || '')
            .trim()
            .slice(0, 60) || 'API key',
        prefix: key.slice(0, 9),
        hash: sec.sha256(key),
        createdAt: now()
      };
      await accounts.updateUser(req.user.id, (u) => (u.apiKeys = (u.apiKeys || []).concat(rec)));
      res.status(201).json({ key, account: await reload(req) });
    })
  );
  api.delete(
    '/keys/:id',
    wrap(async (req, res) => {
      if (!(req.user.apiKeys || []).some((k) => k.id === req.params.id)) throw new InputError(404, 'No such key.');
      await accounts.updateUser(req.user.id, (u) => (u.apiKeys = u.apiKeys.filter((k) => k.id !== req.params.id)));
      res.json(await reload(req));
    })
  );

  api.post(
    '/inbound',
    wrap(async (req, res) => {
      const token = sec.randomToken('in_', 24);
      await accounts.updateUser(req.user.id, (u) => (u.inbound = { hash: sec.sha256(token), sealed: vault.seal(token), createdAt: now() }));
      res.status(201).json(await reload(req));
    })
  );
  api.delete(
    '/inbound',
    wrap(async (req, res) => {
      await accounts.updateUser(req.user.id, (u) => (u.inbound = null));
      res.json(await reload(req));
    })
  );

  api.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use('/api', api);

  app.get('/engine.js', (req, res) => res.type('js').sendFile(ENGINE));
  app.use(express.static(PUBLIC, { maxAge: cfg.production ? '1h' : 0, index: 'index.html' }));

  // Errors: user mistakes are 4xx with a message they can act on; anything else is a logged 500 with no internals leaked.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof InputError) return res.status(err.status).json({ error: err.message });
    if (err instanceof UnsupportedFileError) return res.status(422).json({ error: err.message });
    if (err instanceof multer.MulterError)
      return res
        .status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
        .json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than ' + cfg.maxUploadMb + ' MB.' : err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Too large.' });
    logger.error({ err, id: req.id }, 'unhandled error');
    res.status(500).json({ error: 'Something went wrong on our side.', requestId: req.id });
  });
  return app;
}

module.exports = { createApp, webhookProblem, autoChoice };
