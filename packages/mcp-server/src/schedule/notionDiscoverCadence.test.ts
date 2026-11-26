import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { discoverSchema } from "@ahkms/core";

vi.mock("../notion.js", () => ({
	searchNotion: vi.fn(),
	notionResultTitle: vi.fn(),
}));
const runDiscover = vi.fn();
const softArchiveSourceTrashed = vi.fn();
vi.mock("../tools/discover.js", () => ({
	ingestDiscoverAction: { id: "ingest_discover", schema: discoverSchema, run: (input: unknown) => runDiscover(input) },
	softArchiveSourceTrashed: (...a: unknown[]) => softArchiveSourceTrashed(...a),
}));
vi.mock("../credentials.js", () => ({ getCredential: vi.fn() }));
vi.mock("./runLog.js", () => ({ recordRun: vi.fn() }));

import { searchNotion, notionResultTitle } from "../notion.js";
import { getCredential } from "../credentials.js";
import { recordRun } from "./runLog.js";
import { runNotionDiscoverCadence } from "./notionDiscoverCadence.js";

// Configure a subset of workspaces: those in `set` resolve a token, the rest reject
// (the runtime signal for "workspace not configured").
function configureWorkspaces(set: Record<string, string>) {
	(getCredential as any).mockImplementation(async (ws: string) => {
		if (ws in set) return set[ws];
		throw new Error(`${ws} token not set`);
	});
}

beforeEach(() => {
	// Default: title extraction echoes the id so the mapping is verifiable without
	// re-testing notionResultTitle's extraction (covered in notion.test.ts).
	(notionResultTitle as any).mockImplementation((r: any) => `title-${r.id}`);
	softArchiveSourceTrashed.mockReset().mockResolvedValue(0);
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("runNotionDiscoverCadence", () => {
	it("no-ops (does not search, discover, or record) when no workspace is configured", async () => {
		configureWorkspaces({});

		await runNotionDiscoverCadence();

		expect(searchNotion).not.toHaveBeenCalled();
		expect(runDiscover).not.toHaveBeenCalled();
		expect(recordRun).not.toHaveBeenCalled();
	});

	it("maps pages and databases to the discover shape (content_hash = last_edited_time) and records a notion run", async () => {
		configureWorkspaces({ notion_work: "work-token" });
		(searchNotion as any).mockResolvedValue({
			results: [
				{
					id: "p1",
					object: "page",
					url: "https://notion.so/p1",
					created_time: "2026-01-01T00:00:00.000Z",
					last_edited_time: "2026-07-01T00:00:00.000Z",
				},
				{
					id: "db1",
					object: "database",
					url: "https://notion.so/db1",
					created_time: "2026-02-01T00:00:00.000Z",
					last_edited_time: "2026-07-02T00:00:00.000Z",
				},
			],
			next_cursor: null,
			has_more: false,
		});
		(runDiscover as any).mockResolvedValue({ inserted: 2, updated: 0, unchanged: 0 });

		await runNotionDiscoverCadence();

		expect(runDiscover).toHaveBeenCalledTimes(1);
		expect(runDiscover).toHaveBeenCalledWith({
			connector: "notion",
			items: [
				{
					external_id: "p1",
					title: "title-p1",
					url: "https://notion.so/p1",
					source_created_at: "2026-01-01T00:00:00.000Z",
					source_modified_at: "2026-07-01T00:00:00.000Z",
					content_hash: "2026-07-01T00:00:00.000Z",
				},
				{
					external_id: "db1",
					title: "title-db1",
					url: "https://notion.so/db1",
					source_created_at: "2026-02-01T00:00:00.000Z",
					source_modified_at: "2026-07-02T00:00:00.000Z",
					content_hash: "2026-07-02T00:00:00.000Z",
				},
			],
		});

		expect(recordRun).toHaveBeenCalledWith(
			expect.objectContaining({
				cadence: "discover",
				connector: "notion",
				counts: { scanned: 2, new: 2, changed: 0, unchanged: 0, trashed: 0, workspaces: 1, errors: 0 },
			}),
		);
	});

	it("skips archived objects from active discover and soft-archives them", async () => {
		configureWorkspaces({ notion_work: "work-token" });
		(searchNotion as any).mockResolvedValue({
			results: [
				{ id: "a1", archived: true, last_edited_time: "2026-07-01T00:00:00.000Z" },
				{ id: "n1", last_edited_time: "2026-07-02T00:00:00.000Z" },
			],
			next_cursor: null,
			has_more: false,
		});
		(runDiscover as any).mockResolvedValue({ inserted: 1, updated: 0, unchanged: 0 });

		await runNotionDiscoverCadence();

		expect(runDiscover).toHaveBeenCalledWith(
			expect.objectContaining({ items: [expect.objectContaining({ external_id: "n1" })] }),
		);
		expect(softArchiveSourceTrashed).toHaveBeenCalledWith("notion", ["a1"]);
		expect(recordRun).toHaveBeenCalledWith(
			expect.objectContaining({ counts: expect.objectContaining({ scanned: 1 }) }),
		);
	});

	it("searches both workspaces with their own tokens and aggregates counts", async () => {
		configureWorkspaces({ notion_work: "work-token", notion_personal: "personal-token" });
		(searchNotion as any)
			.mockResolvedValueOnce({
				results: [{ id: "w1", last_edited_time: "t1" }],
				next_cursor: null,
				has_more: false,
			})
			.mockResolvedValueOnce({
				results: [{ id: "p1", last_edited_time: "t2" }],
				next_cursor: null,
				has_more: false,
			});
		(runDiscover as any).mockResolvedValue({ inserted: 1, updated: 0, unchanged: 0 });

		await runNotionDiscoverCadence();

		expect(searchNotion).toHaveBeenCalledTimes(2);
		expect((searchNotion as any).mock.calls[0][0]).toBe("work-token");
		expect((searchNotion as any).mock.calls[1][0]).toBe("personal-token");
		expect(runDiscover).toHaveBeenCalledTimes(2);
		expect(recordRun).toHaveBeenCalledWith(
			expect.objectContaining({
				counts: expect.objectContaining({ scanned: 2, new: 2, workspaces: 2, errors: 0 }),
			}),
		);
	});

	it("isolates a per-workspace failure: one workspace throwing still discovers the other and records the error", async () => {
		configureWorkspaces({ notion_work: "work-token", notion_personal: "personal-token" });
		(searchNotion as any)
			.mockRejectedValueOnce(new Error("boom work"))
			.mockResolvedValueOnce({
				results: [{ id: "p1", last_edited_time: "t2" }],
				next_cursor: null,
				has_more: false,
			});
		(runDiscover as any).mockResolvedValue({ inserted: 1, updated: 0, unchanged: 0 });

		await expect(runNotionDiscoverCadence()).resolves.toBeUndefined();

		expect(runDiscover).toHaveBeenCalledTimes(1);
		expect(runDiscover).toHaveBeenCalledWith(
			expect.objectContaining({ items: [expect.objectContaining({ external_id: "p1" })] }),
		);
		expect(recordRun).toHaveBeenCalledWith(
			expect.objectContaining({
				connector: "notion",
				error: expect.stringContaining("boom work"),
				counts: expect.objectContaining({ scanned: 1, new: 1, workspaces: 2, errors: 1 }),
			}),
		);
	});

	it("paginates through has_more/next_cursor and merges results", async () => {
		configureWorkspaces({ notion_work: "work-token" });
		(searchNotion as any)
			.mockResolvedValueOnce({
				results: [{ id: "a", last_edited_time: "t" }],
				next_cursor: "c2",
				has_more: true,
			})
			.mockResolvedValueOnce({
				results: [{ id: "b", last_edited_time: "t" }],
				next_cursor: null,
				has_more: false,
			});
		(runDiscover as any).mockResolvedValue({ inserted: 2, updated: 0, unchanged: 0 });

		await runNotionDiscoverCadence();

		expect(searchNotion).toHaveBeenCalledTimes(2);
		expect((searchNotion as any).mock.calls[1][1]).toEqual({ cursor: "c2" });
		expect(runDiscover).toHaveBeenCalledTimes(1);
		expect(runDiscover).toHaveBeenCalledWith(
			expect.objectContaining({
				items: [
					expect.objectContaining({ external_id: "a" }),
					expect.objectContaining({ external_id: "b" }),
				],
			}),
		);
	});

	it("batches runDiscover calls in groups of 200 and sums counts", async () => {
		configureWorkspaces({ notion_work: "work-token" });
		const results = Array.from({ length: 250 }, (_, i) => ({
			id: `n${i}`,
			last_edited_time: "t",
		}));
		(searchNotion as any).mockResolvedValue({ results, next_cursor: null, has_more: false });
		(runDiscover as any)
			.mockResolvedValueOnce({ inserted: 200, updated: 0, unchanged: 0 })
			.mockResolvedValueOnce({ inserted: 50, updated: 0, unchanged: 0 });

		await runNotionDiscoverCadence();

		expect(runDiscover).toHaveBeenCalledTimes(2);
		expect((runDiscover as any).mock.calls[0][0].items).toHaveLength(200);
		expect((runDiscover as any).mock.calls[1][0].items).toHaveLength(50);
		expect(recordRun).toHaveBeenCalledWith(
			expect.objectContaining({
				counts: expect.objectContaining({ scanned: 250, new: 250, workspaces: 1 }),
			}),
		);
	});
});
