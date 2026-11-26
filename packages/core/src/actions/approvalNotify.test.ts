import { describe, expect, it, vi } from "vitest";
import { withApprovalNotifier } from "./approvalNotify.js";
import type { ActionApprovalStore, ApprovalRequest } from "./gate.js";

const REQ: ApprovalRequest = {
	actionId: "slack_post",
	input: { channel: "C123", text: "Hello" },
	inputSha256: "abc123",
	caller: "mcp",
	requestId: "req-1",
	userId: "user-1",
	clientId: "claude-code",
	sessionId: "sess-1",
};

describe("withApprovalNotifier (#1534)", () => {
	it("1. calls notifier once after park resolves and returns park result unchanged", async () => {
		const order: string[] = [];
		const store: ActionApprovalStore = {
			park: vi.fn(async () => {
				order.push("park");
				return { decisionId: "d1" };
			}),
		};
		const notifier = vi.fn(async () => {
			order.push("notify");
		});
		const res = await withApprovalNotifier(store, notifier).park(REQ);
		expect(res).toEqual({ decisionId: "d1" });
		expect(order).toEqual(["park", "notify"]);
		expect(notifier).toHaveBeenCalledWith(REQ, "d1");
	});

	it("2. when notifier rejects or hangs past timeoutMs, park still resolves d1 and logs one stderr line naming d1", async () => {
		const lines: string[] = [];
		const store: ActionApprovalStore = { park: vi.fn(async () => ({ decisionId: "d1" })) };
		const rejecting = withApprovalNotifier(store, async () => {
			throw new Error("Slack 503");
		}, { writeStderr: (l) => lines.push(l) });
		expect(await rejecting.park(REQ)).toEqual({ decisionId: "d1" });
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("d1");

		const timeoutLines: string[] = [];
		const hanging = withApprovalNotifier(store, () => new Promise<void>(() => {}), {
			timeoutMs: 25,
			writeStderr: (l) => timeoutLines.push(l),
		});
		expect(await hanging.park(REQ)).toEqual({ decisionId: "d1" });
		expect(timeoutLines).toHaveLength(1);
		expect(timeoutLines[0]).toContain("d1");
	});

	it("3. when park rejects, notifier is not called", async () => {
		const store: ActionApprovalStore = {
			park: vi.fn(async () => {
				throw new Error("insert failed");
			}),
		};
		const notifier = vi.fn(async () => {});
		await expect(withApprovalNotifier(store, notifier).park(REQ)).rejects.toThrow("insert failed");
		expect(notifier).not.toHaveBeenCalled();
	});
});
