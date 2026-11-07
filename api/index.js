'use strict';

/**
 * Vercel entry point: every path that is not a static file in public/ is sent here (see vercel.json).
 * The app is built once per instance, on its first request, and reused while the instance stays warm.
 * Data lives in Postgres (DATABASE_URL, from the Neon integration); see docs/DEPLOY.md.
 */
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { createContext } = require('../src/context');

let ready = null;
function getApp() {
  if (!ready) {
    ready = (async () => {
      const cfg = loadConfig();
      const logger = createLogger(cfg.logLevel);
      const { app } = await createContext(cfg, { logger });
      return app;
    })().catch((err) => {
      ready = null; // try again on the next request (a database that was briefly unreachable, a fixed setting)
      throw err;
    });
  }
  return ready;
}

module.exports = async (req, res) => {
  let app;
  try {
    app = await getApp();
  } catch (err) {
    // Configuration errors name the settings to fix (never their values); anything else stays generic.
    const config = /^Invalid configuration/.test(err.message);
    process.stderr.write('Trueline failed to start: ' + err.message + '\n');
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: config ? err.message : 'The server could not start. Check the deployment logs.' }));
    return;
  }
  return app(req, res);
};
