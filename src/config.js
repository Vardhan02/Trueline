'use strict';

const path = require('node:path');

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

/**
 * Which hops may set X-Forwarded-For. The client IP decides rate limits, so trusting a header the client wrote itself
 * would let anyone reset their sign-in limit. By default only proxies on this machine or a private network are trusted
 * (Caddy or nginx on localhost, a Docker network, a cloud load balancer); a client on the internet cannot pose as one.
 * TRUST_PROXY accepts what Express accepts: true/false, a hop count, or a list of addresses and subnets.
 */
function trustProxy(v) {
  if (v === undefined || v === '') return 'loopback, linklocal, uniquelocal';
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

/** Vercel limits a request body to 4.5 MB, so uploads there stay a little under it. */
const VERCEL_MAX_MB = 4;

/** Read and validate environment variables once, at start-up. Fails fast with a readable message. */
function loadConfig(env = process.env) {
  const errors = [];
  const production = env.NODE_ENV === 'production';
  // On Vercel there is no lasting disk and no long-running process: data lives in Postgres (Neon), background syncs
  // run after each response and from a daily cron, and request bodies are capped.
  const vercel = env.VERCEL === '1';
  const databaseUrl = env.DATABASE_URL || env.POSTGRES_URL || '';
  const vercelHost = env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL || '';
  const cfg = {
    vercel,
    serverless: vercel,
    storage: databaseUrl ? 'postgres' : 'files',
    databaseUrl,
    cronSecret: env.CRON_SECRET || '',
    inboundMaxMb: vercel ? VERCEL_MAX_MB : 25,
    env: env.NODE_ENV || 'development',
    production,
    port: num(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || './data'),
    sessionSecret: env.SESSION_SECRET || '',
    encryptionKey: env.ENCRYPTION_KEY || '',
    allowSignup: env.ALLOW_SIGNUP ? env.ALLOW_SIGNUP === 'true' : true,
    signupCode: env.SIGNUP_CODE || '',
    publicUrl: String(env.PUBLIC_URL || (vercel && vercelHost ? 'https://' + vercelHost : '')).replace(/\/+$/, ''),
    googleClientId: env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',
    syncHours: num(env.SYNC_HOURS, 6),
    sessionHours: num(env.SESSION_HOURS, 12),
    authAttempts: num(env.AUTH_ATTEMPTS, 10), // sign-in / sign-up / password attempts per 15 minutes per address
    maxUploadMb: num(env.MAX_UPLOAD_MB, vercel ? VERCEL_MAX_MB : 10),
    maxSources: num(env.MAX_SOURCES, 50),
    logLevel: env.LOG_LEVEL || (production ? 'info' : 'debug'),
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : production,
    // Vercel's own edge is the single proxy in front of the function and sets X-Forwarded-For itself.
    trustProxy: vercel && !env.TRUST_PROXY ? 1 : trustProxy(env.TRUST_PROXY)
  };
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) errors.push('PORT must be 0-65535');
  if (!(cfg.maxUploadMb > 0 && cfg.maxUploadMb <= 50)) errors.push('MAX_UPLOAD_MB must be between 1 and 50');
  if (vercel && cfg.maxUploadMb > VERCEL_MAX_MB) errors.push('MAX_UPLOAD_MB can be at most ' + VERCEL_MAX_MB + ' on Vercel (requests are limited to 4.5 MB)');
  if (vercel && !databaseUrl)
    errors.push('DATABASE_URL must be set on Vercel: add a Neon database to the project (Vercel dashboard → Storage), which sets it for you');
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) errors.push('DATABASE_URL must be a postgres:// connection string');
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
