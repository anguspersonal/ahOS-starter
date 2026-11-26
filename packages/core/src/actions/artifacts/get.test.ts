import { describe, expect, it } from "vitest";
import { executeAction } from "../adapters/direct.js";
import { DEFAULT_CAPTURE_PREFERENCES } from "../../domain/capturePreferences.js";
import type { ArtifactRow } from "../../ports/artifacts.js";
import { createArtifactGetAction, type ArtifactGetPorts } from "./get.js";

const ART_ID = "11111111-2222-4333-8444-555555555555";

function makeArtifact(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
	return {
		id: ART_ID,
		title: "Quarterly Review Notes",
		description: "Notes from Q3 review",
		plain_text: "Full transcript of Q3 review.",
		tags: ["q3", "review"],
		lifecycle_stage: "uploaded",
		source: null,
		source_url: "https://example.com/q3",
		source_channel: "mcp",
		surface: "claude_code",
		trust_override: null,
		source_drive_file_id: null,
		source_parent_folder_ids: null,
		source_parent_folder_path: null,
		routing_decision: null,
		routing_confidence: null,
		routing_reason: null,
		drive_action: null,
		drive_action_at: null,
		created_at: "2026-10-01T00:00:00.000Z",
		storage_bucket: "user-uploads",
		storage_path: "notes/q3.md",
		storage_url: "https://example.supabase.co/storage/v1/object/public/user-uploads/notes/q3.md",
		file_type: "text/markdown",
		file_size: 29,
		processing_metadata: null,
		...overrides,
	};
}

function makePorts(overrides: Partial<ArtifactGetPorts> = {}): ArtifactGetPorts {
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
		...overrides,
	};
}

describe("createArtifactGetAction (#1511)", () => {
	it("returns found: false and 'No artifact <id>.' when getById returns null", async () => {
		const action = createArtifactGetAction(
			makePorts({
				artifacts: {
					getById: async () => null,
					getLinkedEntities: async () => [],
				},
			}),
		);

		const result = await executeAction(action, { id: ART_ID });
		expect(result).toEqual({
			found: false,
			text: `No artifact ${ART_ID}.`,
		});
		expect(action.formatMcp!(result)).toBe(`No artifact ${ART_ID}.`);
	});

	it("renders metadata, provenance, linked entities, derived external links, and plain_text", async () => {
		const action = createArtifactGetAction(
			makePorts({
				artifacts: {
					getById: async () =>
						makeArtifact({
							trust_override: "high",
							source_drive_file_id: "drive-123",
							source_parent_folder_path: "/Ops/Q3",
							source_parent_folder_ids: ["folder-1"],
							routing_decision: "keep_in_place",
							routing_confidence: 0.95,
							routing_reason: "Active folder",
							drive_action: "none",
							drive_action_at: "2026-10-01T01:00:00.000Z",
						}),
					getLinkedEntities: async () => [
						{ title: "Alice", entity_type: "people" },
						{ title: "Work", entity_type: "organizations" },
					],
				},
				externalLinks: {
					getExternalLinks: async () => [
						{
							provider: "notion_work",
							kind: "task",
							external_id: "page-1",
							external_url: "https://notion.so/page-1",
						},
					],
				},
				config: {
					loadCapturePreferences: async () => ({
						...DEFAULT_CAPTURE_PREFERENCES,
						surface_role_map: { claude_code: "narrative" },
					}),
				},
			}),
		);

		const result = await executeAction(action, { id: ART_ID });
		expect(result.found).toBe(true);
		expect(result.text).toBe(
			[
				`Artifact ${ART_ID}`,
				"Title: Quarterly Review Notes",
				"Description: Notes from Q3 review",
				"Stage: uploaded  Source: https://example.com/q3",
				"Provenance: channel=mcp surface=claude_code trust=high (override) role=narrative",
				"Drive file: drive-123",
				"Drive parent folders: /Ops/Q3 [folder-1]",
				"Routing: keep_in_place (0.95) — Active folder",
				"Drive action: none @ 2026-10-01T01:00:00.000Z",
				"Tags: q3, review",
				"Entities: Alice (people), Work (organizations)",
				"Derived: task@notion_work → https://notion.so/page-1",
				"",
				"Full transcript of Q3 review.",
			].join("\n"),
		);
	});

	it("prints pointerDetailLines for a discovered pointer (storage_bucket 'external')", async () => {
		const action = createArtifactGetAction(
			makePorts({
				artifacts: {
					getById: async () =>
						makeArtifact({
							title: "Angus Hally CV.pdf",
							description: null,
							plain_text: null,
							tags: [],
							lifecycle_stage: "discovered",
							source: "1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-",
							source_url: null,
							source_channel: "discovered_gdrive",
							surface: "discovered_gdrive",
							storage_bucket: "external",
							storage_path: "discovered/gdrive/1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-",
							storage_url:
								"https://drive.google.com/file/d/1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-/view",
							file_type: null,
							file_size: null,
							processing_metadata: {
								discovery: {
									connector: "gdrive",
									external_id: "1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-",
									url: "https://drive.google.com/file/d/1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-/view",
									owner: "Angus Hally",
									owner_email: "owner@example.com",
									source_created_at: "2025-05-13T09:00:00.000Z",
									source_modified_at: "2025-05-13T09:30:00.000Z",
									content_hash: "5d41402abc4b2a76b9719d911017c592",
									mime_type: "application/pdf",
									size: "837932",
								},
							},
						}),
					getLinkedEntities: async () => [],
				},
			}),
		);

		const result = await executeAction(action, { id: ART_ID });
		expect(result.found).toBe(true);
		expect(result.text).toContain(
			"Link: https://drive.google.com/file/d/1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-/view",
		);
		expect(result.text).toContain("Connector: gdrive");
		expect(result.text).toContain("External id: 1LY7cYO32CQX2ICiKUyJXyxFc_Ad_AAT-");
		expect(result.text).toContain("Owner: Angus Hally <owner@example.com>");
		expect(result.text).toContain("Content hash: 5d41402abc4b2a76b9719d911017c592 (md5)");
		expect(result.text).toContain("Mime type: application/pdf");
		expect(result.text).toContain("Size: 837,932 bytes");
		expect(result.text).toContain("Modified at source: 2025-05-13T09:30:00.000Z");
		expect(result.text).toContain(
			"Provenance: channel=discovered_gdrive surface=discovered_gdrive trust=medium role=evidence",
		);
	});
});
