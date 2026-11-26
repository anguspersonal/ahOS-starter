import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildRegistry } from "@ahkms/core/actions";
import { createServer } from "../server.js";
import { serverAdapters } from "../actions/serverRegistry.js";
import { supabase } from "../supabase.js";
import { readLegacyBaseline } from "./legacyBaseline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../");
const origFrom = supabase.from;

afterEach(() => {
	(supabase as any).from = origFrom;
});

async function withMcpClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	try {
		return await fn(client);
	} finally {
		await client.close();
	}
}

describe("configActions (#1597)", () => {
	it("1. Contract parity (R11): integration_list has provider/include_config properties and read-only annotations", async () => {
		const tools = await withMcpClient(async (c) => (await c.listTools()).tools);
		const tool = tools.find((t) => t.name === "integration_list");
		expect(tool).toBeDefined();
		expect(Object.keys(tool!.inputSchema.properties ?? {})).toEqual(["provider", "include_config"]);
		expect(tool!.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("2. Exposure: integration_list is in action-manifest.json with default exposure", () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(repoRoot, "packages/core/action-manifest.json"), "utf8"),
		);
		expect(manifest.actions.integration_list?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
	});

	it("3. Registration path: integration_list is in buildRegistry and absent from legacy-tools-baseline.txt", () => {
		const registry = buildRegistry(serverAdapters());
		expect(registry.list().map((a) => a.id)).toContain("integration_list");
		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("integration_list");
	});

	it("4. Output prints provider, routing, status, enabled and config key names, never values, plus Notion page-access note", async () => {
		(supabase as any).from = vi.fn(() => ({
			select: () => ({
				eq: () =>
					Promise.resolve({
						data: [
							{
								provider: "notion_work",
								enabled: true,
								routing: "native",
								status: "connected",
								config: { tasks_database_id: "secret-db-value-123" },
							},
						],
						error: null,
					}),
			}),
		}));

		const result = await withMcpClient((c) =>
			c.callTool({ name: "integration_list", arguments: {} }),
		);
		const text = ((result.content as any)[0]?.text ?? "") as string;
		expect(text).toContain("• notion_work [native] — keys: tasks_database_id");
		expect(text).not.toContain("secret-db-value-123");
		expect(text).toContain("Notion page access (#625/#818):");
	});
});
