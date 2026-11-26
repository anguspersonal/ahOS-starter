/**
 * Unit tests for the migration-drift detector's pure logic.
 *
 * The script itself is plain CommonJS (matches sibling worker scripts, e.g.
 * export-golden-extractions.js), so it's required directly rather than
 * imported. Only the pure functions (no Postgres I/O) are exercised here — no
 * SUPABASE_DB_URL is needed and `pg` is never loaded (the script requires it
 * lazily inside the fetch path).
 */

// Makes this a module rather than a global script, so its top-level `const`s
// cannot collide with a sibling script test destructuring the same names — see
// the note in check-migration-versions.test.ts.
export {};

const fs = require('fs');

const {
	migrationVersionFromFilename,
	localMigrationVersions,
	duplicateLocalMigrationVersions,
	diffSets,
	parseCheckConstraintValues,
	resolveUnionValues,
	buildResult,
	formatReport,
	SHARED_ENTITIES_SOURCE,
	REQUIRED_SERVER_RPCS,
} = require('../../../scripts/check-migration-drift');

describe('migrationVersionFromFilename', () => {
	it('extracts the version prefix from a numbered migration', () => {
		expect(migrationVersionFromFilename('20260705150000_063_add_place_entity_type.sql')).toBe('20260705150000');
	});

	it('extracts the version prefix from a remote_schema-style file', () => {
		expect(migrationVersionFromFilename('20251226182232_remote_schema.sql')).toBe('20251226182232');
	});

	it('returns null for non-migration files', () => {
		expect(migrationVersionFromFilename('README.md')).toBeNull();
		expect(migrationVersionFromFilename('.gitkeep')).toBeNull();
		expect(migrationVersionFromFilename('helpers.sql')).toBeNull();
	});
});

describe('localMigrationVersions', () => {
	it('collects sorted unique versions and skips non-migrations', () => {
		const files = [
			'20260705150000_063_add_place_entity_type.sql',
			'20260610203913_entity_relationships_graph_edges.sql',
			'20250115120000_032_add_artifacts_user_created_at_index.sql',
			'README.md',
		];
		expect(localMigrationVersions(files)).toEqual([
			'20250115120000',
			'20260610203913',
			'20260705150000',
		]);
	});

	it('dedupes files sharing a version prefix', () => {
		expect(
			localMigrationVersions(['20260101000000_a.sql', '20260101000000_b.sql'])
		).toEqual(['20260101000000']);
	});

	it('returns an empty list for an empty directory', () => {
		expect(localMigrationVersions([])).toEqual([]);
	});
});

describe('duplicateLocalMigrationVersions', () => {
	it('returns nothing when every version prefix is unique', () => {
		expect(
			duplicateLocalMigrationVersions([
				'20260101000000_a.sql',
				'20260102000000_b.sql',
				'README.md',
			])
		).toEqual([]);
	});

	it('flags the original 074 collision that reached dev', () => {
		// Both stamp version 20260713130000; the second `supabase db push` dies
		// with duplicate key ... schema_migrations_pkey.
		expect(
			duplicateLocalMigrationVersions([
				'20260713130000_074_add_capability_entity_type.sql',
				'20260713130000_074_bindings_and_domain_entity_type.sql',
			])
		).toEqual([
			{
				version: '20260713130000',
				files: [
					'20260713130000_074_add_capability_entity_type.sql',
					'20260713130000_074_bindings_and_domain_entity_type.sql',
				],
			},
		]);
	});

	it('reports colliding files sorted, and version groups sorted', () => {
		const collisions = duplicateLocalMigrationVersions([
			'20260713140000_075_reconcile_entity_type_check_collision.sql',
			'20260713130000_074_bindings_and_domain_entity_type.sql',
			'20260713140000_075_bindings_and_domain_entity_type.sql',
			'20260713130000_074_add_capability_entity_type.sql',
			'20260101000000_unique.sql',
		]);
		expect(collisions).toEqual([
			{
				version: '20260713130000',
				files: [
					'20260713130000_074_add_capability_entity_type.sql',
					'20260713130000_074_bindings_and_domain_entity_type.sql',
				],
			},
			{
				version: '20260713140000',
				files: [
					'20260713140000_075_bindings_and_domain_entity_type.sql',
					'20260713140000_075_reconcile_entity_type_check_collision.sql',
				],
			},
		]);
	});

	it('ignores non-migration files sharing no version', () => {
		expect(duplicateLocalMigrationVersions(['README.md', '.gitkeep'])).toEqual([]);
	});
});

describe('diffSets', () => {
	it('reports strays in both directions, sorted', () => {
		const diff = diffSets(['b', 'a', 'shared'], ['shared', 'z', 'c']);
		expect(diff).toEqual({ onlyInA: ['a', 'b'], onlyInB: ['c', 'z'] });
	});

	it('returns empty diffs for identical sets', () => {
		expect(diffSets(['x', 'y'], ['y', 'x'])).toEqual({ onlyInA: [], onlyInB: [] });
	});

	it('handles empty inputs', () => {
		expect(diffSets([], ['a'])).toEqual({ onlyInA: [], onlyInB: ['a'] });
		expect(diffSets(['a'], [])).toEqual({ onlyInA: ['a'], onlyInB: [] });
	});
});

describe('parseCheckConstraintValues', () => {
	it('parses the canonical pg_get_constraintdef ARRAY form', () => {
		const def =
			"CHECK ((entity_type = ANY (ARRAY['project'::text, 'area'::text, 'place'::text])))";
		expect(parseCheckConstraintValues(def)).toEqual(['project', 'area', 'place']);
	});

	it('parses the full 11-type constraint from migration 063', () => {
		const def =
			"CHECK ((entity_type = ANY (ARRAY['project'::text, 'area'::text, 'resource'::text, " +
			"'memory'::text, 'people'::text, 'secure'::text, 'archive'::text, 'event'::text, " +
			"'organization'::text, 'signal'::text, 'place'::text])))";
		expect(parseCheckConstraintValues(def)).toHaveLength(11);
		expect(parseCheckConstraintValues(def)).toContain('place');
		expect(parseCheckConstraintValues(def)).not.toContain('concept');
	});

	it('parses values without ::text casts', () => {
		expect(parseCheckConstraintValues("CHECK ((x = ANY (ARRAY['a', 'b'])))")).toEqual(['a', 'b']);
	});

	it('falls back to scanning literals for IN-style definitions', () => {
		expect(parseCheckConstraintValues("CHECK (entity_type IN ('a', 'b'))")).toEqual(['a', 'b']);
	});

	it("unescapes doubled quotes ('') inside literals", () => {
		expect(parseCheckConstraintValues("CHECK ((x = ANY (ARRAY['it''s'::text])))")).toEqual(["it's"]);
	});

	it('returns an empty list for empty or non-string input', () => {
		expect(parseCheckConstraintValues('')).toEqual([]);
		expect(parseCheckConstraintValues(null)).toEqual([]);
		expect(parseCheckConstraintValues(undefined)).toEqual([]);
	});
});

describe('resolveUnionValues', () => {
	const fixtureSource = `
		/** The closed CRUD set. */
		export type EntityType =
			| 'project'
			| 'area' // trailing comment
			| 'people';

		/**
		 * Everything the CHECK accepts: EntityType plus graph-only types.
		 */
		export type GraphEntityType =
			| EntityType
			| 'event'
			| 'place';
	`;

	it('resolves literal members of a direct union', () => {
		expect(resolveUnionValues(fixtureSource, 'EntityType')).toEqual(['project', 'area', 'people']);
	});

	it('follows references to other union aliases', () => {
		expect(resolveUnionValues(fixtureSource, 'GraphEntityType')).toEqual([
			'project',
			'area',
			'people',
			'event',
			'place',
		]);
	});

	it('throws when the type alias is not found', () => {
		expect(() => resolveUnionValues(fixtureSource, 'MissingType')).toThrow(/MissingType not found/);
	});

	it('does not loop on circular references', () => {
		const circular = `
			export type A = B | 'a';
			export type B = A | 'b';
		`;
		expect(resolveUnionValues(circular, 'A')).toEqual(['b', 'a']);
	});

	it('parses a single-line union', () => {
		expect(resolveUnionValues("export type T = 'x' | 'y';", 'T')).toEqual(['x', 'y']);
	});
});

describe('sync guard: the REAL @ahkms/shared GraphEntityType parses to the known 14 types', () => {
	// This is the load-bearing test: if someone edits the union in
	// packages/shared/src/types/entities.ts (add/remove a type, or reformat it
	// in a way the parser can't read), this fails in CI — the same PR must then
	// update this expectation AND ship the matching entities_entity_type_check
	// migration. Kept-in-sync-by-hand, but now with a tripwire.
	it('resolves GraphEntityType from the actual shared source', () => {
		const source = fs.readFileSync(SHARED_ENTITIES_SOURCE, 'utf-8');
		const values = resolveUnionValues(source, 'GraphEntityType');
		expect([...values].sort()).toEqual([
			'area',
			'arrangement', // #327 — ADR-035 reified n-ary/repeated fact node (migration 079)
			'capability', // #63 — the skill/agent/command registry (migration 074/075)
			'concept',
			'decision', // #2003 — first-class decision entity (migration 146)
			'domain', // #62 — the binding-layer scope axis (migration 074/075)
			'event',
			'organization',
			'people',
			'place',
			'project',
			'resource',
			'signal',
			'term', // #1023 — ADR-092 acronyms and internal shorthand (migration 110)
		]);
	});
});

describe('buildResult + formatReport', () => {
	const SHARED_FIXTURE = `
		export type EntityType = 'project' | 'people';
		export type GraphEntityType = EntityType | 'place';
	`;
	const CONSTRAINT_OK =
		"CHECK ((entity_type = ANY (ARRAY['project'::text, 'people'::text, 'place'::text])))";

	it('reports ok when history and constraint both match', () => {
		const result = buildResult({
			remoteVersions: ['20260101000000', '20260102000000'],
			localFilenames: ['20260101000000_one.sql', '20260102000000_two.sql', 'README.md'],
			constraintDef: CONSTRAINT_OK,
			sharedSource: SHARED_FIXTURE,
		});
		expect(result.ok).toBe(true);
		expect(result.checks.migrationHistory).toMatchObject({
			ok: true,
			remoteCount: 2,
			localCount: 2,
			remoteOnly: [],
			localOnly: [],
		});
		expect(result.checks.entityTypeCheck).toMatchObject({ ok: true, constraintFound: true });

		const report = formatReport(result).join('\n');
		expect(report).toContain('OK: 2 remote version(s)');
		expect(report).toContain('No drift');
	});

	it('flags the pre-repair incident shape: an apply_migration version with no repo file', () => {
		// 2026-07-05, 19:24 UTC: apply_migration stamped 20260705192428; the repo
		// only has 20260705150000_063. db push then fails against the stray row.
		const result = buildResult({
			remoteVersions: ['20260705150000', '20260705192428'],
			localFilenames: ['20260705150000_063_add_place_entity_type.sql'],
			constraintDef: CONSTRAINT_OK,
			sharedSource: SHARED_FIXTURE,
		});
		expect(result.ok).toBe(false);
		expect(result.checks.migrationHistory.remoteOnly).toEqual(['20260705192428']);
		expect(result.checks.migrationHistory.localOnly).toEqual([]);

		const report = formatReport(result).join('\n');
		expect(report).toContain('20260705192428');
		expect(report).toContain('outside the repo flow');
		expect(report).toContain('SUPABASE_MIGRATION_HISTORY_RUNBOOK');
	});

	it('flags the post-repair incident shape: history clean but constraint drifted', () => {
		// After the blind repairs, history matched the repo ("Remote database is
		// up to date") while the LIVE constraint still accepted 'concept' and
		// lacked 'place'. Check A passes; Check B is what catches it.
		const constraintDrifted =
			"CHECK ((entity_type = ANY (ARRAY['project'::text, 'people'::text, 'concept'::text])))";
		const result = buildResult({
			remoteVersions: ['20260705150000'],
			localFilenames: ['20260705150000_063_add_place_entity_type.sql'],
			constraintDef: constraintDrifted,
			sharedSource: SHARED_FIXTURE,
		});
		expect(result.ok).toBe(false);
		expect(result.checks.migrationHistory.ok).toBe(true);
		expect(result.checks.entityTypeCheck.constraintOnly).toEqual(['concept']);
		expect(result.checks.entityTypeCheck.sharedOnly).toEqual(['place']);

		const report = formatReport(result).join('\n');
		expect(report).toContain("'concept' is accepted by the live constraint");
		expect(report).toContain("'place' is in GraphEntityType but the live constraint rejects it");
	});

	it('flags a local migration missing from remote history', () => {
		const result = buildResult({
			remoteVersions: [],
			localFilenames: ['20260101000000_one.sql'],
			constraintDef: CONSTRAINT_OK,
			sharedSource: SHARED_FIXTURE,
		});
		expect(result.ok).toBe(false);
		expect(result.checks.migrationHistory.localOnly).toEqual(['20260101000000']);
		expect(formatReport(result).join('\n')).toContain('not in remote history');
	});

	it('treats a missing constraint as drift', () => {
		const result = buildResult({
			remoteVersions: [],
			localFilenames: [],
			constraintDef: null,
			sharedSource: SHARED_FIXTURE,
		});
		expect(result.ok).toBe(false);
		expect(result.checks.entityTypeCheck.constraintFound).toBe(false);
		expect(formatReport(result).join('\n')).toContain('not found on public.entities');
	});

	it('reports duplicateVersions.ok when every prefix is unique', () => {
		const result = buildResult({
			remoteVersions: ['20260101000000', '20260102000000'],
			localFilenames: ['20260101000000_one.sql', '20260102000000_two.sql', 'README.md'],
			constraintDef: CONSTRAINT_OK,
			sharedSource: SHARED_FIXTURE,
		});
		expect(result.checks.duplicateVersions).toEqual({ ok: true, collisions: [] });
		expect(formatReport(result).join('\n')).toContain('every local migration file has a unique version prefix');
	});

	it('flags the same-timestamp collision shape: two files share a version prefix', () => {
		// The 074 incident: two files stamp 20260713130000. History (Check A) can
		// still look clean — localMigrationVersions collapses the pair to one
		// version — so Check C is what catches it before `db push` fails.
		const result = buildResult({
			remoteVersions: ['20260713130000'],
			localFilenames: [
				'20260713130000_074_add_capability_entity_type.sql',
				'20260713130000_074_bindings_and_domain_entity_type.sql',
			],
			constraintDef: CONSTRAINT_OK,
			sharedSource: SHARED_FIXTURE,
		});
		expect(result.ok).toBe(false);
		expect(result.checks.migrationHistory.ok).toBe(true);
		expect(result.checks.duplicateVersions.ok).toBe(false);
		expect(result.checks.duplicateVersions.collisions).toEqual([
			{
				version: '20260713130000',
				files: [
					'20260713130000_074_add_capability_entity_type.sql',
					'20260713130000_074_bindings_and_domain_entity_type.sql',
				],
			},
		]);

		const report = formatReport(result).join('\n');
		expect(report).toContain('version 20260713130000 is shared by 2 files');
		expect(report).toContain('schema_migrations_pkey');
	});

	it('reports ok when all required server RPCs exist in remoteProcs', () => {
		const result = buildResult({
			remoteVersions: ['20260101000000'],
			localFilenames: ['20260101000000_one.sql'],
			constraintDef: CONSTRAINT_OK,
			sharedSource: SHARED_FIXTURE,
			remoteProcs: [...REQUIRED_SERVER_RPCS, 'unrelated_function'],
		});
		expect(result.ok).toBe(true);
		expect(result.checks.serverRpcs).toEqual({
			ok: true,
			missing: [],
			required: REQUIRED_SERVER_RPCS,
		});
		expect(formatReport(result).join('\n')).toContain(
			`OK: all ${REQUIRED_SERVER_RPCS.length} server RPC function(s) exist in the live DB.`
		);
	});

	it('requires get_dos_coverage_days, so a pending migration 158 push is reported (#2264)', () => {
		expect(REQUIRED_SERVER_RPCS).toContain('get_dos_coverage_days');

		const result = buildResult({
			remoteVersions: ['20260101000000'],
			localFilenames: ['20260101000000_one.sql'],
			constraintDef: CONSTRAINT_OK,
			sharedSource: SHARED_FIXTURE,
			remoteProcs: REQUIRED_SERVER_RPCS.filter((r: string) => r !== 'get_dos_coverage_days'),
		});
		expect(result.ok).toBe(false);
		expect(result.checks.serverRpcs.missing).toEqual(['get_dos_coverage_days']);
	});

	it('flags drift when server calls an RPC that live DB lacks (e.g. merge_entities, issue #1367)', () => {
		const procsWithoutMerge = REQUIRED_SERVER_RPCS.filter(
			(r: string) => r !== 'merge_entities' && r !== 'unmerge_entities'
		);
		const result = buildResult({
			remoteVersions: ['20260101000000'],
			localFilenames: ['20260101000000_one.sql'],
			constraintDef: CONSTRAINT_OK,
			sharedSource: SHARED_FIXTURE,
			remoteProcs: procsWithoutMerge,
		});
		expect(result.ok).toBe(false);
		expect(result.checks.serverRpcs.ok).toBe(false);
		expect(result.checks.serverRpcs.missing).toEqual(['merge_entities', 'unmerge_entities']);

		const report = formatReport(result).join('\n');
		expect(report).toContain('DRIFT: the server calls RPC "merge_entities" but the live DB does not have it');
		expect(report).toContain('DRIFT: the server calls RPC "unmerge_entities" but the live DB does not have it');
		expect(report).toContain('Drift detected');
	});
});
