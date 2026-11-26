import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../server.js";
import { notionDatabaseGetHandler } from "../tools/notionDatabaseGet.js";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const DB_ID = "11112222-3333-4444-5555-666677778888";
const DS_ID = "99990000-1111-2222-3333-444455556666";

function fakeNotion(stub: {
	schemas?: Record<string, Record<string, unknown>>;
	dataSources?: Record<string, string>;
}) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL) => {
			const href = typeof url === "string" ? url : url.toString();
			const path = new URL(href).pathname;

			if (path.startsWith("/v1/data_sources/")) {
				const id = path.split("/")[3];
				const databaseId = stub.dataSources?.[id];
				if (!databaseId) {
					return {
						ok: false,
						status: 404,
						statusText: "Not Found",
						text: async () => JSON.stringify({ message: "Could not find data source" }),
					};
				}
				return {
					ok: true,
					status: 200,
					json: async () => ({ parent: { type: "database_id", database_id: databaseId } }),
				};
			}

			if (path.startsWith("/v1/databases/")) {
				const id = path.split("/")[3];
				const properties = stub.schemas?.[id];
				if (!properties) {
					return {
						ok: false,
						status: 404,
						statusText: "Not Found",
						text: async () => JSON.stringify({ message: "Could not find database" }),
					};
				}
				return {
					ok: true,
					status: 200,
					json: async () => ({ properties }),
				};
			}

			return { ok: false, status: 404 };
		}),
	);
}

describe("notion_database_get MCP tool", () => {
	it("returns formatted database schema for valid database_id", async () => {
		fakeNotion({
			schemas: {
				[DB_ID]: {
					Name: { type: "title" },
					Status: { type: "status", status: { options: [{ name: "Done" }] } },
				},
			},
		});

		const out = await notionDatabaseGetHandler({
			domain: "work",
			database_id: DB_ID,
		} as any);

		expect(out.content[0].text).toContain(`Database schema (work, db ${DB_ID}):`);
		expect(out.content[0].text).toContain("  Name — title");
		expect(out.content[0].text).toContain("  Status — status (options: Done)");
	});

	it("resolves data_source_id to database_id", async () => {
		fakeNotion({
			schemas: {
				[DB_ID]: {
					Name: { type: "title" },
				},
			},
			dataSources: {
				[DS_ID]: DB_ID,
			},
		});

		const out = await notionDatabaseGetHandler({
			domain: "work",
			data_source_id: DS_ID,
		} as any);

		expect(out.content[0].text).toContain(`Database schema (work, db ${DB_ID}):`);
		expect(out.content[0].text).toContain("  Name — title");
	});
});

describe("registration", () => {
	it("serves notion_database_get over a real client connection", async () => {
		const server = createServer();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		const tools = (await client.listTools()).tools.map((t) => t.name);
		expect(tools).toContain("notion_database_get");

		await client.close();
		await server.close();
	});
});
