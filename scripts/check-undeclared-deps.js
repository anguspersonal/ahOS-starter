#!/usr/bin/env node

/**
 * Undeclared-dependency guard
 *
 * Fails when a workspace package imports a bare specifier that is absent from
 * that package's OWN package.json (any of dependencies / devDependencies /
 * peerDependencies / optionalDependencies).
 *
 * Why this exists (#440): in a monorepo, npm hoists every dependency to the root
 * node_modules, so a package can `import { parse } from "yaml"` without declaring
 * `yaml` and still pass tsc, eslint, test, and even the root build - all of which
 * resolve via the hoisted copy. The truth only shows up in an ISOLATED install:
 * worker and mcp-server build in Docker from a COPY of their own package.json
 * alone, so an undeclared import makes tsc fail there and nowhere else. That is
 * exactly how `yaml` shipped undeclared and left mcp-server running three-day
 * stale code in production (fixed in #438/#439). This check catches the whole
 * class in about a second with no Docker.
 *
 * Scope: each package's whole source tree, whatever its layout (`src/` for worker
 * / mcp-server / shared, root-level `app/` / `components/` / etc. for web, root-
 * level files + `app/` for mobile) - build output, tests, and dotdirs are skipped
 * (see SKIP_DIRS) since test-only imports use declared devDeps and never enter the
 * runtime image.
 *
 * Usage:
 *   node scripts/check-undeclared-deps.js            # audit every workspace package
 *   node scripts/check-undeclared-deps.js worker mcp-server   # audit only these
 *
 * Exit 0 = clean, 1 = at least one undeclared import.
 */

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const ROOT = path.join(__dirname, '..');
const PACKAGES_DIR = path.join(ROOT, 'packages');

const BUILTINS = new Set(builtinModules);
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  'public',
  '__tests__',
  '__mocks__',
]);
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
// Build/lint/test tooling entry points (eslint.config.mjs, vitest.config.ts,
// jest.config.js, next.config.ts, tailwind.config.ts, metro.config.js, ...).
// These configure dev tooling that always runs from the workspace it's declared
// in - confirmed against packages/worker/Dockerfile and packages/mcp-server/
// Dockerfile, neither of which COPYs any *.config.* file into the isolated build,
// only package.json / package-lock.json / tsconfig.json / src/. An import here can
// never reproduce the #440 failure mode, same rationale as skipping __tests__ /
// __mocks__ above. This exclusion applies ONLY at the package ROOT: a *.config.*
// file nested under src/ (or any other subdirectory) IS copied into the isolated
// Docker build via `COPY .../src ./src`, so it is scanned like any other source
// file - only a root-level config is skipped.
const TOOLING_CONFIG_RE = /\.config\.(m|c)?[jt]sx?$/;

/** Recursively collect source files under `dir` (pkgRoot = the package's own dir). */
function collectSourceFiles(dir, pkgRoot, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        collectSourceFiles(full, pkgRoot, out);
      }
    } else if (SOURCE_EXT.has(path.extname(entry.name))) {
      // Tooling config (eslint.config.mjs, next.config.ts, ...) lives at the
      // package ROOT and is never COPY'd into the isolated Docker build, so an
      // import there can't reproduce #440. A `*.config.*` nested under src/ IS
      // compiled in that build, so exclude ONLY root-level configs.
      const isRootConfig = dir === pkgRoot && TOOLING_CONFIG_RE.test(entry.name);
      if (!isRootConfig) out.push(full);
    }
  }
  return out;
}

/**
 * Extract every bare-ish import specifier from a source file.
 *
 * Handles multi-line (Prettier-wrapped) imports, `export ... from`, side-effect
 * `import 'x'`, dynamic `import('x')`, and `require('x')`. Block and line comments
 * are stripped first (protecting `://`) so commented-out imports do not register.
 */
function extractSpecifiers(content) {
  const src = content
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments, keep `://`
  const specifiers = new Set();
  const patterns = [
    // static import: default / named / namespace / side-effect, single- or multi-line
    /\bimport\b\s+(?:[\w*{}\n\r\t, ]+\s+from\s+)?['"]([^'"]+)['"]/g,
    // re-export: export ... from 'x' (single- or multi-line)
    /\bexport\b\s+(?:[\w*{}\n\r\t, ]+\s+)?from\s+['"]([^'"]+)['"]/g,
    // dynamic import('x')
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // require('x')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) specifiers.add(m[1]);
  }
  return specifiers;
}

/** Reduce an import specifier to its package name, or null if it isn't one. */
function toPackageName(spec) {
  // Relative / absolute / subpath-imports ('#foo') are never node_modules packages.
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return null;
  // Node builtins, with or without the 'node:' prefix.
  if (spec.startsWith('node:')) return null;
  if (BUILTINS.has(spec)) return null;

  if (spec.startsWith('@')) {
    const [scope, name] = spec.split('/');
    if (!name) return null; // malformed '@scope' with no package
    return `${scope}/${name}`;
  }
  return spec.split('/')[0];
}

/**
 * Strip // and /* *\/ comments from JSONC text, honoring string boundaries.
 *
 * A naive regex-based stripper (matching /\/\*...\*\// anywhere in the text)
 * corrupts real tsconfig.json files: a wildcard path key like "@/*" reads as an
 * opening block comment, and the non-greedy match then eats everything up to the
 * next literal '*' + '/' pair - which glob patterns like "**\/*.ts" in `include`
 * supply for free, silently deleting the whole `paths` block. Tracking string
 * state avoids stripping anything that is really JSON content.
 */
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next;
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
    } else if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/** Build alias matchers from a tsconfig's compilerOptions.paths. */
function loadTsAliases(pkgDir) {
  const tsconfigPath = path.join(pkgDir, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return [];
  let paths;
  try {
    // tsconfig allows comments/trailing commas; strip the common cases so JSON.parse copes.
    const raw = stripJsonComments(fs.readFileSync(tsconfigPath, 'utf-8')).replace(
      /,(\s*[}\]])/g,
      '$1'
    );
    paths = JSON.parse(raw).compilerOptions?.paths ?? {};
  } catch {
    return [];
  }
  // Each key becomes a prefix matcher. Wildcard keys ('@/*') match anything
  // starting with the prefix; exact keys ('@ahkms/shared') only match that exact
  // spec or a subpath of it, so they can't mask an unrelated package that merely
  // shares the prefix (e.g. '@ahkms/shared-utils' vs the '@ahkms/shared' alias).
  return Object.keys(paths).map((key) =>
    key.endsWith('*')
      ? { prefix: key.slice(0, -1), wildcard: true }
      : { prefix: key, wildcard: false }
  );
}

/** '@scope/name' -> '@types/scope__name', 'name' -> '@types/name' (DefinitelyTyped convention). */
function typesPackageFor(pkgName) {
  return pkgName.startsWith('@')
    ? `@types/${pkgName.slice(1).replace('/', '__')}`
    : `@types/${pkgName}`;
}

/** Audit one package directory; return { name, violations: [{ pkgName, file, spec }] }. */
function auditPackage(pkgDir) {
  const manifestPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(manifestPath)) return { name: null, violations: [] };
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
  const aliases = loadTsAliases(pkgDir);
  const ownName = manifest.name;

  const isDeclared = (pkgName) =>
    declared.has(pkgName) || declared.has(typesPackageFor(pkgName)) || pkgName === ownName;
  const isAliased = (spec) =>
    aliases.some((a) =>
      a.wildcard ? spec.startsWith(a.prefix) : spec === a.prefix || spec.startsWith(a.prefix + '/')
    );

  const violations = [];
  const seen = new Set(); // one row per (pkgName, file)
  for (const file of collectSourceFiles(pkgDir, pkgDir)) {
    const content = fs.readFileSync(file, 'utf-8');
    for (const spec of extractSpecifiers(content)) {
      if (isAliased(spec)) continue;
      const pkgName = toPackageName(spec);
      if (!pkgName || isDeclared(pkgName)) continue;
      const key = `${pkgName} ${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({ pkgName, file: path.relative(ROOT, file), spec });
    }
  }
  return { name: ownName, violations };
}

function main() {
  const requested = process.argv.slice(2);
  const allPackages = fs
    .readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(PACKAGES_DIR, e.name, 'package.json')))
    .map((e) => e.name);

  const targets = requested.length ? requested : allPackages;

  console.log('Checking for undeclared dependencies...\n');

  let total = 0;
  for (const dirName of targets) {
    const pkgDir = path.join(PACKAGES_DIR, dirName);
    if (!fs.existsSync(pkgDir)) {
      console.error(`ERROR: no such package directory: packages/${dirName}`);
      process.exit(2);
    }
    const { name, violations } = auditPackage(pkgDir);
    if (violations.length === 0) continue;
    total += violations.length;
    console.log(`FAIL: ${name || dirName} imports ${violations.length} undeclared package(s):`);
    for (const v of violations) {
      console.log(`   - ${v.pkgName}  (as "${v.spec}")`);
      console.log(`       ${v.file}`);
    }
    console.log('');
  }

  if (total === 0) {
    console.log('OK: every imported package is declared in its own package.json.\n');
    process.exit(0);
  }

  console.log(`\n${total} undeclared import(s) found.`);
  console.log(
    '   Add each package to the importing workspace\'s own package.json.\n' +
      '   It resolves locally via monorepo hoisting but will fail the isolated\n' +
      '   Docker build (worker / mcp-server) - the failure mode behind #440.\n'
  );
  process.exit(1);
}

main();
