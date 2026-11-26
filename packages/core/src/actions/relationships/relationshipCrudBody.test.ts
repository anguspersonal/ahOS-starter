import { describe, expect, it, vi } from "vitest";
import type { EntityRepository } from "../../ports/entities.js";
import type { RelationshipRecord } from "../domain/relationships.js";
import { createCoreRelationshipsPort } from "./port.js";
import { relationshipCrudCore } from "./relationshipCrudBody.js";

const NODE_A = "11111111-aaaa-4111-8111-111111111111";
const NODE_B = "22222222-bbbb-4222-8222-222222222222";
const EDGE_ID = "33333333-cccc-4333-8333-333333333333";

function makeFakeEntityRepo(overrides: Partial<EntityRepository> = {}): EntityRepository {
	return {
		getById: vi.fn(),
		loadRows: vi.fn(),
		insert: vi.fn(),
		update: vi.fn(),
		mutateByIds: vi.fn(),
		getDomainRow: vi.fn(),
		fetchPrimaryParentId: vi.fn(),
		fetchPrimaryParentsBatch: vi.fn(),
		getEdgeById: vi.fn(),
		findOwnedEntityIds: vi.fn(),
		insertArrangementNodes: vi.fn(),
		insertParticipantEdges: vi.fn(),
		insertProvenanceLinks: vi.fn(),
		archiveEdge: vi.fn(),
		findTrackedResources: vi.fn(),
		getTitleById: vi.fn(),
		getRelationship: vi.fn().mockResolvedValue(null),
		queryRelationships: vi.fn().mockResolvedValue([]),
		insertRelationship: vi.fn(async (row) => ({ ...row })),
		updateRelationship: vi.fn().mockResolvedValue(null),
		deleteRelationships: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

describe("relationshipCrudCore", () => {
	it("create with role: 'parent' swaps endpoints and defaults type to 'contains'; no role/type uses 'relates_to'; equal endpoints reject before any repository call", async () => {
		const uuidSpy = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(EDGE_ID);
		const repo = makeFakeEntityRepo();

		try {
			const parentResult = await relationshipCrudCore(
				repo,
				{
					operation: "create",
					from_entity_id: NODE_A,
					to_entity_id: NODE_B,
					role: "parent",
				},
				{ userId: "user-1" },
			);

			expect(repo.insertRelationship).toHaveBeenCalledWith(
				{
					id: EDGE_ID,
					from_entity_id: NODE_B,
					to_entity_id: NODE_A,
					relationship_type: "contains",
					confidence_score: 1.0,
					metadata: {},
				},
				"user-1",
			);
			expect(parentResult.success).toBe(true);
			expect(parentResult.relationship).toMatchObject({
				id: EDGE_ID,
				from_entity_id: NODE_B,
				to_entity_id: NODE_A,
				relationship_type: "contains",
			});

			const defaultResult = await relationshipCrudCore(
				repo,
				{
					operation: "create",
					from_entity_id: NODE_A,
					to_entity_id: NODE_B,
				},
				{ userId: "user-1" },
			);

			expect(defaultResult.relationship?.relationship_type).toBe("relates_to");

			const freshRepo = makeFakeEntityRepo();
			await expect(
				relationshipCrudCore(freshRepo, {
					operation: "create",
					from_entity_id: NODE_A,
					to_entity_id: NODE_A,
				}),
			).rejects.toThrow("Cannot create self-referencing relationship: from and to IDs must differ");
			expect(freshRepo.insertRelationship).not.toHaveBeenCalled();
		} finally {
			uuidSpy.mockRestore();
		}
	});

	it("query with direction: 'both' queries either endpoint with default limit 50", async () => {
		const rows: RelationshipRecord[] = [
			{
				id: EDGE_ID,
				from_entity_id: NODE_A,
				to_entity_id: NODE_B,
				relationship_type: "relates_to",
				created_at: "2026-01-02T00:00:00Z",
			},
		];
		const repo = makeFakeEntityRepo({
			queryRelationships: vi.fn().mockResolvedValue(rows),
		});

		const result = await relationshipCrudCore(
			repo,
			{
				operation: "query",
				filter: {
					entity_id: NODE_A,
					direction: "both",
				},
			},
			{ userId: "user-1" },
		);

		expect(repo.queryRelationships).toHaveBeenCalledWith(
			{
				entity_id: NODE_A,
				direction: "both",
				relationship_type: undefined,
				limit: 50,
			},
			"user-1",
		);
		expect(result).toEqual({
			success: true,
			operation: "query",
			count: 1,
			relationships: rows,
			message: "Found 1 relationships",
		});
	});

	it("delete without id or both endpoints rejects with dev's message; by endpoints passes optional type", async () => {
		const repo = makeFakeEntityRepo();

		await expect(
			relationshipCrudCore(repo, {
				operation: "delete",
				from_entity_id: NODE_A,
			}),
		).rejects.toThrow(
			"Must provide either 'id' or both 'from_entity_id' and 'to_entity_id' for 'delete' operation",
		);
		expect(repo.deleteRelationships).not.toHaveBeenCalled();

		const res = await relationshipCrudCore(
			repo,
			{
				operation: "delete",
				from_entity_id: NODE_A,
				to_entity_id: NODE_B,
				relationship_type: "contains",
			},
			{ userId: "user-1" },
		);

		expect(repo.deleteRelationships).toHaveBeenCalledWith(
			{
				from_entity_id: NODE_A,
				to_entity_id: NODE_B,
				relationship_type: "contains",
			},
			"user-1",
		);
		expect(res).toEqual({
			success: true,
			operation: "delete",
			id: undefined,
			deleted: true,
			message: "Deleted relationship edge successfully",
		});
	});

	it("with no user id, no repository method receives one", async () => {
		const record: RelationshipRecord = {
			id: EDGE_ID,
			from_entity_id: NODE_A,
			to_entity_id: NODE_B,
			relationship_type: "relates_to",
		};
		const repo = makeFakeEntityRepo({
			insertRelationship: vi.fn().mockResolvedValue(record),
			getRelationship: vi.fn().mockResolvedValue(record),
			queryRelationships: vi.fn().mockResolvedValue([record]),
			updateRelationship: vi.fn().mockResolvedValue(record),
			deleteRelationships: vi.fn().mockResolvedValue(undefined),
		});

		await relationshipCrudCore(repo, {
			operation: "create",
			id: EDGE_ID,
			from_entity_id: NODE_A,
			to_entity_id: NODE_B,
		});
		await relationshipCrudCore(repo, { operation: "get", id: EDGE_ID });
		await relationshipCrudCore(repo, { operation: "query" });
		await relationshipCrudCore(repo, {
			operation: "update",
			id: EDGE_ID,
			confidence_score: 0.8,
		});
		await relationshipCrudCore(repo, { operation: "delete", id: EDGE_ID });

		for (const mockFn of [
			repo.insertRelationship,
			repo.getRelationship,
			repo.queryRelationships,
			repo.updateRelationship,
			repo.deleteRelationships,
		]) {
			const call = (mockFn as ReturnType<typeof vi.fn>).mock.calls[0];
			expect(call).toHaveLength(mockFn === repo.updateRelationship ? 2 : 1);
			expect(call[mockFn === repo.updateRelationship ? 2 : 1]).toBeUndefined();
		}
	});

	it("createCoreRelationshipsPort delegates relationshipCrud to relationshipCrudCore", async () => {
		const record: RelationshipRecord = {
			id: EDGE_ID,
			from_entity_id: NODE_A,
			to_entity_id: NODE_B,
			relationship_type: "contains",
		};
		const repo = makeFakeEntityRepo({
			getRelationship: vi.fn().mockResolvedValue(record),
		});
		const port = createCoreRelationshipsPort({ entities: repo });

		const result = await port.relationshipCrud({ operation: "get", id: EDGE_ID }, { userId: "u1" });
		expect(result.success).toBe(true);
		expect(result.relationship).toEqual(record);
		expect(repo.getRelationship).toHaveBeenCalledWith(EDGE_ID, "u1");
	});
});
