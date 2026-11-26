import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import type { ArtifactEntityLinkRow, LinkRepository } from "../../ports/entities.js";

function linkItemSchema() {
	return z.object({
		artifact_id: z.string().uuid().describe("Artifact id."),
		entity_id: z.string().uuid().describe("Entity id."),
		link_type: z
			.string()
			.optional()
			.describe("Optional relationship label. Defaults to 'related'."),
		confidence_score: z
			.number()
			.min(0)
			.max(1)
			.optional()
			.describe("Optional confidence score between 0 and 1."),
		created_by: z.string().optional().describe("Optional provenance label."),
		notes: z.string().optional().describe("Optional notes."),
	});
}

export const artifactEntityLinkGetInput = {
	id: z.string().uuid().describe("Link id."),
} as const;

export const artifactEntityLinkQueryInput = {
	artifact_id: z.string().uuid().optional().describe("Filter by artifact id."),
	entity_id: z.string().uuid().optional().describe("Filter by entity id."),
	link_type: z.string().optional().describe("Filter by link type."),
	limit: z.number().int().min(1).max(100).optional().describe("Max rows to return (default 20)."),
} as const;

export const artifactEntityLinkCreateInput = {
	links: z
		.array(linkItemSchema())
		.min(1)
		.max(100)
		.describe("One or many artifact-entity links to create."),
} as const;

export const artifactEntityLinkDeleteInput = {
	id: z.string().uuid().describe("Link id."),
} as const;

export const artifactEntityLinkUpsertInput = {
	links: z
		.array(linkItemSchema())
		.min(1)
		.max(100)
		.describe("One or many artifact-entity links to upsert."),
	mark_artifact_derived: z
		.boolean()
		.optional()
		.describe(
			"When true, stamps processing_metadata.derivation = { status: 'completed', derived_at, attempts: 1, provider: 'interactive' } on each distinct artifact_id in links via set_artifact_derivation (#1978).",
		),
} as const;

export const artifactEntityLinkGetSchema = z.object(artifactEntityLinkGetInput);
export const artifactEntityLinkQuerySchema = z.object(artifactEntityLinkQueryInput);
export const artifactEntityLinkCreateSchema = z.object(artifactEntityLinkCreateInput);
export const artifactEntityLinkDeleteSchema = z.object(artifactEntityLinkDeleteInput);
export const artifactEntityLinkUpsertSchema = z.object(artifactEntityLinkUpsertInput);

export type ArtifactEntityLinkGetInput = z.infer<typeof artifactEntityLinkGetSchema>;
export type ArtifactEntityLinkQueryInput = z.infer<typeof artifactEntityLinkQuerySchema>;
export type ArtifactEntityLinkCreateInput = z.infer<typeof artifactEntityLinkCreateSchema>;
export type ArtifactEntityLinkDeleteInput = z.infer<typeof artifactEntityLinkDeleteSchema>;
export type ArtifactEntityLinkUpsertInput = z.infer<typeof artifactEntityLinkUpsertSchema>;

export interface LinkGetResult {
	link: ArtifactEntityLinkRow | null;
}

export interface LinkQueryResult {
	rows: ArtifactEntityLinkRow[];
}

export interface LinkCreateResult {
	rows: Array<{ id: string; artifact_id: string; entity_id: string }>;
	count: number;
}

export interface LinkUpsertResult {
	rows: Array<{ id: string; artifact_id: string; entity_id: string; link_type: string | null }>;
	count: number;
}

export interface LinkDeleteResult {
	id: string;
	deleted: boolean;
	rows: Array<{ id: string; artifact_id: string; entity_id: string }>;
}

export const LINK_GET_DESCRIPTION = "Read one artifact-entity link by id.";
export const LINK_QUERY_DESCRIPTION =
	"Read artifact-entity links with optional artifact, entity, or link_type filters.";
export const LINK_CREATE_DESCRIPTION = "Create one or many artifact-entity links.";
export const LINK_UPSERT_DESCRIPTION =
	"Create or update one or many artifact-entity links using the unique artifact/entity/link_type key. On an existing link, omitted optional fields (confidence_score, created_by, notes) are left unchanged.";
export const LINK_DELETE_DESCRIPTION = "Delete one artifact-entity link by id.";

export function formatArtifactEntityLinkRow(row: ArtifactEntityLinkRow): string {
	return `• [${row.id}] artifact=${row.artifact_id} entity=${row.entity_id} type=${row.link_type ?? "related"} score=${row.confidence_score ?? "n/a"} created_at=${row.created_at}`;
}

export function formatLinkGetMcp(result: LinkGetResult): string {
	if (!result.link) {
		return "No artifact-entity link found.";
	}
	return formatArtifactEntityLinkRow(result.link);
}

export function formatLinkQueryMcp(result: LinkQueryResult): string {
	if (result.rows.length === 0) {
		return "No artifact-entity links found.";
	}
	return `Artifact-entity links (${result.rows.length}):\n${result.rows.map(formatArtifactEntityLinkRow).join("\n")}`;
}

export function formatLinkCreateMcp(result: LinkCreateResult): string {
	return `Created ${result.count} artifact-entity link(s).`;
}

export function formatLinkUpsertMcp(result: LinkUpsertResult): string {
	return `Upserted ${result.count} artifact-entity link(s).`;
}

export function formatLinkDeleteMcp(result: LinkDeleteResult): string {
	if (!result.deleted) {
		return "No artifact-entity link deleted.";
	}
	return `Deleted artifact-entity link ${result.id}.`;
}

export function createLinkGetAction(
	port: LinkRepository,
): ActionDefinition<typeof artifactEntityLinkGetSchema, LinkGetResult> {
	return defineAction({
		id: "link_get",
		name: "link_get",
		description: LINK_GET_DESCRIPTION,
		domain: "kg",
		schema: artifactEntityLinkGetSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (input, ctx) => {
			const link = await port.get(input.id, ctx.userId);
			return { link };
		},
		formatMcp: formatLinkGetMcp,
	});
}

export function createLinkQueryAction(
	port: LinkRepository,
): ActionDefinition<typeof artifactEntityLinkQuerySchema, LinkQueryResult> {
	return defineAction({
		id: "link_query",
		name: "link_query",
		description: LINK_QUERY_DESCRIPTION,
		domain: "kg",
		schema: artifactEntityLinkQuerySchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (input, ctx) => {
			const rows = await port.query(input, ctx.userId);
			return { rows };
		},
		formatMcp: formatLinkQueryMcp,
	});
}

export function createLinkCreateAction(
	port: LinkRepository,
): ActionDefinition<typeof artifactEntityLinkCreateSchema, LinkCreateResult> {
	return defineAction({
		id: "link_create",
		name: "link_create",
		description: LINK_CREATE_DESCRIPTION,
		domain: "kg",
		schema: artifactEntityLinkCreateSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		run: async (input, ctx) => {
			if (!port.create) {
				throw new Error("LinkRepository.create is not configured.");
			}
			const rows = await port.create(input.links, ctx.userId);
			return { rows, count: rows.length };
		},
		formatMcp: formatLinkCreateMcp,
	});
}

export function createLinkUpsertAction(
	port: LinkRepository,
): ActionDefinition<typeof artifactEntityLinkUpsertSchema, LinkUpsertResult> {
	return defineAction({
		id: "link_upsert",
		name: "link_upsert",
		description: LINK_UPSERT_DESCRIPTION,
		domain: "kg",
		schema: artifactEntityLinkUpsertSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (input, ctx) => {
			if (!port.upsert) {
				throw new Error("LinkRepository.upsert is not configured.");
			}
			const rows = await port.upsert(input.links, {
				markArtifactDerived: input.mark_artifact_derived,
				userId: ctx.userId,
			});
			return { rows, count: rows.length };
		},
		formatMcp: formatLinkUpsertMcp,
	});
}

export function createLinkDeleteAction(
	port: LinkRepository,
): ActionDefinition<typeof artifactEntityLinkDeleteSchema, LinkDeleteResult> {
	return defineAction({
		id: "link_delete",
		name: "link_delete",
		description: LINK_DELETE_DESCRIPTION,
		domain: "kg",
		schema: artifactEntityLinkDeleteSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		run: async (input, ctx) => {
			if (!port.delete) {
				throw new Error("LinkRepository.delete is not configured.");
			}
			const rows = await port.delete(input.id, ctx.userId);
			return {
				id: input.id,
				deleted: rows.length > 0,
				rows,
			};
		},
		formatMcp: formatLinkDeleteMcp,
	});
}
