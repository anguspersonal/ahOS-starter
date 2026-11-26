import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildRegistry } from "@ahkms/core/actions";
import { createServer } from "../server.js";
import { readLegacyBaseline } from "./legacyBaseline.js";

const require = createRequire(import.meta.url);
const manifest = require("@ahkms/core/action-manifest.json") as {
	actions: Record<string, { expose: Record<string, boolean> }>;
};

async function listTools() {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools;
}

describe("link_get and link_query MCP surface parity (#1472)", () => {
	it("case 1: preserves dev inputSchema properties, required list, types, description, and annotations", async () => {
		const tools = await listTools();
		const linkGet = tools.find((t) => t.name === "link_get");
		const linkQuery = tools.find((t) => t.name === "link_query");

		expect(linkGet).toBeDefined();
		expect(linkGet?.description).toBe("Read one artifact-entity link by id.");
		expect(Object.keys(linkGet?.inputSchema.properties ?? {})).toEqual(["id"]);
		expect(linkGet?.inputSchema.required).toEqual(["id"]);
		expect((linkGet?.inputSchema.properties as Record<string, { type?: string }>).id.type).toBe(
			"string",
		);
		expect(linkGet?.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});

		expect(linkQuery).toBeDefined();
		expect(linkQuery?.description).toBe(
			"Read artifact-entity links with optional artifact, entity, or link_type filters.",
		);
		expect(Object.keys(linkQuery?.inputSchema.properties ?? {}).sort()).toEqual(
			["artifact_id", "entity_id", "limit", "link_type"].sort(),
		);
		expect(linkQuery?.inputSchema.required ?? []).toEqual([]);
		const queryProps = linkQuery?.inputSchema.properties as Record<string, { type?: string }>;
		expect(queryProps.artifact_id.type).toBe("string");
		expect(queryProps.entity_id.type).toBe("string");
		expect(queryProps.link_type.type).toBe("string");
		expect(["integer", "number"]).toContain(queryProps.limit.type);
		expect(linkQuery?.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("case 2: exposes link_get and link_query in action-manifest.json with default surface flags", () => {
		const actions = manifest.actions as Record<
			string,
			{ expose: Record<string, boolean> }
		>;
		for (const id of ["link_get", "link_query"]) {
			expect(actions[id]).toBeDefined();
			expect(actions[id].expose).toEqual({
				mcp: true,
				http: true,
				ui_agent: true,
				worker: true,
				cli: false,
				a2a: false,
			});
		}
	});

	it("case 3: registers link_get and link_query in buildRegistry and removes them from legacy-tools-baseline.txt", () => {
		const registryIds = buildRegistry({}).list().map((a) => a.id);
		expect(registryIds).toContain("link_get");
		expect(registryIds).toContain("link_query");

		const baselineTools = readLegacyBaseline();
		expect(baselineTools).not.toContain("link_get");
		expect(baselineTools).not.toContain("link_query");
	});
});
