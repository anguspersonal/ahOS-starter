#!/usr/bin/env node

/**
 * Circular Dependency Guard (#1723).
 *
 * WHY THIS EXISTS:
 *   In Node.js ES modules (ESM), circular dependencies between modules can cause
 *   top-level `const` exports to be evaluated before initialization (Temporal
 *   Dead Zone / TDZ), resulting in fatal runtime `ReferenceError` crashes at
 *   service boot.
 *
 *   TypeScript compilation (`tsc`) does not catch this because TypeScript's type
 *   system does not model runtime ESM module evaluation order.
 *
 *   This script analyzes compiled JavaScript in `dist/` directories, where
 *   type-only imports are already erased by `tsc`, ensuring that all detected
 *   cycles represent true JavaScript runtime dependency loops.
 *
 * Usage:
 *   node scripts/check-circular-deps.js [dirs...]
 *   npm run check:circular-deps
 *
 * Exit codes:
 *   0 = clean (no circular dependencies)
 *   1 = circular dependencies found
 *   2 = configuration or filesystem error
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_DIRS = [
  path.join(REPO_ROOT, 'packages', 'mcp-server', 'dist'),
  path.join(REPO_ROOT, 'packages', 'core', 'dist'),
];

function getJsFiles(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '__tests__') {
        files.push(...getJsFiles(full));
      }
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      files.push(full);
    }
  }
  return files;
}

const IMPORT_EXPORT_REGEX = /(?:import|export)\s+(?:[\s\S]*?from\s+)?["\x27]([\.\/][^"\x27]+)["\x27]/g;

function checkDirectory(targetDir) {
  if (!fs.existsSync(targetDir)) {
    console.warn(`[check:circular-deps] Directory not found (did you run build?): ${path.relative(REPO_ROOT, targetDir)}`);
    return { filesCount: 0, cycles: [] };
  }

  const files = getJsFiles(targetDir);
  const graph = new Map();

  for (const file of files) {
    let content = fs.readFileSync(file, 'utf8');
    // Strip single-line and multi-line comments so comments containing import statements are ignored.
    content = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    const deps = [];
    let match;
    IMPORT_EXPORT_REGEX.lastIndex = 0;
    while ((match = IMPORT_EXPORT_REGEX.exec(content)) !== null) {
      const spec = match[1];
      if (spec.startsWith('.')) {
        let resolved = path.resolve(path.dirname(file), spec);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
          resolved = path.join(resolved, 'index.js');
        }
        if (fs.existsSync(resolved)) {
          deps.push(resolved);
        }
      }
    }
    graph.set(file, deps);
  }

  const visited = new Map(); // 0 = unvisited, 1 = visiting (on current stack), 2 = visited
  const cycles = [];

  function dfs(node, pathStack) {
    visited.set(node, 1);
    pathStack.push(node);

    const neighbors = graph.get(node) || [];
    for (const neighbor of neighbors) {
      const state = visited.get(neighbor) || 0;
      if (state === 1) {
        const cycleStartIndex = pathStack.indexOf(neighbor);
        cycles.push(pathStack.slice(cycleStartIndex).concat(neighbor));
      } else if (state === 0) {
        dfs(neighbor, pathStack);
      }
    }

    pathStack.pop();
    visited.set(node, 2);
  }

  for (const node of graph.keys()) {
    if (!visited.get(node)) {
      dfs(node, []);
    }
  }

  return { filesCount: files.length, cycles };
}

function main() {
  const dirs = process.argv.slice(2).length > 0
    ? process.argv.slice(2).map((d) => path.resolve(REPO_ROOT, d))
    : DEFAULT_DIRS;

  let totalFiles = 0;
  let totalCycles = 0;

  for (const dir of dirs) {
    const relDir = path.relative(REPO_ROOT, dir);
    const { filesCount, cycles } = checkDirectory(dir);
    totalFiles += filesCount;

    if (cycles.length > 0) {
      totalCycles += cycles.length;
      console.error(`\n❌ Found ${cycles.length} circular dependency loop(s) in ${relDir}:`);
      for (const cycle of cycles) {
        const formatted = cycle.map((p) => path.relative(dir, p)).join(' -> ');
        console.error(`  ${formatted}`);
      }
    }
  }

  if (totalCycles > 0) {
    console.error(`\nFound ${totalCycles} total circular dependencies across ${totalFiles} files.`);
    process.exit(1);
  }

  console.log(`✔ No circular dependencies found across ${totalFiles} compiled files.`);
}

if (require.main === module) {
  main();
}

module.exports = { checkDirectory };
