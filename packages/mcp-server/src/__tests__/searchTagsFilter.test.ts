import { afterEach, describe, expect, it, vi } from "vitest";

// #1213: knowledge_search `tags` (all-of) and `artifacts_only`. The load-bearing
// property is WHERE the tag filter runs: inside the RPC (migration 119's
// `filter_tags`), before the RPC's own row ceiling. The ceiling test below fakes an
// RPC that honours both the filter and the ceiling the way the SQL does, and shows
// that tagged rows sitting past the old 120-row ceiling still come back.

vi.mock("../env.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../env.js")>();
	return { ...actual, env: { ...actual.env, openaiApiKey: undefined as string | undefined } };
});

vi.mock("../embeddings.js", () => ({
	embed: vi.fn(async () => [0.1, 0.2, 0.3]),
}));

import { supabase } from "../supabase.js";
import { env } from "../env.js";
import { searchInput } from "@ahkms/core";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { textArrayLiteral } from "../tools/search.js";
import { z } from "zod";

const searchHandler = (args: any) =>
	toMcpTool(serverRegistry().get("knowledge_search")!).handler(args);

const origFrom = supabase.from;
const origRpc = supabase.rpc;

afterEach(() => {
	(supabase as any).from = origFrom;
	(supabase as any).rpc = origRpc;
	(env as { openaiApiKey?: string }).openaiApiKey = undefined;
	vi.restoreAllMocks();
});

const schema = z.object(searchInput);
type Args = z.infer<typeof schema>;

function artifact(i: number, tags: string[] = []) {
	return {
		id: `artifact-${i}`,
		title: `Document ${i}`,
		plain_text: `Body ${i}`,
		created_at: "2026-06-01T00:00:00Z",
		captured_at: "2026-06-01T00:00:00Z",
		effective_at: "2026-06-01T00:00:00Z",
		lifecycle_stage: "discovered",
		tags,
		content_subtype: null,
	};
}

const ENTITY = { id: "entity-1", title: "CV", description: "A concept called CV" };
const PERSON = { id: "person-1", title: "Cv Smith", description: "A person" };

/**
 * A fake of the migration-119 artifact RPCs over `corpus`, ranked in corpus order:
 * `filter_tags` (all-of) is applied first, then the hybrid RPC's
 * `least(match_limit, 30) * 2` per-arm cap and the outer `limit match_limit` -- the
 * same order the SQL applies them. Graph RPCs return one entity / one person.
 */
function fakeRpcs(corpus: ReturnType<typeof artifact>[]) {
	const calls: { name: string; params: Record<string, unknown> }[] = [];
	(supabase as any).rpc = vi.fn((name: string, params: Record<string, unknown>) => {
		calls.push({ name, params });
		let data: unknown[] = [];
		if (name === "hybrid_search_artifacts" || name === "fts_search_artifacts") {
			const tags = params.filter_tags as string[] | undefined;
			const matchLimit = params.match_limit as number;
			const ranked = tags ? corpus.filter((r) => tags.every((t) => r.tags.includes(t))) : corpus;
			const ceiling = name === "hybrid_search_artifacts" ? Math.min(matchLimit, 30) * 2 * 2 : matchLimit;
			data = ranked.slice(0, Math.min(ceiling, matchLimit));
		} else if (name.includes("entities")) {
			data = [ENTITY];
		} else if (name.includes("people")) {
			data = [PERSON];
		}
		return { select: () => Promise.resolve({ data, error: null }) };
	});
	return calls;
}

describe("knowledge_search `tags` (#1213)", () => {
	it("returns tagged matches that sit beyond the old 120-row ceiling", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		// 150 untagged rows outrank the 5 tagged ones. A JS post-filter would only ever
		// see the first 120 (all untagged) and return nothing.
		const corpus = [
			...Array.from({ length: 150 }, (_, i) => artifact(i)),
			...Array.from({ length: 5 }, (_, i) => artifact(1000 + i, ["doc:cv"])),
		];
		const calls = fakeRpcs(corpus);

		const out = (await searchHandler({ query: "cv", tags: ["doc:cv"], limit: 50 } as Args)).content[0].text;

		for (let i = 0; i < 5; i++) expect(out).toContain(`[artifact-${1000 + i}]`);
		expect(out).toContain("5 result(s):");
		expect(out).not.toContain("[artifact-0]");
		const hybrid = calls.find((c) => c.name === "hybrid_search_artifacts");
		expect(hybrid?.params.filter_tags).toEqual(["doc:cv"]);
	});

	it("requires ALL the tags, de-duplicated, on the full-text path too", async () => {
		const corpus = [artifact(1, ["doc:cv"]), artifact(2, ["doc:cv", "golden"]), artifact(3, ["golden"])];
		const calls = fakeRpcs(corpus);

		const out = (await searchHandler({ query: "cv", tags: ["doc:cv", "golden", "doc:cv"] } as Args))
			.content[0].text;

		expect(out).toContain("[artifact-2]");
		expect(out).not.toContain("[artifact-1]");
		expect(out).not.toContain("[artifact-3]");
		expect(calls.find((c) => c.name === "fts_search_artifacts")?.params.filter_tags).toEqual([
			"doc:cv",
			"golden",
		]);
	});

	it("skips the entity and people arms, which carry no artifact tags", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		const calls = fakeRpcs([artifact(1, ["doc:cv"])]);

		const out = (await searchHandler({ query: "cv", tags: ["doc:cv"] } as Args)).content[0].text;

		expect(calls.map((c) => c.name)).toEqual(["hybrid_search_artifacts"]);
		expect(out).not.toContain("[entity]");
		expect(out).not.toContain("[person]");
	});

	it("sends no filter_tags at all when no tags are given (old-database compatible)", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		const calls = fakeRpcs([artifact(1)]);

		await searchHandler({ query: "cv" } as Args);

		const hybrid = calls.find((c) => c.name === "hybrid_search_artifacts");
		expect(hybrid?.params).not.toHaveProperty("filter_tags");
		// ...and the graph arms still run: nothing changes for an unfiltered search.
		expect(calls.map((c) => c.name).sort()).toEqual([
			"hybrid_search_artifacts",
			"hybrid_search_entities",
			"hybrid_search_people",
		]);
	});

	it("points a tagged RPC failure at migration 119", async () => {
		(supabase as any).rpc = vi.fn(() => ({
			select: () =>
				Promise.resolve({ data: null, error: { message: "Could not find the function fts_search_artifacts" } }),
		}));
		await expect(searchHandler({ query: "cv", tags: ["doc:cv"] } as Args)).rejects.toThrow(
			/the `tags` filter needs migration 119/,
		);
	});

	it("is enough on its own: a tags-only read lists tagged artifacts through a SQL containment filter", async () => {
		const filters: unknown[][] = [];
		const b: any = {
			select: () => b,
			eq: () => b,
			or: () => b,
			filter: (...a: unknown[]) => {
				filters.push(a);
				return b;
			},
			order: () => b,
			limit: () => Promise.resolve({ data: [artifact(7, ["doc:cv"])], error: null, count: 1 }),
		};
		(supabase as any).from = vi.fn(() => b);
		const rpc = vi.fn();
		(supabase as any).rpc = rpc;

		const out = (await searchHandler({ tags: ["doc:cv"] } as Args)).content[0].text;

		expect(out).toContain("[artifact-7]");
		expect(filters).toEqual([["tags", "cs", '{"doc:cv"}']]);
		expect(rpc).not.toHaveBeenCalled();
	});

	it("keeps discovered pointers in a tags-only listing (it is not a synthesis window)", async () => {
		const ors: string[] = [];
		const b: any = {
			select: () => b,
			eq: () => b,
			or: (clause: string) => {
				ors.push(clause);
				return b;
			},
			filter: () => b,
			order: () => b,
			limit: () => Promise.resolve({ data: [], error: null, count: 0 }),
		};
		(supabase as any).from = vi.fn(() => b);

		await searchHandler({ tags: ["doc:cv"] } as Args);

		expect(ors.some((c) => c.includes("lifecycle_stage"))).toBe(false);
	});

	it("still refuses a call with nothing to search on, naming tags among the options", async () => {
		await expect(searchHandler({} as Args)).rejects.toThrow(
			/at least one of query, tags, captured_after, captured_before, not_consumed/,
		);
	});

	it("rejects an empty tags array at the schema", () => {
		expect(schema.safeParse({ query: "cv", tags: [] }).success).toBe(false);
		expect(schema.safeParse({ query: "cv", tags: [""] }).success).toBe(false);
	});

	it("quotes every tag in the containment literal", () => {
		expect(textArrayLiteral(["doc:cv", 'a,b', 'say "hi"', "back\\slash", " edge "])).toBe(
			'{"doc:cv","a,b","say \\"hi\\"","back\\\\slash"," edge "}',
		);
	});
});

describe("knowledge_search `artifacts_only` (#1213)", () => {
	it("drops the entity and people arms from a hybrid query", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		const calls = fakeRpcs([artifact(1), artifact(2)]);

		const out = (await searchHandler({ query: "CV", artifacts_only: true } as Args)).content[0].text;

		expect(calls.map((c) => c.name)).toEqual(["hybrid_search_artifacts"]);
		expect(out).toContain("[artifact-1]");
		expect(out).not.toContain("[entity-1]");
		expect(out).not.toContain("[person-1]");
		// No tags were given, so the artifact RPC call is unchanged.
		expect(calls[0].params).not.toHaveProperty("filter_tags");
	});

	it("drops them from a full-text query too", async () => {
		const calls = fakeRpcs([artifact(1)]);

		await searchHandler({ query: "CV", artifacts_only: true } as Args);

		expect(calls.map((c) => c.name)).toEqual(["fts_search_artifacts"]);
	});

	it("leaves the fused ranking alone when it is off: a name-exact entity still leads", async () => {
		// ADR-047 §4's invariant with neither new parameter set.
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		fakeRpcs([artifact(1), artifact(2)]);

		const out = (await searchHandler({ query: "CV" } as Args)).content[0].text;

		expect(out.indexOf("[entity-1]")).toBeGreaterThan(-1);
		expect(out.indexOf("[entity-1]")).toBeLessThan(out.indexOf("[artifact-1]"));
	});
});
