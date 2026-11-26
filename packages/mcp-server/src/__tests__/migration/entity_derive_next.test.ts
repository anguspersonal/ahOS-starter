import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ENTITY_DERIVE_NEXT_DESCRIPTION } from "@ahkms/core";
import { createServer } from "../../server.js";
import { serverRegistry } from "../../actions/serverRegistry.js";
import { readLegacyBaseline } from "../legacyBaseline.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");

async function connectClient() {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return { client, server };
}

describe("entity_derive_next migration (#1506)", () => {
	it("serves entity_derive_next from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = JSON.parse(
			readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"),
		);
		expect(manifest.actions.entity_derive_next?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("entity_derive_next")).toBeDefined();

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("entity_derive_next");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();

		const tool = tools.find((t) => t.name === "entity_derive_next")!;
		expect(tool).toBeDefined();
		expect(tool.description).toBe(ENTITY_DERIVE_NEXT_DESCRIPTION);
		expect(tool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});

		const props = (tool.inputSchema.properties ?? {}) as Record<
			string,
			{ type?: string; description?: string; minimum?: number; maximum?: number }
		>;
		expect(Object.keys(props).sort()).toEqual([
			"artifact_id",
			"artifact_ids",
			"force",
			"limit",
			"model",
			"provider",
		]);
		expect(props.limit).toMatchObject({
			type: "integer",
			minimum: 1,
			maximum: 20,
		});
	});
});
