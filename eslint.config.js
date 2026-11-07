'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'data/', 'dist/', 'coverage/', 'samples/**/*.js', 'scripts/*.txt'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      strict: ['error', 'global']
    }
  },
  {
    // The engine is a UMD module shared by the server and the browser.
    files: ['src/engine/engine.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.node, ...globals.browser } },
    rules: { strict: 'off' }
  },
  {
    files: ['public/app.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, Engine: 'readonly' } }
  }
];
