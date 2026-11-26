import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeAction } from "../adapters/direct.js";
import type { EmbeddingPort, EmbeddingStorePort } from "../../ports/embeddings.js";
import type {
	ArrangementNodeInsertRow,
	EntityRepository,
	ParticipantEdgeInsertRow,
	PromotableEdgeRow,
	ProvenanceLinkInsertRow,
} from "../../ports/entities.js";
import {
	createEntityPromoteEdgeAction,
	ENTITY_PROMOTE_EDGE_DESCRIPTION,
} from "./promoteEdge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EDGE_ID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = "44444444-4444-4444-8444-444444444444";
const PERSON_ID = "55555555-5555-4555-8555-555555555555";
const ART_ID = "66666666-6666-4666-8666-666666666666";
const NODE_ID = "77777777-7777-4777-8777-777777777777";

const COMMITTED_JSON_SCHEMA = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {
		edge_id: {
			type: "string",
			format: "uuid",
			pattern:
				"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
			description:
				"The binary edge to reify (id from entity_relate / entity_neighbourhood). Archived after promotion unless archive_original is false.",
		},
		kind: {
			type: "string",
			minLength: 1,
			description:
				"Arrangement kind, stored in properties.kind — open-vocab (employment | residency | supply | tenancy | …). Reify-by-category and the accumulation counter key on this, NOT entity_type (ADR-035 §2/§4).",
		},
		arrangements: {
			minItems: 1,
			maxItems: 20,
			type: "array",
			items: {
				type: "object",
				properties: {
					title: {
						description: "Node title, e.g. 'PM at Acme'. Defaults to the kind if omitted.",
						type: "string",
						minLength: 1,
					},
					valid_from: {
						description:
							"Start of THIS arrangement's window (ISO 8601). For a 1→N split each node carries its own corrected window.",
						type: "string",
						format: "date-time",
						pattern:
							"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
					},
					valid_to: {
						description: "End of THIS arrangement's window (ISO 8601). Omit if ongoing.",
						type: "string",
						format: "date-time",
						pattern:
							"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
					},
					confidence: {
						description: "0–100 confidence this arrangement is real.",
						type: "number",
						minimum: 0,
						maximum: 100,
					},
					properties: {
						description: "Extra node properties; merged under { kind, valid_from, valid_to }.",
						type: "object",
						propertyNames: {
							type: "string",
						},
						additionalProperties: {},
					},
					participants: {
						minItems: 1,
						type: "array",
						items: {
							type: "object",
							properties: {
								role: {
									type: "string",
									minLength: 1,
									description:
										"Per-role participant edge type OUT of the arrangement (arrangement → participant). Seed roles (open-vocab, ADR-035 §5): employer, employee, resident, at_place, supplier, customer, of_utility. A new kind coins its own roles — unknown values are stored verbatim (soft validation), never rejected or retyped.",
								},
								entity_id: {
									type: "string",
									format: "uuid",
									pattern:
										"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
									description: "The participating entity (must exist and belong to you).",
								},
								confidence: {
									description: "0–100 confidence this participant edge is real.",
									type: "number",
									minimum: 0,
									maximum: 100,
								},
							},
							required: ["role", "entity_id"],
							additionalProperties: false,
						},
						description: "The per-role edges from this arrangement to each participant (≥1).",
					},
				},
				required: ["participants"],
				additionalProperties: false,
			},
			description:
				"One arrangement to reify the edge into, or SEVERAL for the 1→N split (e.g. two job-nodes from one employment edge — 'PM 2018–2019', 'Senior PM 2019–2023'). Every new node is linked to source_artifact_id; the original edge's window is superseded by these (ADR-035 §6).",
		},
		source_artifact_id: {
			description:
				"Originating capture. Each new arrangement node gets an artifact_entity_links row (link_type 'primary') to it — provenance attaches to NODES, not edges (ADR-035 §7). For a 1→N split it links to ALL new nodes.",
			type: "string",
			format: "uuid",
			pattern:
				"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
		},
		archive_original: {
			description:
				"Soft-delete the source edge after promotion (default true). Archived edges are retained for history (migration 068) and excluded from default reads. Set false to keep the edge live alongside the new nodes.",
			type: "boolean",
		},
	},
	required: ["edge_id", "kind", "arrangements"],
	additionalProperties: false,
};

function makeInMemoryFixture(initialOwner = "owner-1") {
	const edges = new Map<string, PromotableEdgeRow & { user_id: string }>([
		[
			EDGE_ID,
			{
				id: EDGE_ID,
				user_id: initialOwner,
				from_entity_id: PERSON_ID,
				to_entity_id: ORG_ID,
				relationship_type: "employed_by",
				valid_from: "2018-01-01T00:00:00.000Z",
				valid_to: "2023-01-01T00:00:00.000Z",
				archived: false,
			},
		],
	]);
	const ownedEntities = new Map<string, string>([
		[ORG_ID, initialOwner],
		[PERSON_ID, initialOwner],
	]);

	const callOrder: string[] = [];
	const seenUserIds: Array<{ method: string; userId: string | undefined }> = [];
	const insertedNodes: ArrangementNodeInsertRow[] = [];
	const insertedEdges: ParticipantEdgeInsertRow[] = [];
	const insertedLinks: ProvenanceLinkInsertRow[] = [];
	const embeddedNodes: Array<{ id: string; text: string; vector: number[] }> = [];

	const repo: EntityRepository = {
		getById: async () => null,
		loadRows: async () => ({ rows: [], truncated: false }),
		insert: async () => [],
		update: async () => [],
		mutateByIds: async () => [],
		getDomainRow: async () => null,
		fetchPrimaryParentId: async () => null,
		fetchPrimaryParentsBatch: async () => new Map(),
		getEdgeById: async (edgeId, userId) => {
			callOrder.push("getEdgeById");
			seenUserIds.push({ method: "getEdgeById", userId });
			const row = edges.get(edgeId);
			if (!row || row.user_id !== userId) return null;
			return {
				id: row.id,
				from_entity_id: row.from_entity_id,
				to_entity_id: row.to_entity_id,
				relationship_type: row.relationship_type,
				valid_from: row.valid_from,
				valid_to: row.valid_to,
				archived: row.archived,
			};
		},
		findOwnedEntityIds: async (ids, userId) => {
			callOrder.push("findOwnedEntityIds");
			seenUserIds.push({ method: "findOwnedEntityIds", userId });
			return new Set(ids.filter((id) => ownedEntities.get(id) === userId));
		},
		insertArrangementNodes: async (rows, userId) => {
			callOrder.push("insertArrangementNodes");
			seenUserIds.push({ method: "insertArrangementNodes", userId });
			insertedNodes.push(...rows);
		},
		insertParticipantEdges: async (rows, userId) => {
			callOrder.push("insertParticipantEdges");
			seenUserIds.push({ method: "insertParticipantEdges", userId });
			insertedEdges.push(...rows);
		},
		insertProvenanceLinks: async (rows, userId) => {
			callOrder.push("insertProvenanceLinks");
			seenUserIds.push({ method: "insertProvenanceLinks", userId });
			insertedLinks.push(...rows);
		},
		archiveEdge: async (edgeId, userId) => {
			callOrder.push("archiveEdge");
			seenUserIds.push({ method: "archiveEdge", userId });
			const row = edges.get(edgeId);
			if (row && row.user_id === userId) {
				row.archived = true;
			}
		},
	};

	const embeddingPort: EmbeddingPort = {
		embed: vi.fn(async (text: string) => {
			callOrder.push("embed");
			return [text.length];
		}),
		embedBatch: vi.fn(async (texts: string[]) => texts.map((t) => [t.length])),
	};

	const embeddingStore: EmbeddingStorePort = {
		setEmbedding: vi.fn(async (_table, id, vector) => {
			callOrder.push("setEmbedding");
			embeddedNodes.push({ id, text: "", vector });
		}),
	};

	return {
		repo,
		embeddingPort,
		embeddingStore,
		callOrder,
		seenUserIds,
		insertedNodes,
		insertedEdges,
		insertedLinks,
		embeddedNodes,
		edges,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("entity_promote_edge core action (#1501)", () => {
	it("1. Contract: id, schema JSONSchema snapshot, description, and annotations match legacy tool verbatim", () => {
		const { repo } = makeInMemoryFixture();
		const action = createEntityPromoteEdgeAction(repo);

		expect(action.id).toBe("entity_promote_edge");
		expect(z.toJSONSchema(action.schema)).toEqual(COMMITTED_JSON_SCHEMA);
		expect(action.description).toBe(
			"Reify a binary edge into one or more `arrangement` nodes: create the node, attach per-role " +
				"participant edges out of it, and link the originating capture. Use when a relationship itself " +
				"needs properties — a role, a term, a rate — that an edge cannot carry. Full notes: " +
				"docs/guides/tools/entity_promote_edge.md",
		);
		expect(action.description).toBe(ENTITY_PROMOTE_EDGE_DESCRIPTION);
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("2. Tenant scoping: an edge belonging to another user reads as not found and every repository call carries ctx.userId", async () => {
		const fixture = makeInMemoryFixture("owner-1");
		const action = createEntityPromoteEdgeAction({
			entities: fixture.repo,
			embeddings: fixture.embeddingPort,
			embeddingStore: fixture.embeddingStore,
		});

		await expect(
			executeAction(
				action,
				{
					edge_id: EDGE_ID,
					kind: "employment",
					arrangements: [
						{
							participants: [
								{ role: "employer", entity_id: ORG_ID },
								{ role: "employee", entity_id: PERSON_ID },
							],
						},
					],
				},
				{
					context: { caller: "mcp", userId: "other-user", requestId: "req-1" },
				},
			),
		).rejects.toThrow(
			`No edge ${EDGE_ID} found for you — pass an edge_id from entity_relate or entity_neighbourhood.`,
		);

		expect(fixture.seenUserIds).toEqual([{ method: "getEdgeById", userId: "other-user" }]);

		fixture.seenUserIds.length = 0;
		await executeAction(
			action,
			{
				edge_id: EDGE_ID,
				kind: "employment",
				source_artifact_id: ART_ID,
				arrangements: [
					{
						title: "PM at Acme",
						participants: [
							{ role: "employer", entity_id: ORG_ID },
							{ role: "employee", entity_id: PERSON_ID },
						],
					},
				],
			},
			{
				context: { caller: "mcp", userId: "owner-1", requestId: "req-2" },
			},
		);

		expect(fixture.seenUserIds).toEqual([
			{ method: "getEdgeById", userId: "owner-1" },
			{ method: "findOwnedEntityIds", userId: "owner-1" },
			{ method: "insertArrangementNodes", userId: "owner-1" },
			{ method: "insertParticipantEdges", userId: "owner-1" },
			{ method: "insertProvenanceLinks", userId: "owner-1" },
			{ method: "archiveEdge", userId: "owner-1" },
		]);
	});

	it("3 & 4. Promotes one edge with two roles in exact order, embeds once, and re-running creates nothing new", async () => {
		const fixture = makeInMemoryFixture("owner-1");
		const action = createEntityPromoteEdgeAction({
			entities: fixture.repo,
			embeddings: fixture.embeddingPort,
			embeddingStore: fixture.embeddingStore,
		});

		const input = {
			edge_id: EDGE_ID,
			kind: "employment",
			source_artifact_id: ART_ID,
			arrangements: [
				{
					title: "PM at Acme",
					valid_from: "2018-01-01T00:00:00.000Z",
					valid_to: "2019-01-01T00:00:00.000Z",
					participants: [
						{ role: "employer", entity_id: ORG_ID },
						{ role: "employee", entity_id: PERSON_ID },
					],
				},
			],
		};

		const result = await executeAction(action, input, {
			context: { caller: "mcp", userId: "owner-1", requestId: "req-3" },
		});

		expect(fixture.callOrder).toEqual([
			"getEdgeById",
			"findOwnedEntityIds",
			"insertArrangementNodes",
			"embed",
			"setEmbedding",
			"insertParticipantEdges",
			"insertProvenanceLinks",
			"archiveEdge",
		]);
		expect(fixture.insertedNodes).toHaveLength(1);
		expect(fixture.insertedEdges).toHaveLength(2);
		expect(fixture.insertedLinks).toHaveLength(1);
		expect(fixture.embeddedNodes).toHaveLength(1);
		expect(fixture.embeddingPort.embed).toHaveBeenCalledTimes(1);
		expect(result.text).toContain("Promoted edge");

		await expect(
			executeAction(action, input, {
				context: { caller: "mcp", userId: "owner-1", requestId: "req-4" },
			}),
		).rejects.toThrow(/already archived/);

		expect(fixture.insertedNodes).toHaveLength(1);
		expect(fixture.insertedEdges).toHaveLength(2);
		expect(fixture.insertedLinks).toHaveLength(1);
		expect(fixture.embeddedNodes).toHaveLength(1);
		expect(fixture.embeddingPort.embed).toHaveBeenCalledTimes(1);
	});

	it("5. Node ids come from globalThis.crypto.randomUUID() and promoteEdge.ts imports no node:crypto", async () => {
		const spy = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(NODE_ID);
		const fixture = makeInMemoryFixture("owner-1");
		const action = createEntityPromoteEdgeAction(
			fixture.repo,
			fixture.embeddingPort,
			fixture.embeddingStore,
		);

		await executeAction(
			action,
			{
				edge_id: EDGE_ID,
				kind: "employment",
				arrangements: [
					{
						title: "PM at Acme",
						participants: [{ role: "employer", entity_id: ORG_ID }],
					},
				],
			},
			{
				context: { caller: "mcp", userId: "owner-1", requestId: "req-5" },
			},
		);

		expect(spy).toHaveBeenCalledTimes(1);
		expect(fixture.insertedNodes[0].id).toBe(NODE_ID);

		const sourcePath = path.resolve(__dirname, "./promoteEdge.ts");
		const sourceText = fs.readFileSync(sourcePath, "utf8");
		expect(sourceText).not.toContain("node:crypto");
		expect(sourceText).toContain("globalThis.crypto.randomUUID()");
	});
});
