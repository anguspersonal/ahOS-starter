#!/usr/bin/env node
'use strict';

/**
 * Client-writes guard — browser/mobile roles read under RLS and write only
 * through `/api/actions` (#1450, ADR-100 §2, ADR-102 §3 / Consequences).
 *
 * WHY THIS EXISTS (ADR-102 Consequences):
 *   A rule written only in prose is forgotten the next time an agent copies a
 *   nearby pattern (#1325 left `graphLevelActions.ts` out as "client-only view
 *   state", missing two direct `.from("entities").update(...)` calls). Migration
 *   141 revokes INSERT, UPDATE, DELETE and TRUNCATE on `public` tables from
 *   `anon` and `authenticated`; this guard fails CI and pre-push before a direct
 *   Supabase write call in `packages/web/src` or `packages/mobile` or a migration
 *   re-granting table writes to `anon`/`authenticated` can land.
 *
 * BLIND SPOT:
 *   Static regex analysis cannot trace a query builder held in a variable and
 *   written later (e.g. `const q = supabase.from("x"); q.update(...)`). The
 *   database-level REVOKE in migration 141 is the runtime backstop for that case.
 *
 * Exit codes: 0 = clean; 1 = violation(s); 2 = could not run.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CLIENT_ROOTS = [
  path.join(REPO_ROOT, 'packages', 'web', 'src'),
  path.join(REPO_ROOT, 'packages', 'mobile'),
];
const DEFAULT_MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', '.next', 'coverage', '.git']);
const CODE_EXT = /\.[jt]sx?$/;

// Adapted from check-artifact-surface-writes.js:71 (do not import or edit it).
const CHAINED_FROM_WRITE =
  /\.from\(\s*(?:(["'`])(?:\\.|(?!\1)[^\\])*\1|[A-Za-z_$][\w$.]*)\s*\)\s*\.\s*(insert|update|upsert|delete)\s*\(/g;

const CODE_RULES = [
  {
    name: 'chained-from-write',
    regex: CHAINED_FROM_WRITE,
    describe: (m) => `direct Supabase .from(...).${m[2]}() write call`,
  },
  {
    name: 'supabase-rpc',
    regex: /\b(?:supabase|client)\s*\.\s*rpc\s*\(/g,
    describe: () => 'direct .rpc() call (counted as a write; route via /api/actions)',
  },
  {
    name: 'storage-from',
    regex: /\.\s*storage\s*\.\s*from\s*\(/g,
    describe: () => 'direct .storage.from() call in client code',
  },
  {
    name: 'functions-invoke',
    regex: /\.\s*functions\s*\.\s*invoke\s*\(/g,
    describe: () => 'direct .functions.invoke() call in client code',
  },
  {
    name: 'postgrest-url',
    regex: /\/rest\/v1\//g,
    describe: () => 'direct PostgREST /rest/v1/ path in client code',
  },
];

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function isTestPath(relPosix) {
  return (
    /(?:^|\/)__tests__\//.test(relPosix) ||
    /(?:^|\/)tests\//.test(relPosix) ||
    /\.(?:test|spec)\.[jt]sx?$/.test(relPosix)
  );
}

function collectCodeFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectCodeFiles(full));
    } else if (entry.isFile() && CODE_EXT.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function checkCodeSource(relPath, source) {
  const rel = toPosix(relPath);
  if (isTestPath(rel)) return [];
  const violations = [];
  for (const rule of CODE_RULES) {
    rule.regex.lastIndex = 0;
    let m;
    while ((m = rule.regex.exec(source)) !== null) {
      const line = lineNumberAt(source, m.index);
      violations.push(`${rel}:${line}: ${rule.describe(m)} — route client mutations through /api/actions (#1450, ADR-100).`);
    }
  }
  return violations;
}

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/--[^\n]*/g, '');
}

const CUTOVER_FILE = /_client_roles_read_only\.sql$/i;
const GRANT_STMT = /\bgrant\s+([^;]+?)\s+on\s+([^;]+?)\s+to\s+([^;]+)/gi;
const WRITE_PRIV = /\b(?:insert|update|delete|truncate|all)\b/i;
const CLIENT_ROLE = /\b(?:anon|authenticated)\b/i;
const NON_TABLE_TARGET =
  /^\s*(?:all\s+)?(?:functions?|procedures?|routines?|schemas?|sequences?|types?|domains?|foreign|language|large|parameter|tablespaces?)\b/i;

function checkMigrationsDir(migrationsDir) {
  if (!migrationsDir || !fs.existsSync(migrationsDir) || !fs.statSync(migrationsDir).isDirectory()) {
    return { error: `migrations directory missing: ${migrationsDir}`, violations: [] };
  }
  const sqlFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => /\.sql$/i.test(f))
    .sort();

  const cutoverIdx = sqlFiles.findIndex((f) => CUTOVER_FILE.test(f));
  if (cutoverIdx === -1) {
    return {
      error: null,
      violations: [
        `${toPosix(migrationsDir)}: missing *_client_roles_read_only.sql cut-over migration (#1450).`,
      ],
    };
  }

  const violations = [];
  for (const file of sqlFiles.slice(cutoverIdx)) {
    const raw = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const stripped = stripSqlComments(raw);
    GRANT_STMT.lastIndex = 0;
    let m;
    while ((m = GRANT_STMT.exec(stripped)) !== null) {
      const [, privs, target, grantees] = m;
      if (!CLIENT_ROLE.test(grantees)) continue;
      if (NON_TABLE_TARGET.test(target)) continue;
      if (!WRITE_PRIV.test(privs)) continue;
      const line = lineNumberAt(stripped, m.index);
      violations.push(
        `${file}:${line}: grants table write privilege (${privs.trim()}) to ${grantees.trim()} after client_roles_read_only cut-over (#1450).`,
      );
    }
  }
  return { error: null, violations };
}

function runCheck({ clientRoots = DEFAULT_CLIENT_ROOTS, migrationsDir = DEFAULT_MIGRATIONS_DIR, repoRoot = REPO_ROOT } = {}) {
  const violations = [];
  for (const root of clientRoots) {
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return { code: 2, violations: [], error: `client root missing: ${root}` };
    }
    const allFiles = collectCodeFiles(root).filter((abs) => !isTestPath(toPosix(path.relative(repoRoot, abs))));
    if (allFiles.length === 0) {
      return { code: 2, violations: [], error: `client root has no non-test code files: ${root}` };
    }
    for (const abs of allFiles) {
      const rel = toPosix(path.relative(repoRoot, abs));
      const src = fs.readFileSync(abs, 'utf8');
      violations.push(...checkCodeSource(rel, src));
    }
  }

  const mig = checkMigrationsDir(migrationsDir);
  if (mig.error) {
    return { code: 2, violations: [], error: mig.error };
  }
  violations.push(...mig.violations);

  return { code: violations.length === 0 ? 0 : 1, violations, error: null };
}

function main(argv = process.argv.slice(2)) {
  void argv;
  const res = runCheck();
  if (res.code === 2) {
    console.error(`client-writes: could not run: ${res.error}`);
    return 2;
  }
  if (res.code !== 0) {
    console.error('client-writes: violations found:');
    for (const v of res.violations) console.error(`  ${v}`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  checkCodeSource,
  checkMigrationsDir,
  runCheck,
  main,
};
