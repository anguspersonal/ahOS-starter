/**
 * Migration acceptance test: notion_page_update served from registry (#1575).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../server.js";
import { serverRegistry } from "../../actions/serverRegistry.js";
import { TOOL_ALIASES } from "../../toolAliases.js";
import { supabase } from "../../supabase.js";
import { readLegacyBaseline } from "../legacyBaseline.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../../../../../");

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function connectClient() {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return { client, server };
}

describe("notion_page_update migration (#1575)", () => {
	it("serves notion_page_update from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = JSON.parse(readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"));
		expect(manifest.actions.notion_page_update?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("notion_page_update")).toBeDefined();

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("notion_page_update");
		expect(TOOL_ALIASES.update_notion_page).toBe("notion_page_update");

		const { client, server } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();
		await server.close();

		const tool = tools.find((t) => t.name === "notion_page_update");
		expect(tool).toBeDefined();
		expect(tool!.description).toBe(
			"Write to any Notion page — the write half of the page surface. `domain` ('work' or 'angus') " +
				"is REQUIRED, no default. Ops: 'append' blocks, 'update_block' to rewrite one block in place, " +
				"'update_properties' — which also sets `icon` and trashes or restores the page via `archived`. " +
				"Refuses State Doc pages. Full notes: docs/guides/tools/notion_page_update.md",
		);
		expect(tool!.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});

		const props = (tool!.inputSchema.properties ?? {}) as Record<string, { type?: string; description?: string }>;
		expect(Object.keys(props).sort()).toEqual(
			[
				"after",
				"archived",
				"block_id",
				"block_type",
				"body",
				"checked",
				"domain",
				"icon",
				"op",
				"page_id",
				"properties",
				"text",
			].sort(),
		);
		expect(tool!.inputSchema.required).toBeUndefined();
		expect(props.domain?.description).toContain("Required. Which workspace to write to: 'work'");
		expect(props.op?.description).toContain("Required. append: add blocks to the end of a page");
		expect(props.page_id?.description).toContain("append / update_properties: the target page");
		expect(props.after?.description).toContain("append: place the new blocks immediately after this sibling block id");
		expect(props.body?.description).toContain("append: the content, one block per line.");
		expect(props.block_id?.description).toBe("update_block: the block to rewrite. Get ids from notion_page_get.");
		expect(props.block_type?.description).toContain("update_block: the block's type exactly as notion_page_get reported it");
		expect(props.text?.description).toContain("update_block: the block's new text");
		expect(props.checked?.description).toBe("update_block on a to_do block: set the checkbox state in the same call.");
		expect(props.properties?.description).toContain("update_properties: keyed by property NAME");
		expect(props.archived?.description).toContain("update_properties: true moves the page to Notion's TRASH");
		expect(props.icon?.description).toContain("update_properties: the page icon, in Notion's raw shape");
	});

	it("executes notion_page_update through MCP with byte-for-byte text parity and wired State Doc guard", async () => {
		const PAGE = "8db39ce2-4513-4593-9a57-f3a9a0a05ed7";
		const STATE_DOC = "aaaabbbb-cccc-dddd-eeee-ffff00001111";
		const BLOCK = "b2b2b2b2-0000-0000-0000-000000000002";

		(supabase as any).from = vi.fn(() => {
			const b: any = {
				select: () => b,
				eq: () => b,
				maybeSingle: async () => ({
					data: {
						config: {
							tasks_database_id: "db1",
							state_doc_page_id: STATE_DOC,
						},
						enabled: true,
					},
					error: null,
				}),
			};
			return b;
		});

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL, init: RequestInit = {}) => {
				const path = new URL(typeof url === "string" ? url : url.toString()).pathname;
				if (init.method === "PATCH" && path === `/v1/blocks/${PAGE}/children`) {
					return {
						ok: true,
						status: 200,
						json: async () => ({ results: [{ id: "b1" }], has_more: false, next_cursor: null }),
					};
				}
				if (init.method === "PATCH" && path === `/v1/blocks/${BLOCK}`) {
					return {
						ok: true,
						status: 200,
						json: async () => ({ id: BLOCK, type: "to_do" }),
					};
				}
				if (init.method === "PATCH" && path === `/v1/pages/${PAGE}`) {
					return {
						ok: true,
						status: 200,
						json: async () => ({ id: PAGE }),
					};
				}
				if (init.method === "GET" && path === `/v1/blocks/${BLOCK}`) {
					return {
						ok: true,
						status: 200,
						json: async () => ({ id: BLOCK, type: "to_do", parent: { type: "page_id", page_id: PAGE } }),
					};
				}
				throw new Error(`unexpected fetch: ${init.method ?? "GET"} ${path}`);
			}),
		);

		const { client, server } = await connectClient();

		const blocked = await client.callTool({
			name: "notion_page_update",
			arguments: { domain: "work", op: "append", page_id: STATE_DOC, body: "- blocked" },
		});
		expect(blocked.isError).toBe(true);
		expect(((blocked.content as any)[0] as any).text).toMatch(/state_doc_update/);

		const appended = await client.callTool({
			name: "notion_page_update",
			arguments: { domain: "work", op: "append", page_id: PAGE, body: "- first\n- second" },
		});
		expect(appended.isError).toBeFalsy();
		expect(((appended.content as any)[0] as any).text).toBe(
			`Appended 2 block(s) to ${PAGE} (domain='work').`,
		);

		const updatedBlock = await client.callTool({
			name: "notion_page_update",
			arguments: {
				domain: "work",
				op: "update_block",
				block_id: BLOCK,
				block_type: "to_do",
				text: "Passport renewed",
				checked: true,
			},
		});
		expect(updatedBlock.isError).toBeFalsy();
		expect(((updatedBlock.content as any)[0] as any).text).toBe(
			`Updated block ${BLOCK} (to_do, domain='work').`,
		);

		const trashed = await client.callTool({
			name: "notion_page_update",
			arguments: {
				domain: "work",
				op: "update_properties",
				page_id: PAGE,
				archived: true,
			},
		});
		expect(trashed.isError).toBeFalsy();
		expect(((trashed.content as any)[0] as any).text).toBe(
			`Page ${PAGE} (domain='work'): moved it to Notion's trash (restore with archived:false).`,
		);

		const restored = await client.callTool({
			name: "notion_page_update",
			arguments: {
				domain: "work",
				op: "update_properties",
				page_id: PAGE,
				archived: false,
			},
		});
		expect(restored.isError).toBeFalsy();
		expect(((restored.content as any)[0] as any).text).toBe(
			`Page ${PAGE} (domain='work'): restored it from Notion's trash.`,
		);

		await client.close();
		await server.close();
	});
});
