'use strict';

/**
 * Run the whole test suite against the Postgres stores (in-process PGlite) instead of files on disk: the storage used on
 * Vercel. Two test files at a time, since each starts its own Postgres. Usage: npm run test:pg
 */
const { spawnSync } = require('node:child_process');

const r = spawnSync(process.execPath, ['--test', '--test-concurrency=2', 'test/*.test.js'], {
  stdio: 'inherit',
  env: Object.assign({}, process.env, { TL_TEST_DB: 'pglite' })
});
process.exit(r.status === null ? 1 : r.status);
