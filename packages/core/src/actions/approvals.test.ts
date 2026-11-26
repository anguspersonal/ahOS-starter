import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApprovalConflictError, actionResolver, executeApproved, rejectApproval } from "./approvals.js";
import { defineAction } from "./defineAction.js";
import type { ActionApprovalLifecycleStore, ApprovalRequest } from "./gate.js";
import { inputSha256 } from "./inputHash.js";
import type { ActionAuditRecord, ActionContext } from "./types.js";

interface StoredRow {
	id: string;
	status: "pending" | "approved" | "executed" | "failed" | "rejected";
	actionId: string;
	input: unknown;
	inputSha256: string;
	caller: string;
	userId: string;
	expiresAt: string | null;
	resolvedBy: string | null;
	resolvedAt: string | null;
	resolutionNotes: string | null;
	resolutionData: { outcome: "executed" | "failed"; error?: string } | null;
}

function createInMemoryStore(nowIso = "2026-10-19T12:00:00.000Z") {
	const rows = new Map<string, StoredRow>();
	let seq = 0;
	const seed = async (overrides: Partial<StoredRow> = {}): Promise<StoredRow> => {
		const id = overrides.id ?? `dec-${++seq}`;
		const input = "input" in overrides ? overrides.input : { msg: "hi" };
		const row: StoredRow = {
			id,
			status: overrides.status ?? "pending",
			actionId: overrides.actionId ?? "send_msg",
			input,
			inputSha256: overrides.inputSha256 ?? (await inputSha256(input)),
			caller: overrides.caller ?? "mcp",
			userId: overrides.userId ?? "u-owner",
			expiresAt: "expiresAt" in overrides ? (overrides.expiresAt ?? null) : "2026-10-26T12:00:00.000Z",
			resolvedBy: overrides.resolvedBy ?? null,
			resolvedAt: overrides.resolvedAt ?? null,
			resolutionNotes: overrides.resolutionNotes ?? null,
			resolutionData: overrides.resolutionData ?? null,
		};
		rows.set(id, row);
		return row;
	};
	const store: ActionApprovalLifecycleStore = {
		async park(req: ApprovalRequest) {
			return { decisionId: (await seed({ ...req, userId: req.userId ?? "u-owner" })).id };
		},
		async claim(id, approverUserId, notes) {
			const r = rows.get(id);
			if (!r || r.status !== "pending" || r.resolvedAt !== null || r.userId !== approverUserId || !r.expiresAt || r.expiresAt <= nowIso) return null;
			Object.assign(r, { status: "approved", resolvedBy: approverUserId, resolvedAt: nowIso, resolutionNotes: notes ?? null });
			return { decisionId: r.id, actionId: r.actionId, input: r.input, inputSha256: r.inputSha256, caller: r.caller, userId: r.userId };
		},
		async finish(id, res, errArg) {
			const r = rows.get(id);
			if (!r || r.status !== "approved") throw new Error(`Row ${id} is not approved`);
			const outcome = typeof res === "string" ? res : (res.outcome ?? res.status ?? "executed");
			const error = typeof res === "string" ? errArg : res.error;
			r.status = outcome;
			r.resolutionData = error !== undefined ? { outcome, error } : { outcome };
		},
		async reject(id, approverUserId, notes) {
			const r = rows.get(id);
			if (!r || r.status !== "pending" || r.resolvedAt !== null || r.userId !== approverUserId) return false;
			Object.assign(r, { status: "rejected", resolvedBy: approverUserId, resolvedAt: nowIso, resolutionNotes: notes ?? null });
			return true;
		},
	};
	return { seed, store };
}

describe("executeApproved and rejectApproval (#1420)", () => {
	it("1. pending row approved in web inbox runs once via executeAction, records executed, and emits success ledger row", async () => {
		const { seed, store } = createInMemoryStore();
		const row = await seed({ id: "d-1", input: { msg: "hello" }, caller: "mcp", userId: "u-1" });
		const records: ActionAuditRecord[] = [];
		const seen: Array<{ input: unknown; ctx: ActionContext }> = [];
		const action = defineAction({
			id: "send_msg",
			description: "Send message",
			schema: z.object({ msg: z.string() }),
			needsApproval: true,
			run: vi.fn(async (input, ctx) => {
				seen.push({ input, ctx });
				return { delivered: input.msg };
			}),
		});
		const resolve = actionResolver((id) => (id === "send_msg" ? action : undefined), { auditSink: (rec) => { records.push(rec); } });
		const out = await executeApproved("d-1", { store, resolve, approvedBy: { userId: "u-1", via: "web_inbox" } });
		expect(out).toEqual({ status: "executed", result: { delivered: "hello" } });
		expect(seen).toEqual([{ input: { msg: "hello" }, ctx: expect.objectContaining({ caller: "mcp", userId: "u-1", approval: { decisionId: "d-1", actionId: "send_msg", inputSha256: row.inputSha256 } }) }]);
		expect(row).toMatchObject({ status: "executed", resolutionData: { outcome: "executed" }, resolvedBy: "u-1", resolutionNotes: "approved in the web inbox" });
		expect(records).toEqual([expect.objectContaining({ actionId: "send_msg", caller: "mcp", userId: "u-1", outcome: "success", decisionId: "d-1" })]);
	});

	it.each([
		["already executed", { status: "executed" as const }],
		["re-armed pending with resolved_at set", { status: "pending" as const, resolvedAt: "2026-10-18T00:00:00.000Z" }],
		["expires_at in the past", { expiresAt: "2026-10-18T00:00:00.000Z" }],
		["expires_at is null", { expiresAt: null }],
		["user_id is not the approver", { userId: "other-user" }],
	])("2. refused claim (%s) rejects with 409 and never calls run", async (_label, overrides) => {
		const { seed, store } = createInMemoryStore();
		const row = await seed({ id: "d-refused", ...overrides });
		const run = vi.fn(async () => "ok");
		await expect(executeApproved(row.id, { store, resolve: () => run, approvedBy: { userId: "u-owner", via: "web_inbox" } })).rejects.toMatchObject({
			status: 409,
			message: "Decision d-refused is not pending (already resolved, expired or claimed)",
		});
		expect(run).not.toHaveBeenCalled();
	});

	it("3. race: two concurrent executeApproved calls on one row fulfil once, 409 once, and call run once", async () => {
		const { seed, store } = createInMemoryStore();
		await seed({ id: "d-race" });
		const run = vi.fn(async () => "won");
		const settled = await Promise.allSettled([
			executeApproved("d-race", { store, resolve: () => run, approvedBy: { userId: "u-owner", via: "web_inbox" } }),
			executeApproved("d-race", { store, resolve: () => run, approvedBy: { userId: "u-owner", via: "web_inbox" } }),
		]);
		expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
		const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
		expect(rejected).toHaveLength(1);
		expect((rejected[0].reason as ApprovalConflictError).status).toBe(409);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("4. changed input: mismatched hash marks row failed without calling run", async () => {
		const { seed, store } = createInMemoryStore();
		const row = await seed({ id: "d-tampered", input: { msg: "tampered" }, inputSha256: "deadbeef" });
		const run = vi.fn(async () => "ok");
		const out = await executeApproved("d-tampered", { store, resolve: () => run, approvedBy: { userId: "u-owner", via: "web_inbox" } });
		expect(out).toEqual({ status: "failed", error: "input changed since the request" });
		expect(row).toMatchObject({ status: "failed", resolutionData: { outcome: "failed", error: "input changed since the request" } });
		expect(run).not.toHaveBeenCalled();
	});

	it("5. nothing registered: resolve returning undefined marks row failed", async () => {
		const { seed, store } = createInMemoryStore();
		const row = await seed({ id: "d-missing", actionId: "unknown_act" });
		const out = await executeApproved("d-missing", { store, resolve: () => undefined, approvedBy: { userId: "u-owner", via: "web_inbox" } });
		const error = "no action or tool named unknown_act is registered";
		expect(out).toEqual({ status: "failed", error });
		expect(row).toMatchObject({ status: "failed", resolutionData: { outcome: "failed", error } });
	});

	it("6. run throws 600-char message (client c1): truncates to 500 chars, records error ledger row, and propagates finish failures", async () => {
		const { seed, store } = createInMemoryStore();
		const row = await seed({ id: "d-throw" });
		const records: ActionAuditRecord[] = [];
		const action = defineAction({
			id: "send_msg",
			description: "Send message",
			schema: z.object({ msg: z.string() }),
			needsApproval: true,
			run: async () => { throw new Error("x".repeat(600)); },
		});
		const resolve = actionResolver((id) => (id === "send_msg" ? action : undefined), { auditSink: (rec) => { records.push(rec); } });
		const out = await executeApproved("d-throw", { store, resolve, approvedBy: { userId: "u-owner", via: "client", clientId: "c1" } });
		const expectedErr = "x".repeat(500);
		expect(out).toEqual({ status: "failed", error: expectedErr });
		expect(row).toMatchObject({ status: "failed", resolutionData: { outcome: "failed", error: expectedErr }, resolutionNotes: "approved in client c1" });
		expect(records).toEqual([expect.objectContaining({ outcome: "error", decisionId: "d-throw" })]);

		const rowFinishFail = await seed({ id: "d-finish-err" });
		const finishSpy = vi.spyOn(store, "finish").mockRejectedValueOnce(new Error("finish write failed"));
		await expect(
			executeApproved("d-finish-err", { store, resolve: () => async () => "ok", approvedBy: { userId: "u-owner", via: "web_inbox" } }),
		).rejects.toThrow("finish write failed");
		expect(finishSpy).toHaveBeenCalledTimes(1);
		expect(rowFinishFail.status).toBe("approved");
	});

	it("7. rejectApproval moves pending to rejected with resolved_by and notes, and rejects a second call with 409", async () => {
		const { seed, store } = createInMemoryStore();
		const row = await seed({ id: "d-rej" });
		const res = await rejectApproval("d-rej", { store, userId: "u-owner", notes: "not needed" });
		expect(res).toEqual({ status: "rejected", decision_id: "d-rej" });
		expect(row).toMatchObject({ status: "rejected", resolvedBy: "u-owner", resolutionNotes: "not needed" });
		await expect(rejectApproval("d-rej", { store, userId: "u-owner", notes: "again" })).rejects.toMatchObject({ status: 409 });
	});
});
