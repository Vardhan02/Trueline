'use strict';

/**
 * Minimal Google client over fetch: OAuth (offline access), Calendar, Tasks and Docs.
 * Least-privilege scopes: Trueline can only see calendars and docs it created itself.
 */
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.app.created', // only calendars Trueline creates
  'https://www.googleapis.com/auth/tasks', // Google Tasks (where Google Reminders now live)
  'https://www.googleapis.com/auth/drive.file' // only docs Trueline creates
];
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const CAL = 'https://www.googleapis.com/calendar/v3';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
const DOCS = 'https://docs.googleapis.com/v1/documents';

class GoogleError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createGoogle({ clientId, clientSecret, redirectUri, http = globalThis.fetch }) {
  const configured = Boolean(clientId && clientSecret && redirectUri);

  async function call(method, url, token, body) {
    const r = await http(url, {
      method,
      headers: Object.assign(
        { Accept: 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {},
        body ? { 'Content-Type': 'application/json' } : {}
      ),
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let j;
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      j = {};
    }
    if (!r.ok) throw new GoogleError(r.status, (j.error && (j.error.message || j.error_description || j.error)) || 'Google returned ' + r.status);
    return j;
  }
  async function form(url, params) {
    const r = await http(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString()
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new GoogleError(r.status, j.error_description || (typeof j.error === 'string' ? j.error : 'Google returned ' + r.status));
    return j;
  }

  return {
    configured,
    scopes: SCOPES,
    authUrl: (state) =>
      AUTH +
      '?' +
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state
      }).toString(),
    exchange: (code) => form(TOKEN, { code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    refresh: (refreshToken) => form(TOKEN, { refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' }),
    revoke: (token) => form(REVOKE, { token }).catch(() => null), // best effort: the user may have revoked it already
    userinfo: (token) => call('GET', USERINFO, token),
    calendar: {
      create: (t, summary, timeZone) => call('POST', CAL + '/calendars', t, { summary, timeZone, description: 'Bills and expected payments from Trueline.' }),
      insert: (t, cal, body) => call('POST', CAL + '/calendars/' + encodeURIComponent(cal) + '/events', t, body),
      patch: (t, cal, id, body) => call('PATCH', CAL + '/calendars/' + encodeURIComponent(cal) + '/events/' + encodeURIComponent(id), t, body),
      remove: (t, cal, id) => call('DELETE', CAL + '/calendars/' + encodeURIComponent(cal) + '/events/' + encodeURIComponent(id), t)
    },
    tasks: {
      createList: (t, title) => call('POST', TASKS + '/users/@me/lists', t, { title }),
      insert: (t, list, body) => call('POST', TASKS + '/lists/' + encodeURIComponent(list) + '/tasks', t, body),
      patch: (t, list, id, body) => call('PATCH', TASKS + '/lists/' + encodeURIComponent(list) + '/tasks/' + encodeURIComponent(id), t, body)
    },
    docs: {
      create: (t, title) => call('POST', DOCS, t, { title }),
      get: (t, id) => call('GET', DOCS + '/' + encodeURIComponent(id), t),
      batchUpdate: (t, id, requests) => call('POST', DOCS + '/' + encodeURIComponent(id) + ':batchUpdate', t, { requests })
    }
  };
}

module.exports = { createGoogle, GoogleError, SCOPES };
