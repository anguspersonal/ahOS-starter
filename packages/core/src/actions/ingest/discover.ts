import type { z } from "zod";
import {
	discoverInput,
	discoverSchema,
	discoveryMetadata,
	driveColumns,
	envelopeFields,
	isJunkTitle,
	needsEnvelopeRefresh,
	normalizePointerUrl,
	originatedAt,
	pointerDescription,
	pointerEmbedText,
	pointerProcessingStatus,
	pointerUrl,
	resolveTitle,
	slugify as slugifyPointerTitle,
	type DiscoverCounts,
	type DiscoverItem,
	type EnvelopeRefreshRow,
	type ExistingRow,
} from "../../domain/ingest/discoverPointers.js";
import {
	evaluateExclusion,
	type ExclusionLists,
} from "../../domain/ingest/exclusions.js";
import {
	DISCOVER_INSERT_BATCH_SIZE,
	DISCOVER_LOOKUP_BATCH_SIZE,
	type DiscoverEmbeddingPort,
	type DiscoverRepository,
} from "../../ports/discover.js";
import { defineAction } from "../defineAction.js";

export {
	DISCOVER_INSERT_BATCH_SIZE,
	DISCOVER_LOOKUP_BATCH_SIZE,
	discoverInput,
	discoverSchema,
	type DiscoverCounts,
	type DiscoverItem,
};

export const DISCOVERED_STAGE = "discovered" as const;

export const INGEST_DISCOVER_DESCRIPTION =
	"Register a batch of items inventoried from an external system (Notion, Drive, Gmail, ...) as lightweight pointers in the knowledge registry. Records what exists and where it lives WITHOUT pulling in content -- the cheap, frequent layer of Discover & Index. Compose this after listing items from a connector. Idempotent per external id; re-running refreshes changed items.";

const DISCOVER_MCP_META = Symbol.for("@ahkms/core/ingest_discover/mcp_meta");

export interface DiscoverFormatMeta {
	connector?: string;
	itemCount?: number;
	embeddingConfigured?: boolean;
}

export type IngestDiscoverDeps = (
	| { repo: DiscoverRepository; discover?: DiscoverRepository }
	| { discover: DiscoverRepository; repo?: DiscoverRepository }
) & {
	embeddings?: DiscoverEmbeddingPort | null;
	exclusionLists?: ExclusionLists | (() => ExclusionLists | undefined);
};

function isEmbeddingPortConfigured(
	embeddings: DiscoverEmbeddingPort | null | undefined,
): boolean {
	if (!embeddings) return false;
	if (typeof embeddings.isConfigured === "function") {
		return embeddings.isConfigured();
	}
	return true;
}

async function attachEmbeddings(
	targets: { payload: Record<string, unknown>; text: string | null }[],
	embeddings: DiscoverEmbeddingPort | null | undefined,
): Promise<{ embedded: number; embeddable: number; embeddingConfigured: boolean }> {
	const embeddable = targets.filter(
		(t): t is { payload: Record<string, unknown>; text: string } => t.text !== null,
	);
	const embeddingConfigured = isEmbeddingPortConfigured(embeddings);
	if (!embeddingConfigured || !embeddings || embeddable.length === 0) {
		return { embedded: 0, embeddable: embeddable.length, embeddingConfigured };
	}

	const vectors = await embeddings.embedBatch(embeddable.map((t) => t.text));

	let embedded = 0;
	vectors.forEach((vector, i) => {
		if (!vector) return;
		embeddable[i].payload.embedding = JSON.stringify(vector);
		embedded += 1;
	});
	return { embedded, embeddable: embeddable.length, embeddingConfigured };
}

export function embedShortfallNote(
	counts: DiscoverCounts,
	written: number,
	embeddingConfigured = true,
): string {
	const { embedded, embeddable } = counts;
	if (embedded === written) return "";
	const noText = written - embeddable;
	const providerShortfall = embeddable - embedded;
	const parts: string[] = [];
	if (noText > 0) parts.push(`${noText} had no embeddable text`);
	if (providerShortfall > 0) {
		parts.push(
			embeddingConfigured
				? `${providerShortfall} pending (embedding provider unavailable — the backfill will retry)`
				: `${providerShortfall} pending (no OpenAI embedding key configured)`,
		);
	}
	return parts.length > 0 ? ` (${parts.join("; ")}.)` : "";
}

export function formatIngestDiscoverMcp(
	counts: DiscoverCounts & DiscoverFormatMeta,
	options?: DiscoverFormatMeta,
): string {
	const meta = (
		counts as DiscoverCounts & { [DISCOVER_MCP_META]?: DiscoverFormatMeta }
	)[DISCOVER_MCP_META];
	const connector =
		options?.connector ?? counts.connector ?? meta?.connector ?? "unknown";
	const totalFromCounts =
		counts.inserted +
		counts.updated +
		counts.unchanged +
		counts.skipped +
		counts.excluded;
	const itemCount =
		options?.itemCount ??
		counts.itemCount ??
		meta?.itemCount ??
		totalFromCounts;
	const embeddingConfigured =
		options?.embeddingConfigured ??
		counts.embeddingConfigured ??
		meta?.embeddingConfigured ??
		true;

	const channel = `discovered_${connector}`;
	const written = counts.inserted + counts.updated;
	const embedNote =
		written > 0
			? ` ${counts.embedded}/${written} embedded (semantic search).${embedShortfallNote(counts, written, embeddingConfigured)}`
			: "";
	return (
		`Discovered ${itemCount} item(s) from ${connector} ` +
		`(channel ${channel}): ${counts.inserted} new, ${counts.updated} changed, ` +
		`${counts.unchanged} unchanged` +
		(counts.refreshed > 0 ? ` (${counts.refreshed} envelope-refreshed)` : "") +
		`, ${counts.skipped} skipped (junk/archived)` +
		(counts.excluded > 0 ? `, ${counts.excluded} excluded by policy` : "") +
		"." +
		embedNote
	);
}

export function createIngestDiscoverAction(deps: IngestDiscoverDeps) {
	const repo = (deps.repo ?? deps.discover)!;

	return defineAction({
		id: "ingest_discover",
		domain: "artifacts",
		description: INGEST_DISCOVER_DESCRIPTION,
		schema: discoverSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		run: async (
			args: z.infer<typeof discoverSchema>,
			ctx,
		): Promise<DiscoverCounts> => {
			const userId = ctx.userId ?? "";
			const channel = `discovered_${args.connector}`;
			const now = new Date().toISOString();
			const externalIds = args.items.map((i) => i.external_id);

			const existingRows = await repo.findKnown(userId, channel, externalIds);
			const existing = new Map<string, ExistingRow>();
			for (const row of existingRows ?? []) {
				if (row.source) existing.set(row.source, row);
			}

			const includeArchived = args.include_archived === true;
			const resolvedExclusions =
				typeof deps.exclusionLists === "function"
					? deps.exclusionLists()
					: deps.exclusionLists;

			const toInsert: Record<string, unknown>[] = [];
			const toUpdate: {
				id: string;
				externalId: string;
				payload: Record<string, unknown>;
			}[] = [];
			const toRefresh: EnvelopeRefreshRow[] = [];
			const embedTargets: {
				payload: Record<string, unknown>;
				text: string | null;
			}[] = [];
			let unchanged = 0;
			let skipped = 0;
			let excluded = 0;

			for (const item of args.items) {
				const exclusion = evaluateExclusion(item, resolvedExclusions);
				if (exclusion.excluded) {
					excluded += 1;
					continue;
				}

				if (isJunkTitle(item.title) || isJunkTitle(item.summary)) {
					skipped += 1;
					continue;
				}
				if (item.archived === true && !includeArchived) {
					skipped += 1;
					continue;
				}

				const url = normalizePointerUrl(args.connector, item.url);
				const title = resolveTitle(args.connector, item);
				const processingStatus = pointerProcessingStatus(args.connector, item);

				const prior = existing.get(item.external_id);

				if (item.trashed === true) {
					if (prior && !prior.archived) {
						toUpdate.push({
							id: prior.id,
							externalId: item.external_id,
							payload: {
								archived: true,
								archived_at: now,
								archived_reason: "source_trashed",
							},
						});
					} else {
						skipped += 1;
					}
					continue;
				}

				if (!prior) {
					const insertRow: Record<string, unknown> = {
						id: globalThis.crypto.randomUUID(),
						user_id: userId,
						storage_bucket: "external",
						storage_path: `discovered/${args.connector}/${item.external_id}`,
						storage_url: pointerUrl(args.connector, item.external_id, url),
						filename: `${slugifyPointerTitle(title)}.ref`,
						artifact_type: "original",
						captured_at: now,
						source: item.external_id,
						source_channel: channel,
						surface: channel,
						lifecycle_stage: DISCOVERED_STAGE,
						processing_status: processingStatus,
						title,
						description: pointerDescription(item),
						tags: item.tags ?? [],
						processing_metadata: discoveryMetadata(
							args.connector,
							item,
							now,
							url,
						),
						...originatedAt(args.connector, item),
						...driveColumns(args.connector, item),
					};
					toInsert.push(insertRow);
					embedTargets.push({
						payload: insertRow,
						text: pointerEmbedText(item, title),
					});
					continue;
				}

				const priorArchived = prior.archived === true;
				const isRestoring =
					priorArchived && prior.archived_reason === "source_trashed";

				const priorHash =
					prior.processing_metadata?.discovery?.content_hash ?? null;
				const changed =
					item.content_hash != null && item.content_hash !== priorHash;
				if (changed || isRestoring) {
					const updatePayload: Record<string, unknown> = {
						title,
						description: pointerDescription(item),
						storage_url: pointerUrl(args.connector, item.external_id, url),
						tags: item.tags ?? [],
						surface: channel,
						...(changed
							? {
									lifecycle_stage: DISCOVERED_STAGE,
									processing_status: processingStatus,
								}
							: {}),
						processing_metadata: discoveryMetadata(
							args.connector,
							item,
							now,
							url,
						),
						...originatedAt(args.connector, item),
						...driveColumns(args.connector, item),
						...(isRestoring
							? { archived: false, archived_at: null, archived_reason: null }
							: {}),
					};
					toUpdate.push({
						id: prior.id,
						externalId: item.external_id,
						payload: updatePayload,
					});
					if (changed) {
						embedTargets.push({
							payload: updatePayload,
							text: pointerEmbedText(item, title),
						});
					}
				} else {
					unchanged += 1;
					if (needsEnvelopeRefresh(prior, item)) {
						const drive = driveColumns(args.connector, item);
						toRefresh.push({
							id: prior.id,
							envelope: envelopeFields(item),
							drive_file_id: drive.source_drive_file_id ?? null,
							parent_ids: drive.source_parent_folder_ids ?? null,
							dequeue: processingStatus === "completed",
						});
					}
				}
			}

			const { embedded, embeddable, embeddingConfigured } =
				await attachEmbeddings(embedTargets, deps.embeddings);

			if (toInsert.length > 0) {
				await repo.insert(toInsert);
			}

			for (const { id, externalId, payload } of toUpdate) {
				await repo.update(id, payload, externalId);
			}

			const refreshed = await repo.refreshEnvelopes(toRefresh, userId);

			const counts: DiscoverCounts = {
				inserted: toInsert.length,
				updated: toUpdate.length,
				unchanged,
				refreshed,
				skipped,
				excluded,
				embedded,
				embeddable,
			};
			Object.defineProperty(counts, DISCOVER_MCP_META, {
				value: {
					connector: args.connector,
					itemCount: args.items.length,
					embeddingConfigured,
				} satisfies DiscoverFormatMeta,
				enumerable: false,
			});
			return counts;
		},
		formatMcp: formatIngestDiscoverMcp,
	});
}
