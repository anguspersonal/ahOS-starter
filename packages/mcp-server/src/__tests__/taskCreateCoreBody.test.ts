import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildRegistry, createCoreTasksPort } from "@ahkms/core/actions";
import { supabase } from "../supabase.js";
import { createServer } from "../server.js";

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.unstubAllGlobals();
});

describe("task_create over core ports without mcp-server code (#1662)", () => {
	it("succeeds when mcp-server's supabase.from throws and fetch refuses", async () => {
		(supabase as any).from = vi.fn(() => {
			throw new Error("mcp-server supabase.from must not be called");
		});
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch must not be called")));

		const createPage = vi.fn(async () => ({ id: "page_1", url: "https://notion.so/page_1" }));
		const insert = vi.fn(async (row: any) => row);
		const tasks = createCoreTasksPort({
			tasks: {} as any,
			notion: { createPage } as any,
			config: { loadConfig: async () => ({ tasks_database_id: "db", title_property: "Name", property_map: {} }) } as any,
			links: { recordExternalLink: async () => ({ ok: true }) } as any,
			artifacts: { insert } as any,
			storage: { upload: async () => {}, remove: async () => {}, publicUrl: () => "https://storage.test/x" },
			entities: {} as any,
			entityLinks: {} as any,
			storageBucket: "bucket",
		});

		const server = createServer(undefined, undefined, buildRegistry({ tasks }));
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		const response = await client.callTool({
			name: "task_create",
			arguments: { title: "Buy milk", domain: "work" },
		});
		await client.close();

		expect(response.isError).toBeFalsy();
		const id = insert.mock.calls[0][0].id;
		expect((response.content as Array<{ text: string }>)[0].text).toBe(
			`Created Notion task: Buy milk\nPage: https://notion.so/page_1\nSource captured as artifact ${id} (content_subtype='task_request')\nLinked to artifact ${id}`,
		);
		expect(createPage).toHaveBeenCalledTimes(1);
	});
});
