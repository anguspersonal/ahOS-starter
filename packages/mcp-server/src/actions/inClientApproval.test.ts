import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { defineAction, setActionApprovalStore, type ActionApprovalLifecycleStore, type ApprovalRequest } from "@ahkms/core";
import { toMcpTool } from "./adapters/mcp.js";
import { createInClientApprover, type ElicitationServer } from "./inClientApproval.js";

function makeStub(elicitImpl: ElicitationServer["elicitInput"] = async () => ({ action: "cancel" as const })) {
	const controller = new AbortController();
	const elicitInput = vi.fn(elicitImpl);
	const server: ElicitationServer = { getClientCapabilities: () => ({ elicitation: { form: {} } }), elicitInput };
	const extra = { authInfo: { token: "tok", clientId: "c1", scopes: [] as string[] }, requestId: 7, signal: controller.signal };
	return { server, elicitInput, extra };
}

describe("createInClientApprover and toMcpTool wiring (#1424)", () => {
	afterEach(() => setActionApprovalStore(undefined));

	it("1. returns undefined and never calls elicitInput for stdio, empty clientId, no elicitation, or url-only elicitation", () => {
		const { server, elicitInput, extra } = makeStub();
		expect(createInClientApprover(server, {})).toBeUndefined();
		expect(createInClientApprover(server, { authInfo: { token: "t", clientId: "", scopes: [] } })).toBeUndefined();
		expect(createInClientApprover({ getClientCapabilities: () => ({}), elicitInput }, extra)).toBeUndefined();
		expect(createInClientApprover({ getClientCapabilities: () => ({ elicitation: { url: {} } }), elicitInput }, extra)).toBeUndefined();
		expect(elicitInput).not.toHaveBeenCalled();
	});

	it.each([
		["accept approve", async () => ({ action: "accept" as const, content: { decision: "approve" } }), "approve"],
		["accept reject", async () => ({ action: "accept" as const, content: { decision: "reject" } }), "reject"],
		["decline", async () => ({ action: "decline" as const }), "reject"],
		["cancel", async () => ({ action: "cancel" as const }), "unanswered"],
		["accept no content", async () => ({ action: "accept" as const }), "unanswered"],
		["accept empty content", async () => ({ action: "accept" as const, content: {} }), "unanswered"],
		["McpError -32001 timeout", async () => { throw new McpError(ErrorCode.RequestTimeout, "timed out"); }, "unanswered"],
		["McpError -32602 schema mismatch", async () => { throw new McpError(ErrorCode.InvalidParams, "bad schema"); }, "unanswered"],
		["closed stream", async () => { throw new Error("stream closed"); }, "unanswered"],
	])("2. answer mapping (%s -> %s)", async (_label, impl, expected) => {
		const { server, extra } = makeStub(impl);
		await expect(createInClientApprover(server, extra)!.ask({ decisionId: "d-1", actionId: "act_1", input: { a: 1 }, caller: "mcp" })).resolves.toBe(expected);
	});

	it("3. exact request schema, options, JSON input formatting, and 4000-char truncation notice", async () => {
		const { server, elicitInput, extra } = makeStub(async () => ({ action: "accept", content: { decision: "approve" } }));
		const approver = createInClientApprover(server, extra)!;
		await approver.ask({ decisionId: "dec-9", actionId: "post_note", input: { text: "hello" }, caller: "mcp" });
		expect(elicitInput).toHaveBeenCalledWith(
			{ mode: "form", message: expect.stringContaining(JSON.stringify({ text: "hello" }, null, 2)), requestedSchema: { type: "object", properties: { decision: { type: "string", enum: ["reject", "approve"] } }, required: ["decision"] } },
			{ relatedRequestId: 7, timeout: 60000, signal: extra.signal },
		);
		for (const part of ["dec-9", "post_note", "mcp", "c1"]) expect(elicitInput.mock.calls[0][0].message).toContain(part);
		const bigInput = { payload: "x".repeat(4500) };
		const fullJson = JSON.stringify(bigInput, null, 2);
		await approver.ask({ decisionId: "dec-10", actionId: "post_note", input: bigInput, caller: "mcp" });
		const msg2 = elicitInput.mock.calls[1][0].message;
		expect(msg2).toContain(fullJson.slice(0, 4000));
		expect(msg2).not.toContain(fullJson);
		expect(msg2).toContain(`${fullJson.length - 4000} characters hidden`);
		expect(msg2).toMatch(/cancelling leaves the call in the Approvals inbox/i);
	});

	it("4. wiring in toMcpTool: approve runs once, cancel returns pending_approval, decline rejects, without server parks without elicitInput", async () => {
		const rows = new Map<string, { status: string; input: unknown; inputSha256: string; userId: string }>();
		let seq = 0;
		const store: ActionApprovalLifecycleStore = {
			async park(req: ApprovalRequest) { const id = `d-${++seq}`; rows.set(id, { status: "pending", input: req.input, inputSha256: req.inputSha256, userId: req.userId ?? "" }); return { decisionId: id }; },
			async claim(id, userId) { const r = rows.get(id); if (!r || r.status !== "pending") return null; r.status = "approved"; return { decisionId: id, actionId: "gated_tool", input: r.input, inputSha256: r.inputSha256, caller: "mcp", userId }; },
			async finish(id, res) { rows.get(id)!.status = typeof res === "string" ? res : (res.outcome ?? "executed"); },
			async reject(id) { const r = rows.get(id); if (!r || r.status !== "pending") return false; r.status = "rejected"; return true; },
		};
		setActionApprovalStore(store);
		const run = vi.fn(async ({ msg }: { msg: string }) => `ran:${msg}`);
		const action = defineAction({ id: "gated_tool", description: "Gated", schema: z.object({ msg: z.string() }), needsApproval: true, run });
		const { server, elicitInput, extra } = makeStub();
		const tool = toMcpTool(action, { server });
		elicitInput.mockResolvedValueOnce({ action: "accept", content: { decision: "approve" } });
		await expect(tool.handler({ msg: "ok" }, extra)).resolves.toEqual({ content: [{ type: "text", text: "ran:ok" }] });
		expect(run).toHaveBeenCalledTimes(1);
		elicitInput.mockResolvedValueOnce({ action: "cancel" });
		expect((await tool.handler({ msg: "wait" }, extra)).content[0].text).toContain('"status":"pending_approval"');
		expect(run).toHaveBeenCalledTimes(1);
		elicitInput.mockResolvedValueOnce({ action: "decline" });
		await expect(tool.handler({ msg: "no" }, extra)).rejects.toThrow(/declined in client c1/);
		expect(run).toHaveBeenCalledTimes(1);
		elicitInput.mockClear();
		expect((await toMcpTool(action).handler({ msg: "wrap" }, extra)).content[0].text).toContain('"status":"pending_approval"');
		expect(elicitInput).not.toHaveBeenCalled();
	});
});
