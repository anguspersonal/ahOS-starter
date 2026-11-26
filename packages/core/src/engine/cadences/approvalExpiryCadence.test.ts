import { describe, expect, it, vi } from "vitest";
import { createApprovalExpiryCadence } from "./approvalExpiryCadence.js";

describe("createApprovalExpiryCadence (#1429)", () => {
	it("defaults to name 'approval_expiry', interval 1h, and enabled true", () => {
		const port = { expirePending: vi.fn().mockResolvedValue(0), failStuck: vi.fn().mockResolvedValue(0) };
		const cadence = createApprovalExpiryCadence({ port });

		expect(cadence.name).toBe("approval_expiry");
		expect(cadence.intervalMs).toBe(60 * 60 * 1000);
		expect(cadence.enabled()).toBe(true);
	});

	it("calls expirePending(nowIso) once and returns { expired: n }", async () => {
		const expirePending = vi.fn().mockResolvedValue(3);
		const failStuck = vi.fn().mockResolvedValue(0);
		const cadence = createApprovalExpiryCadence({ port: { expirePending, failStuck } });

		const counts = await cadence.run();

		expect(counts).toEqual({ expired: 3, stuck_failed: 0 });
		expect(expirePending).toHaveBeenCalledTimes(1);
		const nowArg = expirePending.mock.calls[0]?.[0];
		expect(typeof nowArg).toBe("string");
		expect(Number.isNaN(Date.parse(nowArg))).toBe(false);
	});

	it("rejects run() when the port throws so the runner records an error row", async () => {
		const expirePending = vi.fn().mockRejectedValue(new Error("db connection lost"));
		const failStuck = vi.fn().mockResolvedValue(0);
		const cadence = createApprovalExpiryCadence({ port: { expirePending, failStuck } });

		await expect(cadence.run()).rejects.toThrow("db connection lost");
	});
});
