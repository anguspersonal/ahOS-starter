import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutable openaiApiKey so the embedding tests can turn the discover-side embed on
// and off. Everything else comes from the real env (supabase.ts builds a client at
// import time from it).
vi.mock("../env.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../env.js")>();
	return {
		...actual,
		env: { ...actual.env, openaiApiKey: undefined as string | undefined },
	};
});

// No real OpenAI calls. embedText mirrors the real join; embedBatchWithRetry returns
// one vector per input by default and is overridden per test to model failures.
vi.mock("../embeddings.js", () => ({
	embedText: vi.fn(
		(a: { title?: string | null; description?: string | null }) =>
			[a.title, a.description].filter(Boolean).join("\n\n").trim(),
	),
	embedBatchWithRetry: vi.fn(async (texts: string[]) => texts.map((_, i) => [i, 0.5])),
}));

import type { z } from "zod";
import { executeAction, type discoverSchema } from "@ahkms/core";
import { supabase } from "../supabase.js";
import { env } from "../env.js";
import { embedBatchWithRetry } from "../embeddings.js";
import {
	DISCOVER_INSERT_BATCH_SIZE,
	ingestDiscoverAction,
	discoverHandler,
	softArchiveSourceTrashed,
} from "./discover.js";

const runDiscover = (input: z.input<typeof discoverSchema>) =>
	executeAction(ingestDiscoverAction, input, { context: { caller: "worker" } });

// Unit tests for the discover write-side hygiene rules (issue #428) and the
// discover-time embedding (#427). No live Supabase / connector calls: supabase.from
// is swapped for a chainable stub that records the rows discover would have
// inserted/updated.

const origFrom = supabase.from;
const origRpc = supabase.rpc;

beforeEach(() => {
	vi.mocked(embedBatchWithRetry)
		.mockReset()
		.mockImplementation(async (texts: string[]) => texts.map((_, i) => [i, 0.5]));
});

afterEach(() => {
	(supabase as any).from = origFrom;
	(supabase as any).rpc = origRpc;
	(env as { openaiApiKey?: string }).openaiApiKey = undefined;
	vi.clearAllMocks();
});

type Existing = {
	id: string;
	source: string | null;
	processing_metadata?: { discovery?: Record<string, unknown>; [key: string]: unknown } | null;
	archived?: boolean | null;
	archived_reason?: string | null;
};

type RpcCall = { fn: string; params: { p_user_id: string; p_rows: Record<string, unknown>[] } };

function mockSupabase(existing: Existing[] = []) {
	const inserts: Record<string, unknown>[][] = [];
	const updates: { values: Record<string, unknown>; filters: Record<string, unknown> }[] = [];
	const rpcs: RpcCall[] = [];

	// discover_envelope_refresh (migration 118) reports how many rows it updated; the
	// stub says "all of them" unless a test overrides supabase.rpc.
	(supabase as any).rpc = vi.fn((fn: string, params: RpcCall["params"]) => {
		rpcs.push({ fn, params });
		return Promise.resolve({ data: params.p_rows.length, error: null });
	});

	const selectBuilder = () => {
		const filters: Record<string, unknown> = {};
		const inFilters: Record<string, unknown[]> = {};
		const b: any = {
			eq: (col: string, val: unknown) => {
				filters[col] = val;
				return b;
			},
			in: (col: string, val: unknown[]) => {
				inFilters[col] = val;
				return b;
			},
			then: (resolve: (v: unknown) => unknown) => {
				let result = existing;
				if ("archived" in filters) {
					result = result.filter((r) => (r.archived ?? false) === filters.archived);
				}
				if ("source" in inFilters) {
					const list = inFilters.source;
					result = result.filter((r) => r.source && list.includes(r.source));
				}
				return resolve({ data: result, error: null });
			},
		};
		return b;
	};

	(supabase as any).from = vi.fn(() => ({
		select: () => selectBuilder(),
		insert: (rows: Record<string, unknown>[]) => {
			inserts.push(rows);
			return Promise.resolve({ error: null });
		},
		update: (values: Record<string, unknown>) => {
			const filters: Record<string, unknown> = {};
			const b: any = {
				eq: (col: string, val: unknown) => {
					filters[col] = val;
					return b;
				},
				in: (col: string, val: unknown) => {
					filters[col] = val;
					return b;
				},
				then: (resolve: (v: unknown) => unknown) => {
					updates.push({ values, filters });
					return resolve({ error: null });
				},
			};
			return b;
		},
	}));

	return { inserts, updates, rpcs };
}

/** The single inserted row for a one-item batch. */
function insertedRow(inserts: Record<string, unknown>[][]): Record<string, unknown> {
	expect(inserts).toHaveLength(1);
	expect(inserts[0]).toHaveLength(1);
	return inserts[0][0];
}

describe("ingest_discover - pointer processing_status (#428 #1)", () => {
	it("gives Notion pointer rows a terminal 'completed' status (nothing to process)", async () => {
		const { inserts } = mockSupabase();
		const counts = await runDiscover({
			connector: "notion",
			items: [{ external_id: "n1", title: "Page One" }],
		});
		expect(counts.inserted).toBe(1);
		const row = insertedRow(inserts);
		expect(row.processing_status).toBe("completed");
		// It is still a discovered pointer — eligible for enrichment if a reader lands.
		expect(row.lifecycle_stage).toBe("discovered");
	});

	it("keeps Drive pointer rows 'pending' for the budgeted enrich pass", async () => {
		const { inserts } = mockSupabase();
		await runDiscover({
			connector: "gdrive",
			items: [{ external_id: "d1", title: "Doc" }],
		});
		expect(insertedRow(inserts).processing_status).toBe("pending");
	});

	it("keeps the terminal status on re-discovery of changed Notion content", async () => {
		const { updates } = mockSupabase([
			{ id: "row-1", source: "n1", processing_metadata: { discovery: { content_hash: "old" } } },
		]);
		const counts = await runDiscover({
			connector: "notion",
			items: [{ external_id: "n1", title: "Page One", content_hash: "new" }],
		});
		expect(counts.updated).toBe(1);
		expect(updates).toHaveLength(1);
		expect(updates[0].values.processing_status).toBe("completed");
		expect(updates[0].values.lifecycle_stage).toBe("discovered");
	});
});

describe("ingest_discover - surface stamping (#570)", () => {
	it("stamps surface = source_channel on a new Drive pointer, not null", async () => {
		const { inserts } = mockSupabase();
		await runDiscover({
			connector: "gdrive",
			items: [{ external_id: "d1", title: "Doc" }],
		});
		const row = insertedRow(inserts);
		expect(row.surface).toBe("discovered_gdrive");
		expect(row.source_channel).toBe("discovered_gdrive");
	});

	it("stamps surface for any connector, not just gdrive", async () => {
		const { inserts } = mockSupabase();
		await runDiscover({
			connector: "notion",
			items: [{ external_id: "n1", title: "Page" }],
		});
		expect(insertedRow(inserts).surface).toBe("discovered_notion");
	});

	it("heals surface on re-discovery of changed content", async () => {
		const { updates } = mockSupabase([
			{ id: "row-1", source: "d1", processing_metadata: { discovery: { content_hash: "old" } } },
		]);
		await runDiscover({
			connector: "gdrive",
			items: [{ external_id: "d1", title: "Doc", content_hash: "new" }],
		});
		expect(updates[0].values.surface).toBe("discovered_gdrive");
	});
});

describe("ingest_discover - URL tracking suffix (#428 #2)", () => {
	it("strips the ?pvs=1 query suffix from Notion URLs", async () => {
		const { inserts } = mockSupabase();
		await runDiscover({
			connector: "notion",
			items: [
				{
					external_id: "n1",
					title: "Page",
					url: "https://www.notion.so/Page-c1619c140?pvs=1",
				},
			],
		});
		const row = insertedRow(inserts);
		expect(row.storage_url).toBe("https://www.notion.so/Page-c1619c140");
		const meta = row.processing_metadata as { discovery: { url: string } };
		expect(meta.discovery.url).toBe("https://www.notion.so/Page-c1619c140");
	});

	it("leaves non-suffix connectors' query params intact (Drive)", async () => {
		const { inserts } = mockSupabase();
		const url = "https://drive.google.com/file/d/abc/view?usp=sharing";
		await runDiscover({ connector: "gdrive", items: [{ external_id: "d1", title: "Doc", url }] });
		expect(insertedRow(inserts).storage_url).toBe(url);
	});
});

describe("ingest_discover - envelope field-copies (ADR-046 §2, #1210)", () => {
	const envelope = {
		message_id: "m1",
		part_id: "1",
		from: "Owner <owner@example.com>",
		subject: "Updated CV",
		inline: false,
	};

	it("stores owner_email, mime_type, size and the envelope in the discovery block", async () => {
		const { inserts } = mockSupabase();
		await runDiscover({
			connector: "gmail_attachment",
			items: [
				{
					external_id: "m1:1",
					title: "cv.pdf",
					owner: "Owner",
					owner_email: "owner@example.com",
					mime_type: "application/pdf",
					size: 81234,
					envelope,
				},
			],
		});
		const discovery = (insertedRow(inserts).processing_metadata as { discovery: Record<string, unknown> })
			.discovery;
		expect(discovery).toMatchObject({
			owner: "Owner",
			owner_email: "owner@example.com",
			mime_type: "application/pdf",
			size: 81234,
			envelope,
		});
	});

	it("writes none of those keys for a connector that does not serve them", async () => {
		// Absent, not null: Notion and hand-rolled agent calls keep exactly the block they
		// wrote before these fields existed. The same rule as #1228's Drive envelope.
		const { inserts } = mockSupabase();
		await runDiscover({ connector: "notion", items: [{ external_id: "n1", title: "Page" }] });
		const discovery = (insertedRow(inserts).processing_metadata as { discovery: Record<string, unknown> })
			.discovery;
		for (const key of ["owner_email", "mime_type", "size", "envelope"]) {
			expect(discovery).not.toHaveProperty(key);
		}
	});

	it("refreshes the envelope on a changed re-discovery", async () => {
		const { updates } = mockSupabase([
			{ id: "row-1", source: "m1:1", processing_metadata: { discovery: { content_hash: "old" } } },
		]);
		await runDiscover({
			connector: "gmail_attachment",
			items: [{ external_id: "m1:1", title: "cv.pdf", content_hash: "new", size: 5, envelope }],
		});
		const discovery = (updates[0].values.processing_metadata as { discovery: Record<string, unknown> })
			.discovery;
		expect(discovery).toMatchObject({ size: 5, envelope });
	});

	it("gives Gmail attachment pointers the terminal 'completed' status (no read adapter yet)", async () => {
		const { inserts } = mockSupabase();
		await runDiscover({
			connector: "gmail_attachment",
			items: [{ external_id: "m1:1", title: "cv.pdf" }],
		});
		const row = insertedRow(inserts);
		expect(row.processing_status).toBe("completed");
		expect(row.lifecycle_stage).toBe("discovered");
		expect(row.surface).toBe("discovered_gmail_attachment");
	});
});

describe("ingest_discover - untitled rows (#428 #3)", () => {
	it("synthesises a title from the summary's first line when title is null", async () => {
		const { inserts } = mockSupabase();
		await runDiscover({
			connector: "notion",
			items: [
				{
					external_id: "n1",
					title: null,
					summary: "Wedding venue shortlist\nsecond line ignored",
				},
			],
		});
		expect(insertedRow(inserts).title).toBe("Wedding venue shortlist");
	});

	it("falls back to an (untitled <type>) placeholder using the item type", async () => {
		const { inserts } = mockSupabase();
		await runDiscover({
			connector: "notion",
			items: [{ external_id: "n1", title: null, type: "Personal Task" }],
		});
		expect(insertedRow(inserts).title).toBe("(untitled Personal Task)");
	});

	it("uses the connector name when neither title, summary, nor type is given", async () => {
		const { inserts } = mockSupabase();
		await runDiscover({ connector: "notion", items: [{ external_id: "n1" }] });
		expect(insertedRow(inserts).title).toBe("(untitled notion)");
	});
});

describe("ingest_discover - junk & archived policy (#428 #4)", () => {
	it("skips test/template junk titles but keeps real rows", async () => {
		const { inserts } = mockSupabase();
		const counts = await runDiscover({
			connector: "notion",
			items: [
				{ external_id: "t1", title: "[test] #355 — MCP task_create verification (safe to delete)" },
				{ external_id: "ok", title: "Real Doc" },
			],
		});
		expect(counts.skipped).toBe(1);
		expect(counts.inserted).toBe(1);
		const row = insertedRow(inserts);
		expect(row.source).toBe("ok");
	});

	it("excludes archived items by default", async () => {
		const { inserts } = mockSupabase();
		const counts = await runDiscover({
			connector: "notion",
			items: [{ external_id: "a1", title: "Completed wedding admin", archived: true }],
		});
		expect(counts.skipped).toBe(1);
		expect(counts.inserted).toBe(0);
		expect(inserts).toHaveLength(0);
	});

	it("includes archived items when include_archived is set", async () => {
		const { inserts } = mockSupabase();
		const counts = await runDiscover({
			connector: "notion",
			include_archived: true,
			items: [{ external_id: "a1", title: "Completed wedding admin", archived: true }],
		});
		expect(counts.skipped).toBe(0);
		expect(counts.inserted).toBe(1);
		expect(insertedRow(inserts).title).toBe("Completed wedding admin");
	});

	it("does not treat a synthesised (untitled) placeholder as junk", async () => {
		const { inserts } = mockSupabase();
		const counts = await runDiscover({
			connector: "notion",
			items: [{ external_id: "n1", title: null }],
		});
		expect(counts.skipped).toBe(0);
		expect(insertedRow(inserts).title).toBe("(untitled notion)");
	});

	it("filters out code files and build trees by exclusion policy (#1232)", async () => {
		const { inserts } = mockSupabase();
		const counts = await runDiscover({
			connector: "gdrive",
			items: [
				{ external_id: "code-1", title: "page.tsx" },
				{ external_id: "mod-1", title: "node_modules/lodash/index.js" },
				{ external_id: "doc-1", title: "Angus_Hally_CV.pdf" },
			],
		});
		expect(counts.excluded).toBe(2);
		expect(counts.inserted).toBe(1);
		expect(insertedRow(inserts).source).toBe("doc-1");
	});

	it("reflects excluded counts in discoverHandler summary (#1232)", async () => {
		mockSupabase();
		const res = await discoverHandler({
			connector: "gdrive",
			items: [
				{ external_id: "code-1", title: "script.py" },
				{ external_id: "doc-1", title: "Report.docx" },
			],
		});
		expect(res.content[0].text).toContain("1 excluded by policy");
	});
});

describe("ingest_discover - pointer summary is persisted (#427)", () => {
	it("stores the source summary in description, where both FTS and embedText read it", async () => {
		const { inserts } = mockSupabase();
		await runDiscover({
			connector: "notion",
			items: [
				{
					external_id: "n1",
					title: "Venue shortlist",
					summary: "Five venues with costs, capacity and travel time.",
				},
			],
		});
		expect(insertedRow(inserts).description).toBe(
			"Five venues with costs, capacity and travel time.",
		);
	});

	it("leaves description null when the source gave no summary", async () => {
		const { inserts } = mockSupabase();
		await runDiscover({
			connector: "notion",
			items: [{ external_id: "n1", title: "Venue shortlist" }],
		});
		expect(insertedRow(inserts).description).toBeNull();
	});

	it("refreshes description on a changed re-discovery", async () => {
		const { updates } = mockSupabase([
			{ id: "row-1", source: "n1", processing_metadata: { discovery: { content_hash: "old" } } },
		]);
		await runDiscover({
			connector: "notion",
			items: [
				{ external_id: "n1", title: "Venue shortlist", summary: "Now four venues.", content_hash: "new" },
			],
		});
		expect(updates[0].values.description).toBe("Now four venues.");
	});
});

describe("ingest_discover - embedding on ingest_discover(#427 Part 2)", () => {
	it("embeds new pointers and folds the vector into the insert, with no extra round trip", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		const { inserts } = mockSupabase();

		const counts = await runDiscover({
			connector: "notion",
			items: [
				{ external_id: "n1", title: "Venue shortlist", summary: "Five venues with costs." },
			],
		});

		expect(counts.embedded).toBe(1);
		expect(embedBatchWithRetry).toHaveBeenCalledWith([
			"Venue shortlist\n\nFive venues with costs.",
		]);
		// The vector rides along on the insert — one write, never an UPDATE ... SET
		// embedding follow-up, so a pointer is never briefly present without it.
		expect(JSON.parse(insertedRow(inserts).embedding as string)).toEqual([0, 0.5]);
		expect(inserts).toHaveLength(1);
	});

	it("embeds changed pointers on re-discovery, and leaves unchanged ones alone", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		const { updates } = mockSupabase([
			{ id: "row-1", source: "n1", processing_metadata: { discovery: { content_hash: "old" } } },
			{ id: "row-2", source: "n2", processing_metadata: { discovery: { content_hash: "same" } } },
		]);

		const counts = await runDiscover({
			connector: "notion",
			items: [
				{ external_id: "n1", title: "Changed page", content_hash: "new" },
				{ external_id: "n2", title: "Untouched page", content_hash: "same" },
			],
		});

		// Idempotent: only the content-changed row is re-embedded, so a re-sweep of a
		// stable corpus costs zero provider calls.
		expect(counts.embedded).toBe(1);
		expect(counts.unchanged).toBe(1);
		expect(embedBatchWithRetry).toHaveBeenCalledWith(["Changed page"]);
		expect(updates).toHaveLength(1);
		expect(JSON.parse(updates[0].values.embedding as string)).toEqual([0, 0.5]);
	});

	it("makes no provider call at all when every item is unchanged", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		mockSupabase([
			{ id: "row-1", source: "n1", processing_metadata: { discovery: { content_hash: "same" } } },
		]);

		const counts = await runDiscover({
			connector: "notion",
			items: [{ external_id: "n1", title: "Page", content_hash: "same" }],
		});

		expect(counts).toMatchObject({ inserted: 0, updated: 0, unchanged: 1, embedded: 0 });
		expect(embedBatchWithRetry).not.toHaveBeenCalled();
	});

	it("skips rows whose title we synthesised — a placeholder is not worth a vector", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		const { inserts } = mockSupabase();

		const counts = await runDiscover({
			connector: "notion",
			items: [
				{ external_id: "n1", title: null }, // -> "(untitled notion)", no summary
				{ external_id: "n2", title: "Real page" },
			],
		});

		expect(counts.embedded).toBe(1);
		expect(embedBatchWithRetry).toHaveBeenCalledWith(["Real page"]);
		const rows = inserts[0];
		expect(rows.find((r) => r.source === "n1")!.embedding).toBeUndefined();
		expect(rows.find((r) => r.source === "n2")!.embedding).toBeDefined();
	});

	it("reports `embeddable` separately from `embedded` (round 1 QA review, #515) — distinguishes no-text rows from a provider shortfall", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		mockSupabase();

		const counts = await runDiscover({
			connector: "notion",
			items: [
				{ external_id: "n1", title: null }, // no embeddable text
				{ external_id: "n2", title: "Real page" },
			],
		});

		// 1 of the 2 written rows had text worth embedding, and it embedded.
		expect(counts.embeddable).toBe(1);
		expect(counts.embedded).toBe(1);
	});

	it("still embeds a summary-titled row — the summary IS source-provided text", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		const { inserts } = mockSupabase();

		const counts = await runDiscover({
			connector: "notion",
			items: [{ external_id: "n1", title: null, summary: "Wedding venue shortlist" }],
		});

		expect(counts.embedded).toBe(1);
		expect(insertedRow(inserts).title).toBe("Wedding venue shortlist");
		expect(insertedRow(inserts).embedding).toBeDefined();
	});

	it("does not call the provider when no embedding key is configured", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		const { inserts } = mockSupabase();

		const counts = await runDiscover({
			connector: "notion",
			items: [{ external_id: "n1", title: "Real page" }],
		});

		expect(counts.embedded).toBe(0);
		// The row had embeddable text — the shortfall is "no key", not "nothing to embed".
		expect(counts.embeddable).toBe(1);
		expect(embedBatchWithRetry).not.toHaveBeenCalled();
		// The pointer still lands — discovery does not depend on embeddings.
		expect(counts.inserted).toBe(1);
		expect(insertedRow(inserts).embedding).toBeUndefined();
	});

	it("still writes the pointer when the provider fails, leaving it for the backfill", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		// embedBatchWithRetry is best-effort by contract: exhausted retries come back as
		// nulls, not a throw.
		vi.mocked(embedBatchWithRetry).mockImplementation(async (texts: string[]) =>
			texts.map(() => null),
		);
		const { inserts } = mockSupabase();

		const counts = await runDiscover({
			connector: "notion",
			items: [{ external_id: "n1", title: "Real page" }],
		});

		expect(counts.inserted).toBe(1);
		expect(counts.embedded).toBe(0);
		// The row had embeddable text and the provider was called — the shortfall is
		// provider-side, distinct from "nothing to embed".
		expect(counts.embeddable).toBe(1);
		// No `embedding` key at all -> the column stays NULL, which is exactly the
		// backfill's work queue.
		expect(insertedRow(inserts).embedding).toBeUndefined();
	});

	it("keeps the sweep alive when only some vectors come back", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		vi.mocked(embedBatchWithRetry).mockImplementation(async (texts: string[]) =>
			texts.map((_, i) => (i === 0 ? [0.9] : null)),
		);
		const { inserts } = mockSupabase();

		const counts = await runDiscover({
			connector: "notion",
			items: [
				{ external_id: "n1", title: "First page" },
				{ external_id: "n2", title: "Second page" },
			],
		});

		expect(counts.inserted).toBe(2);
		expect(counts.embedded).toBe(1);
		const rows = inserts[0];
		expect(JSON.parse(rows.find((r) => r.source === "n1")!.embedding as string)).toEqual([0.9]);
		expect(rows.find((r) => r.source === "n2")!.embedding).toBeUndefined();
	});
});

describe("discoverHandler — summary text", () => {
	it("reports how many written rows got a vector", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		mockSupabase();

		const out = await discoverHandler({
			connector: "notion",
			items: [
				{ external_id: "n1", title: "Real page" },
				{ external_id: "n2", title: null }, // placeholder — not embeddable
			],
		});

		expect(out.content[0].text).toContain("1/2 embedded");
	});

	it("omits the embedding note when nothing was written", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		mockSupabase([
			{ id: "row-1", source: "n1", processing_metadata: { discovery: { content_hash: "same" } } },
		]);

		const out = await discoverHandler({
			connector: "notion",
			items: [{ external_id: "n1", title: "Page", content_hash: "same" }],
		});

		expect(out.content[0].text).not.toContain("embedded");
	});

	it("explains a shortfall caused by rows with no embeddable text (round 1 QA review, #515)", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		mockSupabase();

		const out = await discoverHandler({
			connector: "notion",
			items: [
				{ external_id: "n1", title: "Real page" },
				{ external_id: "n2", title: null }, // no title/summary — nothing to embed
			],
		});

		expect(out.content[0].text).toContain("1/2 embedded");
		expect(out.content[0].text).toContain("had no embeddable text");
	});

	it("explains a shortfall caused by the embedding provider being unavailable, distinct from no-key/no-text", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = "test-key";
		vi.mocked(embedBatchWithRetry).mockImplementation(async (texts: string[]) =>
			texts.map(() => null),
		);
		mockSupabase();

		const out = await discoverHandler({
			connector: "notion",
			items: [{ external_id: "n1", title: "Real page" }],
		});

		expect(out.content[0].text).toContain("0/1 embedded");
		expect(out.content[0].text).toContain("provider unavailable");
	});

	it("explains a shortfall caused by no embedding key configured, distinct from a provider failure", async () => {
		(env as { openaiApiKey?: string }).openaiApiKey = undefined;
		mockSupabase();

		const out = await discoverHandler({
			connector: "notion",
			items: [{ external_id: "n1", title: "Real page" }],
		});

		expect(out.content[0].text).toContain("0/1 embedded");
		expect(out.content[0].text).toContain("no OpenAI embedding key configured");
	});
});

const FOLDER = "application/vnd.google-apps.folder";

/**
 * #1228: the Drive envelope (mimeType, size, parents, owner email) is written onto
 * the pointer, folders are never queued for enrichment, and pointers discovered
 * before the envelope existed pick it up on the next relist WITHOUT being
 * re-queued. Each of these fails quietly in production, which is why they are
 * pinned: a folder "pending" forever costs a unit of the daily enrich budget, and
 * a re-queue of unchanged rows would re-enrich the whole estate.
 */
describe("ingest_discover - Drive envelope metadata (#1228)", () => {
	const pdf = {
		external_id: "cv-pdf",
		title: "Angus Hally CV.pdf",
		owner: "Angus Hally",
		owner_email: "owner@example.com",
		mime_type: "application/pdf",
		size: 48213,
		parents: ["folder-b"],
		content_hash: "0123456789abcdef0123456789abcdef",
	};

	it("records the envelope in processing_metadata.discovery and the Drive columns", async () => {
		const { inserts } = mockSupabase();
		await runDiscover({ connector: "gdrive", items: [pdf] });

		const row = insertedRow(inserts);
		const discovery = (row.processing_metadata as { discovery: Record<string, unknown> }).discovery;
		expect(discovery).toMatchObject({
			owner: "Angus Hally",
			owner_email: "owner@example.com",
			mime_type: "application/pdf",
			size: 48213,
			parents: ["folder-b"],
		});
		expect(row.source_drive_file_id).toBe("cv-pdf");
		expect(row.source_parent_folder_ids).toEqual(["folder-b"]);
		expect(row.processing_status).toBe("pending");
	});

	it("keeps another person's file distinguishable by its owner email", async () => {
		const { inserts } = mockSupabase();
		await runDiscover({
			connector: "gdrive",
			items: [{ ...pdf, external_id: "cv-2026", owner: "L Sharp", owner_email: "someone.else@example.com" }],
		});

		const discovery = (insertedRow(inserts).processing_metadata as { discovery: Record<string, unknown> })
			.discovery;
		expect(discovery.owner_email).toBe("someone.else@example.com");
	});

	it("writes a folder as a terminal, non-enrichable pointer", async () => {
		const { inserts } = mockSupabase();
		await runDiscover({
			connector: "gdrive",
			items: [{ external_id: "cv-folder", title: "CV Curriculum vitae", mime_type: FOLDER }],
		});

		const row = insertedRow(inserts);
		expect(row.processing_status).toBe("completed");
		// Still a discovered pointer — findable, just never queued.
		expect(row.lifecycle_stage).toBe("discovered");
	});

	it("keeps a folder terminal when its content hash moves", async () => {
		const { updates } = mockSupabase([
			{ id: "row-1", source: "cv-folder", processing_metadata: { discovery: { content_hash: "old" } } },
		]);
		await runDiscover({
			connector: "gdrive",
			items: [{ external_id: "cv-folder", title: "CV", mime_type: FOLDER, content_hash: "new" }],
		});

		expect(updates[0].values.processing_status).toBe("completed");
	});

	it("does not stamp Drive columns on a non-Drive pointer", async () => {
		const { inserts } = mockSupabase();
		await runDiscover({ connector: "notion", items: [{ external_id: "n1", title: "Page" }] });

		const row = insertedRow(inserts);
		expect(row).not.toHaveProperty("source_drive_file_id");
		expect(row).not.toHaveProperty("source_parent_folder_ids");
	});

	it("writes no envelope key the source did not serve: absent, never null", async () => {
		// The contract #1210's Gmail attachment connector shares (its discover.test
		// asserts not.toHaveProperty on these keys): a connector that serves none of
		// them writes exactly the discovery block it wrote before they existed.
		const { inserts } = mockSupabase();
		await runDiscover({ connector: "notion", items: [{ external_id: "n1", title: "Page" }] });

		const discovery = (insertedRow(inserts).processing_metadata as { discovery: Record<string, unknown> })
			.discovery;
		for (const key of ["owner_email", "mime_type", "size", "parents"]) {
			expect(discovery).not.toHaveProperty(key);
		}
	});

	it("writes only the envelope keys the source served on the changed path", async () => {
		const { updates } = mockSupabase([
			{ id: "row-1", source: "d1", processing_metadata: { discovery: { content_hash: "old" } } },
		]);
		await runDiscover({
			connector: "gdrive",
			items: [{ external_id: "d1", title: "Doc", mime_type: "application/pdf", content_hash: "new" }],
		});

		const discovery = (updates[0].values.processing_metadata as { discovery: Record<string, unknown> })
			.discovery;
		expect(discovery.mime_type).toBe("application/pdf");
		expect(discovery).not.toHaveProperty("size");
		expect(discovery).not.toHaveProperty("parents");
		expect(discovery).not.toHaveProperty("owner_email");
	});

	it("omits source_parent_folder_ids rather than nulling it when the source served no parents", async () => {
		const { updates } = mockSupabase([
			{ id: "row-1", source: "d1", processing_metadata: { discovery: { content_hash: "old" } } },
		]);
		await runDiscover({
			connector: "gdrive",
			items: [{ external_id: "d1", title: "Doc", mime_type: "application/pdf", content_hash: "new" }],
		});

		expect(updates[0].values.source_drive_file_id).toBe("d1");
		expect(updates[0].values).not.toHaveProperty("source_parent_folder_ids");
	});
});

/**
 * The refresh is ONE set-based RPC per call (migration 118's
 * discover_envelope_refresh), not a PATCH per row. What these pin is the request
 * discover sends; the SQL side (merge onto the stored block, never-null Drive
 * columns, dequeue only at 'discovered', the mime_type replay guard, the user_id
 * filter) was exercised against a scratch Postgres when the migration was written.
 */
describe("ingest_discover - envelope refresh of unchanged pointers (#1228)", () => {
	const enrichedMeta = {
		discovery: {
			connector: "gdrive",
			external_id: "d1",
			content_hash: "same",
			enriched_at: "2026-09-28T12:31:00.000Z",
		},
		enrichment_note: "kept",
	};

	it("sends an unchanged row that predates the envelope to the RPC, and PATCHes nothing", async () => {
		const { inserts, updates, rpcs } = mockSupabase([
			{ id: "row-1", source: "d1", processing_metadata: enrichedMeta },
		]);
		const counts = await runDiscover({
			connector: "gdrive",
			items: [
				{
					external_id: "d1",
					title: "Doc",
					mime_type: "application/pdf",
					size: 10,
					parents: ["p1"],
					owner_email: "owner@example.com",
					content_hash: "same",
				},
			],
		});

		expect(inserts).toHaveLength(0);
		expect(updates).toHaveLength(0);
		expect(counts).toMatchObject({ unchanged: 1, refreshed: 1, updated: 0 });
		expect(rpcs).toHaveLength(1);
		expect(rpcs[0].fn).toBe("discover_envelope_refresh");
		expect(rpcs[0].params.p_user_id).toBeTruthy();
		// Only the envelope, the Drive columns and the dequeue flag: no title,
		// lifecycle, description or embedding, so nothing is re-queued for
		// enrichment, and no copy of the stored block to write back over enrich's keys.
		expect(rpcs[0].params.p_rows).toEqual([
			{
				id: "row-1",
				envelope: {
					owner_email: "owner@example.com",
					mime_type: "application/pdf",
					size: 10,
					parents: ["p1"],
				},
				drive_file_id: "d1",
				parent_ids: ["p1"],
				dequeue: false,
			},
		]);
	});

	it("batches every refresh in the call into one RPC", async () => {
		const { rpcs } = mockSupabase([
			{ id: "row-1", source: "d1", processing_metadata: { discovery: { content_hash: "same" } } },
			{ id: "row-2", source: "d2", processing_metadata: { discovery: { content_hash: "same" } } },
			{ id: "row-3", source: "d3", processing_metadata: { discovery: { content_hash: "same" } } },
		]);
		const counts = await runDiscover({
			connector: "gdrive",
			items: ["d1", "d2", "d3"].map((id) => ({
				external_id: id,
				title: id,
				mime_type: "application/pdf",
				content_hash: "same",
			})),
		});

		expect(rpcs).toHaveLength(1);
		expect(rpcs[0].params.p_rows.map((r) => r.id)).toEqual(["row-1", "row-2", "row-3"]);
		expect(counts.refreshed).toBe(3);
	});

	it("asks the RPC to dequeue a folder (it applies that only while the row is still 'discovered')", async () => {
		const { rpcs } = mockSupabase([
			{ id: "row-1", source: "cv-folder", processing_metadata: { discovery: { content_hash: "same" } } },
		]);
		await runDiscover({
			connector: "gdrive",
			items: [{ external_id: "cv-folder", title: "CV", mime_type: FOLDER, content_hash: "same" }],
		});

		expect(rpcs[0].params.p_rows[0]).toMatchObject({ id: "row-1", dequeue: true, parent_ids: null });
		expect(rpcs[0].params.p_rows[0].envelope).toEqual({ mime_type: FOLDER });
	});

	it("reports the count the database returned, not the count it asked for", async () => {
		const { rpcs } = mockSupabase([
			{ id: "row-1", source: "d1", processing_metadata: { discovery: { content_hash: "same" } } },
			{ id: "row-2", source: "d2", processing_metadata: { discovery: { content_hash: "same" } } },
		]);
		// Another writer filled row-2's envelope first; the SQL guard skipped it.
		(supabase as any).rpc = vi.fn((fn: string, params: RpcCall["params"]) => {
			rpcs.push({ fn, params });
			return Promise.resolve({ data: 1, error: null });
		});
		const counts = await runDiscover({
			connector: "gdrive",
			items: ["d1", "d2"].map((id) => ({ external_id: id, title: id, mime_type: "text/plain", content_hash: "same" })),
		});

		expect(counts).toMatchObject({ unchanged: 2, refreshed: 1 });
	});

	it("refreshes each row at most once: a row that already has a mime_type is left alone", async () => {
		const { updates, rpcs } = mockSupabase([
			{
				id: "row-1",
				source: "d1",
				processing_metadata: { discovery: { content_hash: "same", mime_type: "application/pdf" } },
			},
		]);
		const counts = await runDiscover({
			connector: "gdrive",
			items: [{ external_id: "d1", title: "Doc", mime_type: "application/pdf", content_hash: "same" }],
		});

		expect(updates).toHaveLength(0);
		expect(rpcs).toHaveLength(0);
		expect(counts.refreshed).toBe(0);
	});

	it("never refreshes a connector that serves no envelope (Notion)", async () => {
		const { updates, rpcs } = mockSupabase([
			{ id: "row-1", source: "n1", processing_metadata: { discovery: { content_hash: "same" } } },
		]);
		await runDiscover({
			connector: "notion",
			items: [{ external_id: "n1", title: "Page", content_hash: "same" }],
		});

		expect(updates).toHaveLength(0);
		expect(rpcs).toHaveLength(0);
	});

	it("reports the refresh count in the tool summary", async () => {
		mockSupabase([{ id: "row-1", source: "d1", processing_metadata: { discovery: { content_hash: "same" } } }]);
		const out = await discoverHandler({
			connector: "gdrive",
			items: [{ external_id: "d1", title: "Doc", mime_type: "application/pdf", content_hash: "same" }],
		});

		expect(out.content[0].text).toContain("1 unchanged (1 envelope-refreshed)");
	});

	it("fails the call when the refresh RPC fails (including before migration 118 is pushed)", async () => {
		mockSupabase([{ id: "row-1", source: "d1", processing_metadata: { discovery: { content_hash: "same" } } }]);
		(supabase as any).rpc = vi.fn(() =>
			Promise.resolve({
				data: null,
				error: { code: "PGRST202", message: "Could not find the function public.discover_envelope_refresh" },
			}),
		);

		await expect(
			runDiscover({
				connector: "gdrive",
				items: [{ external_id: "d1", title: "Doc", mime_type: "application/pdf", content_hash: "same" }],
			}),
		).rejects.toThrow("Discovery envelope refresh failed for 1 row(s): Could not find the function");
	});
});

describe("softArchiveSourceTrashed (#1212)", () => {
	it("soft-archives matching active pointers with source_trashed", async () => {
		const { updates } = mockSupabase([
			{ id: "row-1", source: "file-1", archived: false },
			{ id: "row-2", source: "file-2", archived: false },
		]);

		const count = await softArchiveSourceTrashed("gdrive", ["file-1", "file-2"]);

		expect(count).toBe(2);
		expect(updates).toHaveLength(1);
		expect(updates[0].values).toMatchObject({
			archived: true,
			archived_reason: "source_trashed",
		});
		expect(updates[0].values.archived_at).toBeDefined();
		expect(updates[0].filters.id).toEqual(["row-1", "row-2"]);
	});

	it("ignores trashed files that were never indexed", async () => {
		const { updates } = mockSupabase([]);

		const count = await softArchiveSourceTrashed("gdrive", ["file-never-indexed"]);

		expect(count).toBe(0);
		expect(updates).toHaveLength(0);
	});

	it("ignores pointers that are already archived", async () => {
		const { updates } = mockSupabase([
			{ id: "row-1", source: "file-1", archived: true, archived_reason: "user_deleted" },
		]);

		const count = await softArchiveSourceTrashed("gdrive", ["file-1"]);

		expect(count).toBe(0);
		expect(updates).toHaveLength(0);
	});

	it("returns 0 when given an empty list", async () => {
		const { updates } = mockSupabase([]);

		const count = await softArchiveSourceTrashed("gdrive", []);

		expect(count).toBe(0);
		expect(updates).toHaveLength(0);
	});
});

describe("trashed source detection and pointer restoration (#1212)", () => {
	it("un-archives a pointer previously archived as source_trashed when restored", async () => {
		const { updates } = mockSupabase([
			{
				id: "row-1",
				source: "file-1",
				archived: true,
				archived_reason: "source_trashed",
				processing_metadata: { discovery: { content_hash: "hash-old" } },
			},
		]);

		const counts = await runDiscover({
			connector: "gdrive",
			items: [{ external_id: "file-1", title: "Restored Doc", content_hash: "hash-new" }],
		});

		expect(counts.updated).toBe(1);
		expect(updates).toHaveLength(1);
		expect(updates[0].values).toMatchObject({
			archived: false,
			archived_at: null,
			archived_reason: null,
		});
	});

	it("un-archives a restored pointer even when content_hash has not changed", async () => {
		const { updates } = mockSupabase([
			{
				id: "row-1",
				source: "file-1",
				archived: true,
				archived_reason: "source_trashed",
				processing_metadata: { discovery: { content_hash: "same-hash" } },
			},
		]);

		const counts = await runDiscover({
			connector: "gdrive",
			items: [{ external_id: "file-1", title: "Restored Doc", content_hash: "same-hash" }],
		});

		expect(counts.updated).toBe(1);
		expect(counts.unchanged).toBe(0);
		expect(updates).toHaveLength(1);
		expect(updates[0].values).toMatchObject({
			archived: false,
			archived_at: null,
			archived_reason: null,
		});
	});

	it("does not un-archive pointers archived for reasons other than source_trashed", async () => {
		const { updates } = mockSupabase([
			{
				id: "row-1",
				source: "file-1",
				archived: true,
				archived_reason: "user_deleted",
				processing_metadata: { discovery: { content_hash: "same-hash" } },
			},
		]);

		const counts = await runDiscover({
			connector: "gdrive",
			items: [{ external_id: "file-1", title: "Doc", content_hash: "same-hash" }],
		});

		expect(counts.unchanged).toBe(1);
		expect(counts.updated).toBe(0);
		expect(updates).toHaveLength(0);
	});

	it("handles item with trashed: true in runDiscover: soft-archives existing active pointer", async () => {
		const { updates } = mockSupabase([
			{
				id: "row-1",
				source: "file-1",
				archived: false,
				processing_metadata: { discovery: { content_hash: "hash-1" } },
			},
		]);

		const counts = await runDiscover({
			connector: "gdrive",
			items: [{ external_id: "file-1", title: "Doc", trashed: true }],
		});

		expect(counts.updated).toBe(1);
		expect(updates).toHaveLength(1);
		expect(updates[0].values).toMatchObject({
			archived: true,
			archived_reason: "source_trashed",
		});
		expect(updates[0].values.archived_at).toBeDefined();
	});

	it("handles item with trashed: true in runDiscover: ignores item if never indexed", async () => {
		const { inserts, updates } = mockSupabase([]);

		const counts = await runDiscover({
			connector: "gdrive",
			items: [{ external_id: "file-never-indexed", title: "Doc", trashed: true }],
		});

		expect(counts.skipped).toBe(1);
		expect(counts.inserted).toBe(0);
		expect(counts.updated).toBe(0);
		expect(inserts).toHaveLength(0);
		expect(updates).toHaveLength(0);
	});
});

describe("runDiscover - batched inserts", () => {
	it("chunks large insert batches into slices of DISCOVER_INSERT_BATCH_SIZE to avoid statement timeouts", async () => {
		const { inserts } = mockSupabase([]);
		const totalItems = DISCOVER_INSERT_BATCH_SIZE * 2 + 10;
		const items = Array.from({ length: totalItems }, (_, i) => ({
			external_id: `file-${i + 1}`,
			title: `Document ${i + 1}`,
		}));

		const counts = await runDiscover({
			connector: "gdrive",
			items,
		});

		expect(counts.inserted).toBe(totalItems);
		expect(inserts).toHaveLength(3);
		expect(inserts[0]).toHaveLength(DISCOVER_INSERT_BATCH_SIZE);
		expect(inserts[1]).toHaveLength(DISCOVER_INSERT_BATCH_SIZE);
		expect(inserts[2]).toHaveLength(10);
	});
});


