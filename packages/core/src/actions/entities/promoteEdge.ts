import { z } from "zod";
import { embedAndStore, type EntityEmbedFields, type RetryOptions } from "../../domain/embeddings.js";
import { EDGE_TYPES } from "../../domain/vocab.js";
import type { EmbeddingPort, EmbeddingStorePort } from "../../ports/embeddings.js";
import type {
	ArrangementNodeInsertRow,
	EntityRepository,
	ParticipantEdgeInsertRow,
	ProvenanceLinkInsertRow,
} from "../../ports/entities.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

/**
 * ADR-035 §6 — `entity_promote_edge`: reify a binary `entity_relationships`
 * edge into one or more `arrangement` nodes, provenance-preserving.
 *
 * Steps (ADR-035 §6): (1) create the `arrangement` node(s); (2) move the fact's
 * labels/dates onto them; (3) attach per-role participant edges OUT of each node
 * (arrangement → participant, named per-role — employer/employee/… — never a
 * generic has_participant, §5); (4) archive the original edge (soft-delete,
 * migration 068 — history retained).
 *
 * 1→N split (the employment case, §6): one edge → several job-nodes ("PM
 * 2018–2019", "Senior PM 2019–2023"). Pass several `arrangements`; the
 * originating capture's provenance links to EVERY new node (an
 * `artifact_entity_links` row each), and the original edge's window is
 * superseded by the per-node windows the caller supplies.
 *
 * Where the dates live: `entities` has no valid_from/valid_to columns (migration
 * 068 added those to `entity_relationships` only). So each arrangement's window
 * is stored BOTH in `properties.valid_from`/`valid_to` (the node-level fact, §6)
 * AND on every participant edge's real `valid_from`/`valid_to` columns — the only
 * temporal read path that exists (`entity_neighbourhood` as-of, #315) filters
 * EDGE windows, so without dates on the edges a reified arrangement could never
 * be queried over time, defeating the point of reifying (§Decision drivers,
 * "Traversable & queryable").
 *
 * Not atomic (the supabase-js REST client has no multi-statement transaction):
 * nodes → participant edges → provenance links are written first, and the
 * original edge is archived LAST. A mid-operation failure therefore leaves the
 * source edge live (no data loss) — the worst case is an orphan arrangement node
 * the caller can archive. Reifying is local and non-cascading (§6): nothing
 * references an edge, so this touches exactly one edge + its endpoints.
 *
 * Idempotency: an already-archived source edge is refused outright (rather than
 * silently reified again), so calling this twice on the same edge_id can't
 * create a second, duplicate set of arrangement nodes.
 */

export const ENTITY_PROMOTE_EDGE_DESCRIPTION =
	"Reify a binary edge into one or more `arrangement` nodes: create the node, attach per-role " +
	"participant edges out of it, and link the originating capture. Use when a relationship itself " +
	"needs properties — a role, a term, a rate — that an edge cannot carry. Full notes: " +
	"docs/guides/tools/entity_promote_edge.md";

const participantSchema = z.object({
	role: z
		.string()
		.min(1)
		.describe(
			`Per-role participant edge type OUT of the arrangement (arrangement → participant). Seed roles (open-vocab, ADR-035 §5): ${[
				"employer",
				"employee",
				"resident",
				"at_place",
				"supplier",
				"customer",
				"of_utility",
			].join(", ")}. A new kind coins its own roles — unknown values are stored verbatim (soft validation), never rejected or retyped.`,
		),
	entity_id: z
		.string()
		.uuid()
		.describe("The participating entity (must exist and belong to you)."),
	confidence: z
		.number()
		.min(0)
		.max(100)
		.optional()
		.describe("0–100 confidence this participant edge is real."),
});

const arrangementSchema = z.object({
	title: z
		.string()
		.min(1)
		.optional()
		.describe("Node title, e.g. 'PM at Acme'. Defaults to the kind if omitted."),
	valid_from: z
		.string()
		.datetime()
		.optional()
		.describe("Start of THIS arrangement's window (ISO 8601). For a 1→N split each node carries its own corrected window."),
	valid_to: z
		.string()
		.datetime()
		.optional()
		.describe("End of THIS arrangement's window (ISO 8601). Omit if ongoing."),
	confidence: z
		.number()
		.min(0)
		.max(100)
		.optional()
		.describe("0–100 confidence this arrangement is real."),
	properties: z
		.record(z.string(), z.unknown())
		.optional()
		.describe("Extra node properties; merged under { kind, valid_from, valid_to }."),
	participants: z
		.array(participantSchema)
		.min(1)
		.describe("The per-role edges from this arrangement to each participant (≥1)."),
});

export const promoteEdgeToNodeInput = {
	edge_id: z
		.string()
		.uuid()
		.describe(
			"The binary edge to reify (id from entity_relate / entity_neighbourhood). Archived after promotion unless archive_original is false.",
		),
	kind: z
		.string()
		.min(1)
		.describe(
			"Arrangement kind, stored in properties.kind — open-vocab (employment | residency | supply | tenancy | …). Reify-by-category and the accumulation counter key on this, NOT entity_type (ADR-035 §2/§4).",
		),
	arrangements: z
		.array(arrangementSchema)
		.min(1)
		.max(20)
		.describe(
			"One arrangement to reify the edge into, or SEVERAL for the 1→N split (e.g. two job-nodes from one employment edge — 'PM 2018–2019', 'Senior PM 2019–2023'). Every new node is linked to source_artifact_id; the original edge's window is superseded by these (ADR-035 §6).",
		),
	source_artifact_id: z
		.string()
		.uuid()
		.optional()
		.describe(
			"Originating capture. Each new arrangement node gets an artifact_entity_links row (link_type 'primary') to it — provenance attaches to NODES, not edges (ADR-035 §7). For a 1→N split it links to ALL new nodes.",
		),
	archive_original: z
		.boolean()
		.optional()
		.describe(
			"Soft-delete the source edge after promotion (default true). Archived edges are retained for history (migration 068) and excluded from default reads. Set false to keep the edge live alongside the new nodes.",
		),
};

export const entityPromoteEdgeInput = promoteEdgeToNodeInput;
export const promoteEdgeToNodeSchema = z.object(promoteEdgeToNodeInput);
export const entityPromoteEdgeSchema = promoteEdgeToNodeSchema;
export type EntityPromoteEdgeInput = z.infer<typeof promoteEdgeToNodeSchema>;

export interface EntityPromoteEdgeResult {
	text: string;
	nodeIds: string[];
	edgeCount: number;
	linkCount: number;
	archived: boolean;
}

export type EntityPromoteEdgeRepository = Pick<
	EntityRepository,
	| "getEdgeById"
	| "findOwnedEntityIds"
	| "insertArrangementNodes"
	| "insertParticipantEdges"
	| "insertProvenanceLinks"
	| "archiveEdge"
>;

export interface EntityPromoteEdgeDeps {
	entities: EntityPromoteEdgeRepository;
	embeddings?: EmbeddingPort | null | (() => EmbeddingPort | null);
	embeddingStore?: EmbeddingStorePort;
	embedEntity?: (id: string, fields: EntityEmbedFields) => Promise<unknown>;
	ownerId?: string | (() => string | undefined);
	retryOptions?: RetryOptions;
}

const noopEmbeddingStore: EmbeddingStorePort = {
	setEmbedding: async () => {},
};

export function formatEntityPromoteEdgeMcp(result: EntityPromoteEdgeResult): string {
	return result.text;
}

export function createEntityPromoteEdgeAction(
	depsOrRepo: EntityPromoteEdgeRepository | EntityPromoteEdgeDeps,
	embeddingsArg?: EmbeddingPort | null,
	embeddingStoreArg?: EmbeddingStorePort,
): ActionDefinition<typeof promoteEdgeToNodeSchema, EntityPromoteEdgeResult> {
	const deps: EntityPromoteEdgeDeps =
		"entities" in depsOrRepo
			? depsOrRepo
			: {
					entities: depsOrRepo,
					embeddings: embeddingsArg,
					embeddingStore: embeddingStoreArg,
				};

	return defineAction({
		id: "entity_promote_edge",
		name: "entity_promote_edge",
		description: ENTITY_PROMOTE_EDGE_DESCRIPTION,
		domain: "kg",
		schema: promoteEdgeToNodeSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (args: EntityPromoteEdgeInput, ctx) => {
			const userId =
				ctx.userId ??
				(typeof deps.ownerId === "function" ? deps.ownerId() : deps.ownerId) ??
				"";

			// 1. Load the source edge, scoped to the user.
			const sourceEdge = await deps.entities.getEdgeById(args.edge_id, userId);
			if (!sourceEdge) {
				throw new Error(
					`No edge ${args.edge_id} found for you — pass an edge_id from entity_relate or entity_neighbourhood.`,
				);
			}
			if (sourceEdge.archived) {
				throw new Error(
					`Edge ${sourceEdge.id} is already archived — refusing to promote it again. This usually means entity_promote_edge already ran on this edge; re-running would create a second, duplicate set of arrangement nodes. If the edge needs to be reified again, resurrect it first with entity_relate (same from/to/type un-archives it).`,
				);
			}

			// 2. Every participant across every arrangement must exist and be yours,
			// before we write anything (a partial promotion is worse than a rejected one).
			const participantIds = [
				...new Set(
					args.arrangements.flatMap((a) => a.participants.map((p) => p.entity_id)),
				),
			];
			const owned = await deps.entities.findOwnedEntityIds(participantIds, userId);
			const missing = participantIds.filter((id) => !owned.has(id));
			if (missing.length > 0) {
				throw new Error(
					`These participant entities don't exist or aren't yours: ${missing.join(", ")}. Create them with upsert_entity first.`,
				);
			}

			// Build every row up front (node ids generated here so participant edges and
			// provenance links can reference them without a round-trip), then write in
			// batches. Original edge archived LAST so a failure can't lose the fact.
			const nodeRows: ArrangementNodeInsertRow[] = [];
			const edgeRows: ParticipantEdgeInsertRow[] = [];
			const linkRows: ProvenanceLinkInsertRow[] = [];
			const unknownRoles = new Set<string>();
			const summaries: string[] = [];

			for (const arrangement of args.arrangements) {
				const nodeId = globalThis.crypto.randomUUID();
				const validFrom = arrangement.valid_from ?? null;
				const validTo = arrangement.valid_to ?? null;
				const title = arrangement.title ?? args.kind;

				nodeRows.push({
					id: nodeId,
					entity_type: "arrangement",
					title,
					description: null,
					// Dates live in properties too (entities has no valid_from/valid_to
					// columns) so a node-centric read still sees the fact's window (§6).
					properties: {
						...(arrangement.properties ?? {}),
						kind: args.kind,
						...(validFrom ? { valid_from: validFrom } : {}),
						...(validTo ? { valid_to: validTo } : {}),
					},
					tags: [],
					archived: false,
					user_id: userId,
					team_id: null,
				});

				for (const p of arrangement.participants) {
					if (!(EDGE_TYPES as readonly string[]).includes(p.role)) {
						unknownRoles.add(p.role);
					}
					edgeRows.push({
						user_id: userId,
						from_entity_id: nodeId,
						to_entity_id: p.entity_id,
						relationship_type: p.role,
						confidence_score: p.confidence ?? arrangement.confidence ?? null,
						metadata: {},
						created_by: "entity_promote_edge",
						notes: `Participant edge of ${args.kind} arrangement ${nodeId} (reified from edge ${sourceEdge.id}).`,
						// Mirror the arrangement window onto every participant edge so the
						// as-of read path (#315) can filter the reified fact by time.
						valid_from: validFrom,
						valid_to: validTo,
					});
				}

				if (args.source_artifact_id) {
					linkRows.push({
						user_id: userId,
						artifact_id: args.source_artifact_id,
						entity_id: nodeId,
						link_type: "primary",
						confidence_score: null,
						created_by: "entity_promote_edge",
						notes: null,
					});
				}

				summaries.push(
					`• [${nodeId}] ${title} (kind: ${args.kind}${validFrom || validTo ? `, ${validFrom ?? "…"}–${validTo ?? "…"}` : ""}) — ${arrangement.participants
						.map((p) => `${p.role} → ${p.entity_id}`)
						.join(", ")}`,
				);
			}

			// 3. Write: nodes, then participant edges, then provenance links.
			try {
				await deps.entities.insertArrangementNodes(nodeRows, userId);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(
					`Create arrangement node(s) failed: ${msg}. Original edge ${sourceEdge.id} is untouched.`,
				);
			}

			// Embed the new nodes (ADR-047 §2 / #551) — field values are already known
			// client-side (they're what we just inserted), so no read-back is needed.
			const embeddingPort =
				typeof deps.embeddings === "function" ? deps.embeddings() : deps.embeddings;
			const store = deps.embeddingStore ?? noopEmbeddingStore;
			await Promise.all(
				nodeRows.map((node) => {
					const fields: EntityEmbedFields = {
						title: node.title,
						description: node.description,
						properties: node.properties,
					};
					if (deps.embedEntity && !embeddingPort) {
						return deps.embedEntity(node.id, fields);
					}
					return embedAndStore(embeddingPort, store, "entities", node.id, fields, {
						retryOptions: deps.retryOptions,
					});
				}),
			);

			try {
				await deps.entities.insertParticipantEdges(edgeRows, userId);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(
					`Create participant edges failed: ${msg}. Arrangement node(s) were created but are orphaned — original edge ${sourceEdge.id} is untouched; archive the node(s) and retry.`,
				);
			}

			if (linkRows.length > 0) {
				try {
					await deps.entities.insertProvenanceLinks(linkRows, userId);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					throw new Error(
						`Create provenance links failed: ${msg}. Node(s) + participant edges exist; original edge ${sourceEdge.id} is untouched. Add the artifact_entity_links manually or retry.`,
					);
				}
			}

			// 4. Archive the original edge LAST (if requested). Nothing references an
			// edge, so this is a local, non-cascading soft-delete (§6).
			const archiveOriginal = args.archive_original ?? true;
			let archivedNote = "";
			if (archiveOriginal) {
				try {
					await deps.entities.archiveEdge(sourceEdge.id, userId);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					throw new Error(
						`Promotion succeeded but archiving the original edge ${sourceEdge.id} failed: ${msg}. Archive it manually (entity_relate … archive:true) so the reified fact isn't double-counted.`,
					);
				}
				archivedNote = `\nArchived original edge ${sourceEdge.id} (${sourceEdge.from_entity_id} -[${sourceEdge.relationship_type}]-> ${sourceEdge.to_entity_id}).`;
			} else {
				archivedNote = `\nLeft original edge ${sourceEdge.id} live (archive_original: false).`;
			}

			const provenanceNote = args.source_artifact_id
				? `\nLinked artifact ${args.source_artifact_id} to ${nodeRows.length} node(s) (provenance).`
				: "";
			const roleNote =
				unknownRoles.size > 0
					? `\nNote: role(s) not in the seed vocabulary stored verbatim (open-vocab): ${[...unknownRoles].join(", ")}.`
					: "";

			return {
				text: `Promoted edge ${sourceEdge.id} into ${nodeRows.length} arrangement node(s) with ${edgeRows.length} participant edge(s):\n${summaries.join("\n")}${provenanceNote}${archivedNote}${roleNote}`,
				nodeIds: nodeRows.map((n) => n.id),
				edgeCount: edgeRows.length,
				linkCount: linkRows.length,
				archived: archiveOriginal,
			};
		},
		formatMcp: formatEntityPromoteEdgeMcp,
	});
}
