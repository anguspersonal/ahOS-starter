import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "../fakeSupabase.testkit.js";
import { ARTIFACT_SELECT_COLUMNS, type ArtifactRow } from "../../ports/artifacts.js";
import { createSupabaseArtifactRepository } from "./artifacts.js";

const ART_ID = "11111111-2222-3333-4444-555555555555";
const USER_ID = "owner-123";

function sampleRow(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
	return {
		id: ART_ID,
		title: "Sample Artifact",
		description: "A description",
		plain_text: "body content",
		tags: ["ops"],
		lifecycle_stage: "uploaded",
		source: null,
		source_url: "https://example.com/doc",
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
		storage_path: "notes/sample.md",
		storage_url: "https://example.supabase.co/storage/v1/object/public/user-uploads/notes/sample.md",
		file_type: "text/markdown",
		file_size: 12,
		processing_metadata: null,
		...overrides,
	};
}

describe("createSupabaseArtifactRepository (#1511)", () => {
	it("getById selects ARTIFACT_SELECT_COLUMNS scoped by id and ownerId", async () => {
		const row = sampleRow();
		const fake = createFakeSupabase((call) => {
			if (call.table === "artifacts" && call.op === "select") {
				return { data: row, error: null };
			}
			return { data: null, error: null };
		});

		const repo = createSupabaseArtifactRepository({
			client: fake.client,
			ownerId: () => USER_ID,
		});

		const found = await repo.getById(ART_ID);
		expect(found).toEqual(row);
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0].table).toBe("artifacts");
		expect(fake.calls[0].selected).toBe(ARTIFACT_SELECT_COLUMNS);
		expect(fake.calls[0].single).toBe("maybeSingle");
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([
			["id", ART_ID],
			["user_id", USER_ID],
		]);
	});

	it("getById returns null when no row matches and throws on error", async () => {
		const fakeEmpty = createFakeSupabase(() => ({ data: null, error: null }));
		const repoEmpty = createSupabaseArtifactRepository({
			client: fakeEmpty.client,
			ownerId: USER_ID,
		});
		expect(await repoEmpty.getById(ART_ID)).toBeNull();

		const fakeErr = createFakeSupabase(() => ({
			data: null,
			error: { message: "connection timeout" },
		}));
		const repoErr = createSupabaseArtifactRepository({
			client: fakeErr.client,
			ownerId: USER_ID,
		});
		await expect(repoErr.getById(ART_ID)).rejects.toThrow("Fetch failed: connection timeout");
	});

	it("getLinkedEntities normalizes object and array entity embeds and degrades to [] on error", async () => {
		const fake = createFakeSupabase((call) => {
			if (call.table === "artifact_entity_links") {
				return {
					data: [
						{ entities: { title: "Alice", entity_type: "people" } },
						{ entities: [{ title: "Acme", entity_type: "organizations" }] },
						{ entities: null },
					],
					error: null,
				};
			}
			return { data: [], error: null };
		});

		const repo = createSupabaseArtifactRepository({
			client: fake.client,
			ownerId: USER_ID,
		});

		const entities = await repo.getLinkedEntities(ART_ID);
		expect(entities).toEqual([
			{ title: "Alice", entity_type: "people" },
			{ title: "Acme", entity_type: "organizations" },
		]);
		expect(fake.calls[0].selected).toBe("entities(title, entity_type)");
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([["artifact_id", ART_ID]]);

		const fakeErr = createFakeSupabase(() => ({
			data: null,
			error: { message: "relation missing" },
		}));
		const repoErr = createSupabaseArtifactRepository({
			client: fakeErr.client,
			ownerId: USER_ID,
		});
		expect(await repoErr.getLinkedEntities(ART_ID)).toEqual([]);
	});

	it("patch updates artifacts scoped to id and ownerId and normalizes archive stamps", async () => {
		const fake = createFakeSupabase((call) => ({
			data: {
				id: ART_ID,
				title: "Updated",
				description: null,
				plain_text: null,
				storage_bucket: "user-uploads",
				storage_path: "notes/sample.md",
				file_type: "text/markdown",
				routing_decision: "keep_in_place",
				drive_action: null,
				archived: false,
				updated_at: "2026-10-02T00:00:00.000Z",
				...(call.payload as Record<string, unknown>),
			},
			error: null,
		}));

		const repo = createSupabaseArtifactRepository({
			client: fake.client,
			ownerId: USER_ID,
		});

		const updated = await repo.patch(ART_ID, {
			title: "Updated",
			routing_decision: "keep_in_place",
			archived: false,
		});
		expect(updated.title).toBe("Updated");
		expect(fake.calls[0].op).toBe("update");
		expect(fake.calls[0].payload).toMatchObject({
			title: "Updated",
			routing_decision: "keep_in_place",
			archived: false,
			archived_at: null,
			archived_reason: null,
		});
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([
			["id", ART_ID],
			["user_id", USER_ID],
		]);
	});

	it("archive and hardDelete scope mutations to ownerId", async () => {
		const fake = createFakeSupabase(() => ({
			data: [{ id: ART_ID, title: "Sample Artifact" }],
			error: null,
		}));

		const repo = createSupabaseArtifactRepository({
			client: fake.client,
			ownerId: USER_ID,
		});

		const archived = await repo.archive([ART_ID], "duplicate");
		expect(archived).toEqual([{ id: ART_ID, title: "Sample Artifact" }]);
		expect(fake.calls[0].op).toBe("update");
		expect(fake.calls[0].payload).toMatchObject({
			archived: true,
			archived_reason: "duplicate",
		});
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([["user_id", USER_ID]]);
		expect(fake.filtersOf(fake.calls[0], "in")).toEqual([["id", [ART_ID]]]);

		const deleted = await repo.hardDelete([ART_ID]);
		expect(deleted).toEqual([{ id: ART_ID, title: "Sample Artifact" }]);
		expect(fake.calls[1].op).toBe("delete");
		expect(fake.filtersOf(fake.calls[1], "eq")).toEqual([["user_id", USER_ID]]);
		expect(fake.filtersOf(fake.calls[1], "in")).toEqual([["id", [ART_ID]]]);
	});

	it("findExistingSources queries source column scoped by ownerId and returns empty set for empty input", async () => {
		const fake = createFakeSupabase(() => ({
			data: [{ source: "https://github.com/acme/api/issues/1" }, { source: null }],
			error: null,
		}));
		const repo = createSupabaseArtifactRepository({
			client: fake.client,
			ownerId: USER_ID,
		});

		expect(await repo.findExistingSources([])).toEqual(new Set());
		expect(fake.calls).toHaveLength(0);

		const existing = await repo.findExistingSources([
			"https://github.com/acme/api/issues/1",
			"https://github.com/acme/api/issues/2",
		]);
		expect(existing).toEqual(new Set(["https://github.com/acme/api/issues/1"]));
		expect(fake.calls[0].selected).toBe("source");
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([["user_id", USER_ID]]);
		expect(fake.filtersOf(fake.calls[0], "in")).toEqual([
			["source", ["https://github.com/acme/api/issues/1", "https://github.com/acme/api/issues/2"]],
		]);
	});

	it("mutateByIds soft-archives when archiveOnly is true and hard-deletes when false", async () => {
		const fake = createFakeSupabase(() => ({
			data: [{ id: ART_ID, title: "Sample Artifact" }],
			error: null,
		}));

		const repo = createSupabaseArtifactRepository({
			client: fake.client,
			ownerId: USER_ID,
		});

		expect(await repo.mutateByIds([], true)).toEqual([]);
		expect(fake.calls).toHaveLength(0);

		const archived = await repo.mutateByIds([ART_ID], true, "stale");
		expect(archived).toEqual([{ id: ART_ID, title: "Sample Artifact" }]);
		expect(fake.calls[0].op).toBe("update");
		expect(fake.calls[0].payload).toMatchObject({
			archived: true,
			archived_reason: "stale",
		});
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([["user_id", USER_ID]]);
		expect(fake.filtersOf(fake.calls[0], "in")).toEqual([["id", [ART_ID]]]);

		const deleted = await repo.mutateByIds([ART_ID], false);
		expect(deleted).toEqual([{ id: ART_ID, title: "Sample Artifact" }]);
		expect(fake.calls[1].op).toBe("delete");
		expect(fake.filtersOf(fake.calls[1], "eq")).toEqual([["user_id", USER_ID]]);
		expect(fake.filtersOf(fake.calls[1], "in")).toEqual([["id", [ART_ID]]]);
	});

	it("getDocumentsByIds drops non-UUIDs, getPrimaryLinksForEntities groups links, and searchDocumentTitleCandidates calls rpc (#1622)", async () => {
		const fake = createFakeSupabase((call) => {
			if (call.table === "artifacts") {
				return {
					data: [
						{
							id: ART_ID,
							title: "CV.pdf",
							storage_bucket: "external",
							storage_url: "https://drive.google.com/file/d/1/view",
							source_url: null,
							source: "1",
							source_channel: "discovered_gdrive",
							surface: "discovered_gdrive",
							file_type: "application/pdf",
							archived: false,
							archived_reason: null,
							lifecycle_stage: "discovered",
							processing_metadata: null,
						},
					],
					error: null,
				};
			}
			if (call.table === "artifact_entity_links") {
				return {
					data: [
						{ artifact_id: ART_ID, entity_id: "ent-1" },
						{ artifact_id: ART_ID, entity_id: "ent-1" },
					],
					error: null,
				};
			}
			return { data: [], error: null };
		});
		let rpcCall: { name: string; params: unknown; selected: string } | null = null;
		(fake.client as any).rpc = (name: string, params: unknown) => ({
			select(cols: string) {
				rpcCall = { name, params, selected: cols };
				return Promise.resolve({
					data: [{ id: ART_ID, title: "CV.pdf" }],
					error: null,
				});
			},
		});

		const repo = createSupabaseArtifactRepository({
			client: fake.client,
			ownerId: USER_ID,
		});

		const map = await repo.getDocumentsByIds([ART_ID, "not-a-uuid"]);
		expect(map.size).toBe(1);
		expect(fake.filtersOf(fake.calls[0], "in")).toEqual([["id", [ART_ID]]]);

		const links = await repo.getPrimaryLinksForEntities(["ent-1"]);
		expect(links.get("ent-1")).toEqual([ART_ID]);
		expect(fake.filtersOf(fake.calls[1], "eq")).toEqual([["link_type", "primary"]]);

		const candidates = await repo.searchDocumentTitleCandidates(["cv"], 11);
		expect(candidates).toHaveLength(1);
		expect(rpcCall).toMatchObject({
			name: "document_title_candidates",
			params: { p_user_id: USER_ID, p_terms: ["cv"], p_limit: 11 },
		});
	});

	it("saveExtractedText updates extracted_content, plain_text, description, and processing_status scoped by id and ownerId (#1616)", async () => {
		const fake = createFakeSupabase(() => ({
			data: [{ id: ART_ID }],
			error: null,
		}));
		const repo = createSupabaseArtifactRepository({
			client: fake.client,
			ownerId: USER_ID,
		});

		await repo.saveExtractedText!(ART_ID, {
			extracted_content: "Extracted markdown",
			plain_text: "Extracted markdown",
			description: "A 1-2 sentence summary",
		});

		expect(fake.calls[0].op).toBe("update");
		expect(fake.calls[0].payload).toEqual({
			extracted_content: "Extracted markdown",
			plain_text: "Extracted markdown",
			description: "A 1-2 sentence summary",
			processing_status: "completed",
		});
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([
			["id", ART_ID],
			["user_id", USER_ID],
		]);

		const fakeMissing = createFakeSupabase(() => ({ data: [], error: null }));
		const repoMissing = createSupabaseArtifactRepository({
			client: fakeMissing.client,
			ownerId: USER_ID,
		});
		await expect(
			repoMissing.saveExtractedText!(ART_ID, {
				extracted_content: "text",
				plain_text: "text",
				description: null,
			}),
		).rejects.toThrow(`Artifact ${ART_ID} no longer exists: extraction discarded.`);
	});

	it("appendDocEditAudit appends entry to processing_metadata.docs_edit_audit when matching source_drive_file_id exists (#1521)", async () => {
		const fake = createFakeSupabase((call) => {
			if (call.op === "select") {
				return {
					data: [
						{
							id: ART_ID,
							processing_metadata: {
								existing_key: "kept",
								docs_edit_audit: [
									{
										timestamp: "2026-10-01T00:00:00.000Z",
										revision_before: "rev-0",
										revision_after: "rev-1",
										request_count: 2,
										suggest: false,
									},
								],
							},
						},
					],
					error: null,
				};
			}
			return { data: null, error: null };
		});
		const repo = createSupabaseArtifactRepository({
			client: fake.client,
			ownerId: USER_ID,
		});

		await repo.appendDocEditAudit!("doc-123", {
			timestamp: "2026-10-02T00:00:00.000Z",
			revision_before: "rev-1",
			revision_after: "rev-2",
			request_count: 3,
			suggest: true,
		});

		expect(fake.calls).toHaveLength(2);
		expect(fake.calls[0].op).toBe("select");
		expect(fake.calls[0].selected).toBe("id, processing_metadata");
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([
			["source_drive_file_id", "doc-123"],
		]);
		expect(fake.calls[1].op).toBe("update");
		expect(fake.calls[1].payload).toEqual({
			processing_metadata: {
				existing_key: "kept",
				docs_edit_audit: [
					{
						timestamp: "2026-10-01T00:00:00.000Z",
						revision_before: "rev-0",
						revision_after: "rev-1",
						request_count: 2,
						suggest: false,
					},
					{
						timestamp: "2026-10-02T00:00:00.000Z",
						revision_before: "rev-1",
						revision_after: "rev-2",
						request_count: 3,
						suggest: true,
					},
				],
			},
		});
		expect(fake.filtersOf(fake.calls[1], "eq")).toEqual([["id", ART_ID]]);
	});

	it("duplicateClusters calls document_duplicate_clusters RPC with defaults and propagates error codes (#1659)", async () => {
		const calls: Array<{ name: string; params: unknown }> = [];
		const fake = createFakeSupabase(() => ({ data: [], error: null }));
		(fake.client as any).rpc = (name: string, params: unknown) => {
			calls.push({ name, params });
			return Promise.resolve({
				data: [{ artifact_id: ART_ID, cluster_rank: 1, member_rank: 1 }],
				error: null,
			});
		};
		const repo = createSupabaseArtifactRepository({
			client: fake.client,
			ownerId: USER_ID,
		});

		const rows = await repo.duplicateClusters();
		expect(rows).toHaveLength(1);
		expect(calls[0]).toEqual({
			name: "document_duplicate_clusters",
			params: {
				p_user_id: USER_ID,
				p_query: null,
				p_connector: null,
				p_min_cluster: 2,
				p_limit: 20,
				p_include_archived: false,
			},
		});

		(fake.client as any).rpc = () =>
			Promise.resolve({
				data: null,
				error: { code: "57014", message: "statement timeout" },
			});
		await expect(repo.duplicateClusters({ query: "cv" })).rejects.toMatchObject({
			message: "statement timeout",
			code: "57014",
		});
	});

	it("listLinkedArtifactsForEntities joins artifact_entity_links to artifacts scoped by entityIds and userId", async () => {
		const fake = createFakeSupabase((call) => {
			if (call.table === "artifact_entity_links") {
				return {
					data: [
						{
							entity_id: "app-1",
							artifact_id: ART_ID,
							link_type: "related",
							confidence_score: 0.9,
							notes: "inbound email",
							artifacts: {
								id: ART_ID,
								title: "Re: Application",
								source: "gmail:msg-1",
								source_channel: "gmail",
								source_url: null,
								storage_url: null,
								file_type: "message/rfc822",
								captured_at: "2026-11-10T10:00:00.000Z",
								originated_at: "2026-11-10T09:55:00.000Z",
								created_at: "2026-11-10T10:00:00.000Z",
								archived: false,
								processing_metadata: { direction: "inbound" },
							},
						},
					],
					error: null,
				};
			}
			return { data: [], error: null };
		});

		const repo = createSupabaseArtifactRepository({
			client: fake.client,
			ownerId: USER_ID,
		});

		expect(await repo.listLinkedArtifactsForEntities!([])).toEqual([]);
		expect(fake.calls).toHaveLength(0);

		const linked = await repo.listLinkedArtifactsForEntities!(["app-1"]);
		expect(linked).toHaveLength(1);
		expect(linked[0]).toMatchObject({
			entity_id: "app-1",
			artifact_id: ART_ID,
			link_type: "related",
			artifact: {
				id: ART_ID,
				title: "Re: Application",
				source_channel: "gmail",
			},
		});
		expect(fake.filtersOf(fake.calls[0], "in")).toEqual([["entity_id", ["app-1"]]]);
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([["user_id", USER_ID]]);
	});
});



