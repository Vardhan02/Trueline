'use strict';

/**
 * Keeps each user's connected services in step with their files, with no clicks:
 * runs a few seconds after any upload, inbound email or deletion, and on a timer for everyone.
 * Idempotent: it remembers what it created (by key and content hash) and only creates, changes or
 * closes what differs, so running it twice does nothing the second time.
 */
const crypto = require('node:crypto');
const Engine = require('../engine/engine');
const { buildDataset } = require('../ingest/build');
const { plan, emptyPlan } = require('./plan');
const { GoogleError } = require('./google');

const gone = (e) => e instanceof GoogleError && (e.status === 404 || e.status === 410);
const short = (e) => String((e && e.message) || e).slice(0, 200);

function createSync({
  accounts,
  workspaceFor,
  vault,
  google,
  logger,
  clock = Date.now,
  http = globalThis.fetch,
  debounceMs = 1500,
  timeZone = 'Europe/Dublin',
  lock = null, // a lock shared by every instance (Postgres); without one, syncs are kept in order in this process only
  afterResponse = null // serverless: run work after the response is sent (Vercel's waitUntil) instead of on a timer
}) {
  const timers = new Map();
  const chains = new Map();
  const stamp = () => new Date(clock()).toISOString().replace(/\.\d+Z$/, 'Z');

  async function load(uid) {
    const ws = await workspaceFor(uid).load();
    return { ws, eng: ws.sources.length ? Engine.create(buildDataset(ws, { clock })) : null };
  }

  /**
   * Make `map` (key -> {id, hash}) match `want` ([{key, hash, body}]). `map` is updated in place after every call that
   * succeeds, so if Google fails halfway, what was already created is still remembered and not created twice next time.
   */
  async function reconcile(map, want, ops) {
    const counts = { created: 0, updated: 0, closed: 0 };
    const wanted = new Set(want.map((w) => w.key));
    for (const w of want) {
      const prev = map[w.key];
      if (prev && prev.hash === w.hash) continue;
      let id;
      if (prev) {
        try {
          await ops.patch(prev.id, w.body);
          id = prev.id;
          counts.updated++;
        } catch (e) {
          if (!gone(e)) throw e; // deleted by the user in Google: put it back
        }
      }
      if (!id) {
        id = (await ops.insert(w.body)).id;
        counts.created++;
      }
      map[w.key] = { id, hash: w.hash };
    }
    for (const key of Object.keys(map)) {
      if (wanted.has(key)) continue;
      try {
        await ops.close(map[key].id);
      } catch (e) {
        if (!gone(e)) throw e;
      }
      delete map[key];
      counts.closed++;
    }
    return { map, counts };
  }

  /** Sync Google. On failure the error carries `state`: whatever was created before it failed, so it is saved, not lost. */
  async function syncGoogle(g, p) {
    const st = JSON.parse(JSON.stringify(Object.assign({ events: {}, tasks: {} }, g.state)));
    try {
      return await syncGoogleInto(st, g, p);
    } catch (e) {
      e.state = st;
      throw e;
    }
  }

  async function syncGoogleInto(st, g, p) {
    const secret = vault.open(g.sealed);
    const t = (await google.refresh(secret.refreshToken)).access_token;

    const withContainer = async (field, items, create, fn) => {
      if (!st[field]) st[field] = (await create()).id;
      try {
        return await fn(st[field]);
      } catch (e) {
        if (!gone(e)) throw e; // the whole calendar or list was deleted: make a new one once
        st[field] = (await create()).id;
        st[items] = {}; // what lived in the old one went with it
        return fn(st[field]);
      }
    };
    const cal = await withContainer(
      'calendarId',
      'events',
      () => google.calendar.create(t, 'Trueline', timeZone),
      (id) =>
        reconcile(st.events, p.events, {
          insert: (b) => google.calendar.insert(t, id, b),
          patch: (eid, b) => google.calendar.patch(t, id, eid, b),
          close: (eid) => google.calendar.remove(t, id, eid)
        })
    );
    const tasks = await withContainer(
      'taskListId',
      'tasks',
      () => google.tasks.createList(t, 'Trueline'),
      (id) =>
        reconcile(st.tasks, p.tasks, {
          insert: (b) => google.tasks.insert(t, id, b),
          patch: (tid, b) => google.tasks.patch(t, id, tid, b),
          close: (tid) => google.tasks.patch(t, id, tid, { status: 'completed' }) // done or no longer needed: tick it off
        })
    );

    if (st.docHash !== p.doc.hash || !st.docId) {
      const write = async () => {
        if (!st.docId) st.docId = (await google.docs.create(t, p.doc.title)).documentId;
        const d = await google.docs.get(t, st.docId);
        const content = (d.body && d.body.content) || [];
        const end = content.length ? content[content.length - 1].endIndex : 1;
        const reqs = end > 2 ? [{ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1 } } }] : [];
        reqs.push({ insertText: { location: { index: 1 }, text: p.doc.text } });
        await google.docs.batchUpdate(t, st.docId, reqs);
      };
      try {
        await write();
      } catch (e) {
        if (!gone(e)) throw e;
        st.docId = null;
        await write();
      }
      st.docHash = p.doc.hash;
    }
    return { state: st, counts: { events: Object.keys(st.events).length, tasks: Object.keys(st.tasks).length, changes: [cal.counts, tasks.counts] } };
  }

  async function postWebhook(hook, payload) {
    const { url, secret } = vault.open(hook.sealed);
    const body = JSON.stringify(payload);
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const r = await http(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Trueline-Webhook/1', 'X-Trueline-Signature': 'sha256=' + sig },
      body,
      signal: AbortSignal.timeout(8000),
      redirect: 'error'
    });
    return r.status;
  }

  const payloadOf = (user, p, event) => ({
    event,
    sentAt: stamp(),
    account: user.email,
    subject: p ? p.subject : 'Test from Trueline',
    doToday: p ? p.rows : [],
    cash: p ? p.cash : null,
    upcoming: p ? p.events.map((e) => ({ date: e.body.start.date, title: e.body.summary })) : []
  });

  async function run(uid) {
    const user = await accounts.get(uid);
    if (!user) return { skipped: 'no user' };
    const wantsGoogle = Boolean(user.google && user.google.sealed && google.configured);
    const hooks = user.webhooks || [];
    if (!wantsGoogle && !hooks.length) return { skipped: 'nothing connected' };
    const { ws, eng } = await load(uid);
    let p;
    if (eng) p = plan(eng);
    else {
      // Every file was removed. Anything Trueline put in Google is now out of date: take it out, once.
      const st = (user.google && user.google.state) || {};
      const leftovers = Object.keys(st.events || {}).length + Object.keys(st.tasks || {}).length;
      if (!wantsGoogle || !leftovers) return { skipped: 'no files' };
      p = emptyPlan(ws.settings.company);
    }
    const result = {};

    if (wantsGoogle) {
      const connectedAt = user.google.connectedAt;
      try {
        const r = await syncGoogle(user.google, p);
        result.google = r.counts;
        await accounts.updateUser(uid, (u) => {
          if (!u.google || u.google.connectedAt !== connectedAt) return; // disconnected meanwhile
          Object.assign(u.google, {
            state: r.state,
            lastSync: stamp(),
            lastError: null,
            needsReconnect: false,
            counts: { events: r.counts.events, tasks: r.counts.tasks }
          });
        });
      } catch (e) {
        const revoked = e instanceof GoogleError && (e.status === 400 || e.status === 401) && /invalid_grant|revoked|expired/i.test(e.message);
        result.google = { error: short(e) };
        logger.warn({ uid, err: short(e) }, 'google sync failed');
        await accounts.updateUser(uid, (u) => {
          if (!u.google || u.google.connectedAt !== connectedAt) return;
          if (e.state) u.google.state = e.state; // keep what was created before the failure, so a retry does not duplicate it
          Object.assign(u.google, { lastError: revoked ? 'Google access was removed. Connect again.' : short(e), needsReconnect: revoked, lastTry: stamp() });
        });
      }
    }

    if (eng && hooks.length) {
      const statuses = {};
      for (const h of hooks) {
        try {
          statuses[h.id] = String(await postWebhook(h, payloadOf(user, p, 'brief.updated')));
        } catch (e) {
          statuses[h.id] = 'failed: ' + short(e);
        }
      }
      result.webhooks = statuses;
      await accounts.updateUser(uid, (u) =>
        (u.webhooks || []).forEach((h) => {
          if (statuses[h.id]) Object.assign(h, { lastStatus: statuses[h.id], lastAt: stamp() });
        })
      );
    }
    return result;
  }

  /**
   * With a shared lock: run unless another instance is syncing this account. That one is told to go again when it
   * finishes, so the newest files still reach Google, and two instances never create the same events.
   */
  async function runLocked(uid) {
    for (let round = 0; round < 3; round++) {
      if (!(await lock.acquire(uid))) return { skipped: 'already syncing; this change will be included' };
      let again;
      let result;
      try {
        result = await run(uid);
      } finally {
        again = await lock.release(uid);
      }
      if (!again) return result;
    }
    return { skipped: 'still busy; the next sync will catch up' };
  }

  /** Run now, one sync per user at a time. */
  function runNow(uid) {
    const prev = chains.get(uid) || Promise.resolve();
    const next = prev.then(() => (lock ? runLocked(uid) : run(uid)));
    const settled = next.catch((e) => logger.error({ uid, err: short(e) }, 'sync failed'));
    chains.set(uid, settled);
    settled.then(() => chains.get(uid) === settled && chains.delete(uid));
    return next;
  }

  /** Run shortly, so a batch of uploads causes one sync. */
  const queued = new Set();
  function schedule(uid) {
    if (afterResponse) {
      // Serverless: a timer would be frozen with the instance. Run after this response instead; several schedules for
      // the same account in one request become one sync.
      if (queued.has(uid)) return;
      queued.add(uid);
      afterResponse(
        Promise.resolve()
          .then(() => {
            queued.delete(uid);
            return runNow(uid);
          })
          .catch(() => {})
      );
      return;
    }
    clearTimeout(timers.get(uid));
    const t = setTimeout(() => {
      timers.delete(uid);
      runNow(uid).catch(() => {});
    }, debounceMs);
    t.unref();
    timers.set(uid, t);
  }

  async function runAll() {
    const users = await accounts.all();
    for (const u of users) if ((u.google && u.google.sealed) || (u.webhooks || []).length) await runNow(u.id).catch(() => {});
  }

  return {
    run,
    runNow,
    schedule,
    runAll,
    testWebhook: (user, hook) => postWebhook(hook, payloadOf(user, null, 'test')),
    idle: () => Promise.all([...chains.values()])
  };
}

module.exports = { createSync };
