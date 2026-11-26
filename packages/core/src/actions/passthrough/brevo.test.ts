import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createBrevoPassthroughAdapter } from "../../adapters/passthrough/brevo.js";
import type { McpPassthroughPort } from "../../ports/mcpPassthrough.js";
import { executeAction } from "../adapters/direct.js";
import { AdapterUnavailableError, buildRegistry } from "../buildRegistry.js";
import { PendingApprovalError, setActionApprovalStore, type ApprovalRequest } from "../gate.js";
import {
	BREVO_CALL_TOOL_DESCRIPTION,
	BREVO_LIST_TOOLS_DESCRIPTION,
	createBrevoCallToolAction,
	createBrevoListToolsAction,
} from "./brevo.js";
import { brevoCallSends } from "./brevoSends.js";

const EXPECTED_BREVO_LIST_TOOLS_JSON_SCHEMA = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {},
	additionalProperties: false,
};

const EXPECTED_BREVO_CALL_TOOL_JSON_SCHEMA = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {
		name: {
			type: "string",
			minLength: 1,
			description: "Upstream Brevo tool name, exactly as returned by brevo_list_tools.",
		},
		arguments: {
			description:
				"Arguments for the tool, matching its inputSchema from brevo_list_tools. Passed through verbatim; Brevo validates them upstream.",
			type: "object",
			propertyNames: { type: "string" },
			additionalProperties: {},
		},
	},
	required: ["name"],
	additionalProperties: false,
};

const DEFAULT_EXPOSE = { mcp: true, http: true, ui_agent: true, worker: true, cli: false, a2a: false };

function makePort(overrides: Partial<McpPassthroughPort> = {}): McpPassthroughPort {
	return {
		listTools: vi.fn().mockResolvedValue([{ name: "contacts_get_contacts", description: "List", inputSchema: {} }]),
		callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
		...overrides,
	};
}

describe("brevo_list_tools and brevo_call_tool core actions (#1490)", () => {
	afterEach(() => {
		setActionApprovalStore(undefined);
		vi.restoreAllMocks();
	});

	it("1. Contract parity for brevo_list_tools", () => {
		const action = createBrevoListToolsAction(makePort());
		expect(action.id).toBe("brevo_list_tools");
		expect(action.description).toBe(BREVO_LIST_TOOLS_DESCRIPTION);
		expect(action.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
		expect(action.expose).toEqual(DEFAULT_EXPOSE);
		expect(z.toJSONSchema(action.schema)).toEqual(EXPECTED_BREVO_LIST_TOOLS_JSON_SCHEMA);
	});

	it("2. Contract parity for brevo_call_tool", () => {
		const action = createBrevoCallToolAction(makePort());
		expect(action.id).toBe("brevo_call_tool");
		expect(action.description).toBe(BREVO_CALL_TOOL_DESCRIPTION);
		expect(action.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
		expect(action.expose).toEqual(DEFAULT_EXPOSE);
		expect(z.toJSONSchema(action.schema)).toEqual(EXPECTED_BREVO_CALL_TOOL_JSON_SCHEMA);
	});

	it("3. Forwards input key arguments verbatim upstream and defaults omitted arguments to {}", async () => {
		const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "done" }] });
		const action = createBrevoCallToolAction(makePort({ callTool }));
		const payload = { limit: 25, nested: { tags: ["vip", 1] } };
		await executeAction(action, { name: "contacts_get_contacts", arguments: payload }, { context: { caller: "mcp" } });
		expect(callTool).toHaveBeenCalledWith("contacts_get_contacts", payload);
		await executeAction(action, { name: "contacts_get_contacts" }, { context: { caller: "mcp" } });
		expect(callTool).toHaveBeenCalledWith("contacts_get_contacts", {});
	});

	it("4. Caller mcp parks sends without calling port, runs non-sends, and preserves #1427 cases 1 & 2", async () => {
		const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "contacts" }] });
		const action = createBrevoCallToolAction(makePort({ callTool }));
		const parked: ApprovalRequest[] = [];
		setActionApprovalStore({ park: vi.fn(async (req) => { parked.push(req); return { decisionId: `dec-${parked.length}` }; }) });

		await expect(
			executeAction(action, { name: "transac_templates_send_transac_email", arguments: { to: ["a@example.com"] } }, { context: { caller: "mcp", userId: "u-1" } }),
		).rejects.toThrow(PendingApprovalError);
		expect(callTool).not.toHaveBeenCalled();
		expect(parked).toHaveLength(1);

		const res = await executeAction(action, { name: "contacts_get_contacts", arguments: { limit: 10 } }, { context: { caller: "mcp", userId: "u-1" } });
		expect(callTool).toHaveBeenCalledOnce();
		expect(res).toEqual({ content: [{ type: "text", text: "contacts" }] });

		for (const name of [
			"transac_templates_send_transac_email", "email_campaign_management_send_email_campaign_now",
			"whatsapp_management_send_whatsapp_message", "conversations_post_messages",
			"conversations_post_pushed_messages", "contact_import_export_create_doi_contact",
			"users_inviteuser", "accounts_invite_admin_user", "senders_create_sender", "foo_send_bar",
		]) expect(brevoCallSends({ name })).toBe(true);
		for (const input of [
			{ name: "email_campaign_management_create_email_campaign", arguments: { scheduledAt: "2026-10-12T10:00:00Z" } },
			{ name: "email_campaign_management_update_email_campaign", arguments: { sendAtBestTime: true } },
			{ name: "whatsapp_campaigns_update_whats_app_campaign", arguments: { rescheduleFor: "2026-10-12T10:00:00Z" } },
			{ name: "email_campaign_management_update_campaign_status", arguments: { status: "queued" } },
			{ name: "users_putresendcancelinvitation", arguments: { action: "resend" } },
			{ name: "payments_create_payment_request", arguments: { notification: { channel: "email", text: "Pay" } } },
		]) expect(brevoCallSends(input)).toBe(true);
		for (const name of ["senders_get_senders", "ips_get_from_sender", "transac_templates_get_scheduled_email_by_id", "contacts_get_contacts"]) {
			expect(brevoCallSends({ name })).toBe(false);
		}
		for (const input of [
			{ name: "email_campaign_management_create_email_campaign", arguments: { name: "Draft" } },
			{ name: "email_campaign_management_update_campaign_status", arguments: { status: "suspended" } },
			{ name: "users_putresendcancelinvitation", arguments: { action: "cancel" } },
			{ name: "payments_create_payment_request", arguments: { amount: 100 } },
		]) expect(brevoCallSends(input)).toBe(false);
	});

	it("5. Caller ui runs a send without parking (#1416)", async () => {
		const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "sent" }] });
		const out = await executeAction(
			createBrevoCallToolAction(makePort({ callTool })),
			{ name: "transac_templates_send_transac_email", arguments: { to: ["a@example.com"] } },
			{ context: { caller: "ui" } },
		);
		expect(callTool).toHaveBeenCalledOnce();
		expect(out).toEqual({ content: [{ type: "text", text: "sent" }] });
	});

	it("6. Rejects with setup error before any request when API key is unset, and wires via buildRegistry", async () => {
		const fetchFn = vi.fn();
		const adapter = createBrevoPassthroughAdapter({ apiKey: () => undefined, fetchFn: fetchFn as unknown as typeof fetch });
		await expect(executeAction(createBrevoCallToolAction(adapter), { name: "contacts_get_contacts" }, { context: { caller: "mcp" } })).rejects.toThrow(/BREVO_MCP_API_KEY is not set/);
		await expect(executeAction(createBrevoListToolsAction(adapter), {}, { context: { caller: "mcp" } })).rejects.toThrow(/BREVO_MCP_API_KEY is not set/);
		expect(fetchFn).not.toHaveBeenCalled();
		await expect(executeAction(buildRegistry({}).get("brevo_list_tools")!, {}, { context: { caller: "ui" } })).rejects.toThrow(AdapterUnavailableError);
	});

	it("7. mcpStructured forwards upstream structuredContent object and omits when absent (#2333)", () => {
		const action = createBrevoCallToolAction(makePort());
		expect(action.mcpStructured).toBeDefined();
		expect(
			action.mcpStructured!({
				content: [{ type: "text", text: "ok" }],
				structuredContent: { a: 1 },
			} as any),
		).toEqual({ a: 1 });
		expect(
			action.mcpStructured!({
				content: [{ type: "text", text: "ok" }],
			}),
		).toBeUndefined();
	});
});
