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
const { plan } = require('./plan');
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
  timeZone = 'Europe/Dublin'
}) {
  const timers = new Map();
  const chains = new Map();
  const stamp = () => new Date(clock()).toISOString().replace(/\.\d+Z$/, 'Z');

  async function engineFor(uid) {
    const ws = await workspaceFor(uid).load();
    if (!ws.sources.length) return null;
    return Engine.create(buildDataset(ws, { clock }));
  }

  /** Make `have` (key -> {id, hash}) match `want` ([{key, hash, body}]). */
  async function reconcile(have, want, ops) {
    const next = {};
    const counts = { created: 0, updated: 0, closed: 0 };
    for (const w of want) {
      const prev = have[w.key];
      if (prev && prev.hash === w.hash) {
        next[w.key] = prev;
        continue;
      }
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
      next[w.key] = { id, hash: w.hash };
    }
    for (const key of Object.keys(have)) {
      if (next[key]) continue;
      try {
        await ops.close(have[key].id);
      } catch (e) {
        if (!gone(e)) throw e;
      }
      counts.closed++;
    }
    return { map: next, counts };
  }

  async function syncGoogle(g, p) {
    const secret = vault.open(g.sealed);
    const t = (await google.refresh(secret.refreshToken)).access_token;
    const st = Object.assign({ events: {}, tasks: {} }, g.state);

    const withContainer = async (field, create, fn) => {
      if (!st[field]) st[field] = (await create()).id;
      try {
        return await fn(st[field]);
      } catch (e) {
        if (!gone(e)) throw e; // the whole calendar or list was deleted: make a new one once
        st[field] = (await create()).id;
        return fn(st[field]);
      }
    };
    const cal = await withContainer(
      'calendarId',
      () => google.calendar.create(t, 'Trueline', timeZone),
      (id) =>
        reconcile(Object.assign({}, st.events), p.events, {
          insert: (b) => google.calendar.insert(t, id, b),
          patch: (eid, b) => google.calendar.patch(t, id, eid, b),
          close: (eid) => google.calendar.remove(t, id, eid)
        })
    );
    st.events = cal.map;
    const tasks = await withContainer(
      'taskListId',
      () => google.tasks.createList(t, 'Trueline'),
      (id) =>
        reconcile(Object.assign({}, st.tasks), p.tasks, {
          insert: (b) => google.tasks.insert(t, id, b),
          patch: (tid, b) => google.tasks.patch(t, id, tid, b),
          close: (tid) => google.tasks.patch(t, id, tid, { status: 'completed' }) // done or no longer needed: tick it off
        })
    );
    st.tasks = tasks.map;

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
    const eng = await engineFor(uid);
    if (!eng) return { skipped: 'no files' };
    const p = plan(eng);
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
          Object.assign(u.google, { lastError: revoked ? 'Google access was removed. Connect again.' : short(e), needsReconnect: revoked, lastTry: stamp() });
        });
      }
    }

    if (hooks.length) {
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

  /** Run now, one sync per user at a time. */
  function runNow(uid) {
    const prev = chains.get(uid) || Promise.resolve();
    const next = prev.then(() => run(uid));
    const settled = next.catch((e) => logger.error({ uid, err: short(e) }, 'sync failed'));
    chains.set(uid, settled);
    settled.then(() => chains.get(uid) === settled && chains.delete(uid));
    return next;
  }

  /** Run shortly, so a batch of uploads causes one sync. */
  function schedule(uid) {
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
