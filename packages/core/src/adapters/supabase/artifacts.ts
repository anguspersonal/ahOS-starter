import type { SupabaseClient } from "@supabase/supabase-js";
import {
	ARTIFACT_DEDUP_SELECT_COLUMNS,
	ARTIFACT_PATCH_SELECT_COLUMNS,
	ARTIFACT_SELECT_COLUMNS,
	ArtifactWriteError,
	DOCUMENT_RESOLVE_SELECT_COLUMNS,
	type ArtifactInsertedRow,
	type ArtifactInsertRow,
	type ArtifactPatch,
	type ArtifactPatchedRow,
	type ArtifactRepository,
	type ArtifactRow,
	type ArtifactSummaryRow,
	type ClusterRow,
	type DedupMatch,
	type DocEditAuditEntry,
	type DocumentResolveArtifactRow,
	type DuplicateClustersParams,
	type LinkedArtifactEntity,
	type LinkedArtifactForEntityRow,
} from "../../ports/artifacts.js";

export {
	ARTIFACT_DEDUP_SELECT_COLUMNS,
	ArtifactWriteError,
	DOCUMENT_RESOLVE_SELECT_COLUMNS,
	type ArtifactInsertedRow,
	type ArtifactInsertRow,
	type DedupMatch,
	type DocumentResolveArtifactRow,
	type DuplicateClustersParams,
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ArtifactSupabaseClient = Pick<SupabaseClient, "from"> &
	Partial<Pick<SupabaseClient, "storage" | "rpc">>;

export interface SupabaseArtifactRepositoryOptions {
	client: ArtifactSupabaseClient;
	ownerId: string | (() => string);
	embedArtifact?: (
		id: string,
		fields: {
			title: string | null;
			description: string | null;
			plain_text: string | null;
		},
	) => Promise<unknown>;
}

export function createSupabaseArtifactRepository(
	options: SupabaseArtifactRepositoryOptions,
): ArtifactRepository {
	const resolveOwnerId = (override?: string) =>
		override ?? (typeof options.ownerId === "function" ? options.ownerId() : options.ownerId);

	return {
		async getById(id: string): Promise<ArtifactRow | null> {
			const { data, error } = await options.client
				.from("artifacts")
				.select(ARTIFACT_SELECT_COLUMNS)
				.eq("id", id)
				.eq("user_id", resolveOwnerId())
				.maybeSingle();

			if (error) throw new Error(`Fetch failed: ${error.message}`);
			return (data as ArtifactRow | null) ?? null;
		},

		async getLinkedEntities(artifactId: string): Promise<LinkedArtifactEntity[]> {
			const { data: links } = await options.client
				.from("artifact_entity_links")
				.select("entities(title, entity_type)")
				.eq("artifact_id", artifactId);

			return ((links ?? []) as Array<{ entities: unknown }>)
				.flatMap((l) => {
					const e = l.entities;
					return Array.isArray(e) ? e : e ? [e] : [];
				})
				.map((e: { title: string; entity_type: string }) => ({
					title: e.title,
					entity_type: e.entity_type,
				}));
		},

		async findExistingSources(sources: string[]): Promise<Set<string>> {
			if (sources.length === 0) return new Set();
			const { data, error } = await options.client
				.from("artifacts")
				.select("source")
				.eq("user_id", resolveOwnerId())
				.in("source", sources);
			if (error) {
				throw new Error(`Dedup lookup failed: ${error.message}`);
			}
			return new Set(
				(data ?? [])
					.map((r: { source: string | null }) => r.source)
					.filter((s): s is string => Boolean(s)),
			);
		},

		async insert(row: ArtifactInsertRow): Promise<ArtifactInsertedRow> {
			const { data, error } = await options.client
				.from("artifacts")
				.insert(row)
				.select("id, title, created_at")
				.single();

			if (error) {
				throw new ArtifactWriteError(error.message, error.code);
			}
			return data as ArtifactInsertedRow;
		},

		async findOldestByDedupKey(key: string): Promise<DedupMatch | null> {
			const { data, error } = await options.client
				.from("artifacts")
				.select(ARTIFACT_DEDUP_SELECT_COLUMNS)
				.eq("user_id", resolveOwnerId())
				.eq("dedup_key", key)
				.order("created_at", { ascending: true })
				.limit(1);

			if (error) {
				throw new Error(`Dedup lookup failed: ${error.message}`);
			}
			return ((data ?? [])[0] as DedupMatch | undefined) ?? null;
		},

		async findOldestByFingerprint(
			fingerprint: string,
			sinceIso: string,
		): Promise<DedupMatch | null> {
			const { data, error } = await options.client
				.from("artifacts")
				.select(ARTIFACT_DEDUP_SELECT_COLUMNS)
				.eq("user_id", resolveOwnerId())
				.eq("content_fingerprint", fingerprint)
				.gte("created_at", sinceIso)
				.order("created_at", { ascending: true })
				.limit(1);

			if (error) {
				throw new Error(`Dedup lookup failed: ${error.message}`);
			}
			return ((data ?? [])[0] as DedupMatch | undefined) ?? null;
		},

		async patch(id: string, patch: ArtifactPatch): Promise<ArtifactPatchedRow> {
			const normalized: Record<string, unknown> = { ...patch };
			if (normalized.archived === false) {
				normalized.archived_at = null;
				normalized.archived_reason = normalized.archived_reason ?? null;
			} else if (normalized.archived === true) {
				normalized.archived_at = normalized.archived_at ?? new Date().toISOString();
			}

			const userId = resolveOwnerId();
			const { data, error } = await options.client
				.from("artifacts")
				.update(normalized)
				.eq("id", id)
				.eq("user_id", userId)
				.select(ARTIFACT_PATCH_SELECT_COLUMNS)
				.single();

			if (error) throw new Error(`Artifact update failed: ${error.message}`);
			const row = data as ArtifactPatchedRow;

			if (typeof patch.plain_text === "string") {
				const isTextBlob =
					row.file_type === "text/markdown" || row.file_type === "text/plain";
				if (row.storage_path && isTextBlob && options.client.storage) {
					const bodyBytes = new TextEncoder().encode(patch.plain_text);
					const fileSize = bodyBytes.byteLength;
					const hashBuffer = await globalThis.crypto.subtle.digest(
						"SHA-256",
						bodyBytes,
					);
					const contentFingerprint = Array.from(new Uint8Array(hashBuffer))
						.map((b) => b.toString(16).padStart(2, "0"))
						.join("");
					const bucket = row.storage_bucket || "artifacts";

					const { error: uploadError } = await options.client.storage
						.from(bucket)
						.upload(row.storage_path, bodyBytes, {
							contentType: row.file_type ?? undefined,
							upsert: true,
						});
					if (uploadError) {
						throw new Error(`Artifact storage sync failed: ${uploadError.message}`);
					}

					const { error: metaError } = await options.client
						.from("artifacts")
						.update({
							file_size: fileSize,
							content_fingerprint: contentFingerprint,
						})
						.eq("id", row.id)
						.eq("user_id", userId);
					if (metaError) {
						throw new Error(`Artifact metadata sync failed: ${metaError.message}`);
					}
				}
			}

			if (patch.plain_text !== undefined && options.embedArtifact) {
				await options.embedArtifact(row.id, {
					title: row.title ?? patch.title ?? null,
					description: row.description ?? patch.description ?? null,
					plain_text: row.plain_text ?? patch.plain_text ?? null,
				});
			}

			return row;
		},

		async mutateByIds(
			ids: string[],
			archiveOnly: boolean,
			archivedReason?: string | null,
		): Promise<ArtifactSummaryRow[]> {
			if (ids.length === 0) return [];

			if (!archiveOnly) {
				const { data, error } = await options.client
					.from("artifacts")
					.delete()
					.eq("user_id", resolveOwnerId())
					.in("id", ids)
					.select("id, title");
				if (error) throw new Error(`Artifact delete failed: ${error.message}`);
				return (data ?? []) as ArtifactSummaryRow[];
			}

			const { data, error } = await options.client
				.from("artifacts")
				.update({
					archived: true,
					archived_at: new Date().toISOString(),
					archived_reason: archivedReason ?? null,
				})
				.eq("user_id", resolveOwnerId())
				.in("id", ids)
				.select("id, title");
			if (error) throw new Error(`Artifact archive failed: ${error.message}`);
			return (data ?? []) as ArtifactSummaryRow[];
		},

		async archive(
			idOrIds: string | string[],
			reason?: string | null,
		): Promise<ArtifactSummaryRow[]> {
			const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
			if (ids.length === 0) return [];
			const query = options.client
				.from("artifacts")
				.update({
					archived: true,
					archived_at: new Date().toISOString(),
					archived_reason: reason ?? null,
				})
				.eq("user_id", resolveOwnerId());
			const filtered = Array.isArray(idOrIds)
				? query.in("id", ids)
				: query.eq("id", idOrIds);
			const { data, error } = await filtered.select("id, title");
			if (error) throw new Error(`Artifact archive failed: ${error.message}`);
			return (data ?? []) as ArtifactSummaryRow[];
		},

		async hardDelete(idOrIds: string | string[]): Promise<ArtifactSummaryRow[]> {
			const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
			if (ids.length === 0) return [];
			const query = options.client
				.from("artifacts")
				.delete()
				.eq("user_id", resolveOwnerId());
			const filtered = Array.isArray(idOrIds)
				? query.in("id", ids)
				: query.eq("id", idOrIds);
			const { data, error } = await filtered.select("id, title");
			if (error) throw new Error(`Artifact delete failed: ${error.message}`);
			return (data ?? []) as ArtifactSummaryRow[];
		},

		async getDocumentsByIds(
			candidateIds: readonly string[],
			userId?: string,
		): Promise<Map<string, DocumentResolveArtifactRow>> {
			const out = new Map<string, DocumentResolveArtifactRow>();
			const ids = candidateIds.filter((id) => UUID_PATTERN.test(id));
			const activeUserId = resolveOwnerId(userId);
			for (let i = 0; i < ids.length; i += 100) {
				const { data, error } = await options.client
					.from("artifacts")
					.select(DOCUMENT_RESOLVE_SELECT_COLUMNS)
					.eq("user_id", activeUserId)
					.in("id", ids.slice(i, i + 100));
				if (error) {
					throw new Error(`document_resolve: artifact lookup failed: ${error.message}`);
				}
				for (const row of (data ?? []) as unknown as DocumentResolveArtifactRow[]) {
					out.set(row.id, row);
				}
			}
			return out;
		},

		async getPrimaryLinksForEntities(
			entityIds: readonly string[],
		): Promise<Map<string, string[]>> {
			const out = new Map<string, string[]>();
			if (entityIds.length === 0) return out;
			const { data, error } = await options.client
				.from("artifact_entity_links")
				.select("artifact_id, entity_id")
				.in("entity_id", [...entityIds])
				.eq("link_type", "primary");
			if (error) {
				throw new Error(`document_resolve: link lookup failed: ${error.message}`);
			}
			for (const link of (data ?? []) as Array<{ artifact_id: string; entity_id: string }>) {
				const list = out.get(link.entity_id) ?? [];
				if (!list.includes(link.artifact_id)) list.push(link.artifact_id);
				out.set(link.entity_id, list);
			}
			return out;
		},

		async listLinkedArtifactsForEntities(
			entityIds: readonly string[],
			userId?: string,
		): Promise<LinkedArtifactForEntityRow[]> {
			if (entityIds.length === 0) return [];
			const activeUserId = resolveOwnerId(userId);
			const out: LinkedArtifactForEntityRow[] = [];
			for (let i = 0; i < entityIds.length; i += 100) {
				const batch = entityIds.slice(i, i + 100);
				let q = options.client
					.from("artifact_entity_links")
					.select(
						"entity_id, artifact_id, link_type, confidence_score, notes, artifacts(id, title, source, source_channel, source_url, storage_url, file_type, captured_at, originated_at, created_at, archived, processing_metadata)",
					)
					.in("entity_id", [...batch]);
				if (activeUserId) {
					q = q.eq("user_id", activeUserId);
				}
				const { data, error } = await q;
				if (error) {
					throw new Error(`Artifact link lookup failed: ${error.message}`);
				}
				for (const row of (data ?? []) as Array<{
					entity_id: string;
					artifact_id: string;
					link_type: string | null;
					confidence_score: number | null;
					notes: string | null;
					artifacts: unknown;
				}>) {
					const joined = Array.isArray(row.artifacts) ? row.artifacts[0] : row.artifacts;
					if (!joined || typeof joined !== "object") continue;
					out.push({
						entity_id: row.entity_id,
						artifact_id: row.artifact_id,
						link_type: row.link_type ?? null,
						confidence_score: row.confidence_score ?? null,
						notes: row.notes ?? null,
						artifact: joined as LinkedArtifactForEntityRow["artifact"],
					});
				}
			}
			return out;
		},

		async searchDocumentTitleCandidates(
			terms: readonly string[],
			limit: number,
			userId?: string,
		): Promise<DocumentResolveArtifactRow[]> {
			if (!options.client.rpc) {
				throw new Error("Supabase rpc client is not configured");
			}
			const activeUserId = resolveOwnerId(userId);
			const { data, error } = await options.client
				.rpc("document_title_candidates", {
					p_user_id: activeUserId,
					p_terms: [...terms],
					p_limit: limit,
				})
				.select(DOCUMENT_RESOLVE_SELECT_COLUMNS);
			if (error) {
				throw new Error(
					`document_resolve: candidate title search failed: ${error.message}. If this mentions "document_title_candidates", apply migration 119.`,
				);
			}
			return (data ?? []) as unknown as DocumentResolveArtifactRow[];
		},

		async duplicateClusters(params: DuplicateClustersParams = {}): Promise<ClusterRow[]> {
			if (!options.client.rpc) {
				throw new Error("Supabase rpc client is not configured");
			}
			const { data, error } = await options.client.rpc("document_duplicate_clusters", {
				p_user_id: resolveOwnerId(params.userId),
				p_query: params.query ?? null,
				p_connector: params.connector ?? null,
				p_min_cluster: params.min_cluster ?? 2,
				p_limit: params.limit ?? 20,
				p_include_archived: params.include_archived ?? false,
			});
			if (error) {
				throw Object.assign(
					new Error(error.message),
					error.code !== undefined ? { code: error.code } : {},
				);
			}
			return (data ?? []) as unknown as ClusterRow[];
		},

		async saveExtractedText(
			id: string,
			fields: {
				extracted_content: string;
				plain_text: string;
				description: string | null;
				processing_status?: string;
			},
		): Promise<void> {
			const { data, error } = await options.client
				.from("artifacts")
				.update({
					extracted_content: fields.extracted_content,
					plain_text: fields.plain_text,
					description: fields.description,
					processing_status: fields.processing_status ?? "completed",
				})
				.eq("id", id)
				.eq("user_id", resolveOwnerId())
				.select("id");
			if (error) throw new Error(`Update failed: ${error.message}`);
			if (!data || data.length === 0) {
				throw new Error(`Artifact ${id} no longer exists: extraction discarded.`);
			}
		},

		async appendDocEditAudit(
			sourceDriveFileId: string,
			entry: DocEditAuditEntry,
		): Promise<void> {
			const { data: artifacts, error } = await options.client
				.from("artifacts")
				.select("id, processing_metadata")
				.eq("source_drive_file_id", sourceDriveFileId)
				.limit(1);
			if (error) throw new Error(`Audit lookup failed: ${error.message}`);
			if (!artifacts || artifacts.length === 0) return;

			const art = artifacts[0] as {
				id: string;
				processing_metadata?: Record<string, unknown> | null;
			};
			const currentMeta =
				(art.processing_metadata as Record<string, unknown>) ?? {};
			const auditTrail = Array.isArray(currentMeta.docs_edit_audit)
				? [...currentMeta.docs_edit_audit]
				: [];
			auditTrail.push({
				timestamp: entry.timestamp ?? new Date().toISOString(),
				revision_before: entry.revision_before,
				revision_after: entry.revision_after ?? null,
				request_count: entry.request_count,
				suggest: entry.suggest === true,
			});
			const { error: updateError } = await options.client
				.from("artifacts")
				.update({
					processing_metadata: {
						...currentMeta,
						docs_edit_audit: auditTrail,
					},
				})
				.eq("id", art.id);
			if (updateError) throw new Error(`Audit update failed: ${updateError.message}`);
		},
	};
}



