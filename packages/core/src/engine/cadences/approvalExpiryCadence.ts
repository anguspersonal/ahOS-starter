import type { CadenceDefinition } from "../runner.js";

export const STUCK_APPROVAL_AFTER_MS = 30 * 60 * 1000;
export const STUCK_APPROVAL_REASON =
	"Approved more than 30 minutes ago with no outcome recorded; the call may have run and was not re-run. Check action_ledger for this decision_id.";

export interface ApprovalExpiryPort {
	expirePending(nowIso: string): Promise<number>;
	failStuck(approvedBeforeIso: string, reason: string): Promise<number>;
}

export interface ApprovalExpiryCadenceOptions {
	port: ApprovalExpiryPort;
	intervalMs?: number;
	enabled?: () => boolean;
}

/**
 * Creates the hourly `approval_expiry` cadence definition (ADR-101 §1, ADR-104 #1403, #1429, #1430).
 * Moves `action_approval` rows in `system_decisions` still `pending` past their `expires_at`
 * to `expired`, marks rows stuck at `approved` for 30 minutes as `failed`, and never approves or runs anything.
 */
export function createApprovalExpiryCadence(
	options: ApprovalExpiryCadenceOptions,
): CadenceDefinition {
	return {
		name: "approval_expiry",
		intervalMs: options.intervalMs ?? 60 * 60 * 1000,
		enabled: options.enabled ?? (() => true),
		run: async () => {
			const nowMs = Date.now();
			const nowIso = new Date(nowMs).toISOString();
			const cutoffIso = new Date(nowMs - STUCK_APPROVAL_AFTER_MS).toISOString();
			const [expiredRes, stuckRes] = await Promise.allSettled([
				options.port.expirePending(nowIso),
				options.port.failStuck(cutoffIso, STUCK_APPROVAL_REASON),
			]);
			const errors: string[] = [];
			if (expiredRes.status === "rejected") {
				const msg = expiredRes.reason instanceof Error ? expiredRes.reason.message : String(expiredRes.reason);
				errors.push(`expirePending: ${msg}`);
			}
			if (stuckRes.status === "rejected") {
				const msg = stuckRes.reason instanceof Error ? stuckRes.reason.message : String(stuckRes.reason);
				errors.push(`failStuck: ${msg}`);
			}
			if (errors.length > 0) {
				throw new Error(errors.join("; "));
			}
			return {
				expired: (expiredRes as PromiseFulfilledResult<number>).value,
				stuck_failed: (stuckRes as PromiseFulfilledResult<number>).value,
			};
		},
	};
}
