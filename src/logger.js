'use strict';

const pino = require('pino');

function createLogger(level = 'info') {
  return pino({ level, redact: ['req.headers.cookie', 'req.headers.authorization'] });
}

module.exports = { createLogger };
