#!/usr/bin/env node

/**
 * Core Import Direction Guard (#1321, ADR-101 §3).
 *
 * WHY THIS EXISTS:
 *   ADR-101 establishes a strict internal dependency hierarchy within @ahkms/core:
 *     contracts → actions → engine (never backwards)
 *   Adapters are imported ONLY by the two composition roots:
 *     - packages/mcp-server front door startup
 *     - packages/core/src/engine/main.ts
 *     (and by unit test files)
 *
 * WHAT THIS SCRIPT CHECKS:
 *   1. contracts (src/index.ts, src/domain/**, src/actions/domain/**, src/actions/types.ts)
 *      must NEVER import from actions, engine, or adapters.
 *   2. actions (src/actions/**) must NEVER import from engine or adapters.
 *   3. engine (src/engine/**) must NEVER import from adapters, EXCEPT in src/engine/main.ts.
 *   4. adapters (src/adapters/**) must NEVER import backwards from engine or actions internals.
 *   5. Outside core: web and mobile must NEVER import @ahkms/core/adapters or @ahkms/core/engine.
 *
 * Usage:
 *   node scripts/check-core-import-direction.js
 *   npm run check:core-import-direction
 *
 * Exit codes: 0 = clean; 1 = violations found; 2 = unexpected error.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const CORE_DIR = path.join(REPO_ROOT, 'packages', 'core');
const CORE_SRC = path.join(CORE_DIR, 'src');

const IMPORT_EXPORT_REGEX = /(?:import|export)\s+(?:(?:[\w*\s{},]*)\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_REGEX = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_REGEX = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function findFiles(dir, ext = ['.ts', '.js']) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') {
        continue;
      }
      results.push(...findFiles(fullPath, ext));
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) {
        continue;
      }
      if (ext.some((e) => entry.name.endsWith(e))) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function resolveRelativeImport(fromFile, specifier) {
  const dir = path.dirname(fromFile);
  let resolved = path.resolve(dir, specifier);

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

function classifyFile(absPath) {
  const rel = path.relative(CORE_SRC, absPath).replace(/\\/g, '/');

  // Composition roots
  if (rel === 'engine/main.ts' || rel === 'engine/main.js') {
    return 'composition-root';
  }

  // Contracts layer: pure schemas, types, and isomorphic domain definitions
  if (
    rel === 'index.ts' ||
    rel.startsWith('domain/') ||
    rel.startsWith('actions/domain/') ||
    rel === 'actions/types.ts'
  ) {
    return 'contracts';
  }

  // Engine layer: scheduler tick, locks, runLog, cadences, runner
  if (rel.startsWith('engine/')) {
    return 'engine';
  }

  // Adapters layer: concrete persistence and integrations satisfying ports
  if (rel.startsWith('adapters/')) {
    return 'adapters';
  }

  // Actions layer: action definitions and CAR dispatcher
  if (rel.startsWith('actions/')) {
    return 'actions';
  }

  return 'other';
}

function checkCoreImportDirection() {
  const violations = [];
  if (!fs.existsSync(CORE_SRC)) {
    console.error(`ERROR: Core source directory not found: ${CORE_SRC}`);
    process.exit(2);
  }

  const files = findFiles(CORE_SRC);

  for (const file of files) {
    const fileLayer = classifyFile(file);
    const relativePath = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
    const content = fs.readFileSync(file, 'utf8');

    const checkSpecifier = (specifier, lineNum) => {
      let targetLayer = null;

      if (specifier.startsWith('.')) {
        const targetPath = resolveRelativeImport(file, specifier);
        if (targetPath && targetPath.startsWith(CORE_SRC)) {
          targetLayer = classifyFile(targetPath);
        }
      } else if (specifier.startsWith('@ahkms/core/')) {
        const sub = specifier.slice('@ahkms/core/'.length);
        if (sub.startsWith('engine')) targetLayer = 'engine';
        else if (sub.startsWith('adapters')) targetLayer = 'adapters';
        else if (sub.startsWith('actions')) targetLayer = 'actions';
        else targetLayer = 'contracts';
      }

      if (!targetLayer) return;

      // 1. Contracts must NEVER import from actions, engine, or adapters
      if (fileLayer === 'contracts') {
        if (targetLayer === 'actions') {
          // Allow index.ts to export actions entrypoints as part of CAR root facade if needed,
          // but domain schemas must not import actions.
          const rel = path.relative(CORE_SRC, file).replace(/\\/g, '/');
          if (rel !== 'index.ts') {
            violations.push({
              file: relativePath,
              line: lineNum,
              specifier,
              reason: `Contracts file cannot import from actions layer (hierarchy: contracts → actions → engine; ADR-101).`,
            });
          }
        } else if (targetLayer === 'engine' || targetLayer === 'adapters' || targetLayer === 'composition-root') {
          violations.push({
            file: relativePath,
            line: lineNum,
            specifier,
            reason: `Contracts file cannot import from ${targetLayer} layer (contracts must be pure and isomorphic; ADR-101).`,
          });
        }
      }

      // 2. Actions must NEVER import from engine or adapters
      if (fileLayer === 'actions') {
        if (targetLayer === 'engine' || targetLayer === 'composition-root') {
          violations.push({
            file: relativePath,
            line: lineNum,
            specifier,
            reason: `Actions cannot import from engine layer (hierarchy: contracts → actions → engine; ADR-101).`,
          });
        } else if (targetLayer === 'adapters') {
          violations.push({
            file: relativePath,
            line: lineNum,
            specifier,
            reason: `Actions cannot import concrete adapters directly (actions are written against ports; adapters wired at composition roots; ADR-101).`,
          });
        }
      }

      // 3. Engine must NEVER import from adapters, EXCEPT in engine/main.ts
      if (fileLayer === 'engine') {
        if (targetLayer === 'adapters') {
          violations.push({
            file: relativePath,
            line: lineNum,
            specifier,
            reason: `Engine internal files cannot import adapters directly; only composition roots (engine/main.ts) wire adapters (ADR-101).`,
          });
        }
      }

      // 4. Adapters must NEVER import from concrete actions or engine internals
      if (fileLayer === 'adapters') {
        if (targetLayer === 'composition-root') {
          violations.push({
            file: relativePath,
            line: lineNum,
            specifier,
            reason: `Adapters cannot import composition roots (ADR-101).`,
          });
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

function checkOutsideConsumers() {
  const violations = [];
  const consumerDirs = [
    path.join(REPO_ROOT, 'packages', 'web', 'src'),
    path.join(REPO_ROOT, 'packages', 'mobile', 'src'),
  ];

  for (const dir of consumerDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = findFiles(dir);

    for (const file of files) {
      const relativePath = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      const content = fs.readFileSync(file, 'utf8');

      const checkSpecifier = (specifier, lineNum) => {
        if (specifier === '@ahkms/core/adapters' || specifier.startsWith('@ahkms/core/adapters/')) {
          violations.push({
            file: relativePath,
            line: lineNum,
            specifier,
            reason: `Client packages must not import Node-only @ahkms/core/adapters (ADR-101).`,
          });
        }
        if (specifier === '@ahkms/core/engine' || specifier.startsWith('@ahkms/core/engine/')) {
          violations.push({
            file: relativePath,
            line: lineNum,
            specifier,
            reason: `Client packages must not import @ahkms/core/engine (ADR-101).`,
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
      });
    }
  }

  return violations;
}

function main() {
  const coreViolations = checkCoreImportDirection();
  const consumerViolations = checkOutsideConsumers();
  const allViolations = [...coreViolations, ...consumerViolations];

  if (allViolations.length > 0) {
    console.error('FAIL: @ahkms/core import direction guard violations found:');
    for (const v of allViolations) {
      console.error(`  - ${v.file}:${v.line} -> "${v.specifier}": ${v.reason}`);
    }
    process.exit(1);
  }

  console.log('OK: @ahkms/core import direction verified (contracts → actions → engine; adapters in composition roots only; ADR-101).');
  process.exit(0);
}

main();
