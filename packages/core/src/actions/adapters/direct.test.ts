import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionAuditRecord, ActionAuditSink } from "../types.js";
import {
	executeAction,
	recordActionAudit,
	setDefaultAuditSink,
	stderrAuditSink,
} from "./direct.js";

describe("executeAction direct adapter in @ahkms/core", () => {
	it("executes an action with validated input and injected context", async () => {
		const action = defineAction({
			id: "test_action",
			description: "Test direct execution",
			schema: z.object({
				name: z.string(),
				count: z.number().int().min(1),
			}),
			run: async (input, ctx) => {
				return {
					greeting: `Hello, ${input.name}!`,
					count: input.count,
					caller: ctx.caller,
				};
			},
		});

		const result = await executeAction(
			action,
			{ name: "Angus", count: 3 },
			{ context: { caller: "cli" } },
		);

		expect(result).toEqual({
			greeting: "Hello, Angus!",
			count: 3,
			caller: "cli",
		});
	});

	it("throws ZodError on invalid input when validation is not skipped", async () => {
		const action = defineAction({
			id: "strict_action",
			description: "Strict validation action",
			schema: z.object({
				email: z.string().email(),
			}),
			run: async (input) => input,
		});

		await expect(
			executeAction(action, { email: "not-an-email" }),
		).rejects.toThrow();
	});

	it("emits [audit:action] to console.error on execution", async () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const auditedAction = defineAction({
			id: "audited_action",
			description: "Action with audit logging",
			schema: z.object({ value: z.string() }),
			run: async (input) => input.value,
		});

		await executeAction(auditedAction, { value: "test" }, { context: { caller: "internal" } });

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringMatching(
				/\[audit:action\] audited_action caller=internal requestId=[a-f0-9-]+ durationMs=\d+ success=true outcome=success/,
			),
		);

		consoleSpy.mockRestore();
	});
});

describe("audit sink", () => {
	afterEach(() => {
		setDefaultAuditSink(stderrAuditSink);
		vi.restoreAllMocks();
	});

	it("records validation_error outcome when validation fails", async () => {
		const records: ActionAuditRecord[] = [];
		const auditSink: ActionAuditSink = (record) => {
			records.push(record);
		};

		const action = defineAction({
			id: "schema_action",
			description: "Schema validation test",
			schema: z.object({
				count: z.number(),
			}),
			run: async (input) => input,
		});

		await expect(
			executeAction(action, { count: "invalid" as any }, { auditSink }),
		).rejects.toThrow(z.ZodError);

		expect(records).toHaveLength(1);
		expect(records[0].outcome).toBe("validation_error");
		expect(records[0].actionId).toBe("schema_action");
		expect(records[0].inputKeys).toEqual(["count"]);
		expect(records[0].errorMessage).toBeTruthy();
	});

	it("records error outcome on throwing run, success on resolved run, and handles context ids", async () => {
		const records: ActionAuditRecord[] = [];
		const auditSink: ActionAuditSink = (record) => {
			records.push(record);
		};

		const throwingAction = defineAction({
			id: "throwing_action",
			description: "Throws during run",
			schema: z.object({ val: z.string() }),
			run: async () => {
				throw new Error("test-failure-message");
			},
		});

		await expect(
			executeAction(
				throwingAction,
				{ val: "bad" },
				{
					auditSink,
					context: { clientId: "c1", sessionId: "s1" },
				},
			),
		).rejects.toThrow("test-failure-message");

		expect(records).toHaveLength(1);
		expect(records[0].outcome).toBe("error");
		expect(records[0].errorMessage).toBe("test-failure-message");
		expect(records[0].clientId).toBe("c1");
		expect(records[0].sessionId).toBe("s1");
		expect(records[0].durationMs).toBeGreaterThanOrEqual(0);

		// Readonly action success case
		const readOnlyAction = defineAction({
			id: "readonly_action",
			description: "Readonly action",
			schema: z.object({ query: z.string() }),
			annotations: { readOnlyHint: true },
			run: async ({ query }) => ({ found: query }),
		});

		const res = await executeAction(
			readOnlyAction,
			{ query: "target" },
			{
				auditSink,
				context: { clientId: "", sessionId: undefined },
			},
		);

		expect(res).toEqual({ found: "target" });
		expect(records).toHaveLength(2);
		expect(records[1].outcome).toBe("success");
		expect(records[1].errorMessage).toBeNull();
		expect(records[1].clientId).toBeNull();
		expect(records[1].sessionId).toBeNull();
		expect(records[1].durationMs).toBeGreaterThanOrEqual(0);
		expect(records[1].inputKeys).toEqual(["query"]);
	});

	it("handles throwing sinks safely and respects setDefaultAuditSink", async () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const sampleRecord: ActionAuditRecord = {
			actionId: "test_action",
			seam: "action",
			caller: "test",
			requestId: "req-12345",
			userId: null,
			clientId: null,
			sessionId: null,
			outcome: "success",
			durationMs: 5,
			errorMessage: null,
			inputKeys: [],
			inputSha256: null,
		};

		const throwingSink: ActionAuditSink = () => {
			throw new Error("sink exploded");
		};

		// recordActionAudit resolves and prints one stderr line naming the request id
		await expect(
			recordActionAudit(sampleRecord, throwingSink),
		).resolves.toBeUndefined();

		expect(consoleSpy).toHaveBeenCalledTimes(1);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("req-12345"),
		);

		consoleSpy.mockClear();

		// setDefaultAuditSink
		const defaultRecords: ActionAuditRecord[] = [];
		const customDefaultSink: ActionAuditSink = (rec) => {
			defaultRecords.push(rec);
		};

		setDefaultAuditSink(customDefaultSink);

		const action = defineAction({
			id: "default_sink_action",
			description: "Tests default audit sink",
			schema: z.object({ ok: z.boolean() }),
			run: async (input) => input.ok,
		});

		await executeAction(action, { ok: true });

		expect(defaultRecords).toHaveLength(1);
		expect(defaultRecords[0].actionId).toBe("default_sink_action");
		expect(defaultRecords[0].outcome).toBe("success");
	});
});
