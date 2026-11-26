import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDexPassthroughAdapter } from "../../adapters/passthrough/dex.js";
import { DEX_TOOLS } from "../../domain/dex/catalog.js";
import type { McpPassthroughPort } from "../../ports/mcpPassthrough.js";
import { executeAction } from "../adapters/direct.js";
import { AdapterUnavailableError, buildRegistry } from "../buildRegistry.js";
import {
	createDexCallToolAction,
	createDexListToolsAction,
	DEX_CALL_TOOL_DESCRIPTION,
	DEX_LIST_TOOLS_DESCRIPTION,
} from "./dex.js";

const EXPECTED_DEX_LIST_TOOLS_JSON_SCHEMA = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {},
	additionalProperties: false,
};

const EXPECTED_DEX_CALL_TOOL_JSON_SCHEMA = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {
		tool: {
			type: "string",
			minLength: 1,
			description: "Dex tool name, exactly as returned by dex_list_tools (e.g. dex_search_contacts).",
		},
		args: {
			description:
				"Arguments for that tool, matching its inputSchema from dex_list_tools. Validated here before any request reaches Dex; omitted means {}.",
			type: "object",
			propertyNames: { type: "string" },
			additionalProperties: {},
		},
	},
	required: ["tool"],
	additionalProperties: false,
};

const DEFAULT_EXPOSE = { mcp: true, http: true, ui_agent: true, worker: true, cli: false, a2a: false };

function makePort(overrides: Partial<McpPassthroughPort> = {}): McpPassthroughPort {
	return {
		listTools: vi.fn().mockResolvedValue([]),
		callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
		...overrides,
	};
}

describe("dex_list_tools and dex_call_tool core actions (#1520)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("1. Contract parity for dex_list_tools and dex_call_tool", () => {
		const listAction = createDexListToolsAction(makePort());
		expect(listAction.id).toBe("dex_list_tools");
		expect(listAction.description).toBe(DEX_LIST_TOOLS_DESCRIPTION);
		expect(listAction.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(listAction.expose).toEqual(DEFAULT_EXPOSE);
		expect(z.toJSONSchema(listAction.schema)).toEqual(EXPECTED_DEX_LIST_TOOLS_JSON_SCHEMA);

		const callAction = createDexCallToolAction(makePort());
		expect(callAction.id).toBe("dex_call_tool");
		expect(callAction.description).toBe(DEX_CALL_TOOL_DESCRIPTION);
		expect(callAction.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		});
		expect(callAction.expose).toEqual(DEFAULT_EXPOSE);
		expect(z.toJSONSchema(callAction.schema)).toEqual(EXPECTED_DEX_CALL_TOOL_JSON_SCHEMA);
	});

	it("2. Unknown tool returns an error naming the valid tools without making any request", async () => {
		const callTool = vi.fn();
		const action = createDexCallToolAction(makePort({ callTool }));

		const err = await executeAction(
			action,
			{ tool: "dex_find_people", args: {} },
			{ context: { caller: "mcp" } },
		).catch((e: Error) => e);

		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain("dex_find_people");
		for (const entry of DEX_TOOLS) {
			expect((err as Error).message).toContain(entry.name);
		}
		expect(callTool).not.toHaveBeenCalled();
	});

	it("3. Invalid args returns Invalid args for <tool>, nothing was sent to Dex. without making any request", async () => {
		const callTool = vi.fn();
		const action = createDexCallToolAction(makePort({ callTool }));

		const err = await executeAction(
			action,
			{ tool: "dex_create_contact", args: { first_name: "Ada", emails: [{ label: "Work" }] } },
			{ context: { caller: "mcp" } },
		).catch((e: Error) => e);

		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toMatch(/^Invalid args for dex_create_contact, nothing was sent to Dex\. /);
		expect((err as Error).message).toContain("emails.0.email");
		expect(callTool).not.toHaveBeenCalled();
	});

	it("4. dex_list_tools outputs compact JSON of name, description, JSON-schema input, and annotations for all catalog entries", async () => {
		const fetchFn = vi.fn();
		const adapter = createDexPassthroughAdapter({
			apiKey: () => undefined,
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		const action = createDexListToolsAction(adapter);
		const summary = await executeAction(action, {}, { context: { caller: "mcp" } });
		const formatted = action.formatMcp!(summary, {});

		expect(formatted).not.toContain("\n");
		const parsed = JSON.parse(formatted) as Array<{
			name: string;
			description: string;
			inputSchema: Record<string, unknown>;
			annotations: Record<string, unknown>;
		}>;
		expect(parsed).toHaveLength(DEX_TOOLS.length);
		expect(parsed.map((t) => t.name)).toEqual(DEX_TOOLS.map((t) => t.name));
		for (const item of parsed) {
			expect(typeof item.description).toBe("string");
			expect(item.inputSchema).toHaveProperty("type", "object");
			expect(item.annotations).toMatchObject({
				readOnlyHint: expect.any(Boolean),
				destructiveHint: expect.any(Boolean),
				idempotentHint: expect.any(Boolean),
				openWorldHint: expect.any(Boolean),
			});
		}
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("5. Adapter handles SSE & JSON responses; missing DEX_API_KEY rejects before any request and buildRegistry wires both actions", async () => {
		const fetchFn = vi.fn();
		const adapter = createDexPassthroughAdapter({
			apiKey: () => undefined,
			fetchFn: fetchFn as unknown as typeof fetch,
		});
		await expect(
			executeAction(
				createDexCallToolAction(adapter),
				{ tool: "dex_search_contacts", args: { query: "Ada" } },
				{ context: { caller: "mcp" } },
			),
		).rejects.toThrow(/DEX_API_KEY is not set/);
		expect(fetchFn).not.toHaveBeenCalled();

		await expect(
			executeAction(
				buildRegistry({}).get("dex_call_tool")!,
				{ tool: "dex_search_contacts", args: { query: "Ada" } },
				{ context: { caller: "ui" } },
			),
		).rejects.toThrow(AdapterUnavailableError);
	});

	it("6. mcpStructured forwards upstream structuredContent object and omits when absent (#2333)", () => {
		const action = createDexCallToolAction(makePort());
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
