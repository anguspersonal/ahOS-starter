import { describe, expect, it, vi } from "vitest";
import {
	ARTIFACT_DEDUP_SELECT_COLUMNS,
	ArtifactWriteError,
	createSupabaseArtifactRepository,
	type ArtifactInsertRow,
	type ArtifactSupabaseClient,
} from "./artifacts.js";

function validArtifactInsertRow(
	overrides: Partial<ArtifactInsertRow> = {},
): ArtifactInsertRow {
	return {
		id: "art-1",
		user_id: "user-123",
		storage_bucket: "user-uploads",
		storage_path: "user-123/art-1.md",
		storage_url:
			"https://example.supabase.co/storage/v1/object/public/user-uploads/user-123/art-1.md",
		filename: "art-1.md",
		original_file_name: "art-1.md",
		file_type: "text/markdown",
		content_type: "text/markdown",
		file_extension: "md",
		file_size: 42,
		artifact_type: "note",
		captured_at: "2026-04-19T10:00:00.000Z",
		surface: "api",
		lifecycle_stage: "captured",
		processing_status: "completed",
		title: "Test Artifact",
		plain_text: "Hello world",
		...overrides,
	};
}

describe("createSupabaseArtifactRepository write & dedup seam (#1611)", () => {
	it("insert(row) calls .from('artifacts').insert(row).select('id, title, created_at').single() and returns the inserted row", async () => {
		const single = vi.fn().mockResolvedValue({
			data: {
				id: "art-1",
				title: "Test Artifact",
				created_at: "2026-04-19T10:00:00.000Z",
			},
			error: null,
		});
		const select = vi.fn().mockReturnValue({ single });
		const insert = vi.fn().mockReturnValue({ select });
		const from = vi.fn().mockReturnValue({ insert });

		const repo = createSupabaseArtifactRepository({
			client: { from } as unknown as ArtifactSupabaseClient,
			ownerId: "user-123",
		});

		const row = validArtifactInsertRow();
		const res = await repo.insert(row);

		expect(from).toHaveBeenCalledWith("artifacts");
		expect(insert).toHaveBeenCalledWith(row);
		expect(select).toHaveBeenCalledWith("id, title, created_at");
		expect(single).toHaveBeenCalledTimes(1);
		expect(res).toEqual({
			id: "art-1",
			title: "Test Artifact",
			created_at: "2026-04-19T10:00:00.000Z",
		});
	});

	it("insert(row) rejects with ArtifactWriteError preserving PostgREST code and message on unique violation", async () => {
		const single = vi.fn().mockResolvedValue({
			data: null,
			error: {
				code: "23505",
				message:
					'duplicate key value violates unique constraint "idx_artifacts_user_dedup_key"',
			},
		});
		const select = vi.fn().mockReturnValue({ single });
		const insert = vi.fn().mockReturnValue({ select });
		const from = vi.fn().mockReturnValue({ insert });

		const repo = createSupabaseArtifactRepository({
			client: { from } as unknown as ArtifactSupabaseClient,
			ownerId: "user-123",
		});

		let caught: unknown;
		try {
			await repo.insert(validArtifactInsertRow());
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(ArtifactWriteError);
		expect((caught as ArtifactWriteError).code).toBe("23505");
		expect((caught as ArtifactWriteError).message).toContain(
			"idx_artifacts_user_dedup_key",
		);
	});

	it("findOldestByDedupKey scopes to owner, orders by created_at ascending limit 1, and returns first row or null", async () => {
		const matchRow = {
			id: "art-existing",
			title: "Existing Slack Thread",
			tags: ["slack"],
			source_channel: "slack",
			storage_bucket: "user-uploads",
			storage_path: "user-123/art-existing.md",
			captured_at: "2026-04-18T12:00:00.000Z",
			content_fingerprint: "fp-1",
			processing_metadata: { messages: 3 },
		};
		const limit = vi
			.fn()
			.mockResolvedValueOnce({ data: [matchRow], error: null })
			.mockResolvedValueOnce({ data: [], error: null });
		const order = vi.fn().mockReturnValue({ limit });
		const eqDedup = vi.fn().mockReturnValue({ order });
		const eqUser = vi.fn().mockReturnValue({ eq: eqDedup });
		const select = vi.fn().mockReturnValue({ eq: eqUser });
		const from = vi.fn().mockReturnValue({ select });

		const repo = createSupabaseArtifactRepository({
			client: { from } as unknown as ArtifactSupabaseClient,
			ownerId: () => "user-123",
		});

		const found = await repo.findOldestByDedupKey("slack:C1:1");
		expect(from).toHaveBeenCalledWith("artifacts");
		expect(select).toHaveBeenCalledWith(ARTIFACT_DEDUP_SELECT_COLUMNS);
		expect(eqUser).toHaveBeenCalledWith("user_id", "user-123");
		expect(eqDedup).toHaveBeenCalledWith("dedup_key", "slack:C1:1");
		expect(order).toHaveBeenCalledWith("created_at", { ascending: true });
		expect(limit).toHaveBeenCalledWith(1);
		expect(found).toEqual(matchRow);

		const missing = await repo.findOldestByDedupKey("slack:C1:missing");
		expect(missing).toBeNull();
	});

	it("findOldestByFingerprint scopes to owner, filters gte created_at, orders ascending limit 1, and returns first row or null", async () => {
		const matchRow = {
			id: "art-fp",
			title: "Existing Note",
			tags: null,
			source_channel: "api",
			storage_bucket: "user-uploads",
			storage_path: "user-123/art-fp.md",
			captured_at: "2026-04-19T01:00:00.000Z",
			content_fingerprint: "abc",
			processing_metadata: null,
		};
		const limit = vi
			.fn()
			.mockResolvedValueOnce({ data: [matchRow], error: null })
			.mockResolvedValueOnce({ data: [], error: null });
		const order = vi.fn().mockReturnValue({ limit });
		const gte = vi.fn().mockReturnValue({ order });
		const eqFp = vi.fn().mockReturnValue({ gte });
		const eqUser = vi.fn().mockReturnValue({ eq: eqFp });
		const select = vi.fn().mockReturnValue({ eq: eqUser });
		const from = vi.fn().mockReturnValue({ select });

		const repo = createSupabaseArtifactRepository({
			client: { from } as unknown as ArtifactSupabaseClient,
			ownerId: "user-123",
		});

		const found = await repo.findOldestByFingerprint(
			"abc",
			"2026-04-19T00:00:00.000Z",
		);
		expect(from).toHaveBeenCalledWith("artifacts");
		expect(select).toHaveBeenCalledWith(ARTIFACT_DEDUP_SELECT_COLUMNS);
		expect(eqUser).toHaveBeenCalledWith("user_id", "user-123");
		expect(eqFp).toHaveBeenCalledWith("content_fingerprint", "abc");
		expect(gte).toHaveBeenCalledWith("created_at", "2026-04-19T00:00:00.000Z");
		expect(order).toHaveBeenCalledWith("created_at", { ascending: true });
		expect(limit).toHaveBeenCalledWith(1);
		expect(found).toEqual(matchRow);

		const missing = await repo.findOldestByFingerprint(
			"abc",
			"2026-04-19T00:00:00.000Z",
		);
		expect(missing).toBeNull();
	});

	it("enforces non-optional surface at compile time on ArtifactInsertRow", () => {
		const validRow = validArtifactInsertRow();
		const checkType = (_row: ArtifactInsertRow) => _row;
		expect(checkType(validRow).surface).toBe("api");

		if (false as boolean) {
			const repo = createSupabaseArtifactRepository({
				client: {} as unknown as ArtifactSupabaseClient,
				ownerId: "user-123",
			});
			// @ts-expect-error surface must be a non-undefined string
			void repo.insert({ ...validRow, surface: undefined });

			// @ts-expect-error omitting surface from ArtifactInsertRow is a compile error
			const missingSurface: ArtifactInsertRow = {
				id: "art-2",
				user_id: "user-123",
				storage_bucket: "user-uploads",
				storage_path: "user-123/art-2.md",
				storage_url: "https://example.supabase.co/storage/v1/object/public/user-uploads/user-123/art-2.md",
				filename: "art-2.md",
				original_file_name: "art-2.md",
				file_type: "text/markdown",
				content_type: "text/markdown",
				file_extension: "md",
				file_size: 10,
				artifact_type: "note",
				captured_at: "2026-04-19T10:00:00.000Z",
				lifecycle_stage: "captured",
				processing_status: "completed",
				title: "No Surface",
				plain_text: "Body",
			};
			void missingSurface;
		}
	});
});
