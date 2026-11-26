import type { z } from "zod";
import { DEFAULT_DOS_CONFIG, type DosConfig } from "../../domain/dosConfig.js";
import {
	embedAndStore,
	type EntityEmbedFields,
	type RetryOptions,
} from "../../domain/embeddings.js";
import {
	fetchPrimaryParentsBatch,
	resolveEntityDomainSafely,
} from "../../domain/entityDomain.js";
import type { EmbeddingPort, EmbeddingStorePort } from "../../ports/embeddings.js";
import {
	HARD_DELETE_APPROVAL_THRESHOLD,
	type EntitiesCrudResult,
	type EntitiesFilterInput,
	type EntityBulkDeleteInput,
	type EntityBulkDeleteResult,
	type EntityCreateInput,
	type EntityCreateResult,
	type EntityDeleteResult,
	type EntityGetInput,
	type EntityGetResult,
	type EntityHardDeleteCheckInput,
	type EntityLoadResult,
	type EntityQueryInput,
	type EntityQueryResult,
	type EntityRepository,
	type EntityRow,
	type EntityUpdateInput,
	type EntityUpdateResult,
	type EntityUpsertInput,
	type EntityUpsertResult,
} from "../../ports/entities.js";
import type { deleteSchema, EntityCrudInput } from "../domain/entities.js";
import type { ActionContext } from "../types.js";
import { SCAN_LIMIT } from "./format.js";

export interface CoreEntitiesDeps {
	repo: EntityRepository;
	embedding?: EmbeddingPort | null | (() => EmbeddingPort | null | undefined);
	embeddingStore?: EmbeddingStorePort;
	embedEntity?: (id: string, fields: EntityEmbedFields) => Promise<unknown>;
	loadDosConfig?: () => Promise<DosConfig>;
	retryOptions?: RetryOptions;
	onEmbedError?: (err: unknown, id: string) => void;
}

const noopEmbeddingStore: EmbeddingStorePort = {
	setEmbedding: async () => {},
};

function scopedDomainReader(repo: EntityRepository, userId?: string) {
	return {
		getDomainRow: (id: string) => repo.getDomainRow(id, userId),
		fetchPrimaryParentId: (id: string) => repo.fetchPrimaryParentId(id, userId),
		fetchPrimaryParentsBatch: (ids: readonly string[]) =>
			repo.fetchPrimaryParentsBatch(ids, userId),
	};
}

async function resolveDosConfig(deps: CoreEntitiesDeps): Promise<DosConfig> {
	return deps.loadDosConfig ? deps.loadDosConfig() : DEFAULT_DOS_CONFIG;
}

async function embedWrittenEntity(
	deps: CoreEntitiesDeps,
	row: {
		id: string;
		title: string | null;
		description?: string | null;
		properties?: Record<string, unknown> | null;
		aliases?: string[] | null;
	},
): Promise<void> {
	const fields: EntityEmbedFields = {
		title: row.title,
		description: row.description ?? null,
		properties: row.properties ?? null,
		...(row.aliases !== undefined ? { aliases: row.aliases } : {}),
	};
	const embeddingPort =
		typeof deps.embedding === "function" ? deps.embedding() : deps.embedding;
	if (!embeddingPort && deps.embedEntity) {
		await deps.embedEntity(row.id, fields).catch((err: unknown) => {
			deps.onEmbedError?.(err, row.id);
		});
		return;
	}
	await embedAndStore(
		embeddingPort,
		deps.embeddingStore ?? noopEmbeddingStore,
		"entities",
		row.id,
		fields,
		{
			retryOptions: deps.retryOptions,
			onError: deps.onEmbedError ? (err) => deps.onEmbedError!(err, row.id) : undefined,
		},
	);
}

async function loadEntityRows(
	deps: CoreEntitiesDeps,
	filter: EntityQueryInput,
	userId?: string,
): Promise<EntityLoadResult> {
	const limit = filter.limit ?? 20;
	const { rows: loadedRows, truncated } = await deps.repo.loadRows(
		filter.domain ? { ...filter, limit: SCAN_LIMIT } : filter,
		userId,
	);
	if (!filter.domain || loadedRows.length === 0) {
		return { rows: loadedRows, truncated };
	}
	const reader = scopedDomainReader(deps.repo, userId);
	const [dosConfig, primaryParents] = await Promise.all([
		resolveDosConfig(deps),
		fetchPrimaryParentsBatch(reader, loadedRows.map((r) => r.id)),
	]);
	const resolutions = await Promise.all(
		loadedRows.map((r) =>
			resolveEntityDomainSafely(reader, r.id, { dosConfig, primaryParents }),
		),
	);
	const filtered = loadedRows.filter((_r, i) => resolutions[i].domain === filter.domain);
	return { rows: filtered.slice(0, limit), truncated };
}

async function resolveTargetRows(
	deps: CoreEntitiesDeps,
	args: { ids?: string[]; filter?: EntitiesFilterInput },
	userId?: string,
): Promise<EntityRow[]> {
	if (args.ids?.length) {
		const { rows } = await loadEntityRows(
			deps,
			{ ids: args.ids, limit: args.ids.length, include_archived: true },
			userId,
		);
		return rows;
	}
	if (args.filter) {
		const { rows } = await loadEntityRows(deps, { ...args.filter, limit: 100 }, userId);
		return rows;
	}
	return [];
}

async function resolveTargetIds(
	deps: CoreEntitiesDeps,
	args: { ids?: string[]; filter?: EntitiesFilterInput },
	userId?: string,
): Promise<string[]> {
	if (args.ids?.length) return args.ids;
	if (args.filter) {
		const rows = await resolveTargetRows(deps, args, userId);
		return rows.map((row) => row.id);
	}
	return [];
}

export async function entityHardDeleteNeedsApproval(
	deps: CoreEntitiesDeps,
	args: EntityHardDeleteCheckInput,
	userId?: string,
): Promise<boolean> {
	if (
		args.operation !== undefined &&
		args.operation !== "bulk_delete" &&
		!(args.operation === "delete" && (args.filter || (args.ids && args.ids.length > 1)))
	) {
		return false;
	}
	if (args.archive_only !== false || args.dry_run === true) return false;
	const ids = args.id ? [args.id, ...(args.ids ?? [])] : args.ids;
	if (ids?.length) return new Set(ids).size > HARD_DELETE_APPROVAL_THRESHOLD;
	return args.filter
		? (await resolveTargetRows(deps, { filter: args.filter }, userId)).length >
				HARD_DELETE_APPROVAL_THRESHOLD
		: false;
}

export async function entitiesCreateCore(
	deps: CoreEntitiesDeps,
	args: EntityCreateInput,
	userId?: string,
): Promise<EntityCreateResult> {
	const data = await deps.repo.insert(args.entities, userId);
	await Promise.all(data.map((row) => embedWrittenEntity(deps, row)));
	return {
		success: true,
		count: data.length,
		entities: data.map((row) => ({
			id: row.id,
			title: row.title,
			entity_type: row.entity_type,
			description: row.description ?? null,
			properties: row.properties ?? null,
		})),
	};
}

export async function entitiesGetCore(
	deps: CoreEntitiesDeps,
	args: EntityGetInput,
	userId?: string,
): Promise<EntityGetResult> {
	const entity = await deps.repo.getById(args.id, userId);
	if (!entity) return { found: false, entity: null };
	const reader = scopedDomainReader(deps.repo, userId);
	const domain = await resolveEntityDomainSafely(reader, args.id, {
		loadDosConfig: () => resolveDosConfig(deps),
	});
	return { found: true, entity, domain };
}

export async function entitiesQueryCore(
	deps: CoreEntitiesDeps,
	args: EntityQueryInput,
	userId?: string,
): Promise<EntityQueryResult> {
	const { rows, truncated } = await loadEntityRows(deps, args, userId);
	if (rows.length === 0) {
		return {
			count: 0,
			rows: [],
			truncated,
			domains: [],
			include_properties: args.include_properties,
		};
	}
	const reader = scopedDomainReader(deps.repo, userId);
	const [dosConfig, primaryParents] = await Promise.all([
		resolveDosConfig(deps),
		fetchPrimaryParentsBatch(
			reader,
			rows.map((row) => row.id),
		),
	]);
	const domains = await Promise.all(
		rows.map((row) =>
			resolveEntityDomainSafely(reader, row.id, { dosConfig, primaryParents }),
		),
	);
	return {
		count: rows.length,
		rows,
		truncated,
		domains,
		include_properties: args.include_properties,
	};
}

export async function entitiesUpdateCore(
	deps: CoreEntitiesDeps,
	args: EntityUpdateInput,
	userId?: string,
): Promise<EntityUpdateResult> {
	const ids = await resolveTargetIds(deps, args, userId);
	if (ids.length === 0) throw new Error("Entities update failed: provide ids or a filter.");
	const updated = await deps.repo.update(ids, args.patch, userId);
	await Promise.all(updated.map((row) => embedWrittenEntity(deps, row)));
	return {
		success: true,
		count: updated.length,
		updated: updated.map((row) => ({ id: row.id, title: row.title })),
	};
}

export async function entitiesDeleteCore(
	deps: CoreEntitiesDeps,
	args: z.infer<typeof deleteSchema>,
	userId?: string,
): Promise<EntityDeleteResult> {
	const ids = await resolveTargetIds(deps, args, userId);
	if (ids.length === 0) throw new Error("Entities delete failed: provide ids or a filter.");
	const archiveOnly = args.archive_only ?? true;
	const mutated = await deps.repo.mutateByIds(ids, archiveOnly, userId);
	return {
		success: true,
		count: mutated.length,
		archiveOnly,
		deleted: mutated.map((row) => ({ id: row.id, title: row.title })),
	};
}

export async function entitiesBulkDeleteCore(
	deps: CoreEntitiesDeps,
	args: EntityBulkDeleteInput,
	userId?: string,
): Promise<EntityBulkDeleteResult> {
	const targetRows = await resolveTargetRows(deps, args, userId);
	const ids = targetRows.map((r) => r.id);
	const archiveOnly = args.archive_only ?? true;

	if (ids.length === 0) {
		return {
			success: true,
			count: 0,
			archiveOnly,
			deleted: [],
			dryRun: Boolean(args.dry_run),
			sample: [],
			wouldDeleteIds: [],
		};
	}

	if (args.dry_run) {
		const sample = targetRows.slice(0, 5).map((r) => ({ id: r.id, title: r.title }));
		return {
			success: true,
			count: ids.length,
			archiveOnly,
			dryRun: true,
			sample,
			wouldDeleteIds: ids,
			deleted: [],
		};
	}

	const mutated = await deps.repo.mutateByIds(ids, archiveOnly, userId);
	return {
		success: true,
		count: mutated.length,
		archiveOnly,
		deleted: mutated.map((row) => ({ id: row.id, title: row.title })),
	};
}

export async function entitiesUpsertCore(
	deps: CoreEntitiesDeps,
	args: EntityUpsertInput,
	userId?: string,
): Promise<EntityUpsertResult> {
	const created: string[] = [];
	const updated: string[] = [];

	for (const entity of args.entities) {
		if (entity.id) {
			const data = await deps.repo.update(entity.id, entity, userId);
			const row = data[0];
			if (row) await embedWrittenEntity(deps, row);
			updated.push(entity.id);
			continue;
		}

		const data = await deps.repo.insert([entity], userId);
		const row = data[0];
		if (row) await embedWrittenEntity(deps, row);
		created.push(entity.title ?? "(untitled)");
	}

	return {
		success: true,
		count: args.entities.length,
		created,
		updated,
	};
}

export async function entityCrudRun(
	deps: CoreEntitiesDeps,
	args: EntityCrudInput,
	ctx?: ActionContext,
): Promise<EntitiesCrudResult> {
	switch (args.operation) {
		case "create": {
			if (!args.entities || args.entities.length === 0) {
				throw new Error("Entity create requires 'entities' array with at least one entity.");
			}
			const result = await entitiesCreateCore(deps, { entities: args.entities }, ctx?.userId);
			return { operation: "create", ...result };
		}
		case "get": {
			if (!args.id) {
				throw new Error("Entity get requires 'id'.");
			}
			const result = await entitiesGetCore(deps, { id: args.id }, ctx?.userId);
			return { operation: "get", ...result };
		}
		case "query": {
			const result = await entitiesQueryCore(
				deps,
				{
					query: args.query,
					entity_type: args.entity_type,
					local_name: args.local_name,
					namespace: args.namespace,
					ids: args.ids,
					team_id: args.team_id,
					user_id: args.user_id,
					include_archived: args.include_archived,
					limit: args.limit,
					include_properties: args.include_properties,
					created_before: args.created_before,
					updated_before: args.updated_before,
					tags: args.tags,
					domain: args.domain,
				},
				ctx?.userId,
			);
			return {
				operation: "query",
				...result,
				include_properties: args.include_properties ?? false,
			};
		}
		case "update": {
			if (!args.patch || Object.keys(args.patch).length === 0) {
				throw new Error("Entity update requires a non-empty 'patch'.");
			}
			const ids = args.id ? [args.id, ...(args.ids ?? [])] : args.ids;
			const result = await entitiesUpdateCore(
				deps,
				{
					ids,
					filter: args.filter,
					patch: args.patch,
				},
				ctx?.userId,
			);
			return { operation: "update", ...result };
		}
		case "delete": {
			if (args.dry_run || args.filter || (args.ids && args.ids.length > 1)) {
				const ids = args.id ? [args.id, ...(args.ids ?? [])] : args.ids;
				const result = await entitiesBulkDeleteCore(
					deps,
					{
						ids,
						filter: args.filter,
						archive_only: args.archive_only,
						dry_run: args.dry_run,
					},
					ctx?.userId,
				);
				return { operation: "delete", ...result };
			}

			if (!args.id && (!args.ids || args.ids.length === 0)) {
				throw new Error("Entity delete requires 'id', 'ids', or 'filter'.");
			}
			const ids = args.id ? [args.id] : args.ids!;
			const result = await entitiesDeleteCore(
				deps,
				{
					ids,
					archive_only: args.archive_only,
				},
				ctx?.userId,
			);
			return { operation: "delete", ...result };
		}
		case "bulk_delete": {
			const ids = args.id ? [args.id, ...(args.ids ?? [])] : args.ids;
			const result = await entitiesBulkDeleteCore(
				deps,
				{
					ids,
					filter: args.filter,
					archive_only: args.archive_only,
					dry_run: args.dry_run,
				},
				ctx?.userId,
			);
			return { operation: "bulk_delete", ...result };
		}
		case "upsert": {
			if (!args.entities || args.entities.length === 0) {
				throw new Error("Entity upsert requires 'entities' array with at least one entity.");
			}
			const result = await entitiesUpsertCore(deps, { entities: args.entities }, ctx?.userId);
			return { operation: "upsert", ...result };
		}
		default:
			throw new Error(
				`Unsupported entity operation: ${(args as { operation?: string }).operation}`,
			);
	}
}

export async function entityBulkDeleteRun(
	deps: CoreEntitiesDeps,
	args: EntityBulkDeleteInput,
	ctx?: ActionContext,
): Promise<EntityBulkDeleteResult> {
	return entitiesBulkDeleteCore(deps, args, ctx?.userId);
}
