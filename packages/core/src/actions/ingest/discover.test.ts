import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
	EnvelopeRefreshRow,
	ExistingRow,
} from "../../domain/ingest/discoverPointers.js";
import type {
	DiscoverEmbeddingPort,
	DiscoverRepository,
} from "../../ports/discover.js";
import { createSupabaseDiscoverRepository } from "../../adapters/supabase/discover.js";
import { executeAction } from "../adapters/direct.js";
import {
	createIngestDiscoverAction,
	discoverInput,
	formatIngestDiscoverMcp,
	INGEST_DISCOVER_DESCRIPTION,
} from "./discover.js";

const USER_ID = "00000000-0000-4000-8000-000000000099";

function createFakeRepo(initial: ExistingRow[] = []) {
	const findKnownCalls: Array<{
		userId: string;
		channel: string;
		sources: string[];
	}> = [];
	const insertedBatches: Record<string, unknown>[][] = [];
	const updates: Array<{
		id: string;
		patch: Record<string, unknown>;
		externalId?: string;
	}> = [];
	const refreshCalls: EnvelopeRefreshRow[][] = [];

	const repo: DiscoverRepository = {
		findKnown: vi.fn(async (userId, channel, sources) => {
			findKnownCalls.push({ userId, channel, sources });
			return initial.filter((r) => r.source && sources.includes(r.source));
		}),
		insert: vi.fn(async (rows) => {
			insertedBatches.push(rows);
		}),
		update: vi.fn(async (id, patch, externalId) => {
			updates.push({ id, patch, externalId });
		}),
		refreshEnvelopes: vi.fn(async (rows) => {
			if (rows.length > 0) refreshCalls.push(rows);
			return rows.length;
		}),
	};

	return { repo, findKnownCalls, insertedBatches, updates, refreshCalls };
}

describe("createIngestDiscoverAction (#1625)", () => {
	it("1. JSON Schema snapshot of action.schema matches z.toJSONSchema(z.object(discoverInput))", () => {
		const { repo } = createFakeRepo();
		const action = createIngestDiscoverAction({ repo });

		expect(action.id).toBe("ingest_discover");
		expect(action.description).toBe(INGEST_DISCOVER_DESCRIPTION);
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		});
		expect(z.toJSONSchema(action.schema)).toEqual(
			z.toJSONSchema(z.object(discoverInput)),
		);
	});

	it("2. 3 new + 1 changed + 1 unchanged + 1 excluded: inserts 3, updates 1, leaves 1, excludes 1; embedding called once with 4 texts", async () => {
		const { repo, insertedBatches, updates } = createFakeRepo([
			{
				id: "row-changed",
				source: "ext-changed",
				processing_metadata: { discovery: { content_hash: "old-hash" } },
			},
			{
				id: "row-unchanged",
				source: "ext-unchanged",
				processing_metadata: { discovery: { content_hash: "same-hash" } },
			},
		]);
		const embeddings: DiscoverEmbeddingPort = {
			embedBatch: vi.fn(async (texts: string[]) =>
				texts.map((_, idx) => [idx + 1, 0.25]),
			),
		};
		const action = createIngestDiscoverAction({ repo, embeddings });

		const counts = await executeAction(
			action,
			{
				connector: "gdrive",
				items: [
					{ external_id: "new-1", title: "New One", summary: "First summary" },
					{ external_id: "new-2", title: "New Two" },
					{ external_id: "new-3", title: "New Three" },
					{
						external_id: "ext-changed",
						title: "Changed Doc",
						content_hash: "new-hash",
					},
					{
						external_id: "ext-unchanged",
						title: "Unchanged Doc",
						content_hash: "same-hash",
					},
					{
						external_id: "ext-excluded",
						title: "node_modules/pkg/index.js",
					},
				],
			},
			{ context: { caller: "mcp", userId: USER_ID } },
		);

		expect(counts).toEqual({
			inserted: 3,
			updated: 1,
			unchanged: 1,
			refreshed: 0,
			skipped: 0,
			excluded: 1,
			embedded: 4,
			embeddable: 4,
		});
		expect(embeddings.embedBatch).toHaveBeenCalledTimes(1);
		expect(embeddings.embedBatch).toHaveBeenCalledWith([
			"New One\n\nFirst summary",
			"New Two",
			"New Three",
			"Changed Doc",
		]);
		expect(insertedBatches).toHaveLength(1);
		expect(insertedBatches[0]).toHaveLength(3);
		expect(JSON.parse(insertedBatches[0][0].embedding as string)).toEqual([
			1, 0.25,
		]);
		expect(updates).toHaveLength(1);
		expect(updates[0].id).toBe("row-changed");
		expect(JSON.parse(updates[0].patch.embedding as string)).toEqual([
			4, 0.25,
		]);
	});

	it("3. lookup batches external_ids by 50 and scopes to ctx.userId and source_channel = discovered_<connector>", async () => {
		const lookupCalls: Array<{
			userId: unknown;
			channel: unknown;
			batch: string[];
		}> = [];
		const client = {
			from: vi.fn(() => ({
				select: () => {
					const filters: Record<string, unknown> = {};
					const b: any = {
						eq: (col: string, val: unknown) => {
							filters[col] = val;
							return b;
						},
						in: (_col: string, batch: string[]) => {
							lookupCalls.push({
								userId: filters.user_id,
								channel: filters.source_channel,
								batch,
							});
							return Promise.resolve({
								data: batch.map((s, i) => ({
									id: `row-${i}`,
									source: s,
									processing_metadata: { discovery: { content_hash: "same" } },
								})),
								error: null,
							});
						},
					};
					return b;
				},
				insert: () => Promise.resolve({ error: null }),
				update: () => ({
					eq: () => ({ eq: () => Promise.resolve({ error: null }) }),
				}),
			})),
			rpc: vi.fn(() => Promise.resolve({ data: 0, error: null })),
		};

		const repo = createSupabaseDiscoverRepository({
			client: client as any,
			ownerId: USER_ID,
		});
		const action = createIngestDiscoverAction({ repo });
		const items = Array.from({ length: 120 }, (_, i) => ({
			external_id: `ext-${i + 1}`,
			title: `Doc ${i + 1}`,
			content_hash: "same",
		}));

		const counts = await executeAction(
			action,
			{ connector: "notion", items },
			{ context: { caller: "worker", userId: USER_ID } },
		);

		expect(counts.unchanged).toBe(120);
		expect(lookupCalls).toHaveLength(3);
		expect(lookupCalls[0].batch).toHaveLength(50);
		expect(lookupCalls[1].batch).toHaveLength(50);
		expect(lookupCalls[2].batch).toHaveLength(20);
		for (const call of lookupCalls) {
			expect(call.userId).toBe(USER_ID);
			expect(call.channel).toBe("discovered_notion");
		}
	});

	it("4. unchanged item whose envelope changed is sent to refreshEnvelopes", async () => {
		const { repo, updates, refreshCalls } = createFakeRepo([
			{
				id: "row-1",
				source: "d1",
				processing_metadata: {
					discovery: {
						connector: "gdrive",
						external_id: "d1",
						content_hash: "same",
					},
				},
			},
		]);
		const action = createIngestDiscoverAction({ repo });

		const counts = await executeAction(
			action,
			{
				connector: "gdrive",
				items: [
					{
						external_id: "d1",
						title: "Doc",
						mime_type: "application/pdf",
						size: 4096,
						parents: ["folder-1"],
						owner_email: "owner@example.com",
						content_hash: "same",
					},
				],
			},
			{ context: { caller: "mcp", userId: USER_ID } },
		);

		expect(updates).toHaveLength(0);
		expect(counts).toMatchObject({ unchanged: 1, refreshed: 1, updated: 0 });
		expect(refreshCalls).toEqual([
			[
				{
					id: "row-1",
					envelope: {
						owner_email: "owner@example.com",
						mime_type: "application/pdf",
						size: 4096,
						parents: ["folder-1"],
					},
					drive_file_id: "d1",
					parent_ids: ["folder-1"],
					dequeue: false,
				},
			],
		]);
	});

	it("5. embedding unavailable (port returns nulls): rows are still written and summary carries the embed shortfall note", async () => {
		const { repo, insertedBatches } = createFakeRepo();
		const embeddings: DiscoverEmbeddingPort = {
			embedBatch: vi.fn(async (texts: string[]) => texts.map(() => null)),
		};
		const action = createIngestDiscoverAction({ repo, embeddings });

		const counts = await executeAction(
			action,
			{
				connector: "notion",
				items: [{ external_id: "n1", title: "Real page" }],
			},
			{ context: { caller: "mcp", userId: USER_ID } },
		);

		expect(counts.inserted).toBe(1);
		expect(counts.embedded).toBe(0);
		expect(counts.embeddable).toBe(1);
		expect(insertedBatches[0][0].embedding).toBeUndefined();

		const summary = action.formatMcp!(counts);
		expect(summary).toBe(
			"Discovered 1 item(s) from notion (channel discovered_notion): 1 new, 0 changed, 0 unchanged, 0 skipped (junk/archived). 0/1 embedded (semantic search). (1 pending (embedding provider unavailable — the backfill will retry).)",
		);
	});

	it("6. formatMcp equals today's summary line for the same counts", async () => {
		const { repo } = createFakeRepo([
			{
				id: "row-unchanged",
				source: "d-unchanged",
				processing_metadata: { discovery: { content_hash: "same" } },
			},
		]);
		const embeddings: DiscoverEmbeddingPort = {
			embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
		};
		const action = createIngestDiscoverAction({ repo, embeddings });

		const counts = await executeAction(
			action,
			{
				connector: "gdrive",
				items: [
					{ external_id: "d-new", title: "Spec.pdf" },
					{
						external_id: "d-unchanged",
						title: "Existing.pdf",
						mime_type: "application/pdf",
						content_hash: "same",
					},
					{ external_id: "d-excluded", title: "bundle.min.js" },
				],
			},
			{ context: { caller: "mcp", userId: USER_ID } },
		);

		expect(action.formatMcp!(counts)).toBe(
			"Discovered 3 item(s) from gdrive (channel discovered_gdrive): 1 new, 0 changed, 1 unchanged (1 envelope-refreshed), 0 skipped (junk/archived), 1 excluded by policy. 1/1 embedded (semantic search).",
		);

		// Also verify unconfigured port shortfall note ("no OpenAI embedding key configured")
		const unconfiguredAction = createIngestDiscoverAction({
			repo: createFakeRepo().repo,
			embeddings: null,
		});
		const unconfiguredCounts = await executeAction(
			unconfiguredAction,
			{
				connector: "notion",
				items: [{ external_id: "n1", title: "Page" }],
			},
			{ context: { caller: "mcp", userId: USER_ID } },
		);
		expect(unconfiguredAction.formatMcp!(unconfiguredCounts)).toBe(
			"Discovered 1 item(s) from notion (channel discovered_notion): 1 new, 0 changed, 0 unchanged, 0 skipped (junk/archived). 0/1 embedded (semantic search). (1 pending (no OpenAI embedding key configured).)",
		);

		// Direct helper call with explicit options
		expect(
			formatIngestDiscoverMcp(
				{
					inserted: 2,
					updated: 1,
					unchanged: 4,
					refreshed: 2,
					skipped: 1,
					excluded: 1,
					embedded: 2,
					embeddable: 2,
				},
				{ connector: "gdrive", itemCount: 9, embeddingConfigured: true },
			),
		).toBe(
			"Discovered 9 item(s) from gdrive (channel discovered_gdrive): 2 new, 1 changed, 4 unchanged (2 envelope-refreshed), 1 skipped (junk/archived), 1 excluded by policy. 2/3 embedded (semantic search). (1 had no embeddable text.)",
		);
	});
});
