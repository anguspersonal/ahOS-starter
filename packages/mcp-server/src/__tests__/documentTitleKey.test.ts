import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TITLE_KEY_SQL_PATTERNS, documentTitleKey } from "../tools/documentTitleKey.js";
import { FAMILY_READ_CAP, QUERY_TITLE_CAP } from "../tools/documentDuplicates.js";

// #1217: the version-family key. `public.document_title_key` (migration 119) is the
// normaliser that runs; documentTitleKey.ts mirrors it so the behaviour is testable
// here. The second block pins the two together over the committed SQL text, the
// same static lockstep guard termNodesMigration.test.ts uses -- no database.

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../supabase/migrations");

function readMigration119(): string {
	const file = readdirSync(migrationsDir).find((f) => /_119_/.test(f));
	if (!file) throw new Error(`migration 119 not found in ${migrationsDir}`);
	return readFileSync(join(migrationsDir, file), "utf8");
}

function readMigration150(): string {
	const file = readdirSync(migrationsDir).find((f) => /_150_/.test(f));
	if (!file) throw new Error(`migration 150 not found in ${migrationsDir}`);
	return readFileSync(join(migrationsDir, file), "utf8");
}

describe("documentTitleKey — the version-family key", () => {
	it("maps the issue's three CV titles to one family", () => {
		// The acceptance-criterion examples from #1217: a Drive copy with a copy
		// counter, a MultCloud backup suffix, and a month/year-dated export.
		const keys = [
			"Copy of Angus Hally CV Feb 23 (3).docx",
			"Angus Hally CV Mar 21-v20250622131750.pdf",
			"Angus Hally CV Jun 24.pdf",
		].map(documentTitleKey);
		expect(new Set(keys)).toEqual(new Set(["angus hally cv"]));
		expect(documentTitleKey("Angus Hally CV.pdf")).toBe("angus hally cv");
	});

	it.each([
		["Angus Hally CV Sept 2015.pdf", "angus hally cv"],
		["Angus Hally CV Jan 2018.docx", "angus hally cv"],
		["Copy of Copy of RT - MP Challenge Tracker 2.xlsx", "rt mp challenge tracker"],
		["google driver file directory 3.xlsx", "google driver file directory"],
		["Budget (1) (2).xlsx", "budget"],
		["Angus Hally Oliver Wyman Cover Letter April 2017.docx", "angus hally oliver wyman cover letter"],
		["CV_Oct2022", "cv"],
		["Curriculum_vitae_2026", "curriculum vitae"],
		["Product Management CV", "product management cv"],
		["  Leading and trailing  ", "leading and trailing"],
		["Mr. Smith", "mr smith"],
		["Tab\tseparated.txt", "tab separated"],
		["résumé Mai 2021.pdf", "résumé mai"],
	])("normalises %j to %j", (title, key) => {
		expect(documentTitleKey(title)).toBe(key);
	});

	it("keeps a distinct variant in its own family", () => {
		// "Short v.04" is a different document from the plain CV, not a copy of it.
		expect(documentTitleKey("Angus Hally CV Nov 2020 Short v.04-v20250622131750.docx")).toBe(
			"angus hally cv short v",
		);
	});

	it("returns null for a title that is nothing but dates, and for no title", () => {
		expect(documentTitleKey("2023.pdf")).toBeNull();
		expect(documentTitleKey("copy of copy of 12")).toBeNull();
		expect(documentTitleKey("")).toBeNull();
		expect(documentTitleKey(null)).toBeNull();
		expect(documentTitleKey(undefined)).toBeNull();
	});

	it("returns null for macOS OS junk (.DS_Store, ._* AppleDouble forks) and bare untitled (#2099)", () => {
		expect(documentTitleKey(".DS_Store")).toBeNull();
		expect(documentTitleKey("Copy of .DS_Store (1)")).toBeNull();
		expect(documentTitleKey("._Angus Hally CV.pdf")).toBeNull();
		expect(documentTitleKey("  ._Budget 2025.xlsx")).toBeNull();
		expect(documentTitleKey("Untitled")).toBeNull();
		expect(documentTitleKey("Untitled (2).docx")).toBeNull();
		expect(documentTitleKey("Copy of Untitled 2024.pdf")).toBeNull();
		// A qualified untitled placeholder or real document title with "untitled" remains distinct
		expect(documentTitleKey("(untitled gdrive)")).toBe("untitled gdrive");
	});

	it("never adds a character a title did not have, so every key token is in the title", () => {
		// The key only removes text: a family is titles that differ by copy markers,
		// dates and extensions, never by something the normaliser made up.
		for (const title of [
			"Copy of Angus Hally CV Feb 23 (3).docx",
			"W8R Bertrand et al AER 2005 PH225.pdf",
			"IMG_20230512_102345.jpg",
			"notes_final-FINAL (copy).md",
		]) {
			const key = documentTitleKey(title);
			for (const token of key?.split(" ") ?? []) {
				expect(title.toLowerCase(), `${token} from ${title}`).toContain(token);
			}
		}
	});
});

describe("migration 119 & 150 — lockstep with the TypeScript mirror", () => {
	const sql119 = readMigration119();
	const sql150 = readMigration150();

	it("claims numbers 119 and 150 exactly once", () => {
		expect(readdirSync(migrationsDir).filter((f) => /_119_/.test(f))).toHaveLength(1);
		expect(readdirSync(migrationsDir).filter((f) => /_150_/.test(f))).toHaveLength(1);
	});

	it.each(Object.entries(TITLE_KEY_SQL_PATTERNS))("uses the %s pattern verbatim in migration 150", (_name, pattern) => {
		expect(sql150).toContain(`'${pattern}'`);
	});

	it("collapses punctuation with the POSIX class the TypeScript mirrors by intent, not by text", () => {
		// Step 5 is deliberately not in TITLE_KEY_SQL_PATTERNS: JavaScript has no
		// `[:alnum:]`, so pinning the string would prove nothing about behaviour.
		expect(sql119).toContain("'[^[:alnum:]]+', ' ', 'g'");
		expect(sql150).toContain("'[^[:alnum:]]+', ' ', 'g'");
		expect(Object.values(TITLE_KEY_SQL_PATTERNS)).not.toContain("[^[:alnum:]]+");
	});

	it("creates document_title_key as an immutable function and reindexes idx_artifacts_discovered_title_key (#2099)", () => {
		expect(sql119).toMatch(/create or replace function public\.document_title_key\(p_title text\)\s+returns text\s+language sql\s+immutable/);
		expect(sql150).toMatch(/create or replace function public\.document_title_key\(p_title text\)\s+returns text\s+language sql\s+immutable/);
		expect(sql150).toContain("REINDEX INDEX public.idx_artifacts_discovered_title_key;");
	});

	it("keeps p_query seed scans and connector filters on idx_artifacts_discovered_title_key and bounds exact_src (#2099)", () => {
		expect(sql150).toMatch(/^SET statement_timeout = '\d+(s|min)';$/m);
		expect(sql150).not.toMatch(/SET LOCAL/i);
		// Query seed branch must include document_title_key(a.title) is not null so the planner can use the covering index
		expect(sql150).toMatch(
			/into v_seed_count, v_seed_ids, v_seed_keys[\s\S]*?and public\.document_title_key\(a\.title\) is not null\s+and a\.title ilike v_pattern/,
		);
		// Connector filter prevents idx_artifacts_user_channel_source fallback
		expect(sql150).toContain("and (v_channel is null or a.source_channel || '' = v_channel)");
		// exact_src bounds per-md5 heap reads with LATERAL (... ORDER BY a.originated_at DESC NULLS LAST, a.id LIMIT c_family_read)
		expect(sql150).toMatch(
			/exact_src as materialized \([\s\S]*?from exact_counts ec\s+cross join lateral \([\s\S]*?order by a\.originated_at desc nulls last, a\.id\s+limit c_family_read\s+\) p/,
		);
	});
});

describe("migration 119 — the pointer-index indexes the RPCs rely on", () => {
	const sql = readMigration119();
	const POINTERS = "source_channel like 'discovered\\_%'";

	it("stores the title key in a covering partial index", () => {
		expect(sql).toContain(
			[
				"create index if not exists idx_artifacts_discovered_title_key",
				"  on public.artifacts (user_id, public.document_title_key(title))",
				"  include (id, title, archived, source_channel, originated_at)",
				`  where ${POINTERS} and octet_length(title) <= 1000;`,
			].join("\n"),
		);
	});

	it("indexes the Drive md5 of discovered pointers", () => {
		expect(sql).toContain(
			"on public.artifacts (user_id, (processing_metadata #>> '{discovery,content_hash}'))",
		);
	});

	it("repeats the title-key index's predicate verbatim wherever it means to use it", () => {
		// The planner uses a partial index only when it can prove the query implies the
		// predicate; the same text on both sides is how that proof is guaranteed.
		// Full run, query seeds, query families, member pick, candidates: five reads.
		const reads = sql.match(/a\.source_channel like 'discovered\\_%'\s+and octet_length\(a\.title\) <= 1000/g) ?? [];
		expect(reads).toHaveLength(5);
	});

	it("warns that replacing document_title_key needs a REINDEX", () => {
		expect(sql).toContain("REINDEX INDEX public.idx_artifacts_discovered_title_key");
	});
});

describe("migration 119 — document_duplicate_clusters bounds", () => {
	const sql = readMigration119();

	it("pins the per-family read and the query-title cap the tool words its output with", () => {
		expect(sql).toContain(`c_family_read  constant int := ${FAMILY_READ_CAP};`);
		expect(sql).toContain(`c_seed_cap     constant int := ${QUERY_TITLE_CAP};`);
		expect(sql).toMatch(/using errcode = '54000'/);
	});

	it("never reports the md5 of empty content as an exact cluster", () => {
		expect(sql).toMatch(/and x\.h <> 'd41d8cd98f00b204e9800998ecf8427e'/);
	});

	it("declares the untracked-candidate title search document_resolve calls", () => {
		expect(sql).toMatch(
			/create or replace function public\.document_title_candidates\(\s+p_user_id uuid,\s+p_terms\s+text\[\],\s+p_limit\s+int default 10\s+\)\s+returns setof public\.artifacts/,
		);
		// A term that could act as a LIKE or regex metacharacter is dropped.
		expect(sql).toContain("u.t !~ '[[:punct:][:space:]]'");
	});
});

describe("migration 119 — search RPC signature change", () => {
	const sql = readMigration119();

	it("drops both search RPCs by their exact current (069/071) signature before re-creating them", () => {
		// The 069/071 lesson: CREATE OR REPLACE with a new parameter makes an overload.
		expect(sql).toContain(
			"drop function if exists public.fts_search_artifacts(text, uuid, integer, boolean);",
		);
		expect(sql).toContain(
			"drop function if exists public.hybrid_search_artifacts(text, vector, uuid, integer, double precision, double precision, integer, boolean);",
		);
	});

	it("adds filter_tags as a defaulted trailing parameter, so old named-argument calls still resolve", () => {
		const params = sql.match(/filter_tags\s+text\[\] default null\n\)/g) ?? [];
		expect(params).toHaveLength(2);
	});

	it("filters tags inside every full-text sub-query, before its limit", () => {
		// fts_search_artifacts once, hybrid's fts arm once.
		expect(sql.match(/and \(filter_tags is null or (a\.)?tags @> filter_tags\)/g) ?? []).toHaveLength(2);
	});

	it("ranks the tagged set itself in the semantic arm instead of filtering the HNSW scan", () => {
		// A predicate beside `order by embedding <=> q limit n` is applied after the
		// HNSW index's nearest-neighbour cut, so a selective tag would return nothing.
		expect(sql).toMatch(
			/tagged as materialized \(\s+select id, embedding\s+from public\.artifacts\s+where filter_tags is not null[\s\S]*?and tags @> filter_tags/,
		);
		expect(sql).toMatch(
			/from tagged\s+order by embedding <=> query_embedding\s+limit least\(match_limit, 30\) \* 2/,
		);
		// Without tags, the 069 arm, gated on the pseudoconstant alone.
		expect(sql).toMatch(
			/where filter_tags is null\s+and user_id = match_user_id\s+and \(include_archived or archived = false\)\s+and embedding is not null\s+order by embedding <=> query_embedding/,
		);
	});

	it("declares the duplicates RPC with the batch contract's exact parameters", () => {
		expect(sql).toMatch(
			/create or replace function public\.document_duplicate_clusters\(\s+p_user_id\s+uuid,\s+p_query\s+text\s+default null,\s+p_connector\s+text\s+default null,\s+p_min_cluster\s+int\s+default 2,\s+p_limit\s+int\s+default 20,\s+p_include_archived boolean default false\s+\)/,
		);
	});

	it("only trusts a real md5 as an exact-duplicate key", () => {
		expect(sql).toContain("when m.disc ->> 'content_hash' ~ '^[0-9a-f]{32}$' then 'md5'");
		expect(sql).toMatch(
			/exact_src as materialized \([\s\S]*?and \(a\.processing_metadata #>> '\{discovery,content_hash\}'\) ~ '\^\[0-9a-f\]\{32\}\$'/,
		);
	});

	it("uses SET, never SET LOCAL", () => {
		// Minutes since review round 1: the two index builds each read the whole table.
		expect(sql).toMatch(/^SET statement_timeout = '\d+(s|min)';$/m);
		expect(sql).not.toMatch(/SET LOCAL/i);
	});
});
