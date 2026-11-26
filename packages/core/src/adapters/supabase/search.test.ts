import { describe, expect, it, vi } from "vitest";
import {
	ENRICHED_STAGES,
	GRAPH_SELECT,
	GRAPH_SELECT_LEGACY,
	MAX_URL_EXCLUDE_IDS,
	SEARCH_ARTIFACT_SELECT,
} from "../../ports/search.js";
import { createSupabaseSearchAdapter, type SearchSupabaseClient } from "./search.js";

describe("createSupabaseSearchAdapter (#1618)", () => {
	it("calls fts_search_artifacts with tagRpcParam and preserves rpcMigrationHint on error", async () => {
		const rpcCalls: Array<{ name: string; params: unknown; select: string }> = [];
		const client: SearchSupabaseClient = {
			from: vi.fn() as never,
			rpc: vi.fn((name: string, params: unknown) => ({
				select: (sel: string) => {
					rpcCalls.push({ name, params, select: sel });
					return Promise.resolve(
						rpcCalls.length === 2
							? { data: null, error: { message: "rpc boom" } }
							: { data: [{ id: "a1", title: "Hit" }], error: null },
					);
				},
			})) as never,
		};
		const adapter = createSupabaseSearchAdapter({ client, ownerId: () => "user-1" });
		const rows = await adapter.ftsSearchArtifacts({ query: "roadmap", matchLimit: 30 });
		expect(rows).toEqual([{ id: "a1", title: "Hit" }]);
		expect(rpcCalls[0]).toEqual({
			name: "fts_search_artifacts",
			params: { query_text: "roadmap", match_user_id: "user-1", match_limit: 30, include_archived: false },
			select: SEARCH_ARTIFACT_SELECT,
		});
		await expect(
			adapter.ftsSearchArtifacts({ query: "cv", matchLimit: 30, tags: ["doc:cv", "doc:cv"] }),
		).rejects.toThrow(
			'Full-text search failed: rpc boom. If this mentions "fts_search_artifacts", apply migration 066 and 069; the `tags` filter needs migration 119.',
		);
		expect(rpcCalls[1]?.params).toMatchObject({ filter_tags: ["doc:cv"] });
	});

	it("calls hybrid_search_artifacts with serialized embedding and preserves rpcMigrationHint on error", async () => {
		const rpcCalls: Array<{ name: string; params: unknown; select: string }> = [];
		const client: SearchSupabaseClient = {
			from: vi.fn() as never,
			rpc: vi.fn((name: string, params: unknown) => ({
				select: (sel: string) => {
					rpcCalls.push({ name, params, select: sel });
					return Promise.resolve(
						rpcCalls.length === 2
							? { data: null, error: { message: "function missing" } }
							: { data: [{ id: "h1", title: "Hybrid" }], error: null },
					);
				},
			})) as never,
		};
		const adapter = createSupabaseSearchAdapter({ client, ownerId: "user-1" });
		const rows = await adapter.hybridSearchArtifacts({
			query: "strategy",
			queryEmbedding: [0.1, 0.2],
			matchLimit: 15,
			includeArchived: true,
			tags: ["golden"],
		});
		expect(rows).toEqual([{ id: "h1", title: "Hybrid" }]);
		expect(rpcCalls[0]).toEqual({
			name: "hybrid_search_artifacts",
			params: {
				query_text: "strategy",
				query_embedding: "[0.1,0.2]",
				match_user_id: "user-1",
				match_limit: 15,
				include_archived: true,
				filter_tags: ["golden"],
			},
			select: SEARCH_ARTIFACT_SELECT,
		});
		await expect(
			adapter.hybridSearchArtifacts({ query: "strategy", queryEmbedding: "[0.1,0.2]", matchLimit: 15 }),
		).rejects.toThrow(
			'Hybrid search failed: function missing. If this mentions "hybrid_search_artifacts", apply migration 051 and 069.',
		);
	});

	it("calls graph RPCs and retries with GRAPH_SELECT_LEGACY when aliases column is missing", async () => {
		const selects: Array<{ name: string; params: unknown; select: string }> = [];
		const warnings: string[] = [];
		const client: SearchSupabaseClient = {
			from: vi.fn() as never,
			rpc: vi.fn((name: string, params: unknown) => ({
				select: (sel: string) => {
					selects.push({ name, params, select: sel });
					if (name === "hybrid_search_entities" && sel === GRAPH_SELECT) {
						return Promise.resolve({
							data: null,
							error: { code: "42703", message: "column entities.aliases does not exist" },
						});
					}
					if (name === "fts_search_people") {
						return Promise.resolve({ data: null, error: { code: "XX000", message: "graph offline" } });
					}
					return Promise.resolve({
						data: [{ id: "g1", title: "Work", description: "Company" }],
						error: null,
					});
				},
			})) as never,
		};
		const adapter = createSupabaseSearchAdapter({
			client,
			ownerId: "user-1",
			onWarning: (msg) => warnings.push(msg),
		});
		const entityRows = await adapter.searchGraph({
			kind: "entity",
			mode: "hybrid",
			query: "Work",
			queryEmbedding: [0.5],
			matchLimit: 30,
		});
		expect(entityRows).toEqual([{ id: "g1", title: "Work", description: "Company" }]);
		expect(selects.map((s) => s.select)).toEqual([GRAPH_SELECT, GRAPH_SELECT_LEGACY]);
		const peopleRows = await adapter.searchGraph({
			kind: "person",
			mode: "full-text-only",
			query: "Angus",
			matchLimit: 15,
		});
		expect(peopleRows).toEqual([]);
		expect(warnings[0]).toContain("fts_search_people failed");
	});

	it("builds filter-only artifacts query with subtype, window, URL-exclusion cap, tag, and stage predicates", async () => {
		const ops: Array<[string, ...unknown[]]> = [];
		const builder: Record<string, unknown> = {
			eq: (col: string, val: unknown) => (ops.push(["eq", col, val]), builder),
			or: (expr: string) => (ops.push(["or", expr]), builder),
			gte: (col: string, val: unknown) => (ops.push(["gte", col, val]), builder),
			lte: (col: string, val: unknown) => (ops.push(["lte", col, val]), builder),
			not: (col: string, op: string, val: unknown) => (ops.push(["not", col, op, val]), builder),
			filter: (col: string, op: string, val: unknown) => (ops.push(["filter", col, op, val]), builder),
			order: (col: string, opts: unknown) => (ops.push(["order", col, opts]), builder),
			limit: (n: number) => (
				ops.push(["limit", n]),
				Promise.resolve({ data: [{ id: "f1", title: "Filtered" }], error: null, count: 4 })
			),
		};
		const client: SearchSupabaseClient = {
			rpc: vi.fn() as never,
			from: vi.fn((table: string) => ({
				select: (cols: string, opts: unknown) => (ops.push(["select", table, cols, opts]), builder),
			})) as never,
		};
		const adapter = createSupabaseSearchAdapter({ client, ownerId: "user-1" });
		const res = await adapter.filterArtifacts({
			excludedSubtypes: ["task_request", "daily_log"],
			capturedAfter: "2026-08-01T00:00:00Z",
			capturedBefore: "2026-08-02T00:00:00Z",
			consumedIds: ["c1", "c2"],
			tags: ["a,b"],
			excludeUnenriched: true,
			limit: 10,
		});
		expect(res).toEqual({ rows: [{ id: "f1", title: "Filtered" }], count: 4 });
		expect(ops).toEqual([
			["select", "artifacts", SEARCH_ARTIFACT_SELECT, { count: "exact" }],
			["eq", "user_id", "user-1"],
			["eq", "archived", false],
			["or", "content_subtype.is.null,content_subtype.not.in.(task_request,daily_log)"],
			["gte", "effective_at", "2026-08-01T00:00:00Z"],
			["lte", "effective_at", "2026-08-02T00:00:00Z"],
			["not", "id", "in", "(c1,c2)"],
			["filter", "tags", "cs", '{"a,b"}'],
			["or", `lifecycle_stage.is.null,lifecycle_stage.in.(${[...ENRICHED_STAGES].join(",")})`],
			["order", "effective_at", { ascending: false }],
			["limit", 10],
		]);
		ops.length = 0;
		const overCap = Array.from({ length: MAX_URL_EXCLUDE_IDS + 1 }, (_, i) => `id-${i}`);
		await adapter.filterArtifacts({ excludedSubtypes: ["task_request"], consumedIds: overCap, limit: 5 });
		expect(ops.some((o) => o[0] === "not")).toBe(false);
		expect(ops).toContainEqual(["or", "content_subtype.is.null,content_subtype.neq.task_request"]);
	});

	it("fetches consumed artifact ids scoped by domain and chunks window scoping by MAX_URL_EXCLUDE_IDS (150)", async () => {
		const linkOps: Array<[string, ...unknown[]]> = [];
		const artifactChunks: string[][] = [];
		const allIds = Array.from({ length: 160 }, (_, i) => `art-${i}`);
		const client: SearchSupabaseClient = {
			rpc: vi.fn() as never,
			from: vi.fn((table: string) => {
				if (table === "artifact_external_links") {
					const q: Record<string, unknown> = {
						select: (cols: string) => (linkOps.push(["select", cols]), q),
						eq: (col: string, val: unknown) => (linkOps.push(["eq", col, val]), q),
						in: (col: string, vals: unknown) => (
							linkOps.push(["in", col, vals]),
							Promise.resolve({ data: allIds.map((artifact_id) => ({ artifact_id })), error: null })
						),
					};
					return q;
				}
				let currentChunk: string[] = [];
				const aq: Record<string, unknown> = {
					select: () => aq,
					eq: () => aq,
					in: (_c: string, vals: string[]) => ((currentChunk = vals), artifactChunks.push(vals), aq),
					gte: () => aq,
					lte: () => Promise.resolve({ data: currentChunk.slice(0, 2).map((id) => ({ id })), error: null }),
				};
				return aq;
			}) as never,
		};
		const adapter = createSupabaseSearchAdapter({ client, ownerId: "user-1" });
		const scoped = await adapter.findConsumedArtifactIds({
			domain: "work",
			consumingKinds: ["synthesized"],
			capturedAfter: "2026-08-01T00:00:00Z",
			capturedBefore: "2026-08-02T00:00:00Z",
		});
		expect(linkOps).toContainEqual(["eq", "provider", "notion_work"]);
		expect(artifactChunks.map((c) => c.length)).toEqual([MAX_URL_EXCLUDE_IDS, 10]);
		expect(scoped).toEqual(["art-0", "art-1", "art-150", "art-151"]);
	});
});

