import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlackWritePort } from "../../ports/slack.js";
import { createSlackWriteAdapter } from "../../adapters/slack/writes.js";
import { executeAction } from "../adapters/direct.js";
import { PendingApprovalError, setActionApprovalStore, type ApprovalRequest } from "../gate.js";
import type { ActionAuditRecord } from "../types.js";
import {
	createSlackMessageDeleteAction,
	createSlackMessageUpdateAction,
	createSlackReactionAddAction,
} from "./write.js";

const jsonRes = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function makeFakePort(overrides: Partial<SlackWritePort> = {}): SlackWritePort {
	return {
		updateMessage: vi.fn().mockResolvedValue({ channel_id: "C0123ABC", ts: "1712000000.000100" }),
		deleteMessage: vi.fn().mockResolvedValue({ deleted: true }),
		addReaction: vi.fn().mockResolvedValue({ added: true }),
		...overrides,
	};
}

describe("Slack gated write actions (#1526)", () => {
	afterEach(() => {
		setActionApprovalStore(undefined);
		vi.restoreAllMocks();
	});

	it("1. Caller mcp: each action parks, the port is not called, and outcome is pending_approval", async () => {
		const port = makeFakePort();
		const records: ActionAuditRecord[] = [];
		const parked: ApprovalRequest[] = [];
		setActionApprovalStore({
			park: vi.fn(async (req: ApprovalRequest) => {
				parked.push(req);
				return { decisionId: `dec-${parked.length}` };
			}),
		});

		const opts = { context: { caller: "mcp" as const, userId: "u-1" }, auditSink: (r: ActionAuditRecord) => void records.push(r) };
		const updateAction = createSlackMessageUpdateAction(port);
		const deleteAction = createSlackMessageDeleteAction(port);
		const reactAction = createSlackReactionAddAction(port);

		expect(deleteAction.annotations.destructiveHint).toBe(true);
		expect(reactAction.annotations.idempotentHint).toBe(true);

		await expect(executeAction(updateAction, { channel: "C1", ts: "1.1", text: "hi" }, opts)).rejects.toThrow(PendingApprovalError);
		await expect(executeAction(deleteAction, { channel: "C1", ts: "1.1" }, opts)).rejects.toThrow(PendingApprovalError);
		await expect(executeAction(reactAction, { channel: "C1", ts: "1.1", name: "thumbsup" }, opts)).rejects.toThrow(PendingApprovalError);

		expect(port.updateMessage).not.toHaveBeenCalled();
		expect(port.deleteMessage).not.toHaveBeenCalled();
		expect(port.addReaction).not.toHaveBeenCalled();
		expect(records.map((r) => [r.actionId, r.outcome])).toEqual([
			["slack_message_update", "pending_approval"],
			["slack_message_delete", "pending_approval"],
			["slack_reaction_add", "pending_approval"],
		]);
	});

	it("2. Caller ui: as='ahos_bot' uses bot token resolver; default as uses user token", async () => {
		const userToken = vi.fn(async () => "test-slack-p-token");
		const botToken = vi.fn(async () => "test-slack-b-token");
		const fetchSpy = vi.fn<typeof fetch>().mockImplementation(async () => jsonRes({ ok: true, channel: "C1", ts: "1.1" }));
		const adapter = createSlackWriteAdapter({ userToken, botToken }, { fetch: fetchSpy });
		const ui = { context: { caller: "ui" as const } };

		await executeAction(createSlackMessageUpdateAction(adapter), { channel: "C1", ts: "1.1", text: "owner edit" }, ui);
		expect(userToken).toHaveBeenCalledTimes(1);
		expect(botToken).not.toHaveBeenCalled();

		await executeAction(createSlackMessageUpdateAction(adapter), { channel: "C1", ts: "1.1", text: "bot edit", as: "ahos_bot" }, ui);
		await executeAction(createSlackMessageDeleteAction(adapter), { channel: "C1", ts: "1.1", as: "ahos_bot" }, ui);
		expect(botToken).toHaveBeenCalledTimes(2);

		await executeAction(createSlackReactionAddAction(adapter), { channel: "C1", ts: "1.1", name: "white_check_mark" }, ui);
		expect(userToken).toHaveBeenCalledTimes(2);
	});

	it("3. cant_update_message and cant_delete_message map to identity mismatch messages", async () => {
		const fetchSpy = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonRes({ ok: false, error: "cant_update_message" }))
			.mockResolvedValueOnce(jsonRes({ ok: false, error: "cant_delete_message" }));
		const adapter = createSlackWriteAdapter({ userToken: async () => "test-slack-p-token", botToken: async () => "test-slack-b-token" }, { fetch: fetchSpy });
		const ui = { context: { caller: "ui" as const } };

		await expect(executeAction(createSlackMessageUpdateAction(adapter), { channel: "C1", ts: "1.1", text: "x" }, ui)).rejects.toThrow(
			"this message was not posted by owner; pass as='ahos_bot'",
		);
		await expect(executeAction(createSlackMessageDeleteAction(adapter), { channel: "C1", ts: "1.1", as: "ahos_bot" }, ui)).rejects.toThrow(
			"this message was not posted by ahos_bot; pass as='owner'",
		);
	});

	it("4. message_not_found on delete resolves { deleted: false }; already_reacted resolves { added: false }", async () => {
		const fetchSpy = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonRes({ ok: false, error: "message_not_found" }))
			.mockResolvedValueOnce(jsonRes({ ok: false, error: "already_reacted" }));
		const adapter = createSlackWriteAdapter({ userToken: async () => "test-slack-p-token", botToken: async () => "test-slack-b-token" }, { fetch: fetchSpy });
		const ui = { context: { caller: "ui" as const } };

		await expect(executeAction(createSlackMessageDeleteAction(adapter), { channel: "C1", ts: "1.1" }, ui)).resolves.toEqual({ deleted: false });
		await expect(executeAction(createSlackReactionAddAction(adapter), { channel: "C1", ts: "1.1", name: "thumbsup" }, ui)).resolves.toEqual({ added: false });
	});

	it("5. No result and no audit record contains the text input", async () => {
		const secretText = "CONFIDENTIAL_SLACK_EDIT_TEXT_98765";
		const records: ActionAuditRecord[] = [];
		setActionApprovalStore({ park: vi.fn(async () => ({ decisionId: "dec-secret" })) });
		const action = createSlackMessageUpdateAction(makeFakePort());

		await expect(
			executeAction(action, { channel: "C0123ABC", ts: "1712000000.000100", text: secretText }, { context: { caller: "mcp", userId: "u-1" }, auditSink: (r) => void records.push(r) }),
		).rejects.toThrow(PendingApprovalError);
		const result = await executeAction(
			action,
			{ channel: "C0123ABC", ts: "1712000000.000100", text: secretText },
			{ context: { caller: "ui", userId: "u-1" }, auditSink: (r) => void records.push(r) },
		);

		expect(result).toEqual({ channel_id: "C0123ABC", ts: "1712000000.000100" });
		expect(JSON.stringify(result)).not.toContain(secretText);
		expect(JSON.stringify(records)).not.toContain(secretText);
	});
});
