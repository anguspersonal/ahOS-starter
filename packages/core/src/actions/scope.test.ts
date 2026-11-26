import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAction } from "./defineAction.js";
import { executeAction } from "./adapters/direct.js";
import { noopActionScope, setActionScope, type ActionScope } from "./scope.js";
import type { ActionAuditRecord, ActionContext } from "./types.js";
import { createFakeSupabase } from "../adapters/fakeSupabase.testkit.js";
import { createSupabaseActionLedgerSink } from "../adapters/supabase/actionLedger.js";

function createStackScope(): ActionScope {
	const stack: ActionContext[] = [];
	return {
		current: () => stack[stack.length - 1],
		run: (ctx, fn) => {
			stack.push(ctx);
			try {
				const res = fn();
				if (res && typeof (res as any).then === "function") {
					return (res as Promise<any>).finally(() => {
						stack.pop();
					}) as any;
				}
				stack.pop();
				return res;
			} catch (err) {
				stack.pop();
				throw err;
			}
		},
	};
}

describe("ActionScope and nested trace propagation (#1561)", () => {
	afterEach(() => {
		setActionScope(noopActionScope);
	});

	it("1. With a test scope (stack), nested executeAction records parentRequestId and inherits traceId", async () => {
		setActionScope(createStackScope());
		const records: ActionAuditRecord[] = [];
		const auditSink = (r: ActionAuditRecord) => {
			records.push(r);
		};

		const inner = defineAction({
			id: "inner_action",
			description: "Inner action",
			schema: z.object({}),
			run: async (_input, ctx) => ({ requestId: ctx.requestId, parentRequestId: ctx.parentRequestId, traceId: ctx.traceId }),
		});

		const outer = defineAction({
			id: "outer_action",
			description: "Outer action",
			schema: z.object({}),
			run: async () => executeAction(inner, {}, { auditSink }),
		});

		await executeAction(outer, {}, { auditSink });

		expect(records).toHaveLength(2);
		const innerRec = records.find((r) => r.actionId === "inner_action")!;
		const outerRec = records.find((r) => r.actionId === "outer_action")!;
		expect(outerRec.parentRequestId).toBeNull();
		expect(outerRec.traceId).toBe(outerRec.requestId);
		expect(innerRec.parentRequestId).toBe(outerRec.requestId);
		expect(innerRec.traceId).toBe(outerRec.requestId);
	});

	it("2. context.traceId: 't1' on the outer call gives traceId: 't1' on both records", async () => {
		setActionScope(createStackScope());
		const records: ActionAuditRecord[] = [];
		const auditSink = (r: ActionAuditRecord) => {
			records.push(r);
		};

		const inner = defineAction({
			id: "inner_action",
			description: "Inner action",
			schema: z.object({}),
			run: async () => ({ ok: true }),
		});

		const outer = defineAction({
			id: "outer_action",
			description: "Outer action",
			schema: z.object({}),
			run: async () => executeAction(inner, {}, { auditSink }),
		});

		await executeAction(outer, {}, { context: { traceId: "t1" }, auditSink });

		expect(records).toHaveLength(2);
		expect(records[0]?.traceId).toBe("t1");
		expect(records[1]?.traceId).toBe("t1");
	});

	it("3. With the default scope each call is its own trace (traceId === requestId, parentRequestId: null)", async () => {
		const records: ActionAuditRecord[] = [];
		const auditSink = (r: ActionAuditRecord) => {
			records.push(r);
		};

		const inner = defineAction({
			id: "inner_action",
			description: "Inner action",
			schema: z.object({}),
			run: async () => ({ ok: true }),
		});

		const outer = defineAction({
			id: "outer_action",
			description: "Outer action",
			schema: z.object({}),
			run: async () => executeAction(inner, {}, { auditSink }),
		});

		await executeAction(outer, {}, { auditSink });

		expect(records).toHaveLength(2);
		for (const rec of records) {
			expect(rec.parentRequestId).toBeNull();
			expect(rec.traceId).toBe(rec.requestId);
		}
	});

	it("4. A scope whose current() throws is ignored and the call still records", async () => {
		setActionScope({
			current: () => {
				throw new Error("scope failure");
			},
			run: (_ctx, fn) => fn(),
		});
		const records: ActionAuditRecord[] = [];
		const action = defineAction({
			id: "resilient_action",
			description: "Resilient action",
			schema: z.object({}),
			run: async () => ({ ok: true }),
		});

		const out = await executeAction(action, {}, { auditSink: (r) => { records.push(r); } });
		expect(out).toEqual({ ok: true });
		expect(records).toHaveLength(1);
		expect(records[0]?.parentRequestId).toBeNull();
		expect(records[0]?.traceId).toBe(records[0]?.requestId);
	});

	it("5. The Supabase sink writes parent_request_id and trace_id, null when absent", async () => {
		const fake = createFakeSupabase(() => ({ data: null, error: null }));
		const sink = createSupabaseActionLedgerSink(fake.client as any);

		await sink.record({
			actionId: "a1",
			seam: "action",
			caller: "worker",
			requestId: "r2",
			parentRequestId: "r1",
			traceId: "t1",
			userId: null,
			clientId: null,
			sessionId: null,
			outcome: "success",
			durationMs: 5,
			errorMessage: null,
			inputKeys: [],
			inputSha256: null,
		});
		await sink.record({
			actionId: "a2",
			seam: "action",
			caller: "worker",
			requestId: "r3",
			userId: null,
			clientId: null,
			sessionId: null,
			outcome: "success",
			durationMs: 5,
			errorMessage: null,
			inputKeys: [],
			inputSha256: null,
		});

		expect((fake.calls[0]?.payload as any).parent_request_id).toBe("r1");
		expect((fake.calls[0]?.payload as any).trace_id).toBe("t1");
		expect((fake.calls[1]?.payload as any).parent_request_id).toBeNull();
		expect((fake.calls[1]?.payload as any).trace_id).toBeNull();
	});
});
