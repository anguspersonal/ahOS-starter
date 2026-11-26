#!/usr/bin/env node

/**
 * Native Node ESM Entrypoint Smoke Guard (#1723).
 *
 * WHY THIS EXISTS:
 *   In Node.js ES modules, circular dependencies and top-level execution ordering
 *   issues can lead to runtime `ReferenceError: Cannot access '...' before initialization`
 *   (Temporal Dead Zone / TDZ) or unhandled module resolution errors.
 *
 *   These runtime errors are invisible to TypeScript compilation (`tsc`) and are
 *   frequently masked by Vitest's mocked module runner.
 *
 *   This guard runs each compiled service entrypoint directly with native Node.js
 *   in a dry-run smoke mode (`CHECK_SMOKE=1`), ensuring that all top-level module
 *   initialization and server registry creation succeed in production.
 *
 * Usage:
 *   node scripts/check-esm-smoke.js
 *   npm run check:esm-smoke
 *
 * Exit codes:
 *   0 = clean (entrypoints boot and initialize without error)
 *   1 = runtime error or initialization failure
 *   2 = missing compiled artifacts (dist not found)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

const ENTRYPOINTS = [
  {
    name: 'mcp-server (HTTP)',
    file: path.join(REPO_ROOT, 'packages', 'mcp-server', 'dist', 'http.js'),
  },
  {
    name: 'mcp-server (Stdio)',
    file: path.join(REPO_ROOT, 'packages', 'mcp-server', 'dist', 'index.js'),
  },
];

const SMOKE_ENV = {
  ...process.env,
  CHECK_SMOKE: '1',
  SUPABASE_URL: 'https://mock.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'mock-key',
  KMS_USER_ID: '00000000-0000-0000-0000-000000000000',
};

function main() {
  let hasFailure = false;

  for (const entry of ENTRYPOINTS) {
    if (!fs.existsSync(entry.file)) {
      console.error(`❌ [check:esm-smoke] Compiled entrypoint not found: ${path.relative(REPO_ROOT, entry.file)} (did you run build?)`);
      process.exit(2);
    }

    try {
      execFileSync('node', [entry.file], {
        env: SMOKE_ENV,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      console.log(`✔ [check:esm-smoke] ${entry.name} entrypoint booted and initialized cleanly.`);
    } catch (err) {
      hasFailure = true;
      console.error(`\n❌ [check:esm-smoke] ${entry.name} crashed during ESM boot evaluation:`);
      if (err.stderr) {
        console.error(err.stderr.toString('utf8'));
      } else if (err.stdout) {
        console.error(err.stdout.toString('utf8'));
      } else {
        console.error(err.message);
      }
    }
  }

  if (hasFailure) {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { ENTRYPOINTS };
