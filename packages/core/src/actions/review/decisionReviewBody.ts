import type { ActionContext } from "../types.js";
import type {
	DecisionReviewInput,
	DecisionReviewResult,
} from "../domain/governance.js";
import type { DecisionRepository } from "../../ports/decisions.js";

async function assertNoActionApprovals(
	repo: DecisionRepository,
	ids: string[],
	userId: string | undefined,
): Promise<void> {
	if (ids.length === 0) return;
	const rows = await repo.typesOf(ids, userId);
	for (const row of rows) {
		if (row.decision_type === "action_approval") {
			throw new Error(
				`Decision ${row.id} is an action approval; approve or reject it in the Approvals inbox, not with decision_review.`,
			);
		}
	}
}

export async function runDecisionReview(
	repo: DecisionRepository,
	input: DecisionReviewInput,
	ctx?: ActionContext,
	resolveUserId?: () => string | undefined,
): Promise<DecisionReviewResult> {
	let userId: string | undefined = ctx?.userId;
	if (!userId && resolveUserId) {
		try {
			userId = resolveUserId();
		} catch {
			// Environment without user ID in mock tests
		}
	}

	const nowIso = new Date().toISOString();

	switch (input.operation) {
		case "list_pending": {
			const decisions = await repo.listRecent(
				{
					status: input.status,
					blockingOnly: input.blocking_only,
					stage: input.stage,
					reviewType: input.review_type,
					limit: input.limit,
				},
				userId,
			);

			return {
				operation: "list_pending",
				count: decisions.length,
				decisions,
			};
		}

		case "get": {
			if (!input.id) {
				throw new Error("id is required for get operation");
			}

			const decision = await repo.get(input.id, userId);

			return {
				operation: "get",
				decision,
			};
		}

		case "approve": {
			if (!input.id) {
				throw new Error("id is required for approve operation");
			}

			await assertNoActionApprovals(repo, [input.id], userId);

			const updatePayload: Record<string, unknown> = {
				status: "approved",
				resolved_at: nowIso,
				updated_at: nowIso,
				resolution_notes: input.resolution_notes ?? null,
			};
			if (userId) {
				updatePayload.resolved_by = userId;
			}

			try {
				const rows = await repo.resolve(
					[input.id],
					updatePayload,
					{ excludeType: "action_approval" },
					userId,
				);
				return {
					operation: "approve",
					decision: rows[0],
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`Failed to approve decision ${input.id}: ${msg}`);
			}
		}

		case "reject": {
			if (!input.id) {
				throw new Error("id is required for reject operation");
			}

			await assertNoActionApprovals(repo, [input.id], userId);

			const updatePayload: Record<string, unknown> = {
				status: "rejected",
				resolved_at: nowIso,
				updated_at: nowIso,
				resolution_notes: input.resolution_notes ?? null,
			};
			if (userId) {
				updatePayload.resolved_by = userId;
			}

			try {
				const rows = await repo.resolve(
					[input.id],
					updatePayload,
					{ excludeType: "action_approval" },
					userId,
				);
				return {
					operation: "reject",
					decision: rows[0],
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`Failed to reject decision ${input.id}: ${msg}`);
			}
		}

		case "modify_and_approve": {
			if (!input.id) {
				throw new Error("id is required for modify_and_approve operation");
			}

			await assertNoActionApprovals(repo, [input.id], userId);

			const updatePayload: Record<string, unknown> = {
				status: "modified",
				resolved_at: nowIso,
				updated_at: nowIso,
				resolution_notes: input.resolution_notes ?? null,
				resolution_data: input.resolution_data ?? null,
			};
			if (userId) {
				updatePayload.resolved_by = userId;
			}

			try {
				const rows = await repo.resolve(
					[input.id],
					updatePayload,
					{ excludeType: "action_approval" },
					userId,
				);
				return {
					operation: "modify_and_approve",
					decision: rows[0],
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`Failed to modify decision ${input.id}: ${msg}`);
			}
		}

		case "bulk_resolve": {
			if (!input.ids || input.ids.length === 0) {
				throw new Error("ids array is required for bulk_resolve operation");
			}

			await assertNoActionApprovals(repo, input.ids, userId);

			const targetStatus = input.status ?? "approved";
			const updatePayload: Record<string, unknown> = {
				status: targetStatus,
				resolved_at: nowIso,
				updated_at: nowIso,
				resolution_notes: input.resolution_notes ?? null,
			};
			if (userId) {
				updatePayload.resolved_by = userId;
			}

			try {
				const rows = await repo.resolve(
					input.ids,
					updatePayload,
					{ excludeType: "action_approval" },
					userId,
				);
				return {
					operation: "bulk_resolve",
					resolved_count: rows.length,
					ids: rows.map((row) => row.id),
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`Failed to bulk resolve decisions: ${msg}`);
			}
		}

		default:
			throw new Error(`Unsupported operation: ${(input as { operation: string }).operation}`);
	}
}
