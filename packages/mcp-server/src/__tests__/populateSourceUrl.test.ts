import { afterEach, describe, expect, it, vi } from "vitest";

// notion.ts's searchNotion is the actual candidate source (person_match never
// reaches Notion — see the module's own header) — stubbed per test so each case
// controls exactly what each workspace "finds" without a real API call.
const searchNotion = vi.fn();
vi.mock("../notion.js", () => ({
	searchNotion: (...args: unknown[]) => searchNotion(...args),
	notionResultTitle: (r: { title?: string }) => r.title ?? "",
}));

import { supabase } from "../supabase.js";
import { runPopulateSourceUrl } from "../entities/populateSourceUrl.js";

const TEST_USER = "00000000-0000-0000-0000-000000000000"; // from vitest.config env

type FakeEntity = {
	id: string;
	title: string | null;
	entity_type: string;
	archived: boolean;
	user_id: string;
	source_url: string | null;
};

function person(id: string, title: string, overrides: Partial<FakeEntity> = {}): FakeEntity {
	return {
		id,
		title,
		entity_type: "people",
		archived: false,
		user_id: TEST_USER,
		source_url: null,
		...overrides,
	};
}

/**
 * Minimal in-memory fake of the entities table, matching the query shapes
 * populateSourceUrl.ts actually issues: select+filters+order+limit (fetchBatch),
 * a head-count variant (countRemaining), and update+eq (the write). Mirrors the
 * fake in backfill.test.ts, scoped down to what this module needs.
 */
function makeEntitiesMock(initialRows: FakeEntity[]) {
	const table: FakeEntity[] = initialRows.map((r) => ({ ...r }));

	function builder() {
		const filters: Array<(r: FakeEntity) => boolean> = [];
		let orderCol: keyof FakeEntity | null = null;
		let limitN: number | null = null;
		let mode: "select" | "update" | "count" = "select";
		let updatePayload: Partial<FakeEntity> | null = null;

		const b: any = {
			select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
				if (opts?.head) mode = "count";
				return b;
			},
			update: (payload: Partial<FakeEntity>) => {
				mode = "update";
				updatePayload = payload;
				return b;
			},
			eq: (col: keyof FakeEntity, val: unknown) => {
				filters.push((r) => r[col] === val);
				return b;
			},
			is: (col: keyof FakeEntity, val: unknown) => {
				filters.push((r) => r[col] === val);
				return b;
			},
			gt: (col: keyof FakeEntity, val: unknown) => {
				filters.push((r) => (r[col] as unknown as string) > (val as string));
				return b;
			},
			order: (col: keyof FakeEntity) => {
				orderCol = col;
				return b;
			},
			limit: (n: number) => {
				limitN = n;
				return b;
			},
			then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
				try {
					if (mode === "update") {
						const targets = table.filter((r) => filters.every((f) => f(r)));
						for (const target of targets) {
							const nextUrl = updatePayload?.source_url ?? null;
							if (
								nextUrl !== null &&
								table.some((r) => r.id !== target.id && r.user_id === target.user_id && r.source_url === nextUrl)
							) {
								resolve({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } });
								return;
							}
							Object.assign(target, updatePayload);
						}
						resolve({ data: targets, error: null });
						return;
					}
					if (mode === "count") {
						const matched = table.filter((r) => filters.every((f) => f(r)));
						resolve({ count: matched.length, error: null });
						return;
					}
					let rows = table.filter((r) => filters.every((f) => f(r)));
					if (orderCol) rows = [...rows].sort((a, b2) => (a[orderCol as keyof FakeEntity]! < b2[orderCol as keyof FakeEntity]! ? -1 : 1));
					if (limitN !== null) rows = rows.slice(0, limitN);
					resolve({ data: rows, error: null });
				} catch (err) {
					reject(err);
				}
			},
		};
		return b;
	}

	return { table, from: () => builder() };
}

function stubSupabase(rows: FakeEntity[]) {
	const mock = makeEntitiesMock(rows);
	vi.spyOn(supabase, "from").mockImplementation(mock.from as never);
	return mock;
}

afterEach(() => {
	vi.restoreAllMocks();
	searchNotion.mockReset();
});

/** A notion_search result shaped like notion.ts's NotionSearchResult, pre-titled for the mock above. */
function hit(title: string, url: string, archived = false) {
	return { title, url, archived };
}

describe("runPopulateSourceUrl", () => {
	it("writes source_url when exactly one live page across workspaces is an exact name match", async () => {
		stubSupabase([person("1", "Robbie")]);
		searchNotion.mockResolvedValueOnce({ results: [hit("Robbie", "https://notion.so/robbie")] }); // work
		searchNotion.mockResolvedValueOnce({ results: [] }); // angus

		const result = await runPopulateSourceUrl({});

		expect(result.populated).toBe(1);
		expect(result.scanned).toBe(1);
		expect(result.review).toHaveLength(0);
	});

	it("leaves source_url NULL and reports 'ambiguous' when more than one page exactly matches the name (#445's 'Sam' example)", async () => {
		stubSupabase([person("1", "Sam")]);
		searchNotion.mockResolvedValueOnce({
			results: [hit("Sam", "https://notion.so/sam-1"), hit("Sam", "https://notion.so/sam-2")],
		});
		searchNotion.mockResolvedValueOnce({ results: [] });

		const result = await runPopulateSourceUrl({});

		expect(result.populated).toBe(0);
		expect(result.skippedAmbiguous).toBe(1);
		expect(result.review).toEqual([
			expect.objectContaining({ entityId: "1", reason: "ambiguous" }),
		]);
	});

	it("leaves source_url NULL and reports 'low-confidence' for a subset/fuzzy-only match, never guessing", async () => {
		stubSupabase([person("1", "Sam")]);
		// "Sam Altman" is not an exact match for "Sam" — must not be auto-attached.
		searchNotion.mockResolvedValueOnce({ results: [hit("Sam Altman", "https://notion.so/sam-altman")] });
		searchNotion.mockResolvedValueOnce({ results: [] });

		const result = await runPopulateSourceUrl({});

		expect(result.populated).toBe(0);
		expect(result.skippedLowConfidence).toBe(1);
		expect(result.review[0].reason).toBe("low-confidence");
	});

	it("reports 'no-candidate' (not a review item worth writing) when nothing resembles the name in any workspace", async () => {
		stubSupabase([person("1", "Robbie")]);
		searchNotion.mockResolvedValueOnce({ results: [] });
		searchNotion.mockResolvedValueOnce({ results: [] });

		const result = await runPopulateSourceUrl({});

		expect(result.skippedNoCandidate).toBe(1);
		expect(result.review).toHaveLength(0);
	});

	it("ignores archived Notion pages as candidates", async () => {
		stubSupabase([person("1", "Robbie")]);
		searchNotion.mockResolvedValueOnce({ results: [hit("Robbie", "https://notion.so/robbie", true)] });
		searchNotion.mockResolvedValueOnce({ results: [] });

		const result = await runPopulateSourceUrl({});

		expect(result.populated).toBe(0);
		expect(result.skippedNoCandidate).toBe(1);
	});

	it("never violates entities_user_source_url_unique: a second entity's exact match to an already-claimed URL is left NULL and counted as a conflict", async () => {
		stubSupabase([
			person("1", "Robbie", { source_url: "https://notion.so/robbie" }),
			person("2", "Robbie B"),
		]);
		// Only entity 2 is scanned (entity 1 already has source_url); its exact-match
		// candidate happens to collide with entity 1's existing URL.
		searchNotion.mockResolvedValueOnce({ results: [hit("Robbie B", "https://notion.so/robbie")] });
		searchNotion.mockResolvedValueOnce({ results: [] });

		const result = await runPopulateSourceUrl({});

		expect(result.scanned).toBe(1);
		expect(result.populated).toBe(0);
		expect(result.skippedConflict).toBe(1);
	});

	it("dry run scores and reports without writing", async () => {
		const mock = stubSupabase([person("1", "Robbie")]);
		searchNotion.mockResolvedValueOnce({ results: [hit("Robbie", "https://notion.so/robbie")] });
		searchNotion.mockResolvedValueOnce({ results: [] });

		const result = await runPopulateSourceUrl({ dryRun: true });

		expect(result.populated).toBe(1);
		expect(mock.table[0].source_url).toBeNull();
	});

	it("is idempotent: only source_url IS NULL rows are ever selected", async () => {
		stubSupabase([person("1", "Robbie", { source_url: "https://notion.so/robbie" })]);

		const result = await runPopulateSourceUrl({});

		expect(result.scanned).toBe(0);
		expect(searchNotion).not.toHaveBeenCalled();
	});

	it("scopes to entity_type='people' and to the current user", async () => {
		stubSupabase([
			person("1", "Robbie"),
			person("2", "Some Org", { entity_type: "organization" }),
			person("3", "Other User", { user_id: "11111111-1111-1111-1111-111111111111" }),
		]);
		searchNotion.mockResolvedValue({ results: [] });

		const result = await runPopulateSourceUrl({});

		expect(result.scanned).toBe(1);
	});

	it("counts a notion_search failure as failed and continues the batch", async () => {
		stubSupabase([person("1", "Robbie"), person("2", "Lynsay")]);
		searchNotion.mockRejectedValueOnce(new Error("Notion search failed (500)"));
		searchNotion.mockResolvedValueOnce({ results: [] }); // Robbie / angus
		searchNotion.mockResolvedValueOnce({ results: [hit("Lynsay", "https://notion.so/lynsay")] }); // Lynsay / work
		searchNotion.mockResolvedValueOnce({ results: [] }); // Lynsay / angus

		const result = await runPopulateSourceUrl({});

		expect(result.failed).toBe(1);
		expect(result.populated).toBe(1);
		expect(result.scanned).toBe(2);
	});
});
