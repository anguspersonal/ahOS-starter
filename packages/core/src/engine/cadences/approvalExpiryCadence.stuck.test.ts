import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STUCK_APPROVAL_AFTER_MS, STUCK_APPROVAL_REASON, createApprovalExpiryCadence } from "./approvalExpiryCadence.js";

describe("createApprovalExpiryCadence stuck approvals (#1430)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("1. run() returns { expired, stuck_failed } from expirePending(nowIso) and failStuck(cutoff, STUCK_APPROVAL_REASON)", async () => {
		const expirePending = vi.fn().mockResolvedValue(2);
		const failStuck = vi.fn().mockResolvedValue(5);
		const cadence = createApprovalExpiryCadence({ port: { expirePending, failStuck } });

		expect(await cadence.run()).toEqual({ expired: 2, stuck_failed: 5 });
		expect(expirePending).toHaveBeenCalledTimes(1);
		expect(expirePending).toHaveBeenCalledWith("2026-10-11T12:00:00.000Z");
		expect(failStuck).toHaveBeenCalledTimes(1);
		expect(failStuck).toHaveBeenCalledWith("2026-10-11T11:30:00.000Z", STUCK_APPROVAL_REASON);
	});

	it("2. STUCK_APPROVAL_AFTER_MS is 30 minutes and STUCK_APPROVAL_REASON names 30 minutes, may have run, not re-run, action_ledger, <=500 chars", () => {
		expect(STUCK_APPROVAL_AFTER_MS).toBe(30 * 60 * 1000);
		expect(STUCK_APPROVAL_REASON).toMatch(/30 minutes/i);
		expect(STUCK_APPROVAL_REASON).toMatch(/may have run/i);
		expect(STUCK_APPROVAL_REASON).toMatch(/not re-run/i);
		expect(STUCK_APPROVAL_REASON).toContain("action_ledger");
		expect(STUCK_APPROVAL_REASON.length).toBeLessThanOrEqual(500);
	});

	it("3. when either method rejects, the other is still called once and run() rejects naming the failed method", async () => {
		const expirePendingFail = vi.fn().mockRejectedValue(new Error("expire boom"));
		const failStuckOk = vi.fn().mockResolvedValue(1);
		await expect(createApprovalExpiryCadence({ port: { expirePending: expirePendingFail, failStuck: failStuckOk } }).run()).rejects.toThrow(/expirePending.*expire boom/);
		expect(expirePendingFail).toHaveBeenCalledTimes(1);
		expect(failStuckOk).toHaveBeenCalledTimes(1);

		const expirePendingOk = vi.fn().mockResolvedValue(1);
		const failStuckFail = vi.fn().mockRejectedValue(new Error("stuck boom"));
		await expect(createApprovalExpiryCadence({ port: { expirePending: expirePendingOk, failStuck: failStuckFail } }).run()).rejects.toThrow(/failStuck.*stuck boom/);
		expect(expirePendingOk).toHaveBeenCalledTimes(1);
		expect(failStuckFail).toHaveBeenCalledTimes(1);
	});
});
