import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRegistry } from "@ahkms/core/actions";
import {
	createSupabaseArtifactRepository,
	createSupabaseStorageAdapter,
	type ArtifactSupabaseClient,
	type StorageSupabaseClient,
} from "@ahkms/core/adapters";
import { toMcpTool } from "../actions/index.js";
import { loadCapturePreferences } from "../captureConfig.js";
import { getCurrentUserId } from "../identity.js";
import { getExternalLinks } from "../links.js";
import { supabase } from "../supabase.js";
import { getArtifactHandler } from "../tools/getArtifact.js";

const ART_ID = "11111111-2222-3333-4444-555555555555";

// Isolate from the DB-backed prefs loader and the external-links lookup — artifact_get's
// own tests would cover their content; here we only care about the file-reference logic
// artifact_get_file (#588) adds on top.
vi.mock("../captureConfig.js", () => ({
	loadCapturePreferences: vi.fn(async () => ({
		default_tags: [],
		tag_rules: [],
		default_source_channel: "note",
		default_surface: null,
	})),
	resolveTrust: vi.fn(() => "medium"),
	resolveSynthesisRole: vi.fn(() => "context"),
}));

vi.mock("../links.js", () => ({
	getExternalLinks: vi.fn(async () => []),
}));

const getArtifactAndFileHandler = toMcpTool(
	buildRegistry({
		artifactRepository: createSupabaseArtifactRepository({
			client: supabase as unknown as ArtifactSupabaseClient,
			ownerId: getCurrentUserId,
		}),
		externalLinks: { getExternalLinks } as any,
		config: { loadCapturePreferences } as any,
		storage: createSupabaseStorageAdapter(supabase as unknown as StorageSupabaseClient),
	}).get("artifact_get_file")!,
).handler;

const origFrom = supabase.from;
const origStorageFrom = supabase.storage.from;

afterEach(() => {
	(supabase as any).from = origFrom;
	(supabase.storage as any).from = origStorageFrom;
	vi.restoreAllMocks();
});

function baseArtifactRow(overrides: Record<string, unknown> = {}) {
	return {
		id: ART_ID,
		title: "Test artifact",
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
		...overrides,
	};
}

/** Stub the `artifacts` + `artifact_entity_links` reads loadArtifact performs. */
function stubArtifactsQuery(row: Record<string, unknown> | null) {
	(supabase as any).from = vi.fn((table: string) => {
		if (table === "artifacts") {
			return {
				select: () => ({
					eq: () => ({
						eq: () => ({
							maybeSingle: () => Promise.resolve({ data: row, error: null }),
						}),
					}),
				}),
			};
		}
		if (table === "artifact_entity_links") {
			return {
				select: () => ({
					eq: () => Promise.resolve({ data: [], error: null }),
				}),
			};
		}
		throw new Error(`unexpected table in test: ${table}`);
	});
}

describe("getArtifactAndFileHandler — file reference resolution (#588)", () => {
	it("returns a signed URL for an artifact with a real stored file (photo/PDF)", async () => {
		stubArtifactsQuery(baseArtifactRow());
		const createSignedUrl = vi.fn(async (path: string) => ({
			data: { signedUrl: `https://signed.example/user-uploads/${path}` },
			error: null,
		}));
		(supabase.storage as any).from = vi.fn((bucket: string) => {
			expect(bucket).toBe("user-uploads");
			return { createSignedUrl };
		});

		const result = await getArtifactAndFileHandler({ id: ART_ID } as any);

		expect(result.content[0].text).toContain(`Artifact ${ART_ID}`);
		expect(result.content[0].text).toContain(
			"File: https://signed.example/user-uploads/drive-imports/user/photo.jpg",
		);
		expect(result.content[0].text).toContain("expires in 3600s");
		expect(createSignedUrl).toHaveBeenCalledWith("drive-imports/user/photo.jpg", 3600);
	});

	it("returns a clean null file for a plain-text capture (no separate attached file)", async () => {
		stubArtifactsQuery(
			baseArtifactRow({
				file_type: "text/markdown",
				storage_path: "notes/user/note.md",
				storage_url:
					"https://x.supabase.co/storage/v1/object/public/user-uploads/notes/user/note.md",
			}),
		);
		const storageFrom = vi.fn();
		(supabase.storage as any).from = storageFrom;

		const result = await getArtifactAndFileHandler({ id: ART_ID } as any);

		expect(result.content[0].text).toContain(
			"File: none (text capture — its content is the plain_text above, not a separate attached file).",
		);
		// No error thrown, and no wasted signed-URL attempt for a row we know has no
		// separate file.
		expect(storageFrom).not.toHaveBeenCalled();
	});

	it("surfaces a discovered pointer's external link as-is, not a signed URL", async () => {
		stubArtifactsQuery(
			baseArtifactRow({
				storage_bucket: "external",
				storage_path: "discovered/notion/abc123",
				storage_url: "https://www.notion.so/Some-Page-abc123",
				file_type: null,
			}),
		);
		const storageFrom = vi.fn();
		(supabase.storage as any).from = storageFrom;

		const result = await getArtifactAndFileHandler({ id: ART_ID } as any);

		expect(result.content[0].text).toContain(
			"File: external link only (storage_url is not a Supabase Storage object) — https://www.notion.so/Some-Page-abc123",
		);
		expect(storageFrom).not.toHaveBeenCalled();
	});

	it("matches artifact_get's not-found error shape for a missing/foreign artifact id", async () => {
		stubArtifactsQuery(null);
		const fileResult = await getArtifactAndFileHandler({ id: ART_ID } as any);

		stubArtifactsQuery(null);
		const plainResult = await getArtifactHandler({ id: ART_ID } as any);

		expect(fileResult.content).toEqual(plainResult.content);
		expect(fileResult.content[0].text).toBe(`No artifact ${ART_ID}.`);
	});

	it("reports signed-URL failure across every candidate bucket without throwing", async () => {
		stubArtifactsQuery(baseArtifactRow());
		(supabase.storage as any).from = vi.fn(() => ({
			createSignedUrl: async () => ({ data: null, error: { message: "not found" } }),
		}));

		const result = await getArtifactAndFileHandler({ id: ART_ID } as any);

		expect(result.content[0].text).toContain("File: unavailable");
		expect(result.content[0].text).toContain("signed URL failed");
	});
});
