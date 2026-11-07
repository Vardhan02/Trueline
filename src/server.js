'use strict';

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createContext } = require('./context');

async function main() {
  const cfg = loadConfig();
  const logger = createLogger(cfg.logLevel);

  // Handlers go in before the async start-up, so a failure during start-up is logged as fatal too.
  let server = null;
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    if (!server) process.exit(signal === 'unhandledRejection' ? 1 : 0); // not serving yet: nothing to drain
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10e3).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    logger.fatal({ err }, 'unhandled rejection');
    shutdown('unhandledRejection');
  });

  const { app, sync, google } = await createContext(cfg, { logger });
  if (!cfg.encryptionKey) logger.warn('ENCRYPTION_KEY is not set: using a development key stored in the data folder. Set it in production.');
  if (!google.configured) logger.info('Google is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET): the Connect Google button will explain this.');
  // Keep connected services up to date even when no one uploads anything (dates move, items become overdue).
  const timer = setInterval(() => sync.runAll().catch((err) => logger.error({ err }, 'scheduled sync failed')), cfg.syncHours * 3600e3);
  timer.unref();
  if (!closing) server = app.listen(cfg.port, cfg.host, () => logger.info({ port: cfg.port, env: cfg.env }, 'Trueline is running'));
}

main().catch((err) => {
  process.stderr.write(err.message + '\n');
  process.exit(1);
});
