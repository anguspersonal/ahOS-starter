/**
 * Guards the Discover & Index `lifecycle_stage` vocabulary (issue #586).
 *
 * Before this, `discover.ts`, `enrichNext.ts`, and `search.ts` each carried their own
 * hand-typed copy of the "discovered"/"extracted"/"failed" strings, and the *shared*
 * `LifecycleStage` type in `@ahkms/shared` had already drifted from them -- it listed
 * `extracted`/`failed` but not `discovered` (round-1 QA review on #581, finding L1).
 * `DISCOVER_INDEX_STAGES` in `packages/mcp-server/src/vocab.ts` is now the single
 * source those three files import from (mirroring `TASK_REQUEST_CONTENT_SUBTYPE`'s
 * "writer and reader can never drift on the string" treatment).
 *
 * Two kinds of assertion below: runtime checks on the vocabulary itself (would fail
 * if someone edited `DISCOVER_INDEX_STAGES`/`UNENRICHED_STAGES` inconsistently), and a
 * static source scan of the three write sites (would fail if someone reintroduced a
 * hand-typed copy of the literal instead of importing the constant -- the exact
 * regression #586 exists to prevent, and not something a runtime check on vocab.ts
 * alone could ever catch).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DISCOVER_INDEX_STAGES,
	DISCOVERED_STAGE,
	EXTRACTED_STAGE,
	FAILED_STAGE,
	UNENRICHED_STAGES,
	ENRICHED_STAGES,
} from "../vocab.js";

const TOOLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tools");

function readTool(file: string): string {
	return readFileSync(resolve(TOOLS_DIR, file), "utf-8");
}

describe("DISCOVER_INDEX_STAGES is the single source for the Discover & Index lifecycle_stage vocabulary", () => {
	it("pins the exact three stages the pipeline writes/reads", () => {
		expect([...DISCOVER_INDEX_STAGES].sort()).toEqual(["discovered", "extracted", "failed"]);
	});

	it("keeps DISCOVERED_STAGE / EXTRACTED_STAGE / FAILED_STAGE as the tuple's own members (no second copy of the strings)", () => {
		expect(DISCOVER_INDEX_STAGES).toContain(DISCOVERED_STAGE);
		expect(DISCOVER_INDEX_STAGES).toContain(EXTRACTED_STAGE);
		expect(DISCOVER_INDEX_STAGES).toContain(FAILED_STAGE);
	});

	it("derives UNENRICHED_STAGES as exactly {discovered, failed}, excluding the enriched terminal stage", () => {
		expect(new Set(UNENRICHED_STAGES)).toEqual(new Set([DISCOVERED_STAGE, FAILED_STAGE]));
		expect(UNENRICHED_STAGES.has(EXTRACTED_STAGE)).toBe(false);
	});

	it("covers every DISCOVER_INDEX_STAGES member as either unenriched or the enriched terminal stage (nothing falls through both)", () => {
		for (const stage of DISCOVER_INDEX_STAGES) {
			expect(UNENRICHED_STAGES.has(stage) || stage === EXTRACTED_STAGE).toBe(true);
		}
	});

	it("defines ENRICHED_STAGES disjoint from UNENRICHED_STAGES (#1726)", () => {
		for (const stage of ENRICHED_STAGES) {
			expect(UNENRICHED_STAGES.has(stage), `${stage} must not be in UNENRICHED_STAGES`).toBe(false);
		}
		expect(ENRICHED_STAGES).toContain(EXTRACTED_STAGE);
	});
});

/**
 * The names actually bound by a file's `import { ... } from "../vocab.js"` statement
 * -- NOT a whole-file substring search. Whole-file `toContain` was round-1 QA finding
 * H1 on PR #774: it passes for a name that merely appears anywhere in the file, so a
 * local re-declaration (`const UNENRICHED_STAGES = new Set([...])`) satisfies "imports
 * UNENRICHED_STAGES" just as well as a real import does. Scoping to the import
 * specifier list closes that hole for all three files at once: keeping a name in both
 * the import list AND as a local declaration is a duplicate-identifier compile error,
 * so a re-declaration necessarily drops the name from here.
 *
 * `[^{}]*` (not `[\s\S]*?`) between the braces: it still spans the multi-line import
 * form (search.ts's real import block runs over several lines; `[^{}]` matches
 * newlines fine, it just excludes brace characters), but critically it CANNOT cross
 * another import statement's own braces to reach the vocab import further down the
 * file. A lazy `[\s\S]*?` looked equivalent in isolation but is not: `.match()` tries
 * the leftmost possible start first, and every file here starts with `import { z }
 * from "zod";` -- a lazy dot-all class happily backtracks THROUGH that unrelated `}`
 * and keeps consuming everything up to the vocab import's closing brace, so the
 * "captured" group became the entire file in between (caught by actually running
 * these tests, not just reading the regex).
 */
function namesImportedFromVocab(source: string): string[] {
	const match = source.match(/import\s*(?:type\s*)?\{([^{}]*)\}\s*from\s*["']\.\.\/vocab\.js["']/);
	if (!match) return [];
	return match[1]
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
}

/**
 * Shapes a reintroduced hand-typed copy of the vocabulary could take (round-1 QA
 * finding M2 on PR #774, widening the original single-pattern check). Each is scoped
 * enough to have zero false positives against these three files' real content
 * (verified: discover.ts's unrelated `new Set(["notion"])`, search.ts's `new
 * Set(excluded)` / `new Set(consumedIds)`, and every `lifecycle_stage='discovered'` /
 * `lifecycle_stage 'discovered'` prose comment all correctly do NOT match).
 */
const RAW_LITERAL_PATTERNS: readonly RegExp[] = [
	// lifecycle_stage: "discovered"   /   .eq("lifecycle_stage", "discovered")
	/lifecycle_stage["']?\s*[,:]\s*["'](discovered|extracted|failed)["']/,
	// .in("lifecycle_stage", ["discovered", "failed"])
	/\.in\(\s*["']lifecycle_stage["']\s*,\s*\[[^\]]*["'](discovered|extracted|failed)["']/,
	// PostgREST dotted filter: lifecycle_stage.eq.discovered / lifecycle_stage.not.in.(discovered,failed)
	// -- the shape search.ts:543 itself builds, but via interpolation, never a literal.
	/lifecycle_stage\.(?:eq|neq|in|not\.in)\.\(?(discovered|extracted|failed)/,
	// A bare Set literal of the vocabulary values -- the exact PR #774 round-1 QA
	// repro (drop the vocab.ts import, restore `new Set(["discovered", "failed"])`).
	/new Set\(\s*\[[^\]]*["'](discovered|extracted|failed)["']/,
];

function findRawLifecycleStageLiteral(source: string): string | null {
	for (const pattern of RAW_LITERAL_PATTERNS) {
		const match = source.match(pattern);
		if (match) return match[0];
	}
	return null;
}

describe("discover.ts / enrichNext.ts / search.ts import the vocab instead of re-declaring the literals (#586)", () => {
	const CASES: { file: string; mustImport: string[] }[] = [
		{ file: "discover.ts", mustImport: ["DISCOVERED_STAGE"] },
		{ file: "enrichNext.ts", mustImport: ["DISCOVERED_STAGE", "EXTRACTED_STAGE", "FAILED_STAGE"] },
		{ file: "search.ts", mustImport: ["UNENRICHED_STAGES", "ENRICHED_STAGES"] },
	];

	for (const { file, mustImport } of CASES) {
		it(`${file} imports its lifecycle_stage constant(s) from vocab.ts`, () => {
			const source = readTool(file);
			const imported = namesImportedFromVocab(source);
			expect(imported.length, `${file} should have an import from ../vocab.js`).toBeGreaterThan(0);
			for (const name of mustImport) {
				expect(imported, `${file} should import ${name} from vocab.ts (found: ${imported.join(", ")})`).toContain(name);
			}
		});

		it(`${file} contains no hand-typed lifecycle_stage literal (the copy #586 removed)`, () => {
			const source = readTool(file);
			const found = findRawLifecycleStageLiteral(source);
			expect(found, `${file} should reference the stage via a vocab.ts constant, not a raw literal (found: ${found})`).toBeNull();
		});
	}
});

/**
 * Round-1 QA on PR #774 mutation-probed the two checks above by reverting search.ts to
 * its exact pre-PR drifted state (drop `UNENRICHED_STAGES` from the vocab.ts import,
 * restore the local `const UNENRICHED_STAGES = new Set([...])`) and found both checks
 * passed anyway -- a guard that cannot fail is worse than none, since it reports
 * success for the exact regression #586 exists to prevent. This fixture pins that
 * finding as an executable test (per the review's own suggestion) rather than trusting
 * a one-off manual repro: a synthetic stand-in for search.ts's real import block and
 * local declaration, run through the same two helper functions the tests above use,
 * on both the broken shape (must fail) and the intact shape (must pass).
 */
describe("regression fixture: the exact search.ts revert round-1 QA used to break PR #774's guards", () => {
	const DRIFTED_SEARCH_TS = [
		"import {",
		"\tTASK_REQUEST_CONTENT_SUBTYPE,",
		"\tEVENT_REQUEST_CONTENT_SUBTYPE,",
		"\tDAILY_LOG_CONTENT_SUBTYPE,",
		'} from "../vocab.js";',
		"",
		'const UNENRICHED_STAGES: ReadonlySet<string> = new Set(["discovered", "failed"]);',
		"",
	].join("\n");

	const INTACT_SEARCH_TS = [
		"import {",
		"\tTASK_REQUEST_CONTENT_SUBTYPE,",
		"\tEVENT_REQUEST_CONTENT_SUBTYPE,",
		"\tDAILY_LOG_CONTENT_SUBTYPE,",
		"\tUNENRICHED_STAGES,",
		'} from "../vocab.js";',
		"",
	].join("\n");

	it("FAILS the import check on the drifted shape (UNENRICHED_STAGES dropped from the import)", () => {
		expect(namesImportedFromVocab(DRIFTED_SEARCH_TS)).not.toContain("UNENRICHED_STAGES");
	});

	it("FAILS the raw-literal scan on the drifted shape (the restored local declaration)", () => {
		expect(findRawLifecycleStageLiteral(DRIFTED_SEARCH_TS)).not.toBeNull();
	});

	it("PASSES both checks on the intact (post-PR) shape", () => {
		expect(namesImportedFromVocab(INTACT_SEARCH_TS)).toContain("UNENRICHED_STAGES");
		expect(findRawLifecycleStageLiteral(INTACT_SEARCH_TS)).toBeNull();
	});
});
