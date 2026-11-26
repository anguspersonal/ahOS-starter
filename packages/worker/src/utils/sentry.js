'use strict';

// DO NOT DELETE — production depends on this file (#650).
//
// `sentry.ts` is TypeScript, but `app.js` and `src/middleware/*.js` are plain
// CommonJS and cannot import it. `require('./src/utils/sentry')` from those
// callers resolves this `.js` first (Node prefers `.js`), and this shim hands
// back the compiled `dist/` build — which is what `npm start` should use.
//
// The `./sentry.ts` fallback covers `npm run dev`, where ts-node is registered
// and no `dist/` may exist yet.
//
// Tests do NOT come through here. jest.config.js sets
// `moduleFileExtensions: ['ts', ...]` so the suite binds to `sentry.ts`
// directly. Before that, a stale `dist/` silently became the code under test —
// see #650 and __tests__/unit/moduleResolution.test.ts, which fails if that
// ordering is ever reverted.

function loadSentryModule() {
  try {
    return require('../../dist/utils/sentry');
  } catch (distError) {
    try {
      return require('./sentry.ts');
    } catch (sourceError) {
      const error = new Error('Unable to load Sentry utils from dist or source');
      error.cause = { distError, sourceError };
      throw error;
    }
  }
}

module.exports = loadSentryModule();
