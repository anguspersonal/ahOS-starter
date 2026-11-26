/**
 * Unit tests for the migration function-signature lint (#273).
 *
 * The script is plain CommonJS (matches sibling worker scripts, e.g.
 * check-migration-drift.js), so it's required directly. Every test below is pure
 * static analysis of SQL strings — NO database is touched.
 *
 * The load-bearing case is the pair at the bottom: a known-BAD fixture that
 * reproduces the exact migration-069 overload trap (must fail), and a
 * known-GOOD fixture plus the REAL committed migrations dir (must pass).
 */

// Mark this file as a module so its top-level `const`s are module-scoped. Without
// it, a `require`-only file is a global script and its `fs` / `buildResult` /
// `formatReport` collide with the CommonJS source's same-named globals, failing the
// full-suite ts-jest type-check with TS2451 (green in an isolated single-file run).
export {};

const fs = require('fs');
const path = require('path');

const {
	stripSqlComments,
	canonicalizeType,
	splitTopLevelArgs,
	parseCreateSignature,
	parseDropSignature,
	extractFunctionOps,
	analyzeMigrations,
	buildResult,
	formatReport,
	MIGRATIONS_DIR,
} = require('../../../scripts/check-migration-signatures');

// The 3-arg fts function as migration 066 defined it.
const FTS_066 = `
create or replace function public.fts_search_artifacts(
  query_text    text,
  match_user_id uuid,
  match_limit   int default 10
)
returns setof public.artifacts language sql stable as $$
  select a.* from public.artifacts a where a.user_id = match_user_id limit match_limit;
$$;
`;

// The migration-069 change: adds include_archived via CREATE OR REPLACE, changing
// the signature — this creates a SECOND overload instead of replacing.
const FTS_069 = `
create or replace function public.fts_search_artifacts(
  query_text       text,
  match_user_id    uuid,
  match_limit      int default 10,
  include_archived boolean default false
)
returns setof public.artifacts language sql stable as $$
  select a.* from public.artifacts a where a.user_id = match_user_id limit match_limit;
$$;
`;

// The migration-071 fix: drops the stale 3-arg overload by explicit signature.
const FTS_071 = `drop function if exists public.fts_search_artifacts(text, uuid, integer);`;

describe('canonicalizeType', () => {
	it('maps integer spellings to a single canonical form', () => {
		expect(canonicalizeType('int')).toBe('integer');
		expect(canonicalizeType('int4')).toBe('integer');
		expect(canonicalizeType('INTEGER')).toBe('integer');
	});

	it('maps float spellings to double precision', () => {
		expect(canonicalizeType('float')).toBe('double precision');
		expect(canonicalizeType('float8')).toBe('double precision');
		expect(canonicalizeType('double precision')).toBe('double precision');
	});

	it('strips a type modifier but keeps the base type', () => {
		expect(canonicalizeType('vector(1536)')).toBe('vector');
		expect(canonicalizeType('numeric(10, 2)')).toBe('numeric');
		expect(canonicalizeType('varchar(50)')).toBe('character varying');
	});

	it('preserves array-ness', () => {
		expect(canonicalizeType('text[]')).toBe('text[]');
		expect(canonicalizeType('int[]')).toBe('integer[]');
	});

	it('passes unknown types through unchanged (lowercased)', () => {
		expect(canonicalizeType('uuid')).toBe('uuid');
		expect(canonicalizeType('JSONB')).toBe('jsonb');
	});
});

describe('splitTopLevelArgs', () => {
	it('splits on top-level commas only', () => {
		expect(splitTopLevelArgs('a int, b uuid, c text')).toEqual(['a int', 'b uuid', 'c text']);
	});

	it('does not split inside a type modifier', () => {
		expect(splitTopLevelArgs('emb vector(1536), n numeric(10,2)')).toEqual([
			'emb vector(1536)',
			'n numeric(10,2)',
		]);
	});

	it('returns an empty list for a no-arg function', () => {
		expect(splitTopLevelArgs('')).toEqual([]);
		expect(splitTopLevelArgs('   ')).toEqual([]);
	});
});

describe('parseCreateSignature', () => {
	it('extracts canonical input types from named args, dropping defaults', () => {
		expect(parseCreateSignature('query_text text, match_user_id uuid, match_limit int default 10')).toEqual([
			'text',
			'uuid',
			'integer',
		]);
	});

	it('handles the full 8-arg hybrid signature (float -> double precision, vector modifier stripped)', () => {
		const inner =
			'query_text text, query_embedding vector(1536), match_user_id uuid, ' +
			'match_limit int default 10, full_text_weight float default 1.0, ' +
			'semantic_weight float default 1.0, rrf_k int default 50, ' +
			'include_archived boolean default false';
		expect(parseCreateSignature(inner)).toEqual([
			'text',
			'vector',
			'uuid',
			'integer',
			'double precision',
			'double precision',
			'integer',
			'boolean',
		]);
	});
});

describe('parseDropSignature', () => {
	it('reads type-only DROP args and canonicalises them', () => {
		expect(parseDropSignature('text, uuid, integer')).toEqual(['text', 'uuid', 'integer']);
	});

	it('canonicalises the hybrid DROP signature to match its CREATE', () => {
		expect(
			parseDropSignature('text, vector, uuid, integer, double precision, double precision, integer')
		).toEqual(['text', 'vector', 'uuid', 'integer', 'double precision', 'double precision', 'integer']);
	});
});

describe('extractFunctionOps', () => {
	it('extracts a CREATE op with its canonical signature', () => {
		const ops = extractFunctionOps(FTS_066);
		expect(ops).toEqual([
			{
				op: 'create',
				name: 'public.fts_search_artifacts',
				hasArgs: true,
				signature: '(text, uuid, integer)',
				index: expect.any(Number),
			},
		]);
	});

	it('extracts a DROP op with its canonical signature', () => {
		const ops = extractFunctionOps(FTS_071);
		expect(ops).toEqual([
			{
				op: 'drop',
				name: 'public.fts_search_artifacts',
				hasArgs: true,
				signature: '(text, uuid, integer)',
				index: expect.any(Number),
			},
		]);
	});

	it('ignores the word "function" inside comments', () => {
		// The exact false-positive shape from migrations 010/012.
		expect(extractFunctionOps('-- Step 13: Create function to auto-update updated_at\nselect 1;')).toEqual([]);
	});

	it('returns ops in source order when a file drops then creates', () => {
		const sql = `drop function if exists public.f(text);\ncreate function public.f(text, uuid) returns void language sql as $$ select $$;`;
		const ops = extractFunctionOps(sql);
		expect(ops.map((o: { op: string }) => o.op)).toEqual(['drop', 'create']);
	});

	it('fails loudly (throws) on an unbalanced paren group instead of silently skipping the op', () => {
		// A CREATE FUNCTION whose arg list never closes: extractBalancedParens returns
		// null, which must now throw rather than silently drop the op (silently dropping
		// could hide a signature-changing overload — the class this lint exists to catch).
		expect(() => extractFunctionOps('create or replace function public.foo(a int')).toThrow(
			/unbalanced parentheses/i,
		);
	});
});

describe('extractFunctionOps — multi-name DROP FUNCTION (#402)', () => {
	it('registers every name in a comma-separated DROP FUNCTION list', () => {
		const ops = extractFunctionOps('drop function if exists public.f1(text), public.f2(uuid, boolean);');
		expect(ops).toEqual([
			{ op: 'drop', name: 'public.f1', hasArgs: true, signature: '(text)', index: expect.any(Number) },
			{ op: 'drop', name: 'public.f2', hasArgs: true, signature: '(uuid, boolean)', index: expect.any(Number) },
		]);
	});

	it('handles three or more names, and a bare (no-arg-list) name in the middle', () => {
		const ops = extractFunctionOps('drop function public.f1(text), public.f2, public.f3(integer);');
		expect(ops.map((o: { name: string; hasArgs: boolean }) => [o.name, o.hasArgs])).toEqual([
			['public.f1', true],
			['public.f2', false],
			['public.f3', true],
		]);
	});

	it('does not extend a single-name DROP across an unrelated later statement', () => {
		const ops = extractFunctionOps('drop function public.f1(text);\ncreate table public.t2 (id uuid);');
		expect(ops).toEqual([
			{ op: 'drop', name: 'public.f1', hasArgs: true, signature: '(text)', index: expect.any(Number) },
		]);
	});

	it('clears an overload left by two functions in one statement (069+071 pattern, generalised to N)', () => {
		// The direct motivation for this feature: instead of one DROP per function, a
		// single multi-name DROP FUNCTION fixes an accidental overload in both f1 and
		// f2 at once.
		const files = [
			{
				name: '20260101000000_a_create.sql',
				sql:
					'create function public.f1(a text) returns void language sql as $$ select 1 $$;\n' +
					'create function public.f2(a uuid) returns void language sql as $$ select 1 $$;',
			},
			{
				name: '20260102000000_b_add_overloads.sql',
				sql:
					'create or replace function public.f1(a text, b int default 1) returns void language sql as $$ select 1 $$;\n' +
					'create or replace function public.f2(a uuid, b int default 1) returns void language sql as $$ select 1 $$;',
			},
			{
				name: '20260103000000_c_fix_both.sql',
				sql: 'drop function if exists public.f1(text), public.f2(uuid);',
			},
		];
		expect(buildResult(files).ok).toBe(true);
	});

	it('still flags a violation when a multi-name DROP fixes only one of two overloaded functions', () => {
		const files = [
			{
				name: '20260101000000_a_create.sql',
				sql:
					'create function public.f1(a text) returns void language sql as $$ select 1 $$;\n' +
					'create function public.f2(a uuid) returns void language sql as $$ select 1 $$;',
			},
			{
				name: '20260102000000_b_add_overloads.sql',
				sql:
					'create or replace function public.f1(a text, b int default 1) returns void language sql as $$ select 1 $$;\n' +
					'create or replace function public.f2(a uuid, b int default 1) returns void language sql as $$ select 1 $$;',
			},
			{
				name: '20260103000000_c_wrong_second_name.sql',
				// f2's DROP names the wrong arity (3 args instead of the real 2), so f2
				// keeps both overloads; f1 is fixed correctly.
				sql: 'drop function if exists public.f1(text), public.f2(uuid, integer, integer);',
			},
		];
		const result = buildResult(files);
		expect(result.ok).toBe(false);
		expect(result.violations.map((v: { name: string }) => v.name)).toEqual(['f2']);
	});
});

describe('stripSqlComments / extractFunctionOps — string-literal awareness (#402)', () => {
	it('does not treat a DROP/CREATE FUNCTION lookalike inside a single-quoted default as DDL', () => {
		const sql =
			"create or replace function public.example_fn(\n" +
			"  note text default 'DROP FUNCTION evil_fn(); -- not real DDL, just a string',\n" +
			'  match_limit int default 10\n' +
			')\n' +
			'returns void language sql as $$ select 1; $$;';
		const ops = extractFunctionOps(sql);
		expect(ops).toEqual([
			{
				op: 'create',
				name: 'public.example_fn',
				hasArgs: true,
				signature: '(text, integer)',
				index: expect.any(Number),
			},
		]);
	});

	it('does not let an unbalanced paren inside a string-literal default break paren balancing', () => {
		// Before #402 this threw "unbalanced parentheses" — the stray `(` inside the
		// string was counted as a real open-paren.
		const sql =
			"create or replace function public.example_fn2(\n" +
			"  note text default 'unbalanced ( paren',\n" +
			'  n int default 1\n' +
			')\n' +
			'returns void language sql as $$ select 1; $$;';
		expect(() => extractFunctionOps(sql)).not.toThrow();
		const ops = extractFunctionOps(sql);
		expect(ops).toEqual([
			{
				op: 'create',
				name: 'public.example_fn2',
				hasArgs: true,
				signature: '(text, integer)',
				index: expect.any(Number),
			},
		]);
	});

	it("handles an escaped quote ('') inside a string-literal default without losing sync", () => {
		const sql =
			"create or replace function public.example_fn3(\n" +
			"  note text default 'it''s DROP FUNCTION evil_fn(); fine',\n" +
			'  n int default 1\n' +
			')\n' +
			'returns void language sql as $$ select 1; $$;';
		const ops = extractFunctionOps(sql);
		expect(ops).toEqual([
			{
				op: 'create',
				name: 'public.example_fn3',
				hasArgs: true,
				signature: '(text, integer)',
				index: expect.any(Number),
			},
		]);
	});

	it('does not parse dynamic SQL (EXECUTE) inside a dollar-quoted body as DDL', () => {
		const sql =
			'create function public.wrapper_fn() returns void language plpgsql as $$\n' +
			'begin\n' +
			"  execute 'drop function if exists legacy_fn(text)';\n" +
			'end;\n' +
			'$$;';
		const ops = extractFunctionOps(sql);
		expect(ops).toEqual([
			{ op: 'create', name: 'public.wrapper_fn', hasArgs: true, signature: '()', index: expect.any(Number) },
		]);
	});

	it('does not parse a tagged dollar-quoted body ($body$...$body$) as DDL either', () => {
		const sql =
			'create function public.wrapper_fn2() returns void language plpgsql as $body$\n' +
			'begin\n' +
			"  execute 'create or replace function legacy_fn(a text, b int) returns void as $$ select $$;';\n" +
			'end;\n' +
			'$body$;';
		const ops = extractFunctionOps(sql);
		expect(ops).toEqual([
			{ op: 'create', name: 'public.wrapper_fn2', hasArgs: true, signature: '()', index: expect.any(Number) },
		]);
	});

	it('ignores a full DDL-looking line-comment, not just the bare word "function"', () => {
		const sql =
			'-- DROP FUNCTION old_fn(text, uuid);\n' +
			'create function public.new_fn(a text) returns void language sql as $$ select 1 $$;';
		const ops = extractFunctionOps(sql);
		expect(ops).toEqual([
			{ op: 'create', name: 'public.new_fn', hasArgs: true, signature: '(text)', index: expect.any(Number) },
		]);
	});

	it('ignores a full DDL-looking block comment', () => {
		const sql =
			'/* DROP FUNCTION old_fn2(text); */\n' +
			'create function public.new_fn2(a text) returns void language sql as $$ select 1 $$;';
		const ops = extractFunctionOps(sql);
		expect(ops).toEqual([
			{ op: 'create', name: 'public.new_fn2', hasArgs: true, signature: '(text)', index: expect.any(Number) },
		]);
	});

	it('preserves the total character length (line/position structure) of the source', () => {
		const sql =
			"create or replace function public.f(a text default 'x''y $$ -- /* z')\n" +
			'returns void language sql as $$ select 1; -- trailing\n$$;';
		expect(stripSqlComments(sql).length).toBe(sql.length);
	});

	it('a string-literal-hidden overload trap still resolves correctly once dropped', () => {
		// End-to-end: the accidental overload is introduced with a decoy string literal
		// alongside the real signature change, and fixed with a real DROP. Confirms
		// string-literal blanking and the analysis pass compose correctly.
		const files = [
			{
				name: '20260101000000_a.sql',
				sql: "create function public.g(note text default 'DROP FUNCTION g(text);') returns void language sql as $$ select 1 $$;",
			},
			{
				name: '20260102000000_b_overload.sql',
				sql:
					"create or replace function public.g(note text default 'x', extra int default 1) " +
					'returns void language sql as $$ select 1 $$;',
			},
		];
		expect(buildResult(files).ok).toBe(false);

		const fixed = [...files, { name: '20260103000000_c_fix.sql', sql: 'drop function if exists public.g(text);' }];
		expect(buildResult(fixed).ok).toBe(true);
	});
});

describe('analyzeMigrations / buildResult — known-good cases (must PASS)', () => {
	it('passes when a signature change drops the old overload (the 069+071 pattern)', () => {
		const result = buildResult([
			{ name: '20260707130000_066_fts_rank_search.sql', sql: FTS_066 },
			{ name: '20260707160000_069_artifact_soft_delete_search_opt_in.sql', sql: FTS_069 },
			{ name: '20260707180000_071_fix_search_fn_overloads.sql', sql: FTS_071 },
		]);
		expect(result.ok).toBe(true);
		expect(result.violations).toEqual([]);
	});

	it('passes on a same-signature CREATE OR REPLACE (a body-only change)', () => {
		const bodyChange = FTS_066.replace('limit match_limit;', 'limit match_limit + 0;');
		const result = buildResult([
			{ name: '20260101000000_a.sql', sql: FTS_066 },
			{ name: '20260102000000_b.sql', sql: bodyChange },
		]);
		expect(result.ok).toBe(true);
	});

	it('passes when a return-type change drops first, then recreates the same input signature (the 039 pattern)', () => {
		const files = [
			{ name: '20260101000000_base.sql', sql: 'create function public.g(p text) returns int language sql as $$ select 1 $$;' },
			{
				name: '20260301120000_039.sql',
				sql: 'drop function if exists public.g(text);\ncreate function public.g(p text) returns table(x int) language sql as $$ select 1 $$;',
			},
		];
		expect(buildResult(files).ok).toBe(true);
	});

	it('passes when a function is created then fully dropped', () => {
		const files = [
			{ name: '20260101000000_add.sql', sql: 'create function public.tmp(a uuid, b boolean) returns void language sql as $$ select $$;' },
			{ name: '20260102000000_remove.sql', sql: 'drop function if exists public.tmp(uuid, boolean) cascade;' },
		];
		const result = buildResult(files);
		expect(result.ok).toBe(true);
		expect(result.dropCount).toBe(1);
	});
});

describe('analyzeMigrations / buildResult — known-bad cases (must FAIL)', () => {
	it('flags the raw migration-069 trap: add an overload via CREATE OR REPLACE, no DROP', () => {
		const result = buildResult([
			{ name: '20260707130000_066_fts_rank_search.sql', sql: FTS_066 },
			{ name: '20260707160000_069_artifact_soft_delete_search_opt_in.sql', sql: FTS_069 },
			// NOTE: no 071 fix — this is the state that broke prod.
		]);
		expect(result.ok).toBe(false);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0].name).toBe('fts_search_artifacts');
		expect(result.violations[0].overloads.map((o: { signature: string }) => o.signature)).toEqual([
			'(text, uuid, integer)',
			'(text, uuid, integer, boolean)',
		]);

		const report = formatReport(result).join('\n');
		expect(report).toContain('fts_search_artifacts');
		expect(report).toContain('is not unique');
		expect(report).toContain('DROP FUNCTION');
	});

	it('attributes each surviving overload to the migration that created it', () => {
		const result = buildResult([
			{ name: '20260707130000_066_fts_rank_search.sql', sql: FTS_066 },
			{ name: '20260707160000_069_artifact_soft_delete_search_opt_in.sql', sql: FTS_069 },
		]);
		const overloads = result.violations[0].overloads;
		expect(overloads).toContainEqual({
			signature: '(text, uuid, integer)',
			file: '20260707130000_066_fts_rank_search.sql',
		});
		expect(overloads).toContainEqual({
			signature: '(text, uuid, integer, boolean)',
			file: '20260707160000_069_artifact_soft_delete_search_opt_in.sql',
		});
	});

	it('flags a mismatched DROP that fails to clear the old overload', () => {
		// DROP names the wrong arity (2 args), so the real 3-arg overload survives
		// alongside the new 4-arg one — still two live, still the trap.
		const wrongDrop = 'drop function if exists public.fts_search_artifacts(text, uuid);';
		const result = buildResult([
			{ name: '20260707130000_066.sql', sql: FTS_066 },
			{ name: '20260707160000_069.sql', sql: FTS_069 },
			{ name: '20260707180000_071_wrong.sql', sql: wrongDrop },
		]);
		expect(result.ok).toBe(false);
		expect(result.violations[0].name).toBe('fts_search_artifacts');
	});
});

describe('sync guard: the REAL committed migrations dir passes the lint', () => {
	// The load-bearing test. If a future migration reintroduces the overload trap
	// (a CREATE OR REPLACE that changes a signature without dropping the old one),
	// this fails in CI — the same PR must add the DROP. Mirrors the analogous
	// real-source tripwire in check-migration-drift.test.ts.
	it('resolves every function to a single live overload across the whole history', () => {
		const files = fs
			.readdirSync(MIGRATIONS_DIR)
			.filter((f: string) => f.endsWith('.sql'))
			.map((name: string) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf-8') }));
		const result = buildResult(files);
		if (!result.ok) {
			// Surface the offending functions in the failure message.
			throw new Error(formatReport(result).join('\n'));
		}
		expect(result.ok).toBe(true);
	});
});
