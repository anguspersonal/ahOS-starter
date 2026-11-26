import { z } from "zod";
import { DEX_TOOLS, type DexToolSpec } from "../../domain/dex/catalog.js";
import type {
	McpPassthroughCallResult,
	McpPassthroughPort,
	McpPassthroughToolSummary,
} from "../../ports/mcpPassthrough.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

export const DEX_LIST_TOOLS_DESCRIPTION =
	"List the Dex CRM tools (contacts, notes, reminders, tags, groups, custom fields) with each one's description, JSON-schema input and annotations. Served from a local catalog, so it never calls Dex. Then invoke one with dex_call_tool.";

export const DEX_CALL_TOOL_DESCRIPTION =
	"Invoke a Dex CRM tool by its exact name from dex_list_tools, e.g. dex_search_contacts. `args` is validated against that tool's schema before anything reaches Dex, and a bad field is named in the error. Reaches the irreversible dex_delete_* and dex_merge_contacts. Requires DEX_API_KEY.";

export const dexListToolsInput = {} as const;
export const dexListToolsSchema = z.object(dexListToolsInput);
export type DexListToolsInput = z.infer<typeof dexListToolsSchema>;

export const dexCallToolInput = {
	tool: z
		.string()
		.min(1)
		.describe("Dex tool name, exactly as returned by dex_list_tools (e.g. dex_search_contacts)."),
	args: z
		.record(z.string(), z.unknown())
		.optional()
		.describe(
			"Arguments for that tool, matching its inputSchema from dex_list_tools. Validated here before any request reaches Dex; omitted means {}.",
		),
} as const;
export const dexCallToolSchema = z.object(dexCallToolInput);
export type DexCallToolInput = z.infer<typeof dexCallToolSchema>;

const BY_NAME: ReadonlyMap<string, DexToolSpec> = new Map(DEX_TOOLS.map((t) => [t.name, t]));

/** `emails.0.email: Invalid input: ...` — the path a caller can find in the schema. */
function describeIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(args)"}: ${issue.message}`)
		.join("; ");
}

export function createDexListToolsAction(
	port: McpPassthroughPort,
): ActionDefinition<typeof dexListToolsSchema, McpPassthroughToolSummary[]> {
	return defineAction({
		id: "dex_list_tools",
		domain: "integrations",
		description: DEX_LIST_TOOLS_DESCRIPTION,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		schema: dexListToolsSchema,
		async run(): Promise<McpPassthroughToolSummary[]> {
			const tools = await port.listTools();
			return tools.map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: t.inputSchema,
				annotations: t.annotations,
			}));
		},
		formatMcp: (summary) => JSON.stringify(summary),
	});
}

export function createDexCallToolAction(
	port: McpPassthroughPort,
): ActionDefinition<typeof dexCallToolSchema, McpPassthroughCallResult> {
	return defineAction({
		id: "dex_call_tool",
		domain: "integrations",
		description: DEX_CALL_TOOL_DESCRIPTION,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
		schema: dexCallToolSchema,
		async run(input: DexCallToolInput): Promise<McpPassthroughCallResult> {
			const tool = BY_NAME.get(input.tool);
			if (!tool) {
				throw new Error(
					`Unknown Dex tool "${input.tool}". Valid names: ${DEX_TOOLS.map((t) => t.name).join(", ")}. ` +
						"dex_list_tools returns each one's inputSchema.",
				);
			}
			// z.object, not .strict(): preserves first-class tool validation semantics by dropping undeclared keys.
			const parsed = z.object(tool.input).safeParse(input.args ?? {});
			if (!parsed.success) {
				throw new Error(
					`Invalid args for ${tool.name}, nothing was sent to Dex. ${describeIssues(parsed.error)}. ` +
						"dex_list_tools has this tool's inputSchema.",
				);
			}
			const result = await port.callTool(tool.name, parsed.data);
			if (result.isError) {
				throw new Error(
					result.content.map((item) => item.text).join("\n") || "Dex tool call failed",
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
