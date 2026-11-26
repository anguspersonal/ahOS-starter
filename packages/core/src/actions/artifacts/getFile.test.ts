import { describe, expect, it, vi } from "vitest";
import { executeAction } from "../adapters/direct.js";
import { DEFAULT_CAPTURE_PREFERENCES } from "../../domain/capturePreferences.js";
import type { ArtifactRow } from "../../ports/artifacts.js";
import { createArtifactGetFileAction, type ArtifactGetFilePorts } from "./getFile.js";

const ART_ID = "11111111-2222-4333-8444-555555555555";

function makeArtifact(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
	return {
		id: ART_ID,
		title: "Test photo",
		description: null,
		plain_text: "hello",
		tags: [],
		lifecycle_stage: "uploaded",
		source: null,
		source_url: null,
		source_channel: "note",
		surface: null,
		trust_override: null,
		source_drive_file_id: null,
		source_parent_folder_ids: null,
		source_parent_folder_path: null,
		routing_decision: null,
		routing_confidence: null,
		routing_reason: null,
		drive_action: null,
		drive_action_at: null,
		created_at: "2026-07-13T00:00:00.000Z",
		storage_bucket: "user-uploads",
		storage_path: "drive-imports/user/photo.jpg",
		storage_url:
			"https://x.supabase.co/storage/v1/object/public/user-uploads/drive-imports/user/photo.jpg",
		file_type: "image/jpeg",
		file_size: 1024,
		processing_metadata: null,
		...overrides,
	};
}

function makePorts(overrides: Partial<ArtifactGetFilePorts> = {}): ArtifactGetFilePorts {
	return {
		artifacts: {
			getById: async () => makeArtifact(),
			getLinkedEntities: async () => [],
		},
		externalLinks: {
			getExternalLinks: async () => [],
		},
		config: {
			loadCapturePreferences: async () => DEFAULT_CAPTURE_PREFERENCES,
		},
		storage: {
			signedUrl: async (bucket, path, ttl) =>
				`https://signed.example/${bucket}/${path}?ttl=${ttl}`,
		},
		...overrides,
	};
}

describe("createArtifactGetFileAction (#1610)", () => {
	it("returns found: false and 'No artifact <id>.' when getById returns null without calling storage", async () => {
		const signedUrl = vi.fn();
		const action = createArtifactGetFileAction(
			makePorts({
				artifacts: {
					getById: async () => null,
					getLinkedEntities: async () => [],
				},
				storage: { signedUrl },
			}),
		);

		const result = await executeAction(action, { id: ART_ID });
		expect(result).toEqual({
			found: false,
			text: `No artifact ${ART_ID}.`,
		});
		expect(action.formatMcp!(result)).toBe(`No artifact ${ART_ID}.`);
		expect(signedUrl).not.toHaveBeenCalled();
	});

	it("mints a signed URL for a binary artifact and falls back across bucketCandidates", async () => {
		const signedUrl = vi.fn(async (bucket: string, path: string, ttl: number) => {
			if (bucket === "raw-inputs") {
				return `https://signed.example/${bucket}/${path}?ttl=${ttl}`;
			}
			throw new Error("not found");
		});
		const action = createArtifactGetFileAction(
			makePorts({
				artifacts: {
					getById: async () =>
						makeArtifact({
							storage_bucket: "inputs",
							storage_url:
								"https://x.supabase.co/storage/v1/object/public/inputs/drive-imports/user/photo.jpg",
						}),
					getLinkedEntities: async () => [],
				},
				storage: { signedUrl },
			}),
		);

		const result = await executeAction(action, { id: ART_ID });
		expect(result.found).toBe(true);
		expect(result.text).toContain(
			"File: https://signed.example/raw-inputs/drive-imports/user/photo.jpg?ttl=3600 (signed, bucket=raw-inputs, expires in 3600s)",
		);
		expect(signedUrl).toHaveBeenCalledWith("inputs", "drive-imports/user/photo.jpg", 3600);
		expect(signedUrl).toHaveBeenCalledWith("raw-inputs", "drive-imports/user/photo.jpg", 3600);
	});

	it("returns a clean null file line for a textual capture without calling storage", async () => {
		const signedUrl = vi.fn();
		const action = createArtifactGetFileAction(
			makePorts({
				artifacts: {
					getById: async () =>
						makeArtifact({
							file_type: "text/markdown",
							storage_path: "notes/user/note.md",
						}),
					getLinkedEntities: async () => [],
				},
				storage: { signedUrl },
			}),
		);

		const result = await executeAction(action, { id: ART_ID });
		expect(result.found).toBe(true);
		expect(result.text).toContain(
			"File: none (text capture — its content is the plain_text above, not a separate attached file).",
		);
		expect(signedUrl).not.toHaveBeenCalled();
	});

	it("surfaces an external pointer's storage_url as-is without calling storage", async () => {
		const signedUrl = vi.fn();
		const action = createArtifactGetFileAction(
			makePorts({
				artifacts: {
					getById: async () =>
						makeArtifact({
							storage_bucket: "external",
							storage_path: "discovered/notion/abc123",
							storage_url: "https://www.notion.so/Some-Page-abc123",
							file_type: null,
						}),
					getLinkedEntities: async () => [],
				},
				storage: { signedUrl },
			}),
		);

		const result = await executeAction(action, { id: ART_ID });
		expect(result.found).toBe(true);
		expect(result.text).toContain(
			"File: external link only (storage_url is not a Supabase Storage object) — https://www.notion.so/Some-Page-abc123",
		);
		expect(signedUrl).not.toHaveBeenCalled();
	});

	it("reports every bucket tried when signed URL fails across all candidate buckets", async () => {
		const signedUrl = vi.fn(async () => {
			throw new Error("not found");
		});
		const action = createArtifactGetFileAction(
			makePorts({
				storage: { signedUrl },
			}),
		);

		const result = await executeAction(action, { id: ART_ID });
		expect(result.found).toBe(true);
		expect(result.text).toContain(
			'File: unavailable — signed URL failed for "drive-imports/user/photo.jpg" (tried [user-uploads, raw-inputs, derived-artifacts]): user-uploads: not found; raw-inputs: not found; derived-artifacts: not found',
		);
	});
});
