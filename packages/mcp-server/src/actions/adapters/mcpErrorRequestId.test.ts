import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	defineAction,
	setActionApprovalStore,
	type ActionAuditRecord,
	type ActionAuditSink,
} from "@ahkms/core";
import { toMcpTool } from "./mcp.js";

describe("toMcpTool error request_id suffix (#1918)", () => {
	afterEach(() => {
		setActionApprovalStore(undefined);
	});

	it("1. rethrows the exact Error object with [request_id=<uuid>] matching the audit record's requestId", async () => {
		const records: ActionAuditRecord[] = [];
		const auditSink: ActionAuditSink = (rec) => {
			records.push(rec);
		};

		const boom = new Error("boom");
		const action = defineAction({
			id: "test_error_request_id",
			description: "Throws an Error.",
			schema: z.object({}),
			run: async () => {
				throw boom;
			},
		});

		const tool = toMcpTool(action, { auditSink });

		await expect(tool.handler({})).rejects.toBe(boom);
		expect(boom.message).toMatch(/^boom \[request_id=[0-9a-f-]{36}\]$/);
		expect(records).toHaveLength(1);
		expect(records[0]?.outcome).toBe("error");
		const match = boom.message.match(/\[request_id=([0-9a-f-]{36})\]$/);
		expect(match?.[1]).toBe(records[0]?.requestId);
	});

	it("2. wraps a non-Error rejection in an Error whose message ends with [request_id=<uuid>] matching the audit record's", async () => {
		const records: ActionAuditRecord[] = [];
		const auditSink: ActionAuditSink = (rec) => {
			records.push(rec);
		};

		const action = defineAction({
			id: "test_non_error_request_id",
			description: "Throws a string.",
			schema: z.object({}),
			run: async () => {
				throw "nope";
			},
		});

		const tool = toMcpTool(action, { auditSink });

		let caught: unknown;
		try {
			await tool.handler({});
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(Error);
		expect(records).toHaveLength(1);
		expect((caught as Error).message).toBe(`nope [request_id=${records[0]?.requestId}]`);
	});

	it("3. returns the two-line pending_approval text with no isError and no request_id suffix when gated", async () => {
		setActionApprovalStore({
			park: async () => ({ decisionId: "d-1" }),
		});

		const action = defineAction({
			id: "test_gated_pending",
			description: "Gated action.",
			schema: z.object({}),
			needsApproval: true,
			run: async () => ({ ok: true }),
		});

		const tool = toMcpTool(action);
		const res = await tool.handler({});

		expect((res as { isError?: unknown }).isError).toBeUndefined();
		const text = res.content[0]?.text ?? "";
		const lines = text.split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]!)).toEqual({
			status: "pending_approval",
			decision_id: "d-1",
			action_id: "test_gated_pending",
		});
		expect(text).not.toContain("request_id=");
	});

	it("4. returns formatMcp output with no request_id on success", async () => {
		const action = defineAction({
			id: "test_success_no_request_id",
			description: "Succeeds.",
			schema: z.object({}),
			run: async () => ({ value: 42 }),
			formatMcp: (out) => `formatted:${out.value}`,
		});

		const tool = toMcpTool(action);
		const res = await tool.handler({});

		expect(res.content[0]?.text).toBe("formatted:42");
		expect(res.content[0]?.text).not.toContain("request_id");
	});
});
