import { z } from "zod";
import type {
	McpPassthroughCallResult,
	McpPassthroughPort,
	McpPassthroughToolSummary,
} from "../../ports/mcpPassthrough.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

export const META_ADS_LIST_TOOLS_DESCRIPTION =
	"Discover the read-only Meta Ads tools available (ad account/campaign/ad-set/ad listing, spend/impressions/clicks insights). Returns each tool's name, description, and JSON-schema input. Call this first, then invoke a tool with meta_ads_call_tool. Requires a Meta system-user access token scoped ads_read (META_ADS_ACCESS_TOKEN). Read-only: there is no write tool in this catalog, by design (#646) — pausing, editing or creating ads is out of scope.";

export const META_ADS_CALL_TOOL_DESCRIPTION =
	"Invoke a Meta Ads tool by name (list_ad_accounts, list_campaigns, list_adsets, list_ads, get_insights). Use meta_ads_list_tools to discover tool names and their input schemas. All tools are read-only Marketing API GETs; there is no way to pause, edit or create an ad through this tool.";

export const metaAdsListToolsInput = {} as const;
export const metaAdsListToolsSchema = z.object(metaAdsListToolsInput);
export type MetaAdsListToolsInput = z.infer<typeof metaAdsListToolsSchema>;

export const metaAdsCallToolInput = {
	name: z
		.string()
		.min(1)
		.describe("Meta Ads tool name, exactly as returned by meta_ads_list_tools."),
	arguments: z
		.record(z.string(), z.unknown())
		.optional()
		.describe(
			"Arguments for the tool, matching its inputSchema from meta_ads_list_tools.",
		),
} as const;
export const metaAdsCallToolSchema = z.object(metaAdsCallToolInput);
export type MetaAdsCallToolInput = z.infer<typeof metaAdsCallToolSchema>;

export function createMetaAdsListToolsAction(
	port: McpPassthroughPort,
): ActionDefinition<typeof metaAdsListToolsSchema, McpPassthroughToolSummary[]> {
	return defineAction({
		id: "meta_ads_list_tools",
		domain: "integrations",
		description: META_ADS_LIST_TOOLS_DESCRIPTION,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: metaAdsListToolsSchema,
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

export function createMetaAdsCallToolAction(
	port: McpPassthroughPort,
): ActionDefinition<typeof metaAdsCallToolSchema, McpPassthroughCallResult> {
	return defineAction({
		id: "meta_ads_call_tool",
		domain: "integrations",
		description: META_ADS_CALL_TOOL_DESCRIPTION,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		schema: metaAdsCallToolSchema,
		async run(args: MetaAdsCallToolInput): Promise<McpPassthroughCallResult> {
			const result = await port.callTool(args.name, args.arguments ?? {});
			if (result.isError) {
				throw new Error(
					result.content.map((item) => item.text).join("\n") || "Meta Ads tool call failed",
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
