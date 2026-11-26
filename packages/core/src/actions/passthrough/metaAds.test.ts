import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpPassthroughPort } from "../../ports/mcpPassthrough.js";
import {
	META_ADS_CALL_TOOL_DESCRIPTION,
	META_ADS_LIST_TOOLS_DESCRIPTION,
	createMetaAdsCallToolAction,
	createMetaAdsListToolsAction,
	metaAdsCallToolSchema,
	metaAdsListToolsSchema,
} from "./metaAds.js";

function makeMockPort(overrides: Partial<McpPassthroughPort> = {}): McpPassthroughPort {
	return {
		listTools: vi.fn(async () => [
			{
				name: "list_ad_accounts",
				description: "List ad accounts",
				inputSchema: { type: "object", properties: {} },
			},
		]),
		callTool: vi.fn(async () => ({
			content: [{ type: "text", text: JSON.stringify({ data: [] }, null, 2) }],
		})),
		...overrides,
	};
}

describe("meta_ads_list_tools action", () => {
	it("preserves exact id, schema, description, and annotations", () => {
		const action = createMetaAdsListToolsAction(makeMockPort());

		expect(action.id).toBe("meta_ads_list_tools");
		expect(action.description).toBe(META_ADS_LIST_TOOLS_DESCRIPTION);
		expect(action.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		expect(z.toJSONSchema(action.schema)).toEqual(z.toJSONSchema(metaAdsListToolsSchema));
	});

	it("delegates to port.listTools and formats as pretty JSON for MCP", async () => {
		const port = makeMockPort();
		const action = createMetaAdsListToolsAction(port);

		const result = await action.run({}, {} as any);
		expect(port.listTools).toHaveBeenCalledOnce();
		expect(result).toEqual([
			{
				name: "list_ad_accounts",
				description: "List ad accounts",
				inputSchema: { type: "object", properties: {} },
			},
		]);
		expect(action.formatMcp?.(result, {})).toBe(JSON.stringify(result, null, 2));
	});
});

describe("meta_ads_call_tool action", () => {
	it("preserves exact id, JSON schema (name, arguments), description, and annotations", () => {
		const action = createMetaAdsCallToolAction(makeMockPort());

		expect(action.id).toBe("meta_ads_call_tool");
		expect(action.description).toBe(META_ADS_CALL_TOOL_DESCRIPTION);
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});

		const jsonSchema = z.toJSONSchema(action.schema) as {
			properties: Record<string, unknown>;
			required?: string[];
		};
		expect(jsonSchema).toEqual(z.toJSONSchema(metaAdsCallToolSchema));
		expect(Object.keys(jsonSchema.properties).sort()).toEqual(["arguments", "name"]);
		expect(jsonSchema.required).toEqual(["name"]);
	});

	it("delegates to port.callTool with empty object when arguments are omitted", async () => {
		const port = makeMockPort();
		const action = createMetaAdsCallToolAction(port);

		const result = await action.run({ name: "list_ad_accounts" }, {} as any);
		expect(port.callTool).toHaveBeenCalledWith("list_ad_accounts", {});
		expect(action.formatMcp?.(result, { name: "list_ad_accounts" })).toBe(
			JSON.stringify({ data: [] }, null, 2),
		);
	});

	it("throws when port.callTool returns isError=true", async () => {
		const port = makeMockPort({
			callTool: vi.fn(async () => ({
				content: [{ type: "text", text: "Bad request" }],
				isError: true,
			})),
		});
		const action = createMetaAdsCallToolAction(port);

		await expect(action.run({ name: "list_ad_accounts" }, {} as any)).rejects.toThrow(
			"Bad request",
		);
	});

	it("mcpStructured forwards upstream structuredContent object and omits when absent (#2333)", () => {
		const action = createMetaAdsCallToolAction(makeMockPort());
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
