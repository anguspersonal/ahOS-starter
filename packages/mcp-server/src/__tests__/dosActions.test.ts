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

describe("dosActions (#1603)", () => {
	it("1. Contract parity: dos_config_get has domain and audience properties, unchanged types/required, and read-only annotations", async () => {
		const tools = await withMcpClient(async (c) => (await c.listTools()).tools);
		const tool = tools.find((t) => t.name === "dos_config_get");
		expect(tool, "dos_config_get should be listed").toBeDefined();
		expect(Object.keys(tool!.inputSchema.properties ?? {})).toEqual(["domain", "audience"]);
		expect(tool!.inputSchema.required ?? []).toEqual([]);
		expect((tool!.inputSchema.properties as any)?.domain).toMatchObject({
			type: "string",
			enum: ["work", "angus"],
		});
		expect((tool!.inputSchema.properties as any)?.audience).toMatchObject({
			type: "string",
		});
		expect(tool!.description).toContain("docs/guides/tools/dos_config_get.md");
		expect(tool!.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("2. Exposure: dos_config_get is a key of packages/core/action-manifest.json with default exposure", () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(repoRoot, "packages/core/action-manifest.json"), "utf8"),
		);
		expect(manifest.actions.dos_config_get?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
	});

	it("3. Registration path: dos_config_get is in buildRegistry and absent from legacy-tools-baseline.txt", () => {
		const registry = buildRegistry(serverAdapters());
		expect(registry.list().map((a) => a.id)).toContain("dos_config_get");

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("dos_config_get");
	});

	it("4. Executes dos_config_get through the registry and renders domain config", async () => {
		(supabase as any).from = vi.fn(() => ({
			select: () => ({
				eq: () => ({
					maybeSingle: () =>
						Promise.resolve({
							data: {
								dos_config: {
									by_domain: {
										work: {
											topics: ["Round", "Product"],
											domain_signals: ["Work"],
										},
									},
									types: [{ key: "Note", description: "Passive observation" }],
									tone: ["Plain British English"],
								},
							},
							error: null,
						}),
				}),
			}),
		}));

		const res = await withMcpClient((c) =>
			c.callTool({ name: "dos_config_get", arguments: { domain: "work" } }),
		);
		const text = ((res.content as any)[0]?.text ?? "") as string;
		expect(text).toContain("dos config — domain: work (user_preferences.dos_config):");
		expect(text).toContain("  Round, Product");
		expect(text).toContain("  Note — Passive observation");
		expect(text).toContain("  - Plain British English");
	});
});
