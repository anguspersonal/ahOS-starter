import type { ApprovalExpiryPort } from "../../engine/cadences/approvalExpiryCadence.js";
import type { SchedulerSupabaseClient } from "./scheduler.js";

const EXPIRY_RESOLUTION_NOTES = "Expired after 7 days without approval; nothing ran.";

/**
 * Creates the Supabase adapter implementing `ApprovalExpiryPort` (ADR-104 #1403, #1429).
 * Updates pending `action_approval` rows in `system_decisions` whose `expires_at < nowIso`
 * to `expired` with `{ count: "exact" }`.
 */
export function createSupabaseApprovalExpiryPort(
	supabase: SchedulerSupabaseClient,
): ApprovalExpiryPort {
	return {
		async expirePending(nowIso: string): Promise<number> {
			const { count, error } = await supabase
				.from("system_decisions")
				.update(
					{
						status: "expired",
						resolved_at: nowIso,
						resolution_notes: EXPIRY_RESOLUTION_NOTES,
					},
					{ count: "exact" },
				)
				.eq("decision_type", "action_approval")
				.eq("status", "pending")
				.lt("expires_at", nowIso);

			if (error) {
				throw new Error(`approval_expiry update failed: ${error.message}`);
			}
			if (count === null || count === undefined) {
				throw new Error("approval_expiry update returned null count");
			}
			return count;
		},

		async failStuck(approvedBeforeIso: string, reason: string): Promise<number> {
			const { count, error } = await supabase
				.from("system_decisions")
				.update(
					{
						status: "failed",
						resolution_data: {
							outcome: "failed",
							error: reason,
						},
					},
					{ count: "exact" },
				)
				.eq("decision_type", "action_approval")
				.eq("status", "approved")
				.lt("resolved_at", approvedBeforeIso);

			if (error) {
				throw new Error(`approval_expiry failStuck update failed: ${error.message}`);
			}
			if (count === null || count === undefined) {
				throw new Error("approval_expiry failStuck update returned null count");
			}
			return count;
		},
	};
}
