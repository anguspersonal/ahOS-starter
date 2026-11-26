/**
 * Issue #650 — the suite must bind to TypeScript source, never to `dist/`.
 *
 * Two files under `src/` are CommonJS shims that shadow a `.ts` sibling:
 * `utils/alerts.js` and `utils/sentry.js`. Both do
 * `require('../../dist/utils/<name>')` with a `require('./<name>.ts')` fallback.
 * They exist because `app.js` and the plain-JS middleware are CommonJS and
 * cannot import a `.ts` module at runtime — production genuinely needs them.
 *
 * Jest's DEFAULT `moduleFileExtensions` puts `js` before `ts`, so every
 * `require('../utils/alerts')` in a test resolved to the shim, and the shim
 * preferred `dist/`. On any machine carrying a stale build the suite silently
 * ran against it: a `dist/utils/alerts.js` dated 12 Jul produced
 * `TypeError: isAlertDeliveryConfigured is not a function` pointing at a line
 * of perfectly good source. `jest --clearCache` does not help — it is
 * resolution, not caching. CI never reproduced it because a fresh checkout has
 * no `dist/`, so the shim fell through to source and the trap stayed armed.
 *
 * The fix is `moduleFileExtensions: ['ts', 'js', 'json', 'node']` in
 * jest.config.js. This test is the guard: it fails if that ordering is ever
 * reverted, or if a new `.js` file starts shadowing a `.ts` sibling.
 *
 * Relates #573, #513, #613.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const SRC = resolve(__dirname, '../../src');

/**
 * `src/`-relative, always `/`-separated. `findShadowedModules` builds paths with
 * `join`, so on Windows they come back `utils\alerts` and a deep-equal against
 * POSIX literals fails — the suite was red on every Windows dev machine while
 * Linux CI stayed green. Only this projection needs it: the `require.resolve`
 * case below compares two native paths, so it already agrees on both platforms.
 */
const toPosixRelative = (p: string) => p.slice(SRC.length + 1).split(sep).join('/');

/** Every `<name>.js` under src/ that sits next to a `<name>.ts`. */
function findShadowedModules(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      findShadowedModules(full, found);
    } else if (entry.endsWith('.js')) {
      const ts = `${full.slice(0, -3)}.ts`;
      try {
        if (statSync(ts).isFile()) found.push(full.slice(0, -3));
      } catch {
        // no .ts sibling — a standalone CommonJS module, not a shadow
      }
    }
  }
  return found;
}

describe('module resolution (#650)', () => {
  const shadowed = findShadowedModules(SRC);

  it('finds the known .js-shadows-.ts pairs, so the cases below are not vacuous', () => {
    // If this fails because the list SHRANK, a shim was deleted — check app.js
    // and src/middleware/*.js still load at runtime before accepting it.
    // If it GREW, the new file carries the same hazard: extend this test.
    expect(shadowed.map(toPosixRelative).sort()).toEqual(['utils/alerts', 'utils/sentry']);
  });

  it.each(shadowed)('resolves %s to the .ts source, not the .js shim', (modulePath) => {
    expect(require.resolve(modulePath)).toBe(`${modulePath}.ts`);
  });

  // The resolution assertions above are necessary but not sufficient: a shim
  // resolves to its own .js path, so "not in dist/" is trivially true even when
  // broken — dist is only reached at require time, INSIDE the shim. This is the
  // assertion that actually bit us. `isAlertDeliveryConfigured` was added to
  // alerts.ts by #573's round-1 review and is absent from any build older than
  // that, so binding to a stale dist makes it `undefined` and the scheduler dies
  // with `TypeError: ... is not a function`.
  it('loads the live source, not a build predating #573', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const alerts = require('../../src/utils/alerts');
    expect(typeof alerts.isAlertDeliveryConfigured).toBe('function');
  });
});
