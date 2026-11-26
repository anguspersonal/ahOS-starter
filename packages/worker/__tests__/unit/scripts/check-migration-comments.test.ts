/**
 * Unit tests for the column-comment shrink guard (#964).
 *
 * The script is plain CommonJS with no build step (matches its siblings,
 * check-migration-versions.js and check-migration-signatures.js), so it is
 * required directly. Every test drives the PURE core with synthetic filenames
 * and SQL — nothing here reads supabase/migrations/, on purpose: a worker test
 * reading a repo-root directory is outside this package's turbo cache key, so a
 * real-tree assertion could go on passing from cache after the tree changed.
 * The real tree is asserted live by the pr-guards.yml step that runs the script
 * itself against `--base`.
 *
 * Three pins the guard exists for:
 *   1. A migration that shrinks an EXISTING column comment by more than half is
 *      flagged — but only when THAT migration is "new" (the 090 -> 097 shape).
 *   2. A migration that drops a shouted rule phrase is flagged even when the
 *      length barely moves.
 *   3. A column rename carries the running comment forward under the new name,
 *      so a rename-then-recomment migration is compared against the PRE-rename
 *      text (054 and 097's shape), not treated as a fresh column with no
 *      history.
 */

// A .ts file with no import/export is a global SCRIPT to TypeScript, so its
// top-level `const`s collide with every sibling script test that destructures
// the same names. ts-jest only sees it when both files land in one program,
// which depends on worker sharding — green locally, TS2451 in CI. This makes
// the file a module; keep it.
export {};

const {
	tokenize,
	splitIdentParts,
	columnKeyFromRef,
	collectRenames,
	collectComments,
	blankLiterals,
	normalizeMarkerScope,
	extractMarkers,
	extractCapsPhrases,
	normalizeWhitespace,
	buildResult,
	formatReport,
	annotate,
} = require('../../../scripts/check-migration-comments');

type Violation = { kind: string; file: string; key: string; [k: string]: unknown };

const kinds = (violations: Violation[]) => violations.map((v) => v.kind);

/** Build a `COMMENT ON COLUMN table.column IS '<text>';` statement, quote-escaped. */
const commentStmt = (target: string, text: string) => `COMMENT ON COLUMN ${target} IS '${text.replace(/'/g, "''")}';`;

/** Build one dollar-quoted comment statement, e.g. to carry apostrophes without escaping. */
const dollarCommentStmt = (target: string, text: string) => `COMMENT ON COLUMN ${target} IS $comment$${text}$comment$;`;

describe('tokenize', () => {
	it('extracts a single-quoted literal with doubled-quote escaping', () => {
		const { clean, strings } = tokenize("SELECT 'it''s fine';");
		expect(strings).toEqual([{ value: "it's fine", kind: 'single', tag: null }]);
		// NUL is built via fromCharCode rather than typed as \0 in source, which next to a
		// literal digit is a legacy octal escape (a syntax error in strict mode), and rather
		// than embedding a raw NUL byte in this committed file.
		const NUL = String.fromCharCode(0);
		expect(clean).toBe(`SELECT ${NUL}0${NUL};`);
	});

	it('extracts a dollar-quoted literal by its own tag, not a bare $$', () => {
		const { strings } = tokenize('COMMENT ON COLUMN t.c IS $comment$has $$ inside$comment$;');
		expect(strings).toEqual([{ value: 'has $$ inside', kind: 'dollar', tag: 'comment' }]);
	});

	it('blanks a line comment to a single newline, preserving statement order', () => {
		const { clean } = tokenize("-- a comment\nSELECT 1;");
		expect(clean).toBe('\nSELECT 1;');
	});

	it('blanks a block comment entirely', () => {
		const { clean } = tokenize('SELECT /* nope */ 1;');
		expect(clean).toBe('SELECT  1;');
	});
});

describe('splitIdentParts / columnKeyFromRef', () => {
	it('splits a bare dotted identifier and lowercases it', () => {
		expect(splitIdentParts('public.user_preferences')).toEqual(['public', 'user_preferences']);
	});

	it('splits a fully double-quoted identifier', () => {
		expect(splitIdentParts('"public"."artifacts"."artifact_type"')).toEqual(['public', 'artifacts', 'artifact_type']);
	});

	it('resolves table.column to a schema-free key, 2 or 3 parts either way', () => {
		expect(columnKeyFromRef('user_preferences.dos_config')).toBe('user_preferences.dos_config');
		expect(columnKeyFromRef('public.user_preferences.dos_config')).toBe('user_preferences.dos_config');
		expect(columnKeyFromRef('"public"."artifacts"."artifact_type"')).toBe('artifacts.artifact_type');
	});
});

describe('collectRenames', () => {
	it('finds a plain top-level rename', () => {
		const renames: unknown[] = [];
		collectRenames('ALTER TABLE user_preferences RENAME COLUMN dos_hl_config TO dos_config;', renames);
		expect(renames).toEqual([{ table: 'user_preferences', from: 'dos_hl_config', to: 'dos_config' }]);
	});

	it('finds a rename guarded by IF EXISTS inside a DO block body', () => {
		const body = `
			BEGIN
				IF EXISTS (SELECT 1 FROM information_schema.columns WHERE column_name = 'dos_hl_config') THEN
					ALTER TABLE user_preferences RENAME COLUMN dos_hl_config TO dos_config;
				END IF;
			END`;
		const renames: unknown[] = [];
		collectRenames(body, renames);
		expect(renames).toEqual([{ table: 'user_preferences', from: 'dos_hl_config', to: 'dos_config' }]);
	});

	it('ignores a schema-qualified table by keeping only the table part', () => {
		const renames: unknown[] = [];
		collectRenames('ALTER TABLE public.user_preferences RENAME COLUMN a TO b;', renames);
		expect(renames).toEqual([{ table: 'user_preferences', from: 'a', to: 'b' }]);
	});
});

describe('collectComments', () => {
	it('resolves a single-quoted comment via its placeholder', () => {
		const { clean, strings } = tokenize(commentStmt('user_preferences.dos_config', 'hello world'));
		expect(collectComments(clean, strings)).toEqual([{ key: 'user_preferences.dos_config', text: 'hello world' }]);
	});

	it('resolves a dollar-quoted comment via its placeholder', () => {
		const { clean, strings } = tokenize(dollarCommentStmt('user_preferences.dos_config', "an objective's identity"));
		expect(collectComments(clean, strings)).toEqual([
			{ key: 'user_preferences.dos_config', text: "an objective's identity" },
		]);
	});

	it('treats COMMENT ... IS NULL as clearing the comment', () => {
		const { clean, strings } = tokenize('COMMENT ON COLUMN t.c IS NULL;');
		expect(collectComments(clean, strings)).toEqual([{ key: 't.c', text: '' }]);
	});

	it('finds every statement in source order', () => {
		const sql = [commentStmt('t.a', 'first'), commentStmt('t.b', 'second')].join('\n');
		const { clean, strings } = tokenize(sql);
		expect(collectComments(clean, strings)).toEqual([
			{ key: 't.a', text: 'first' },
			{ key: 't.b', text: 'second' },
		]);
	});
});

describe('extractMarkers', () => {
	it('finds no marker in a plain file', () => {
		expect(extractMarkers('SELECT 1;')).toEqual(new Set());
	});

	it('finds a blanket marker', () => {
		expect(extractMarkers('-- ALLOW-COMMENT-SHRINK\nSELECT 1;')).toEqual(new Set(['*']));
	});

	it('finds a column-scoped marker, lowercased', () => {
		expect(extractMarkers('-- ALLOW-COMMENT-SHRINK: User_Preferences.Dos_Config')).toEqual(
			new Set(['user_preferences.dos_config'])
		);
	});

	it('collects more than one scoped marker', () => {
		expect(
			extractMarkers('-- ALLOW-COMMENT-SHRINK: t.a\n-- ALLOW-COMMENT-SHRINK: t.b')
		).toEqual(new Set(['t.a', 't.b']));
	});
});

describe('extractCapsPhrases', () => {
	it('extracts a run of 3+ shout-words, punctuation stripped', () => {
		expect(extractCapsPhrases('so NEVER RENAME AN OPTION, ONLY ADD. it matters')).toEqual([
			'NEVER RENAME AN OPTION ONLY ADD',
		]);
	});

	it('ignores a lone 1-2 word capitalised term', () => {
		expect(extractCapsPhrases('A PILLAR is not OK here')).toEqual([]);
	});

	it('does not treat a hyphenated identifier as a shout-word', () => {
		expect(extractCapsPhrases('see ADR-054 SECTION FIVE for the P0-P4 scale')).toEqual([]);
	});

	it('does not treat a hashtag reference as a shout-word', () => {
		expect(extractCapsPhrases('fixed by NEVER SKIP THIS in #715')).toEqual(['NEVER SKIP THIS']);
	});

	it('finds more than one phrase in one comment', () => {
		expect(
			extractCapsPhrases('EVERY CONFIGURED VALUE MUST EXIST IN NOTION, but not the reverse. NEVER RENAME AN OPTION, ONLY ADD.')
		).toEqual(['EVERY CONFIGURED VALUE MUST EXIST IN NOTION', 'NEVER RENAME AN OPTION ONLY ADD']);
	});
});

describe('normalizeWhitespace', () => {
	it('collapses newlines and repeated spaces to one space', () => {
		expect(normalizeWhitespace('a\n\n  b   c\t d')).toBe('a b c d');
	});
});

// ---------------------------------------------------------------------------
// buildResult — the end-to-end behaviour
// ---------------------------------------------------------------------------

const file = (name: string, sql: string) => ({ name, sql });

describe('buildResult — the 090 -> 097 shape', () => {
	const files = [
		file('20260101000000_001_add_col.sql', commentStmt('user_preferences.dos_hl_config', 'x'.repeat(2822))),
		file(
			'20260102000000_002_rename.sql',
			[
				'ALTER TABLE user_preferences RENAME COLUMN dos_hl_config TO dos_config;',
				commentStmt('user_preferences.dos_config', 'y'.repeat(416)),
			].join('\n')
		),
	];

	it('is invisible when the shrinking file is NOT new (already merged history)', () => {
		const result = buildResult({ files, newFiles: new Set() });
		expect(result.ok).toBe(true);
		expect(result.violations).toEqual([]);
	});

	it('is caught when the shrinking file IS new', () => {
		const result = buildResult({ files, newFiles: new Set(['20260102000000_002_rename.sql']) });
		expect(result.ok).toBe(false);
		expect(kinds(result.violations)).toEqual(['comment-shrink']);
		expect(result.violations[0]).toMatchObject({
			key: 'user_preferences.dos_config',
			file: '20260102000000_002_rename.sql',
			previousFile: '20260101000000_001_add_col.sql',
			previousLength: 2822,
			newLength: 416,
		});
	});

	it('is not caught if the FIRST file is new but the second (the actual shrink) is not', () => {
		const result = buildResult({ files, newFiles: new Set(['20260101000000_001_add_col.sql']) });
		expect(result.ok).toBe(true);
	});
});

describe('buildResult — dropped capitals-phrase without a length halving', () => {
	const oldText = 'NEVER RENAME AN OPTION, ONLY ADD. Some more text padding this out to a longer length overall.';
	const newText = 'Some more text of about the same length as before, but the rule itself is simply gone now too.';

	const files = [
		file('20260101000000_001_add.sql', commentStmt('t.c', oldText)),
		file('20260102000000_002_rewrite.sql', commentStmt('t.c', newText)),
	];

	it('flags the dropped rule even though the length barely moved', () => {
		const result = buildResult({ files, newFiles: new Set(['20260102000000_002_rewrite.sql']) });
		expect(kinds(result.violations)).toEqual(['comment-dropped-rule']);
		expect(result.violations[0]).toMatchObject({ phrase: 'NEVER RENAME AN OPTION ONLY ADD' });
	});
});

describe('buildResult — growth is never a violation', () => {
	const files = [
		file('20260101000000_001_short.sql', commentStmt('t.c', 'short')),
		file('20260102000000_002_longer.sql', commentStmt('t.c', 'a much longer and more complete explanation than before')),
	];

	it('passes when a migration only grows a comment', () => {
		const result = buildResult({ files, newFiles: new Set(['20260102000000_002_longer.sql']) });
		expect(result.ok).toBe(true);
	});
});

describe('buildResult — first-ever comment on a column', () => {
	it('is never a regression — there is nothing to compare against', () => {
		const files = [file('20260101000000_001_add.sql', commentStmt('t.c', 'anything at all'))];
		const result = buildResult({ files, newFiles: new Set(['20260101000000_001_add.sql']) });
		expect(result.ok).toBe(true);
	});
});

describe('buildResult — escape hatch', () => {
	const files = [
		file('20260101000000_001_add.sql', commentStmt('t.c', 'NEVER RENAME AN OPTION, ONLY ADD. ' + 'x'.repeat(200))),
		file(
			'20260102000000_002_shrink.sql',
			['-- ALLOW-COMMENT-SHRINK', commentStmt('t.c', 'short')].join('\n')
		),
	];

	it('a blanket marker suppresses both shrink and dropped-rule findings', () => {
		const result = buildResult({ files, newFiles: new Set(['20260102000000_002_shrink.sql']) });
		expect(result.ok).toBe(true);
	});

	it('a marker scoped to a DIFFERENT column does not suppress this one', () => {
		const scoped = files.map((f) =>
			f.name === '20260102000000_002_shrink.sql'
				? { ...f, sql: f.sql.replace('-- ALLOW-COMMENT-SHRINK', '-- ALLOW-COMMENT-SHRINK: other.column') }
				: f
		);
		const result = buildResult({ files: scoped, newFiles: new Set(['20260102000000_002_shrink.sql']) });
		expect(result.ok).toBe(false);
	});

	it('a marker scoped to THIS column suppresses it', () => {
		const scoped = files.map((f) =>
			f.name === '20260102000000_002_shrink.sql'
				? { ...f, sql: f.sql.replace('-- ALLOW-COMMENT-SHRINK', '-- ALLOW-COMMENT-SHRINK: t.c') }
				: f
		);
		const result = buildResult({ files: scoped, newFiles: new Set(['20260102000000_002_shrink.sql']) });
		expect(result.ok).toBe(true);
	});

	it('does NOT treat marker text found only inside a comment STRING as a real marker', () => {
		// The marker substring appears verbatim, but as part of the column comment's
		// own text (a single-quoted literal), not as an actual SQL `--` comment. A
		// naive raw-text scan would wrongly suppress this — the guard must not.
		const stringOnly = [
			file(
				'20260101000000_001_add.sql',
				commentStmt('t.c', 'NEVER RENAME AN OPTION, ONLY ADD. ' + 'x'.repeat(200))
			),
			file(
				'20260102000000_002_shrink.sql',
				commentStmt('t.c', 'mentions -- ALLOW-COMMENT-SHRINK inside the text itself, not a real comment')
			),
		];
		const result = buildResult({ files: stringOnly, newFiles: new Set(['20260102000000_002_shrink.sql']) });
		expect(result.ok).toBe(false);
		expect(kinds(result.violations).sort()).toEqual(['comment-dropped-rule', 'comment-shrink']);
	});

	it('a scoped marker written with a schema prefix (as it naturally appears in the COMMENT statement) still suppresses', () => {
		const schemaQualified = [
			file(
				'20260101000000_001_add.sql',
				commentStmt('public.user_preferences.dos_config', 'x'.repeat(1000))
			),
			file(
				'20260102000000_002_shrink.sql',
				[
					'-- ALLOW-COMMENT-SHRINK: public.user_preferences.dos_config',
					commentStmt('public.user_preferences.dos_config', 'short'),
				].join('\n')
			),
		];
		const result = buildResult({ files: schemaQualified, newFiles: new Set(['20260102000000_002_shrink.sql']) });
		expect(result.ok).toBe(true);
	});
});

describe('blankLiterals', () => {
	it('drops single-quoted content but keeps a line comment intact', () => {
		expect(blankLiterals("SELECT 'secret'; -- ALLOW-COMMENT-SHRINK")).toBe('SELECT ; -- ALLOW-COMMENT-SHRINK');
	});

	it('drops an entire dollar-quoted span, apostrophes and all, without desyncing what follows', () => {
		const sql = "COMMENT ON COLUMN t.c IS $c$an objective's identity$c$; -- ALLOW-COMMENT-SHRINK";
		expect(blankLiterals(sql)).toBe('COMMENT ON COLUMN t.c IS ; -- ALLOW-COMMENT-SHRINK');
	});
});

describe('normalizeMarkerScope', () => {
	it('leaves a bare table.column alone', () => {
		expect(normalizeMarkerScope('user_preferences.dos_config')).toBe('user_preferences.dos_config');
	});

	it('drops a schema prefix to match columnKeyFromRef output', () => {
		expect(normalizeMarkerScope('public.user_preferences.dos_config')).toBe('user_preferences.dos_config');
	});

	it('lowercases and trims', () => {
		expect(normalizeMarkerScope(' Public.User_Preferences.Dos_Config ')).toBe('user_preferences.dos_config');
	});
});

describe('buildResult — rename carries the comment forward', () => {
	it('compares a rename-then-recomment migration against the PRE-rename text', () => {
		const files = [
			file('20260101000000_001_add.sql', commentStmt('user_preferences.dos_hl_config', 'x'.repeat(1000))),
			file(
				'20260102000000_002_rename_only.sql',
				'ALTER TABLE user_preferences RENAME COLUMN dos_hl_config TO dos_config;'
			),
			file('20260103000000_003_recomment.sql', commentStmt('user_preferences.dos_config', 'y'.repeat(100))),
		];
		const result = buildResult({ files, newFiles: new Set(['20260103000000_003_recomment.sql']) });
		expect(result.ok).toBe(false);
		expect(result.violations[0]).toMatchObject({
			key: 'user_preferences.dos_config',
			previousFile: '20260101000000_001_add.sql',
			previousLength: 1000,
		});
	});

	it('a rename with no prior comment carries nothing forward and cannot violate', () => {
		const files = [
			file('20260101000000_001_rename.sql', 'ALTER TABLE t RENAME COLUMN a TO b;'),
			file('20260102000000_002_comment.sql', commentStmt('t.b', 'first ever comment')),
		];
		const result = buildResult({ files, newFiles: new Set(files.map((f) => f.name)) });
		expect(result.ok).toBe(true);
	});
});

describe('buildResult — counts and multiple violations', () => {
	it('reports both a shrink and a dropped-rule for the same statement independently', () => {
		const oldText = 'NEVER RENAME AN OPTION, ONLY ADD. ' + 'x'.repeat(2000);
		const files = [
			file('20260101000000_001_add.sql', commentStmt('t.c', oldText)),
			file('20260102000000_002_shrink.sql', commentStmt('t.c', 'tiny')),
		];
		const result = buildResult({ files, newFiles: new Set(['20260102000000_002_shrink.sql']) });
		expect(kinds(result.violations).sort()).toEqual(['comment-dropped-rule', 'comment-shrink']);
	});

	it('counts files, new files, statements and renames', () => {
		const files = [
			file('20260101000000_001_add.sql', commentStmt('t.a', 'one')),
			file('20260102000000_002_rename.sql', 'ALTER TABLE t RENAME COLUMN a TO b;'),
		];
		const result = buildResult({ files, newFiles: new Set(['20260102000000_002_rename.sql']) });
		expect(result.counts).toEqual({ files: 2, newFiles: 1, commentStatements: 1, renames: 1 });
	});
});

describe('formatReport', () => {
	it('reports OK with the scanned/new counts on a clean run', () => {
		const result = buildResult({ files: [file('a.sql', commentStmt('t.c', 'x'))], newFiles: new Set() });
		const report = formatReport(result).join('\n');
		expect(report).toContain('Scanned 1 file(s) (0 new)');
		expect(report).toContain('OK: no unexplained column-comment regression');
	});

	it('names the column, the file and the fix on a shrink', () => {
		const files = [
			file('20260101000000_001_add.sql', commentStmt('t.c', 'x'.repeat(100))),
			file('20260102000000_002_shrink.sql', commentStmt('t.c', 'y')),
		];
		const report = formatReport(
			buildResult({ files, newFiles: new Set(['20260102000000_002_shrink.sql']) })
		).join('\n');
		expect(report).toContain('SHRINK: supabase/migrations/20260102000000_002_shrink.sql');
		expect(report).toContain('t.c');
		expect(report).toContain('ALLOW-COMMENT-SHRINK');
	});
});

describe('annotate', () => {
	it('anchors a shrink violation to its file', () => {
		const lines: string[] = [];
		const spy = jest.spyOn(console, 'log').mockImplementation((line?: unknown) => {
			lines.push(String(line));
		});
		try {
			annotate({ kind: 'comment-shrink', key: 't.c', file: 'x.sql', previousFile: 'y.sql', previousLength: 10, newLength: 1 });
		} finally {
			spy.mockRestore();
		}
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^::error file=supabase\/migrations\/x\.sql::SHRINK: /);
	});
});
