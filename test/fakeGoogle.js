'use strict';

/** In-memory stand-in for the Google endpoints Trueline calls, plus any webhook. Records every call. */
function fakeGoogle() {
  const g = { calls: [], calendars: {}, lists: {}, docs: {}, hooks: [], n: 0, fail: null, refreshError: null };
  const J = (b, s = 200) => new Response(s === 204 ? null : JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
  const id = (p) => p + ++g.n;
  g.http = async (url, o = {}) => {
    const method = o.method || 'GET';
    const u = new URL(url);
    const body = o.body && typeof o.body === 'string' && o.headers && /json/.test(o.headers['Content-Type'] || '') ? JSON.parse(o.body) : o.body;
    g.calls.push(method + ' ' + u.host + u.pathname);
    if (g.fail && g.fail(method, u)) return J({ error: { message: 'boom' } }, 500);
    if (!/google/.test(u.host)) {
      g.hooks.push({ url, headers: o.headers, body: o.body });
      return J({}, g.hookStatus || 200);
    }
    if (u.pathname === '/token') {
      const p = new URLSearchParams(o.body);
      if (p.get('grant_type') === 'refresh_token' && g.refreshError) return J({ error: 'invalid_grant', error_description: g.refreshError }, 400);
      if (p.get('code') === 'bad') return J({ error: 'invalid_grant' }, 400);
      return J({ access_token: 'at', refresh_token: p.get('code') === 'norefresh' ? undefined : 'rt', scope: 'x' });
    }
    if (u.pathname === '/revoke') return J({});
    if (u.pathname === '/v1/userinfo') return J({ email: 'owner@gmail.example' });
    let m;
    if (u.pathname === '/calendar/v3/calendars') {
      const c = id('cal');
      g.calendars[c] = {};
      return J({ id: c });
    }
    if ((m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/(.+))?$/.exec(u.pathname))) {
      const cal = g.calendars[decodeURIComponent(m[1])];
      if (!cal) return J({ error: { message: 'Not Found' } }, 404);
      if (method === 'POST') {
        const e = id('ev');
        cal[e] = body;
        return J({ id: e });
      }
      if (!cal[m[2]]) return J({ error: { message: 'Not Found' } }, 404);
      if (method === 'DELETE') {
        delete cal[m[2]];
        return J(null, 204);
      }
      cal[m[2]] = body;
      return J({ id: m[2] });
    }
    if (u.pathname === '/tasks/v1/users/@me/lists') {
      const l = id('list');
      g.lists[l] = {};
      return J({ id: l });
    }
    if ((m = /^\/tasks\/v1\/lists\/([^/]+)\/tasks(?:\/(.+))?$/.exec(u.pathname))) {
      const list = g.lists[decodeURIComponent(m[1])];
      if (!list) return J({ error: { message: 'Not Found' } }, 404);
      if (method === 'POST') {
        const t = id('task');
        list[t] = body;
        return J({ id: t });
      }
      if (!list[m[2]]) return J({ error: { message: 'Not Found' } }, 404);
      list[m[2]] = Object.assign(list[m[2]], body);
      return J({ id: m[2] });
    }
    if (u.pathname === '/v1/documents') {
      const d = id('doc');
      g.docs[d] = '';
      return J({ documentId: d });
    }
    if ((m = /^\/v1\/documents\/([^/:]+)(:batchUpdate)?$/.exec(u.pathname))) {
      if (!(m[1] in g.docs)) return J({ error: { message: 'Not Found' } }, 404);
      if (!m[2]) return J({ body: { content: g.docs[m[1]] ? [{ endIndex: 1 }, { endIndex: g.docs[m[1]].length + 2 }] : [{ endIndex: 1 }] } });
      body.requests.forEach((r) => {
        if (r.deleteContentRange) g.docs[m[1]] = '';
        if (r.insertText) g.docs[m[1]] = r.insertText.text;
      });
      return J({});
    }
    return J({ error: { message: 'unexpected ' + url } }, 418);
  };
  return g;
}

module.exports = { fakeGoogle };
