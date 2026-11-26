import { z } from "zod";
import { DOMAINS, ENTITY_DOMAINS, type EntityDomain } from "../../domain/domains.js";
import { actionConfidenceSchema } from "../types.js";
import {
	TASK_EFFORT_SLUGS,
	TASK_ENERGY_MODE_SLUGS,
	TASK_SOURCE_SLUGS,
	TASK_STATUS_SLUGS,
	TASK_TYPE_SLUGS,
} from "../../domain/taskDimensions.js";

/**
 * Optional canonical dimension keys stored inside `entities.properties` JSONB for
 * actionable entity types (`project`, `arrangement`, `decision`, `event`; ADR-117).
 */
export const actionableEntityPropertiesSchema = z
	.object({
		priority_level: z.number().int().min(1).max(7).nullable().optional(),
		status: z.enum(TASK_STATUS_SLUGS).nullable().optional(),
		task_type: z.enum(TASK_TYPE_SLUGS).nullable().optional(),
		recurrence_rule: z.string().nullable().optional(),
		effort: z.enum(TASK_EFFORT_SLUGS).nullable().optional(),
		energy_mode: z.enum(TASK_ENERGY_MODE_SLUGS).nullable().optional(),
		source: z.enum(TASK_SOURCE_SLUGS).nullable().optional(),
	})
	.passthrough();

/**
 * Allowed `entities.entity_type` values — kept in sync with `entities_entity_type_check`
 * (migration 146, #2003), `ENTITY_TYPES` in `@ahkms/mcp-server`, and `GraphEntityType`
 * in `@ahkms/shared`.
 */
export const ENTITY_TYPES = [
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
] as const;

/**
 * Standard fields for knowledge graph entities (ADR-021, ADR-037, ADR-092, ADR-100).
 */
export const entityFields = {
	id: z.string().uuid().optional().describe("Existing entity id, used by update/upsert flows."),
	entity_type: z
		.enum(ENTITY_TYPES)
		.optional()
		.describe(
			"Entity type, e.g. people, organization, event, signal, term, decision. A 'term' is an acronym or piece of internal shorthand (PSR, P0, 'the migration'): title = the short form, properties.expansion = the long form, properties.context = the disambiguator (e.g. 'Work finance'), description = an optional one-line gloss (ADR-092, #1023).",
		),
	title: z.string().min(1).optional().describe("Human-readable entity title."),
	description: z.string().nullable().optional().describe("Short summary / notes."),
	archived: z.boolean().optional().describe("Archived state."),
	archived_at: z.string().datetime().nullable().optional().describe("Archived timestamp in ISO 8601."),
	properties: z.record(z.string(), z.unknown()).nullable().optional().describe("Structured entity properties."),
	tags: z.array(z.string()).nullable().optional().describe("Tags."),
	team_id: z.string().uuid().nullable().optional().describe("Optional team id."),
	source_url: z.string().nullable().optional().describe("URL of the external record that IS this entity (e.g. its Notion page), not pages that mention it. null = native to the graph (#426)."),
	domain_override: z
		.enum(ENTITY_DOMAINS)
		.nullable()
		.optional()
		.describe(
			"ADR-084 / ADR-107 escape hatch: the ONLY place an entity's domain is asserted rather than derived. Leave unset for the ordinary case. Set only for the residue neither rule reaches, or to correct a wrong derivation. Accepts 'work', 'angus', or 'cross-domain'.",
		),
	aliases: z
		.array(z.string())
		.optional()
		.describe(
			"Other names this entity answers to: short names, codenames, lowercase spellings (e.g. ['logicrays', 'LR']).",
		),
	hot: z
		.boolean()
		.optional()
		.describe(
			"Put this entity or term in the hot tier: the always-loaded decoder table shipped in every session's MCP instructions (ADR-092).",
		),
	local_name: z
		.string()
		.nullable()
		.optional()
		.describe("IRI local part (ADR-037 / #1104). Identifies seeded instance nodes and vocab terms. Null = no IRI identity."),
	namespace: z
		.string()
		.nullable()
		.optional()
		.describe("Namespace pointer for IRI identity (ADR-037 / #1104). Null means default 'ahos'."),
};

/** The row filter shared by entity_query, entity_bulk_delete, and bulk update `filter` arguments. */
export const entitiesFilterInput = {
	query: z.string().min(1).optional().describe("Filter by title, description, entity_type, tags, or properties stringification."),
	entity_type: z.enum(ENTITY_TYPES).optional().describe("Filter by entity type."),
	local_name: z.string().optional().describe("Filter by exact local_name."),
	namespace: z.string().optional().describe("Filter by namespace pointer (e.g. 'ahos' or namespace IRI)."),
	ids: z.array(z.string().uuid()).optional().describe("Limit the operation to these ids."),
	team_id: z.string().uuid().optional().describe("Filter by team id."),
	user_id: z.string().uuid().optional().describe("Filter by user id."),
	include_archived: z.boolean().optional().describe("Include archived rows. Defaults to false."),
	limit: z.number().int().min(1).max(100).optional().describe("Max rows returned after `query` is applied (default 20)."),
	created_before: z.string().datetime().optional().describe("Filter for rows created before this ISO 8601 timestamp."),
	updated_before: z.string().datetime().optional().describe("Filter for rows updated before this ISO 8601 timestamp."),
	tags: z.array(z.string()).optional().describe("Filter for rows containing all of these tags."),
	domain: z.enum(DOMAINS).optional().describe("Filter for rows matching this domain."),
} as const;

export const entitiesQueryInput = {
	...entitiesFilterInput,
	include_properties: z
		.boolean()
		.optional()
		.describe("Also print each row's full `properties` JSON on the line under it (default false)."),
} as const;

export const entitiesCreateInput = {
	entities: z.array(z.object(entityFields)).min(1).max(100).describe("One or many entities to create."),
	confidence: actionConfidenceSchema,
} as const;

export const entitiesUpdateInput = {
	ids: z.array(z.string().uuid()).optional().describe("Update only these ids."),
	filter: z.object(entitiesFilterInput).optional().describe("Optional filter to select rows for bulk update."),
	patch: z.object(entityFields).partial().refine((value) => Object.keys(value).length > 0, "Provide at least one field to update.").describe("Fields to change."),
} as const;

export const entitiesDeleteInput = {
	ids: z.array(z.string().uuid()).optional().describe("Delete only these ids."),
	filter: z.object(entitiesFilterInput).optional().describe("Optional filter to select rows for bulk delete."),
	archive_only: z.boolean().optional().describe("Archive instead of deleting. Defaults to true."),
	dry_run: z.boolean().optional().describe("Preview matching entities without deleting (defaults to false)."),
} as const;

export const entitySingleDeleteInput = {
	id: z.string().uuid().describe("Entity ID to delete or archive."),
	archive_only: z.boolean().optional().describe("Archive instead of deleting. Defaults to true."),
} as const;

export const entityBulkDeleteInput = {
	ids: z.array(z.string().uuid()).optional().describe("Entity IDs to delete in bulk."),
	filter: z.object(entitiesFilterInput).optional().describe("Optional filter criteria to select entities to delete in bulk."),
	archive_only: z.boolean().optional().describe("Archive instead of deleting. Defaults to true."),
	dry_run: z.boolean().optional().describe("Preview matching entities without deleting (defaults to false)."),
} as const;

export const entitiesGetInput = {
	id: z.string().uuid().describe("Entity id."),
} as const;

export const entitiesUpsertInput = {
	entities: z.array(z.object(entityFields)).min(1).max(100).describe("One or many entities to upsert."),
	confidence: actionConfidenceSchema,
} as const;

export const entityCrudInput = {
	operation: z
		.enum(["create", "get", "query", "update", "delete", "bulk_delete", "upsert"])
		.describe("CRUD operation to execute on entities."),
	id: z.string().uuid().optional().describe("Entity id for single get or delete, or single target for update."),
	ids: z.array(z.string().uuid()).optional().describe("Entity ids for bulk update/delete/query."),
	entities: z.array(z.object(entityFields)).optional().describe("One or many entities for create or upsert."),
	query: z.string().min(1).optional().describe("Filter by title, description, entity_type, tags, or properties for query."),
	title: z.string().optional().describe("Filter by exact or partial title for query, or title for create."),
	description: z.string().nullable().optional().describe("Description for create or update."),
	entity_type: z.enum(ENTITY_TYPES).optional().describe("Filter by entity type for query."),
	local_name: z.string().optional().describe("Filter by exact local_name for query."),
	namespace: z.string().optional().describe("Filter by namespace pointer for query."),
	team_id: z.string().uuid().optional().describe("Filter by team id for query."),
	user_id: z.string().uuid().optional().describe("Filter by user id for query."),
	include_archived: z.boolean().optional().describe("Include archived rows for query (defaults to false)."),
	include_properties: z.boolean().optional().describe("Include full properties JSON on query (defaults to false)."),
	limit: z.number().int().min(1).max(100).optional().describe("Max rows returned for query (defaults to 20)."),
	created_before: z.string().datetime().optional().describe("Filter for rows created before timestamp."),
	updated_before: z.string().datetime().optional().describe("Filter for rows updated before timestamp."),
	tags: z.array(z.string()).optional().describe("Filter for rows containing tags."),
	domain: z.enum(DOMAINS).optional().describe("Filter for rows matching domain."),
	filter: z.object(entitiesFilterInput).optional().describe("Optional filter to select rows for bulk update/delete."),
	patch: z.object(entityFields).partial().optional().describe("Fields to change on update."),
	archive_only: z.boolean().optional().describe("Archive instead of deleting on delete (defaults to true)."),
	dry_run: z.boolean().optional().describe("Preview matching entities without executing deletion."),
} as const;

export const filterSchema = z.object(entitiesFilterInput);
export const querySchema = z.object(entitiesQueryInput);
export const createSchema = z.object(entitiesCreateInput);
export const updateSchema = z.object(entitiesUpdateInput);
export const deleteSchema = z.object(entitiesDeleteInput);
export const singleDeleteSchema = z.object(entitySingleDeleteInput);
export const bulkDeleteSchema = z.object(entityBulkDeleteInput);
export const getSchema = z.object(entitiesGetInput);
export const upsertSchema = z.object(entitiesUpsertInput);
export const entityCrudSchema = z.object(entityCrudInput);

export type EntitiesFilterInput = z.infer<typeof filterSchema>;
export type EntityCrudInput = z.infer<typeof entityCrudSchema>;
export type EntityBulkDeleteInput = z.infer<typeof bulkDeleteSchema>;
export type EntityCreateInput = z.infer<typeof createSchema>;
export type EntityGetInput = z.infer<typeof getSchema>;
export type EntityQueryInput = z.infer<typeof querySchema>;
export type EntityUpdateInput = z.infer<typeof updateSchema>;
export type EntityDeleteInput = z.infer<typeof singleDeleteSchema>;
export type EntityUpsertInput = z.infer<typeof upsertSchema>;

export type ResolvedBy = "override" | "parent" | "signals" | "is_self" | "unresolved";

export type DomainResolution = {
	domain: EntityDomain | null;
	resolved_by: ResolvedBy;
	path?: string[];
};

export type EntityRow = {
	id: string;
	entity_type: string;
	title: string | null;
	description: string | null;
	archived: boolean | null;
	archived_at: string | null;
	properties: Record<string, unknown> | null;
	tags: string[] | null;
	source_url: string | null;
	user_id: string | null;
	team_id: string | null;
	created_at: string | null;
	updated_at: string | null;
	domain_override?: string | null;
	aliases?: string[] | null;
	hot?: boolean | null;
	local_name?: string | null;
	namespace?: string | null;
	[key: string]: unknown;
};

export type EntityCreateResult = {
	success: boolean;
	count: number;
	entities: Array<{
		id: string;
		title: string | null;
		entity_type: string;
		description?: string | null;
		properties?: Record<string, unknown> | null;
	}>;
};

export type EntityGetResult = {
	found: boolean;
	entity?: EntityRow | null;
	domain?: DomainResolution | null;
};

export type EntityQueryResult = {
	count: number;
	rows: EntityRow[];
	domains?: DomainResolution[];
	truncated?: boolean;
	include_properties?: boolean;
};

export type EntityUpdateResult = {
	success: boolean;
	count: number;
	updated: Array<{ id: string; title: string | null }>;
};

export type EntityDeleteResult = {
	success: boolean;
	count: number;
	archiveOnly: boolean;
	deleted: Array<{ id: string; title: string | null }>;
	dryRun?: boolean;
	sample?: Array<{ id: string; title: string | null }>;
	wouldDeleteIds?: string[];
};

export type EntityBulkDeleteResult = EntityDeleteResult;

export type EntityUpsertResult = {
	success: boolean;
	count: number;
	created: string[];
	updated: string[];
};

export type EntitiesCrudResult =
	| ({ operation: "create" } & EntityCreateResult)
	| ({ operation: "get" } & EntityGetResult)
	| ({ operation: "query"; include_properties?: boolean } & EntityQueryResult)
	| ({ operation: "update" } & EntityUpdateResult)
	| ({ operation: "delete" } & EntityDeleteResult)
	| ({ operation: "bulk_delete" } & EntityBulkDeleteResult)
	| ({ operation: "upsert" } & EntityUpsertResult);

/**
 * Lean select column list for entity queries across Web UI and Agent tool surfaces.
 * Omits heavy 1536-dimensional vector embeddings (`embedding`, `search_vector`)
 * to conserve network bandwidth, browser memory, and LLM context window tokens.
 */
export const ENTITY_SELECT_FIELDS =
	"id, title, entity_type, description, properties, tags, archived, archived_at, source_url, local_name, namespace, user_id, team_id, created_at, updated_at";

/**
 * Sanitizes entity database rows before passing them to LLMs or UI state.
 * Strips vector embeddings and truncates overly verbose description fields.
 */
export function sanitizeEntityRow(row: Record<string, unknown>): Record<string, unknown> {
	if (!row || typeof row !== "object") return row;
	const sanitized = { ...row };
	delete sanitized.embedding;
	delete sanitized.search_vector;

	if (typeof sanitized.description === "string" && sanitized.description.length > 500) {
		sanitized.description = sanitized.description.slice(0, 500) + "... [truncated]";
	}

	if (sanitized.properties && typeof sanitized.properties === "object" && !Array.isArray(sanitized.properties)) {
		const props = { ...(sanitized.properties as Record<string, unknown>) };
		for (const [key, val] of Object.entries(props)) {
			if (typeof val === "string" && val.length > 300) {
				props[key] = val.slice(0, 300) + "... [truncated]";
			}
		}
		sanitized.properties = props;
	}

	return sanitized;
}
