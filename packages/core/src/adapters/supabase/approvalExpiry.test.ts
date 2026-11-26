import { describe, expect, it, vi } from "vitest";
import { createSupabaseApprovalExpiryPort } from "./approvalExpiry.js";
import type { SchedulerSupabaseClient } from "./scheduler.js";

function createFakeClient(result: { count: number | null; error: { message: string } | null }) {
	const lt = vi.fn().mockResolvedValue(result);
	const eqStatus = vi.fn().mockReturnValue({ lt });
	const eqDecisionType = vi.fn().mockReturnValue({ eq: eqStatus });
	const update = vi.fn().mockReturnValue({ eq: eqDecisionType });
	const from = vi.fn().mockReturnValue({ update });

	const client: SchedulerSupabaseClient = {
		from,
	};

	return { client, from, update, eqDecisionType, eqStatus, lt };
}

describe("createSupabaseApprovalExpiryPort (#1429)", () => {
	it("updates system_decisions pending action_approval rows past expires_at and returns count", async () => {
		const { client, from, update, eqDecisionType, eqStatus, lt } = createFakeClient({
			count: 4,
			error: null,
		});
		const port = createSupabaseApprovalExpiryPort(client);
		const now = "2026-10-19T12:00:00.000Z";

		const count = await port.expirePending(now);

		expect(count).toBe(4);
		expect(from).toHaveBeenCalledTimes(1);
		expect(from).toHaveBeenCalledWith("system_decisions");
		expect(update).toHaveBeenCalledWith(
			{
				status: "expired",
				resolved_at: now,
				resolution_notes: "Expired after 7 days without approval; nothing ran.",
			},
			{ count: "exact" },
		);
		expect(eqDecisionType).toHaveBeenCalledWith("decision_type", "action_approval");
		expect(eqStatus).toHaveBeenCalledWith("status", "pending");
		expect(lt).toHaveBeenCalledWith("expires_at", now);
	});

	it("throws when Supabase returns an error", async () => {
		const { client } = createFakeClient({
			count: null,
			error: { message: "permission denied for table system_decisions" },
		});
		const port = createSupabaseApprovalExpiryPort(client);

		await expect(port.expirePending("2026-10-19T12:00:00.000Z")).rejects.toThrow(
			"permission denied for table system_decisions",
		);
	});

	it("throws when count is null rather than returning 0", async () => {
		const { client } = createFakeClient({
			count: null,
			error: null,
		});
		const port = createSupabaseApprovalExpiryPort(client);

		await expect(port.expirePending("2026-10-19T12:00:00.000Z")).rejects.toThrow(/null count/i);
	});
});
