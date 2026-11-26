import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "../supabase.js";
import { getArtifactHandler } from "../tools/getArtifact.js";
import { contentHashKind, documentLink, formatSize } from "../tools/documentPointer.js";

// #1214: artifact_get prints an external pointer's discovery envelope, so an agent
// can act on a discovered document (open it, tell whose it is, tell whether two
// copies are byte-identical) without a second call. Every other artifact's output
// is pinned byte-for-byte below.

const ART_ID = "11111111-2222-3333-4444-555555555555";

vi.mock("../captureConfig.js", () => ({
	loadCapturePreferences: vi.fn(async () => ({})),
	resolveTrust: vi.fn(() => "medium"),
	resolveSynthesisRole: vi.fn(() => "evidence"),
}));

vi.mock("../links.js", () => ({
	getExternalLinks: vi.fn(async () => []),
}));

const origFrom = supabase.from;

afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

function stubArtifact(row: Record<string, unknown>) {
	(supabase as any).from = vi.fn((table: string) => {
		if (table === "artifacts") {
			return {
				select: () => ({
					eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }),
				}),
			};
		}
		if (table === "artifact_entity_links") {
			return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
		}
		throw new Error(`unexpected table in test: ${table}`);
	});
}

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: ART_ID,
		title: "Angus Hally CV.pdf",
		description: null,
		plain_text: null,
		tags: [],
		lifecycle_stage: "discovered",
		source: "1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-",
		source_url: null,
		source_channel: "discovered_gdrive",
		surface: "discovered_gdrive",
		trust_override: null,
		source_drive_file_id: null,
		source_parent_folder_ids: null,
		source_parent_folder_path: null,
		routing_decision: null,
		routing_confidence: null,
		routing_reason: null,
		drive_action: null,
		drive_action_at: null,
		created_at: "2026-08-04T00:00:00.000Z",
		storage_bucket: "external",
		storage_path: "discovered/gdrive/1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-",
		storage_url: "https://drive.google.com/file/d/1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-/view",
		file_type: null,
		file_size: null,
		processing_metadata: {
			discovery: {
				connector: "gdrive",
				external_id: "1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-",
				url: "https://drive.google.com/file/d/1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-/view",
				owner: "Angus Hally",
				source_created_at: "2025-05-13T09:00:00.000Z",
				source_modified_at: "2025-05-13T09:30:00.000Z",
				content_hash: "5d41402abc4b2a76b9719d911017c592",
			},
		},
		...overrides,
	};
}

async function text(r: Record<string, unknown>): Promise<string> {
	stubArtifact(r);
	const out = await getArtifactHandler({ id: ART_ID });
	return out.content[0].text;
}

describe("artifact_get — external pointer details (#1214)", () => {
	it("prints a Drive pointer's link, connector, id, owner, md5 and modified time", async () => {
		const out = await text(row());
		expect(out).toContain("Link: https://drive.google.com/file/d/1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-/view");
		expect(out).toContain("Connector: gdrive");
		expect(out).toContain("External id: 1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-");
		expect(out).toContain("Owner: Angus Hally");
		expect(out).toContain("Content hash: 5d41402abc4b2a76b9719d911017c592 (md5)");
		expect(out).toContain("Modified at source: 2025-05-13T09:30:00.000Z");
		// Absent in the envelope, so not printed at all.
		expect(out).not.toContain("Mime type:");
		expect(out).not.toContain("Size:");
	});

	it("prints mime type, size and the owner's email once the Drive envelope carries them (#1228)", async () => {
		const r = row();
		(r.processing_metadata as any).discovery = {
			...(r.processing_metadata as any).discovery,
			mime_type: "application/pdf",
			size: "837932",
			owner_email: "owner@example.com",
		};
		const out = await text(r);
		expect(out).toContain("Mime type: application/pdf");
		expect(out).toContain("Size: 837,932 bytes");
		expect(out).toContain("Owner: Angus Hally <owner@example.com>");
	});

	it("labels a Google-native doc's modifiedTime fallback as modified_time, not a content hash", async () => {
		const r = row({ title: "Budget 2025" });
		(r.processing_metadata as any).discovery.content_hash = "2025-10-17T04:55:31.000Z";
		const out = await text(r);
		expect(out).toContain("Content hash: 2025-10-17T04:55:31.000Z (modified_time)");
	});

	it("handles a Notion pointer: last_edited_time as the hash, no owner", async () => {
		const out = await text(
			row({
				title: "Product Management CV",
				source: "1fbb7b8b-edcd-8108-81de-c9b081a7ad4b",
				source_channel: "discovered_notion",
				surface: "discovered_notion",
				storage_url: "https://www.notion.so/1fbb7b8bedcd810881dec9b081a7ad4b",
				processing_metadata: {
					discovery: {
						connector: "notion",
						external_id: "1fbb7b8b-edcd-8108-81de-c9b081a7ad4b",
						url: "https://www.notion.so/1fbb7b8bedcd810881dec9b081a7ad4b",
						owner: null,
						source_modified_at: "2025-05-22T10:11:00.000Z",
						content_hash: "2025-05-22T10:11:00.000Z",
					},
				},
			}),
		);
		expect(out).toContain("Link: https://www.notion.so/1fbb7b8bedcd810881dec9b081a7ad4b");
		expect(out).toContain("Connector: notion");
		expect(out).toContain("Owner: (unknown)");
		expect(out).toContain("Content hash: 2025-05-22T10:11:00.000Z (modified_time)");
	});

	it("says so when a pointer has only its discovered:// locator and no envelope", async () => {
		const out = await text(
			row({ storage_url: "discovered://gdrive/abc", source: "abc", processing_metadata: null }),
		);
		expect(out).toContain("Link: (none recorded; locator discovered://gdrive/abc)");
		expect(out).toContain("Connector: gdrive");
		expect(out).toContain("External id: abc");
		expect(out).toContain("Content hash: (none)");
		expect(out).toContain("Modified at source: (unknown)");
	});

	it("prints every other artifact exactly as before", async () => {
		const out = await text(
			row({
				title: "A note",
				plain_text: "hello",
				lifecycle_stage: "uploaded",
				source: null,
				source_channel: "mcp",
				surface: "cowork",
				storage_bucket: "user-uploads",
				storage_path: "notes/a.txt",
				storage_url: "https://x.supabase.co/storage/v1/object/public/user-uploads/notes/a.txt",
				tags: ["cv"],
				processing_metadata: { discovery: { connector: "gdrive", content_hash: "x" } },
			}),
		);
		expect(out).toBe(
			[
				`Artifact ${ART_ID}`,
				"Title: A note",
				"Stage: uploaded  Source: ?",
				"Provenance: channel=mcp surface=cowork trust=medium role=evidence",
				"Tags: cv",
				"",
				"hello",
			].join("\n"),
		);
	});
});

describe("documentPointer helpers", () => {
	it("only calls a 32-hex value an md5", () => {
		expect(contentHashKind("5d41402abc4b2a76b9719d911017c592")).toBe("md5");
		expect(contentHashKind("5D41402ABC4B2A76B9719D911017C592")).toBe("modified_time");
		expect(contentHashKind("2025-10-17T04:55:31.000Z")).toBe("modified_time");
		expect(contentHashKind(null)).toBeNull();
		expect(contentHashKind("")).toBeNull();
	});

	it("prefers the envelope url, since enrichment re-points storage_url at the stored blob", () => {
		expect(
			documentLink({
				storage_bucket: "user-uploads",
				storage_url: "https://x.supabase.co/storage/v1/object/public/user-uploads/enriched/gdrive/a.pdf",
				processing_metadata: { discovery: { url: "https://drive.google.com/file/d/a/view" } },
			}),
		).toBe("https://drive.google.com/file/d/a/view");
		expect(documentLink({ storage_bucket: "external", storage_url: "discovered://gdrive/a" })).toBeNull();
		expect(documentLink({ storage_bucket: "external", storage_url: "https://n.so/a" })).toBe("https://n.so/a");
		expect(documentLink({ storage_bucket: "user-uploads", storage_url: "https://blob", source_url: "https://src" })).toBe(
			"https://src",
		);
	});

	it("formats sizes and passes junk through rather than printing NaN", () => {
		expect(formatSize(837932)).toBe("837,932 bytes");
		expect(formatSize("37406")).toBe("37,406 bytes");
		expect(formatSize("big")).toBe("big");
		expect(formatSize(null)).toBeNull();
		expect(formatSize("")).toBeNull();
	});
});
