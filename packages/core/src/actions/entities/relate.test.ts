import { describe, expect, it, vi } from "vitest";
import { executeAction } from "../adapters/direct.js";
import type { ActionContext } from "../types.js";
import {
	createEntityRelateAction,
	ENTITY_RELATE_DESCRIPTION,
	type EntityRelateRepository,
} from "./relate.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const FROM_ID = "11111111-1111-4111-8111-111111111111";
const TO_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const OLD_EDGE_ID = "44444444-4444-4444-8444-444444444444";

const baseCtx: ActionContext = {
	caller: "mcp",
	userId: USER_ID,
	requestId: "req-relate-test",
};

function makeRepo(overrides: Partial<EntityRelateRepository> = {}): EntityRelateRepository {
	return {
		findEntityEndpoints: vi.fn(async (ids) =>
			ids.map((id) => ({ id, entity_type: "person" })),
		),
		findLivePrimaryContainmentEdges: vi.fn(async () => []),
		findRelationshipEdge: vi.fn(async () => null),
		archiveEdge: vi.fn(async () => undefined),
		archiveEdgesByIds: vi.fn(async () => undefined),
		getRelationshipForSupersession: vi.fn(async () => null),
		updateRelationshipEdge: vi.fn(async () => undefined),
		insertRelationshipEdge: vi.fn(async () => ({ id: "edge-created-1" })),
		...overrides,
	};
}

describe("entity_relate core action (#1484)", () => {
	it("exposes exact contract metadata, annotations, default exposure, and schema keys", () => {
		const action = createEntityRelateAction(makeRepo());
		expect(action.id).toBe("entity_relate");
		expect(action.domain).toBe("kg");
		expect(action.description).toBe(ENTITY_RELATE_DESCRIPTION);
		expect(action.description).toContain("Full notes: docs/guides/tools/entity_relate.md");
		expect(action.expose).toEqual({
			mcp: true,
			http: true,
			cli: false,
			ui_agent: true,
			worker: true,
			a2a: false,
		});
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(Object.keys(action.schema.shape)).toEqual([
			"from_entity_id",
			"to_entity_id",
			"relationship_type",
			"confidence",
			"metadata",
			"notes",
			"valid_from",
			"valid_to",
			"clear_window",
			"archive",
			"overwrite",
			"supersedes_relationship_id",
			"relationships",
		]);
	});

	it("validates required inputs, self-edges, clear_window conflicts, and endpoint ownership", async () => {
		const repo = makeRepo();
		const action = createEntityRelateAction(repo);

		await expect(executeAction(action, {}, { context: baseCtx })).rejects.toThrow(
			/provide from_entity_id, to_entity_id, and relationship_type, or a non-empty relationships array/,
		);
		await expect(
			executeAction(
				action,
				{ from_entity_id: FROM_ID, to_entity_id: FROM_ID, relationship_type: "knows" },
				{ context: baseCtx },
			),
		).rejects.toThrow(/no self-edges/);
		await expect(
			executeAction(
				action,
				{
					from_entity_id: FROM_ID,
					to_entity_id: TO_ID,
					relationship_type: "knows",
					clear_window: true,
					valid_from: "2026-01-01T00:00:00Z",
				},
				{ context: baseCtx },
			),
		).rejects.toThrow(/clear_window cannot be combined/);

		const missingEndpointAction = createEntityRelateAction(
			makeRepo({ findEntityEndpoints: vi.fn(async () => [{ id: FROM_ID, entity_type: "person" }]) }),
		);
		await expect(
			executeAction(
				missingEndpointAction,
				{ from_entity_id: FROM_ID, to_entity_id: TO_ID, relationship_type: "knows" },
				{ context: baseCtx },
			),
		).rejects.toThrow(/Both entities must exist and belong to you/);
	});

	it("creates a normalised edge scoped to ctx.userId and formats MCP text", async () => {
		const repo = makeRepo();
		const action = createEntityRelateAction(repo);

		const res = await executeAction(
			action,
			{
				from_entity_id: FROM_ID,
				to_entity_id: TO_ID,
				relationship_type: "sister",
				confidence: 85,
				metadata: { context: "family" },
				notes: "older",
			},
			{ context: baseCtx },
		);

		expect(repo.findEntityEndpoints).toHaveBeenCalledWith([FROM_ID, TO_ID], USER_ID);
		expect(repo.insertRelationshipEdge).toHaveBeenCalledWith(
			{
				from_entity_id: FROM_ID,
				to_entity_id: TO_ID,
				relationship_type: "siblingOf",
				confidence_score: 0.85,
				metadata: { context: "family" },
				created_by: "mcp",
				notes: "older",
				valid_from: null,
				valid_to: null,
			},
			USER_ID,
		);
		expect(action.formatMcp!(res)).toBe(
			`Created edge edge-created-1: ${FROM_ID} -[siblingOf]-> ${TO_ID}. (normalised from "sister")`,
		);
	});

	it("preserves omitted fields on update, merges metadata, resurrects archived edges, and enforces ADR-035 collision-at-2", async () => {
		const existing = {
			id: "edge-existing-1",
			archived: true,
			valid_from: "2024-01-01T00:00:00Z",
			valid_to: "2025-01-01T00:00:00Z",
			confidence_score: 80,
			metadata: { keep: "yes", drop: "old" },
			notes: "initial | girlfriend",
		};
		const repo = makeRepo({ findRelationshipEdge: vi.fn(async () => existing) });
		const action = createEntityRelateAction(repo);

		await expect(
			executeAction(
				action,
				{
					from_entity_id: FROM_ID,
					to_entity_id: TO_ID,
					relationship_type: "lifePartnerOf",
					valid_from: "2026-01-01T00:00:00Z",
					valid_to: "2027-01-01T00:00:00Z",
				},
				{ context: baseCtx },
			),
		).rejects.toThrow(/collision-at-2/);

		const res = await executeAction(
			action,
			{
				from_entity_id: FROM_ID,
				to_entity_id: TO_ID,
				relationship_type: "lifePartnerOf",
				metadata: { drop: null, added: 1 },
			},
			{ context: baseCtx },
		);

		expect(repo.updateRelationshipEdge).toHaveBeenCalledWith(
			"edge-existing-1",
			{
				confidence_score: 0.8,
				metadata: { keep: "yes", added: 1 },
				notes: "initial | girlfriend",
				valid_from: "2024-01-01T00:00:00Z",
				valid_to: "2025-01-01T00:00:00Z",
				archived: false,
			},
			USER_ID,
		);
		expect(res.text).toBe(
			`Updated edge edge-existing-1: ${FROM_ID} -[lifePartnerOf]-> ${TO_ID}. (un-archived)`,
		);
	});

	it("handles archive with legacy raw-type fallback, PARA re-pointing, supersession, and batch mode", async () => {
		const archiveRepo = makeRepo({
			findRelationshipEdge: vi.fn(async (_from, _to, relType) =>
				relType === "fiancee_of" ? { id: "edge-legacy-1", archived: false } : null,
			),
		});
		const archiveAction = createEntityRelateAction(archiveRepo);
		const archivedRes = await executeAction(
			archiveAction,
			{
				from_entity_id: FROM_ID,
				to_entity_id: TO_ID,
				relationship_type: "fiancee_of",
				archive: true,
			},
			{ context: baseCtx },
		);
		expect(archiveRepo.archiveEdge).toHaveBeenCalledWith("edge-legacy-1", USER_ID);
		expect(archivedRes.text).toContain('matched the stored legacy type "fiancee_of"');

		const paraRepo = makeRepo({
			findEntityEndpoints: vi.fn(async () => [
				{ id: FROM_ID, entity_type: "project" },
				{ id: TO_ID, entity_type: "area" },
				{ id: OTHER_ID, entity_type: "area" },
			]),
			findLivePrimaryContainmentEdges: vi.fn(async () => [
				{ id: "edge-old-primary", to_entity_id: OTHER_ID },
			]),
			getRelationshipForSupersession: vi.fn(async () => ({
				id: OLD_EDGE_ID,
				user_id: USER_ID,
				valid_from: "2025-01-01T00:00:00Z",
				valid_to: null,
				metadata: { prior: true },
			})),
		});
		const paraAction = createEntityRelateAction(paraRepo);
		await expect(
			executeAction(
				paraAction,
				{ from_entity_id: FROM_ID, to_entity_id: TO_ID, relationship_type: "belongs_to" },
				{ context: baseCtx },
			),
		).rejects.toThrow(/2nd primary containment parent/);

		const batchRes = await executeAction(
			paraAction,
			{
				relationships: [
					{
						from_entity_id: FROM_ID,
						to_entity_id: TO_ID,
						relationship_type: "belongs_to",
						overwrite: true,
						valid_from: "2026-02-01T00:00:00Z",
						supersedes_relationship_id: OLD_EDGE_ID,
					},
				],
			},
			{ context: baseCtx },
		);
		expect(paraRepo.archiveEdgesByIds).toHaveBeenCalledWith(["edge-old-primary"], USER_ID);
		expect(paraRepo.updateRelationshipEdge).toHaveBeenCalledWith(
			OLD_EDGE_ID,
			{
				valid_to: "2026-02-01T00:00:00Z",
				metadata: { prior: true, superseded_by_relationship_id: "edge-created-1" },
			},
			USER_ID,
		);
		expect(batchRes.text).toContain("Processed 1 relationship(s):\n\u2022 Created edge edge-created-1");
	});
});
