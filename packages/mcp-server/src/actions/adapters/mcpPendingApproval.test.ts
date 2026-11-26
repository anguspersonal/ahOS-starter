import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	defineAction,
	setActionApprovalStore,
	type ActionAuditRecord,
} from "@ahkms/core";
import { toMcpTool } from "./mcp.js";
import { configureApprovals } from "../approvals.js";

function makeFakeClient(
	responder: () => { data: unknown; error: { code?: string; message: string } | null },
) {
	const calls: Array<{ table: string; payload: Record<string, unknown> }> = [];
	const client = {
		from(table: string) {
			return {
				insert(payload: Record<string, unknown>) {
					calls.push({ table, payload });
					return {
						select(_cols: string) {
							return {
								async single() {
									return responder();
								},
							};
						},
					};
				},
			};
		},
	};
	return { client, calls };
}

describe("toMcpTool pending_approval handling (#1417)", () => {
	const originalUserId = process.env.KMS_USER_ID;

	beforeEach(() => {
		process.env.KMS_USER_ID = "00000000-0000-0000-0000-000000000001";
	});

	afterEach(() => {
		setActionApprovalStore(undefined);
		if (originalUserId === undefined) {
			delete process.env.KMS_USER_ID;
		} else {
			process.env.KMS_USER_ID = originalUserId;
		}
	});

	it("parks a gated action via configureApprovals(fake.client), returns non-error pending_approval text, and never calls run (Case 4)", async () => {
		const fake = makeFakeClient(() => ({
			data: { id: "d-1" },
			error: null,
		}));
		configureApprovals(fake.client as any);

		const runSpy = vi.fn(async () => ({ sent: true }));
		const gatedAction = defineAction({
			id: "test_outward_send",
			description: "Sends an outward message requiring approval",
			schema: z.object({ recipient: z.string(), body: z.string() }),
			needsApproval: true,
			run: runSpy,
		});

		const audits: ActionAuditRecord[] = [];
		const tool = toMcpTool(gatedAction, {
			auditSink: (record) => {
				audits.push(record);
			},
		});

		const res = await tool.handler(
			{ recipient: "alice@example.com", body: "hello" },
			{ authInfo: { clientId: "claude-desktop" }, sessionId: "sess-99" },
		);

		expect(runSpy).not.toHaveBeenCalled();
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]?.table).toBe("system_decisions");
		expect(fake.calls[0]?.payload.decision_type).toBe("action_approval");

		expect((res as { isError?: unknown }).isError).toBeUndefined();
		expect(res.content).toHaveLength(1);
		expect(res.content[0]?.type).toBe("text");

		const lines = res.content[0]!.text.split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]!)).toEqual({
			status: "pending_approval",
			decision_id: "d-1",
			action_id: "test_outward_send",
		});
		expect(lines[1]).toMatch(/Approvals inbox/i);
		expect(lines[1]).toMatch(/do not retry/i);
		expect(res.structuredContent).toEqual({
			status: "pending_approval",
			decision_id: "d-1",
			action_id: "test_outward_send",
		});

		expect(audits).toHaveLength(1);
		expect(audits[0]?.outcome).toBe("pending_approval");
		expect(audits[0]?.decisionId).toBe("d-1");
		expect(audits[0]?.inputSha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("rejects without running when fake answers an error or no store is installed, and leaves ungated actions unchanged (Case 5)", async () => {
		const runSpy = vi.fn(async () => ({ ok: true }));
		const gatedAction = defineAction({
			id: "test_gated_error_cases",
			description: "Gated action for error & unconfigured store cases",
			schema: z.object({ target: z.string() }),
			needsApproval: true,
			run: runSpy,
		});
		const gatedTool = toMcpTool(gatedAction, { auditSink: () => {} });

		// 1. When the fake answers an error, the handler rejects and run is never called
		const failingFake = makeFakeClient(() => ({
			data: null,
			error: { code: "23514", message: "check constraint failed" },
		}));
		configureApprovals(failingFake.client as any);

		await expect(gatedTool.handler({ target: "prod" })).rejects.toThrow(
			/system_decisions.*23514/,
		);
		expect(runSpy).not.toHaveBeenCalled();

		// 2. With no store installed, the gate's refusal rejects and run is never called
		setActionApprovalStore(undefined);
		await expect(gatedTool.handler({ target: "prod" })).rejects.toThrow(
			/no approval store is configured/i,
		);
		expect(runSpy).not.toHaveBeenCalled();

		// 3. An ungated action's text output is unchanged, and non-PendingApprovalError rethrows
		const ungatedAction = defineAction({
			id: "test_ungated_ok",
			description: "Ungated action returning normal output",
			schema: z.object({ greeting: z.string() }),
			async run(input) {
				return { echoed: input.greeting };
			},
		});
		const ungatedTool = toMcpTool(ungatedAction, { auditSink: () => {} });
		const okRes = await ungatedTool.handler({ greeting: "hi" });
		expect(okRes).toEqual({
			content: [{ type: "text", text: JSON.stringify({ echoed: "hi" }, null, 2) }],
			structuredContent: { echoed: "hi" },
		});

		const boom = new Error("downstream service exploded");
		const failingAction = defineAction({
			id: "test_ungated_throws",
			description: "Ungated action that throws",
			schema: z.object({}),
			async run() {
				throw boom;
			},
		});
		const failingTool = toMcpTool(failingAction, { auditSink: () => {} });
		await expect(failingTool.handler({})).rejects.toBe(boom);
	});
});
