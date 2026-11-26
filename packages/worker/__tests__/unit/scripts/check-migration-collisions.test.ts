/**
 * Unit tests for the cross-PR migration collision guard (#1049).
 *
 * The script is plain CommonJS with no build step (matches its siblings, e.g.
 * check-migration-versions.js), so it is required directly rather than
 * imported. `findCollisions`, `parseMigrationPath` and `excludeSelf` are pure,
 * so most cases here are plain object literals — no git, no network. The
 * network-touching helpers (`fetchOpenPullRequests`, `fetchAddedMigrations`)
 * and the full `runCheck` decision tree get stubbed-`fetchJson`/injected-fake
 * cases, enough to prove every branch (base-resolution failure, the two SKIP
 * paths, both API-failure paths, and the happy path) runs the way `main()`
 * would drive it, without touching `process.exit` or `process.env`.
 *
 * Originally lived at `packages/worker/scripts/check-migration-collisions.test.js`
 * and ran via `node --test` — but nothing in CI ever invoked that: worker's
 * Jest is scoped to `.test.ts` under `src/__tests__`, and `pr-guards.yml`'s
 * `node --test` step globs only repo-root `scripts/` and `.github/scripts/`.
 * Moved here, alongside the sibling guards' tests, so `test:unit` actually
 * runs it (round 1 QA review finding).
 */

// A .ts file with no import/export is a global SCRIPT to TypeScript, so its
// top-level `const`s collide with every sibling script test that destructures
// the same names. ts-jest only sees it when both files land in one program,
// which depends on worker sharding — green locally, TS2451 in CI. This makes
// the file a module; keep it.
export {};

const {
	parseMigrationPath,
	findCollisions,
	formatReport,
	excludeSelf,
	runCheck,
	fetchOpenPullRequests,
	fetchAddedMigrations,
} = require('../../../scripts/check-migration-collisions.js');

type MigrationFile = { filename: string; version: string; sequence: string };

const file = (version: string, seq: string, slug: string): MigrationFile => ({
	filename: `${version}_${seq}_${slug}.sql`,
	version,
	sequence: seq,
});

// --- parseMigrationPath ------------------------------------------------------

describe('parseMigrationPath', () => {
	it('parses a well-formed migration path', () => {
		expect(parseMigrationPath('supabase/migrations/20260912120000_101_entities_domain_override.sql')).toEqual({
			filename: '20260912120000_101_entities_domain_override.sql',
			version: '20260912120000',
			sequence: '101',
		});
	});

	it('rejects a path outside supabase/migrations', () => {
		expect(parseMigrationPath('packages/worker/scripts/foo.sql')).toBeNull();
	});

	it('rejects a malformed filename', () => {
		expect(parseMigrationPath('supabase/migrations/not_a_migration.sql')).toBeNull();
		expect(parseMigrationPath('supabase/migrations/20260912120000_remote_schema.sql')).toBeNull();
	});
});

// --- findCollisions ----------------------------------------------------------

describe('findCollisions', () => {
	it('flags two PRs stamping the same timestamp, naming both PRs', () => {
		// The #1049 shape: #1041 and #1039 both stamp 20260912120000.
		const local = [file('20260912120000', '101', 'entities_domain_override')];
		const foreign = [{ ...file('20260912120000', '102', 'graph_instance_of_view'), prNumber: 1039 }];

		const violations = findCollisions(local, foreign);

		expect(violations.length).toBe(1);
		expect(violations[0].kind).toBe('version');
		expect(violations[0].key).toBe('20260912120000');
		expect(violations[0].foreignPr).toBe(1039);
		expect(violations[0].localFile).toBe(local[0].filename);
		expect(violations[0].foreignFile).toBe(foreign[0].filename);
	});

	it('passes clean on distinct timestamps and sequences', () => {
		const local = [file('20260912120000', '101', 'a')];
		const foreign = [{ ...file('20260913090000', '102', 'b'), prNumber: 1039 }];

		expect(findCollisions(local, foreign)).toEqual([]);
	});

	it('flags a shared _NNN_ sequence among new files too', () => {
		const local = [file('20260915090000', '104', 'a')];
		const foreign = [{ ...file('20260916100000', '104', 'b'), prNumber: 1050 }];

		const violations = findCollisions(local, foreign);

		expect(violations.length).toBe(1);
		expect(violations[0].kind).toBe('sequence');
		expect(violations[0].key).toBe('104');
		expect(violations[0].foreignPr).toBe(1050);
	});

	it('leaves grandfathered dev _NNN_ collisions out of scope', () => {
		// 049 is grandfathered on dev, but this guard never sees dev files at all —
		// only files another open PR's diff reports as added/renamed. A local new
		// file that happens to reuse a *different*, non-colliding number must stay
		// clean.
		const local = [file('20260920090000', '110', 'new_thing')];
		const foreign = [{ ...file('20260921090000', '111', 'unrelated'), prNumber: 1060 }];

		expect(findCollisions(local, foreign)).toEqual([]);
	});

	it('reports both violations when a pair shares both version and sequence', () => {
		const local = [file('20260912120000', '101', 'a')];
		const foreign = [{ ...file('20260912120000', '101', 'b'), prNumber: 1039 }];

		const violations = findCollisions(local, foreign);

		expect(violations.length).toBe(2);
		expect(violations.map((v: { kind: string }) => v.kind).sort()).toEqual(['sequence', 'version']);
	});

	it('produces no violations when there are no local files, regardless of foreign files', () => {
		const foreign = [{ ...file('20260912120000', '101', 'a'), prNumber: 1039 }];
		expect(findCollisions([], foreign)).toEqual([]);
	});
});

// --- formatReport --------------------------------------------------------------

describe('formatReport', () => {
	it('names both PRs in the collision block', () => {
		const violations = findCollisions(
			[file('20260912120000', '101', 'a')],
			[{ ...file('20260912120000', '102', 'b'), prNumber: 1039 }]
		);
		const lines = formatReport(violations, { selfPr: 1041, checked: 3 }).join('\n');
		expect(lines).toMatch(/#1041/);
		expect(lines).toMatch(/PR #1039/);
		expect(lines).toMatch(/COLLISION/);
	});

	it('reports OK with no violations', () => {
		const lines = formatReport([], { selfPr: 1041, checked: 3 }).join('\n');
		expect(lines).toMatch(/OK/);
		expect(lines).not.toMatch(/COLLISION/);
	});
});

// --- excludeSelf ---------------------------------------------------------------

describe('excludeSelf', () => {
	it('drops the PR matching selfPr, keeping the others', () => {
		const pulls = [{ number: 1039 }, { number: 1041 }, { number: 1042 }];
		expect(excludeSelf(pulls, 1041)).toEqual([{ number: 1039 }, { number: 1042 }]);
	});

	it('compares loosely so a string --pr matches a numeric pr.number', () => {
		const pulls = [{ number: 1041 }, { number: 1042 }];
		expect(excludeSelf(pulls, '1041')).toEqual([{ number: 1042 }]);
	});

	it('keeps every PR when selfPr is null (no --pr / PR_NUMBER given)', () => {
		const pulls = [{ number: 1039 }, { number: 1041 }];
		expect(excludeSelf(pulls, null)).toEqual(pulls);
	});
});

// --- fetchOpenPullRequests / fetchAddedMigrations (stubbed fetchJson) --------

describe('fetchOpenPullRequests', () => {
	it('pages until a short page', async () => {
		const pages = [Array.from({ length: 100 }, (_, i) => ({ number: i + 1 })), [{ number: 101 }]];
		let calls = 0;
		const fetchJson = async (url: string) => {
			expect(url).toMatch(/state=open&base=dev/);
			return pages[calls++];
		};

		const pulls = await fetchOpenPullRequests({
			repo: 'anguspersonal/ahOS',
			token: 't',
			targetBase: 'dev',
			fetchJson,
		});
		expect(pulls.length).toBe(101);
		expect(calls).toBe(2);
	});
});

describe('fetchAddedMigrations', () => {
	it('keeps added migration files, drops modified and non-migration files', () => {
		const fetchJson = async () => [
			{ filename: 'supabase/migrations/20260912120000_101_a.sql', status: 'added' },
			{ filename: 'supabase/migrations/20260101000000_050_old.sql', status: 'modified' },
			{ filename: 'packages/worker/src/index.js', status: 'added' },
		];

		return fetchAddedMigrations({ repo: 'anguspersonal/ahOS', token: 't', prNumber: 1039, fetchJson }).then(
			(files: unknown) => {
				expect(files).toEqual([
					{ filename: '20260912120000_101_a.sql', version: '20260912120000', sequence: '101', prNumber: 1039 },
				]);
			}
		);
	});

	// Round 1 QA review, medium: a migration another open PR RENAMES (GitHub
	// reports `status: "renamed"`) is exactly how this guard's own suggested
	// remedy — "give ITS file a new, later timestamp" — is applied in practice,
	// via `git mv`. An added-only filter made that case invisible; this pins
	// that a rename is now treated as a candidate, using its post-rename name.
	it('keeps renamed migration files, treating the new filename as the candidate', async () => {
		const fetchJson = async () => [
			{
				filename: 'supabase/migrations/20260912130000_102_renamed_off_collision.sql',
				previous_filename: 'supabase/migrations/20260912120000_102_original_name.sql',
				status: 'renamed',
			},
		];

		const files = await fetchAddedMigrations({ repo: 'anguspersonal/ahOS', token: 't', prNumber: 1039, fetchJson });

		expect(files).toEqual([
			{
				filename: '20260912130000_102_renamed_off_collision.sql',
				version: '20260912130000',
				sequence: '102',
				prNumber: 1039,
			},
		]);
	});
});

// --- runCheck (the `main()` decision tree, minus process/console) -----------

describe('runCheck', () => {
	const baseArgs = { argv: [] as string[], repo: 'anguspersonal/ahOS', targetBase: 'dev', selfPr: 1041, token: 't' };

	it('reports the base-resolution failure and exits 1, without touching the network', async () => {
		const resolveBaseFn = () => {
			throw new Error('no merge base');
		};
		const fetchOpenPullRequestsFn = jest.fn();

		const result = await runCheck({ ...baseArgs, resolveBaseFn, fetchOpenPullRequestsFn });

		expect(result.exitCode).toBe(1);
		expect(result.isError).toBe(true);
		expect(result.lines.join('\n')).toMatch(/no merge base/);
		expect(fetchOpenPullRequestsFn).not.toHaveBeenCalled();
	});

	it('SKIPs cleanly (exit 0) when this branch adds no migration', async () => {
		const result = await runCheck({
			...baseArgs,
			resolveBaseFn: () => 'basesha',
			localAddedMigrationsFn: () => [],
		});

		expect(result.exitCode).toBe(0);
		expect(result.isError).toBeUndefined();
		expect(result.lines.join('\n')).toMatch(/SKIP: this branch adds no supabase\/migrations/);
	});

	it('SKIPs cleanly (exit 0) when there is no token, without listing PRs', async () => {
		const fetchOpenPullRequestsFn = jest.fn();
		const result = await runCheck({
			...baseArgs,
			token: null,
			resolveBaseFn: () => 'basesha',
			localAddedMigrationsFn: () => [file('20260912120000', '101', 'a')],
			fetchOpenPullRequestsFn,
		});

		expect(result.exitCode).toBe(0);
		expect(result.lines.join('\n')).toMatch(/SKIP: no GITHUB_TOKEN/);
		expect(fetchOpenPullRequestsFn).not.toHaveBeenCalled();
	});

	it('fails closed (exit 2) when listing open PRs errors', async () => {
		const result = await runCheck({
			...baseArgs,
			resolveBaseFn: () => 'basesha',
			localAddedMigrationsFn: () => [file('20260912120000', '101', 'a')],
			fetchOpenPullRequestsFn: async () => {
				throw new Error('GitHub API 500');
			},
		});

		expect(result.exitCode).toBe(2);
		expect(result.isError).toBe(true);
		expect(result.lines.join('\n')).toMatch(/could not list open PRs/);
	});

	it('fails closed (exit 2) when reading a sibling PR\'s files errors', async () => {
		const result = await runCheck({
			...baseArgs,
			resolveBaseFn: () => 'basesha',
			localAddedMigrationsFn: () => [file('20260912120000', '101', 'a')],
			fetchOpenPullRequestsFn: async () => [{ number: 1039 }],
			fetchAddedMigrationsFn: async () => {
				throw new Error('GitHub API 502');
			},
		});

		expect(result.exitCode).toBe(2);
		expect(result.isError).toBe(true);
		expect(result.lines.join('\n')).toMatch(/could not read PR files/);
	});

	it('excludes this PR from the sibling list end to end, reporting OK', async () => {
		const fetchAddedMigrationsFn = jest.fn(async ({ prNumber }: { prNumber: number }) =>
			prNumber === 1041 ? [{ ...file('20260912120000', '101', 'self'), prNumber }] : []
		);

		const result = await runCheck({
			...baseArgs,
			resolveBaseFn: () => 'basesha',
			localAddedMigrationsFn: () => [file('20260912120000', '101', 'a')],
			fetchOpenPullRequestsFn: async () => [{ number: 1039 }, { number: 1041 }],
			fetchAddedMigrationsFn,
		});

		// PR #1041 (selfPr) must never be asked for its files — excludeSelf ran.
		expect(fetchAddedMigrationsFn).toHaveBeenCalledTimes(1);
		expect(fetchAddedMigrationsFn).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 1039 }));
		expect(result.exitCode).toBe(0);
		expect(result.lines.join('\n')).toMatch(/OK/);
	});

	it('reports a collision (exit 1) and annotates in GitHub Actions', async () => {
		const result = await runCheck({
			...baseArgs,
			resolveBaseFn: () => 'basesha',
			localAddedMigrationsFn: () => [file('20260912120000', '101', 'a')],
			fetchOpenPullRequestsFn: async () => [{ number: 1039 }],
			fetchAddedMigrationsFn: async () => [{ ...file('20260912120000', '102', 'b'), prNumber: 1039 }],
			isGithubActions: true,
		});

		expect(result.exitCode).toBe(1);
		expect(result.lines.join('\n')).toMatch(/::error file=supabase\/migrations/);
	});

	it('emits machine-readable JSON with --json', async () => {
		const result = await runCheck({
			...baseArgs,
			argv: ['--json'],
			resolveBaseFn: () => 'basesha',
			localAddedMigrationsFn: () => [file('20260912120000', '101', 'a')],
			fetchOpenPullRequestsFn: async () => [],
			fetchAddedMigrationsFn: async () => [],
		});

		const parsed = JSON.parse(result.lines[0]);
		expect(parsed).toEqual({ ok: true, checked: 0, violations: [] });
	});
});
