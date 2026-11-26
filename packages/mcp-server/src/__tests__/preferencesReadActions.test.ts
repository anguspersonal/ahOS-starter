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

describe("preferencesReadActions (#1599)", () => {
	it("1. Contract parity: config_capture_get and config_preferences_get have empty properties and read-only annotations", async () => {
		const tools = await withMcpClient(async (c) => (await c.listTools()).tools);
		for (const name of ["config_capture_get", "config_preferences_get"] as const) {
			const tool = tools.find((t) => t.name === name);
			expect(tool, `${name} should be listed`).toBeDefined();
			expect(Object.keys(tool!.inputSchema.properties ?? {})).toEqual([]);
			expect(tool!.inputSchema.required ?? []).toEqual([]);
			expect(tool!.annotations).toMatchObject({
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			});
		}
	});

	it("2. Exposure: config_capture_get and config_preferences_get are in action-manifest.json with default exposure", () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(repoRoot, "packages/core/action-manifest.json"), "utf8"),
		);
		for (const id of ["config_capture_get", "config_preferences_get"] as const) {
			expect(manifest.actions[id]?.expose).toEqual({
				mcp: true,
				http: true,
				ui_agent: true,
				worker: true,
				cli: false,
				a2a: false,
			});
		}
	});

	it("3. Registration path: both ids are in buildRegistry and absent from legacy-tools-baseline.txt", () => {
		const registry = buildRegistry(serverAdapters());
		const ids = registry.list().map((a) => a.id);
		expect(ids).toContain("config_capture_get");
		expect(ids).toContain("config_preferences_get");

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("config_capture_get");
		expect(baseline).not.toContain("config_preferences_get");
	});

	it("4. Executes config_capture_get and config_preferences_get through the registry", async () => {
		(supabase as any).from = vi.fn(() => ({
			select: () => ({
				eq: () => ({
					maybeSingle: () =>
						Promise.resolve({
							data: {
								user_id: "user-1",
								user_mode: "solo",
								capture_preferences: { default_tags: ["ops"] },
							},
							error: null,
						}),
				}),
			}),
		}));

		const [capRes, prefRes] = await withMcpClient((c) =>
			Promise.all([
				c.callTool({ name: "config_capture_get", arguments: {} }),
				c.callTool({ name: "config_preferences_get", arguments: {} }),
			]),
		);

		const capText = ((capRes.content as any)[0]?.text ?? "") as string;
		expect(capText).toContain("Persisted capture context (user_preferences.capture_preferences):");
		expect(capText).toContain("default_tags: ops");

		const prefText = ((prefRes.content as any)[0]?.text ?? "") as string;
		expect(prefText).toContain("user_preferences row:");
		expect(prefText).toContain("user_id:                    user-1");
	});
});
