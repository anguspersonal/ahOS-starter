#!/usr/bin/env node

/**
 * Core Isomorphic Exports Boundary Guard (#1319, #1321, #1340, ADR-100, ADR-101).
 *
 * WHY THIS EXISTS:
 *   ADR-100 and ADR-101 establish @ahkms/core as the pure, isomorphic domain kernel.
 *   The package root entry (`.`) exports contracts only and is imported by browser (web)
 *   and mobile clients.
 *
 *   SDKs under `adapters/` only (#1340):
 *   The package root (`.`) is isomorphic and depends on nothing but `zod`.
 *   Real third-party client SDKs (such as `@supabase/supabase-js`) are Node-only and
 *   allowed exclusively under `packages/core/src/adapters/**`. They must never be
 *   imported by root contracts, actions, engine, or domain logic.
 *
 * WHAT THIS SCRIPT CHECKS:
 *   1. Transitive exports boundary:
 *      Starting from packages/core/src/index.ts (the package root), all transitively
 *      imported files must:
 *      - NEVER import Node.js built-in modules (node:* or bare names like fs, path, crypto, http).
 *      - NEVER import from Node-only subpaths (engine/, adapters/).
 *      - NEVER import forbidden packages (@supabase/supabase-js, @ahkms/shared).
 *   2. packages/core/package.json:
 *      - Must declare exports map with ".", "./actions", "./engine", "./adapters".
 *      - Must NOT declare @ahkms/shared in dependencies.
 *      - dependencies.zod must align with workspace range (^4.0.0).
 *   3. Adapter-only SDK location:
 *      - Across packages/core/src/**, @supabase/supabase-js is allowed ONLY under
 *        packages/core/src/adapters/**, and forbidden anywhere else.
 *
 * Usage:
 *   node scripts/check-core-isomorphic.js
 *   npm run check:core-isomorphic
 *
 * Exit codes: 0 = clean; 1 = violations found; 2 = unexpected error.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

const REPO_ROOT = path.resolve(__dirname, '..');
const CORE_DIR = path.join(REPO_ROOT, 'packages', 'core');
const CORE_SRC = path.join(CORE_DIR, 'src');
const ROOT_ENTRY = path.join(CORE_SRC, 'index.ts');
const CORE_PKG_JSON = path.join(CORE_DIR, 'package.json');

const NODE_BUILTINS = new Set(builtinModules);

const FORBIDDEN_PACKAGES = new Set([
  '@supabase/supabase-js',
  '@ahkms/shared',
]);

const ADAPTER_ONLY_PACKAGES = new Set([
  '@supabase/supabase-js',
]);

const IMPORT_EXPORT_REGEX = /(?:import|export)\s+(?:(?:[\w*\s{},]*)\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_REGEX = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_REGEX = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveRelativeImport(fromFile, specifier) {
  const dir = path.dirname(fromFile);
  let resolved = path.resolve(dir, specifier);

  // If ends with .js, try .ts first (TypeScript ESM rewrite)
  if (resolved.endsWith('.js')) {
    const tsCandidate = resolved.slice(0, -3) + '.ts';
    if (fs.existsSync(tsCandidate)) return tsCandidate;
    const tsxCandidate = resolved.slice(0, -3) + '.tsx';
    if (fs.existsSync(tsxCandidate)) return tsxCandidate;
  }

  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return resolved;
  }
  if (fs.existsSync(resolved + '.ts')) return resolved + '.ts';
  if (fs.existsSync(resolved + '.js')) return resolved + '.js';

  const indexTs = path.join(resolved, 'index.ts');
  if (fs.existsSync(indexTs)) return indexTs;
  const indexJs = path.join(resolved, 'index.js');
  if (fs.existsSync(indexJs)) return indexJs;

  return null;
}

function collectTransitiveImports(entryFile) {
  const visited = new Set();
  const queue = [entryFile];

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    if (!fs.existsSync(current)) continue;
    const content = fs.readFileSync(current, 'utf8');

    const checkSpecifier = (specifier) => {
      if (specifier.startsWith('.')) {
        const target = resolveRelativeImport(current, specifier);
        if (target && !visited.has(target)) {
          queue.push(target);
        }
      }
    };

    let match;
    const staticRegex = new RegExp(IMPORT_EXPORT_REGEX);
    while ((match = staticRegex.exec(content)) !== null) checkSpecifier(match[1]);
    const dynRegex = new RegExp(DYNAMIC_IMPORT_REGEX);
    while ((match = dynRegex.exec(content)) !== null) checkSpecifier(match[1]);
    const reqRegex = new RegExp(REQUIRE_REGEX);
    while ((match = reqRegex.exec(content)) !== null) checkSpecifier(match[1]);
  }

  return visited;
}

function checkRootTransitiveBoundary() {
  const violations = [];
  if (!fs.existsSync(ROOT_ENTRY)) {
    console.error(`ERROR: Core root entrypoint not found: ${ROOT_ENTRY}`);
    process.exit(2);
  }

  const transitiveFiles = collectTransitiveImports(ROOT_ENTRY);

  for (const file of transitiveFiles) {
    const relativePath = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
    const content = fs.readFileSync(file, 'utf8');

    const checkSpecifier = (specifier, lineNum) => {
      // 1. Check for node: prefix
      if (specifier.startsWith('node:')) {
        violations.push({
          file: relativePath,
          line: lineNum,
          specifier,
          reason: `Node built-in prefix "${specifier}" is forbidden in @ahkms/core root exports (must remain isomorphic).`,
        });
        return;
      }

      // 2. Check for bare Node builtin names
      if (NODE_BUILTINS.has(specifier)) {
        violations.push({
          file: relativePath,
          line: lineNum,
          specifier,
          reason: `Node built-in module "${specifier}" is forbidden in @ahkms/core root exports (must remain isomorphic).`,
        });
        return;
      }

      // 3. Check for forbidden non-isomorphic packages
      if (FORBIDDEN_PACKAGES.has(specifier)) {
        violations.push({
          file: relativePath,
          line: lineNum,
          specifier,
          reason: `Package "${specifier}" is forbidden in @ahkms/core root kernel to prevent Node-only pollution (#1319).`,
        });
        return;
      }

      // 4. Check for leaks into Node-only subpaths (engine/, adapters/)
      if (specifier.startsWith('.')) {
        const target = resolveRelativeImport(file, specifier);
        if (target) {
          const relToCoreSrc = path.relative(CORE_SRC, target).replace(/\\/g, '/');
          if (relToCoreSrc.startsWith('engine/') || relToCoreSrc.startsWith('adapters/')) {
            violations.push({
              file: relativePath,
              line: lineNum,
              specifier,
              reason: `Root exports must not import from Node-only subpath "${relToCoreSrc}" (ADR-101 #1321).`,
            });
          }
        }
      }
    };

    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      const lineNum = idx + 1;
      let match;
      const staticRegex = new RegExp(IMPORT_EXPORT_REGEX);
      while ((match = staticRegex.exec(line)) !== null) checkSpecifier(match[1], lineNum);
      const dynRegex = new RegExp(DYNAMIC_IMPORT_REGEX);
      while ((match = dynRegex.exec(line)) !== null) checkSpecifier(match[1], lineNum);
      const reqRegex = new RegExp(REQUIRE_REGEX);
      while ((match = reqRegex.exec(line)) !== null) checkSpecifier(match[1], lineNum);
    });
  }

  return violations;
}

function checkCorePackageJson(corePkgJsonPath = CORE_PKG_JSON) {
  const violations = [];
  if (!fs.existsSync(corePkgJsonPath)) {
    console.error(`ERROR: Core package.json not found: ${corePkgJsonPath}`);
    process.exit(2);
  }

  const pkg = JSON.parse(fs.readFileSync(corePkgJsonPath, 'utf8'));
  const deps = pkg.dependencies || {};

  if (deps['@ahkms/shared']) {
    violations.push({
      file: path.relative(REPO_ROOT, corePkgJsonPath).replace(/\\/g, '/'),
      reason: '@ahkms/shared declared in dependencies; re-exporting shared pulls Node-only utils into the kernel (#1319).',
    });
  }

  if (deps.zod && deps.zod !== '^4.0.0') {
    violations.push({
      file: path.relative(REPO_ROOT, corePkgJsonPath).replace(/\\/g, '/'),
      reason: `zod version "${deps.zod}" must be aligned to "^4.0.0" to prevent dual-instance instanceof failures across workspace packages (#1319).`,
    });
  }

  // Verify exports map has all 4 subpaths required by ADR-101
  const exportsMap = pkg.exports || {};
  const requiredSubpaths = ['.', './actions', './engine', './adapters'];
  for (const sub of requiredSubpaths) {
    if (!exportsMap[sub]) {
      violations.push({
        file: path.relative(REPO_ROOT, corePkgJsonPath).replace(/\\/g, '/'),
        reason: `Missing required exports subpath "${sub}" in package.json exports map (ADR-101 #1321).`,
      });
    }
  }

  return violations;
}

function findCoreFiles(dir, ext = ['.ts', '.js', '.tsx', '.jsx']) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      results.push(...findCoreFiles(fullPath, ext));
    } else if (entry.isFile()) {
      if (ext.some((e) => entry.name.endsWith(e))) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function checkFileForAdapterOnlyPackages(file, content, coreSrcDir = CORE_SRC) {
  const violations = [];
  const relToCoreSrc = path.relative(coreSrcDir, file).replace(/\\/g, '/');

  // Allow SDKs anywhere under packages/core/src/adapters/
  if (relToCoreSrc.startsWith('adapters/') || relToCoreSrc === 'adapters') {
    return violations;
  }

  const checkSpecifier = (specifier, lineNum) => {
    if (ADAPTER_ONLY_PACKAGES.has(specifier)) {
      violations.push({
        file: path.relative(REPO_ROOT, file).replace(/\\/g, '/'),
        line: lineNum,
        specifier,
        reason: `SDK "${specifier}" is forbidden outside adapters/ (found in "${relToCoreSrc}"). Real client SDKs belong exclusively under packages/core/src/adapters/** (ADR-101 §3, #1340).`,
      });
    }
  };

  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    let match;
    const staticRegex = new RegExp(IMPORT_EXPORT_REGEX);
    while ((match = staticRegex.exec(line)) !== null) checkSpecifier(match[1], lineNum);
    const dynRegex = new RegExp(DYNAMIC_IMPORT_REGEX);
    while ((match = dynRegex.exec(line)) !== null) checkSpecifier(match[1], lineNum);
    const reqRegex = new RegExp(REQUIRE_REGEX);
    while ((match = reqRegex.exec(line)) !== null) checkSpecifier(match[1], lineNum);
  });

  return violations;
}

function checkAdapterOnlyPackages(coreSrcDir = CORE_SRC) {
  const violations = [];
  const files = findCoreFiles(coreSrcDir);
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    violations.push(...checkFileForAdapterOnlyPackages(file, content, coreSrcDir));
  }
  return violations;
}

function main() {
  const boundaryViolations = checkRootTransitiveBoundary();
  const pkgViolations = checkCorePackageJson();
  const adapterViolations = checkAdapterOnlyPackages();
  const allViolations = [...boundaryViolations, ...pkgViolations, ...adapterViolations];

  if (allViolations.length > 0) {
    console.error('FAIL: @ahkms/core exports boundary guard violations found:');
    for (const v of allViolations) {
      if (v.line) {
        console.error(`  - ${v.file}:${v.line} -> import "${v.specifier}": ${v.reason}`);
      } else {
        console.error(`  - ${v.file}: ${v.reason}`);
      }
    }
    process.exit(1);
  }

  console.log('OK: @ahkms/core exports boundary verified (root is isomorphic contracts; subpaths declared; zod aligned; SDKs in adapters only).');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  checkRootTransitiveBoundary,
  checkCorePackageJson,
  checkAdapterOnlyPackages,
  checkFileForAdapterOnlyPackages,
  ADAPTER_ONLY_PACKAGES,
  main,
};
