'use strict';

const crypto = require('node:crypto');

const COOKIE = 'tl_session';

const sign = (value, secret) => crypto.createHmac('sha256', secret).update(value).digest('base64url');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((p) => {
      const i = p.indexOf('=');
      if (i > 0) {
        try {
          out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
        } catch {
          /* malformed cookie: ignore it */
        }
      }
    });
  return out;
}

/**
 * Signed session cookie: "userId.expiry.sessionVersion.signature". Changing the password bumps the
 * user's session version, which signs out every other device. No session table to lose on restart.
 */
function createAuth(cfg, accounts, clock = Date.now) {
  const secret = cfg.sessionSecret || crypto.randomBytes(32).toString('hex'); // dev only; sessions reset on restart

  const issue = (user) => {
    const body = [user.id, String(clock() + cfg.sessionHours * 3600e3), String(user.sv || 0)].join('.');
    return body + '.' + sign(body, secret);
  };
  const parse = (token) => {
    const parts = String(token || '').split('.');
    if (parts.length !== 4) return null;
    const body = parts.slice(0, 3).join('.');
    if (!safeEqual(parts[3], sign(body, secret)) || Number(parts[1]) <= clock()) return null;
    return { uid: parts[0], sv: Number(parts[2]) };
  };
  const cookieHeader = (token, maxAgeSec) =>
    COOKIE + '=' + encodeURIComponent(token) + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAgeSec + (cfg.cookieSecure ? '; Secure' : '');

  async function userOf(req) {
    const s = parse(parseCookies(req.headers.cookie)[COOKIE]);
    if (!s) return null;
    const u = await accounts.get(s.uid);
    return u && (u.sv || 0) === s.sv ? u : null;
  }

  return {
    login: (res, user) => res.setHeader('Set-Cookie', cookieHeader(issue(user), cfg.sessionHours * 3600)),
    logout: (res) => res.setHeader('Set-Cookie', cookieHeader('', 0)),
    userOf,
    /** Signed short-lived value for OAuth `state`, tied to one user. */
    stateFor: (uid) => {
      const body = uid + '.' + (clock() + 10 * 60e3) + '.' + crypto.randomBytes(8).toString('base64url');
      return body + '.' + sign('state:' + body, secret);
    },
    checkState: (state) => {
      const parts = String(state || '').split('.');
      if (parts.length !== 4 || !safeEqual(parts[3], sign('state:' + parts.slice(0, 3).join('.'), secret)) || Number(parts[1]) <= clock()) return null;
      return parts[0];
    },
    /** Express middleware: 401 for API calls without a valid session; sets req.user. */
    require: (req, res, next) =>
      userOf(req).then((u) => {
        if (!u) return res.status(401).json({ error: 'Sign in required.' });
        req.user = u;
        next();
      }, next)
  };
}

module.exports = { createAuth, parseCookies, COOKIE };
