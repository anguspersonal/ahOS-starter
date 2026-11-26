// Detect drift between the three places schema truth lives:
//
//   1. the repo:     supabase/migrations/*.sql               (what we SAY the schema is)
//   2. the history:  supabase_migrations.schema_migrations   (what bookkeeping CLAIMS ran)
//   3. the live DB:  pg_constraint / pg_indexes              (what the schema actually IS)
//
// Three checks:
//
//   A. Remote migration history <-> local supabase/migrations/ files.
//      Every remote history version must have a local `<version>_*.sql` file and
//      vice versa. A remote-only version means DDL was applied outside the repo
//      flow (e.g. the Supabase MCP `apply_migration` tool, which stamps
//      to_char(now(),'YYYYMMDDHH24MISS') — a version no repo file has); a
//      local-only version means a migration was never pushed, or its history row
//      was repaired away. Either way the next `supabase db push` fails or lies.
//
//   B. Live `entities_entity_type_check` constraint <-> the EntityType /
//      GraphEntityType union in @ahkms/shared. Catches constraint edits that
//      never went through the repo (the 2026-07-05 'concept' incident class:
//      history said "up to date" while the live CHECK disagreed with the code).
//      The union is a type-only export (erased at compile time), so this parses
//      packages/shared/src/types/entities.ts directly — no build needed.
//
//   C. Duplicate version prefixes WITHIN supabase/migrations/. Two local files
//      that share the leading timestamp (e.g. two same-day `..._074_*.sql`) each
//      try to stamp the SAME schema_migrations.version: `supabase db push`
//      applies one, commits its version row, then the sibling fails with
//      `duplicate key ... schema_migrations_pkey`. Pure repo-side check (no DB
//      needed) — it caught nothing before, which is why two July-2026 collisions
//      (074, then its 075 reincarnation) reached dev and broke push both times.
//
//      Check C is now ALSO enforced pre-merge, standalone, by
//      check-migration-versions.js (#585) — this script's main() exits 2 on a
//      missing SUPABASE_DB_URL long before reaching it, and the workflow below
//      is schedule-only, so Check C had never once run on a PR. It stays here as
//      the scheduled belt to that pre-merge braces; the standalone guard is the
//      stricter of the two (it also rejects duplicate `_NNN_` sequences and
//      unparseable filenames).
//
// Connects DIRECTLY to Postgres via env SUPABASE_DB_URL (Supabase Dashboard ->
// Settings -> Database -> Connection string, URI format). The supabase_migrations
// schema is NOT exposed via PostgREST, so the supabase-js client used by sibling
// scripts cannot see it — hence the `pg` connection.
//
// READ-ONLY: runs two SELECTs, never writes.
//
// Usage:
//   SUPABASE_DB_URL=postgresql://... node scripts/check-migration-drift.js [--json]
//   or: npm run check:migration-drift -w @ahkms/worker
//
// Exit codes: 0 = no drift; 1 = drift found; 2 = could not run (missing env,
// connection failure, unexpected error).
//
// When this reports drift, see docs/guides/SUPABASE_MIGRATION_HISTORY_RUNBOOK.md
// — in particular: verify the live schema BEFORE running any `migration repair`.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const SHARED_ENTITIES_SOURCE = path.join(REPO_ROOT, 'packages', 'shared', 'src', 'types', 'entities.ts');

const ENTITY_TYPE_CONSTRAINT = 'entities_entity_type_check';

const REQUIRED_SERVER_RPCS = [
  'merge_entities',
  'unmerge_entities',
  'document_duplicate_clusters',
  'discover_envelope_refresh',
  'document_title_candidates',
  'fts_search_artifacts',
  'fts_search_entities',
  'fts_search_people',
  'hybrid_search_artifacts',
  'hybrid_search_entities',
  'hybrid_search_people',
  'search_unconsumed_artifacts',
  'get_dos_evidence_aggregate',
  'get_dos_coverage_days',
  'get_hot_tier_candidates',
];

function parseArgs(argv) {
  const args = { json: false };
  for (const a of argv.slice(2)) {
    if (a === '--json') args.json = true;
  }
  return args;
}

/**
 * '20260705150000_063_add_place_entity_type.sql' -> '20260705150000'.
 * Returns null for filenames that aren't versioned migrations (README, .gitkeep).
 */
function migrationVersionFromFilename(filename) {
  const m = /^(\d+)_.*\.sql$/.exec(filename);
  return m ? m[1] : null;
}

/** Distinct, sorted version prefixes from a migrations-directory file listing. */
function localMigrationVersions(filenames) {
  const versions = new Set();
  for (const f of filenames) {
    const v = migrationVersionFromFilename(f);
    if (v !== null) versions.add(v);
  }
  return [...versions].sort();
}

/**
 * Local migration filenames grouped by version prefix, keeping only groups with
 * more than one file — i.e. same-timestamp collisions. `localMigrationVersions`
 * dedupes these away, so a separate pass is needed to see them at all. Two files
 * sharing a version each try to stamp the same schema_migrations.version, so the
 * second `supabase db push` dies with `duplicate key ... schema_migrations_pkey`.
 *
 * @param {string[]} filenames - file listing of supabase/migrations/
 * @returns {Array<{version: string, files: string[]}>} one entry per colliding
 *   version; `files` sorted, entries sorted by version. Empty when none collide.
 */
function duplicateLocalMigrationVersions(filenames) {
  const byVersion = new Map();
  for (const f of filenames) {
    const v = migrationVersionFromFilename(f);
    if (v === null) continue;
    if (!byVersion.has(v)) byVersion.set(v, []);
    byVersion.get(v).push(f);
  }
  return [...byVersion.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([version, files]) => ({ version, files: [...files].sort() }))
    .sort((a, b) => a.version.localeCompare(b.version));
}

/** Set difference in both directions, sorted for stable output. */
function diffSets(aList, bList) {
  const a = new Set(aList);
  const b = new Set(bList);
  return {
    onlyInA: [...a].filter((x) => !b.has(x)).sort(),
    onlyInB: [...b].filter((x) => !a.has(x)).sort(),
  };
}

/**
 * Extract the quoted values from a pg_get_constraintdef() CHECK definition, e.g.
 *   CHECK ((entity_type = ANY (ARRAY['project'::text, 'area'::text])))
 * Falls back to scanning every single-quoted literal when no ARRAY[...] is
 * present (covers `IN (...)`-style definitions). Postgres escapes a quote
 * inside a literal as '' — unescaped here.
 */
function parseCheckConstraintValues(constraintDef) {
  if (typeof constraintDef !== 'string' || constraintDef.length === 0) return [];
  const arrayMatch = constraintDef.match(/ARRAY\s*\[([\s\S]*?)\]/);
  const region = arrayMatch ? arrayMatch[1] : constraintDef;
  const values = [];
  const literal = /'((?:[^']|'')*)'/g;
  let m;
  while ((m = literal.exec(region)) !== null) {
    values.push(m[1].replace(/''/g, "'"));
  }
  return values;
}

/** Strip // and block comments so union parsing isn't confused by prose. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The `...` of `export type <typeName> = ...;`, or null when absent. */
function extractTypeAliasBody(source, typeName) {
  const re = new RegExp(`export\\s+type\\s+${typeName}\\s*=([^;]*);`);
  const m = source.match(re);
  return m ? m[1] : null;
}

/**
 * Resolve the string-literal members of an exported union type in a .ts source,
 * following references to other union aliases in the same file (GraphEntityType
 * includes EntityType by reference). Type-only exports are erased at runtime,
 * so reading the source is the only way to compare them against the live DB.
 * Non-literal, non-identifier members (object types, generics) are ignored.
 */
function resolveUnionValues(source, typeName, seen = new Set()) {
  if (seen.has(typeName)) return [];
  seen.add(typeName);
  const body = extractTypeAliasBody(source, typeName);
  if (body === null) {
    throw new Error(`export type ${typeName} not found in shared entities source`);
  }
  const values = [];
  for (const member of stripComments(body).split('|')) {
    const part = member.trim();
    if (!part) continue;
    const quoted = /^['"]([^'"]*)['"]$/.exec(part);
    if (quoted) {
      values.push(quoted[1]);
    } else if (/^[A-Za-z_$][\w$]*$/.test(part)) {
      values.push(...resolveUnionValues(source, part, seen));
    }
  }
  return [...new Set(values)];
}

/**
 * Pure core: compare the three inputs and shape the drift result. No I/O — easy
 * to unit-test with fixtures.
 *
 * @param {object} inputs
 * @param {string[]} inputs.remoteVersions - supabase_migrations.schema_migrations.version values
 * @param {string[]} inputs.localFilenames - file listing of supabase/migrations/
 * @param {string|null} inputs.constraintDef - pg_get_constraintdef output for
 *   entities_entity_type_check, or null when the constraint doesn't exist
 * @param {string} inputs.sharedSource - contents of packages/shared/src/types/entities.ts
 * @param {string[]} [inputs.remoteProcs] - live public functions from pg_proc
 */
function buildResult({ remoteVersions, localFilenames, constraintDef, sharedSource, remoteProcs }) {
  const localVersions = localMigrationVersions(localFilenames);
  const historyDiff = diffSets(remoteVersions, localVersions);
  const migrationHistory = {
    ok: historyDiff.onlyInA.length === 0 && historyDiff.onlyInB.length === 0,
    remoteCount: new Set(remoteVersions).size,
    localCount: localVersions.length,
    remoteOnly: historyDiff.onlyInA,
    localOnly: historyDiff.onlyInB,
  };

  const sharedValues = resolveUnionValues(sharedSource, 'GraphEntityType');
  const constraintValues = constraintDef === null ? [] : parseCheckConstraintValues(constraintDef);
  const entityDiff = diffSets(constraintValues, sharedValues);
  const entityTypeCheck = {
    ok: constraintDef !== null && entityDiff.onlyInA.length === 0 && entityDiff.onlyInB.length === 0,
    constraintFound: constraintDef !== null,
    constraintValues: [...constraintValues].sort(),
    sharedValues: [...sharedValues].sort(),
    constraintOnly: entityDiff.onlyInA,
    sharedOnly: entityDiff.onlyInB,
  };

  const collisions = duplicateLocalMigrationVersions(localFilenames);
  const duplicateVersions = {
    ok: collisions.length === 0,
    collisions,
  };

  let serverRpcs = { ok: true, missing: [], required: REQUIRED_SERVER_RPCS };
  if (Array.isArray(remoteProcs)) {
    const liveProcSet = new Set(remoteProcs);
    const missing = REQUIRED_SERVER_RPCS.filter((rpc) => !liveProcSet.has(rpc));
    serverRpcs = {
      ok: missing.length === 0,
      missing,
      required: REQUIRED_SERVER_RPCS,
    };
  }

  return {
    ok: migrationHistory.ok && entityTypeCheck.ok && duplicateVersions.ok && serverRpcs.ok,
    checks: { migrationHistory, entityTypeCheck, duplicateVersions, serverRpcs },
  };
}

/** Human-readable report lines for a buildResult() result. Pure. */
function formatReport(result) {
  const lines = [];
  const h = result.checks.migrationHistory;
  const e = result.checks.entityTypeCheck;
  const d = result.checks.duplicateVersions;
  const s = result.checks.serverRpcs;

  lines.push('Check A — remote migration history vs supabase/migrations/');
  if (h.ok) {
    lines.push(`  OK: ${h.remoteCount} remote version(s) and ${h.localCount} local file version(s) match 1:1.`);
  } else {
    for (const v of h.remoteOnly) {
      lines.push(
        `  DRIFT: remote history has ${v} but no supabase/migrations/${v}_*.sql exists ` +
        '— DDL was applied outside the repo flow (apply_migration?).'
      );
    }
    for (const v of h.localOnly) {
      lines.push(
        `  DRIFT: local migration version ${v} is not in remote history ` +
        '— never pushed, or its history row was repaired away.'
      );
    }
  }

  lines.push('');
  lines.push(`Check B — live ${ENTITY_TYPE_CONSTRAINT} vs @ahkms/shared GraphEntityType`);
  if (!e.constraintFound) {
    lines.push(`  DRIFT: constraint ${ENTITY_TYPE_CONSTRAINT} not found on public.entities.`);
  } else if (e.ok) {
    lines.push(`  OK: constraint and shared union agree on ${e.sharedValues.length} entity type(s).`);
  } else {
    for (const v of e.constraintOnly) {
      lines.push(
        `  DRIFT: '${v}' is accepted by the live constraint but missing from GraphEntityType in @ahkms/shared.`
      );
    }
    for (const v of e.sharedOnly) {
      lines.push(`  DRIFT: '${v}' is in GraphEntityType but the live constraint rejects it.`);
    }
  }

  lines.push('');
  lines.push('Check C — no duplicate version prefixes in supabase/migrations/');
  if (d.ok) {
    lines.push('  OK: every local migration file has a unique version prefix.');
  } else {
    for (const c of d.collisions) {
      lines.push(
        `  DRIFT: version ${c.version} is shared by ${c.files.length} files ` +
        `(${c.files.join(', ')}) — the second \`supabase db push\` will fail with ` +
        '`duplicate key ... schema_migrations_pkey`. Renumber one off the shared timestamp.'
      );
    }
  }

  if (s) {
    lines.push('');
    lines.push('Check D — server-called RPC functions vs live database');
    if (s.ok) {
      lines.push(`  OK: all ${s.required.length} server RPC function(s) exist in the live DB.`);
    } else {
      for (const rpc of s.missing) {
        lines.push(
          `  DRIFT: the server calls RPC "${rpc}" but the live DB does not have it ` +
          '— pending migration has not been pushed via `supabase db push`.'
        );
      }
    }
  }

  lines.push('');
  lines.push(
    result.ok
      ? 'No drift: repo migrations, remote history, entity-type constraint, and server RPCs agree.'
      : 'Drift detected — see docs/guides/SUPABASE_MIGRATION_HISTORY_RUNBOOK.md before running any `migration repair`.'
  );
  return lines;
}

/** Fetch history versions + the live constraint definition. The only I/O with the DB. */
async function fetchRemoteState(dbUrl) {
  // Lazy require: the missing-env path and the unit tests never load pg.
  const { Client } = require('pg');
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const versions = await client.query(
      'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version'
    );
    const constraint = await client.query(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'public.entities'::regclass
          AND conname = $1`,
      [ENTITY_TYPE_CONSTRAINT]
    );
    const procs = await client.query(
      `SELECT proname
         FROM pg_proc
         JOIN pg_namespace ON pg_proc.pronamespace = pg_namespace.oid
        WHERE nspname = 'public'`
    );
    return {
      remoteVersions: versions.rows.map((r) => String(r.version)),
      constraintDef: constraint.rows.length > 0 ? constraint.rows[0].def : null,
      remoteProcs: procs.rows.map((r) => String(r.proname)),
    };
  } finally {
    await client.end();
  }
}

async function main() {
  const args = parseArgs(process.argv);

  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.error('SUPABASE_DB_URL is not set.');
    console.error('');
    console.error('This check reads supabase_migrations.schema_migrations, which is NOT exposed');
    console.error('via PostgREST/supabase-js — it needs a direct Postgres connection string.');
    console.error('Supabase Dashboard -> Settings -> Database -> Connection string (URI), e.g.');
    console.error('  export SUPABASE_DB_URL="postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres"');
    process.exit(2);
  }

  const localFilenames = fs.readdirSync(MIGRATIONS_DIR);
  const sharedSource = fs.readFileSync(SHARED_ENTITIES_SOURCE, 'utf-8');
  const { remoteVersions, constraintDef, remoteProcs } = await fetchRemoteState(dbUrl);

  const result = buildResult({ remoteVersions, localFilenames, constraintDef, sharedSource, remoteProcs });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const line of formatReport(result)) console.log(line);
  }
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`check-migration-drift failed to run: ${err.message}`);
    process.exit(2);
  });
}

module.exports = {
  parseArgs,
  migrationVersionFromFilename,
  localMigrationVersions,
  duplicateLocalMigrationVersions,
  diffSets,
  parseCheckConstraintValues,
  stripComments,
  extractTypeAliasBody,
  resolveUnionValues,
  buildResult,
  formatReport,
  ENTITY_TYPE_CONSTRAINT,
  REQUIRED_SERVER_RPCS,
  MIGRATIONS_DIR,
  SHARED_ENTITIES_SOURCE,
};
