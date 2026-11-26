import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingColumnError, normalizeAliases } from "../../domain/aliases.js";
import type {
	ArtifactEntityLinkInput,
	ArtifactEntityLinkQueryFilter,
	ArtifactEntityLinkRow,
	EntityDomainRow,
	EntityEndpointRow,
	EntityInsertInput,
	EntityLoadFilter,
	EntityLoadResult,
	EntityPatchInput,
	EntityRepository,
	EntityRow,
	ExistingRelationshipEdgeRow,
	FindTrackedResourcesFilter,
	HotTierCandidateRow,
	HotTierCandidatesParams,
	HotTierCandidatesResult,
	LinkRepository,
	PrimaryContainmentEdgeRow,
	RelationshipDeleteTarget,
	RelationshipEdgeInsertInput,
	RelationshipEdgeUpdatePatch,
	RelationshipInsertRow,
	RelationshipQueryFilter,
	RelationshipUpdatePatch,
	SupersessionRelationshipEdgeRow,
	SyncEntityCreateInput,
	SyncEntityRow,
	TrackedEntityRow,
} from "../../ports/entities.js";
import type { RelationshipRecord } from "../../actions/domain/relationships.js";

export type EntitiesSupabaseClient = Pick<SupabaseClient, "from"> & Partial<Pick<SupabaseClient, "rpc">>;
export type LinksSupabaseClient = Pick<SupabaseClient, "from"> & Partial<Pick<SupabaseClient, "rpc">>;

export interface SupabaseEntityRepositoryOptions {
	client: EntitiesSupabaseClient;
	ownerId: string | (() => string | undefined);
}

export const SCAN_LIMIT = 2000;
export const BULK_DELETE_CONFIRMATION_THRESHOLD = 50;

export const ENTITY_BASE_COLUMNS =
	"id, entity_type, title, description, archived, archived_at, properties, tags, source_url, user_id, team_id, domain_override, created_at, updated_at";
export const ENTITY_110_COLUMNS = `${ENTITY_BASE_COLUMNS}, aliases, hot`;
export const ENTITY_115_ONLY_COLUMNS = `${ENTITY_BASE_COLUMNS}, local_name, namespace`;
export const ENTITY_COLUMNS = `${ENTITY_110_COLUMNS}, local_name, namespace`;
export const TRACKED_ENTITY_COLUMNS = "id, title, aliases, properties, archived";
export const TRACKED_ENTITY_COLUMNS_PRE_110 = "id, title, properties, archived";

export function matchesQuery(entity: EntityRow, needle: string): boolean {
	return [
		entity.entity_type,
		entity.title,
		entity.description,
		entity.tags?.join(" "),
		entity.source_url,
		entity.local_name,
		entity.namespace,
		...(entity.aliases ?? []),
		JSON.stringify(entity.properties ?? {}),
	]
		.filter((value): value is string => typeof value === "string")
		.some((value) => value.toLowerCase().includes(needle));
}

export async function withAliasColumns<
	T extends { error: { code?: string; message?: string } | null },
>(run: (columns: string) => PromiseLike<T>): Promise<T> {
	const first = await run(ENTITY_COLUMNS);
	if (!first.error) return first;

	if (isMissingColumnError(first.error, "aliases") || isMissingColumnError(first.error, "hot")) {
		const second = await run(ENTITY_115_ONLY_COLUMNS);
		if (!second.error) return second;
		if (
			isMissingColumnError(second.error, "local_name") ||
			isMissingColumnError(second.error, "namespace")
		) {
			return run(ENTITY_BASE_COLUMNS);
		}
		return second;
	}

	if (
		isMissingColumnError(first.error, "local_name") ||
		isMissingColumnError(first.error, "namespace")
	) {
		const second = await run(ENTITY_110_COLUMNS);
		if (!second.error) return second;
		if (isMissingColumnError(second.error, "aliases") || isMissingColumnError(second.error, "hot")) {
			return run(ENTITY_BASE_COLUMNS);
		}
		return second;
	}

	return first;
}

function normalizeSourceUrl(value: string | null | undefined): string | null | undefined {
	if (value === undefined) return undefined;
	return value === "" ? null : value;
}

function normalizeLocalName(value: string | null | undefined): string | null | undefined {
	if (value === undefined) return undefined;
	return value === "" ? null : value;
}

function normalizeNamespace(value: string | null | undefined): string | null | undefined {
	if (value === undefined) return undefined;
	return value === "" || value === "ahos" ? null : value;
}

function aliasColumns(entity: { aliases?: string[]; hot?: boolean }): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (entity.aliases !== undefined) out.aliases = normalizeAliases(entity.aliases);
	if (entity.hot !== undefined) out.hot = entity.hot;
	return out;
}

export function toInsert(entity: EntityInsertInput, userId: string) {
	return {
		id: globalThis.crypto.randomUUID(),
		entity_type: entity.entity_type ?? "entity",
		title: entity.title,
		description: entity.description ?? null,
		archived: entity.archived ?? false,
		archived_at: entity.archived ? entity.archived_at ?? new Date().toISOString() : null,
		properties: entity.properties ?? {},
		tags: entity.tags ?? [],
		source_url: normalizeSourceUrl(entity.source_url) ?? null,
		user_id: userId,
		team_id: entity.team_id ?? null,
		domain_override: entity.domain_override ?? null,
		local_name: normalizeLocalName(entity.local_name) ?? null,
		namespace: normalizeNamespace(entity.namespace) ?? null,
		...aliasColumns(entity),
	};
}

export function toUpdate(entity: EntityPatchInput) {
	const updates: Record<string, unknown> = {};
	if (entity.entity_type !== undefined) updates.entity_type = entity.entity_type;
	if (entity.title !== undefined) updates.title = entity.title;
	if (entity.description !== undefined) updates.description = entity.description;
	if (entity.tags !== undefined) updates.tags = entity.tags ?? [];
	if (entity.archived !== undefined) {
		updates.archived = entity.archived;
		if (entity.archived_at === undefined) {
			updates.archived_at = entity.archived ? new Date().toISOString() : null;
		}
	}
	if (entity.archived_at !== undefined) {
		updates.archived_at = entity.archived_at ?? (entity.archived ? new Date().toISOString() : null);
	}
	if (entity.properties !== undefined) updates.properties = entity.properties ?? {};
	if (entity.source_url !== undefined) updates.source_url = normalizeSourceUrl(entity.source_url);
	if (entity.local_name !== undefined) updates.local_name = normalizeLocalName(entity.local_name);
	if (entity.namespace !== undefined) updates.namespace = normalizeNamespace(entity.namespace);
	if (entity.team_id !== undefined) updates.team_id = entity.team_id;
	if (entity.domain_override !== undefined) updates.domain_override = entity.domain_override;
	Object.assign(updates, aliasColumns(entity));
	return updates;
}

export function createSupabaseEntityRepository(
	options: SupabaseEntityRepositoryOptions,
): Required<EntityRepository> {
	const resolveOwnerId = (override?: string) =>
		override ?? (typeof options.ownerId === "function" ? options.ownerId() : options.ownerId) ?? "";

	return {
		async getById(id: string, userId?: string): Promise<EntityRow | null> {
			const activeUserId = resolveOwnerId(userId);
			const { data, error } = await withAliasColumns((columns) =>
				options.client
					.from("entities")
					.select(columns)
					.eq("id", id)
					.eq("user_id", activeUserId)
					.maybeSingle(),
			);
			if (error) throw new Error(`Entities get failed: ${error.message}`);
			return (data as EntityRow | null) ?? null;
		},

		async loadRows(filter: EntityLoadFilter, userId?: string): Promise<EntityLoadResult> {
			const limit = filter.limit ?? 20;
			const activeUserId = filter.user_id ?? resolveOwnerId(userId);
			const { data, error } = await withAliasColumns((columns) => {
				let q = options.client
					.from("entities")
					.select(columns)
					.order("updated_at", { ascending: false, nullsFirst: false });

				if (activeUserId) q = q.eq("user_id", activeUserId);
				if (filter.team_id) q = q.eq("team_id", filter.team_id);
				if (filter.entity_type) q = q.eq("entity_type", filter.entity_type);
				if (filter.local_name) q = q.eq("local_name", filter.local_name);
				if (filter.namespace !== undefined) {
					if (filter.namespace === "ahos" || filter.namespace === "" || filter.namespace === null) {
						q = q.is("namespace", null);
					} else {
						q = q.eq("namespace", filter.namespace);
					}
				}
				if (filter.ids?.length) q = q.in("id", filter.ids);
				if (!filter.include_archived) q = q.eq("archived", false);
				if (filter.created_before) q = q.lt("created_at", filter.created_before);
				if (filter.updated_before) q = q.lt("updated_at", filter.updated_before);
				if (filter.tags?.length) q = q.contains("tags", filter.tags);
				if (filter.properties_contains) q = q.contains("properties", filter.properties_contains);

				const needsClientFilter = Boolean(filter.query || filter.domain);
				return q.limit(needsClientFilter ? SCAN_LIMIT : limit);
			});
			if (error) throw new Error(`Entities query failed: ${error.message}`);

			const scanned = (data ?? []) as unknown as EntityRow[];
			if (!filter.query) {
				return { rows: scanned.slice(0, limit), truncated: scanned.length >= SCAN_LIMIT };
			}
			const needle = filter.query.toLowerCase();
			const matched = scanned.filter((entity) => matchesQuery(entity, needle));
			return { rows: matched.slice(0, limit), truncated: scanned.length >= SCAN_LIMIT };
		},

		async insert(items: readonly EntityInsertInput[], userId?: string): Promise<EntityRow[]> {
			const activeUserId = resolveOwnerId(userId);
			const rows = items.map((item) => toInsert(item, activeUserId));
			const { data, error } = await options.client
				.from("entities")
				.insert(rows)
				.select("id, title, entity_type, description, properties, aliases");
			if (error) throw new Error(`Entities create failed: ${error.message}`);
			return (data ?? []) as unknown as EntityRow[];
		},

		async update(
			ids: string | readonly string[],
			patch: EntityPatchInput,
			userId?: string,
		): Promise<EntityRow[]> {
			const activeUserId = resolveOwnerId(userId);
			const updates = toUpdate(patch);
			if (typeof ids === "string") {
				const { data, error } = await options.client
					.from("entities")
					.update({ ...updates, user_id: activeUserId })
					.eq("id", ids)
					.eq("user_id", activeUserId)
					.select("id, title, description, properties, aliases");
				if (error) throw new Error(`Entities update failed: ${error.message}`);
				return (data ?? []) as unknown as EntityRow[];
			}
			if (ids.length === 0) return [];
			const { data, error } = await options.client
				.from("entities")
				.update(updates)
				.eq("user_id", activeUserId)
				.in("id", [...ids])
				.select("id, title, description, properties, aliases");
			if (error) throw new Error(`Entities update failed: ${error.message}`);
			return (data ?? []) as unknown as EntityRow[];
		},

		async mutateByIds(
			ids: readonly string[],
			archiveOnly: boolean,
			userId?: string,
		): Promise<Array<{ id: string; title: string | null }>> {
			if (ids.length === 0) return [];
			const activeUserId = resolveOwnerId(userId);
			const idList = [...ids];

			if (!archiveOnly) {
				await Promise.all([
					options.client
						.from("entity_relationships")
						.delete()
						.eq("user_id", activeUserId)
						.in("from_entity_id", idList),
					options.client
						.from("entity_relationships")
						.delete()
						.eq("user_id", activeUserId)
						.in("to_entity_id", idList),
				]);

				const { data, error } = await options.client
					.from("entities")
					.delete()
					.eq("user_id", activeUserId)
					.in("id", idList)
					.select("id, title");
				if (error) throw new Error(`Entities delete failed: ${error.message}`);
				return (data ?? []) as Array<{ id: string; title: string | null }>;
			}

			const { data, error } = await options.client
				.from("entities")
				.update({ archived: true, archived_at: new Date().toISOString() })
				.eq("user_id", activeUserId)
				.in("id", idList)
				.select("id, title, description, properties, aliases");
			if (error) throw new Error(`Entities update failed: ${error.message}`);

			await Promise.all([
				options.client
					.from("entity_relationships")
					.update({ archived: true })
					.eq("user_id", activeUserId)
					.in("from_entity_id", idList),
				options.client
					.from("entity_relationships")
					.update({ archived: true })
					.eq("user_id", activeUserId)
					.in("to_entity_id", idList),
			]);

			return (data ?? []) as Array<{ id: string; title: string | null }>;
		},

		async getDomainRow(id: string, userId?: string): Promise<EntityDomainRow | null> {
			const activeUserId = resolveOwnerId(userId);
			const { data, error } = await options.client
				.from("entities")
				.select("id, title, description, tags, properties, domain_override")
				.eq("id", id)
				.eq("user_id", activeUserId)
				.maybeSingle();
			if (error) throw new Error(`Entity domain resolution failed reading ${id}: ${error.message}`);
			return (data as EntityDomainRow | null) ?? null;
		},

		async fetchPrimaryParentId(id: string, userId?: string): Promise<string | null> {
			const activeUserId = resolveOwnerId(userId);
			const { data, error } = await options.client
				.from("entity_relationships")
				.select("to_entity_id")
				.eq("user_id", activeUserId)
				.eq("from_entity_id", id)
				.eq("relationship_type", "belongs_to")
				.eq("archived", false)
				.limit(1)
				.maybeSingle();
			if (error) throw new Error(`Primary containment lookup failed for ${id}: ${error.message}`);
			return (data as { to_entity_id: string } | null)?.to_entity_id ?? null;
		},

		async fetchPrimaryParentsBatch(
			ids: readonly string[],
			userId?: string,
		): Promise<Map<string, string>> {
			const parents = new Map<string, string>();
			if (ids.length === 0) return parents;
			const activeUserId = resolveOwnerId(userId);
			const { data, error } = await options.client
				.from("entity_relationships")
				.select("from_entity_id, to_entity_id")
				.eq("user_id", activeUserId)
				.in("from_entity_id", [...ids])
				.eq("relationship_type", "belongs_to")
				.eq("archived", false);
			if (error) throw new Error(`Batched primary containment lookup failed: ${error.message}`);
			for (const row of (data ?? []) as { from_entity_id: string; to_entity_id: string }[]) {
				if (!parents.has(row.from_entity_id)) parents.set(row.from_entity_id, row.to_entity_id);
			}
			return parents;
		},

		async getEdgeById(edgeId: string, userId?: string) {
			const activeUserId = resolveOwnerId(userId);
			const { data, error } = await options.client
				.from("entity_relationships")
				.select("id, from_entity_id, to_entity_id, relationship_type, valid_from, valid_to, archived")
				.eq("id", edgeId)
				.eq("user_id", activeUserId)
				.maybeSingle();
			if (error) throw new Error(`Load edge failed: ${error.message}`);
			return (data as Awaited<ReturnType<EntityRepository["getEdgeById"]>>) ?? null;
		},

		async findOwnedEntityIds(ids: readonly string[], userId?: string): Promise<Set<string>> {
			if (ids.length === 0) return new Set();
			const activeUserId = resolveOwnerId(userId);
			const { data, error } = await options.client
				.from("entities")
				.select("id")
				.eq("user_id", activeUserId)
				.in("id", [...ids]);
			if (error) throw new Error(`Participant check failed: ${error.message}`);
			return new Set((data ?? []).map((e: { id: string }) => e.id));
		},

		async insertArrangementNodes(rows, userId?: string): Promise<void> {
			const activeUserId = resolveOwnerId(userId);
			const payload = rows.map((row) => ({ ...row, user_id: row.user_id || activeUserId }));
			const { error } = await options.client.from("entities").insert(payload);
			if (error) throw new Error(error.message);
		},

		async insertParticipantEdges(rows, userId?: string): Promise<void> {
			const activeUserId = resolveOwnerId(userId);
			const payload = rows.map((row) => ({ ...row, user_id: row.user_id || activeUserId }));
			const { error } = await options.client.from("entity_relationships").insert(payload);
			if (error) throw new Error(error.message);
		},

		async insertProvenanceLinks(rows, userId?: string): Promise<void> {
			if (rows.length === 0) return;
			const activeUserId = resolveOwnerId(userId);
			const payload = rows.map((row) => ({ ...row, user_id: row.user_id || activeUserId }));
			const { error } = await options.client.from("artifact_entity_links").insert(payload);
			if (error) throw new Error(error.message);
		},

		async archiveEdge(edgeId: string, userId?: string): Promise<void> {
			const activeUserId = resolveOwnerId(userId);
			const { error } = await options.client
				.from("entity_relationships")
				.update({ archived: true })
				.eq("id", edgeId)
				.eq("user_id", activeUserId);
			if (error) throw new Error(error.message);
		},

		async findEntityEndpoints(ids: readonly string[], userId?: string): Promise<EntityEndpointRow[]> {
			if (ids.length === 0) return [];
			const activeUserId = resolveOwnerId(userId);
			const { data, error } = await options.client
				.from("entities")
				.select("id, entity_type")
				.eq("user_id", activeUserId)
				.in("id", [...ids]);
			if (error) throw new Error(`Endpoint check failed: ${error.message}`);
			return (data ?? []) as EntityEndpointRow[];
		},

		async findLivePrimaryContainmentEdges(
			fromEntityId: string,
			userId?: string,
		): Promise<PrimaryContainmentEdgeRow[]> {
			const activeUserId = resolveOwnerId(userId);
			const { data, error } = await options.client
				.from("entity_relationships")
				.select("id, to_entity_id")
				.eq("user_id", activeUserId)
				.eq("from_entity_id", fromEntityId)
				.eq("relationship_type", "belongs_to")
				.eq("archived", false);
			if (error) throw new Error(`Primary-containment check failed: ${error.message}`);
			return (data ?? []) as PrimaryContainmentEdgeRow[];
		},

		async findRelationshipEdge(
			fromEntityId: string,
			toEntityId: string,
			relationshipType: string,
			userId?: string,
		): Promise<ExistingRelationshipEdgeRow | null> {
			const activeUserId = resolveOwnerId(userId);
			const { data, error } = await options.client
				.from("entity_relationships")
				.select("id, archived, valid_from, valid_to, confidence_score, metadata, notes")
				.eq("user_id", activeUserId)
				.eq("from_entity_id", fromEntityId)
				.eq("to_entity_id", toEntityId)
				.eq("relationship_type", relationshipType)
				.limit(1)
				.maybeSingle();
			if (error) throw new Error(`Dedup check failed: ${error.message}`);
			return (data as ExistingRelationshipEdgeRow | null) ?? null;
		},

		async archiveEdgesByIds(edgeIds: readonly string[], userId?: string): Promise<void> {
			if (edgeIds.length === 0) return;
			const activeUserId = resolveOwnerId(userId);
			const { error } = await options.client
				.from("entity_relationships")
				.update({ archived: true })
				.eq("user_id", activeUserId)
				.in("id", [...edgeIds]);
			if (error) throw new Error(`Re-pointing primary containment failed: ${error.message}`);
		},

		async getRelationshipForSupersession(
			edgeId: string,
			userId?: string,
		): Promise<SupersessionRelationshipEdgeRow | null> {
			const activeUserId = resolveOwnerId(userId);
			const { data, error } = await options.client
				.from("entity_relationships")
				.select("id, user_id, valid_from, valid_to, metadata")
				.eq("id", edgeId)
				.eq("user_id", activeUserId)
				.limit(1)
				.maybeSingle();
			if (error) throw new Error(`Superseded edge check failed: ${error.message}`);
			return (data as SupersessionRelationshipEdgeRow | null) ?? null;
		},

		async updateRelationshipEdge(
			edgeId: string,
			patch: RelationshipEdgeUpdatePatch,
			userId?: string,
		): Promise<void> {
			const activeUserId = resolveOwnerId(userId);
			const { error } = await options.client
				.from("entity_relationships")
				.update(patch)
				.eq("id", edgeId)
				.eq("user_id", activeUserId);
			if (error) throw new Error(error.message);
		},

		async insertRelationshipEdge(
			row: RelationshipEdgeInsertInput,
			userId?: string,
		): Promise<{ id: string }> {
			const activeUserId = resolveOwnerId(userId);
			const { data, error } = await options.client
				.from("entity_relationships")
				.insert({
					user_id: activeUserId,
					...row,
				})
				.select("id")
				.single();
			if (error) {
				throw new Error(
					`Create edge failed: ${error.message}. If this mentions "metadata" or a relationship_type check, apply migration 049.`,
				);
			}
			return data as { id: string };
		},

		async getRelationship(id: string, userId?: string): Promise<RelationshipRecord | null> {
			const activeUserId = resolveOwnerId(userId);
			let q = options.client
				.from("entity_relationships")
				.select("*")
				.eq("id", id);
			if (activeUserId) {
				q = q.eq("user_id", activeUserId);
			}
			const { data, error } = await q.maybeSingle();
			if (error) {
				throw new Error(`Failed to get relationship: ${error.message}`);
			}
			return (data as RelationshipRecord | null) ?? null;
		},

		async queryRelationships(
			filter: RelationshipQueryFilter,
			userId?: string,
		): Promise<RelationshipRecord[]> {
			const activeUserId = resolveOwnerId(userId);
			let q = options.client.from("entity_relationships").select("*");
			if (activeUserId) {
				q = q.eq("user_id", activeUserId);
			}
			if (filter.relationship_type) {
				q = q.eq("relationship_type", filter.relationship_type);
			}
			if (filter.entity_id) {
				const dir = filter.direction || "both";
				if (dir === "outgoing") {
					q = q.eq("from_entity_id", filter.entity_id);
				} else if (dir === "incoming") {
					q = q.eq("to_entity_id", filter.entity_id);
				} else {
					q = q.or(`from_entity_id.eq.${filter.entity_id},to_entity_id.eq.${filter.entity_id}`);
				}
			}
			const { data, error } = await q
				.order("created_at", { ascending: false })
				.limit(filter.limit ?? 50);
			if (error) {
				throw new Error(`Failed to query relationships: ${error.message}`);
			}
			return (data ?? []) as RelationshipRecord[];
		},

		async insertRelationship(
			row: RelationshipInsertRow,
			userId?: string,
		): Promise<RelationshipRecord> {
			const activeUserId = resolveOwnerId(userId);
			const insertRecord: Record<string, unknown> = { ...row };
			if (activeUserId) {
				insertRecord.user_id = activeUserId;
			}
			const { data, error } = await options.client
				.from("entity_relationships")
				.insert(insertRecord)
				.select("*")
				.single();
			if (error) {
				throw new Error(`Failed to create relationship: ${error.message}`);
			}
			return data as RelationshipRecord;
		},

		async updateRelationship(
			id: string,
			patch: RelationshipUpdatePatch,
			userId?: string,
		): Promise<RelationshipRecord | null> {
			const activeUserId = resolveOwnerId(userId);
			let q = options.client
				.from("entity_relationships")
				.update(patch)
				.eq("id", id);
			if (activeUserId) {
				q = q.eq("user_id", activeUserId);
			}
			const { data, error } = await q.select("*").maybeSingle();
			if (error) {
				throw new Error(`Failed to update relationship: ${error.message}`);
			}
			return (data as RelationshipRecord | null) ?? null;
		},

		async deleteRelationships(
			target: RelationshipDeleteTarget,
			userId?: string,
		): Promise<void> {
			const activeUserId = resolveOwnerId(userId);
			let q = options.client.from("entity_relationships").delete();
			if (activeUserId) {
				q = q.eq("user_id", activeUserId);
			}
			if ("id" in target) {
				q = q.eq("id", target.id);
			} else {
				q = q
					.eq("from_entity_id", target.from_entity_id)
					.eq("to_entity_id", target.to_entity_id);
				if (target.relationship_type) {
					q = q.eq("relationship_type", target.relationship_type);
				}
			}
			const { error } = await q;
			if (error) {
				throw new Error(`Failed to delete relationship: ${error.message}`);
			}
		},

		async findTrackedResources(
			filter: FindTrackedResourcesFilter,
			userId?: string,
		): Promise<TrackedEntityRow[]> {
			const activeUserId = resolveOwnerId(userId);
			const limit = filter.limit ?? 501;
			const run = (columns: string) => {
				let q = options.client
					.from("entities")
					.select(columns)
					.eq("user_id", activeUserId)
					.eq("entity_type", "resource")
					.contains("properties", { tracked: true });
				if (!filter.include_archived) q = q.eq("archived", false);
				if (filter.entity_id) q = q.eq("id", filter.entity_id);
				return q.order("title").limit(limit);
			};
			let { data, error } = await run(TRACKED_ENTITY_COLUMNS);
			if (isMissingColumnError(error, "aliases")) {
				({ data, error } = await run(TRACKED_ENTITY_COLUMNS_PRE_110));
			}
			if (error) {
				throw new Error(`document_resolve: tracked-document lookup failed: ${error.message}`);
			}
			return (data ?? []) as unknown as TrackedEntityRow[];
		},

		async getTitleById(id: string, userId?: string): Promise<string | null> {
			const activeUserId = resolveOwnerId(userId);
			const { data } = await options.client
				.from("entities")
				.select("title")
				.eq("user_id", activeUserId)
				.eq("id", id)
				.maybeSingle();
			const raw = (data as { title?: unknown } | null)?.title;
			return typeof raw === "string" && raw.trim() ? raw.trim() : null;
		},

		async findExactForSync(
			query: { id?: string; entity_type: string; title: string; place_type?: string | null },
			userId?: string,
		): Promise<SyncEntityRow | null> {
			const activeUserId = resolveOwnerId(userId);
			if (query.id) {
				const { data, error } = await options.client
					.from("entities")
					.select("id, entity_type, title, description, archived, properties, tags, aliases")
					.eq("id", query.id)
					.eq("user_id", activeUserId)
					.maybeSingle();
				if (error) throw new Error(`Entity lookup failed for ${query.id}: ${error.message}`);
				if (data) return data as unknown as SyncEntityRow;
			}

			let q = options.client
				.from("entities")
				.select("id, entity_type, title, description, archived, properties, tags, aliases")
				.eq("user_id", activeUserId)
				.eq("entity_type", query.entity_type)
				.eq("title", query.title);

			if (query.place_type) {
				q = q.eq("properties->>place_type", query.place_type);
			}

			const { data, error } = await q.maybeSingle();
			if (error) throw new Error(`Entity lookup failed: ${error.message}`);
			return (data as unknown as SyncEntityRow | null) ?? null;
		},

		async findByExactTitle(
			query: { entity_type: string; title: string; limit?: number },
			userId?: string,
		): Promise<EntityRow[]> {
			const activeUserId = resolveOwnerId(userId);
			const wanted = query.title.trim();
			// No surrounding `%`: an escaped ilike pattern is a case-insensitive equality.
			const escaped = wanted.replace(/[\\%_]/g, "\\$&");
			const { data, error } = await withAliasColumns((columns) =>
				options.client
					.from("entities")
					.select(columns)
					.eq("user_id", activeUserId)
					.eq("entity_type", query.entity_type)
					.eq("archived", false)
					.ilike("title", escaped)
					.order("updated_at", { ascending: false, nullsFirst: false })
					.limit(query.limit ?? 50),
			);
			if (error) throw new Error(`Entities query failed: ${error.message}`);
			// PostgREST also reads `*` as a wildcard in ilike patterns and has no escape
			// for it, so a title containing one can over-match. Keep only true matches.
			// Known limit, not fixed: the over-matched rows count towards `limit`, so a
			// `*` title with `limit` or more newer over-matching rows can miss the real row.
			const key = wanted.toLowerCase();
			return ((data ?? []) as unknown as EntityRow[]).filter(
				(row) => (row.title ?? "").trim().toLowerCase() === key,
			);
		},

		async findSyncCandidates(
			query: { entity_type: string; title: string },
			userId?: string,
		): Promise<SyncEntityRow[]> {
			const activeUserId = resolveOwnerId(userId);
			const escapedTitle = query.title.trim().replace(/[\\%_]/g, "\\$&");
			let q: any = options.client
				.from("entities")
				.select("id, entity_type, title, description, archived, properties, tags, aliases")
				.eq("user_id", activeUserId)
				.eq("entity_type", query.entity_type);

			const usedIlike = Boolean(escapedTitle && typeof q.ilike === "function");
			if (usedIlike) {
				q = q.ilike("title", `%${escapedTitle}%`);
			}

			const { data, error } = await q.limit(100);
			if (error) throw new Error(`Entity match failed: ${error.message}`);

			let candidates = (data ?? []) as unknown as SyncEntityRow[];
			if (candidates.length === 0 && usedIlike) {
				const fallback = await options.client
					.from("entities")
					.select("id, entity_type, title, description, archived, properties, tags, aliases")
					.eq("user_id", activeUserId)
					.eq("entity_type", query.entity_type)
					.limit(100);
				if (fallback.error) throw new Error(`Entity match failed: ${fallback.error.message}`);
				candidates = (fallback.data ?? []) as unknown as SyncEntityRow[];
			}
			return candidates;
		},

		async createForSync(
			input: SyncEntityCreateInput,
			userId?: string,
		): Promise<{ created: SyncEntityRow | null; conflict: boolean }> {
			const activeUserId = resolveOwnerId(userId);
			const row = {
				id: input.id,
				entity_type: input.entity_type,
				title: input.title,
				description: input.description,
				tags: input.tags,
				archived: false,
				archived_at: null,
				properties: input.properties,
				user_id: activeUserId,
				team_id: null,
			};

			const { data, error } = await options.client
				.from("entities")
				.insert([row])
				.select("id, entity_type, title, description, archived, properties, tags, aliases");
			if (error) {
				if ((error as { code?: string }).code === "23505") {
					return { created: null, conflict: true };
				}
				throw new Error(`Entity create failed: ${error.message}`);
			}
			const created =
				((data as unknown as SyncEntityRow[] | null)?.[0]) ??
				({ ...row, archived: false } as SyncEntityRow);
			return { created, conflict: false };
		},

		async getHotTierCandidates(
			params: HotTierCandidatesParams,
			userId?: string,
		): Promise<HotTierCandidatesResult> {
			if (!options.client.rpc) {
				throw new Error(
					"get_hot_tier_candidates requires a Supabase client with rpc() wired.",
				);
			}
			const activeUserId = resolveOwnerId(userId);
			const { data, error } = await options.client.rpc("get_hot_tier_candidates", {
				p_user_id: activeUserId,
				p_window_start: params.windowStart,
				p_min_mentions: params.minMentions,
				p_limit: params.limit,
				p_quiet_start: params.quietStart,
				p_excluded_surfaces: [...params.excludedSurfaces],
				p_entity_types: [...params.entityTypes],
			});
			if (error) {
				throw new Error(
					`get_hot_tier_candidates failed: ${error.message}. If this mentions an undefined function, apply migration 159.`,
				);
			}
			const raw = (data ?? {}) as Partial<HotTierCandidatesResult>;
			const candidates: HotTierCandidateRow[] = Array.isArray(raw.candidates)
				? raw.candidates.map((row) => ({
						id: String(row.id),
						entity_type: String(row.entity_type),
						title: String(row.title ?? ""),
						aliases: Array.isArray(row.aliases) ? row.aliases.map(String) : [],
						mentions: Number(row.mentions ?? 0),
						last_mention_at: String(row.last_mention_at ?? ""),
					}))
				: [];
			return {
				hot_count: typeof raw.hot_count === "number" ? raw.hot_count : 0,
				candidates,
			};
		},
	};
}

export const ARTIFACT_ENTITY_LINK_COLUMNS =
	"id, artifact_id, entity_id, link_type, confidence_score, created_by, notes, created_at";

export interface SupabaseLinkRepositoryOptions {
	client: LinksSupabaseClient;
	ownerId: string | (() => string | undefined);
}

export function createSupabaseLinkRepository(
	options: SupabaseLinkRepositoryOptions,
): Required<LinkRepository> {
	const resolveOwnerId = (override?: string) =>
		override ?? (typeof options.ownerId === "function" ? options.ownerId() : options.ownerId) ?? "";

	return {
		async get(id: string, userId?: string): Promise<ArtifactEntityLinkRow | null> {
			const activeUserId = resolveOwnerId(userId);
			const { data, error } = await options.client
				.from("artifact_entity_links")
				.select(ARTIFACT_ENTITY_LINK_COLUMNS)
				.eq("user_id", activeUserId)
				.eq("id", id)
				.maybeSingle();
			if (error) {
				throw new Error(`Get artifact_entity_links failed: ${error.message}`);
			}
			return (data as unknown as ArtifactEntityLinkRow | null) ?? null;
		},

		async query(
			filter: ArtifactEntityLinkQueryFilter,
			userId?: string,
		): Promise<ArtifactEntityLinkRow[]> {
			const activeUserId = resolveOwnerId(userId);
			let q = options.client
				.from("artifact_entity_links")
				.select(ARTIFACT_ENTITY_LINK_COLUMNS)
				.eq("user_id", activeUserId)
				.order("created_at", { ascending: false });

			if (filter.artifact_id) q = q.eq("artifact_id", filter.artifact_id);
			if (filter.entity_id) q = q.eq("entity_id", filter.entity_id);
			if (filter.link_type) q = q.eq("link_type", filter.link_type);

			const { data, error } = await q.limit(filter.limit ?? 20);
			if (error) {
				throw new Error(`Query artifact_entity_links failed: ${error.message}`);
			}
			return (data ?? []) as unknown as ArtifactEntityLinkRow[];
		},

		async create(
			links: readonly ArtifactEntityLinkInput[],
			userId?: string,
		): Promise<Array<{ id: string; artifact_id: string; entity_id: string }>> {
			const activeUserId = resolveOwnerId(userId);
			const rows = links.map((link) => ({
				user_id: activeUserId,
				artifact_id: link.artifact_id,
				entity_id: link.entity_id,
				link_type: link.link_type ?? "related",
				confidence_score: link.confidence_score ?? null,
				created_by: link.created_by ?? null,
				notes: link.notes ?? null,
			}));

			const { data, error } = await options.client
				.from("artifact_entity_links")
				.insert(rows)
				.select("id, artifact_id, entity_id");
			if (error) {
				throw new Error(`Create artifact_entity_links failed: ${error.message}`);
			}
			if (data == null) {
				return rows.map((row) => ({
					id: "",
					artifact_id: row.artifact_id,
					entity_id: row.entity_id,
				}));
			}
			return data as unknown as Array<{ id: string; artifact_id: string; entity_id: string }>;
		},

		async upsert(
			links: readonly ArtifactEntityLinkInput[],
			upsertOptions?: { markArtifactDerived?: boolean; userId?: string },
		): Promise<Array<{ id: string; artifact_id: string; entity_id: string; link_type: string | null }>> {
			const activeUserId = resolveOwnerId(upsertOptions?.userId);

			// An upsert payload column becomes `SET col = EXCLUDED.col` on conflict, so a
			// column the caller did not supply must be absent, not null, or re-linking
			// blanks what is stored (#2295). postgrest-js sends the union of keys across
			// a batch and nulls the gaps, so rows are grouped by which optional columns
			// they carry and each group is written on its own. A uniform batch is one
			// statement; a mixed batch is several, which is not atomic but is safe to
			// retry because every statement is an idempotent upsert.
			type UpsertRow = {
				user_id: string | undefined;
				artifact_id: string;
				entity_id: string;
				link_type: string;
				confidence_score?: number | null;
				created_by?: string | null;
				notes?: string | null;
			};
			const groups = new Map<string, UpsertRow[]>();
			for (const link of links) {
				const row: UpsertRow = {
					user_id: activeUserId,
					artifact_id: link.artifact_id,
					entity_id: link.entity_id,
					link_type: link.link_type ?? "related",
				};
				if (link.confidence_score !== undefined) row.confidence_score = link.confidence_score;
				if (link.created_by !== undefined) row.created_by = link.created_by;
				if (link.notes !== undefined) row.notes = link.notes;
				const shape = [
					"confidence_score" in row ? "c" : "",
					"created_by" in row ? "b" : "",
					"notes" in row ? "n" : "",
				].join("|");
				const group = groups.get(shape);
				if (group) group.push(row);
				else groups.set(shape, [row]);
			}
			// An empty input still issues its one (empty) statement, as before.
			const batches: UpsertRow[][] = groups.size > 0 ? Array.from(groups.values()) : [[]];

			const result: Array<{
				id: string;
				artifact_id: string;
				entity_id: string;
				link_type: string | null;
			}> = [];
			for (const rows of batches) {
				const { data, error } = await options.client
					.from("artifact_entity_links")
					.upsert(rows, { onConflict: "user_id,artifact_id,entity_id,link_type" })
					.select("id, artifact_id, entity_id, link_type");
				if (error) {
					throw new Error(`Upsert artifact_entity_links failed: ${error.message}`);
				}
				if (data == null) {
					result.push(
						...rows.map((row) => ({
							id: "",
							artifact_id: row.artifact_id,
							entity_id: row.entity_id,
							link_type: row.link_type,
						})),
					);
				} else {
					result.push(
						...(data as unknown as Array<{
							id: string;
							artifact_id: string;
							entity_id: string;
							link_type: string | null;
						}>),
					);
				}
			}

			if (upsertOptions?.markArtifactDerived) {
				if (!options.client.rpc) {
					throw new Error("Supabase client rpc is required when markArtifactDerived is true.");
				}
				const distinctArtifactIds = Array.from(
					new Set(links.map((link) => link.artifact_id)),
				);
				const derivedAt = new Date().toISOString();
				for (const artifactId of distinctArtifactIds) {
					const { error: rpcError } = await options.client.rpc("set_artifact_derivation", {
						p_user_id: activeUserId,
						p_artifact_id: artifactId,
						p_derivation: {
							status: "completed",
							derived_at: derivedAt,
							attempts: 1,
							provider: "interactive",
						},
					});
					if (rpcError) {
						throw new Error(
							`Failed to mark artifact ${artifactId} derived: ${rpcError.message}`,
						);
					}
				}
			}

			return result;
		},

		async delete(
			id: string,
			userId?: string,
		): Promise<Array<{ id: string; artifact_id: string; entity_id: string }>> {
			const activeUserId = resolveOwnerId(userId);
			const { data, error } = await options.client
				.from("artifact_entity_links")
				.delete()
				.eq("user_id", activeUserId)
				.eq("id", id)
				.select("id, artifact_id, entity_id");
			if (error) {
				throw new Error(`Delete artifact_entity_links failed: ${error.message}`);
			}
			return (data ?? []) as unknown as Array<{ id: string; artifact_id: string; entity_id: string }>;
		},
	};
}
