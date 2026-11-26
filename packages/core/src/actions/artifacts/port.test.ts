import { describe, expect, it, vi } from "vitest";
import { AdapterUnavailableError, buildRegistry } from "../buildRegistry.js";
import type { ClusterRow } from "../../ports/artifacts.js";
import { createCoreArtifactsPort } from "./port.js";

const sampleRow: ClusterRow = {
	cluster_kind: "exact",
	cluster_key: "5d41402abc4b2a76b9719d911017c592",
	cluster_rank: 1,
	member_count: 2,
	ranked_members: 2,
	distinct_contents: 1,
	unhashed_members: 0,
	member_rank: 1,
	artifact_id: "b564a861-0000-4000-8000-000000000001",
	title: "Angus Hally CV.pdf",
	link: "https://drive.google.com/file/d/1/view",
	connector: "gdrive",
	external_id: "1",
	source_created_at: "2025-09-18T10:00:00.000Z",
	source_modified_at: "2025-09-18T10:00:00.000Z",
	owner: "Angus Hally",
	owner_email: null,
	content_hash: "5d41402abc4b2a76b9719d911017c592",
	content_hash_kind: "md5",
	owned_by_self: true,
	enriched: false,
	lifecycle_stage: "discovered",
	archived: false,
	archived_reason: null,
};

describe("createCoreArtifactsPort (#1659)", () => {
	it("rejects both capture and documentDuplicates with AdapterUnavailableError when given {} adapters", async () => {
		const unwired = createCoreArtifactsPort({});
		await expect(unwired.capture({ text: "hello" }, "user-1")).rejects.toThrow(AdapterUnavailableError);
		await expect(unwired.documentDuplicates({}, "user-1")).rejects.toThrow(AdapterUnavailableError);
	});

	it("implements both capture and documentDuplicates over core ports", async () => {
		const duplicateClusters = vi.fn(async () => [sampleRow]);
		const port = createCoreArtifactsPort({
			ownerId: "user-core-1",
			storageBucket: "artifacts",
			now: () => new Date("2026-09-24T12:00:00.000Z"),
			config: {
				loadCapturePreferences: async () => ({
					create_derived_artifacts: true,
					default_tags: ["core"],
					default_source_channel: "mcp",
					tag_rules: [],
					default_surface: "claude_code",
					surface_trust_map: {},
					default_trust: "medium",
					default_role: "narrative",
					surface_role_map: {},
				}),
			},
			storage: {
				upload: vi.fn(async () => {}),
				remove: vi.fn(async () => {}),
				publicUrl: (bucket, path) => `https://example.test/${bucket}/${path}`,
			},
			artifacts: {
				findOldestByDedupKey: vi.fn(async () => null),
				findOldestByFingerprint: vi.fn(async () => null),
				insert: vi.fn(async (row) => ({
					id: row.id,
					title: row.title,
					created_at: "2026-09-24T12:00:00.000Z",
				})),
				duplicateClusters,
			},
			embedding: { embed: vi.fn(async () => [0.1]), embedBatch: vi.fn(async () => [[0.1]]) },
			embeddingStore: { setEmbedding: vi.fn(async () => {}) },
		});

		const registry = buildRegistry({ artifacts: port });
		const ctx = { caller: "mcp" as const, requestId: "req-1", userId: "user-ctx" };

		const captured = await registry.get("capture")!.run({ text: "Body", title: "Port Capture" }, ctx);
		expect(captured).toMatchObject({ title: "Port Capture", tags: ["core"], deduplicated: false });

		const dupes = await registry.get("document_duplicates")!.run({ query: "CV", limit: 5 }, ctx);
		expect(duplicateClusters).toHaveBeenCalledWith({
			userId: "user-ctx",
			query: "CV",
			connector: null,
			min_cluster: 2,
			limit: 5,
			include_archived: false,
		});
		expect(dupes.clusters).toHaveLength(1);
	});
});
