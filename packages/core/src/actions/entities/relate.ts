import { z } from "zod";
import { EDGE_TYPES } from "../../domain/vocab.js";
import type { EntityRepository } from "../../ports/entities.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import {
	assertValidWindow,
	isPlainObject,
	mergeMetadataPatch,
	nextNotesValue,
	normalizeRelationshipConfidence,
	PRIMARY_CONTAINMENT_SOURCE_TYPES,
	resolveRelationshipType,
	temporalCollision,
	VOCAB_SUMMARY,
} from "./relationshipType.js";

export const ENTITY_RELATE_DESCRIPTION =
	"Create or update one entity-to-entity edge in the knowledge graph. Both endpoints must already " +
	"exist \u2014 use entity_upsert or person_upsert first. Deduplicates on (from, to, " +
	"relationship_type), so re-running is safe. Prefer the canonical ADR-021 relationship vocabulary. " +
	"Full notes: docs/guides/tools/entity_relate.md";

const singleEdgeOptionalFields = {
	confidence: z
		.number()
		.min(0)
		.max(100)
		.optional()
		.describe(
			"0.0–1.0 confidence the edge is real (legacy 1 < value <= 100 inputs are automatically divided by 100). Omit if unknown \u2014 on an edge that already exists, omitting LEAVES the stored value unchanged (#501; there is no clear-confidence flag, since 'unknown confidence' and 'no opinion supplied this call' are the same thing).",
		),
	metadata: z
		.record(z.string(), z.unknown())
		.optional()
		.describe(
			"Optional edge attributes, e.g. { context: 'Matheson Lang Gardens' } (the membership # belongs to the provider×property edge, not the provider alone). " +
				"Omit to leave the edge's stored metadata untouched. When supplied on an edge that already exists, this is a JSON Merge Patch (RFC 7386, one level deep) " +
				"against the stored object, NOT a replacement: keys you supply overwrite the same key, keys you don't mention are kept, and a key supplied with " +
				"value null is DELETED from the stored object. Re-assertion is additive by default \u2014 send only the keys you're adding or changing \u2014 and deletion stays " +
				"possible via explicit null (#501 / ADR-035 amendment).",
		),
	notes: z
		.string()
		.optional()
		.describe(
			"Free-text notes on the edge. Omit to leave the caller's previously-recorded prose unchanged on an edge that already exists (#501); " +
				"pass an empty string to explicitly clear it instead (the exact parallel to metadata's explicit null). " +
				"Independent of this field: when relationship_type needed normalising (ADR-021), the resulting vocabulary note is re-derived and " +
				"re-appended on every write. For a recognised synonym (the romantic subtypes \u2014 girlfriend, boyfriend, situationship, … \u2014 are " +
				"currently the only note-carrying vocabulary) the note is not caller-erasable: it survives even a later call that supplies new " +
				"notes or switches to the canonical term. The open-ended 'other' fallback has no such bounded recognition \u2014 re-using the SAME " +
				"unrecognised phrase never duplicates its note, but a call that both switches to a genuinely different unrecognised phrase AND " +
				"supplies new notes can still lose the earlier phrase, same as any single free-text column would.",
		),
	valid_from: z
		.string()
		.datetime()
		.optional()
		.describe(
			"Start of the relationship's validity window (ISO 8601), e.g. when a job or tenancy began. Omit if unknown/unbounded \u2014 on an edge that already exists, omitting LEAVES the stored value unchanged (use clear_window to erase it).",
		),
	valid_to: z
		.string()
		.datetime()
		.optional()
		.describe(
			"End of the relationship's validity window (ISO 8601), e.g. when a job or tenancy ended. Omit if still active \u2014 on an edge that already exists, omitting LEAVES the stored value unchanged (use clear_window to erase it).",
		),
	clear_window: z
		.boolean()
		.optional()
		.describe(
			"Erase this edge's stored valid_from/valid_to (both set to null). Needed only because omitting the dates now PRESERVES them (#464); pass this to correct a window that should never have been recorded. Cannot be combined with valid_from/valid_to. Defaults to false.",
		),
	archive: z
		.boolean()
		.optional()
		.describe(
			"Soft-delete this edge instead of creating/updating it live. Archived edges are excluded from entity_neighbourhood and default relationship reads but retained for history. Takes effect before any window logic runs, so combining this with clear_window (or valid_from/valid_to) archives the edge and leaves its stored window untouched \u2014 call entity_relate again without archive to change the window. Defaults to false.",
		),
	overwrite: z
		.boolean()
		.optional()
		.describe(
			"Allow overwriting an existing edge's temporal window with a DIFFERENT one. By default a 2nd same-type edge between the same pair carrying different dates is REFUSED (ADR-035 collision-at-2: overwriting would silently drop the first fact \u2014 promote both into an arrangement with entity_promote_edge instead). Set true ONLY to intentionally correct this edge's dates, not to record a 2nd distinct fact. Also gates re-pointing a project/resource's PRIMARY containment parent (#170): a 'belongs_to' write that would give the entity a 2nd primary parent is refused by default; with overwrite: true the old primary edge is archived and the new one written. Defaults to false.",
		),
	supersedes_relationship_id: z
		.string()
		.uuid()
		.optional()
		.describe(
			"Optional id of an earlier relationship edge that this edge supersedes (#2053). When supplied on a non-archive write, the superseded edge must exist and belong to you; its valid_to is closed to this edge's valid_from (or the current timestamp when valid_from is omitted) if valid_to is currently null, and metadata cross-links (supersedes_relationship_id on the new edge, superseded_by_relationship_id on the old edge) are recorded.",
		),
};

const relationshipTypeDescribe =
	`Edge type. Prefer the canonical vocabulary \u2014 people edges per ADR-021, plus the hierarchy category (broader/narrower, SKOS Areas per ADR-033/#195: broader = child Area -> parent Area) \u2014 ${VOCAB_SUMMARY}. ` +
	"Synonyms auto-map ('mother' → parentOf, 'colleague' → colleagueOf); unknown phrases are " +
	"stored as 'other' with the raw value preserved in notes (soft validation \u2014 capture is never blocked). " +
	`General-purpose system edge types (legacy + Schema.org spine terms, ADR-033 / #192) also remain valid unchanged: ${EDGE_TYPES.join(", ")}. ` +
	"PARA containment (#170): 'belongs_to' is the PRIMARY containment edge \u2014 single-parent for project/resource sources (roll-ups/counting traverse it exclusively); " +
	"'associated_with' is the SECONDARY, non-counted containment edge (zero or more per entity) for a project/resource's other relevant Areas.";

const relationshipItemSchema = z.object({
	from_entity_id: z
		.string()
		.uuid()
		.describe("Source entity id (from upsert_entity or search)."),
	to_entity_id: z.string().uuid().describe("Target entity id."),
	relationship_type: z
		.string()
		.min(1)
		.describe(relationshipTypeDescribe),
	...singleEdgeOptionalFields,
});

export const entityRelateInput = {
	from_entity_id: z
		.string()
		.uuid()
		.optional()
		.describe("Source entity id (from upsert_entity or search). Required unless `relationships` is provided."),
	to_entity_id: z
		.string()
		.uuid()
		.optional()
		.describe("Target entity id. Required unless `relationships` is provided."),
	relationship_type: z
		.string()
		.min(1)
		.optional()
		.describe(relationshipTypeDescribe),
	...singleEdgeOptionalFields,
	relationships: z
		.array(relationshipItemSchema)
		.min(1)
		.max(50)
		.optional()
		.describe(
			"Optional batch of 1–50 relationships to create, update, or archive in a single call (#1978). Each item runs through full single-edge validation and deduplication.",
		),
};

export const relateEntitiesInput = entityRelateInput;
export const entityRelateSchema = z.object(entityRelateInput);
export type EntityRelateInput = z.infer<typeof entityRelateSchema>;
type SingleEdgeArgs = z.infer<typeof relationshipItemSchema>;

export interface EntityRelateResult {
	text: string;
}

export type EntityRelateRepository = Required<
	Pick<
		EntityRepository,
		| "findEntityEndpoints"
		| "findLivePrimaryContainmentEdges"
		| "findRelationshipEdge"
		| "archiveEdge"
		| "archiveEdgesByIds"
		| "getRelationshipForSupersession"
		| "updateRelationshipEdge"
		| "insertRelationshipEdge"
	>
>;

export interface EntityRelateDeps {
	entities: EntityRelateRepository;
	ownerId?: string | (() => string | undefined);
}

export function formatEntityRelateMcp(result: EntityRelateResult): string {
	return result.text;
}

async function relateSingleEdge(
	repo: EntityRelateRepository,
	args: SingleEdgeArgs,
	userId: string | undefined,
): Promise<string> {
	if (args.from_entity_id === args.to_entity_id) {
		throw new Error("from_entity_id and to_entity_id must differ (no self-edges).");
	}

	const clearWindow = args.clear_window ?? false;
	if (clearWindow && (args.valid_from !== undefined || args.valid_to !== undefined)) {
		throw new Error(
			"clear_window cannot be combined with valid_from/valid_to \u2014 pass the dates to set a window, or clear_window: true to erase it.",
		);
	}

	const resolved = resolveRelationshipType(args.relationship_type);
	const edgeNotes = [args.notes, resolved.vocabNote].filter(Boolean).join(" | ") || null;
	const normalisedSuffix =
		resolved.type === args.relationship_type.trim()
			? ""
			: ` (normalised from "${args.relationship_type.trim()}")`;

	const endpointRows = await repo.findEntityEndpoints(
		[args.from_entity_id, args.to_entity_id],
		userId,
	);
	const found = new Set(endpointRows.map((e) => e.id));
	if (!found.has(args.from_entity_id) || !found.has(args.to_entity_id)) {
		throw new Error(
			"Both entities must exist and belong to you \u2014 create them with upsert_entity first.",
		);
	}
	const fromEntityType =
		endpointRows.find((e) => e.id === args.from_entity_id)?.entity_type ?? undefined;

	let otherPrimariesToArchive: Array<{ id: string; to_entity_id: string }> = [];
	if (
		resolved.type === "belongs_to" &&
		!(args.archive ?? false) &&
		fromEntityType !== undefined &&
		PRIMARY_CONTAINMENT_SOURCE_TYPES.has(fromEntityType)
	) {
		const primaryRows = await repo.findLivePrimaryContainmentEdges(args.from_entity_id, userId);
		const otherPrimaries = primaryRows.filter((r) => r.to_entity_id !== args.to_entity_id);
		if (otherPrimaries.length > 0) {
			if (!(args.overwrite ?? false)) {
				throw new Error(
					`Refusing to add a 2nd primary containment parent: ${args.from_entity_id} already has a live 'belongs_to' edge to ${otherPrimaries
						.map((r) => r.to_entity_id)
						.join(", ")}. PARA keeps ONE primary parent per ${fromEntityType} \u2014 roll-ups and counting traverse primary 'belongs_to' edges only (#170). To link ${args.to_entity_id} as an additional, non-counted secondary area instead, use relationship_type 'associated_with'. To re-point the primary parent here (archiving the current primary edge), pass overwrite: true.`,
				);
			}
			otherPrimariesToArchive = otherPrimaries;
		}
	}

	const existing = await repo.findRelationshipEdge(
		args.from_entity_id,
		args.to_entity_id,
		resolved.type,
		userId,
	);

	const archive = args.archive ?? false;
	const rawType = args.relationship_type.trim();
	let archiveTarget: { id: string } | null = existing;
	let archivedType = resolved.type;
	if (archive && !existing && rawType !== resolved.type) {
		const legacy = await repo.findRelationshipEdge(
			args.from_entity_id,
			args.to_entity_id,
			rawType,
			userId,
		);
		if (legacy) {
			archiveTarget = legacy;
			archivedType = rawType;
		}
	}

	if (archive && archiveTarget) {
		try {
			await repo.archiveEdge(archiveTarget.id, userId);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Archive edge failed: ${msg}`);
		}
		const legacySuffix =
			archivedType === resolved.type
				? ""
				: ` (matched the stored legacy type "${archivedType}" rather than its normalised form "${resolved.type}")`;
		return `Archived edge ${archiveTarget.id}: ${args.from_entity_id} -[${archivedType}]-> ${args.to_entity_id}.${legacySuffix}`;
	}

	if (archive) {
		return `No edge to archive: ${args.from_entity_id} -[${resolved.type}]-> ${args.to_entity_id} does not exist.`;
	}

	let supersededEdge: {
		id: string;
		user_id?: string;
		valid_from: string | null;
		valid_to: string | null;
		metadata: unknown;
	} | null = null;
	if (args.supersedes_relationship_id) {
		if (existing && existing.id === args.supersedes_relationship_id) {
			throw new Error(
				`Cannot supersede edge ${args.supersedes_relationship_id} with itself.`,
			);
		}
		const typedSup = await repo.getRelationshipForSupersession(
			args.supersedes_relationship_id,
			userId,
		);
		if (!typedSup || (typedSup.user_id !== undefined && userId && typedSup.user_id !== userId)) {
			throw new Error(
				`Superseded edge ${args.supersedes_relationship_id} not found or does not belong to you.`,
			);
		}
		supersededEdge = typedSup;
	}

	const applySupersessionToOldEdge = async (newEdgeId: string) => {
		if (!supersededEdge) return;
		const closureValidTo =
			supersededEdge.valid_to ?? args.valid_from ?? new Date().toISOString();
		const supersededMetadata = isPlainObject(supersededEdge.metadata)
			? supersededEdge.metadata
			: {};
		try {
			await repo.updateRelationshipEdge(
				supersededEdge.id,
				{
					valid_to: closureValidTo,
					metadata: {
						...supersededMetadata,
						superseded_by_relationship_id: newEdgeId,
					},
				},
				userId,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Supersede edge update failed: ${msg}`);
		}
	};

	let archivedPrimaryCount = 0;
	const archiveOtherPrimariesIfNeeded = async () => {
		if (otherPrimariesToArchive.length === 0) return;
		await repo.archiveEdgesByIds(
			otherPrimariesToArchive.map((r) => r.id),
			userId,
		);
		archivedPrimaryCount = otherPrimariesToArchive.length;
	};

	const normalizedConfidence =
		args.confidence !== undefined
			? normalizeRelationshipConfidence(args.confidence)
			: undefined;

	if (existing) {
		const existingWindow = {
			valid_from: existing.valid_from ?? null,
			valid_to: existing.valid_to ?? null,
		};
		const nextFrom = clearWindow ? null : (args.valid_from ?? existingWindow.valid_from);
		const nextTo = clearWindow ? null : (args.valid_to ?? existingWindow.valid_to);

		assertValidWindow(nextFrom, nextTo);

		if (
			!(args.overwrite ?? false) &&
			!clearWindow &&
			temporalCollision(existingWindow, nextFrom, nextTo)
		) {
			throw new Error(
				`Refusing to overwrite edge ${existing.id}: a '${resolved.type}' edge ${args.from_entity_id} -> ${args.to_entity_id} already spans ${existingWindow.valid_from ?? "…"}–${existingWindow.valid_to ?? "…"}, but you're writing ${nextFrom ?? "…"}–${nextTo ?? "…"} \u2014 a 2nd distinct fact between the same pair (ADR-035 collision-at-2). Overwriting would silently drop the first fact's dates. To keep BOTH facts, reify with entity_promote_edge (edge_id: ${existing.id}, kind e.g. 'employment', one arrangement per window). To intentionally CORRECT this edge's dates instead, pass overwrite: true.`,
			);
		}

		await archiveOtherPrimariesIfNeeded();
		const repointSuffix =
			archivedPrimaryCount > 0
				? ` (primary parent re-pointed: ${archivedPrimaryCount} previous 'belongs_to' edge${archivedPrimaryCount === 1 ? "" : "s"} archived)`
				: "";

		const nextConfidence =
			normalizedConfidence ??
			normalizeRelationshipConfidence(existing.confidence_score) ??
			null;

		const existingMetadata = isPlainObject(existing.metadata) ? existing.metadata : {};
		const mergedMetadata =
			args.metadata === undefined
				? existingMetadata
				: mergeMetadataPatch(existingMetadata, args.metadata);
		const nextMetadata = args.supersedes_relationship_id
			? { ...mergedMetadata, supersedes_relationship_id: args.supersedes_relationship_id }
			: mergedMetadata;

		const nextNotes = nextNotesValue(
			existing.notes ?? null,
			args.notes,
			resolved.type,
			resolved.vocabNote,
		);

		try {
			await repo.updateRelationshipEdge(
				existing.id,
				{
					confidence_score: nextConfidence,
					metadata: nextMetadata,
					notes: nextNotes,
					valid_from: nextFrom,
					valid_to: nextTo,
					archived: false,
				},
				userId,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Update edge failed: ${msg}`);
		}

		await applySupersessionToOldEdge(existing.id);
		const resurrectedSuffix = existing.archived ? " (un-archived)" : "";
		return `Updated edge ${existing.id}: ${args.from_entity_id} -[${resolved.type}]-> ${args.to_entity_id}.${normalisedSuffix}${resurrectedSuffix}${repointSuffix}`;
	}

	assertValidWindow(args.valid_from ?? null, args.valid_to ?? null);

	await archiveOtherPrimariesIfNeeded();
	const repointSuffix =
		archivedPrimaryCount > 0
			? ` (primary parent re-pointed: ${archivedPrimaryCount} previous 'belongs_to' edge${archivedPrimaryCount === 1 ? "" : "s"} archived)`
			: "";

	const insertMetadata = args.supersedes_relationship_id
		? { ...(args.metadata ?? {}), supersedes_relationship_id: args.supersedes_relationship_id }
		: (args.metadata ?? {});

	const created = await repo.insertRelationshipEdge(
		{
			from_entity_id: args.from_entity_id,
			to_entity_id: args.to_entity_id,
			relationship_type: resolved.type,
			confidence_score: normalizedConfidence ?? null,
			metadata: insertMetadata,
			created_by: "mcp",
			notes: edgeNotes,
			valid_from: args.valid_from ?? null,
			valid_to: args.valid_to ?? null,
		},
		userId,
	);
	await applySupersessionToOldEdge(created.id);
	return `Created edge ${created.id}: ${args.from_entity_id} -[${resolved.type}]-> ${args.to_entity_id}.${normalisedSuffix}${repointSuffix}`;
}

export function createEntityRelateAction(
	depsOrRepo: EntityRelateRepository | EntityRelateDeps,
): ActionDefinition<typeof entityRelateSchema, EntityRelateResult> {
	const deps: EntityRelateDeps = Object.prototype.hasOwnProperty.call(depsOrRepo, "entities")
		? (depsOrRepo as EntityRelateDeps)
		: { entities: depsOrRepo as EntityRelateRepository };

	return defineAction({
		id: "entity_relate",
		name: "entity_relate",
		description: ENTITY_RELATE_DESCRIPTION,
		domain: "kg",
		schema: entityRelateSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (args: EntityRelateInput, ctx) => {
			const userId =
				ctx.userId ??
				(typeof deps.ownerId === "function" ? deps.ownerId() : deps.ownerId);

			if (args.relationships && args.relationships.length > 0) {
				const results: string[] = [];
				for (const item of args.relationships) {
					results.push(await relateSingleEdge(deps.entities, item, userId));
				}
				return {
					text: `Processed ${results.length} relationship(s):\n${results.map((r) => `• ${r}`).join("\n")}`,
				};
			}

			if (!args.from_entity_id || !args.to_entity_id || !args.relationship_type) {
				throw new Error(
					"Relate entities failed: provide from_entity_id, to_entity_id, and relationship_type, or a non-empty relationships array.",
				);
			}

			const text = await relateSingleEdge(
				deps.entities,
				{
					from_entity_id: args.from_entity_id,
					to_entity_id: args.to_entity_id,
					relationship_type: args.relationship_type,
					confidence: args.confidence,
					metadata: args.metadata,
					notes: args.notes,
					valid_from: args.valid_from,
					valid_to: args.valid_to,
					clear_window: args.clear_window,
					archive: args.archive,
					overwrite: args.overwrite,
					supersedes_relationship_id: args.supersedes_relationship_id,
				},
				userId,
			);
			return { text };
		},
		formatMcp: formatEntityRelateMcp,
	});
}
