import { describe, expect, it } from "vitest";
import { NOT_A_FOLDER_FILTER } from "../../domain/ingest/selection.js";
import type { EnrichPromotePatch } from "../../ports/enrich.js";
import { createSupabaseEnrichRepository, type EnrichSupabaseClient } from "./enrich.js";

const USER = "00000000-0000-4000-8000-000000000001";
const ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-21T09:00:00.000Z";
const CHANNELS = ["discovered_gdrive", "discovered_onedrive"];
// The column lists `ingest_enrich_next` selects today, spelled out so a drift fails here.
const BACKLOG_COLUMNS =
	"id, title, description, source, source_channel, storage_bucket, storage_path, storage_url, source_url, plain_text, lifecycle_stage, processing_metadata";
const ON_DEMAND_COLUMNS =
	"id, title, description, source, source_channel, storage_bucket, storage_path, storage_url, source_url, plain_text, lifecycle_stage, processing_status, processing_metadata";
const BACKLOG_FILTERS = [
	["eq", "user_id", USER],
	["eq", "lifecycle_stage", "discovered"],
	["eq", "archived", false],
	["in", "source_channel", CHANNELS],
	["or", NOT_A_FOLDER_FILTER],
];
const ROW_SCOPE = [["eq", "id", ID], ["eq", "user_id", USER]];

/** A recording fake: every builder call is logged in order; awaiting the chain yields `result`. */
function setup(result: Record<string, unknown> = {}) {
	const calls: any[][] = [];
	const builder: any = new Proxy({}, {
		get: (_target, method: string) => (...args: any[]) => {
			if (method === "then") return args[0]({ data: null, error: null, count: null, ...result });
			calls.push([method, ...args]);
			return builder;
		},
	});
	const client = { from: builder.from } as unknown as EnrichSupabaseClient;
	return { repo: createSupabaseEnrichRepository(client, { now: () => new Date(NOW) }), calls };
}

describe("createSupabaseEnrichRepository", () => {
	it("selectDiscovered issues the backlog filters, both orders and the limit", async () => {
		const rows = [{ id: ID, title: "a" }];
		const { repo, calls } = setup({ data: rows });
		expect(await repo.selectDiscovered(USER, { channels: CHANNELS, limit: 7 })).toEqual(rows);
		expect(calls).toEqual([
			["from", "artifacts"],
			["select", BACKLOG_COLUMNS, undefined],
			...BACKLOG_FILTERS,
			["order", "effective_at", { ascending: false }],
			["order", "captured_at", { ascending: false }],
			["limit", 7],
		]);
		expect(await setup().repo.selectDiscovered(USER, { channels: CHANNELS, limit: 1 })).toEqual([]);
		const broken = setup({ error: { message: "timeout" } }).repo;
		await expect(broken.selectDiscovered(USER, { channels: CHANNELS, limit: 1 })).rejects.toThrow(
			"ingest_enrich_next selection failed: timeout",
		);
	});

	it("countDiscovered is an estimated head count over the same filters, never a silent 0", async () => {
		const { repo, calls } = setup({ count: 4200 });
		expect(await repo.countDiscovered(USER, CHANNELS)).toEqual({ count: 4200 });
		expect(calls).toEqual([
			["from", "artifacts"],
			["select", "id", { count: "estimated", head: true }],
			...BACKLOG_FILTERS,
		]);
		const count = (result: Record<string, unknown>) => setup(result).repo.countDiscovered(USER, CHANNELS);
		expect(await count({ error: { message: "57014" } })).toEqual({ count: null, error: "57014" });
		expect(await count({ error: { message: "" } })).toEqual({ count: null, error: "backlog count failed" });
		expect(await count({})).toEqual({ count: null, error: "backlog count returned no count" });
	});

	it("loadById is scoped to the user and returns null for a missing row", async () => {
		const { repo, calls } = setup({ data: { id: ID } });
		expect(await repo.loadById(USER, ID)).toEqual({ id: ID });
		expect(calls).toEqual([
			["from", "artifacts"],
			["select", ON_DEMAND_COLUMNS],
			["eq", "user_id", USER],
			["eq", "id", ID],
			["maybeSingle"],
		]);
		expect(await setup().repo.loadById(USER, ID)).toBeNull();
		await expect(setup({ error: { message: "boom" } }).repo.loadById(USER, ID)).rejects.toThrow(/^boom$/);
	});

	it("markFailed writes both stage fields and merges the error keys into existing metadata", async () => {
		// The update's own error is not raised, as in the tool today.
		const { repo, calls } = setup({ error: { message: "not raised" } });
		const row = { id: ID, processing_metadata: { discovery: { connector: "gdrive" }, kept: 1 } };
		await repo.markFailed(USER, row, "no read adapter");
		const payload = {
			lifecycle_stage: "failed",
			processing_status: "failed",
			processing_metadata: {
				discovery: { connector: "gdrive" },
				kept: 1,
				enrichment_error: "no read adapter",
				enrichment_failed_at: NOW,
			},
		};
		expect(calls).toEqual([["from", "artifacts"], ["update", payload], ...ROW_SCOPE]);
	});

	const patch: EnrichPromotePatch = {
		storageBucket: "app",
		storagePath: "enriched/gdrive/u/a.pdf",
		storageUrl: "supabase://app/a.pdf",
		mimeType: "application/pdf",
		extension: "pdf",
		fileSize: 12,
		plainText: null,
		title: "Report",
		description: null,
		processingStatus: "pending",
		processingMetadata: { kept: 1, discovery: { connector: "google_drive", content_hash: "old", mime_type: "x" } },
		connector: "gdrive",
		contentHash: null,
	};

	it("promote writes the storage, text and stage fields, merges discovery and throws on error", async () => {
		const { repo, calls } = setup();
		await repo.promote(USER, ID, patch);
		const payload = {
			storage_bucket: "app",
			storage_path: "enriched/gdrive/u/a.pdf",
			storage_url: "supabase://app/a.pdf",
			file_type: "application/pdf",
			content_type: "application/pdf",
			file_extension: "pdf",
			file_size: 12,
			plain_text: null,
			title: "Report",
			description: null,
			lifecycle_stage: "extracted",
			processing_status: "pending",
			processing_metadata: {
				kept: 1,
				discovery: { connector: "google_drive", content_hash: "old", mime_type: "x", enriched_at: NOW },
			},
		};
		expect(calls).toEqual([["from", "artifacts"], ["update", payload], ...ROW_SCOPE]);
		expect(calls[1][1]).not.toHaveProperty("captured_at");
		expect(calls[1][1]).not.toHaveProperty("originated_at");
		// With no recorded discovery, the patch's connector and hash are what get written.
		const promoted = async (overrides: Partial<EnrichPromotePatch>) => {
			const { repo, calls } = setup();
			await repo.promote(USER, ID, { ...patch, ...overrides });
			return calls[1][1].processing_metadata;
		};
		expect(await promoted({ processingMetadata: null, contentHash: "new" })).toEqual({
			discovery: { connector: "gdrive", content_hash: "new", enriched_at: NOW },
		});
		expect((await promoted({ processingMetadata: {} })).discovery.content_hash).toBeNull();
		await expect(setup({ error: { message: "rls" } }).repo.promote(USER, ID, patch)).rejects.toThrow(
			"row update failed: rls",
		);
	});
});
