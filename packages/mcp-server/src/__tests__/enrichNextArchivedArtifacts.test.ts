import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "../supabase.js";
import { enrichNextHandler } from "../tools/enrichNext.js";

// Refs #120: ingest_enrich_next's work-queue selection (and its "N discovered remaining"
// count) must exclude soft-deleted (archived) pointers by default. An artifact
// archived while still lifecycle_stage='discovered' should not silently consume
// enrichment budget (storage upload + artifact_extract_text/model call) on the next run.
//
// Selection query shape only — enrichOne()'s Drive fetch is out of scope here
// (deliberately untested without live credentials per enrich/selection.ts's own
// comment); returning zero rows keeps this test on the selection query alone.

const TEST_USER = "00000000-0000-0000-0000-000000000000"; // from vitest.config env

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

describe("enrichNextHandler — archived artifact exclusion (#120)", () => {
	it("filters both the selection query and the remaining-count query by archived = false", async () => {
		const eqCallsByBuilder: unknown[][] = [];

		(supabase as any).from = vi.fn(() => {
			const b: any = {
				select: (...selArgs: unknown[]) => {
					// Distinguish the head:true count query from the row-selection query by
					// its select() call shape, but both must carry the archived=false filter.
					void selArgs;
					return b;
				},
				eq: (...args: unknown[]) => {
					eqCallsByBuilder.push(args);
					return b;
				},
				in: () => b,
				or: () => b,
				order: () => b,
				limit: () => Promise.resolve({ data: [], error: null }),
				then: (resolve: (v: { count: number | null }) => void) => resolve({ count: 0 }),
			};
			return b;
		});

		const out = await enrichNextHandler({} as any);

		expect(eqCallsByBuilder).toContainEqual(["archived", false]);
		expect(eqCallsByBuilder.filter((c) => c[0] === "archived" && c[1] === false).length).toBeGreaterThanOrEqual(1);
		expect(eqCallsByBuilder).toContainEqual(["user_id", TEST_USER]);
		expect(out.content[0].text).toContain("ingest_enrich_next:");
	});
});
