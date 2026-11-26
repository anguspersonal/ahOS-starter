/**
 * Unit tests for the migration filename guard (#585).
 *
 * The script is plain CommonJS with no build step (matches its siblings, e.g.
 * check-migration-drift.js), so it is required directly rather than imported.
 * Every test drives the PURE core with synthetic filenames — nothing here reads
 * supabase/migrations/, on purpose: a worker test reading a repo-root directory
 * is outside this package's turbo cache key, so a real-tree assertion could go
 * on passing from cache after the tree changed. The real tree is asserted live
 * by the pr-guards.yml step that runs the script itself.
 *
 * Three pins the guard exists for:
 *   1. Two files with the SAME timestamp fail — the collision that breaks
 *      `supabase db push` (#582 / #583, the third occurrence).
 *   2. Two files with DIFFERENT timestamps but the SAME sequence fail — the
 *      parallel-branch race that produces case 1, and the earlier signal.
 *   3. Grandfathering forgives a legacy PAIR but never a new file joining it,
 *      and an exemption whose file is gone fails rather than silently covering
 *      nothing.
 */

// A .ts file with no import/export is a global SCRIPT to TypeScript, so its
// top-level `const`s collide with every sibling script test that destructures
// the same names (`buildResult`, `formatReport`, …). ts-jest only sees it when
// both files land in one program, which depends on worker sharding — green
// locally, TS2451 in CI. This makes the file a module; keep it.
export {};

const {
	isCalendarTimestamp,
	parseMigrationFilename,
	duplicateGroups,
	buildResult,
	formatReport,
	annotate,
	PRE_CONVENTION_FILES,
	GRANDFATHERED_SEQUENCE_COLLISIONS,
	MONOTONICITY_CUTOFF,
} = require('../../../scripts/check-migration-versions');

type Violation = { kind: string; [key: string]: unknown };
type Result = { ok: boolean; violations: Violation[]; counts: Record<string, number>; grandfathered: { preConvention: string[]; sequences: string[] } };

/** No grandfathering unless a test asks for it — keeps fixtures independent of real history. */
const check = (filenames: string[], exemptions: Record<string, Set<string>> = {}): Result =>
	buildResult({
		filenames,
		preConventionFiles: new Set<string>(),
		grandfatheredSequences: new Set<string>(),
		...exemptions,
	});

const kinds = (result: Result) => result.violations.map((violation) => violation.kind);

const VALID_SET = [
	'20260805120000_081_term_node_row_shape_graph_terms_view.sql',
	'20260807120000_083_backfill_discover_surface.sql',
	'20260810120000_086_rename_dos_hl_config_priorities_to_pillars.sql',
];

describe('parseMigrationFilename', () => {
	it('splits a conventional name into version, sequence and slug', () => {
		expect(parseMigrationFilename('20260807130000_084_alert_condition_state_and_cadence.sql')).toEqual({
			kind: 'migration',
			filename: '20260807130000_084_alert_condition_state_and_cadence.sql',
			version: '20260807130000',
			sequence: '084',
			slug: 'alert_condition_state_and_cadence',
		});
	});

	it('ignores entries that are not .sql', () => {
		for (const name of ['README.md', '.gitkeep', '20260101120000_091_notes.sql.bak']) {
			expect(parseMigrationFilename(name)).toEqual({ kind: 'ignored', filename: name });
		}
	});

	it.each([
		['no version prefix', 'add_column.sql', 'does not start with a 14-digit YYYYMMDDHHMMSS version'],
		['a 13-digit version', '2026080713000_084_thing.sql', 'does not start with a 14-digit YYYYMMDDHHMMSS version'],
		['no sequence', '20251226182232_remote_schema.sql', 'has no 3-digit sequence number between the version and the slug'],
		['a 2-digit sequence', '20260807130000_84_thing.sql', 'has no 3-digit sequence number between the version and the slug'],
		['an uppercase slug', '20260807130000_084_Thing.sql', 'slug must be lower_snake_case (a-z, 0-9, single underscores)'],
		['a doubled underscore', '20260807130000_084_a__b.sql', 'slug must be lower_snake_case (a-z, 0-9, single underscores)'],
		['an uppercase extension', '20260807130000_084_thing.SQL', 'slug must be lower_snake_case (a-z, 0-9, single underscores)'],
		['an impossible date', '20260231120000_084_thing.sql', 'version 20260231120000 is not a real UTC timestamp'],
	])('reports %s as malformed', (_label, filename, reason) => {
		expect(parseMigrationFilename(filename)).toMatchObject({ kind: 'malformed', filename, reason });
	});

	it('keeps the version of a malformed name so it still contests version uniqueness', () => {
		expect(parseMigrationFilename('20251226182232_remote_schema.sql')).toMatchObject({
			kind: 'malformed',
			version: '20251226182232',
		});
		expect(parseMigrationFilename('add_column.sql')).toMatchObject({ kind: 'malformed', version: null });
	});
});

describe('isCalendarTimestamp', () => {
	it.each(['20260807130000', '20240229120000', '20251231235959'])('accepts %s', (version) => {
		expect(isCalendarTimestamp(version)).toBe(true);
	});

	it.each(['20261307130000', '20260231120000', '20250229120000', '20260807240000', '20260807136000'])(
		'rejects %s',
		(version) => {
			expect(isCalendarTimestamp(version)).toBe(false);
		}
	);
});

describe('duplicateGroups', () => {
	it('returns only keys held by more than one file, sorted', () => {
		const entries = [
			{ filename: 'b.sql', key: '091' },
			{ filename: 'a.sql', key: '091' },
			{ filename: 'c.sql', key: '092' },
			{ filename: 'd.sql', key: '090' },
			{ filename: 'e.sql', key: '090' },
		];
		expect(duplicateGroups(entries, (entry: { key: string }) => entry.key)).toEqual([
			{ key: '090', files: ['d.sql', 'e.sql'] },
			{ key: '091', files: ['a.sql', 'b.sql'] },
		]);
	});

	it('skips entries with a null key', () => {
		expect(
			duplicateGroups(
				[
					{ filename: 'a.sql', key: null },
					{ filename: 'b.sql', key: null },
				],
				(entry: { key: string | null }) => entry.key
			)
		).toEqual([]);
	});
});

describe('a valid set', () => {
	it('passes with no violations', () => {
		const result = check(VALID_SET);
		expect(result.ok).toBe(true);
		expect(result.violations).toEqual([]);
		expect(result.counts).toEqual({ entries: 3, migrations: 3, ignored: 0 });
	});

	it('is unaffected by a non-.sql file sitting in the directory', () => {
		const result = check([...VALID_SET, 'README.md', '.gitkeep']);
		expect(result.ok).toBe(true);
		expect(result.counts).toEqual({ entries: 5, migrations: 3, ignored: 2 });
		expect(formatReport(result)).toContain('  Ignored 2 non-.sql entries.');
	});

	it('reports the migration count, not the entry count, on success', () => {
		expect(formatReport(check(VALID_SET))[1]).toBe(
			'  OK: 3 migration file(s); every version and sequence is unique.'
		);
	});
});

describe('duplicate timestamp — the collision that breaks `supabase db push`', () => {
	// The real 2026-08-07 shape: PR #582 and PR #583 each minted
	// 20260807120000 in its own branch, so neither could see the other.
	const COLLIDING = [
		'20260807120000_083_backfill_discover_surface.sql',
		'20260807120000_084_alert_condition_state_and_cadence.sql',
	];

	it('fails and names both files', () => {
		const result = check(COLLIDING);
		expect(result.ok).toBe(false);
		expect(result.violations).toEqual([
			{ kind: 'duplicate-version', version: '20260807120000', files: COLLIDING },
		]);
	});

	it('explains the schema_migrations_pkey failure and which file to re-stamp', () => {
		const report = formatReport(check(COLLIDING)).join('\n');
		expect(report).toContain('COLLISION: version 20260807120000 is claimed by 2 files');
		expect(report).toContain('schema_migrations_pkey');
		expect(report).toContain('Give the UNMERGED file a new');
	});

	it('catches a pre-convention file colliding with a numbered one', () => {
		const result = check(['20251226182232_remote_schema.sql', '20251226182232_091_new_thing.sql'], {
			preConventionFiles: new Set(['20251226182232_remote_schema.sql']),
		});
		expect(kinds(result)).toEqual(['duplicate-version']);
	});

	it('is never grandfathered — a duplicate version is not survivable', () => {
		const files = ['20260807120000_083_a.sql', '20260807120000_084_b.sql'];
		const result = buildResult({
			filenames: files,
			preConventionFiles: new Set<string>(),
			grandfatheredSequences: new Set(files),
		});
		expect(kinds(result)).toEqual(['duplicate-version']);
	});
});

describe('duplicate sequence — the parallel-branch race', () => {
	// Two branches both minted "the next" number off 090. Different timestamps,
	// so `db push` would survive; the repo's own naming would not.
	const RACED = ['20260822120000_091_a.sql', '20260822130000_091_b.sql'];

	it('fails even though the timestamps differ', () => {
		const result = check(RACED);
		expect(result.ok).toBe(false);
		expect(result.violations).toEqual([
			{ kind: 'duplicate-sequence', sequence: '091', files: RACED },
		]);
	});

	it('tells the author to renumber the unmerged file', () => {
		const report = formatReport(check(RACED)).join('\n');
		expect(report).toContain('COLLISION: sequence 091 is claimed by 2 files');
		expect(report).toContain('Renumber the');
		expect(report).toContain('UNMERGED file to the next free sequence');
	});

	it('reports a three-way collision as one group', () => {
		const result = check([...RACED, '20260822140000_091_c.sql']);
		expect(result.violations).toEqual([
			{
				kind: 'duplicate-sequence',
				sequence: '091',
				files: ['20260822120000_091_a.sql', '20260822130000_091_b.sql', '20260822140000_091_c.sql'],
			},
		]);
	});

	it('does not confuse a sequence with a version — 091 twice is not 20260822120000 twice', () => {
		expect(kinds(check(RACED))).toEqual(['duplicate-sequence']);
	});
});

describe('malformed filenames', () => {
	it('fails a new unparseable .sql file', () => {
		const result = check([...VALID_SET, 'fix_the_thing.sql']);
		expect(result.ok).toBe(false);
		expect(result.violations).toEqual([
			{
				kind: 'malformed-filename',
				filename: 'fix_the_thing.sql',
				reason: 'does not start with a 14-digit YYYYMMDDHHMMSS version',
			},
		]);
	});

	it('quotes the naming convention in the fix', () => {
		expect(formatReport(check(['fix_the_thing.sql'])).join('\n')).toContain(
			'<YYYYMMDDHHMMSS>_<NNN>_<lower_snake_slug>.sql'
		);
	});

	it('exempts a named pre-convention file but nothing else', () => {
		const result = check(['20251226182232_remote_schema.sql', '20251226190357_remote_schema.sql'], {
			preConventionFiles: new Set(['20251226182232_remote_schema.sql']),
		});
		expect(result.violations).toEqual([
			{
				kind: 'malformed-filename',
				filename: '20251226190357_remote_schema.sql',
				reason: 'has no 3-digit sequence number between the version and the slug',
			},
		]);
	});
});

describe('grandfathering', () => {
	const PAIR = ['20260621120000_053_first.sql', '20260627120000_053_second.sql'];

	it('forgives a legacy collision when every file in it is exempt', () => {
		const result = check(PAIR, { grandfatheredSequences: new Set(PAIR) });
		expect(result.ok).toBe(true);
		expect(result.grandfathered.sequences).toEqual(['053']);
	});

	it('fails when a NEW file joins a grandfathered sequence', () => {
		const joined = [...PAIR, '20260822120000_053_new_thing.sql'];
		const result = check(joined, { grandfatheredSequences: new Set(PAIR) });
		expect(result.ok).toBe(false);
		expect(result.violations).toEqual([
			{ kind: 'duplicate-sequence', sequence: '053', files: joined.slice().sort() },
		]);
		expect(result.grandfathered.sequences).toEqual([]);
	});

	it('surfaces the exemptions on a passing run rather than hiding them', () => {
		const report = formatReport(
			check([...PAIR, '20251226182232_remote_schema.sql'], {
				grandfatheredSequences: new Set(PAIR),
				preConventionFiles: new Set(['20251226182232_remote_schema.sql']),
			})
		).join('\n');
		expect(report).toContain('1 pre-convention file(s) exempt from the naming rule');
		expect(report).toContain('1 pre-existing sequence collision(s) — 053');
	});

	it('fails when an exemption names a file that no longer exists', () => {
		const result = check(VALID_SET, {
			grandfatheredSequences: new Set(['20260621120000_053_deleted.sql']),
			preConventionFiles: new Set(['20251226182232_gone.sql']),
		});
		expect(result.ok).toBe(false);
		expect(result.violations).toEqual([
			{ kind: 'stale-exemption', filename: '20251226182232_gone.sql' },
			{ kind: 'stale-exemption', filename: '20260621120000_053_deleted.sql' },
		]);
	});
});

describe('the committed exemption lists', () => {
	// Not the real directory (see the file header) — just that the two lists say
	// what the script's header claims, and stay disjoint. A file in both would be
	// exempt from the naming rule AND from sequence uniqueness, which is a wider
	// hole than either list is documented to open.
	// These two assertions exist so the exemption list cannot be widened quietly.
	// Adding 097 (#918) broke both, which is the test doing its job: an exemption
	// is a decision, and it should cost a deliberate edit here.
	it('holds exactly the 3 pre-convention files and 6 legacy sequence pairs', () => {
		expect(PRE_CONVENTION_FILES.size).toBe(3);
		expect(GRANDFATHERED_SEQUENCE_COLLISIONS.size).toBe(12);
	});

	it('does not list the same file in both', () => {
		const both = [...PRE_CONVENTION_FILES].filter((file: string) =>
			GRANDFATHERED_SEQUENCE_COLLISIONS.has(file)
		);
		expect(both).toEqual([]);
	});

	it('grandfathers whole pairs, never a lone file', () => {
		const bySequence = new Map<string, string[]>();
		for (const file of GRANDFATHERED_SEQUENCE_COLLISIONS as Set<string>) {
			const sequence = /^\d{14}_(\d{3})_/.exec(file)?.[1] ?? 'unparsed';
			bySequence.set(sequence, [...(bySequence.get(sequence) ?? []), file]);
		}
		expect([...bySequence.keys()].sort()).toEqual(['049', '052', '053', '054', '055', '097']);
		for (const [sequence, files] of bySequence) {
			expect({ sequence, count: files.length }).toEqual({ sequence, count: 2 });
		}
	});
});

describe('GitHub annotations', () => {
	// This path runs ONLY when the guard has already failed, so a crash here
	// would replace the report with a stack trace at the worst moment.
	const captured = (violation: Violation): string[] => {
		const lines: string[] = [];
		const spy = jest.spyOn(console, 'log').mockImplementation((line?: unknown) => {
			lines.push(String(line));
		});
		try {
			annotate(violation);
		} finally {
			spy.mockRestore();
		}
		return lines;
	};

	it('anchors one annotation to each colliding file', () => {
		expect(
			captured({ kind: 'duplicate-sequence', sequence: '091', files: ['a.sql', 'b.sql'] })
		).toEqual([
			'::error file=supabase/migrations/a.sql::COLLISION: sequence 091 is claimed by 2 files:',
			'::error file=supabase/migrations/b.sql::COLLISION: sequence 091 is claimed by 2 files:',
		]);
	});

	it('anchors a malformed filename to that one file', () => {
		expect(captured({ kind: 'malformed-filename', filename: 'oops.sql', reason: 'no version' })).toEqual([
			'::error file=supabase/migrations/oops.sql::MALFORMED: supabase/migrations/oops.sql',
		]);
	});

	it('leaves a stale exemption unanchored — its file no longer exists', () => {
		expect(captured({ kind: 'stale-exemption', filename: 'gone.sql' })).toEqual([
			'::error::STALE EXEMPTION: gone.sql is grandfathered but no longer exists.',
		]);
	});
});

describe('violation ordering', () => {
	it('reports every independent problem in one run rather than stopping at the first', () => {
		const result = check([
			'20260807120000_083_a.sql',
			'20260807120000_084_b.sql',
			'20260822120000_091_c.sql',
			'20260822130000_091_d.sql',
			'oops.sql',
		]);
		expect(kinds(result)).toEqual(['duplicate-version', 'duplicate-sequence', 'malformed-filename']);
	});
});

describe('sequence monotonicity (#731)', () => {
	it('exports MONOTONICITY_CUTOFF matching the newest legacy out-of-order migration', () => {
		expect(MONOTONICITY_CUTOFF).toBe('20260627140000');
	});

	it('accepts strictly non-decreasing sequence numbers', () => {
		const result = check([
			'20260807120000_083_a.sql',
			'20260807130000_084_b.sql',
			'20260810120000_086_c.sql',
		]);
		expect(result.ok).toBe(true);
		expect(result.violations).toEqual([]);
	});

	it('accepts equal sequence numbers under monotonicity (duplicate check handles them)', () => {
		// When sequence collision is grandfathered, monotonicity does not flag equality
		const result = buildResult({
			filenames: ['20260825120000_097_a.sql', '20260825180000_097_b.sql'],
			preConventionFiles: new Set<string>(),
			grandfatheredSequences: new Set(['20260825120000_097_a.sql', '20260825180000_097_b.sql']),
		});
		expect(result.ok).toBe(true);
		expect(result.violations).toEqual([]);
	});

	it('grandfathers historical out-of-order migrations at or before the cutoff', () => {
		const result = check([
			'20250115120000_032_old_with_high_seq.sql',
			'20251226183644_010_newer_with_low_seq.sql',
			'20260621180000_058_seed.sql',
			'20260627140000_055_add_provenance.sql',
		]);
		expect(result.ok).toBe(true);
		expect(result.violations).toEqual([]);
	});

	it('flags sequence drops after the monotonicity cutoff', () => {
		const result = check([
			'20260807120000_084_a.sql',
			'20260808120000_082_b.sql',
		]);
		expect(kinds(result)).toEqual(['non-monotonic-sequence']);
		expect(result.violations[0]).toMatchObject({
			kind: 'non-monotonic-sequence',
			filename: '20260808120000_082_b.sql',
			version: '20260808120000',
			sequence: '082',
			priorFilename: '20260807120000_084_a.sql',
			priorSequence: '084',
		});
	});

	it('flags multiple non-monotonic migrations in the same run', () => {
		const result = check([
			'20260807120000_084_a.sql',
			'20260808120000_082_b.sql',
			'20260809120000_081_c.sql',
		]);
		expect(kinds(result)).toEqual(['non-monotonic-sequence', 'non-monotonic-sequence']);
		// The running max must stay pinned to the true historical high (084),
		// not reset to the last-seen lower value (082) — otherwise the second
		// violation (081_c.sql) would silently cite 082 as its "prior" instead
		// of the actual max, masking a regression to a naive
		// compare-against-immediately-preceding-entry implementation.
		expect(result.violations[1]).toMatchObject({
			priorSequence: '084',
			priorFilename: '20260807120000_084_a.sql',
		});
	});

	it('formats report for non-monotonic violations', () => {
		const result = check([
			'20260807120000_084_a.sql',
			'20260808120000_082_b.sql',
		]);
		const formatted = formatReport(result).join('\n');
		expect(formatted).toContain('NON-MONOTONIC: supabase/migrations/20260808120000_082_b.sql');
		expect(formatted).toContain('Sequence 082 is lower than prior sequence 084');
	});
});
