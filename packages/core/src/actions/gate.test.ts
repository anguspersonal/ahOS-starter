import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineAction } from "./defineAction.js";
import { executeAction } from "./adapters/direct.js";
import {
	ApprovalDeniedError,
	PendingApprovalError,
	REVIEW_BAND_AUTO_APPLY_THRESHOLD,
	REVIEW_BAND_BLOCK_THRESHOLD,
	actionConfidenceSchema,
	isPendingApproval,
	needsReviewBandApproval,
	setActionApprovalStore,
	type ActionApprovalStore,
	type ApprovalRequest,
} from "./gate.js";
import { inputSha256 } from "./inputHash.js";
import type { ActionAuditRecord, ActionCaller } from "./types.js";

describe("approval gate (executeAction + evaluateGate)", () => {
	afterEach(() => {
		setActionApprovalStore(undefined);
	});

	function createHarness() {
		const records: ActionAuditRecord[] = [];
		const parked: ApprovalRequest[] = [];
		const store: ActionApprovalStore = {
			park: vi.fn(async (req: ApprovalRequest) => {
				parked.push(req);
				return { decisionId: "d1" };
			}),
		};
		setActionApprovalStore(store);
		return {
			records,
			parked,
			store,
			sink: (rec: ActionAuditRecord) => {
				records.push(rec);
			},
		};
	}

	it("1. needsApproval: true, caller mcp parks, records pending_approval, and never calls run", async () => {
		const { records, parked, sink } = createHarness();
		const run = vi.fn(async () => ({ ok: true }));
		const action = defineAction({
			id: "gated_action",
			description: "Gated action",
			schema: z.object({ query: z.string(), limit: z.number().default(10) }),
			needsApproval: true,
			run,
		});

		await expect(
			executeAction(action, { query: "hello" }, {
				auditSink: sink,
				context: {
					caller: "mcp",
					requestId: "req-1",
					userId: "u-1",
					clientId: "c-1",
					sessionId: "s-1",
				},
			}),
		).rejects.toSatisfy((err: unknown) => {
			expect(err).toBeInstanceOf(PendingApprovalError);
			expect(isPendingApproval(err)).toBe(true);
			const pe = err as PendingApprovalError;
			expect(pe.decisionId).toBe("d1");
			expect(pe.actionId).toBe("gated_action");
			expect(pe.message).not.toMatch(/validation|required|invalid|must differ/i);
			return true;
		});

		expect(run).not.toHaveBeenCalled();
		expect(parked).toHaveLength(1);
		const expectedHash = await inputSha256({ query: "hello", limit: 10 });
		expect(parked[0]).toEqual({
			actionId: "gated_action",
			input: { query: "hello", limit: 10 },
			inputSha256: expectedHash,
			caller: "mcp",
			requestId: "req-1",
			userId: "u-1",
			clientId: "c-1",
			sessionId: "s-1",
		});

		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			actionId: "gated_action",
			outcome: "pending_approval",
			decisionId: "d1",
			inputSha256: expectedHash,
		});
	});

	it("2. caller ui runs without calling park or predicate", async () => {
		const { records, parked, sink } = createHarness();
		const predicate = vi.fn(() => true);
		const run = vi.fn(async () => ({ ok: true }));
		const action = defineAction({
			id: "gated_ui",
			description: "Gated action",
			schema: z.object({ x: z.number() }),
			needsApproval: predicate,
			run,
		});

		const res = await executeAction(action, { x: 1 }, {
			auditSink: sink,
			context: { caller: "ui", requestId: "req-ui" },
		});

		expect(res).toEqual({ ok: true });
		expect(run).toHaveBeenCalledTimes(1);
		expect(predicate).not.toHaveBeenCalled();
		expect(parked).toHaveLength(0);
		expect(records).toHaveLength(1);
		expect(records[0].outcome).toBe("success");
		expect("decisionId" in records[0]).toBe(false);
	});

	it.each([
		["worker" as ActionCaller],
		["internal" as ActionCaller],
		["http" as ActionCaller],
		["cli" as ActionCaller],
		["a2a" as ActionCaller],
		["test" as ActionCaller],
		["ui_agent" as unknown as ActionCaller],
		[undefined],
	])("3. caller %s parks when needsApproval is true", async (caller) => {
		const { parked, sink } = createHarness();
		const run = vi.fn(async () => ({ ok: true }));
		const action = defineAction({
			id: "table_gated",
			description: "Gated action",
			schema: z.object({ v: z.string() }),
			needsApproval: true,
			run,
		});

		await expect(
			executeAction(action, { v: "a" }, {
				auditSink: sink,
				context: caller ? { caller } : {},
			}),
		).rejects.toBeInstanceOf(PendingApprovalError);

		expect(run).not.toHaveBeenCalled();
		expect(parked).toHaveLength(1);
		expect(parked[0].caller).toBe(caller ?? "worker");
	});

	it("4. predicates: false runs; throwing or rejecting parks; async true parks; receives parsed input and ctx", async () => {
		const { parked, sink } = createHarness();
		const seen: Array<{ input: unknown; caller: string }> = [];

		const falseAction = defineAction({
			id: "pred_false",
			description: "Predicate false",
			schema: z.object({ n: z.number().default(5) }),
			needsApproval: (input, ctx) => {
				seen.push({ input, caller: ctx.caller });
				return false;
			},
			run: async (input) => input.n * 2,
		});

		await expect(
			executeAction(falseAction, {}, { auditSink: sink, context: { caller: "mcp" } }),
		).resolves.toBe(10);
		expect(seen).toEqual([{ input: { n: 5 }, caller: "mcp" }]);
		expect(parked).toHaveLength(0);

		const throwAction = defineAction({
			id: "pred_throw",
			description: "Predicate throw",
			schema: z.object({}),
			needsApproval: () => {
				throw new Error("boom");
			},
			run: async () => "ok",
		});
		await expect(
			executeAction(throwAction, {}, { auditSink: sink, context: { caller: "mcp" } }),
		).rejects.toBeInstanceOf(PendingApprovalError);

		const rejectAction = defineAction({
			id: "pred_reject",
			description: "Predicate reject",
			schema: z.object({}),
			needsApproval: async () => {
				throw new Error("async boom");
			},
			run: async () => "ok",
		});
		await expect(
			executeAction(rejectAction, {}, { auditSink: sink, context: { caller: "mcp" } }),
		).rejects.toBeInstanceOf(PendingApprovalError);

		const asyncTrueAction = defineAction({
			id: "pred_async_true",
			description: "Predicate async true",
			schema: z.object({}),
			needsApproval: async () => true,
			run: async () => "ok",
		});
		await expect(
			executeAction(asyncTrueAction, {}, { auditSink: sink, context: { caller: "mcp" } }),
		).rejects.toBeInstanceOf(PendingApprovalError);

		expect(parked).toHaveLength(3);
	});

	it("5. no store installed: rejects with ApprovalDeniedError, outcome denied, and run is never called", async () => {
		const records: ActionAuditRecord[] = [];
		setActionApprovalStore(undefined);
		const run = vi.fn(async () => "ok");
		const action = defineAction({
			id: "no_store",
			description: "No store",
			schema: z.object({ a: z.string() }),
			needsApproval: true,
			run,
		});

		await expect(
			executeAction(action, { a: "1" }, {
				auditSink: (r) => {
					records.push(r);
				},
				context: { caller: "mcp" },
			}),
		).rejects.toSatisfy((err: unknown) => {
			expect(err).toBeInstanceOf(ApprovalDeniedError);
			const de = err as ApprovalDeniedError;
			expect(de.message).toContain("no approval store is configured");
			expect(de.message).not.toMatch(/validation|required|invalid|must differ/i);
			return true;
		});

		expect(run).not.toHaveBeenCalled();
		expect(records).toHaveLength(1);
		expect(records[0].outcome).toBe("denied");
		expect(records[0].errorMessage).toContain("no approval store is configured");
	});

	it("6. caller mcp with matching context.approval runs without park; mismatched hash is denied", async () => {
		const { records, parked, sink } = createHarness();
		let seenApproval: unknown;
		const action = defineAction({
			id: "approved_mcp",
			description: "Approved MCP",
			schema: z.object({ k: z.string() }),
			needsApproval: true,
			run: async (_input, ctx) => {
				seenApproval = ctx.approval;
				return "done";
			},
		});

		const validHash = await inputSha256({ k: "v" });
		const approval = {
			decisionId: "d1",
			actionId: "approved_mcp",
			inputSha256: validHash,
		};

		const res = await executeAction(action, { k: "v" }, {
			auditSink: sink,
			context: { caller: "mcp", approval },
		});

		expect(res).toBe("done");
		expect(parked).toHaveLength(0);
		expect(seenApproval).toEqual(approval);
		expect(records).toHaveLength(1);
		expect(records[0].outcome).toBe("success");
		expect(records[0].decisionId).toBe("d1");

		await expect(
			executeAction(action, { k: "tampered" }, {
				auditSink: sink,
				context: { caller: "mcp", approval },
			}),
		).rejects.toSatisfy((err: unknown) => {
			expect(err).toBeInstanceOf(ApprovalDeniedError);
			const de = err as ApprovalDeniedError;
			expect(de.message).toContain("input does not match the approved request");
			expect(de.message).not.toMatch(/validation|required|invalid|must differ/i);
			return true;
		});

		expect(records).toHaveLength(2);
		expect(records[1].outcome).toBe("denied");
	});

	it("7. approval scope: another actionId lets internal run, denies mcp, and denies internal on same-action hash mismatch", async () => {
		const { records, parked, sink } = createHarness();
		const childAction = defineAction({
			id: "child_action",
			description: "Child action",
			schema: z.object({ step: z.number() }),
			needsApproval: true,
			run: async (input) => input.step,
		});

		const parentApproval = {
			decisionId: "d-parent",
			actionId: "parent_action",
			inputSha256: "parent-hash",
		};

		const out = await executeAction(childAction, { step: 2 }, {
			auditSink: sink,
			context: { caller: "internal", approval: parentApproval },
		});
		expect(out).toBe(2);
		expect(parked).toHaveLength(0);
		expect(records[0].outcome).toBe("success");
		expect(records[0].decisionId).toBe("d-parent");

		await expect(
			executeAction(childAction, { step: 2 }, {
				auditSink: sink,
				context: { caller: "mcp", approval: parentApproval },
			}),
		).rejects.toBeInstanceOf(ApprovalDeniedError);
		expect(records[1].outcome).toBe("denied");

		await expect(
			executeAction(childAction, { step: 2 }, {
				auditSink: sink,
				context: {
					caller: "internal",
					approval: {
						decisionId: "d-child",
						actionId: "child_action",
						inputSha256: "wrong-hash",
					},
				},
			}),
		).rejects.toBeInstanceOf(ApprovalDeniedError);
		expect(records[2].outcome).toBe("denied");
	});

	it("8. park rejects: executeAction rejects with that error, outcome error, and run is never called", async () => {
		const records: ActionAuditRecord[] = [];
		const storeError = new Error("db connection lost");
		setActionApprovalStore({
			park: async () => {
				throw storeError;
			},
		});
		const run = vi.fn(async () => "ok");
		const action = defineAction({
			id: "park_fails",
			description: "Park fails",
			schema: z.object({ x: z.string() }),
			needsApproval: true,
			run,
		});

		await expect(
			executeAction(action, { x: "1" }, {
				auditSink: (r) => {
					records.push(r);
				},
				context: { caller: "mcp" },
			}),
		).rejects.toBe(storeError);

		expect(run).not.toHaveBeenCalled();
		expect(records).toHaveLength(1);
		expect(records[0].outcome).toBe("error");
		expect(records[0].errorMessage).toBe("db connection lost");
	});

	it("9. no needsApproval with store installed: no predicate or park called, record has no decisionId", async () => {
		const { records, parked, sink } = createHarness();
		const action = defineAction({
			id: "ungated_action",
			description: "Ungated",
			schema: z.object({ v: z.number() }),
			run: async (input) => input.v + 1,
		});

		const res = await executeAction(action, { v: 41 }, {
			auditSink: sink,
			context: { caller: "mcp" },
		});

		expect(res).toBe(42);
		expect(parked).toHaveLength(0);
		expect(records).toHaveLength(1);
		expect(records[0].outcome).toBe("success");
		expect("decisionId" in records[0]).toBe(false);
	});

	it("10. needsReviewBandApproval: omitted or >= 0.85 executes; [0.30, 0.85) parks as action_approval; < 0.30 throws ApprovalDeniedError", async () => {
		const { records, parked, sink } = createHarness();
		const run = vi.fn(async (input: { title: string; confidence?: { epistemic: number; ego_salience?: number } }) => ({
			created: input.title,
		}));
		const action = defineAction({
			id: "governed_write",
			description: "Governed write action",
			schema: z.object({
				title: z.string(),
				confidence: actionConfidenceSchema,
			}),
			needsApproval: needsReviewBandApproval,
			run,
		});

		expect(REVIEW_BAND_BLOCK_THRESHOLD).toBe(0.3);
		expect(REVIEW_BAND_AUTO_APPLY_THRESHOLD).toBe(0.85);

		// Omitted confidence executes immediately
		const resOmitted = await executeAction(
			action,
			{ title: "No confidence" },
			{ auditSink: sink, context: { caller: "mcp" } },
		);
		expect(resOmitted).toEqual({ created: "No confidence" });
		expect(run).toHaveBeenCalledTimes(1);
		expect(parked).toHaveLength(0);

		// >= 0.85 executes immediately
		const resHigh = await executeAction(
			action,
			{ title: "High confidence", confidence: { epistemic: 0.85, ego_salience: 0.9 } },
			{ auditSink: sink, context: { caller: "mcp" } },
		);
		expect(resHigh).toEqual({ created: "High confidence" });
		expect(run).toHaveBeenCalledTimes(2);
		expect(parked).toHaveLength(0);

		// [0.30, 0.85) parks as PendingApprovalError
		await expect(
			executeAction(
				action,
				{ title: "Review band", confidence: { epistemic: 0.65 } },
				{ auditSink: sink, context: { caller: "mcp", userId: "u-1" } },
			),
		).rejects.toBeInstanceOf(PendingApprovalError);
		expect(run).toHaveBeenCalledTimes(2);
		expect(parked).toHaveLength(1);
		expect(parked[0].actionId).toBe("governed_write");
		expect(records.at(-1)?.outcome).toBe("pending_approval");
		expect(records.at(-1)?.decisionId).toBe("d1");

		// Boundary 0.30 parks as PendingApprovalError
		await expect(
			executeAction(
				action,
				{ title: "Lower review boundary", confidence: { epistemic: 0.3 } },
				{ auditSink: sink, context: { caller: "mcp", userId: "u-1" } },
			),
		).rejects.toBeInstanceOf(PendingApprovalError);
		expect(run).toHaveBeenCalledTimes(2);
		expect(parked).toHaveLength(2);

		// < 0.30 throws ApprovalDeniedError without parking or calling run
		await expect(
			executeAction(
				action,
				{ title: "Block band", confidence: { epistemic: 0.2 } },
				{ auditSink: sink, context: { caller: "mcp", userId: "u-1" } },
			),
		).rejects.toSatisfy((err: unknown) => {
			expect(err).toBeInstanceOf(ApprovalDeniedError);
			const de = err as ApprovalDeniedError;
			expect(de.actionId).toBe("governed_write");
			expect(de.message).toContain("below block threshold (0.30)");
			return true;
		});
		expect(run).toHaveBeenCalledTimes(2);
		expect(parked).toHaveLength(2);
		expect(records.at(-1)?.outcome).toBe("denied");
	});
});
