import { z } from "zod";
import { collectAliases } from "../../domain/aliases.js";
import { embedAndStore, type EntityEmbedFields } from "../../domain/embeddings.js";
import type { EmbeddingPort, EmbeddingStorePort } from "../../ports/embeddings.js";
import type { EntityRepository, LinkRepository, SyncEntityRow } from "../../ports/entities.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

const sourceEntityFields = {
	id: z.string().uuid().optional().describe("Existing entity id, if already known."),
	entity_type: z.string().min(1).describe("Entity type, e.g. people, organization, event, task, fact, signal."),
	title: z.string().min(1).describe("Entity title from the source artifact."),
	description: z.string().optional().describe("Optional summary / notes from the source artifact."),
	email: z.string().email().optional().describe("Optional email address to persist as a property."),
	phone: z.string().optional().describe("Optional phone number to persist as a property."),
	organization: z.string().optional().describe("Optional organization to persist as a property."),
	role: z.string().optional().describe("Optional role to persist as a property."),
	relationship: z.string().optional().describe("Optional relationship clue to persist as a property."),
	address: z.string().optional().describe("Optional address to persist as a property."),
	website: z.string().url().optional().describe("Optional website/domain to persist as a property."),
	confidence: z.number().min(0).max(1).optional().describe("Optional extraction confidence."),
	tags: z.array(z.string()).optional().describe("Optional tags to persist on create."),
	properties: z.record(z.string(), z.unknown()).optional().describe("Extra structured properties."),
};

export const artifactEntitySyncInput = {
	artifact_id: z.string().uuid().describe("Artifact id to attach entity links to."),
	entities: z
		.array(z.object(sourceEntityFields))
		.min(1)
		.max(100)
		.describe("Extracted entities to resolve, create if needed, and link."),
	link_type: z.string().min(1).optional().describe("Artifact-entity link type. Defaults to 'mentioned'."),
	created_by: z
		.string()
		.optional()
		.describe("Optional provenance label for link rows. Defaults to 'artifact_entity_sync'."),
} as const;

export const artifactSyncEntitiesSchema = z.object(artifactEntitySyncInput);

export type ArtifactSyncEntitiesInput = z.infer<typeof artifactSyncEntitiesSchema>;
export type SourceEntity = ArtifactSyncEntitiesInput["entities"][number];

export interface ArtifactSyncItemResult {
	input: string;
	type: string;
	action: "created" | "linked-existing";
	entity_id: string;
	title: string;
	link_id: string | null;
}

export interface ArtifactSyncEntitiesResult {
	artifact_id: string;
	created: number;
	reused: number;
	results: ArtifactSyncItemResult[];
}

export interface ArtifactSyncDeps {
	entities: EntityRepository;
	links: LinkRepository;
	embedding?: EmbeddingPort | null | (() => EmbeddingPort | null | undefined);
	embeddingStore?: EmbeddingStorePort;
	embedEntity?: (id: string, fields: EntityEmbedFields) => Promise<unknown>;
}

export const ARTIFACT_SYNC_ENTITIES_DESCRIPTION =
	"Resolve extracted entities against the entities table, create missing rows, and link all resolved entities back to the artifact in one idempotent pass.";

const noopEmbeddingStore: EmbeddingStorePort = {
	setEmbedding: async () => {},
};

function normalize(value: string | undefined | null): string | null {
	return value?.trim().toLowerCase() ?? null;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasBoundedPartialMatch(a: string, b: string): boolean {
	if (!a || !b || a === b) return false;
	const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
	if (shorter.length < 4) return false;
	return new RegExp(`(?:^|\\b|\\s)${escapeRegExp(shorter)}(?:$|\\b|\\s)`, "i").test(longer);
}

/**
 * `properties.place_type` for a place entity (city | address | venue | region |
 * country, open-vocab — issue #188). Undefined for non-place entities/sources.
 */
function placeType(properties: Record<string, unknown> | null | undefined): string | null {
	const value = properties?.place_type;
	return typeof value === "string" ? normalize(value) : null;
}

function buildProperties(entity: SourceEntity): Record<string, unknown> {
	return {
		...(entity.properties ?? {}),
		...(entity.email !== undefined ? { email: entity.email } : {}),
		...(entity.phone !== undefined ? { phone: entity.phone } : {}),
		...(entity.organization !== undefined ? { organization: entity.organization } : {}),
		...(entity.role !== undefined ? { role: entity.role } : {}),
		...(entity.relationship !== undefined ? { relationship: entity.relationship } : {}),
		...(entity.address !== undefined ? { address: entity.address } : {}),
		...(entity.website !== undefined ? { website: entity.website } : {}),
		...(entity.confidence !== undefined ? { confidence: entity.confidence } : {}),
	};
}

export function scoreSyncCandidate(entity: SyncEntityRow, source: SourceEntity): number {
	const entityTitle = normalize(entity.title);
	const sourceTitle = normalize(source.title);
	const aliases = collectAliases(entity)
		.map((alias) => normalize(alias))
		.filter((alias): alias is string => Boolean(alias));

	const exactTitle = Boolean(entityTitle && sourceTitle && entityTitle === sourceTitle);
	const exactAlias = Boolean(!exactTitle && sourceTitle && aliases.some((alias) => alias === sourceTitle));
	const partialTitle = Boolean(
		!exactTitle &&
			!exactAlias &&
			entityTitle &&
			sourceTitle &&
			hasBoundedPartialMatch(entityTitle, sourceTitle),
	);
	const partialAlias = Boolean(
		!exactTitle &&
			!exactAlias &&
			!partialTitle &&
			sourceTitle &&
			aliases.some((alias) => hasBoundedPartialMatch(alias, sourceTitle)),
	);
	// Never allow non-title signals (entity_type +50 and tag overlap +10 = 60)
	// to cross the >=60 fuzzy match acceptance threshold when titles/aliases do not match at all.
	if (!exactTitle && !exactAlias && !partialTitle && !partialAlias) return 0;

	let score = 0;
	if (normalize(entity.entity_type) === normalize(source.entity_type)) score += 50;
	if (exactTitle || exactAlias) score += 60;
	else if (partialTitle || partialAlias) score += 35;
	if (source.description && normalize(entity.description)?.includes(normalize(source.description) ?? "")) score += 10;
	if (source.tags?.length && entity.tags?.some((tag) => source.tags?.some((needle) => normalize(tag) === normalize(needle)))) score += 10;
	// Place disambiguation (#188): a title collision between two DIFFERENT kinds
	// of place ("Edinburgh" the city vs. a venue also named "Edinburgh") must not
	// merge them. Only applied when both sides declare a place_type -- absence of
	// one isn't evidence of a mismatch, so it stays neutral rather than penalised.
	if (normalize(entity.entity_type) === "place" && normalize(source.entity_type) === "place") {
		const sourcePlaceType = placeType(source.properties);
		const entityPlaceType = placeType(entity.properties);
		if (sourcePlaceType && entityPlaceType) {
			score += sourcePlaceType === entityPlaceType ? 15 : -100;
		}
	}
	if (entity.archived) score -= 15;
	return score;
}

async function embedCreatedEntity(deps: ArtifactSyncDeps, created: SyncEntityRow): Promise<void> {
	const fields: EntityEmbedFields = {
		title: created.title,
		description: created.description,
		properties: created.properties,
	};
	const embeddingPort = typeof deps.embedding === "function" ? deps.embedding() : deps.embedding;
	if (!embeddingPort && deps.embedEntity) {
		await deps.embedEntity(created.id, fields);
		return;
	}
	if (embeddingPort && deps.embeddingStore) {
		await embedAndStore(embeddingPort, deps.embeddingStore ?? noopEmbeddingStore, "entities", created.id, fields);
	}
}

export function formatArtifactSyncEntitiesMcp(result: ArtifactSyncEntitiesResult): string {
	return (
		`Synced ${result.results.length} entities to artifact ${result.artifact_id}: ` +
		`${result.created} created, ${result.reused} matched/linked.\n` +
		result.results
			.map(
				(item) =>
					`• ${item.title} (${item.type}) [${item.entity_id}] ${item.action}${item.link_id ? `; link ${item.link_id}` : ""}`,
			)
			.join("\n")
	);
}

export function createArtifactSyncEntitiesAction(
	deps: ArtifactSyncDeps,
): ActionDefinition<typeof artifactSyncEntitiesSchema, ArtifactSyncEntitiesResult> {
	return defineAction({
		id: "artifact_sync_entities",
		name: "artifact_sync_entities",
		description: ARTIFACT_SYNC_ENTITIES_DESCRIPTION,
		domain: "kg",
		schema: artifactSyncEntitiesSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (args, ctx) => {
			if (!deps.entities.findExactForSync || !deps.entities.findSyncCandidates || !deps.entities.createForSync) {
				throw new Error("EntityRepository sync methods are not configured.");
			}
			if (!deps.links.upsert) {
				throw new Error("LinkRepository.upsert is not configured.");
			}

			const linkType = args.link_type ?? "mentioned";
			// The tool was renamed to `artifact_sync_entities` by #1061, but this label is PERSISTED on
			// every link row it has ever written. Changing the default would split the
			// ledger in two across one deploy, with no migration and no way to tell from a
			// row which half it belongs to. The rename is a rename; it writes no new data.
			const createdBy = args.created_by ?? "artifact_entity_sync";
			const results: ArtifactSyncItemResult[] = [];

			for (const source of args.entities) {
				const sourcePlaceType =
					normalize(source.entity_type) === "place" ? placeType(source.properties) : null;
				let entity: SyncEntityRow | null = null;
				let action: "created" | "linked-existing" = "linked-existing";

				entity = await deps.entities.findExactForSync(
					{
						id: source.id,
						entity_type: source.entity_type,
						title: source.title,
						place_type: sourcePlaceType,
					},
					ctx.userId,
				);

				if (!entity) {
					const candidates = await deps.entities.findSyncCandidates(
						{
							entity_type: source.entity_type,
							title: source.title,
						},
						ctx.userId,
					);
					if (candidates.length > 0) {
						const ranked = candidates
							.map((candidate) => ({ entity: candidate, score: scoreSyncCandidate(candidate, source) }))
							.sort((a, b) => b.score - a.score);
						if (ranked[0] && ranked[0].score >= 60) {
							entity = ranked[0].entity;
						}
					}
				}

				if (!entity) {
					const { created: createdRow, conflict } = await deps.entities.createForSync(
						{
							id: globalThis.crypto.randomUUID(),
							entity_type: source.entity_type,
							title: source.title,
							description: source.description ?? null,
							tags: source.tags ?? [],
							properties: buildProperties(source),
						},
						ctx.userId,
					);
					if (conflict) {
						const existing = await deps.entities.findExactForSync(
							{
								id: source.id,
								entity_type: source.entity_type,
								title: source.title,
								place_type: sourcePlaceType,
							},
							ctx.userId,
						);
						if (existing) {
							entity = existing;
						} else {
							throw new Error(`Entity create failed: unique constraint conflict for ${source.title}`);
						}
					} else if (createdRow) {
						entity = createdRow;
						action = "created";
						await embedCreatedEntity(deps, createdRow);
					}
				}

				if (!entity) {
					throw new Error(`Entity sync failed to resolve or create ${source.title}`);
				}

				const upsertedLinks = await deps.links.upsert(
					[
						{
							artifact_id: args.artifact_id,
							entity_id: entity.id,
							link_type: linkType,
							created_by: createdBy,
						},
					],
					{ userId: ctx.userId },
				);
				const link = upsertedLinks[0] ?? null;

				results.push({
					input: source.title,
					type: entity.entity_type,
					action,
					entity_id: entity.id,
					title: entity.title ?? source.title,
					link_id: link?.id || null,
				});
			}

			const created = results.filter((result) => result.action === "created").length;
			const reused = results.length - created;
			return {
				artifact_id: args.artifact_id,
				created,
				reused,
				results,
			};
		},
		formatMcp: formatArtifactSyncEntitiesMcp,
	});
}
