import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildRegistry } from "@ahkms/core/actions";
import { createServer } from "../server.js";
import { serverAdapters, serverRegistry } from "../actions/serverRegistry.js";
import { toMcpTool } from "../actions/index.js";
import { readLegacyBaseline } from "./legacyBaseline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../");

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

describe("bindingWriteActions (#1595)", () => {
	it("1. Contract parity: binding_create, binding_update, binding_delete match dev inputSchema and annotations", async () => {
		const tools = await withMcpClient(async (c) => (await c.listTools()).tools);

		const createTool = tools.find((t) => t.name === "binding_create")!;
		expect(createTool).toBeDefined();
		const createProps = (createTool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(createProps)).toEqual(["name", "domain", "scope", "target_kind", "target_ref"]);
		expect(createTool.inputSchema.required ?? []).toEqual(["name", "target_kind", "target_ref"]);
		expect(createProps.name?.type).toBe("string");
		expect(createProps.domain?.type).toBe("string");
		expect(createProps.scope?.type).toBe("string");
		expect(createProps.target_kind?.type).toBe("string");
		expect(createProps.target_ref?.type).toBe("object");
		expect(createTool.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		});

		const updateTool = tools.find((t) => t.name === "binding_update")!;
		expect(updateTool).toBeDefined();
		const updateProps = (updateTool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(updateProps)).toEqual(["name", "domain", "scope", "target_kind", "target_ref"]);
		expect(updateTool.inputSchema.required ?? []).toEqual(["name"]);
		expect(updateProps.name?.type).toBe("string");
		expect(updateProps.domain?.type).toBe("string");
		expect(updateProps.scope?.type).toBe("string");
		expect(updateProps.target_kind?.type).toBe("string");
		expect(updateProps.target_ref?.type).toBe("object");
		expect(updateTool.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});

		const deleteTool = tools.find((t) => t.name === "binding_delete")!;
		expect(deleteTool).toBeDefined();
		const deleteProps = (deleteTool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(deleteProps)).toEqual(["name", "domain", "scope"]);
		expect(deleteTool.inputSchema.required ?? []).toEqual(["name"]);
		expect(deleteProps.name?.type).toBe("string");
		expect(deleteProps.domain?.type).toBe("string");
		expect(deleteProps.scope?.type).toBe("string");
		expect(deleteTool.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		});
	});

	it("2. Exposure: binding_create, binding_update, binding_delete are in action-manifest.json with default exposure", () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(repoRoot, "packages/core/action-manifest.json"), "utf8"),
		);
		for (const id of ["binding_create", "binding_update", "binding_delete"] as const) {
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

	it("3. Registration path: all three ids are in buildRegistry and absent from legacy-tools-baseline.txt", () => {
		const registry = buildRegistry(serverAdapters());
		const ids = registry.list().map((a) => a.id);
		for (const id of ["binding_create", "binding_update", "binding_delete"] as const) {
			expect(ids).toContain(id);
		}

		const baseline = readLegacyBaseline();
		for (const id of ["binding_create", "binding_update", "binding_delete"] as const) {
			expect(baseline).not.toContain(id);
		}
	});

	it("4. A target_ref that does not match its target_kind is refused", async () => {
		const createHandler = toMcpTool(serverRegistry().get("binding_create")!).handler;
		await expect(
			createHandler({
				name: "notion.inbox_db",
				target_kind: "integration_config",
				target_ref: { value: "not-an-integration-config" },
			}),
		).rejects.toThrow(/target_ref does not match target_kind='integration_config'/);
	});
});
