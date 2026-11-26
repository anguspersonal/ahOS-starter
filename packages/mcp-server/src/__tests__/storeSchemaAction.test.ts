import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildRegistry } from "@ahkms/core/actions";
import { createSupabaseSchemaIntrospectionAdapter } from "@ahkms/core/adapters";
import actionManifest from "@ahkms/core/action-manifest.json" with { type: "json" };
import { createServer } from "../server.js";
import { readLegacyBaseline } from "./legacyBaseline.js";


async function connectClient() {
	const server = createServer();
	const client = new Client({ name: "store-schema-action-test", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("store_schema action migration (#1609)", () => {
	it("case 1: contract parity (R11) — inputSchema.properties, required, annotations, and description match dev", async () => {
		const client = await connectClient();
		const { tools } = await client.listTools();
		const tool = tools.find((t) => t.name === "store_schema");
		expect(tool).toBeDefined();

		const props = (tool!.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
		expect(Object.keys(props)).toEqual(["table"]);
		expect(props.table.type).toBe("string");
		expect(tool!.inputSchema.required ?? []).toEqual([]);

		expect(tool!.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(tool!.description).toContain("Full notes: docs/guides/tools/store_schema.md");
	});

	it("case 2: exposure — store_schema is in action-manifest.json with mcp/http/ui_agent/worker true and cli/a2a false", () => {
		expect(actionManifest.actions.store_schema).toBeDefined();
		expect(actionManifest.actions.store_schema.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
	});

	it("case 3: registration path — store_schema is in buildRegistry and absent from legacy-tools-baseline.txt", () => {
		const ids = buildRegistry({}).list().map((a) => a.id);
		expect(ids).toContain("store_schema");

		const baselineLines = readLegacyBaseline();
		expect(baselineLines).not.toContain("store_schema");
	});

	it("case 4: the adapter's error never contains the key", async () => {
		const secretKey = "top-secret-service-role-key-987654321";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: false,
				status: 401,
				statusText: "Unauthorized",
				text: async () => '{"message":"Invalid API key"}',
			})) as unknown as typeof fetch,
		);

		const adapter = createSupabaseSchemaIntrospectionAdapter({
			supabaseUrl: "http://localhost:54321",
			serviceRoleKey: secretKey,
		});

		await expect(adapter.fetchOpenApi()).rejects.toThrow(/401 Unauthorized/);
		try {
			await adapter.fetchOpenApi();
		} catch (err) {
			expect((err as Error).message).not.toContain(secretKey);
		}
	});
});
