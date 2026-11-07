'use strict';

const path = require('node:path');

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

/** Read and validate environment variables once, at start-up. Fails fast with a readable message. */
function loadConfig(env = process.env) {
  const errors = [];
  const production = env.NODE_ENV === 'production';
  const cfg = {
    env: env.NODE_ENV || 'development',
    production,
    port: num(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || './data'),
    sessionSecret: env.SESSION_SECRET || '',
    encryptionKey: env.ENCRYPTION_KEY || '',
    allowSignup: env.ALLOW_SIGNUP ? env.ALLOW_SIGNUP === 'true' : true,
    signupCode: env.SIGNUP_CODE || '',
    publicUrl: String(env.PUBLIC_URL || '').replace(/\/+$/, ''),
    googleClientId: env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',
    syncHours: num(env.SYNC_HOURS, 6),
    sessionHours: num(env.SESSION_HOURS, 12),
    authAttempts: num(env.AUTH_ATTEMPTS, 10), // sign-in / sign-up / password attempts per 15 minutes per address
    maxUploadMb: num(env.MAX_UPLOAD_MB, 10),
    maxSources: num(env.MAX_SOURCES, 50),
    logLevel: env.LOG_LEVEL || (production ? 'info' : 'debug'),
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : production
  };
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) errors.push('PORT must be 0-65535');
  if (!(cfg.maxUploadMb > 0 && cfg.maxUploadMb <= 50)) errors.push('MAX_UPLOAD_MB must be between 1 and 50');
  if (production) {
    if (cfg.sessionSecret.length < 32) errors.push('SESSION_SECRET must be set (32+ characters) in production');
    if (cfg.encryptionKey.length < 32) errors.push('ENCRYPTION_KEY must be set (32+ characters) in production');
    if (!/^https:\/\//.test(cfg.publicUrl)) errors.push('PUBLIC_URL must be the https address of the site in production');
  }
  if (Boolean(cfg.googleClientId) !== Boolean(cfg.googleClientSecret)) errors.push('Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither');
  if (!(cfg.syncHours >= 1 && cfg.syncHours <= 48)) errors.push('SYNC_HOURS must be between 1 and 48');
  if (errors.length) throw new Error('Invalid configuration:\n - ' + errors.join('\n - '));
  return cfg;
}

module.exports = { loadConfig };
