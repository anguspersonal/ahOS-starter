import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeAction } from "./adapters/direct.js";
import { defineAction } from "./defineAction.js";
import { ApprovalDeniedError, setActionApprovalStore, type ActionApprovalLifecycleStore, type ApprovalRequest, type InClientAnswer } from "./gate.js";
import { inputSha256 } from "./inputHash.js";
import type { ActionAuditRecord } from "./types.js";

function setup() {
	const rows = new Map<string, { id: string; status: string; actionId: string; input: unknown; inputSha256: string; caller: string; userId: string; notes: string | null; error?: string }>();
	const records: ActionAuditRecord[] = [];
	let seq = 0;
	const store: ActionApprovalLifecycleStore = {
		async park(req: ApprovalRequest) {
			const id = `dec-${++seq}`;
			rows.set(id, { id, status: "pending", actionId: req.actionId, input: req.input, inputSha256: req.inputSha256, caller: req.caller, userId: req.userId ?? "u-1", notes: null });
			return { decisionId: id };
		},
		async claim(id, userId, notes) {
			const r = rows.get(id);
			if (!r || r.status !== "pending" || r.userId !== userId) return null;
			Object.assign(r, { status: "approved", notes: notes ?? null });
			return { decisionId: r.id, actionId: r.actionId, input: r.input, inputSha256: r.inputSha256, caller: r.caller, userId: r.userId };
		},
		async finish(id, res, errArg) {
			const r = rows.get(id)!;
			r.status = typeof res === "string" ? res : (res.outcome ?? res.status ?? "executed");
			r.error = typeof res === "string" ? errArg : res.error;
		},
		async reject(id, userId, notes) {
			const r = rows.get(id);
			if (!r || r.status !== "pending" || r.userId !== userId) return false;
			Object.assign(r, { status: "rejected", notes: notes ?? null });
			return true;
		},
	};
	setActionApprovalStore(store);
	const run = vi.fn(async (input: { msg: string; count: number }) => ({ sent: input.msg, count: input.count }));
	const action = defineAction({ id: "send_msg", description: "Send", schema: z.object({ msg: z.string(), count: z.number().default(1) }), needsApproval: true, run });
	const auditSink = (rec: ActionAuditRecord) => { records.push(rec); };
	return { rows, records, store, run, action, auditSink };
}

describe("executeAction with inClientApproval (#1424)", () => {
	afterEach(() => setActionApprovalStore(undefined));

	it("1. ask resolves approve: runs once, marks executed with client notes, and emits pending_approval then success", async () => {
		const { rows, records, run, action, auditSink } = setup();
		const ask = vi.fn(async (): Promise<InClientAnswer> => "approve");
		const out = await executeAction(action, { msg: "hi" }, { auditSink, context: { caller: "mcp", userId: "u-1" }, inClientApproval: { clientId: "c1", ask } });
		expect(out).toEqual({ sent: "hi", count: 1 });
		expect(run).toHaveBeenCalledTimes(1);
		expect(ask).toHaveBeenCalledWith({ decisionId: "dec-1", actionId: "send_msg", input: { msg: "hi", count: 1 }, caller: "mcp" });
		expect(rows.get("dec-1")).toMatchObject({ status: "executed", notes: "approved in client c1" });
		expect(records.map((r) => [r.outcome, r.decisionId])).toEqual([["pending_approval", "dec-1"], ["success", "dec-1"]]);
	});

	it("2. ask resolves reject: throws ApprovalDeniedError, never calls run, marks rejected, and emits pending_approval then denied", async () => {
		const { rows, records, run, action, auditSink } = setup();
		await expect(executeAction(action, { msg: "hi" }, { auditSink, context: { caller: "mcp", userId: "u-1" }, inClientApproval: { clientId: "c1", ask: async () => "reject" } })).rejects.toSatisfy((err: unknown) => {
			expect(err).toBeInstanceOf(ApprovalDeniedError);
			expect((err as Error).message).not.toMatch(/validation|required|invalid|must differ/i);
			expect((err as Error).message).toMatch(/nothing ran.*do not retry unless the owner asks/i);
			return true;
		});
		expect(run).not.toHaveBeenCalled();
		expect(rows.get("dec-1")).toMatchObject({ status: "rejected", notes: "declined in client c1" });
		expect(records.map((r) => [r.outcome, r.decisionId])).toEqual([["pending_approval", "dec-1"], ["denied", "dec-1"]]);
		expect(records[1].errorMessage).toBeTruthy();
	});

	it.each([
		["unanswered", async (): Promise<InClientAnswer> => "unanswered"],
		["rejects", async (): Promise<InClientAnswer> => { throw new Error("timeout"); }],
	])("3. ask %s: throws PendingApprovalError, leaves row pending, and emits only pending_approval", async (_label, ask) => {
		const { rows, records, run, action, auditSink } = setup();
		await expect(executeAction(action, { msg: "hi" }, { auditSink, context: { caller: "mcp", userId: "u-1" }, inClientApproval: { clientId: "c1", ask } })).rejects.toMatchObject({ name: "PendingApprovalError", decisionId: "dec-1" });
		expect(run).not.toHaveBeenCalled();
		expect(rows.get("dec-1")?.status).toBe("pending");
		expect(records.map((r) => [r.outcome, r.decisionId])).toEqual([["pending_approval", "dec-1"]]);
	});

	it.each(["approve" as const, "reject" as const])("4. row resolved elsewhere while ask is open (%s) rejects with 409 and emits no second record", async (answer) => {
		const { store, records, run, action, auditSink } = setup();
		await expect(executeAction(action, { msg: "hi" }, { auditSink, context: { caller: "mcp", userId: "u-1" }, inClientApproval: { clientId: "c1", ask: async ({ decisionId }) => { await store.reject(decisionId, "u-1", "inbox"); return answer; } } })).rejects.toMatchObject({ status: 409 });
		expect(run).not.toHaveBeenCalled();
		expect(records.map((r) => r.outcome)).toEqual(["pending_approval"]);
	});

	it("5. approve then run throws: rejects with run message, marks failed, and emits pending_approval then error", async () => {
		const { rows, records, run, action, auditSink } = setup();
		run.mockRejectedValueOnce(new Error("downstream boom"));
		await expect(executeAction(action, { msg: "hi" }, { auditSink, context: { caller: "mcp", userId: "u-1" }, inClientApproval: { clientId: "c1", ask: async () => "approve" } })).rejects.toThrow("downstream boom");
		expect(rows.get("dec-1")).toMatchObject({ status: "failed", error: "downstream boom" });
		expect(records.map((r) => [r.outcome, r.decisionId])).toEqual([["pending_approval", "dec-1"], ["error", "dec-1"]]);
	});

	it("6. option set when call needs no approval (ungated, caller ui, matching context.approval): ask is never called", async () => {
		const { action, auditSink } = setup();
		const ask = vi.fn(async (): Promise<InClientAnswer> => "approve");
		const ungated = defineAction({ id: "read_op", description: "Read", schema: z.object({}), run: async () => "ok" });
		await expect(executeAction(ungated, {}, { auditSink, context: { caller: "mcp" }, inClientApproval: { clientId: "c1", ask } })).resolves.toBe("ok");
		await expect(executeAction(action, { msg: "ui" }, { auditSink, context: { caller: "ui" }, inClientApproval: { clientId: "c1", ask } })).resolves.toEqual({ sent: "ui", count: 1 });
		const hash = await inputSha256({ msg: "ok", count: 1 });
		await expect(executeAction(action, { msg: "ok" }, { auditSink, context: { caller: "mcp", approval: { decisionId: "d-pre", actionId: "send_msg", inputSha256: hash } }, inClientApproval: { clientId: "c1", ask } })).resolves.toEqual({ sent: "ok", count: 1 });
		expect(ask).not.toHaveBeenCalled();
	});
});
