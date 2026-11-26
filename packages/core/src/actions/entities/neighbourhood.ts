import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { ENTITY_TYPES } from "../domain/entities.js";
import type {
	GraphEdgeRow as EdgeRow,
	GraphEntityRow as EntityRow,
	GraphReadPort,
	GraphTraversedEdge as NeighbourhoodEdge,
} from "../../ports/graphRead.js";

const entityType = z.enum(ENTITY_TYPES);

export const ENTITY_NEIGHBOURHOOD_DESCRIPTION =
	"Read the local knowledge graph around one or more entities: resolve a starting set (by id, PARAMPS type, title substring, or properties match), traverse entity\u2194entity edges up to 2 hops, and return nodes, edges, and per-entity artifact provenance (interactions). This is the closest thing to a 'graph view' read. Use to show what's connected to a person/topic.";

export const entityNeighbourhoodInput = {
	entity_id: z
		.string()
		.uuid()
		.optional()
		.describe(
			"Start from one specific entity. If omitted, the filters below select the starting set.",
		),
	entity_type: entityType
		.optional()
		.describe("Filter the starting set by PARAMPS type, e.g. 'people'."),
	title_contains: z
		.string()
		.optional()
		.describe("Case-insensitive substring filter on starting entities' titles."),
	properties_match: z
		.record(z.string(), z.unknown())
		.optional()
		.describe(
			"jsonb containment filter on properties, e.g. { profession: 'marketing' } returns people whose properties contain that key/value.",
		),
	edge_types: z
		.array(z.string().min(1))
		.optional()
		.describe(
			"Restrict entity\u2194entity edges to these types (ADR-021 vocabulary terms like 'parentOf'/'colleagueOf' or legacy edge types like 'works_with'; matched by equality against stored values). " +
				"PARA roll-ups/counting (#170): pass ['belongs_to'] to traverse PRIMARY containment only \u2014 'associated_with' is the secondary, NON-COUNTED containment edge and MUST be excluded from any roll-up or count (\"show everything under Business\" follows belongs_to exclusively; each edge's type field flags which kind it is).",
		),
	hops: z
		.number()
		.int()
		.min(1)
		.max(2)
		.optional()
		.describe("Traversal depth over entity\u2194entity edges (default 1, max 2)."),
	include_archived_edges: z
		.boolean()
		.optional()
		.describe("Include archived (soft-deleted) relationships in traversal. Defaults to false."),
	include_instance_of: z
		.boolean()
		.optional()
		.describe(
			"ADR-036 \u00a72: opt in to also traverse the virtual 'instance_of' edge from each " +
				"frontier entity to its vocabulary term-node -- the registry row grounding its " +
				"entity_type (e.g. an entity_type='people' row -> the term-node for 'people'). " +
				"Derived from entities.entity_type at query time via the graph_instance_of view; " +
				"never written per-instance. Default false -- ordinary neighbourhood queries stay " +
				"clean and cheap. Only this first hop (instance -> term-node) is virtual: once " +
				"reached, the term-node's own real edges (its exactMatch, a governed_by principle) " +
				"traverse normally on subsequent hops, giving 'walk from this row to its type, then " +
				"to the type's governing principle' in one query. Forward direction only -- an " +
				"entity's own type, never the reverse fan-out of every other instance sharing it.",
		),
	as_of: z
		.string()
		.datetime()
		.optional()
		.describe(
			"ISO 8601 instant. When present, restrict traversal to edges valid at that moment " +
				"(valid_from <= as_of AND (valid_to IS NULL OR valid_to > as_of); NULL bounds are " +
				"open-ended/unbounded), e.g. 'who was my gas supplier in 2026?'. Omit to return all " +
				"edges regardless of their validity window (current behaviour, unchanged) \u2014 as_of is " +
				"purely opt-in.",
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("Max starting entities (default 25)."),
	node_properties: z
		.boolean()
		.optional()
		.describe(
			"Also return every reached node's full `properties` in `nodes` (default false; starting entities always carry theirs). " +
				"Use when a read has to sort or filter what the traversal reached by its properties, e.g. arrangements by `kind`. " +
				"Every node carries `archived` either way: a live edge can still reach an archived entity, and the caller decides whether to drop it.",
		),
	exclude_properties: z
		.array(z.string().min(1))
		.optional()
		.describe(
			"Property keys to omit from returned properties objects on nodes and starting entities (e.g. ['sources', 'notes']).",
		),
	include_source_notes: z
		.boolean()
		.optional()
		.describe(
			"When node_properties is true, include internal 'sources' and 'notes' properties (default false). " +
				"These verbose provenance and editorial fields are excluded by default to keep graph traversal payloads within chat context budgets (#1248).",
		),
	property_keys: z
		.array(z.string().min(1))
		.optional()
		.describe(
			"When node_properties is true, whitelist only these specific keys in returned properties. If omitted, all properties (except excluded ones) are included.",
		),
	include_entity_edges: z
		.boolean()
		.optional()
		.describe(
			"Include the 'edges' array on each starting entity in 'entities' (default true). " +
				"Set to false to omit 'edges' on starting entities and avoid repeating edges when 'result.edges' already contains all traversed edges (#1248).",
		),
};

export const entityNeighbourhoodSchema = z.object(entityNeighbourhoodInput);

export interface EntityNeighbourhoodResult {
	matched: number;
	hops: number;
	as_of: string | null;
	entities: Array<Record<string, unknown>>;
	nodes: Array<Record<string, unknown>>;
	edges: Array<NeighbourhoodEdge & { notes?: string | null }>;
}

/**
 * Issue #315: does an edge's [valid_from, valid_to) validity window cover the
 * instant `asOf`? NULL bounds are open-ended - a null `valid_from` means the
 * start is unknown/unbounded (always satisfied), a null `valid_to` means the
 * edge is still active (always satisfied on the upper end). Exported as a
 * pure function so the boundary logic (incl. NULL-bound open-endedness) is
 * unit-testable without mocking Supabase.
 */
export function isEdgeValidAt(
	validFrom: string | null,
	validTo: string | null,
	asOf: string,
): boolean {
	const asOfMs = new Date(asOf).getTime();
	if (validFrom !== null && new Date(validFrom).getTime() > asOfMs) return false;
	if (validTo !== null && new Date(validTo).getTime() <= asOfMs) return false;
	return true;
}

/**
 * Filter node or entity properties according to projection options (#1248).
 * By default, verbose internal properties ('sources' and 'notes') are excluded from
 * reached nodes when node_properties is true unless include_source_notes is true.
 * Starting entities also omit them when include_source_notes is false or exclude_properties names them.
 */
export function filterProperties(
	props: Record<string, unknown> | null | undefined,
	options: {
		propertyKeys?: string[];
		excludeProperties?: string[];
		includeSourceNotes?: boolean;
		isStartingEntity?: boolean;
	},
): Record<string, unknown> {
	if (!props || typeof props !== "object") return {};
	const { propertyKeys, excludeProperties, includeSourceNotes, isStartingEntity } = options;
	const excludeSet = new Set(excludeProperties ?? []);
	const shouldOmitSourceNotes =
		includeSourceNotes === false || (!isStartingEntity && includeSourceNotes !== true);
	if (shouldOmitSourceNotes) {
		excludeSet.add("sources");
		excludeSet.add("notes");
	}
	const keyFilter = propertyKeys && propertyKeys.length > 0 ? new Set(propertyKeys) : null;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(props)) {
		if (keyFilter && !keyFilter.has(k)) continue;
		if (excludeSet.has(k)) continue;
		out[k] = v;
	}
	return out;
}

async function runEntityNeighbourhood(
	port: GraphReadPort,
	args: z.infer<typeof entityNeighbourhoodSchema>,
	userId: string,
): Promise<EntityNeighbourhoodResult> {
	const hops = args.hops ?? 1;
	const limit = args.limit ?? 25;

	// 1. Resolve the starting set.
	let starting: EntityRow[];
	if (args.entity_id) {
		const data = await port.getStartingEntityById(args.entity_id, userId);
		starting = data ? [data] : [];
	} else {
		starting = await port.queryStartingEntities(
			{
				entity_type: args.entity_type,
				title_contains: args.title_contains,
				properties_match: args.properties_match,
				limit,
			},
			userId,
		);
	}

	if (starting.length === 0) {
		return {
			matched: 0,
			hops,
			as_of: args.as_of ?? null,
			entities: [],
			nodes: [],
			edges: [],
		};
	}

	const startIds = starting.map((e) => e.id);

	// 2. BFS over entity<->entity edges up to `hops`. Two queries per hop
	//    (out + in) rather than a `.or()` so UUID-laden filters parse cleanly.
	const allNodeIds = new Set<string>(startIds);
	const edges: Array<NeighbourhoodEdge & { notes?: string | null }> = [];
	const seenEdge = new Set<string>();
	const allowed = args.edge_types ? new Set<string>(args.edge_types) : null;
	const includeArchivedEdges = args.include_archived_edges ?? false;
	const includeInstanceOf = args.include_instance_of ?? false;
	const asOf = args.as_of;
	const edgeOptions = {
		includeArchivedEdges,
		edgeTypes: allowed,
		asOf,
	};
	let frontier = startIds;
	for (let h = 0; h < hops; h++) {
		if (frontier.length === 0) break;
		// ADR-036 §2: the virtual instance_of hop, forward only (instance ->
		// its term-node), so it never fans out to every other instance of the
		// same type. Queried alongside the real edges, not filtered by
		// `allowed` -- opting in via include_instance_of is itself the ask.
		const [out, inc, instanceOf] = await Promise.all([
			port.getOutEdges(frontier, userId, edgeOptions),
			port.getInEdges(frontier, userId, edgeOptions),
			includeInstanceOf
				? port.getInstanceOfEdges(frontier, userId)
				: Promise.resolve([] as EdgeRow[]),
		]);
		const next: string[] = [];
		const addRow = (r: EdgeRow, { checkAllowed }: { checkAllowed: boolean }) => {
			if (checkAllowed && allowed && !allowed.has(r.relationship_type)) return;
			if (asOf && !isEdgeValidAt(r.valid_from, r.valid_to, asOf)) return;
			const key = `${r.from_entity_id}|${r.to_entity_id}|${r.relationship_type}`;
			if (seenEdge.has(key)) return;
			seenEdge.add(key);
			edges.push({
				from: r.from_entity_id,
				to: r.to_entity_id,
				type: r.relationship_type,
				confidence: r.confidence_score,
				metadata: r.metadata as Record<string, unknown> | null,
				notes: r.notes ?? null,
				valid_from: r.valid_from,
				valid_to: r.valid_to,
			});
			for (const nid of [r.from_entity_id, r.to_entity_id]) {
				if (!allNodeIds.has(nid)) {
					allNodeIds.add(nid);
					next.push(nid);
				}
			}
		};
		for (const r of [...out, ...inc]) {
			addRow(r, { checkAllowed: true });
		}
		for (const r of instanceOf) {
			addRow(r, { checkAllowed: false });
		}
		frontier = next;
	}

	// 3. Details for every node reached. No `archived` filter: archiving an
	//    entity leaves its edges live, so an archived node can still be reached,
	//    and hiding it here would leave edges pointing at nothing. It is flagged
	//    in `nodes` instead (#1234: a rejected ledger entry must be droppable).
	const nodeData = await port.getNodesByIds(Array.from(allNodeIds), userId);
	const nodeMap = new Map<string, EntityRow>(nodeData.map((n) => [n.id, n]));

	// 4. Provenance: artifact links for the STARTING entities (= interactions).
	const links = await port.getArtifactLinks(startIds, userId);
	const artifactIds = Array.from(new Set(links.map((l) => l.artifact_id)));
	const artMap = new Map<string, { title: string | null; created_at: string }>();
	if (artifactIds.length > 0) {
		const artData = await port.getArtifactsByIds(artifactIds, userId);
		for (const a of artData) {
			artMap.set(a.id, { title: a.title, created_at: a.created_at });
		}
	}

	// 5. Assemble one record per starting entity with its edges + interactions.
	//    Scores/rankings are deliberately NOT computed here -- the agent derives
	//    them at query time from these raw materials (counts, dates, edges).
	// ADR-084: resolve each starting entity's domain (not the wider frontier --
	// the starting set is what a caller asked about; resolving every reached
	// node would add an unbounded number of resolver calls for a 2-hop query).
	const domainById = await port.resolveDomains(startIds, userId);
	const entities = starting.map((e) => {
		const interactions = links
			.filter((l) => l.entity_id === e.id)
			.map((l) => ({
				artifact_id: l.artifact_id,
				title: artMap.get(l.artifact_id)?.title ?? null,
				date: artMap.get(l.artifact_id)?.created_at ?? null,
				link_type: l.link_type,
			}))
			.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
		const entityEdges = edges
			.filter((ed) => ed.from === e.id || ed.to === e.id)
			.map((ed) => {
				const otherId = ed.from === e.id ? ed.to : ed.from;
				return {
					type: ed.type,
					direction: ed.from === e.id ? "out" : "in",
					other_id: otherId,
					other_title: nodeMap.get(otherId)?.title ?? null,
					other_type: nodeMap.get(otherId)?.entity_type ?? null,
					confidence: ed.confidence,
					metadata: ed.metadata,
					notes: ed.notes ?? null,
					valid_from: ed.valid_from,
					valid_to: ed.valid_to,
				};
			});
		const includeEntityEdges = args.include_entity_edges ?? true;
		const resolution = domainById.get(e.id);
		const entRecord: Record<string, unknown> = {
			id: e.id,
			type: e.entity_type,
			title: e.title,
			properties: filterProperties(e.properties, {
				propertyKeys: args.property_keys,
				excludeProperties: args.exclude_properties,
				includeSourceNotes: args.include_source_notes,
				isStartingEntity: true,
			}),
			domain: resolution?.domain ?? null,
			domain_resolution: resolution
				? { resolved_by: resolution.resolved_by, path: resolution.path }
				: null,
			interaction_count: interactions.length,
			last_interaction: interactions[0]?.date ?? null,
			interactions,
		};
		if (includeEntityEdges) {
			entRecord.edges = entityEdges;
		}
		return entRecord;
	});

	return {
		matched: entities.length,
		hops,
		as_of: asOf ?? null,
		entities,
		// All reached nodes (incl. 2nd-degree when hops=2) + the full edge list,
		// so the agent can also see indirect connections.
		// `properties` only on request (node_properties): a 2-hop read can reach
		// many nodes, and most callers only need ids and titles.
		nodes: Array.from(nodeMap.values()).map((n) => {
			const node: Record<string, unknown> = {
				id: n.id,
				type: n.entity_type,
				title: n.title,
				archived: n.archived === true,
			};
			if (args.node_properties) {
				node.properties = filterProperties(n.properties, {
					propertyKeys: args.property_keys,
					excludeProperties: args.exclude_properties,
					includeSourceNotes: args.include_source_notes,
					isStartingEntity: false,
				});
			}
			return node;
		}),
		edges,
	};
}

export function formatEntityNeighbourhoodMcp(result: EntityNeighbourhoodResult): string {
	if (result.matched === 0) {
		return "No matching entities.";
	}
	return `Neighbourhood (${result.entities.length} starting entit${
		result.entities.length === 1 ? "y" : "ies"
	}, ${result.hops} hop${result.hops === 1 ? "" : "s"}):\n${JSON.stringify(result, null, 2)}`;
}

export function createEntityNeighbourhoodAction(
	port: GraphReadPort,
): ActionDefinition<typeof entityNeighbourhoodSchema, EntityNeighbourhoodResult> {
	return defineAction({
		id: "entity_neighbourhood",
		description: ENTITY_NEIGHBOURHOOD_DESCRIPTION,
		domain: "kg",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		schema: entityNeighbourhoodSchema,
		formatMcp: formatEntityNeighbourhoodMcp,
		run: async (args, ctx) => {
			if (!ctx.userId) {
				throw new Error("Missing userId in ActionContext");
			}
			return runEntityNeighbourhood(port, args, ctx.userId);
		},
	});
}
