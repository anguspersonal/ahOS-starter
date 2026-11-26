import { embedAndStore, type RetryOptions } from "../../domain/embeddings.js";
import { mergeEntityProperties, type EntityMergeRecord } from "../../domain/entityMerge.js";
import type { DecisionRepository } from "../../ports/decisions.js";
import type { EmbeddingPort, EmbeddingStorePort } from "../../ports/embeddings.js";
import type { EntityRepository } from "../../ports/entities.js";
import type { EntityMergePort } from "../../ports/entityMerge.js";
import type {
	ReviewCandidateEntity,
	ReviewDecisionItem,
	ReviewListInput,
	ReviewListResult,
	ReviewResolveInput,
	ReviewResolveResult,
} from "../domain/review.js";

export interface CoreReviewDeps {
	decisions: DecisionRepository;
	entities: EntityRepository;
	merge: EntityMergePort;
	embedding?: EmbeddingPort | null | (() => EmbeddingPort | null | undefined);
	embeddingStore?: EmbeddingStorePort;
	resolveUserId?: () => string | undefined;
	retryOptions?: RetryOptions;
}

const noopEmbeddingStore: EmbeddingStorePort = {
	setEmbedding: async () => {},
};

function resolveActiveUserId(
	injectedUserId: string | undefined,
	resolveUserId: (() => string | undefined) | undefined,
): string {
	const userId = injectedUserId ?? resolveUserId?.();
	if (!userId) {
		throw new Error("User ID is required");
	}
	return userId;
}

async function resolvePendingOrThrow(
	decisions: DecisionRepository,
	id: string,
	patch: Record<string, unknown>,
	userId: string,
	verb: "reject" | "approve",
): Promise<void> {
	let updated: boolean;
	try {
		updated = await decisions.resolvePending(id, patch, userId);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to ${verb} decision ${id}: ${message}`);
	}
	if (!updated) {
		throw new Error(`Decision ${id} was resolved concurrently; nothing changed.`);
	}
}

export async function reviewListCore(
	deps: Pick<CoreReviewDeps, "decisions" | "entities" | "resolveUserId">,
	args: ReviewListInput,
	injectedUserId?: string,
): Promise<ReviewListResult> {
	const userId = resolveActiveUserId(injectedUserId, deps.resolveUserId);
	const limit = args.limit ?? 20;
	const offset = args.offset ?? 0;

	const { rows, total } = await deps.decisions.listPage(
		{
			status: args.status,
			decisionType: args.decision_type,
			offset,
			limit,
		},
		userId,
	);

	const entityIdsToFetch = new Set<string>();
	for (const row of rows) {
		const payload = (row.decision_payload || {}) as Record<string, unknown>;
		if (row.decision_type === "merge_suggested") {
			if (typeof payload.winnerEntityId === "string" && payload.winnerEntityId.trim()) {
				entityIdsToFetch.add(payload.winnerEntityId);
			}
			if (typeof payload.loserEntityId === "string" && payload.loserEntityId.trim()) {
				entityIdsToFetch.add(payload.loserEntityId);
			}
		}
		if (Array.isArray(payload.linked_entity_ids)) {
			for (const id of payload.linked_entity_ids) {
				if (typeof id === "string" && id.trim()) {
					entityIdsToFetch.add(id.trim());
				}
			}
		}
		if (Array.isArray(payload.candidate_entity_ids)) {
			for (const id of payload.candidate_entity_ids) {
				if (typeof id === "string" && id.trim()) {
					entityIdsToFetch.add(id.trim());
				}
			}
		}
	}

	const entityMap = new Map<string, ReviewCandidateEntity>();
	if (entityIdsToFetch.size > 0) {
		const { rows: entityRows } = await deps.entities.loadRows(
			{
				ids: Array.from(entityIdsToFetch),
				include_archived: true,
				limit: entityIdsToFetch.size,
			},
			userId,
		);
		for (const e of entityRows) {
			entityMap.set(e.id, {
				id: e.id,
				title: e.title ?? null,
				entity_type: e.entity_type ?? null,
			});
		}
	}

	const decisions: ReviewDecisionItem[] = rows.map((row) => {
		const item: ReviewDecisionItem = {
			id: row.id,
			decision_type: row.decision_type,
			review_type: row.review_type,
			stage: row.stage,
			status: row.status,
			title: row.title,
			description: row.description,
			confidence_score: row.confidence_score,
			decision_payload: (row.decision_payload || {}) as Record<string, unknown>,
			created_at: row.created_at,
			resolved_at: row.resolved_at,
			resolved_by: row.resolved_by,
			resolution_notes: row.resolution_notes,
		};
		const p = item.decision_payload;
		if (row.decision_type === "merge_suggested") {
			const wId = typeof p.winnerEntityId === "string" ? p.winnerEntityId : undefined;
			const lId = typeof p.loserEntityId === "string" ? p.loserEntityId : undefined;
			item.candidate_entities = {
				winner: wId
					? entityMap.get(wId) ?? {
							id: wId,
							title: (p.winnerName as string) ?? null,
							entity_type: (p.entityType as string) ?? null,
						}
					: null,
				loser: lId
					? entityMap.get(lId) ?? {
							id: lId,
							title: (p.loserName as string) ?? null,
							entity_type: (p.entityType as string) ?? null,
						}
					: null,
			};
		}
		if (Array.isArray(p.linked_entity_ids)) {
			const linkedIds = p.linked_entity_ids
				.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
				.map((id) => id.trim());
			if (linkedIds.length > 0) {
				item.linked_entities = linkedIds.map(
					(id) => entityMap.get(id) ?? { id, title: null, entity_type: null },
				);
			}
		}
		if (Array.isArray(p.candidate_entity_ids)) {
			const candidateIds = p.candidate_entity_ids
				.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
				.map((id) => id.trim());
			if (candidateIds.length > 0) {
				item.disambiguation_candidates = candidateIds.map(
					(id) => entityMap.get(id) ?? { id, title: null, entity_type: null },
				);
			}
		}
		return item;
	});

	return {
		decisions,
		total,
		limit,
		offset,
	};
}

export async function reviewResolveCore(
	deps: CoreReviewDeps,
	args: ReviewResolveInput,
	injectedUserId?: string,
): Promise<ReviewResolveResult> {
	const userId = resolveActiveUserId(injectedUserId, deps.resolveUserId);

	const decision = await deps.decisions.getOne(args.decision_id, userId);
	if (!decision) {
		throw new Error(`System decision not found: ${args.decision_id}`);
	}
	if (decision.decision_type === "action_approval") {
		throw new Error(
			`Decision ${args.decision_id} is an action approval; approve or reject it in the Approvals inbox, not with review_resolve.`,
		);
	}
	if (decision.status !== "pending") {
		throw new Error(
			`Decision ${args.decision_id} is not pending (status: ${decision.status}); refusing to reprocess.`,
		);
	}

	const nowIso = new Date().toISOString();

	if (args.action === "reject") {
		await resolvePendingOrThrow(
			deps.decisions,
			args.decision_id,
			{
				status: "rejected",
				resolved_by: userId,
				resolved_at: nowIso,
				resolution_notes: args.resolution_notes ?? "Rejected by user",
			},
			userId,
			"reject",
		);

		return {
			success: true,
			decisionId: args.decision_id,
			status: "rejected",
			action: "reject",
			decisionType: decision.decision_type,
			notes: args.resolution_notes ?? "Rejected by user",
		};
	}

	if (decision.decision_type === "merge_suggested") {
		const payload = (decision.decision_payload || {}) as Record<string, unknown>;
		const payloadWinnerId = typeof payload.winnerEntityId === "string" ? payload.winnerEntityId : undefined;
		const payloadLoserId = typeof payload.loserEntityId === "string" ? payload.loserEntityId : undefined;

		if (!payloadWinnerId || !payloadLoserId) {
			throw new Error(`Missing winnerEntityId/loserEntityId for merge_suggested decision ${args.decision_id}`);
		}
		if (payloadWinnerId === payloadLoserId) {
			throw new Error(`merge_suggested decision ${args.decision_id} has winnerEntityId === loserEntityId`);
		}

		let winnerId = payloadWinnerId;
		let loserId = payloadLoserId;
		let survivorOverridden = false;

		const survivor = args.selected_entity_id?.trim();
		if (survivor) {
			if (survivor === payloadLoserId) {
				winnerId = payloadLoserId;
				loserId = payloadWinnerId;
				survivorOverridden = true;
			} else if (survivor !== payloadWinnerId) {
				throw new Error(
					`selected_entity_id ${survivor} is not part of merge decision ${args.decision_id} (winner: ${payloadWinnerId}, loser: ${payloadLoserId})`,
				);
			}
		}

		const [winnerRow, loserRow] = await Promise.all([
			deps.entities.getById(winnerId, userId),
			deps.entities.getById(loserId, userId),
		]);

		if (!winnerRow) {
			throw new Error(`Merge winner entity not found: ${winnerId}`);
		}
		if (!loserRow) {
			throw new Error(`Merge loser entity not found: ${loserId}`);
		}

		if (winnerRow.archived) {
			throw new Error(
				`Merge winner entity ${winnerId} is archived; refusing to merge onto a tombstoned winner.`,
			);
		}

		const loserProps = (loserRow.properties || {}) as Record<string, unknown>;
		const loserMergedInto = typeof loserProps.merged_into === "string" ? loserProps.merged_into : undefined;
		const alreadyMerged = loserRow.archived === true && loserMergedInto === winnerId;

		if (loserRow.archived === true && loserMergedInto !== undefined && loserMergedInto !== winnerId) {
			await resolvePendingOrThrow(
				deps.decisions,
				args.decision_id,
				{
					status: "rejected",
					resolved_by: userId,
					resolved_at: nowIso,
					resolution_notes:
						args.resolution_notes ??
						`Superseded: loser entity ${loserId} was already merged into ${loserMergedInto}, not winner ${winnerId}.`,
				},
				userId,
				"reject",
			);

			return {
				success: true,
				decisionId: args.decision_id,
				status: "rejected",
				action: "reject",
				decisionType: decision.decision_type,
				notes: `Superseded: loser entity ${loserId} was already merged into ${loserMergedInto}`,
			};
		}

		let mergeOp: EntityMergeRecord | undefined;

		if (!alreadyMerged) {
			const winnerProps = (winnerRow.properties || {}) as Record<string, unknown>;
			const {
				mergedProperties,
				carriedKeys: propertiesCarried,
				skippedKeys: propertiesSkipped,
			} = mergeEntityProperties(winnerRow.entity_type, winnerProps, loserProps);

			const aliasSet = new Set<string>(
				Array.isArray(mergedProperties.aliases)
					? (mergedProperties.aliases as unknown[]).filter((a): a is string => typeof a === "string")
					: [],
			);
			const aliasesAdded: string[] = [];
			if (loserRow.title && loserRow.title !== winnerRow.title && !aliasSet.has(loserRow.title)) {
				aliasSet.add(loserRow.title);
				aliasesAdded.push(loserRow.title);
			}
			if (Array.isArray(loserProps.aliases)) {
				for (const a of loserProps.aliases as unknown[]) {
					if (typeof a === "string" && a && a !== winnerRow.title && !aliasSet.has(a)) {
						aliasSet.add(a);
						aliasesAdded.push(a);
					}
				}
			}

			const finalWinnerProps = {
				...mergedProperties,
			};
			delete (finalWinnerProps as Record<string, unknown>).aliases;

			mergeOp = await deps.merge.merge({
				winnerId,
				loserId,
				userId,
				winnerRow,
				loserRow,
				finalWinnerProps,
				winnerAliases: Array.from(aliasSet),
				aliasesAdded,
				propertiesCarried,
				propertiesSkipped,
				decisionId: args.decision_id,
				resolutionNotes: args.resolution_notes ?? "Approved by user",
				survivorOverridden,
				decisionStatus: "approved",
				resolvedBy: userId,
				payload,
				nowIso,
			});

			const embeddingPort =
				typeof deps.embedding === "function" ? deps.embedding() : deps.embedding;
			try {
				await embedAndStore(
					embeddingPort,
					deps.embeddingStore ?? noopEmbeddingStore,
					"entities",
					winnerId,
					{
						title: winnerRow.title,
						description: winnerRow.description,
						properties: finalWinnerProps,
					},
					{ retryOptions: deps.retryOptions },
				);
			} catch {
				// Embed on write is best effort
			}
		} else {
			await resolvePendingOrThrow(
				deps.decisions,
				args.decision_id,
				{
					status: "approved",
					resolved_by: userId,
					resolved_at: nowIso,
					resolution_notes: args.resolution_notes ?? "Approved by user",
					decision_payload: {
						...payload,
						winnerEntityId: winnerId,
						loserEntityId: loserId,
						mergedAt: nowIso,
						survivorOverridden,
					},
				},
				userId,
				"approve",
			);
		}

		return {
			success: true,
			decisionId: args.decision_id,
			status: "approved",
			action: "approve",
			decisionType: decision.decision_type,
			mergeOpId:
				mergeOp?.op_id ?? (typeof payload?.mergeOpId === "string" ? payload.mergeOpId : undefined),
			winnerId,
			loserId,
			survivorOverridden,
			notes: args.resolution_notes ?? "Approved by user",
		};
	}

	// Generic approval for other proposal types
	const selectedEntityId = args.selected_entity_id?.trim();
	const updatePayload: Record<string, unknown> = {
		status: "approved",
		resolved_by: userId,
		resolved_at: nowIso,
		resolution_notes: args.resolution_notes ?? "Approved by user",
	};
	if (selectedEntityId) {
		updatePayload.decision_payload = {
			...(decision.decision_payload || {}),
			selected_entity_id: selectedEntityId,
		};
	}

	await resolvePendingOrThrow(deps.decisions, args.decision_id, updatePayload, userId, "approve");

	return {
		success: true,
		decisionId: args.decision_id,
		status: "approved",
		action: "approve",
		decisionType: decision.decision_type,
		notes: args.resolution_notes ?? "Approved by user",
	};
}
