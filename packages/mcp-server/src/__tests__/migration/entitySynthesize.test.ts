/**
 * Migration acceptance test: entity_synthesize served from registry (#1567).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../server.js";
import { readLegacyBaseline } from "../legacyBaseline.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../../../../../");

async function listTools() {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools;
}

describe("entity_synthesize migration (#1567)", () => {
	it("4. entity_synthesize is a manifest key with mcp exposure and not in the legacy set; listTools() shows dev's inputSchema keys entity_id, dry_run, max_artifacts, provider, model", async () => {
		const manifestPath = resolve(repoRoot, "packages/core/action-manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

		const legacyBaseline = readLegacyBaseline();
		const legacySet = new Set(legacyBaseline);

		const action = manifest.actions.entity_synthesize;
		expect(action).toBeDefined();
		expect(action.expose.mcp).toBe(true);
		expect(legacySet.has("entity_synthesize")).toBe(false);

		const tools = await listTools();
		const tool = tools.find((t) => t.name === "entity_synthesize");
		expect(tool).toBeDefined();
		expect(tool!.description).toBe(
			"Synthesize a concise, factual profile for an entity from evidence in its linked artifacts and update " +
				"entities.description and properties.synthesis. Supports dry_run (makes LLM call and returns profile " +
				"without writing back). Uses Gemini by default, with optional Anthropic routing. Returns plain text with " +
				"LLM output safely quoted.",
		);
		expect(tool!.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		const props = (tool!.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
		expect(Object.keys(props).sort()).toEqual(
			["entity_id", "dry_run", "max_artifacts", "provider", "model"].sort(),
		);
		expect(props.entity_id?.description).toBe("Entity UUID to synthesize");
		expect(props.dry_run?.description).toBe(
			"If true, runs synthesis without writing back to entity",
		);
		expect(props.max_artifacts?.description).toBe(
			"Maximum linked artifacts to consider (1-10, default 10)",
		);
		expect(props.provider?.description).toBe(
			"Optional provider override ('gemini' or 'anthropic')",
		);
		expect(props.model?.description).toBe("Optional model override");
		expect(tool!.inputSchema.required).toEqual(["entity_id"]);
	});
});
