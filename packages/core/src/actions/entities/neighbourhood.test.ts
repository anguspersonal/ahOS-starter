import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ActionContext } from "../types.js";
import type { GraphReadPort } from "../../ports/graphRead.js";
import {
	createEntityNeighbourhoodAction,
	ENTITY_NEIGHBOURHOOD_DESCRIPTION,
	filterProperties,
	isEdgeValidAt,
} from "./neighbourhood.js";

const UUID_PATTERN =
	"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$";

const LEGACY_JSON_SCHEMA_SNAPSHOT = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {
		entity_id: {
			description: "Start from one specific entity. If omitted, the filters below select the starting set.",
			type: "string",
			format: "uuid",
			pattern: UUID_PATTERN,
		},
		entity_type: {
			description: "Filter the starting set by PARAMPS type, e.g. 'people'.",
			type: "string",
			enum: [
				"project",
				"area",
				"resource",
				"people",
				"event",
				"organization",
				"signal",
				"place",
				"concept",
				"capability",
				"domain",
				"arrangement",
				"term",
				"decision",
			],
		},
		title_contains: {
			description: "Case-insensitive substring filter on starting entities' titles.",
			type: "string",
		},
		properties_match: {
			description:
				"jsonb containment filter on properties, e.g. { profession: 'marketing' } returns people whose properties contain that key/value.",
			type: "object",
			propertyNames: { type: "string" },
			additionalProperties: {},
		},
		edge_types: {
			description:
				"Restrict entity\u2194entity edges to these types (ADR-021 vocabulary terms like 'parentOf'/'colleagueOf' or legacy edge types like 'works_with'; matched by equality against stored values). PARA roll-ups/counting (#170): pass ['belongs_to'] to traverse PRIMARY containment only \u2014 'associated_with' is the secondary, NON-COUNTED containment edge and MUST be excluded from any roll-up or count (\"show everything under Business\" follows belongs_to exclusively; each edge's type field flags which kind it is).",
			type: "array",
			items: { type: "string", minLength: 1 },
		},
		hops: {
			description: "Traversal depth over entity\u2194entity edges (default 1, max 2).",
			type: "integer",
			minimum: 1,
			maximum: 2,
		},
		include_archived_edges: {
			description: "Include archived (soft-deleted) relationships in traversal. Defaults to false.",
			type: "boolean",
		},
		include_instance_of: {
			description:
				"ADR-036 \u00a72: opt in to also traverse the virtual 'instance_of' edge from each frontier entity to its vocabulary term-node -- the registry row grounding its entity_type (e.g. an entity_type='people' row -> the term-node for 'people'). Derived from entities.entity_type at query time via the graph_instance_of view; never written per-instance. Default false -- ordinary neighbourhood queries stay clean and cheap. Only this first hop (instance -> term-node) is virtual: once reached, the term-node's own real edges (its exactMatch, a governed_by principle) traverse normally on subsequent hops, giving 'walk from this row to its type, then to the type's governing principle' in one query. Forward direction only -- an entity's own type, never the reverse fan-out of every other instance sharing it.",
			type: "boolean",
		},
		as_of: {
			description:
				"ISO 8601 instant. When present, restrict traversal to edges valid at that moment (valid_from <= as_of AND (valid_to IS NULL OR valid_to > as_of); NULL bounds are open-ended/unbounded), e.g. 'who was my gas supplier in 2026?'. Omit to return all edges regardless of their validity window (current behaviour, unchanged) \u2014 as_of is purely opt-in.",
			type: "string",
			format: "date-time",
			pattern:
				"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
		},
		limit: {
			description: "Max starting entities (default 25).",
			type: "integer",
			minimum: 1,
			maximum: 100,
		},
		node_properties: {
			description:
				"Also return every reached node's full `properties` in `nodes` (default false; starting entities always carry theirs). Use when a read has to sort or filter what the traversal reached by its properties, e.g. arrangements by `kind`. Every node carries `archived` either way: a live edge can still reach an archived entity, and the caller decides whether to drop it.",
			type: "boolean",
		},
		exclude_properties: {
			description:
				"Property keys to omit from returned properties objects on nodes and starting entities (e.g. ['sources', 'notes']).",
			type: "array",
			items: { type: "string", minLength: 1 },
		},
		include_source_notes: {
			description:
				"When node_properties is true, include internal 'sources' and 'notes' properties (default false). These verbose provenance and editorial fields are excluded by default to keep graph traversal payloads within chat context budgets (#1248).",
			type: "boolean",
		},
		property_keys: {
			description:
				"When node_properties is true, whitelist only these specific keys in returned properties. If omitted, all properties (except excluded ones) are included.",
			type: "array",
			items: { type: "string", minLength: 1 },
		},
		include_entity_edges: {
			description:
				"Include the 'edges' array on each starting entity in 'entities' (default true). Set to false to omit 'edges' on starting entities and avoid repeating edges when 'result.edges' already contains all traversed edges (#1248).",
			type: "boolean",
		},
	},
	additionalProperties: false,
};

const USER_ID = "00000000-0000-0000-0000-000000000001";
const E1 = "11111111-1111-4111-8111-111111111111";
const E2 = "22222222-2222-4222-8222-222222222222";
const E3 = "33333333-3333-4333-8333-333333333333";

function makeCtx(userId?: string): ActionContext {
	return { caller: "mcp", requestId: "req-1", userId };
}

function makePort(overrides?: Partial<GraphReadPort>): GraphReadPort {
	return {
		getStartingEntityById: vi.fn(async () => ({
			id: E1,
			entity_type: "people",
			title: "Alice",
			properties: { role: "founder" },
		})),
		queryStartingEntities: vi.fn(async () => []),
		getOutEdges: vi.fn(async () => []),
		getInEdges: vi.fn(async () => []),
		getInstanceOfEdges: vi.fn(async () => []),
		getNodesByIds: vi.fn(async () => [
			{ id: E1, entity_type: "people", title: "Alice", properties: { role: "founder" }, archived: false },
		]),
		getArtifactLinks: vi.fn(async () => []),
		getArtifactsByIds: vi.fn(async () => []),
		resolveDomains: vi.fn(
			async (ids) =>
				new Map(ids.map((id) => [id, { domain: "work" as const, resolved_by: "override" as const, path: [id] }])),
		),
		...overrides,
	};
}

describe("entity_neighbourhood core action (#1491)", () => {
	it("1. preserves contract parity (id, JSON schema snapshot, description, annotations)", () => {
		const action = createEntityNeighbourhoodAction(makePort());
		expect(action.id).toBe("entity_neighbourhood");
		expect(z.toJSONSchema(action.schema)).toEqual(LEGACY_JSON_SCHEMA_SNAPSHOT);
		expect(action.description).toBe(ENTITY_NEIGHBOURHOOD_DESCRIPTION);
		expect(action.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("2. passes ctx.userId to every port call and rejects when ctx.userId is missing", async () => {
		const port = makePort({
			getArtifactLinks: vi.fn(async () => [
				{ entity_id: E1, artifact_id: "art-1", link_type: "primary", confidence_score: 90 },
			]),
			getArtifactsByIds: vi.fn(async () => [
				{ id: "art-1", title: "Kickoff", created_at: "2026-06-01T00:00:00Z" },
			]),
		});
		const action = createEntityNeighbourhoodAction(port);

		await expect(action.run({ entity_id: E1 }, makeCtx(undefined))).rejects.toThrow(/userId/);
		expect(port.getStartingEntityById).not.toHaveBeenCalled();

		await action.run({ entity_id: E1, include_instance_of: true }, makeCtx(USER_ID));
		expect(port.getStartingEntityById).toHaveBeenCalledWith(E1, USER_ID);
		expect(port.getOutEdges).toHaveBeenCalledWith([E1], USER_ID, expect.any(Object));
		expect(port.getInEdges).toHaveBeenCalledWith([E1], USER_ID, expect.any(Object));
		expect(port.getInstanceOfEdges).toHaveBeenCalledWith([E1], USER_ID);
		expect(port.getNodesByIds).toHaveBeenCalledWith([E1], USER_ID);
		expect(port.getArtifactLinks).toHaveBeenCalledWith([E1], USER_ID);
		expect(port.getArtifactsByIds).toHaveBeenCalledWith(["art-1"], USER_ID);
		expect(port.resolveDomains).toHaveBeenCalledWith([E1], USER_ID);
	});

	it("3. formatMcp returns 'No matching entities.' when no starting entity matches", async () => {
		const port = makePort({ getStartingEntityById: vi.fn(async () => null) });
		const action = createEntityNeighbourhoodAction(port);
		const res = await action.run({ entity_id: E1 }, makeCtx(USER_ID));
		expect(action.formatMcp!(res)).toBe("No matching entities.");
	});

	it("4-7. traverses 2 hops with edge_types, forwards as_of/include_archived_edges, batches domain resolution, and formats MCP output", async () => {
		const asOf = "2026-06-15T00:00:00Z";
		const port = makePort({
			getOutEdges: vi.fn(async (frontier) => {
				if (frontier.includes(E1)) {
					return [
						{
							from_entity_id: E1,
							to_entity_id: E2,
							relationship_type: "belongs_to",
							confidence_score: 90,
							metadata: null,
							notes: null,
							valid_from: "2025-01-01T00:00:00Z",
							valid_to: null,
						},
						{
							from_entity_id: E1,
							to_entity_id: E3,
							relationship_type: "associated_with",
							confidence_score: 80,
							metadata: null,
							notes: null,
							valid_from: null,
							valid_to: null,
						},
					];
				}
				return [
					{
						from_entity_id: E2,
						to_entity_id: E3,
						relationship_type: "belongs_to",
						confidence_score: 95,
						metadata: null,
						notes: null,
						valid_from: null,
						valid_to: null,
					},
				];
			}),
			getNodesByIds: vi.fn(async () => [
				{ id: E1, entity_type: "project", title: "Subproject", properties: {}, archived: false },
				{ id: E2, entity_type: "project", title: "Parent Project", properties: {}, archived: false },
				{ id: E3, entity_type: "area", title: "Business", properties: {}, archived: false },
			]),
		});
		const action = createEntityNeighbourhoodAction(port);
		const res = await action.run(
			{
				entity_id: E1,
				hops: 2,
				edge_types: ["belongs_to"],
				as_of: asOf,
				include_archived_edges: true,
			},
			makeCtx(USER_ID),
		);

		expect(port.getOutEdges).toHaveBeenCalledTimes(2);
		expect(port.getInEdges).toHaveBeenCalledTimes(2);
		expect(port.getOutEdges).toHaveBeenNthCalledWith(1, [E1], USER_ID, {
			includeArchivedEdges: true,
			edgeTypes: new Set(["belongs_to"]),
			asOf,
		});
		expect(port.resolveDomains).toHaveBeenCalledTimes(1);
		expect(res.entities[0]).toMatchObject({
			domain: "work",
			domain_resolution: { resolved_by: "override", path: [E1] },
		});
		expect(res.nodes.map((n) => n.id)).toEqual([E1, E2, E3]);
		expect(res.edges.map((e) => `${e.from}->${e.to}:${e.type}`)).toEqual([
			`${E1}->${E2}:belongs_to`,
			`${E2}->${E3}:belongs_to`,
		]);

		const oneHop = await action.run({ entity_id: E1, hops: 1 }, makeCtx(USER_ID));
		const formatted = action.formatMcp!(oneHop);
		expect(formatted.startsWith("Neighbourhood (1 starting entity, 1 hop):\n")).toBe(true);
		expect(JSON.parse(formatted.slice(formatted.indexOf("\n") + 1))).toEqual(oneHop);
		expect(isEdgeValidAt("2026-06-15T00:00:00Z", null, asOf)).toBe(true);
		expect(filterProperties({ a: 1, sources: ["x"] }, { isStartingEntity: false })).toEqual({ a: 1 });
	});
});
