// Flat config (ESLint 9+). Two genuinely different environments live in
// this repo and get two different rule sets:
//
//  - server.js / db / tools / test — real ES modules (import/export), each
//    file's scope is self-contained, so `no-undef` catches real typos.
//
//  - public/js/*.js — classic (non-module) <script> files loaded in a fixed
//    order (see index.html), sharing one global lexical environment on
//    purpose (roadmap #24). A function defined in core.js and called from
//    wizard.js is correct, working code — but `no-undef` can only see one
//    file at a time, so it would flag every one of those as an error. There
//    is no cross-file-aware option for this pattern short of a bundler, so
//    `no-undef` is off for this directory specifically and real reference
//    errors are instead caught by test/app.dom.test.js, which evaluates all
//    8 files together in a real DOM exactly as the browser would.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'db/*.db', 'db/*.db-*', 'public/fonts/**']
  },
  js.configs.recommended,
  {
    // Project-wide: an empty `catch {}` is a deliberate, recurring idiom
    // here (db/sqlite.js's additive migrations swallow "duplicate column"
    // errors on purpose; several fetch/parse paths swallow a failure to
    // fall back to a default) — not an accident worth flagging every time.
    // Function *arguments* required by a callback signature but unused in
    // the body (event handlers, Array callbacks) are the same story; unused
    // *variables* are still flagged.
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { args: 'none' }]
    }
  },
  {
    files: ['server.js', 'db/**/*.js', 'tools/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node }
    }
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.browser, marked: 'readonly', Chart: 'readonly' }
    },
    rules: {
      'no-undef': 'off', // see file-header comment above
      'no-unused-vars': 'off' // same reason — a binding "unused" in its own
      // file is routinely used from a later one
    }
  },
  {
    files: ['public/sw.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.serviceworker }
    }
  }
];
