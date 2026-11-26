import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "../fakeSupabase.testkit.js";
import { createSupabaseActionLedgerSink } from "./actionLedger.js";
import type { ActionAuditRecord } from "../../actions/types.js";

describe("createSupabaseActionLedgerSink", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("inserts formatted payload with exact keys into action_ledger (Case 3)", async () => {
		const fake = createFakeSupabase(() => ({ data: null, error: null }));
		const sink = createSupabaseActionLedgerSink(fake.client as any);

		const record: ActionAuditRecord = {
			actionId: "docs_get",
			seam: "action",
			caller: "worker",
			requestId: "req-123",
			userId: null,
			clientId: null,
			sessionId: null,
			outcome: "success",
			durationMs: 42.6,
			errorMessage: null,
			inputKeys: ["docId"],
			inputSha256: "abcdef123456",
		};

		await sink.record(record);

		expect(fake.calls).toHaveLength(1);
		const call = fake.calls[0];
		expect(call.table).toBe("action_ledger");
		expect(call.op).toBe("insert");
		expect(call.selected).toBeUndefined();

		const expectedKeys = [
			"action_id",
			"seam",
			"caller",
			"request_id",
			"parent_request_id",
			"trace_id",
			"user_id",
			"client_id",
			"session_id",
			"outcome",
			"duration_ms",
			"error_message",
			"input_keys",
			"input_sha256",
			"decision_id",
		];
		expect(Object.keys(call.payload as object).sort()).toEqual(expectedKeys.sort());

		expect(call.payload).toEqual({
			action_id: "docs_get",
			seam: "action",
			caller: "worker",
			request_id: "req-123",
			parent_request_id: null,
			trace_id: null,
			user_id: null,
			client_id: null,
			session_id: null,
			outcome: "success",
			duration_ms: 43,
			error_message: null,
			input_keys: ["docId"],
			input_sha256: "abcdef123456",
			decision_id: null,
		});

		await sink.record({ ...record, decisionId: "dec-789" });
		expect((fake.calls[1].payload as any).decision_id).toBe("dec-789");
	});

	it("converts undefined userId, clientId, and sessionId to null", async () => {
		const fake = createFakeSupabase(() => ({ data: null, error: null }));
		const sink = createSupabaseActionLedgerSink(fake.client as any);

		const record = {
			actionId: "test_action",
			seam: "action",
			caller: "internal",
			requestId: "req-456",
			outcome: "success",
			durationMs: 10,
			errorMessage: undefined,
			inputKeys: [],
			inputSha256: undefined,
		} as unknown as ActionAuditRecord;

		await sink.record(record);

		expect(fake.calls).toHaveLength(1);
		const payload = fake.calls[0].payload as any;
		expect(payload.parent_request_id).toBeNull();
		expect(payload.trace_id).toBeNull();
		expect(payload.user_id).toBeNull();
		expect(payload.client_id).toBeNull();
		expect(payload.session_id).toBeNull();
		expect(payload.error_message).toBeNull();
		expect(payload.input_sha256).toBeNull();
	});

	it("rejects with a message naming action_ledger and error code when PostgREST returns error", async () => {
		const fake = createFakeSupabase(() => ({
			data: null,
			error: { code: "23505", message: "duplicate key value" },
		}));
		const sink = createSupabaseActionLedgerSink(fake.client as any);

		const record: ActionAuditRecord = {
			actionId: "docs_get",
			seam: "action",
			caller: "worker",
			requestId: "req-123",
			userId: "u1",
			clientId: "c1",
			sessionId: "s1",
			outcome: "error",
			durationMs: 5,
			errorMessage: "failed",
			inputKeys: [],
			inputSha256: null,
		};

		await expect(sink.record(record)).rejects.toThrow(/action_ledger.*23505/);
	});

	it("rejects after timeoutMs if insert hangs and clears timer on success (Case 4)", async () => {
		vi.useFakeTimers();

		// 1. Success case clears timer
		const fastFake = createFakeSupabase(() => ({ data: null, error: null }));
		const fastSink = createSupabaseActionLedgerSink(fastFake.client as any);

		const record: ActionAuditRecord = {
			actionId: "fast_action",
			seam: "action",
			caller: "cli",
			requestId: "req-fast",
			userId: null,
			clientId: null,
			sessionId: null,
			outcome: "success",
			durationMs: 1,
			errorMessage: null,
			inputKeys: [],
			inputSha256: null,
		};

		await fastSink.record(record);
		expect(vi.getTimerCount()).toBe(0);

		// 2. Hanging insert times out after 2000 ms
		const hangingFake = createFakeSupabase(() => new Promise(() => {})); // Never resolves
		const hangingSink = createSupabaseActionLedgerSink(hangingFake.client as any);

		const recordPromise = hangingSink.record(record);
		const caughtErrorPromise = expect(recordPromise).rejects.toThrow(
			"action_ledger insert timed out after 2000 ms",
		);

		await vi.advanceTimersByTimeAsync(2000);
		await caughtErrorPromise;
	});
});
