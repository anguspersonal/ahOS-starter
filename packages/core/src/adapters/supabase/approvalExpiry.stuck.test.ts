import { describe, expect, it, vi } from "vitest";
import { createSupabaseApprovalExpiryPort } from "./approvalExpiry.js";
import type { SchedulerSupabaseClient } from "./scheduler.js";

function createFakeSupabase(result: { count: number | null; error: { message: string } | null }) {
	const lt = vi.fn().mockResolvedValue(result);
	const eqStatus = vi.fn().mockReturnValue({ lt });
	const eqDecisionType = vi.fn().mockReturnValue({ eq: eqStatus });
	const update = vi.fn().mockReturnValue({ eq: eqDecisionType });
	const from = vi.fn().mockReturnValue({ update });
	const client: SchedulerSupabaseClient = { from };
	return { client, from, update, eqDecisionType, eqStatus, lt };
}

describe("createSupabaseApprovalExpiryPort.failStuck (#1430)", () => {
	it("4. updates approved action_approval rows with resolved_at < cutoff to failed and keeps claim values", async () => {
		const { client, from, update, eqDecisionType, eqStatus, lt } = createFakeSupabase({ count: 3, error: null });
		const port = createSupabaseApprovalExpiryPort(client);
		const cutoff = "2026-10-11T11:30:00.000Z";
		const reason = "Approved more than 30 minutes ago with no outcome recorded";

		expect(await port.failStuck(cutoff, reason)).toBe(3);
		expect(from).toHaveBeenCalledTimes(1);
		expect(from).toHaveBeenCalledWith("system_decisions");
		expect(update).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledWith(
			{ status: "failed", resolution_data: { outcome: "failed", error: reason } },
			{ count: "exact" },
		);
		const payload = update.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(payload).not.toHaveProperty("resolved_at");
		expect(payload).not.toHaveProperty("resolved_by");
		expect(payload).not.toHaveProperty("resolution_notes");
		expect(eqDecisionType).toHaveBeenCalledWith("decision_type", "action_approval");
		expect(eqStatus).toHaveBeenCalledWith("status", "approved");
		expect(lt).toHaveBeenCalledWith("resolved_at", cutoff);
	});

	it("5. rejects on PostgREST error with its message and rejects on null count", async () => {
		const errPort = createSupabaseApprovalExpiryPort(createFakeSupabase({ count: null, error: { message: "connection reset by peer" } }).client);
		await expect(errPort.failStuck("2026-10-11T11:30:00.000Z", "reason")).rejects.toThrow("connection reset by peer");

		const nullPort = createSupabaseApprovalExpiryPort(createFakeSupabase({ count: null, error: null }).client);
		await expect(nullPort.failStuck("2026-10-11T11:30:00.000Z", "reason")).rejects.toThrow(/null count/i);
	});
});
