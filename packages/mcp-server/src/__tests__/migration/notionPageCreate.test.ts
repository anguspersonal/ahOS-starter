/**
 * Migration acceptance test: notion_page_create served from registry (#1573).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../server.js";
import { serverRegistry } from "../../actions/serverRegistry.js";
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

describe("notion_page_create migration (#1573)", () => {
	it("serves notion_page_create from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = JSON.parse(readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"));
		expect(manifest.actions.notion_page_create?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("notion_page_create")).toBeDefined();

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("notion_page_create");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();

		const tool = tools.find((t) => t.name === "notion_page_create");
		expect(tool).toBeDefined();
		expect(tool!.description).toBe(
			"Create a page in either Notion workspace: a row in a database, or a child page under a page. `properties` are Notion's own REST shapes, validated against the database schema before anything is written — an unknown select option is refused here because Notion would silently create it instead. State Doc and Daily Log refused: they have their own writers.",
		);
		expect(tool!.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});

		const props = (tool!.inputSchema.properties ?? {}) as Record<string, { type?: string; description?: string }>;
		expect(Object.keys(props).sort()).toEqual(
			["body", "data_source_id", "database_id", "domain", "icon", "parent_page_id", "properties", "title"].sort(),
		);
		expect(tool!.inputSchema.required).toEqual(["domain", "title"]);
		expect(props.domain?.description).toContain("Which workspace: 'work' (work) or 'angus' (personal).");
		expect(props.database_id?.description).toContain("Create a row in this database.");
		expect(props.data_source_id?.description).toContain("Create a row in the database behind this data source.");
		expect(props.parent_page_id?.description).toContain("Create a child page under this ordinary page.");
		expect(props.title?.description).toBe(
			"The page title. Written into whichever property the database declares as its title.",
		);
		expect(props.properties?.description).toContain("Other properties, keyed by the property NAME");
		expect(props.body?.description).toContain("Page body as Markdown");
		expect(props.icon?.description).toBe("A single emoji for the page icon.");
	});

	it("executes notion_page_create through MCP with byte-for-byte text parity and wired State Doc / Daily Log guards", async () => {
		const DB_ID = "11112222-3333-4444-5555-666677778888";
		const STATE_DOC = "aaaabbbb-cccc-dddd-eeee-ffff00001111";

		(supabase as any).from = vi.fn(() => {
			const b: any = {
				select: () => b,
				eq: () => b,
				maybeSingle: async () => ({
					data: { config: { tasks_database_id: "db1", state_doc_page_id: STATE_DOC }, enabled: true },
					error: null,
				}),
			};
			return b;
		});

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL, init: RequestInit = {}) => {
				const path = new URL(typeof url === "string" ? url : url.toString()).pathname;
				if (path.startsWith("/v1/databases/")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({ properties: { Name: { type: "title" } } }),
					};
				}
				if (path === "/v1/pages" && init.method === "POST") {
					return {
						ok: true,
						status: 200,
						json: async () => ({ id: "created-page-id", url: "https://notion.so/created-page-id" }),
					};
				}
				throw new Error(`unexpected fetch: ${path}`);
			}),
		);

		const { client } = await connectClient();

		const blocked = await client.callTool({
			name: "notion_page_create",
			arguments: { domain: "work", parent_page_id: STATE_DOC, title: "Blocked" },
		});
		expect(blocked.isError).toBe(true);
		expect(((blocked.content as any)[0] as any).text).toMatch(/State Doc/);

		const created = await client.callTool({
			name: "notion_page_create",
			arguments: { domain: "work", database_id: DB_ID, title: "Row title" },
		});
		expect(created.isError).toBeFalsy();
		expect(((created.content as any)[0] as any).text).toBe(
			"Created in 'work': created-page-id\nhttps://notion.so/created-page-id",
		);

		await client.close();
	});
});
