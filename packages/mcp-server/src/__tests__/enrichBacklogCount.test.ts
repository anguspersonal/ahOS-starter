import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "../supabase.js";
import { enrichNextCore, enrichNextHandler } from "../tools/enrichNext.js";
import { NOT_A_FOLDER_FILTER } from "@ahkms/core";

// #1209 / #1228: ingest_enrich_next's backlog count and its selection.
//
// The count was `count: "exact"` over ~150k Drive pointer rows. It timed out
// (57014) on every scheduled run, the error was dropped, and `count ?? 0` turned
// the timeout into "the backlog is empty". These pin the three halves of the fix:
// the count asks for an estimate, a count error comes back as null plus a reason
// (never 0), and both the count and the selection skip recorded Drive folders.
//
// Selection shape only, as in enrichNextArchivedArtifacts.test.ts: the row query
// returns no rows, so enrichOne()'s Drive fetch is never reached.

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

type Recorded = { selectArgs: unknown[][]; orArgs: unknown[] };

/** A chain whose row query returns [] and whose head count resolves to `countResult`. */
function stubArtifacts(countResult: { count: number | null; error: { message: string } | null }): Recorded {
	const recorded: Recorded = { selectArgs: [], orArgs: [] };
	(supabase as any).from = vi.fn(() => {
		const b: any = {
			select: (...args: unknown[]) => {
				recorded.selectArgs.push(args);
				return b;
			},
			eq: () => b,
			in: () => b,
			or: (filter: unknown) => {
				recorded.orArgs.push(filter);
				return b;
			},
			order: () => b,
			limit: () => Promise.resolve({ data: [], error: null }),
			then: (resolve: (v: unknown) => void) => resolve(countResult),
		};
		return b;
	});
	return recorded;
}

describe("ingest_enrich_next backlog count (#1209)", () => {
	it("asks PostgREST for an estimated count, not an exact one", async () => {
		const recorded = stubArtifacts({ count: 149_872, error: null });

		const out = await enrichNextCore({});

		const countSelect = recorded.selectArgs.find((a) => (a[1] as { head?: boolean } | undefined)?.head);
		expect(countSelect?.[1]).toEqual({ count: "estimated", head: true });
		expect(out.remaining_discovered).toBe(149_872);
		expect(out.count_error).toBeUndefined();
	});

	it("returns null and the reason when the count fails — never 0", async () => {
		stubArtifacts({ count: null, error: { message: "canceling statement due to statement timeout" } });

		const out = await enrichNextCore({});

		expect(out.remaining_discovered).toBeNull();
		expect(out.count_error).toContain("statement timeout");
	});

	it("treats a response with no count as unknown, not as an empty backlog", async () => {
		stubArtifacts({ count: null, error: null });

		const out = await enrichNextCore({});

		expect(out.remaining_discovered).toBeNull();
		expect(out.count_error).toBeTruthy();
	});

	it("says the backlog is unknown in the tool's own summary", async () => {
		stubArtifacts({ count: null, error: { message: "canceling statement due to statement timeout" } });

		const out = await enrichNextHandler({});

		expect(out.content[0].text).toContain("unknown discovered remaining");
		expect(out.content[0].text).toContain("statement timeout");
		expect(out.content[0].text).not.toContain(" 0 discovered remaining");
	});

	it("surfaces a count failure on the no-adapter early return too", async () => {
		stubArtifacts({ count: null, error: { message: "boom" } });

		const out = await enrichNextCore({ connector: "notion" });

		expect(out.remaining_discovered).toBeNull();
		expect(out.count_error).toBe("boom");
	});
});

describe("ingest_enrich_next({ artifact_id }) does not claim a backlog size", () => {
	/** A single-row lookup resolving to `row`; records whether a head count was asked for. */
	function stubSingle(row: Record<string, unknown> | null): Recorded {
		const recorded: Recorded = { selectArgs: [], orArgs: [] };
		(supabase as any).from = vi.fn(() => {
			const b: any = {
				select: (...args: unknown[]) => {
					recorded.selectArgs.push(args);
					return b;
				},
				eq: () => b,
				maybeSingle: () => Promise.resolve({ data: row, error: null }),
			};
			return b;
		});
		return recorded;
	}

	it("returns null (not 0) with no count_error when the artifact is not found, and never counts", async () => {
		const recorded = stubSingle(null);

		const out = await enrichNextCore({ artifact_id: "00000000-0000-0000-0000-000000000001" });

		expect(out.remaining_discovered).toBeNull();
		expect(out.count_error).toBeUndefined();
		expect(recorded.selectArgs.some((a) => (a[1] as { head?: boolean } | undefined)?.head)).toBe(false);
	});

	it("returns null for an already-enriched artifact too", async () => {
		stubSingle({
			id: "a1",
			storage_bucket: "artifacts",
			storage_path: "enriched/gdrive/u/a1.pdf",
			lifecycle_stage: "extracted",
			source_channel: "discovered_gdrive",
		});

		const out = await enrichNextCore({ artifact_id: "a1" });

		expect(out.remaining_discovered).toBeNull();
		expect(out.notes[0]).toContain("already enriched");
	});

	it("leaves the backlog out of the summary instead of printing '0 discovered remaining'", async () => {
		stubSingle(null);

		const out = await enrichNextHandler({ artifact_id: "00000000-0000-0000-0000-000000000001" });
		const text = out.content[0].text;

		expect(text).toContain(
			"ingest_enrich_next: 0 enriched, 1 failed (artifact 00000000-0000-0000-0000-000000000001).",
		);
		expect(text).not.toContain("discovered remaining");
	});
});

describe("ingest_enrich_next skips recorded Drive folders (#1228)", () => {
	it("filters both the selection and the backlog count with NOT_A_FOLDER_FILTER", async () => {
		const recorded = stubArtifacts({ count: 3, error: null });

		await enrichNextCore({});

		// One `or` on the row selection, one on the head count.
		expect(recorded.orArgs).toEqual([NOT_A_FOLDER_FILTER, NOT_A_FOLDER_FILTER]);
	});
});
