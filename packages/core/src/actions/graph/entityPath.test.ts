import { describe, expect, it } from "vitest";
import type {
	GraphEdgePort,
	GraphEdgeRecord,
	GraphEntityNode,
	ListArtifactHopsInput,
	ListGraphEdgesInput,
} from "../../ports/graph.js";
import { createEntityPathAction } from "./entityPath.js";

function createInMemoryGraphPort(options: {
	edges?: GraphEdgeRecord[];
	artifactLinks?: Array<{ entity_id: string; artifact_id: string }>;
	entities?: GraphEntityNode[];
}): GraphEdgePort {
	const edges = options.edges ?? [];
	const links = options.artifactLinks ?? [];
	const entities = options.entities ?? [];

	return {
		async listEdges(input: ListGraphEdgesInput): Promise<GraphEdgeRecord[]> {
			const frontierSet = new Set(input.frontier);
			const allowed = input.edgeTypes && input.edgeTypes.length > 0 ? new Set(input.edgeTypes) : null;
			return edges.filter((e) => {
				if (!input.includeArchived && e.archived === true) return false;
				if (allowed && !allowed.has(e.relationship_type)) return false;
				return input.direction === "out"
					? frontierSet.has(e.from_entity_id)
					: frontierSet.has(e.to_entity_id);
			});
		},
		async listArtifactHops(input: ListArtifactHopsInput): Promise<GraphEdgeRecord[]> {
			const frontierSet = new Set(input.frontier);
			const hops: GraphEdgeRecord[] = [];
			for (const l1 of links) {
				if (!frontierSet.has(l1.entity_id)) continue;
				for (const l2 of links) {
					if (l1.artifact_id === l2.artifact_id && l1.entity_id !== l2.entity_id) {
						hops.push({
							from_entity_id: l1.entity_id,
							to_entity_id: l2.entity_id,
							relationship_type: "co_mentioned",
						});
					}
				}
			}
			return hops;
		},
		async getEntities({ ids }): Promise<GraphEntityNode[]> {
			const set = new Set(ids);
			return entities.filter((e) => set.has(e.id));
		},
	};
}

const UUID_A = "00000000-0000-4000-8000-000000000001";
const UUID_B = "00000000-0000-4000-8000-000000000002";
const UUID_C = "00000000-0000-4000-8000-000000000003";
const UUID_D = "00000000-0000-4000-8000-000000000004";
const UUID_E = "00000000-0000-4000-8000-000000000005";

describe("entity_path action", () => {
	it("case 1: A to B to C with B-C stored as C->B finds path with step 2 direction 'in'", async () => {
		const port = createInMemoryGraphPort({
			edges: [
				{ from_entity_id: UUID_A, to_entity_id: UUID_B, relationship_type: "knows" },
				{ from_entity_id: UUID_C, to_entity_id: UUID_B, relationship_type: "manages" },
			],
			entities: [
				{ id: UUID_A, title: "A", entity_type: "people" },
				{ id: UUID_B, title: "B", entity_type: "people" },
				{ id: UUID_C, title: "C", entity_type: "people" },
			],
		});
		const action = createEntityPathAction(port);
		const res = await action.run(
			{
				start_entity_id: UUID_A,
				target_entity_id: UUID_C,
				max_hops: 2,
				include_archived_edges: false,
				via_artifacts: false,
				max_paths: 5,
			},
			{ userId: "u1", caller: "mcp", requestId: "req-1" },
		);

		expect(res.connected).toBe(true);
		expect(res.hops).toBe(2);
		expect(res.paths).toEqual([
			[
				{ from: UUID_A, to: UUID_B, type: "knows", direction: "out" },
				{ from: UUID_B, to: UUID_C, type: "manages", direction: "in" },
			],
		]);
		expect(res.entities.map((e) => e.id).sort()).toEqual([UUID_A, UUID_B, UUID_C]);
	});

	it("case 2: two shortest paths of length 2 both come back; a length-3 path does not", async () => {
		const port = createInMemoryGraphPort({
			edges: [
				{ from_entity_id: UUID_A, to_entity_id: UUID_B, relationship_type: "r1" },
				{ from_entity_id: UUID_B, to_entity_id: UUID_C, relationship_type: "r2" },
				{ from_entity_id: UUID_A, to_entity_id: UUID_D, relationship_type: "r3" },
				{ from_entity_id: UUID_D, to_entity_id: UUID_C, relationship_type: "r4" },
				{ from_entity_id: UUID_A, to_entity_id: UUID_E, relationship_type: "r5" },
				{ from_entity_id: UUID_E, to_entity_id: UUID_B, relationship_type: "r6" },
			],
		});
		const action = createEntityPathAction(port);
		const res = await action.run(
			{
				start_entity_id: UUID_A,
				target_entity_id: UUID_C,
				max_hops: 3,
				include_archived_edges: false,
				via_artifacts: false,
				max_paths: 5,
			},
			{ userId: "u1", caller: "mcp", requestId: "req-1" },
		);

		expect(res.connected).toBe(true);
		expect(res.hops).toBe(2);
		expect(res.paths).toHaveLength(2);
		for (const p of res.paths) {
			expect(p).toHaveLength(2);
		}
	});

	it("case 3: no path within 3 hops returns connected: false, truncated: false, explored counted", async () => {
		const port = createInMemoryGraphPort({
			edges: [{ from_entity_id: UUID_A, to_entity_id: UUID_B, relationship_type: "knows" }],
		});
		const action = createEntityPathAction(port);
		const res = await action.run(
			{
				start_entity_id: UUID_A,
				target_entity_id: UUID_C,
				max_hops: 3,
				include_archived_edges: false,
				via_artifacts: false,
				max_paths: 5,
			},
			{ userId: "u1", caller: "mcp", requestId: "req-1" },
		);

		expect(res.connected).toBe(false);
		expect(res.hops).toBeNull();
		expect(res.paths).toEqual([]);
		expect(res.truncated).toBe(false);
		expect(res.explored).toBe(2);
	});

	it("case 4: a hub with 600 neighbours sets truncated: true", async () => {
		const edges: GraphEdgeRecord[] = [];
		for (let i = 1; i <= 600; i++) {
			const id = `00000000-0000-4000-8000-${String(i + 100).padStart(12, "0")}`;
			edges.push({ from_entity_id: UUID_A, to_entity_id: id, relationship_type: "rel" });
		}
		const port = createInMemoryGraphPort({ edges });
		const action = createEntityPathAction(port);
		const res = await action.run(
			{
				start_entity_id: UUID_A,
				target_entity_id: UUID_C,
				max_hops: 2,
				include_archived_edges: false,
				via_artifacts: false,
				max_paths: 5,
			},
			{ userId: "u1", caller: "mcp", requestId: "req-1" },
		);

		expect(res.connected).toBe(false);
		expect(res.truncated).toBe(true);
	});

	it("case 5: an archived edge is skipped unless include_archived_edges is true", async () => {
		const port = createInMemoryGraphPort({
			edges: [
				{
					from_entity_id: UUID_A,
					to_entity_id: UUID_B,
					relationship_type: "belongs_to",
					archived: true,
				},
			],
		});
		const action = createEntityPathAction(port);

		const skipped = await action.run(
			{
				start_entity_id: UUID_A,
				target_entity_id: UUID_B,
				max_hops: 2,
				include_archived_edges: false,
				via_artifacts: false,
				max_paths: 5,
			},
			{ userId: "u1", caller: "mcp", requestId: "req-1" },
		);
		expect(skipped.connected).toBe(false);

		const included = await action.run(
			{
				start_entity_id: UUID_A,
				target_entity_id: UUID_B,
				max_hops: 2,
				include_archived_edges: true,
				via_artifacts: false,
				max_paths: 5,
			},
			{ userId: "u1", caller: "mcp", requestId: "req-1" },
		);
		expect(included.connected).toBe(true);
		expect(included.hops).toBe(1);
	});

	it("case 6: via_artifacts: true connects two entities linked to the same artifact in one hop of type co_mentioned", async () => {
		const port = createInMemoryGraphPort({
			artifactLinks: [
				{ entity_id: UUID_A, artifact_id: "art-1" },
				{ entity_id: UUID_B, artifact_id: "art-1" },
			],
		});
		const action = createEntityPathAction(port);
		const res = await action.run(
			{
				start_entity_id: UUID_A,
				target_entity_id: UUID_B,
				max_hops: 2,
				include_archived_edges: false,
				via_artifacts: true,
				max_paths: 5,
			},
			{ userId: "u1", caller: "mcp", requestId: "req-1" },
		);

		expect(res.connected).toBe(true);
		expect(res.hops).toBe(1);
		expect(res.paths).toEqual([
			[{ from: UUID_A, to: UUID_B, type: "co_mentioned", direction: "out" }],
		]);
	});

	it("case 7: edge_types: ['belongs_to'] ignores other edges", async () => {
		const port = createInMemoryGraphPort({
			edges: [
				{ from_entity_id: UUID_A, to_entity_id: UUID_B, relationship_type: "associated_with" },
				{ from_entity_id: UUID_A, to_entity_id: UUID_C, relationship_type: "belongs_to" },
				{ from_entity_id: UUID_C, to_entity_id: UUID_B, relationship_type: "belongs_to" },
			],
		});
		const action = createEntityPathAction(port);
		const res = await action.run(
			{
				start_entity_id: UUID_A,
				target_entity_id: UUID_B,
				max_hops: 3,
				edge_types: ["belongs_to"],
				include_archived_edges: false,
				via_artifacts: false,
				max_paths: 5,
			},
			{ userId: "u1", caller: "mcp", requestId: "req-1" },
		);

		expect(res.connected).toBe(true);
		expect(res.hops).toBe(2);
		expect(res.paths).toEqual([
			[
				{ from: UUID_A, to: UUID_C, type: "belongs_to", direction: "out" },
				{ from: UUID_C, to: UUID_B, type: "belongs_to", direction: "out" },
			],
		]);
	});
});
