import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");

// Mock env so we control openaiApiKey presence per test without depending on process.env.
// Keep the real supabaseUrl/supabaseServiceRoleKey (via importOriginal) since supabase.ts
// constructs a real client from them at import time. Mutable openaiApiKey so individual
// tests can flip the key on/off to exercise both search modes.
vi.mock("../env.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../env.js")>();
	return {
		...actual,
		env: {
			...actual.env,
			geminiApiKey: undefined as string | undefined,
			openaiApiKey: undefined as string | undefined,
		},
	};
});

// Mock embed() so hybrid-mode tests never make a real OpenAI call. Mutable so a test can
// make it throw to exercise the runtime-failure path (network error / revoked key).
vi.mock("../embeddings.js", () => ({
	embed: vi.fn(async () => [0.1, 0.2, 0.3]),
}));

import { supabase } from "../supabase.js";
import { env } from "../env.js";
import { embed } from "../embeddings.js";
import { searchInput } from "@ahkms/core";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { DOMAIN_PROVIDER } from "../domains.js";
import { SESSION_SUMMARY_CONTENT_SUBTYPE, ENRICHED_STAGES } from "../vocab.js";
import { z } from "zod";

const searchHandler = (args: any) =>
	toMcpTool(serverRegistry().get("knowledge_search")!).handler(args);

const origFrom = supabase.from;
const origRpc = supabase.rpc;

afterEach(() => {
	(supabase as any).from = origFrom;
	(supabase as any).rpc = origRpc;
	(env as { geminiApiKey?: string }).geminiApiKey = undefined;
	(env as { openaiApiKey?: string }).openaiApiKey = undefined;
	vi.restoreAllMocks();
});

const ROW = {
	id: "artifact-1",
	title: "Test artifact",
	plain_text: "Some plain text content.",
	created_at: "2026-06-01T00:00:00Z",
	captured_at: "2026-06-01T00:00:00Z", effective_at: "2026-06-01T00:00:00Z",
	lifecycle_stage: "captured",
	tags: [],
	content_subtype: null,
};

/** Stub `supabase.from("artifacts")...limit()` to resolve with the given rows. */
function stubArtifactsQuery(rows: unknown[]) {
	const b: any = {
		select: () => b,
		eq: () => b,
		in: () => b,
		gte: () => b,
		lte: () => b,
		not: () => b,
		filter: () => b,
		or: () => b,
		order: () => b,
		limit: () => Promise.resolve({ data: rows, error: null }),
		maybeSingle: () => Promise.resolve({ data: null, error: null }),
	};
	(supabase as any).from = vi.fn(() => b);
	(supabase as any).rpc = vi.fn((fnName: string) => {
		if (fnName === "search_unconsumed_artifacts") {
			return Promise.resolve({
				data: (rows as any[]).map((r) => ({ ...r, total_count: rows.length })),
				error: null,
			});
		}
		return Promise.resolve({ data: null, error: new Error(`unknown RPC: ${fnName}`) });
	});
}

/**
 * #553: knowledge_search now fans out to two more RPCs per query
 * (hybrid_search_entities/hybrid_search_people, or their fts_ equivalents) besides
 * the artifact one under test. A blanket `vi.fn(() => ...)` would hand the same
 * artifact-shaped `rows` back to those graph calls too, duplicating every row as a
 * bogus "entity"/"person" hit. Route by RPC name instead: the named artifact RPC
 * gets `rows`, everything else (the graph arms) gets an empty result, exactly as
 * if this user has no matching entities/people -- which is what every pre-#553 test
 * fixture implicitly assumed.
 */
function stubRpcFor(artifactRpcName: string, rows: unknown[]) {
	return vi.fn((name: string) => ({
		select: () =>
			Promise.resolve({ data: name === artifactRpcName ? rows : [], error: null }),
	}));
}

/** Stub `supabase.rpc("hybrid_search_artifacts", ...).select()` to resolve with the given rows. */
function stubHybridRpc(rows: unknown[]) {
	(supabase as any).rpc = stubRpcFor("hybrid_search_artifacts", rows);
}

/** Stub `supabase.rpc("fts_search_artifacts", ...).select()` to resolve with the given rows,
 * in the order the RPC returns them (i.e. already ranked by ts_rank_cd server-side). */
function stubFtsRankRpc(rows: unknown[]) {
	(supabase as any).rpc = stubRpcFor("fts_search_artifacts", rows);
}

describe("searchHandler — search_mode signal", () => {
	it("reports hybrid mode with no degradation notice when the OpenAI key is present", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		stubHybridRpc([ROW]);

		const out = await searchHandler({ query: "test query" } as any);

		expect(out.content[0].text).not.toContain("search_mode: full-text-only");
		expect(out.content[0].text).toContain("Test artifact");
		expect(embed).toHaveBeenCalledWith("test query");
	});

	it("reports the full-text-only degradation notice when the OpenAI key is absent and a query was given", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		stubFtsRankRpc([ROW]);

		const out = await searchHandler({ query: "test query" } as any);

		expect(out.content[0].text).toContain(
			"search_mode: full-text-only (no OpenAI embedding key configured",
		);
		expect(out.content[0].text).toContain("Test artifact");
		expect(embed).not.toHaveBeenCalled();
	});

	it("preserves the RPC's relevance ranking for the FTS-only fallback rather than re-sorting (issue #130)", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const exactTitleMatch = {
			...ROW,
			id: "artifact-exact-title",
			title: "Quarterly Roadmap",
			plain_text: "Quarterly Roadmap",
		};
		const incidentalMention = {
			...ROW,
			id: "artifact-incidental-mention",
			title: "Sprawling meeting transcript",
			plain_text:
				"A very long transcript that mentions roadmap only once in passing, buried among thousands of other words.",
		};
		// fts_search_artifacts ranks server-side via ts_rank_cd, so the short exact-title
		// match outranks the incidental long-doc mention — assert the tool preserves that
		// order rather than falling back to arbitrary heap order (the pre-fix bug).
		stubFtsRankRpc([exactTitleMatch, incidentalMention]);

		const out = await searchHandler({ query: "roadmap" } as any);

		expect(out.content[0].text).toContain(
			"search_mode: full-text-only (no OpenAI embedding key configured",
		);
		const exactIdx = out.content[0].text.indexOf("artifact-exact-title");
		const incidentalIdx = out.content[0].text.indexOf("artifact-incidental-mention");
		expect(exactIdx).toBeGreaterThanOrEqual(0);
		expect(incidentalIdx).toBeGreaterThan(exactIdx);
		expect(embed).not.toHaveBeenCalled();
	});

	it("does not emit a degradation notice for a pure filter search (no query) even without a key", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		stubArtifactsQuery([ROW]);

		const out = await searchHandler({ not_consumed: true } as any);

		expect(out.content[0].text).not.toContain("search_mode");
		expect(out.content[0].text).toContain("Test artifact");
	});

	it("does not emit a degradation notice for a pure filter search even when the key IS present", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		stubArtifactsQuery([ROW]);

		const out = await searchHandler({ captured_after: "2026-01-01T00:00:00Z" } as any);

		// No query means no ranking mode applies at all — hybrid RPC must not be called.
		expect(out.content[0].text).not.toContain("search_mode");
		expect(embed).not.toHaveBeenCalled();
	});

	it("still shows the full-text-only notice on a zero-result degraded query", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		stubFtsRankRpc([]);

		const out = await searchHandler({ query: "nothing matches" } as any);

		expect(out.content[0].text).toContain("search_mode: full-text-only");
		expect(out.content[0].text).toContain("No matches.");
	});

	it("reports hybrid mode with no degradation notice when GEMINI_API_KEY is present and OPENAI_API_KEY is absent (#1974)", async () => {
		(env as { geminiApiKey?: string }).geminiApiKey = "test-gemini-key";
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		stubHybridRpc([ROW]);

		const out = await searchHandler({ query: "test query" } as any);

		expect(out.content[0].text).not.toContain("search_mode: full-text-only");
		expect(out.content[0].text).toContain("Test artifact");
		expect(embed).toHaveBeenCalledWith("test query");
	});

	it("degrades to full-text on an embed() 401/403 auth failure (revoked/invalid key) (#1974)", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		(embed as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("OpenAI request failed: 401 Unauthorized"),
		);
		stubFtsRankRpc([ROW]);

		const out = await searchHandler({ query: "test query" } as any);

		expect(out.content[0].text).toContain("search_mode: full-text-only");
		expect(out.content[0].text).toContain("embedding provider unavailable");
		expect(out.content[0].text).toContain("Test artifact");
	});

	it("propagates an unknown embed() failure (400 malformed request) as a hard error rather than silently falling back", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		(embed as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			Object.assign(new Error("400 invalid input"), { status: 400 }),
		);
		stubHybridRpc([ROW]);

		await expect(searchHandler({ query: "test query" } as any)).rejects.toThrow(
			/400 invalid input/,
		);
	});
});

// Issue #486: the embedding provider ran out of credits and every topical query
// returned 429. The tool's own doc promised a full-text fallback, but the failure
// came from embed() *before* any fallback branch, so search was unavailable rather
// than degraded — with a perfectly healthy local FTS index sitting right there.
describe("searchHandler — provider outage falls back to full-text (#486)", () => {
	/** Stub the FTS RPCs while asserting the hybrid RPC is never reached. #553: the
	 * fallback now fans out to the graph FTS arms too (ADR-047 §4 — degrading "all
	 * arms" to FTS-only, not just the artifact one), so those are allowed through
	 * with empty results; only a hybrid_* call is still a hard failure here. */
	function stubFtsOnly(rows: unknown[]) {
		const rpc = vi.fn((fn: string) => {
			if (fn.startsWith("hybrid_")) {
				throw new Error(`unexpected RPC after fallback: ${fn}`);
			}
			return {
				select: () =>
					Promise.resolve({ data: fn === "fts_search_artifacts" ? rows : [], error: null }),
			};
		});
		(supabase as any).rpc = rpc;
		return rpc;
	}

	it("falls back to full-text on a 429 and labels the result as degraded", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		(embed as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			Object.assign(new Error("429 You exceeded your current quota"), { status: 429 }),
		);
		const rpc = stubFtsOnly([ROW]);

		const out = await searchHandler({ query: "test query" } as any);

		expect(out.content[0].text).toContain("search_mode: full-text-only");
		expect(out.content[0].text).toContain("embedding provider unavailable");
		expect(out.content[0].text).toContain("Test artifact");
		expect(rpc).toHaveBeenCalledWith("fts_search_artifacts", expect.anything());
	});

	it("falls back on the status-less 'no credits remaining' shape the outage actually produced", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		(embed as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("no credits remaining"),
		);
		stubFtsOnly([ROW]);

		const out = await searchHandler({ query: "test query" } as any);

		expect(out.content[0].text).toContain("embedding provider unavailable");
		expect(out.content[0].text).toContain("Test artifact");
	});

	it("falls back on a provider 5xx too", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		(embed as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			Object.assign(new Error("Service Unavailable"), { status: 503 }),
		);
		stubFtsOnly([ROW]);

		const out = await searchHandler({ query: "test query" } as any);

		expect(out.content[0].text).toContain("embedding provider unavailable");
	});

	it("still applies structured filters on the degraded path", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		(embed as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			Object.assign(new Error("rate limit"), { status: 429 }),
		);
		const inWindow = { ...ROW, id: "in-window", captured_at: "2026-06-10T00:00:00Z", effective_at: "2026-06-10T00:00:00Z" };
		const tooOld = { ...ROW, id: "too-old", captured_at: "2026-01-01T00:00:00Z", effective_at: "2026-01-01T00:00:00Z" };
		stubFtsOnly([inWindow, tooOld]);

		const out = await searchHandler({
			query: "test query",
			captured_after: "2026-06-01T00:00:00Z",
		} as any);

		expect(out.content[0].text).toContain("in-window");
		expect(out.content[0].text).not.toContain("too-old");
	});

	it("shows the degradation notice even when the fallback finds nothing", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		(embed as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			Object.assign(new Error("rate limit"), { status: 429 }),
		);
		stubFtsOnly([]);

		const out = await searchHandler({ query: "nothing matches" } as any);

		expect(out.content[0].text).toContain("embedding provider unavailable");
		expect(out.content[0].text).toContain("No matches.");
	});

	it("keeps the two degraded wordings distinct — a missing key is not an outage", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		stubFtsOnly([ROW]);

		const out = await searchHandler({ query: "test query" } as any);

		expect(out.content[0].text).toContain("no OpenAI embedding key configured");
		expect(out.content[0].text).not.toContain("embedding provider unavailable");
	});
});

describe("searchHandler — include_archived (#120)", () => {
	it("defaults include_archived to false on the hybrid RPC call", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		const rpc = vi.fn(() => ({ select: () => Promise.resolve({ data: [ROW], error: null }) }));
		(supabase as any).rpc = rpc;

		await searchHandler({ query: "test query" } as any);

		expect(rpc).toHaveBeenCalledWith(
			"hybrid_search_artifacts",
			expect.objectContaining({ include_archived: false }),
		);
	});

	it("passes include_archived: true through to the hybrid RPC when requested", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		const rpc = vi.fn(() => ({ select: () => Promise.resolve({ data: [ROW], error: null }) }));
		(supabase as any).rpc = rpc;

		await searchHandler({ query: "test query", include_archived: true } as any);

		expect(rpc).toHaveBeenCalledWith(
			"hybrid_search_artifacts",
			expect.objectContaining({ include_archived: true }),
		);
	});

	it("defaults include_archived to false on the FTS-only RPC call", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const rpc = vi.fn(() => ({ select: () => Promise.resolve({ data: [ROW], error: null }) }));
		(supabase as any).rpc = rpc;

		await searchHandler({ query: "test query" } as any);

		expect(rpc).toHaveBeenCalledWith(
			"fts_search_artifacts",
			expect.objectContaining({ include_archived: false }),
		);
	});

	it("passes include_archived: true through to the FTS-only RPC when requested", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const rpc = vi.fn(() => ({ select: () => Promise.resolve({ data: [ROW], error: null }) }));
		(supabase as any).rpc = rpc;

		await searchHandler({ query: "test query", include_archived: true } as any);

		expect(rpc).toHaveBeenCalledWith(
			"fts_search_artifacts",
			expect.objectContaining({ include_archived: true }),
		);
	});

	it("omits the archived=false predicate on the filter-only path when include_archived is true", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const eqCalls: unknown[][] = [];
		const b: any = {
			select: () => b,
			eq: (...args: unknown[]) => {
				eqCalls.push(args);
				return b;
			},
			in: () => b,
			gte: () => b,
			lte: () => b,
			not: () => b,
			or: () => b,
			order: () => b,
			limit: () => Promise.resolve({ data: [ROW], error: null }),
		};
		(supabase as any).from = vi.fn(() => b);

		await searchHandler({ captured_after: "2026-08-17T00:00:00Z", include_archived: true } as any);

		expect(eqCalls).not.toContainEqual(["archived", false]);
	});

	it("applies the archived=false predicate on the filter-only path by default", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const eqCalls: unknown[][] = [];
		const b: any = {
			select: () => b,
			eq: (...args: unknown[]) => {
				eqCalls.push(args);
				return b;
			},
			in: () => b,
			gte: () => b,
			lte: () => b,
			not: () => b,
			or: () => b,
			order: () => b,
			limit: () => Promise.resolve({ data: [ROW], error: null }),
		};
		(supabase as any).from = vi.fn(() => b);

		await searchHandler({ captured_after: "2026-08-17T00:00:00Z" } as any);

		expect(eqCalls).toContainEqual(["archived", false]);
	});
});

// Issue #560 / ADR-050 §6: `not_consumed` must match EVERY synthesis kind, never just
// the one this ritual writes. The legacy `consumed_by_state` is gone (backfilled
// 2026-08-20), but the invariant outlives it: #561's unattended sweep writes
// `synthesized_unattended`, and if the predicate tracked only the written kind those
// swept atoms would read as unconsumed forever — the exact pile the sweep prevents.
describe("searchHandler — not_consumed marker vocabulary (#560)", () => {
	/**
	 * Stub the two-query filter-only path: the artifact_external_links lookup first,
	 * then the artifacts query. Returns the args the links lookup filtered `kind` on.
	 */
	function stubConsumedRpc() {
		const prefsQuery: any = {
			select: () => prefsQuery,
			eq: () => prefsQuery,
			maybeSingle: () => Promise.resolve({ data: null, error: null }),
		};
		(supabase as any).from = vi.fn(() => prefsQuery);
		const rpcCalls: Array<{ fnName: string; params: any }> = [];
		(supabase as any).rpc = vi.fn((fnName: string, params: any) => {
			rpcCalls.push({ fnName, params });
			return Promise.resolve({ data: [{ ...ROW, total_count: 1 }], error: null });
		});
		return { rpcCalls };
	}

	it("filters on every synthesis kind, not just the one it writes", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const { rpcCalls } = stubConsumedRpc();

		await searchHandler({ not_consumed: true } as any);

		expect(rpcCalls).toHaveLength(1);
		expect(rpcCalls[0].fnName).toBe("search_unconsumed_artifacts");
		expect([...rpcCalls[0].params.p_kinds].sort()).toEqual([
			"synthesized",
			"synthesized_unattended",
		]);
		expect(rpcCalls[0].params.p_kinds).not.toContain("consumed_by_state");
	});

	it("excludes an atom carrying only the unattended marker", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const { rpcCalls } = stubConsumedRpc();

		await searchHandler({ not_consumed: true } as any);

		expect(rpcCalls[0].params.p_kinds).toContain("synthesized_unattended");
	});
});

// Issue #413: task-request provenance artifacts (content_subtype='task_request',
// auto-captured by task_create) are separable and filtered out of search by default so
// one-line task requests don't crowd results — opt back in with include_task_requests.
describe("searchHandler — include_task_requests (#413)", () => {
	const TASK_REQ_ROW = {
		...ROW,
		id: "artifact-taskreq",
		title: "add a task to buy milk",
		content_subtype: "task_request",
	};
	const NORMAL_ROW = { ...ROW, id: "artifact-normal", content_subtype: null };

	it("excludes task_request rows from hybrid results by default", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		stubHybridRpc([NORMAL_ROW, TASK_REQ_ROW]);

		const out = await searchHandler({ query: "milk" } as any);

		expect(out.content[0].text).toContain("artifact-normal");
		expect(out.content[0].text).not.toContain("artifact-taskreq");
	});

	it("includes task_request rows in hybrid results when include_task_requests is true", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		stubHybridRpc([NORMAL_ROW, TASK_REQ_ROW]);

		const out = await searchHandler({
			query: "milk",
			include_task_requests: true,
		} as any);

		expect(out.content[0].text).toContain("artifact-normal");
		expect(out.content[0].text).toContain("artifact-taskreq");
	});

	it("excludes task_request rows from FTS-only results by default", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		stubFtsRankRpc([NORMAL_ROW, TASK_REQ_ROW]);

		const out = await searchHandler({ query: "milk" } as any);

		expect(out.content[0].text).toContain("artifact-normal");
		expect(out.content[0].text).not.toContain("artifact-taskreq");
	});

	it("includes task_request rows in FTS-only results when include_task_requests is true", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		stubFtsRankRpc([NORMAL_ROW, TASK_REQ_ROW]);

		const out = await searchHandler({
			query: "milk",
			include_task_requests: true,
		} as any);

		expect(out.content[0].text).toContain("artifact-normal");
		expect(out.content[0].text).toContain("artifact-taskreq");
	});

	it("applies ALL FOUR system-subtype exclusions (as one not.in predicate) on the filter-only path by default, keeping NULL content_subtype rows", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const orCalls: unknown[] = [];
		const b: any = {
			select: () => b,
			eq: () => b,
			in: () => b,
			gte: () => b,
			lte: () => b,
			not: () => b,
			or: (arg: unknown) => {
				orCalls.push(arg);
				return b;
			},
			order: () => b,
			limit: () => Promise.resolve({ data: [ROW], error: null }),
		};
		(supabase as any).from = vi.fn(() => b);

		await searchHandler({ captured_after: "2026-08-17T00:00:00Z" } as any);

		// `.not.in` alone would silently drop NULL content_subtype rows — the predicate must
		// re-include them explicitly. With all four system subtypes excluded by default
		// (#413 task_request, #126 event_request, #562 daily_log, #994 scaffold), a single
		// `neq` can't express excluding several values at once (OR-composed neqs are always
		// true), so this uses `not.in.(...)`. `daily_log` and `scaffold` sitting in the
		// DEFAULT set is ADR-051 §9 as built: a ritual's own output must never come back
		// through the day window it reads.
		expect(orCalls).toContainEqual(
			"content_subtype.is.null,content_subtype.not.in.(task_request,event_request,daily_log,scaffold,reflection)",
		);
		// The session summary (#565) is deliberately NOT in that set: it is an input to the
		// day, so the day window must return it. Pinned here so an edit to the exclusion
		// list fails a test that names it.
		for (const call of orCalls) expect(call).not.toContain(SESSION_SUMMARY_CONTENT_SUBTYPE);
	});

	it("still uses not.in when include_task_requests is true, because event_request, daily_log and scaffold remain excluded", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const orCalls: unknown[] = [];
		const b: any = {
			select: () => b,
			eq: () => b,
			in: () => b,
			gte: () => b,
			lte: () => b,
			not: () => b,
			or: (arg: unknown) => {
				orCalls.push(arg);
				return b;
			},
			order: () => b,
			limit: () => Promise.resolve({ data: [ROW], error: null }),
		};
		(supabase as any).from = vi.fn(() => b);

		await searchHandler({ captured_after: "2026-08-17T00:00:00Z", include_task_requests: true } as any);

		expect(orCalls).toContainEqual(
			"content_subtype.is.null,content_subtype.not.in.(event_request,daily_log,scaffold,reflection)",
		);
	});

	it("degrades to the single `neq` form when both provenance flags AND scaffolds are opted in, since only daily_log is left excluded", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const orCalls: unknown[] = [];
		const b: any = {
			select: () => b,
			eq: () => b,
			in: () => b,
			gte: () => b,
			lte: () => b,
			not: () => b,
			or: (arg: unknown) => {
				orCalls.push(arg);
				return b;
			},
			order: () => b,
			limit: () => Promise.resolve({ data: [ROW], error: null }),
		};
		(supabase as any).from = vi.fn(() => b);

		await searchHandler({
			captured_after: "2026-08-17T00:00:00Z",
			include_task_requests: true,
			include_event_requests: true,
			include_scaffolds: true,
			include_reflections: true,
		} as any);

		// Opting into both provenance subtypes plus scaffolds leaves exactly one system
		// subtype excluded (#562 daily_log), which is the single-value case — so this pins
		// the not.in -> neq switch AND pins that the cosmetic opt-ins cannot reach the
		// structural one.
		expect(orCalls).toContainEqual("content_subtype.is.null,content_subtype.neq.daily_log");
		// The lifecycle_stage filter (#567 / #1726) uses positive IN(ENRICHED_STAGES)
		expect(orCalls).toContainEqual(
			`lifecycle_stage.is.null,lifecycle_stage.in.(${[...ENRICHED_STAGES].join(",")})`,
		);
	});
});

// Issue #126: event-request provenance artifacts (content_subtype='event_request',
// auto-captured by event_create) mirror task_request's default-excluded treatment —
// separately opt-in-able via include_event_requests so a caller can request one without
// the other.
describe("searchHandler — include_event_requests (#126)", () => {
	const EVENT_REQ_ROW = {
		...ROW,
		id: "artifact-eventreq",
		title: "schedule dentist appointment",
		content_subtype: "event_request",
	};
	const NORMAL_ROW = { ...ROW, id: "artifact-normal", content_subtype: null };

	it("excludes event_request rows from hybrid results by default", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		stubHybridRpc([NORMAL_ROW, EVENT_REQ_ROW]);

		const out = await searchHandler({ query: "dentist" } as any);

		expect(out.content[0].text).toContain("artifact-normal");
		expect(out.content[0].text).not.toContain("artifact-eventreq");
	});

	it("includes event_request rows in hybrid results when include_event_requests is true", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		stubHybridRpc([NORMAL_ROW, EVENT_REQ_ROW]);

		const out = await searchHandler({
			query: "dentist",
			include_event_requests: true,
		} as any);

		expect(out.content[0].text).toContain("artifact-normal");
		expect(out.content[0].text).toContain("artifact-eventreq");
	});

	it("excludes event_request rows from FTS-only results by default", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		stubFtsRankRpc([NORMAL_ROW, EVENT_REQ_ROW]);

		const out = await searchHandler({ query: "dentist" } as any);

		expect(out.content[0].text).toContain("artifact-normal");
		expect(out.content[0].text).not.toContain("artifact-eventreq");
	});

	it("includes event_request rows in FTS-only results when include_event_requests is true", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		stubFtsRankRpc([NORMAL_ROW, EVENT_REQ_ROW]);

		const out = await searchHandler({
			query: "dentist",
			include_event_requests: true,
		} as any);

		expect(out.content[0].text).toContain("artifact-normal");
		expect(out.content[0].text).toContain("artifact-eventreq");
	});

	it("still uses not.in when include_event_requests is true, because task_request, daily_log and scaffold remain excluded", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const orCalls: unknown[] = [];
		const b: any = {
			select: () => b,
			eq: () => b,
			in: () => b,
			gte: () => b,
			lte: () => b,
			not: () => b,
			or: (arg: unknown) => {
				orCalls.push(arg);
				return b;
			},
			order: () => b,
			limit: () => Promise.resolve({ data: [ROW], error: null }),
		};
		(supabase as any).from = vi.fn(() => b);

		await searchHandler({ captured_after: "2026-08-17T00:00:00Z", include_event_requests: true } as any);

		// Mirrors the symmetric include_task_requests-only case above, and pins that the two
		// provenance flags are independent of each other: opting into one leaves the other
		// excluded alongside daily_log and scaffold, in the order excludedSystemSubtypes
		// builds them.
		expect(orCalls).toContainEqual(
			"content_subtype.is.null,content_subtype.not.in.(task_request,daily_log,scaffold,reflection)",
		);
	});
});

// #562 / ADR-050 §7: a Daily Log entry is an immutable record of a day, so its ahKMS twin
// belongs where knowledge_search can reach it. But the twin is the RITUAL'S OWN OUTPUT,
// and ADR-051 §9 is categorical — "anything the ritual writes is excluded from the day
// window the ritual later reads". Left visible, tomorrow's day-window read consumes today's
// log and the ritual synthesises its own synthesis. This exclusion is the ONE mechanism
// enforcing that: ADR-051 §9 also names an ADR-046 role gate, but resolveSynthesisRole is
// inert as built (no search path consults it), so there is nothing else holding the line.
describe("searchHandler — include_daily_logs (#562)", () => {
	const DAILY_LOG_ROW = {
		...ROW,
		id: "artifact-dailylog",
		title: "Daily Log — 12 August",
		content_subtype: "daily_log",
	};
	const NORMAL_ROW = { ...ROW, id: "artifact-normal", content_subtype: null };

	it("excludes daily_log twins from hybrid results by default", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		stubHybridRpc([NORMAL_ROW, DAILY_LOG_ROW]);

		const out = await searchHandler({ query: "what did I decide on 12 August" } as any);

		expect(out.content[0].text).toContain("artifact-normal");
		expect(out.content[0].text).not.toContain("artifact-dailylog");
	});

	// The issue's AC 3, on the path a natural-language question actually takes.
	it("returns the twin on the hybrid path when include_daily_logs is true", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		stubHybridRpc([NORMAL_ROW, DAILY_LOG_ROW]);

		const out = await searchHandler({
			query: "what did I decide on 12 August",
			include_daily_logs: true,
		} as any);

		expect(out.content[0].text).toContain("artifact-dailylog");
	});

	it("excludes daily_log twins from FTS-only results by default", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		stubFtsRankRpc([NORMAL_ROW, DAILY_LOG_ROW]);

		const out = await searchHandler({ query: "12 August" } as any);

		expect(out.content[0].text).toContain("artifact-normal");
		expect(out.content[0].text).not.toContain("artifact-dailylog");
	});

	it("returns the twin on the FTS-only path when include_daily_logs is true", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		stubFtsRankRpc([NORMAL_ROW, DAILY_LOG_ROW]);

		const out = await searchHandler({
			query: "12 August",
			include_daily_logs: true,
		} as any);

		expect(out.content[0].text).toContain("artifact-dailylog");
	});

	// The load-bearing one, stated as the failure it prevents: this is the exact read shape
	// dos-hl's Setup read 4 and the #561 sweep's per-day read use. A twin filed under the
	// day it narrates sits squarely inside that day's window, so without the exclusion a
	// re-read of a closed day hands the ritual its own log back as fresh material.
	it("keeps the twin out of a day-window not_consumed read — the ritual's own output is never its input", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const orCalls: unknown[] = [];
		const b: any = {
			select: () => b,
			eq: () => b,
			in: () => b,
			gte: () => b,
			lte: () => b,
			not: () => b,
			or: (arg: unknown) => {
				orCalls.push(arg);
				return b;
			},
			order: () => b,
			limit: () => Promise.resolve({ data: [ROW], error: null }),
		};
		(supabase as any).from = vi.fn(() => b);

		await searchHandler({
			captured_after: "2026-08-17T00:00:00Z",
			captured_before: "2026-08-17T23:59:59Z",
		} as any);

		expect(
			orCalls.filter(
				(c) => typeof c === "string" && c.includes("daily_log"),
			),
		).toHaveLength(1);
	});

	it("drops only the daily_log term from the SQL predicate when include_daily_logs is true", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const orCalls: unknown[] = [];
		const b: any = {
			select: () => b,
			eq: () => b,
			in: () => b,
			gte: () => b,
			lte: () => b,
			not: () => b,
			or: (arg: unknown) => {
				orCalls.push(arg);
				return b;
			},
			order: () => b,
			limit: () => Promise.resolve({ data: [ROW], error: null }),
		};
		(supabase as any).from = vi.fn(() => b);

		await searchHandler({ captured_after: "2026-08-17T00:00:00Z", include_daily_logs: true } as any);

		expect(orCalls).toContainEqual(
			"content_subtype.is.null,content_subtype.not.in.(task_request,event_request,scaffold,reflection)",
		);
	});

	it("returns no content_subtype predicate at all once every subtype is opted into", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const orCalls: unknown[] = [];
		const b: any = {
			select: () => b,
			eq: () => b,
			in: () => b,
			gte: () => b,
			lte: () => b,
			not: () => b,
			or: (arg: unknown) => {
				orCalls.push(arg);
				return b;
			},
			order: () => b,
			limit: () => Promise.resolve({ data: [ROW], error: null }),
		};
		(supabase as any).from = vi.fn(() => b);

		await searchHandler({
			captured_after: "2026-08-17T00:00:00Z",
			include_task_requests: true,
			include_event_requests: true,
			include_daily_logs: true,
			include_scaffolds: true,
			include_reflections: true,
		} as any);

		expect(
			orCalls.filter((c) => typeof c === "string" && c.includes("content_subtype")),
		).toHaveLength(0);
	});
});

// #994: a Cowork scheduled task's own ritual output (e.g. friday-reflection-prep's
// "Weekly Reflection" scaffold) mirrors daily_log's default-excluded treatment — it is
// the input to a LATER ritual (dos-reflect), not material for an ordinary day-window read.
describe("searchHandler — include_scaffolds (#994)", () => {
	const SCAFFOLD_ROW = {
		...ROW,
		id: "artifact-scaffold",
		title: "Weekly Reflection — 2026-09-25",
		content_subtype: "scaffold",
	};
	const NORMAL_ROW = { ...ROW, id: "artifact-normal", content_subtype: null };

	it("excludes scaffold rows from hybrid results by default", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		stubHybridRpc([NORMAL_ROW, SCAFFOLD_ROW]);

		const out = await searchHandler({ query: "weekly reflection" } as any);

		expect(out.content[0].text).toContain("artifact-normal");
		expect(out.content[0].text).not.toContain("artifact-scaffold");
	});

	it("includes scaffold rows in hybrid results when include_scaffolds is true", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		stubHybridRpc([NORMAL_ROW, SCAFFOLD_ROW]);

		const out = await searchHandler({
			query: "weekly reflection",
			include_scaffolds: true,
		} as any);

		expect(out.content[0].text).toContain("artifact-normal");
		expect(out.content[0].text).toContain("artifact-scaffold");
	});

	it("excludes scaffold rows from FTS-only results by default", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		stubFtsRankRpc([NORMAL_ROW, SCAFFOLD_ROW]);

		const out = await searchHandler({ query: "weekly reflection" } as any);

		expect(out.content[0].text).toContain("artifact-normal");
		expect(out.content[0].text).not.toContain("artifact-scaffold");
	});

	it("includes scaffold rows in FTS-only results when include_scaffolds is true", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		stubFtsRankRpc([NORMAL_ROW, SCAFFOLD_ROW]);

		const out = await searchHandler({
			query: "weekly reflection",
			include_scaffolds: true,
		} as any);

		expect(out.content[0].text).toContain("artifact-normal");
		expect(out.content[0].text).toContain("artifact-scaffold");
	});

	// The load-bearing case, stated as the failure it prevents: this is the shape a `dos`
	// day-window read uses. A scaffold filed under the day it was generated sits squarely
	// inside that day's window, so without the exclusion the ritual would surface its own
	// scheduled-task output as material — the exact failure #994 reports.
	it("keeps a scaffold out of a day-window not_consumed read by default", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const orCalls: unknown[] = [];
		const b: any = {
			select: () => b,
			eq: () => b,
			in: () => b,
			gte: () => b,
			lte: () => b,
			not: () => b,
			or: (arg: unknown) => {
				orCalls.push(arg);
				return b;
			},
			order: () => b,
			limit: () => Promise.resolve({ data: [ROW], error: null }),
		};
		(supabase as any).from = vi.fn(() => b);

		await searchHandler({
			captured_after: "2026-09-25T00:00:00Z",
			captured_before: "2026-09-25T23:59:59Z",
		} as any);

		expect(
			orCalls.filter((c) => typeof c === "string" && c.includes("scaffold")),
		).toHaveLength(1);
	});

	it("drops only the scaffold term from the SQL predicate when include_scaffolds is true", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const orCalls: unknown[] = [];
		const b: any = {
			select: () => b,
			eq: () => b,
			in: () => b,
			gte: () => b,
			lte: () => b,
			not: () => b,
			or: (arg: unknown) => {
				orCalls.push(arg);
				return b;
			},
			order: () => b,
			limit: () => Promise.resolve({ data: [ROW], error: null }),
		};
		(supabase as any).from = vi.fn(() => b);

		await searchHandler({ captured_after: "2026-09-25T00:00:00Z", include_scaffolds: true } as any);

		expect(orCalls).toContainEqual(
			"content_subtype.is.null,content_subtype.not.in.(task_request,event_request,daily_log,reflection)",
		);
	});
});

// Issue #567: a bulk Google Drive backfill landed hundreds of ADR-016 discover-stage
// pointers (lifecycle_stage='discovered', no body) all stamped with today's
// captured_at, drowning the EOD ritual's day-window read in empty-bodied rows.
// ADR-046 §1: synthesis reads enriched artifacts alongside captured atoms — a
// discovered-only pointer has nothing to narrate and must never enter a synthesis
// window (captured_after/captured_before/not_consumed). General keyword/semantic
// search (query with no structured filters) is a different read shape and must
// still surface unenriched pointers by title (ADR-016 "what I have" search).
// Round-1 QA review folded two more findings in here: M1 — 'failed'-stage rows
// (enrichNext.ts markFailed) are equally body-less and must be excluded too; M2 —
// a NULL-lifecycle_stage fixture pins the SQL<->JS NULL-safety agreement the
// three-path design rests on; H1 — include_discovered is the opt-in escape hatch
// so the discover/failed backlog stays auditable through the tool.
describe("searchHandler — exclude unenriched discovered-stage artifacts from synthesis windows (#567)", () => {
	const ENRICHED_ROW = {
		...ROW,
		id: "enriched-atom",
		lifecycle_stage: "extracted",
		captured_at: "2026-08-05T10:00:00Z", effective_at: "2026-08-05T10:00:00Z",
	};
	const DISCOVERED_ROW = {
		...ROW,
		id: "discovered-pointer",
		title: "Harry Potter and the Deathly Hallows.pdf",
		plain_text: null,
		lifecycle_stage: "discovered",
		captured_at: "2026-08-05T11:00:00Z", effective_at: "2026-08-05T11:00:00Z",
	};
	// M1: ingest_enrich_next's markFailed flips a discovered pointer to lifecycle_stage
	// 'failed' on error without touching captured_at or ever storing a body — it
	// carries the same "nothing to narrate" property as DISCOVERED_ROW.
	const FAILED_ROW = {
		...ROW,
		id: "failed-pointer",
		title: "Accenture FULL TIME Contract.pdf",
		plain_text: null,
		lifecycle_stage: "failed",
		captured_at: "2026-08-05T12:00:00Z", effective_at: "2026-08-05T12:00:00Z",
	};
	// M2: no fixture previously exercised a NULL lifecycle_stage (the value every
	// pre-Discover&Index artifact carries) through the exclusion — pin that the
	// exclusion keeps it, on both the JS-filter (hybrid/FTS) and SQL paths.
	const NULL_STAGE_ROW = {
		...ROW,
		id: "null-stage-row",
		lifecycle_stage: null,
		captured_at: "2026-08-05T09:00:00Z", effective_at: "2026-08-05T09:00:00Z",
	};

	it("excludes discovered- and failed-stage rows from a hybrid day-window read (captured_after set)", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		stubHybridRpc([ENRICHED_ROW, DISCOVERED_ROW, FAILED_ROW, NULL_STAGE_ROW]);

		const out = await searchHandler({
			query: "backfill",
			captured_after: "2026-08-05T00:00:00Z",
		} as any);

		expect(out.content[0].text).toContain("enriched-atom");
		expect(out.content[0].text).toContain("null-stage-row");
		expect(out.content[0].text).not.toContain("discovered-pointer");
		expect(out.content[0].text).not.toContain("failed-pointer");
	});

	it("excludes discovered- and failed-stage rows from an FTS-only day-window read", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		stubFtsRankRpc([ENRICHED_ROW, DISCOVERED_ROW, FAILED_ROW, NULL_STAGE_ROW]);

		const out = await searchHandler({
			query: "backfill",
			captured_before: "2026-08-06T00:00:00Z",
		} as any);

		expect(out.content[0].text).toContain("enriched-atom");
		expect(out.content[0].text).toContain("null-stage-row");
		expect(out.content[0].text).not.toContain("discovered-pointer");
		expect(out.content[0].text).not.toContain("failed-pointer");
	});

	it("excludes discovered-stage rows from a not_consumed synthesis read even without a date window", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		// not_consumed triggers a preliminary lookup against artifact_external_links
		// (searchHandler, before the hybrid RPC) — stub supabase.from for that lookup
		// (empty consumed list) alongside the hybrid RPC stub.
		const linksQuery: any = {
			select: () => linksQuery,
			eq: () => linksQuery,
			in: () => linksQuery,
			maybeSingle: () => Promise.resolve({ data: null, error: null }),
			then: (resolve: any) => resolve({ data: [], error: null }),
		};
		(supabase as any).from = vi.fn(() => linksQuery);
		stubHybridRpc([ENRICHED_ROW, DISCOVERED_ROW]);

		const out = await searchHandler({ query: "backfill", not_consumed: true } as any);

		expect(out.content[0].text).toContain("enriched-atom");
		expect(out.content[0].text).not.toContain("discovered-pointer");
	});

	it("does NOT exclude discovered-stage rows from a bare query with no structured filters (general search still finds pointers by title)", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		stubHybridRpc([ENRICHED_ROW, DISCOVERED_ROW]);

		const out = await searchHandler({ query: "Harry Potter" } as any);

		expect(out.content[0].text).toContain("enriched-atom");
		expect(out.content[0].text).toContain("discovered-pointer");
	});

	it("include_discovered=true opts back into discovered/failed rows in a day-window read (escape hatch, H1)", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		stubHybridRpc([ENRICHED_ROW, DISCOVERED_ROW, FAILED_ROW]);

		const out = await searchHandler({
			query: "backfill",
			captured_after: "2026-08-05T00:00:00Z",
			include_discovered: true,
		} as any);

		expect(out.content[0].text).toContain("enriched-atom");
		expect(out.content[0].text).toContain("discovered-pointer");
		expect(out.content[0].text).toContain("failed-pointer");
	});

	// N1 (round-2 QA): the hybrid escape-hatch test above and the filter-only one below
	// left the FTS-only path (search.ts:273) covered only by reading, not by a test —
	// and it's the path that runs whenever the embedding provider is absent or degraded
	// (#486), so not hypothetical. Mirrors the hybrid test exactly but via the FTS RPC.
	it("include_discovered=true opts back into discovered/failed rows in an FTS-only day-window read (escape hatch, H1/N1)", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		stubFtsRankRpc([ENRICHED_ROW, DISCOVERED_ROW, FAILED_ROW]);

		const out = await searchHandler({
			query: "backfill",
			captured_after: "2026-08-05T00:00:00Z",
			include_discovered: true,
		} as any);

		expect(out.content[0].text).toContain("enriched-atom");
		expect(out.content[0].text).toContain("discovered-pointer");
		expect(out.content[0].text).toContain("failed-pointer");
	});

	// N2 (round-2 QA): include_discovered now also gates 'failed' rows, but both
	// 'discovered' and 'failed' are body-less pointers that otherwise render
	// identically — format() tags the stage so an opted-in caller can tell them
	// apart without a second lookup.
	it("format() renders lifecycle_stage on discovered/failed rows so an opted-in caller can tell them apart (N2)", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		stubHybridRpc([DISCOVERED_ROW, FAILED_ROW]);

		const out = await searchHandler({
			query: "backfill",
			captured_after: "2026-08-05T00:00:00Z",
			include_discovered: true,
		} as any);

		expect(out.content[0].text).toContain("Deathly Hallows.pdf [discovered]");
		expect(out.content[0].text).toContain("Contract.pdf [failed]");
	});

	it("adds the NULL-safe lifecycle_stage positive predicate (ENRICHED_STAGES) on the filter-only path (day window)", async () => {
		const orCalls: unknown[] = [];
		const b: any = {
			select: () => b,
			eq: () => b,
			in: () => b,
			gte: () => b,
			lte: () => b,
			not: () => b,
			or: (arg: unknown) => {
				orCalls.push(arg);
				return b;
			},
			order: () => b,
			limit: () => Promise.resolve({ data: [ENRICHED_ROW], error: null, count: 1 }),
		};
		(supabase as any).from = vi.fn(() => b);

		await searchHandler({ captured_after: "2026-08-05T00:00:00Z" } as any);

		expect(orCalls).toContainEqual(
			`lifecycle_stage.is.null,lifecycle_stage.in.(${[...ENRICHED_STAGES].join(",")})`,
		);
	});

	it("include_discovered=true skips the lifecycle_stage exclusion predicate on the filter-only path (escape hatch, H1)", async () => {
		const orCalls: unknown[] = [];
		const b: any = {
			select: () => b,
			eq: () => b,
			in: () => b,
			gte: () => b,
			lte: () => b,
			not: () => b,
			or: (arg: unknown) => {
				orCalls.push(arg);
				return b;
			},
			order: () => b,
			limit: () =>
				Promise.resolve({ data: [ENRICHED_ROW, DISCOVERED_ROW], error: null, count: 2 }),
		};
		(supabase as any).from = vi.fn(() => b);

		const out = await searchHandler({
			captured_after: "2026-08-05T00:00:00Z",
			include_discovered: true,
		} as any);

		expect(orCalls).not.toContainEqual(
			`lifecycle_stage.is.null,lifecycle_stage.in.(${[...ENRICHED_STAGES].join(",")})`,
		);
		expect(out.content[0].text).toContain("discovered-pointer");
	});
});

// Issue #567 acceptance criterion: "knowledge_search's overflow count is honest on
// filter-only reads". Previously the filter-only path over-fetched `limit + 1` rows
// to detect truncation, so it could only ever report "1 more" no matter how much was
// actually hidden — a day-window read burying dozens of rows behind the cap looked
// identical to one hiding a single row. The fix asks PostgREST for an exact count
// (`{ count: "exact" }`) alongside the page of rows.
describe("searchHandler — honest overflow count on filter-only reads (#567)", () => {
	/** Stub the filter-only path's query builder, resolving `limit()` with both a
	 * page of `data` and an exact `count` (mirrors what PostgREST returns for
	 * `.select(cols, { count: "exact" })`). */
	function stubFilterOnlyWithCount(data: unknown[], count: number) {
		const b: any = {
			select: () => b,
			eq: () => b,
			in: () => b,
			gte: () => b,
			lte: () => b,
			not: () => b,
			or: () => b,
			order: () => b,
			limit: () => Promise.resolve({ data, error: null, count }),
			maybeSingle: () => Promise.resolve({ data: null, error: null }),
		};
		(supabase as any).from = vi.fn(() => b);
		(supabase as any).rpc = vi.fn((fnName: string) => {
			if (fnName === "search_unconsumed_artifacts") {
				return Promise.resolve({
					data: (data as any[]).map((r) => ({ ...r, total_count: count })),
					error: null,
				});
			}
			return Promise.resolve({ data: null, error: new Error(`unknown RPC: ${fnName}`) });
		});
	}

	it("reports the true hidden count when it is far larger than the old '+1 row' trick could ever show", async () => {
		const page = Array.from({ length: 2 }, (_, i) => ({ ...ROW, id: `row-${i}` }));
		// 347 total matches, only 2 returned (limit=2) — the pre-fix code could only ever
		// have said "1 more" here (it over-fetched limit+1 = 3 rows at most).
		stubFilterOnlyWithCount(page, 347);

		const out = await searchHandler({ not_consumed: true, limit: 2 } as any);

		expect(out.content[0].text).toContain("345 more result(s) not shown");
		expect(out.content[0].text).not.toContain("1 more result(s) not shown");
	});

	it("reports zero truncation (no overflow note) when the count exactly matches the returned page", async () => {
		const page = [ROW];
		stubFilterOnlyWithCount(page, 1);

		const out = await searchHandler({ not_consumed: true, limit: 10 } as any);

		expect(out.content[0].text).not.toContain("more result(s) not shown");
	});

	it("falls back to zero truncation when no count is supplied (defensive default, not a false '1 more')", async () => {
		const b: any = {
			select: () => b,
			eq: () => b,
			in: () => b,
			gte: () => b,
			lte: () => b,
			not: () => b,
			or: () => b,
			order: () => b,
			limit: () => Promise.resolve({ data: [ROW], error: null }),
			maybeSingle: () => Promise.resolve({ data: null, error: null }),
		};
		(supabase as any).from = vi.fn(() => b);
		(supabase as any).rpc = vi.fn((fnName: string) => {
			if (fnName === "search_unconsumed_artifacts") {
				return Promise.resolve({
					data: [{ ...ROW, total_count: 1 }],
					error: null,
				});
			}
			return Promise.resolve({ data: null, error: new Error(`unknown RPC: ${fnName}`) });
		});

		const out = await searchHandler({ not_consumed: true } as any);

		expect(out.content[0].text).not.toContain("more result(s) not shown");
	});
});

// Issue #561 / ADR-050 section 8: the unattended sweep stamps `synthesized_unattended` on
// a day the owner never sat down for. `not_consumed` is a bare boolean over the whole
// marker vocabulary, so a swept atom vanishes from EVERY unconsumed read - including the
// attended Catch-up read the owner uses to review that very day. Draft-and-stop would
// degrade into draft-and-LOCK. `consumed_kinds` narrows the consumption predicate so a
// swept day stays re-openable.
describe("searchHandler - consumed_kinds (#561)", () => {
	/**
	 * Stub the filter-only path with search_unconsumed_artifacts RPC stand-in that honours
	 * the kind filter, so "included by consumed_kinds: ['synthesized']" is a real behavioural assertion.
	 */
	function stubMarkerTable(markers: Array<{ artifact_id: string; kind: string }>) {
		const prefsQuery: any = {
			select: () => prefsQuery,
			eq: () => prefsQuery,
			maybeSingle: () => Promise.resolve({ data: null, error: null }),
		};
		(supabase as any).from = vi.fn(() => prefsQuery);
		const kindFilters: string[][] = [];
		const rpcCalls: any[] = [];
		(supabase as any).rpc = vi.fn((fnName: string, params: any) => {
			if (fnName === "search_unconsumed_artifacts") {
				rpcCalls.push(params);
				kindFilters.push(params.p_kinds);
				const consumedSet = new Set(
					markers.filter((m) => params.p_kinds.includes(m.kind)).map((m) => m.artifact_id),
				);
				const rows = consumedSet.has(ROW.id) ? [] : [ROW];
				return Promise.resolve({
					data: rows.map((r) => ({ ...r, total_count: rows.length })),
					error: null,
				});
			}
			return Promise.resolve({ data: null, error: new Error(`unknown RPC: ${fnName}`) });
		});
		return { kindFilters, rpcCalls };
	}

	// ACCEPTANCE (#561, build-plan item 2), half one: existing behaviour, unchanged.
	it("still excludes an atom carrying only the unattended marker when consumed_kinds is omitted", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const { kindFilters } = stubMarkerTable([
			{ artifact_id: "artifact-1", kind: "synthesized_unattended" },
		]);

		const out = await searchHandler({ not_consumed: true } as any);

		expect(kindFilters).toEqual([["synthesized", "synthesized_unattended"]]);
		expect(out.content[0].text).not.toContain("artifact-1");
	});

	// ACCEPTANCE (#561, build-plan item 2), half two: the same atom comes BACK when only
	// human-confirmed synthesis counts as consumption. This is the whole reversibility
	// property - without it the sweep is a one-way door with dos-catchup unbuilt.
	it("includes an atom carrying only the unattended marker when consumed_kinds is ['synthesized']", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const { kindFilters } = stubMarkerTable([
			{ artifact_id: "artifact-1", kind: "synthesized_unattended" },
		]);

		const out = await searchHandler({
			not_consumed: true,
			consumed_kinds: ["synthesized"],
		} as any);

		expect(kindFilters).toEqual([["synthesized"]]);
		expect(out.content[0].text).toContain("artifact-1");
	});

	it("still excludes an atom the owner confirmed when consumed_kinds is ['synthesized']", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const { kindFilters } = stubMarkerTable([
			{ artifact_id: "artifact-1", kind: "synthesized" },
		]);

		const out = await searchHandler({
			not_consumed: true,
			consumed_kinds: ["synthesized"],
		} as any);

		expect(kindFilters).toEqual([["synthesized"]]);
		expect(out.content[0].text).not.toContain("artifact-1");
	});

	it("rejects an empty consumed_kinds array rather than silently consuming nothing", () => {
		const parsed = z
			.object(searchInput)
			.safeParse({ not_consumed: true, consumed_kinds: [] });
		expect(parsed.success).toBe(false);
	});

	it("rejects a kind outside the ADR-050 section 6 vocabulary", () => {
		const parsed = z
			.object(searchInput)
			.safeParse({ not_consumed: true, consumed_kinds: ["consumed_by_state"] });
		expect(parsed.success).toBe(false);
	});
});

// Issue #677: `not_consumed` keyed on marker KIND with no provider predicate, so
// consumption was a global fact. Once `angus` gained a Daily Log of its own (#674), an
// atom folded into it looked already-consumed to the next `work` run — never offered,
// never synthesised, silently lost from the Work day. The ledger has always carried
// `provider` in its unique key; only this read discarded it.
describe("searchHandler - domain-scoped consumption (#677)", () => {
	/**
	 * Stub the filter-only path with a marker table that HONOURS both predicates — the
	 * `kind` list and the `provider` scope — so every assertion below is behavioural.
	 * Returns each provider the links lookup scoped to (empty when it applied no provider
	 * predicate at all) and the `.not("id","in",…)` exclusions the artifacts query applied.
	 */
	function stubDomainMarkerTable(
		markers: Array<{ artifact_id: string; kind: string; provider?: string }>,
	) {
		const prefsQuery: any = {
			select: () => prefsQuery,
			eq: () => prefsQuery,
			maybeSingle: () => Promise.resolve({ data: null, error: null }),
		};
		(supabase as any).from = vi.fn(() => prefsQuery);
		const providerScopes: string[] = [];
		const rpcCalls: any[] = [];
		(supabase as any).rpc = vi.fn((fnName: string, params: any) => {
			if (fnName === "search_unconsumed_artifacts") {
				rpcCalls.push(params);
				if (params.p_provider) {
					providerScopes.push(params.p_provider);
				}
				const kinds: string[] = params.p_kinds ?? [];
				const scope = params.p_provider;
				const consumedSet = new Set(
					markers
						.filter((m) => kinds.includes(m.kind) && (!scope || m.provider === scope))
						.map((m) => m.artifact_id),
				);
				const rows = consumedSet.has(ROW.id) ? [] : [ROW];
				return Promise.resolve({
					data: rows.map((r) => ({ ...r, total_count: rows.length })),
					error: null,
				});
			}
			return Promise.resolve({ data: null, error: new Error(`unknown RPC: ${fnName}`) });
		});
		return { providerScopes, rpcCalls };
	}

	/** artifact-1 (the ROW fixture), consumed by the PERSONAL ritual and nobody else. */
	const CONSUMED_BY_ANGUS = [
		{ artifact_id: "artifact-1", kind: "synthesized", provider: DOMAIN_PROVIDER.angus },
	];

	// ACCEPTANCE: "a `synthesized` marker under one domain's provider does not suppress
	// the atom from a `not_consumed` read scoped to the other domain".
	it("still offers an atom the personal ritual consumed to a work-scoped read", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const { providerScopes } = stubDomainMarkerTable(CONSUMED_BY_ANGUS);

		const out = await searchHandler({ not_consumed: true, domain: "work" } as any);

		expect(providerScopes).toEqual([DOMAIN_PROVIDER.work]);
		expect(out.content[0].text).toContain("artifact-1");
	});

	it("still excludes that atom from the angus-scoped read that consumed it", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const { providerScopes } = stubDomainMarkerTable(CONSUMED_BY_ANGUS);

		const out = await searchHandler({ not_consumed: true, domain: "angus" } as any);

		expect(providerScopes).toEqual([DOMAIN_PROVIDER.angus]);
		expect(out.content[0].text).not.toContain("artifact-1");
	});

	// ACCEPTANCE: "unscoped calls keep today's exact behaviour" — no provider predicate,
	// NOT a default domain. A default would silently narrow every pre-#677 caller.
	it("applies no provider predicate at all when domain is omitted, and still excludes the atom", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const { providerScopes } = stubDomainMarkerTable(CONSUMED_BY_ANGUS);

		const out = await searchHandler({ not_consumed: true } as any);

		expect(providerScopes).toEqual([]);
		expect(out.content[0].text).not.toContain("artifact-1");
	});

	it("composes with consumed_kinds — both predicates apply, neither defaults into the other", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const { providerScopes, rpcCalls } = stubDomainMarkerTable([
			{
				artifact_id: "artifact-1",
				kind: "synthesized_unattended",
				provider: DOMAIN_PROVIDER.work,
			},
		]);

		// Right domain, wrong kind: a swept Work atom is unconsumed for an attended
		// Work Catch-up, exactly as it was before domain scoping existed.
		const out = await searchHandler({
			not_consumed: true,
			domain: "work",
			consumed_kinds: ["synthesized"],
		} as any);

		expect(providerScopes).toEqual([DOMAIN_PROVIDER.work]);
		expect(rpcCalls[0].p_kinds).toEqual(["synthesized"]);
		expect(out.content[0].text).toContain("artifact-1");
	});

	it("rejects a domain outside the ADR-051 §1 routing axis", () => {
		const parsed = z
			.object(searchInput)
			.safeParse({ not_consumed: true, domain: "infra" });
		expect(parsed.success).toBe(false);
	});
});

// Issue #561, build-plan item 3: every day-window consumer buckets on captured_at, and a
// caller that had to infer the day from result order would mis-attribute it. The date is
// emitted per row so the ritual can report honestly which days it is looking at.
describe("searchHandler - captured_at is emitted per result (#561)", () => {
	it("shows each result's captured date in a day-window read", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		stubArtifactsQuery([
			{ ...ROW, id: "a-12", captured_at: "2026-08-12T09:30:00Z", effective_at: "2026-08-12T09:30:00Z" },
			{ ...ROW, id: "a-13", captured_at: "2026-08-13T22:15:00Z", effective_at: "2026-08-13T22:15:00Z" },
		]);

		const out = await searchHandler({
			captured_after: "2026-08-12T00:00:00Z",
			captured_before: "2026-08-13T23:59:59Z",
		} as any);

		expect(out.content[0].text).toContain("[a-12] Test artifact (captured 2026-08-12)");
		expect(out.content[0].text).toContain("[a-13] Test artifact (captured 2026-08-13)");
	});

	it("says so rather than guessing when an artifact has no captured_at", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		stubArtifactsQuery([{ ...ROW, id: "a-null", captured_at: null, effective_at: null }]);

		const out = await searchHandler({ not_consumed: true } as any);

		expect(out.content[0].text).toContain("[a-null] Test artifact (captured date unknown)");
	});

	it("keeps the stage tag and the captured date side by side on an unenriched pointer", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		stubArtifactsQuery([
			{
				...ROW,
				id: "a-disc",
				lifecycle_stage: "discovered",
				captured_at: "2026-08-14T08:00:00Z", effective_at: "2026-08-14T08:00:00Z",
			},
		]);

		const out = await searchHandler({
			not_consumed: true,
			include_discovered: true,
		} as any);

		expect(out.content[0].text).toContain(
			"[a-disc] Test artifact [discovered] (captured 2026-08-14)",
		);
	});
});

// Issue #587 (deferred from #581 QA round 1, finding L3): the filter-only path got an
// exact PostgREST count in #581, but the two ranked paths still derive their count from
// a `limit * 3` over-fetch — so they can only ever see `2 * limit` hidden rows however
// many exist. Both notes were worded identically, so a caller could not tell an exact
// count from a capped estimate. The fix does not make the ranked count exact (that needs
// a signature change to two live RPCs); it makes the difference legible.
describe("searchHandler — ranked-path truncation is labelled as a bound, not a count (#587)", () => {
	/** `limit * 3` rows back from the RPC means it hit its own match_limit: rows it never
	 * returned may also have matched, so anything derived from this page is a floor. */
	function saturatedPage(limit: number) {
		return Array.from({ length: limit * 3 }, (_, i) => ({ ...ROW, id: `row-${i}` }));
	}

	it("says 'at least N more' on a hybrid read whose over-fetch ceiling was reached", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		stubHybridRpc(saturatedPage(2));

		const out = await searchHandler({ query: "test", limit: 2 } as any);

		// 6 rows back, 2 shown: 4 hidden that we can see, and an unknown number we cannot.
		expect(out.content[0].text).toContain("at least 4 more result(s) not shown");
		expect(out.content[0].text).toContain("ranked-search ceiling reached");
	});

	it("says a plain 'N more' on a hybrid read that did NOT reach the ceiling — there the count is exact", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		// 5 < limit*3 (6), so the RPC returned everything it had: 3 hidden, exactly.
		stubHybridRpc(Array.from({ length: 5 }, (_, i) => ({ ...ROW, id: `row-${i}` })));

		const out = await searchHandler({ query: "test", limit: 2 } as any);

		expect(out.content[0].text).toContain("3 more result(s) not shown");
		expect(out.content[0].text).not.toContain("at least");
	});

	it("still warns when the ceiling was reached but post-filtering left nothing over — silence there would hide the same gap", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		// Ceiling reached, but every row is filtered out of the window bar one, so the
		// visible overflow is 0 while the unseen remainder is still unknown.
		const rows = saturatedPage(2).map((r, i) =>
			i === 0 ? r : { ...r, captured_at: "2020-01-01T00:00:00Z", effective_at: "2020-01-01T00:00:00Z" },
		);
		stubHybridRpc(rows);

		const out = await searchHandler({
			query: "test",
			limit: 2,
			captured_after: "2026-01-01T00:00:00Z",
		} as any);

		expect(out.content[0].text).toContain("More results may exist");
	});

	it("applies the same bound-vs-count distinction on the full-text-only path", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		stubFtsRankRpc(saturatedPage(2));

		const out = await searchHandler({ query: "test", limit: 2 } as any);

		expect(out.content[0].text).toContain("at least 4 more result(s) not shown");
	});

	// QA round 1 on #587: the ceiling was originally taken to be `limit * 3` for both
	// ranked paths. hybrid_search_artifacts caps each arm at `least(match_limit,30)*2`
	// (migration 069), so it tops out near 120 rows — and with limit capped at 50,
	// `limit * 3` reaches 150. Every hybrid read above limit 40 therefore reported
	// `exact: true` however much was cut off: the precise claim #587 exists to stop.
	it("does not claim exactness on a large-limit hybrid read the RPC capped internally", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		// limit 45 -> match_limit 135, but the RPC tops out at 120, so 120 IS saturation.
		stubHybridRpc(Array.from({ length: 120 }, (_, i) => ({ ...ROW, id: `row-${i}` })));

		const out = await searchHandler({ query: "test", limit: 45 } as any);

		expect(out.content[0].text).toContain("at least 75 more result(s) not shown");
		expect(out.content[0].text).toContain("ranked-search ceiling reached");
	});

	it("still reports an exact count on a large-limit hybrid read that came back under the cap", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		// 100 < 120, so the RPC was not cut off and the overflow is genuinely exact.
		stubHybridRpc(Array.from({ length: 100 }, (_, i) => ({ ...ROW, id: `row-${i}` })));

		const out = await searchHandler({ query: "test", limit: 45 } as any);

		expect(out.content[0].text).toContain("55 more result(s) not shown");
		expect(out.content[0].text).not.toContain("at least");
	});

	// fts_search_artifacts has no internal cap (bare `limit match_limit`, 066/069), so
	// its ceiling stays the over-fetch even at a large limit.
	it("keeps the over-fetch as the ceiling on the uncapped full-text path", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		stubFtsRankRpc(Array.from({ length: 120 }, (_, i) => ({ ...ROW, id: `row-${i}` })));

		const out = await searchHandler({ query: "test", limit: 45 } as any);

		// 120 < 135, and nothing capped it, so this overflow is exact.
		expect(out.content[0].text).toContain("75 more result(s) not shown");
		expect(out.content[0].text).not.toContain("at least");
	});


	it("leaves the filter-only path's exact count worded as exact (#567/#581 regression)", async () => {
		const b: any = {
			select: () => b,
			eq: () => b,
			in: () => b,
			gte: () => b,
			lte: () => b,
			not: () => b,
			or: () => b,
			order: () => b,
			limit: () =>
				Promise.resolve({ data: [{ ...ROW }], error: null, count: 50 }),
			maybeSingle: () => Promise.resolve({ data: null, error: null }),
		};
		(supabase as any).from = vi.fn(() => b);
		(supabase as any).rpc = vi.fn((fnName: string) => {
			if (fnName === "search_unconsumed_artifacts") {
				return Promise.resolve({
					data: [{ ...ROW, total_count: 50 }],
					error: null,
				});
			}
			return Promise.resolve({ data: null, error: new Error(`unknown RPC: ${fnName}`) });
		});

		const out = await searchHandler({ not_consumed: true, limit: 1 } as any);

		expect(out.content[0].text).toContain("49 more result(s) not shown");
		expect(out.content[0].text).not.toContain("at least");
	});
});

// ADR-047 §4 / #553: knowledge_search fans out to the graph RPCs (migration 097)
// alongside the artifact one, fuses the three ranked lists at the tool layer with a
// representation guard, and labels results by kind. This is the slice that actually
// closes #137 end-to-end: everything before it (#550-#552) built the columns, the
// embed-on-write pipeline, and the RPCs, but nothing called them from search yet.
describe("searchHandler — graph fan-out, representation guard, kind labels (ADR-047 §4 / #553)", () => {
	const PERSON = { id: "person-1", title: "Sam Nobody", description: null };
	const ENTITY = { id: "entity-1", title: "Acme Corp", description: "A vendor." };

	/** Route each RPC by name to its own fixture. `undefined` for an arm not
	 * listed means "no matches", matching the RPC's real empty-result shape. */
	function stubArms(arms: {
		artifact?: unknown[];
		entity?: unknown[];
		person?: unknown[];
		entityError?: string;
		personError?: string;
	}) {
		const byName: Record<string, unknown[]> = {
			hybrid_search_artifacts: arms.artifact ?? [],
			fts_search_artifacts: arms.artifact ?? [],
			hybrid_search_entities: arms.entity ?? [],
			fts_search_entities: arms.entity ?? [],
			hybrid_search_people: arms.person ?? [],
			fts_search_people: arms.person ?? [],
		};
		const rpc = vi.fn((name: string, params: unknown) => ({
			select: () => {
				if (name === "hybrid_search_entities" || name === "fts_search_entities") {
					if (arms.entityError) return Promise.resolve({ data: null, error: { message: arms.entityError } });
				}
				if (name === "hybrid_search_people" || name === "fts_search_people") {
					if (arms.personError) return Promise.resolve({ data: null, error: { message: arms.personError } });
				}
				return Promise.resolve({ data: byName[name] ?? [], error: null });
			},
			_params: params,
		}));
		(supabase as any).rpc = rpc;
		return rpc;
	}

	it("surfaces a person with no matching artifact text on the hybrid path (#137)", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		stubArms({ person: [PERSON] });

		const out = await searchHandler({ query: "Sam Nobody" } as any);

		expect(out.content[0].text).toContain("Sam Nobody");
		expect(out.content[0].text).toContain("[person]");
	});

	it("surfaces the same person recall degraded to FTS-only (no OpenAI key) — the common case", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		stubArms({ person: [PERSON] });

		const out = await searchHandler({ query: "Sam Nobody" } as any);

		expect(out.content[0].text).toContain("search_mode: full-text-only");
		expect(out.content[0].text).toContain("Sam Nobody");
		expect(out.content[0].text).toContain("[person]");
	});

	it("labels an entity hit distinctly from a person hit, and leaves artifact rows unlabelled", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		stubArms({ artifact: [ROW], entity: [ENTITY], person: [PERSON] });

		const out = await searchHandler({ query: "test" } as any);

		expect(out.content[0].text).toContain("[entity]");
		expect(out.content[0].text).toContain("[person]");
		// The artifact row's own line must carry no kind label at all.
		const artifactLine = out.content[0].text
			.split("\n")
			.find((line) => line.includes(ROW.id));
		expect(artifactLine).toBeDefined();
		expect(artifactLine).not.toMatch(/\[(entity|person)\]/);
	});

	it("representation guard: a name-exact person hit outranks an incidental artifact mention", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		// The artifact arm's OWN ranking puts this artifact first (rank 0) -- an
		// incidental body mention that still out-ranked everything else the user has.
		// The person arm returns an exact title match for the query, also at rank 0
		// within its own arm. ADR-047 §4's invariant is that the name-exact graph hit
		// still wins the merge despite tying on rank position.
		const incidentalArtifact = {
			...ROW,
			id: "artifact-incidental",
			title: "Sprawling meeting transcript",
			plain_text: "... mentions Sam Nobody once, in passing, among thousands of words ...",
		};
		const exactPerson = { id: "person-exact", title: "Sam Nobody", description: null };
		stubArms({ artifact: [incidentalArtifact], person: [exactPerson] });

		const out = await searchHandler({ query: "Sam Nobody" } as any);

		const personIdx = out.content[0].text.indexOf("person-exact");
		const artifactIdx = out.content[0].text.indexOf("artifact-incidental");
		expect(personIdx).toBeGreaterThanOrEqual(0);
		expect(artifactIdx).toBeGreaterThan(personIdx);
	});

	it("surfaces a term entity matching its expansion (AC 1 / #1153)", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		const termEntity = {
			id: "entity-psr",
			title: "PSR",
			description: null,
			properties: { expansion: "Pipeline Status Report", context: "Work finance" },
		};
		stubArms({ entity: [termEntity] });

		const out = await searchHandler({ query: "Pipeline Status Report" } as any);

		expect(out.content[0].text).toContain("PSR");
		expect(out.content[0].text).toContain("[entity]");
		expect(out.content[0].text).toContain("Pipeline Status Report (Work finance)");
	});

	it("surfaces a person matching their nickname/alias (AC 2 / #1153)", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		const personWithAlias = {
			id: "person-todd",
			title: "Alexander Smith",
			description: null,
			aliases: ["todd"],
		};
		stubArms({ person: [personWithAlias] });

		const out = await searchHandler({ query: "todd" } as any);

		expect(out.content[0].text).toContain("Alexander Smith");
		expect(out.content[0].text).toContain("[person]");
		expect(out.content[0].text).toContain("aka: todd");
	});

	it("representation guard: an alias-exact person hit outranks an incidental artifact mention (#1153)", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		const incidentalArtifact = {
			...ROW,
			id: "artifact-incidental",
			title: "Long transcript",
			plain_text: "... mentions todd once in passing ...",
		};
		const personWithAlias = {
			id: "person-todd",
			title: "Alexander Smith",
			description: "Engineer",
			aliases: ["todd"],
		};
		stubArms({ artifact: [incidentalArtifact], person: [personWithAlias] });

		const out = await searchHandler({ query: "todd" } as any);

		const personIdx = out.content[0].text.indexOf("person-todd");
		const artifactIdx = out.content[0].text.indexOf("artifact-incidental");
		expect(personIdx).toBeGreaterThanOrEqual(0);
		expect(artifactIdx).toBeGreaterThan(personIdx);
	});

	it("representation guard: an expansion-exact term hit outranks an incidental artifact mention (#1153)", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		const incidentalArtifact = {
			...ROW,
			id: "artifact-incidental",
			title: "Sprawling document",
			plain_text: "... incidental mention of Pipeline Status Report in a footnote ...",
		};
		const termEntity = {
			id: "entity-psr",
			title: "PSR",
			description: null,
			properties: { expansion: "Pipeline Status Report" },
		};
		stubArms({ artifact: [incidentalArtifact], entity: [termEntity] });

		const out = await searchHandler({ query: "Pipeline Status Report" } as any);

		const termIdx = out.content[0].text.indexOf("entity-psr");
		const artifactIdx = out.content[0].text.indexOf("artifact-incidental");
		expect(termIdx).toBeGreaterThanOrEqual(0);
		expect(artifactIdx).toBeGreaterThan(termIdx);
	});

	it("a graph-arm RPC error does not fail artifact results (ADR-047 §4)", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		stubArms({ artifact: [ROW], entityError: "relation does not exist", personError: "relation does not exist" });

		const out = await searchHandler({ query: "test query" } as any);

		expect(out.content[0].text).toContain("Test artifact");
		expect(out.content[0].text).not.toContain("[entity]");
		expect(out.content[0].text).not.toContain("[person]");
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("hybrid_search_entities"));
		stderrSpy.mockRestore();
	});

	it("passes include_archived through to both graph RPCs on the hybrid path", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		const rpc = stubArms({});

		await searchHandler({ query: "test", include_archived: true } as any);

		expect(rpc).toHaveBeenCalledWith(
			"hybrid_search_entities",
			expect.objectContaining({ include_archived: true }),
		);
		expect(rpc).toHaveBeenCalledWith(
			"hybrid_search_people",
			expect.objectContaining({ include_archived: true }),
		);
	});

	it("passes include_archived through to both graph RPCs on the degraded FTS-only path", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const rpc = stubArms({});

		await searchHandler({ query: "test", include_archived: true } as any);

		expect(rpc).toHaveBeenCalledWith(
			"fts_search_entities",
			expect.objectContaining({ include_archived: true }),
		);
		expect(rpc).toHaveBeenCalledWith(
			"fts_search_people",
			expect.objectContaining({ include_archived: true }),
		);
	});

	it("never calls a graph RPC on the filter-only path (no query to rank against)", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const rpc = vi.fn(() => {
			throw new Error("no RPC should be called on the filter-only path");
		});
		(supabase as any).rpc = rpc;
		stubArtifactsQuery([ROW]);

		const out = await searchHandler({ not_consumed: true } as any);

		expect(rpc).not.toHaveBeenCalled();
		expect(out.content[0].text).toContain("Test artifact");
	});

	it("embeds the query once and reuses it for every arm, rather than embedding per arm", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-openai-key";
		stubArms({ artifact: [ROW], entity: [ENTITY], person: [PERSON] });

		await searchHandler({ query: "test query" } as any);

		expect(embed).toHaveBeenCalledTimes(1);
	});
});

describe("searchHandler - evaluate not_consumed in the database (#1769)", () => {
	beforeEach(() => {
		const prefsQuery: any = {
			select: () => prefsQuery,
			eq: () => prefsQuery,
			maybeSingle: () => Promise.resolve({ data: null, error: null }),
		};
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "user_preferences") return prefsQuery;
			throw new Error(`unexpected table in not_consumed test: ${table}`);
		});
	});

	it("migration 135 index IN (...) list matches ENRICHED_STAGES", () => {
		const migrationPath = path.resolve(
			repoRoot,
			"supabase/migrations/20261014160000_135_knowledge_search_unconsumed_rpc.sql",
		);
		const sql = fs.readFileSync(migrationPath, "utf-8");
		const match = sql.match(
			/idx_artifacts_user_enriched_effective[\s\S]*?WHERE[\s\S]*?lifecycle_stage IN \(([\s\S]*?)\)/,
		);
		expect(match).not.toBeNull();
		const stages = match![1]
			.split(",")
			.map((s) => s.trim().replace(/^'|'$/g, ""))
			.filter(Boolean);
		expect(stages.sort()).toEqual([...ENRICHED_STAGES].sort());
	});

	it("threads domain, consumed_kinds, and tags to the RPC as p_provider, p_kinds, and p_tags (without p_offset)", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		let rpcParams: any = null;
		(supabase as any).rpc = vi.fn((fnName: string, params: any) => {
			if (fnName === "search_unconsumed_artifacts") {
				rpcParams = params;
				return Promise.resolve({
					data: [{ ...ROW, total_count: 1 }],
					error: null,
				});
			}
			return Promise.resolve({ data: null, error: new Error(`unknown RPC: ${fnName}`) });
		});

		// 1. When domain/tags omitted: p_provider and p_tags are null, p_kinds defaults to synthesis marker kinds
		await searchHandler({ not_consumed: true } as any);
		expect(rpcParams).toMatchObject({
			p_provider: null,
			p_kinds: ["synthesized", "synthesized_unattended"],
			p_tags: null,
		});
		expect(rpcParams).not.toHaveProperty("p_offset");

		// 2. When domain and tags are provided: p_provider is mapped, p_kinds and p_tags are passed
		await searchHandler({
			not_consumed: true,
			domain: "work",
			consumed_kinds: ["synthesized"],
			tags: ["tag-a", "tag-b"],
		} as any);

		expect(rpcParams).toMatchObject({
			p_provider: DOMAIN_PROVIDER.work,
			p_kinds: ["synthesized"],
			p_tags: ["tag-a", "tag-b"],
		});
		expect(rpcParams).not.toHaveProperty("p_offset");
	});

	it("calls with p_limit: 1 when a role tier has no room left", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const rpcCalls: Array<{ fnName: string; params: any }> = [];
		(supabase as any).rpc = vi.fn((fnName: string, params: any) => {
			if (fnName === "search_unconsumed_artifacts") {
				rpcCalls.push({ fnName, params });
				if (rpcCalls.length === 1) {
					// First tier returns 1 row, which fills limit (limit: 1)
					return Promise.resolve({
						data: [{ ...ROW, id: "tier-1-row", total_count: 5 }],
						error: null,
					});
				}
				// Subsequent tiers called with limit 1 just to count
				return Promise.resolve({
					data: [{ ...ROW, id: "tier-2-count-row", total_count: 3 }],
					error: null,
				});
			}
			return Promise.resolve({ data: null, error: new Error(`unknown RPC: ${fnName}`) });
		});

		await searchHandler({
			not_consumed: true,
			rank_by_role: true,
			roles: ["narrative", "evidence", "metrics", "excluded"],
			limit: 1,
		} as any);

		expect(rpcCalls.length).toBeGreaterThan(1);
		// First tier has room (limit 1 + overfetch 50 = 51)
		expect(rpcCalls[0].params.p_limit).toBe(51);
		expect(rpcCalls[0].params).not.toHaveProperty("p_offset");
		// Second tier has room 0 (limit 1 is full), so rpcLimit is 1
		expect(rpcCalls[1].params.p_limit).toBe(1);
		expect(rpcCalls[1].params).not.toHaveProperty("p_offset");
	});

	it("does not decrement count-only tier total when probe row (room === 0) is robot-authored", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		let callIdx = 0;
		(supabase as any).rpc = vi.fn((fnName: string) => {
			if (fnName === "search_unconsumed_artifacts") {
				callIdx++;
				if (callIdx === 1) {
					// Narrative tier fills limit: 1
					return Promise.resolve({
						data: [{ ...ROW, id: "narrative-1", surface: "claude_code", total_count: 1 }],
						error: null,
					});
				}
				if (callIdx === 2) {
					// Evidence tier has room === 0 (count-only probe with p_limit: 1).
					// Even if the single probe row happens to carry robot_authored tag or robot body text,
					// rawTotal must remain the DB's total_count (3) rather than being decremented to 2.
					return Promise.resolve({
						data: [
							{
								...ROW,
								id: "evidence-probe-robot",
								surface: "act_receipt",
								tags: ["robot_authored"],
								total_count: 3,
							},
						],
						error: null,
					});
				}
				return Promise.resolve({ data: [], error: null });
			}
			return Promise.resolve({ data: null, error: new Error(`unknown RPC: ${fnName}`) });
		});

		const res = await searchHandler({
			not_consumed: true,
			rank_by_role: true,
			roles: ["narrative", "evidence", "metrics", "excluded"],
			limit: 1,
		} as any);

		expect(res.content[0].text).toContain("narrative 1");
		expect(res.content[0].text).toContain("evidence 3");
		expect(res.content[0].text).toContain("3 more result(s) not shown");
	});

	it("computes fallback totalCount before slicing and preserves exactness when total_count is null on timeout retry", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		let callCount = 0;
		// Case 1: retry returns 5 rows (< fetchLimit 52 for limit 2), so exact is true and totalCount is 5 (3 more not shown)
		(supabase as any).rpc = vi.fn((fnName: string, params: any) => {
			if (fnName === "search_unconsumed_artifacts") {
				callCount++;
				if (callCount === 1) {
					expect(params.p_with_count).toBe(true);
					return Promise.resolve({
						data: null,
						error: { code: "57014", message: "canceling statement due to statement timeout" },
					});
				}
				expect(params.p_with_count).toBe(false);
				expect(params.p_limit).toBe(52); // limit (2) + 50
				const rows = Array.from({ length: 5 }, (_, i) => ({
					...ROW,
					id: `retry-atom-${i}`,
					total_count: null,
				}));
				return Promise.resolve({ data: rows, error: null });
			}
			return Promise.resolve({ data: null, error: new Error(`unknown RPC: ${fnName}`) });
		});

		const resExact = await searchHandler({
			not_consumed: true,
			limit: 2,
		} as any);

		expect(resExact.content[0].text).toContain("3 more result(s) not shown");
		expect(resExact.content[0].text).not.toContain("at least");

		// Case 2: retry hits fetchLimit (52 rows for limit 2), so exact is false ("at least 50 more")
		callCount = 0;
		(supabase as any).rpc = vi.fn((fnName: string, params: any) => {
			if (fnName === "search_unconsumed_artifacts") {
				callCount++;
				if (callCount === 1) {
					return Promise.resolve({
						data: null,
						error: { code: "57014", message: "canceling statement due to statement timeout" },
					});
				}
				const rows = Array.from({ length: params.p_limit }, (_, i) => ({
					...ROW,
					id: `retry-full-${i}`,
					total_count: null,
				}));
				return Promise.resolve({ data: rows, error: null });
			}
			return Promise.resolve({ data: null, error: new Error(`unknown RPC: ${fnName}`) });
		});

		const resInexact = await searchHandler({
			not_consumed: true,
			limit: 2,
		} as any);

		expect(resInexact.content[0].text).toContain("at least 50 more result(s) not shown");
	});

	it("reports an exact total on the trailer when unconsumed rows are truncated", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		(supabase as any).rpc = vi.fn((fnName: string) => {
			if (fnName === "search_unconsumed_artifacts") {
				const rows = Array.from({ length: 5 }, (_, i) => ({
					...ROW,
					id: `atom-${i}`,
					total_count: 42,
				}));
				return Promise.resolve({
					data: rows,
					error: null,
				});
			}
			return Promise.resolve({ data: null, error: new Error(`unknown RPC: ${fnName}`) });
		});

		const res = await searchHandler({
			not_consumed: true,
			limit: 5,
		} as any);

		expect(res.content[0].text).toContain("37 more result(s) not shown");
		expect(res.content[0].text).not.toContain("~");
		expect(res.content[0].text).not.toContain("at least");
	});

	it("sends no RPC when not_consumed is omitted", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const rpcSpy = vi.fn();
		(supabase as any).rpc = rpcSpy;
		const artifacts: any = {
			select: () => artifacts,
			eq: () => artifacts,
			in: () => artifacts,
			gte: () => artifacts,
			lte: () => artifacts,
			or: () => artifacts,
			not: () => artifacts,
			filter: () => artifacts,
			order: () => artifacts,
			limit: () => Promise.resolve({ data: [ROW], error: null, count: 1 }),
		};
		(supabase as any).from = vi.fn(() => artifacts);

		await searchHandler({
			captured_after: "2026-10-01T00:00:00Z",
		} as any);

		expect(rpcSpy).not.toHaveBeenCalled();
		expect((supabase as any).from).toHaveBeenCalledWith("artifacts");
	});

	it("scopes marker lookup to candidate IDs in query-bearing searches (at most 150 candidate IDs)", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const candRows = Array.from({ length: 3 }, (_, i) => ({
			...ROW,
			id: `cand-${i}`,
		}));
		stubFtsRankRpc(candRows);

		let externalLinksQueryInCol: string | null = null;
		let externalLinksQueryInVals: any = null;

		const externalLinksQuery: any = {
			select: () => externalLinksQuery,
			eq: () => externalLinksQuery,
			in: (col: string, vals: any) => {
				if (col === "artifact_id") {
					externalLinksQueryInCol = col;
					externalLinksQueryInVals = vals;
				}
				return externalLinksQuery;
			},
			then: (resolve: any) =>
				resolve({
					data: [{ artifact_id: "cand-1" }],
					error: null,
				}),
		};

		const prefsQuery: any = {
			select: () => prefsQuery,
			eq: () => prefsQuery,
			maybeSingle: () => Promise.resolve({ data: null, error: null }),
		};

		(supabase as any).from = vi.fn((table: string) => {
			if (table === "artifact_external_links") return externalLinksQuery;
			if (table === "user_preferences") return prefsQuery;
			return null;
		});

		const res = await searchHandler({
			query: "test query",
			not_consumed: true,
		} as any);

		expect((supabase as any).from).toHaveBeenCalledWith("artifact_external_links");
		expect(externalLinksQueryInCol).toBe("artifact_id");
		expect(externalLinksQueryInVals).toEqual(["cand-0", "cand-1", "cand-2"]);

		// cand-1 was excluded in JS
		expect(res.content[0].text).toContain("cand-0");
		expect(res.content[0].text).not.toContain("cand-1");
		expect(res.content[0].text).toContain("cand-2");
	});
});

describe("searchHandler - non-not_consumed reads keep all roles (#2231)", () => {
	it("returns narrative, evidence, and metrics when not_consumed is omitted", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const rows = [
			{ ...ROW, id: "art-narr", title: "Narrative", surface: "claude_code" },
			{ ...ROW, id: "art-evid", title: "Evidence", surface: "github" },
			{ ...ROW, id: "art-met", title: "Metrics", surface: "kpi_snapshot" },
		];
		stubArtifactsQuery(rows);
		(supabase as any).rpc = vi.fn((fnName: string) => {
			if (fnName === "fts_search_artifacts") {
				return {
					select: () => Promise.resolve({ data: rows, error: null }),
				};
			}
			return {
				select: () => Promise.resolve({ data: [], error: null }),
			};
		});

		const queryOut = await searchHandler({ query: "roadmap" });
		expect(queryOut.content[0].text).toContain("art-narr");
		expect(queryOut.content[0].text).toContain("art-evid");
		expect(queryOut.content[0].text).toContain("art-met");

		const dateOut = await searchHandler({ captured_after: "2026-10-18T00:00:00Z" });
		expect(dateOut.content[0].text).toContain("art-narr");
		expect(dateOut.content[0].text).toContain("art-evid");
		expect(dateOut.content[0].text).toContain("art-met");
	});
});


