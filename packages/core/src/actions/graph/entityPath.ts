import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import { isGraphEdgeValidAt, type GraphEdgePort, type GraphEntityNode } from "../../ports/graph.js";

const FRONTIER_CAP = 500;

export const entityPathInputSchema = z.object({
	start_entity_id: z.string().uuid(),
	target_entity_id: z.string().uuid(),
	max_hops: z.number().int().min(1).max(4).optional().default(3),
	edge_types: z.array(z.string().min(1)).optional(),
	include_archived_edges: z.boolean().optional().default(false),
	via_artifacts: z.boolean().optional().default(false),
	as_of: z.string().datetime().optional(),
	max_paths: z.number().int().min(1).max(20).optional().default(5),
});

export type EntityPathInput = z.infer<typeof entityPathInputSchema>;

export const entityPathStepSchema = z.object({
	from: z.string(),
	to: z.string(),
	type: z.string(),
	direction: z.enum(["out", "in"]),
});

export type EntityPathStep = z.infer<typeof entityPathStepSchema>;

export const entityPathOutputSchema = z.object({
	connected: z.boolean(),
	hops: z.number().int().nullable(),
	paths: z.array(z.array(entityPathStepSchema)),
	entities: z.array(
		z.object({
			id: z.string(),
			title: z.string(),
			entity_type: z.string(),
		}),
	),
	truncated: z.boolean(),
	explored: z.number().int(),
});

export type EntityPathOutput = z.infer<typeof entityPathOutputSchema>;

export interface EntityPathDependencies {
	port: GraphEdgePort;
	getUserId?: () => string | undefined;
}

function resolvePort(deps: GraphEdgePort | EntityPathDependencies): {
	port: GraphEdgePort;
	getUserId?: () => string | undefined;
} {
	if ("listEdges" in deps) {
		return { port: deps };
	}
	return deps;
}

export async function executeEntityPath(
	rawInput: z.input<typeof entityPathInputSchema>,
	context: ActionContext,
	deps: GraphEdgePort | EntityPathDependencies,
): Promise<EntityPathOutput> {
	const input = entityPathInputSchema.parse(rawInput);
	const { port, getUserId } = resolvePort(deps);
	const userId = context.userId ?? getUserId?.() ?? "owner";

	const startId = input.start_entity_id;
	const targetId = input.target_entity_id;
	const maxHops = input.max_hops;
	const maxPaths = input.max_paths;
	const includeArchived = input.include_archived_edges;
	const edgeTypes = input.edge_types;
	const allowedTypes = edgeTypes && edgeTypes.length > 0 ? new Set(edgeTypes) : null;
	const asOf = input.as_of;

	if (startId === targetId) {
		const entities = (await port.getEntities?.({ userId, ids: [startId] })) ?? [
			{ id: startId, title: startId, entity_type: "unknown" },
		];
		return {
			connected: true,
			hops: 0,
			paths: [[]],
			entities,
			truncated: false,
			explored: 1,
		};
	}

	const depthByNode = new Map<string, number>([[startId, 0]]);
	const parentsByNode = new Map<string, EntityPathStep[]>();
	let frontier: string[] = [startId];
	let truncated = false;
	let reachedDepth: number | null = null;

	for (let depth = 1; depth <= maxHops; depth++) {
		if (frontier.length === 0) break;
		if (frontier.length > FRONTIER_CAP) {
			truncated = true;
			frontier = frontier.slice(0, FRONTIER_CAP);
		}

		const [outEdges, inEdges, artifactHops] = await Promise.all([
			port.listEdges({
				userId,
				frontier,
				direction: "out",
				edgeTypes,
				includeArchived,
				asOf,
			}),
			port.listEdges({
				userId,
				frontier,
				direction: "in",
				edgeTypes,
				includeArchived,
				asOf,
			}),
			input.via_artifacts ? port.listArtifactHops({ userId, frontier }) : Promise.resolve([]),
		]);

		const frontierSet = new Set(frontier);
		const nextFrontierSet = new Set<string>();
		const stepSeen = new Set<string>();

		const recordStep = (u: string, v: string, type: string, direction: "out" | "in") => {
			if (u === v) return;
			const existingDepth = depthByNode.get(v);
			if (existingDepth !== undefined && existingDepth < depth) {
				return;
			}
			if (existingDepth === undefined) {
				depthByNode.set(v, depth);
				nextFrontierSet.add(v);
			}
			const stepKey = `${u}|${v}|${type}|${direction}`;
			if (stepSeen.has(stepKey)) return;
			stepSeen.add(stepKey);
			const list = parentsByNode.get(v) ?? [];
			list.push({ from: u, to: v, type, direction });
			parentsByNode.set(v, list);
		};

		for (const edge of outEdges) {
			if (!includeArchived && edge.archived === true) continue;
			if (allowedTypes && !allowedTypes.has(edge.relationship_type)) continue;
			if (asOf && !isGraphEdgeValidAt(edge.valid_from, edge.valid_to, asOf)) continue;
			if (!frontierSet.has(edge.from_entity_id)) continue;
			recordStep(edge.from_entity_id, edge.to_entity_id, edge.relationship_type, "out");
		}

		for (const edge of inEdges) {
			if (!includeArchived && edge.archived === true) continue;
			if (allowedTypes && !allowedTypes.has(edge.relationship_type)) continue;
			if (asOf && !isGraphEdgeValidAt(edge.valid_from, edge.valid_to, asOf)) continue;
			if (!frontierSet.has(edge.to_entity_id)) continue;
			recordStep(edge.to_entity_id, edge.from_entity_id, edge.relationship_type, "in");
		}

		for (const hop of artifactHops) {
			if (!frontierSet.has(hop.from_entity_id)) continue;
			recordStep(hop.from_entity_id, hop.to_entity_id, hop.relationship_type || "co_mentioned", "out");
		}

		if (nextFrontierSet.size > FRONTIER_CAP) {
			truncated = true;
		}

		if (depthByNode.get(targetId) === depth) {
			reachedDepth = depth;
			break;
		}

		const nextArray = Array.from(nextFrontierSet);
		if (nextArray.length > FRONTIER_CAP) {
			truncated = true;
			frontier = nextArray.slice(0, FRONTIER_CAP);
		} else {
			frontier = nextArray;
		}
	}

	const explored = depthByNode.size;
	if (reachedDepth === null) {
		return {
			connected: false,
			hops: null,
			paths: [],
			entities: [],
			truncated,
			explored,
		};
	}

	const paths: EntityPathStep[][] = [];
	const buildPaths = (nodeId: string, suffix: EntityPathStep[]) => {
		if (paths.length >= maxPaths) return;
		if (nodeId === startId) {
			paths.push(suffix);
			return;
		}
		const incoming = parentsByNode.get(nodeId) ?? [];
		for (const step of incoming) {
			if (paths.length >= maxPaths) break;
			buildPaths(step.from, [step, ...suffix]);
		}
	};
	buildPaths(targetId, []);

	const pathEntityIds = new Set<string>();
	for (const p of paths) {
		for (const step of p) {
			pathEntityIds.add(step.from);
			pathEntityIds.add(step.to);
		}
	}

	const idList = Array.from(pathEntityIds);
	const fetched = (await port.getEntities?.({ userId, ids: idList })) ?? [];
	const fetchedById = new Map<string, GraphEntityNode>(fetched.map((e) => [e.id, e]));
	const entities: GraphEntityNode[] = idList.map(
		(id) => fetchedById.get(id) ?? { id, title: id, entity_type: "unknown" },
	);

	return {
		connected: true,
		hops: reachedDepth,
		paths,
		entities,
		truncated,
		explored,
	};
}

export function createEntityPathAction(
	deps: GraphEdgePort | EntityPathDependencies,
): ActionDefinition<typeof entityPathInputSchema, EntityPathOutput> {
	return defineAction<typeof entityPathInputSchema, EntityPathOutput>({
		id: "entity_path",
		name: "entity_path",
		description:
			"Find the shortest paths between two entities in the knowledge graph across both edge directions up to max_hops.",
		domain: "kg",
		schema: entityPathInputSchema,
		outputSchema: entityPathOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		async run(input, context) {
			return executeEntityPath(input, context, deps);
		},
	});
}
