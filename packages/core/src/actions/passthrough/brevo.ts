import { z } from "zod";
import type {
	McpPassthroughCallResult,
	McpPassthroughPort,
	McpPassthroughToolSummary,
} from "../../ports/mcpPassthrough.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { brevoCallSends } from "./brevoSends.js";

export const BREVO_LIST_TOOLS_DESCRIPTION =
	"Discover the tools exposed by Brevo's hosted MCP server (email campaigns, contacts, lists, transactional email, account). Returns each upstream tool's name, description, and JSON-schema input. Call this first, then invoke a tool with brevo_call_tool. Requires an MCP-enabled Brevo API key (BREVO_MCP_API_KEY).";

export const BREVO_CALL_TOOL_DESCRIPTION =
	"Invoke a Brevo tool by name via Brevo's hosted MCP server. Use brevo_list_tools to discover tool names and their input schemas; arguments are passed through verbatim and validated upstream by Brevo. Parks for the owner's approval when the call would make Brevo send or schedule a send (campaigns, transactional messages, invitations, or payment notifications).";

export const brevoListToolsInput = {} as const;
export const brevoListToolsSchema = z.object(brevoListToolsInput);
export type BrevoListToolsInput = z.infer<typeof brevoListToolsSchema>;

export const brevoCallToolInput = {
	name: z
		.string()
		.min(1)
		.describe("Upstream Brevo tool name, exactly as returned by brevo_list_tools."),
	arguments: z
		.record(z.string(), z.unknown())
		.optional()
		.describe(
			"Arguments for the tool, matching its inputSchema from brevo_list_tools. Passed through verbatim; Brevo validates them upstream.",
		),
} as const;
export const brevoCallToolSchema = z.object(brevoCallToolInput);
export type BrevoCallToolInput = z.infer<typeof brevoCallToolSchema>;

export function createBrevoListToolsAction(
	port: McpPassthroughPort,
): ActionDefinition<typeof brevoListToolsSchema, McpPassthroughToolSummary[]> {
	return defineAction({
		id: "brevo_list_tools",
		domain: "integrations",
		description: BREVO_LIST_TOOLS_DESCRIPTION,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: brevoListToolsSchema,
		async run(): Promise<McpPassthroughToolSummary[]> {
			const tools = await port.listTools();
			return tools.map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: t.inputSchema,
			}));
		},
		formatMcp: (summary) => JSON.stringify(summary, null, 2),
	});
}

export function createBrevoCallToolAction(
	port: McpPassthroughPort,
): ActionDefinition<typeof brevoCallToolSchema, McpPassthroughCallResult> {
	return defineAction({
		id: "brevo_call_tool",
		domain: "integrations",
		needsApproval: (input) => brevoCallSends(input),
		description: BREVO_CALL_TOOL_DESCRIPTION,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
		schema: brevoCallToolSchema,
		async run(args: BrevoCallToolInput): Promise<McpPassthroughCallResult> {
			const result = await port.callTool(args.name, args.arguments ?? {});
			if (result.isError) {
				throw new Error(
					result.content.map((item) => item.text).join("\n") || "Brevo tool call failed",
				);
			}
			return result;
		},
		formatMcp: (result) => result.content.map((item) => item.text).join("\n"),
		mcpStructured: (result) => {
			const sc = (result as { structuredContent?: unknown }).structuredContent;
			return sc !== null && typeof sc === "object" && !Array.isArray(sc)
				? (sc as Record<string, unknown>)
				: undefined;
		},
	});
}
