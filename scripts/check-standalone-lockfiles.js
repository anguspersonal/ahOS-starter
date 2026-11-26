#!/usr/bin/env node

/**
 * Standalone-lockfile drift guard (#803).
 *
 * packages/mcp-server, packages/worker and packages/web each commit a package-lock.json that
 * is NOT a workspace lockfile — their Dockerfiles build from an isolated COPY
 * of just that one package.json + package-lock.json, using `npm install` (not
 * `npm ci`) so the build tolerates a mismatch instead of failing on it. That
 * tolerance is exactly the problem: a dependency added to the package.json but
 * never reflected in its lockfile silently floats to whatever its semver range
 * resolves to at image-build time, with nothing failing anywhere — the same
 * non-reproducibility #164 set out to remove, reappearing one dependency at a
 * time. See scripts/regen-standalone-lockfile.js for how to fix a failure here.
 *
 * This checks that every `dependencies` key in each package's package.json
 * (other than the workspace-only "@ahkms/shared") is also a direct dependency
 * in that package's own package-lock.json (the root `packages[""].dependencies`
 * entry, lockfileVersion 3). It does not check version ranges match exactly or
 * that the lock is otherwise up to date — only that nothing has been added to
 * one file and silently left out of the other.
 *
 * Usage:
 *   node scripts/check-standalone-lockfiles.js
 *   npm run check:standalone-lockfiles
 *
 * Exit 0 = clean, 1 = drift found, 2 = could not run.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STANDALONE_PACKAGES = ['mcp-server', 'worker', 'web'];
const WORKSPACE_ONLY = new Set(['@ahkms/shared', '@ahkms/core']);

function auditPackage(pkgName, root = ROOT) {
  const pkgDir = path.join(root, 'packages', pkgName);
  const manifestPath = path.join(pkgDir, 'package.json');
  const lockPath = path.join(pkgDir, 'package-lock.json');

  if (!fs.existsSync(manifestPath)) {
    return { skipped: true, lockMissing: false, missing: [] };
  }

  if (!fs.existsSync(lockPath)) {
    return { skipped: false, lockMissing: true, missing: [] };
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
  const lockDeps = lock.packages?.['']?.dependencies ?? {};

  const declared = Object.keys(manifest.dependencies ?? {}).filter(
    (name) => !WORKSPACE_ONLY.has(name)
  );
  const missing = declared.filter((name) => !(name in lockDeps));

  return { skipped: false, lockMissing: false, missing };
}

function main({ root = ROOT, packages = STANDALONE_PACKAGES } = {}) {
  console.log('Checking standalone package-lock.json files for drift...\n');

  let failed = false;
  let totalMissing = 0;
  const missingLocks = [];

  for (const pkgName of packages) {
    const { skipped, lockMissing, missing } = auditPackage(pkgName, root);
    if (skipped) continue;

    if (lockMissing) {
      failed = true;
      missingLocks.push(pkgName);
      console.log(`FAIL: packages/${pkgName}/package-lock.json is missing.\n`);
      continue;
    }

    if (missing.length > 0) {
      failed = true;
      totalMissing += missing.length;
      console.log(`FAIL: packages/${pkgName}/package-lock.json is missing ${missing.length} dependency(ies) declared in package.json:`);
      for (const name of missing) {
        console.log(`   - ${name}`);
      }
      console.log('');
    }
  }

  if (!failed) {
    console.log('OK: every standalone lockfile covers all of its package.json dependencies.\n');
    return 0;
  }

  if (missingLocks.length > 0) {
    console.log('Generate the missing lockfile(s):');
    for (const pkgName of missingLocks) {
      console.log(`     node scripts/regen-standalone-lockfile.js ${pkgName}`);
    }
    console.log('');
  }

  if (totalMissing > 0) {
    console.log(`\n${totalMissing} missing dependency(ies) found.`);
    console.log(
      '   Regenerate the affected lockfile(s):\n' +
        '     npm run lock:mcp-server\n' +
        '     npm run lock:worker\n' +
        '     node scripts/regen-standalone-lockfile.js web\n' +
        '   Without this, the missing dependency floats to whatever its semver\n' +
        '   range resolves to at image-build time instead of a pinned version (#803).\n'
    );
  }

  return 1;
}

if (require.main === module) process.exit(main());

module.exports = {
  STANDALONE_PACKAGES,
  auditPackage,
  main,
};
