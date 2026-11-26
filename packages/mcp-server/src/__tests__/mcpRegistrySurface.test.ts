import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { ActionRegistry, defineAction } from "@ahkms/core";
import { createServer } from "../server.js";
import { readLegacyBaseline } from "./legacyBaseline.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../../");

async function listTools(serverInstance = createServer()) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	await Promise.all([serverInstance.connect(serverTransport), client.connect(clientTransport)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools;
}

describe("MCP registry surface (#1552, ADR-105)", () => {
	it("Case 1: listTools() contains every manifest id with expose.mcp, each with matching properties keys and description", async () => {
		const manifestPath = path.join(repoRoot, "packages/core/action-manifest.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		const mcpManifestActions = Object.entries(manifest.actions)
			.filter(([_, entry]: any) => entry.expose?.mcp === true);

		expect(mcpManifestActions.length).toBeGreaterThan(0);

		const tools = await listTools();
		const toolMap = new Map(tools.map((t) => [t.name, t]));

		for (const [id, entry] of mcpManifestActions as [string, any][]) {
			const tool = toolMap.get(id);
			expect(tool, `Tool "${id}" should be advertised`).toBeDefined();
			expect(tool!.description).toBe(entry.description);

			const advertisedPropKeys = Object.keys(tool!.inputSchema?.properties ?? {}).sort();
			const manifestPropKeys = Object.keys(entry.input_schema?.properties ?? {}).sort();
			expect(advertisedPropKeys, `Properties mismatch for tool "${id}"`).toEqual(manifestPropKeys);
		}
	});

	it("Case 2: advertised names equal manifest mcp ids plus legacy baseline, and nothing else", async () => {
		const manifestPath = path.join(repoRoot, "packages/core/action-manifest.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		const manifestMcpIds = Object.entries(manifest.actions)
			.filter(([_, entry]: any) => entry.expose?.mcp === true)
			.map(([id]) => id);

		const legacyBaseline = readLegacyBaseline();

		const expectedNames = new Set([
			...manifestMcpIds,
			...legacyBaseline,
		]);

		const tools = await listTools();
		const advertisedNames = new Set(tools.map((t) => t.name));

		expect(Array.from(advertisedNames).sort()).toEqual(Array.from(expectedNames).sort());
	});

	it("Case 3: fixture registry honors expose.mcp off, and former ids before/after today", async () => {
		const today = new Date();
		const tomorrow = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
		const yesterday = new Date(today.getTime() - 86400000).toISOString().slice(0, 10);

		const fixtureRegistry = new ActionRegistry();

		const actionMcpOff = defineAction({
			id: "fixture_mcp_off",
			description: "MCP off description",
			schema: z.object({}),
			expose: {
				mcp: false,
				reason: "app_internal",
				note: "test",
			},
			run: async () => ({ success: true }),
		});

		const actionWithTomorrowFormerId = defineAction({
			id: "fixture_tomorrow_target",
			description: "Tomorrow target description",
			schema: z.object({ foo: z.string() }),
			formerIds: [
				{ id: "fixture_former_tomorrow", until: tomorrow },
			],
			run: async () => ({ success: true }),
		});

		const actionWithYesterdayFormerId = defineAction({
			id: "fixture_yesterday_target",
			description: "Yesterday target description",
			schema: z.object({ bar: z.string() }),
			formerIds: [
				{ id: "fixture_former_yesterday", until: yesterday },
			],
			run: async () => ({ success: true }),
		});

		fixtureRegistry.register(actionMcpOff);
		fixtureRegistry.register(actionWithTomorrowFormerId);
		fixtureRegistry.register(actionWithYesterdayFormerId);

		const server = createServer([], [], fixtureRegistry);
		const tools = await listTools(server);
		const toolNames = new Set(tools.map((t) => t.name));

		expect(toolNames.has("fixture_mcp_off")).toBe(false);
		expect(toolNames.has("fixture_tomorrow_target")).toBe(true);
		expect(toolNames.has("fixture_former_tomorrow")).toBe(true);

		const formerTool = tools.find((t) => t.name === "fixture_former_tomorrow")!;
		expect(formerTool.description).toBe("Deprecated, use fixture_tomorrow_target. Tomorrow target description");

		expect(toolNames.has("fixture_yesterday_target")).toBe(true);
		expect(toolNames.has("fixture_former_yesterday")).toBe(false);
	});

	it("Case 4: static check: server.ts contains no registerAction( call outside makeRegistrar's loop", () => {
		const serverTsPath = path.join(repoRoot, "packages/mcp-server/src/server.ts");
		const content = fs.readFileSync(serverTsPath, "utf-8");
		const lines = content.split("\n");

		const registerActionCalls: { line: number; text: string }[] = [];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (/\bregisterAction\s*\(/.test(line) && !/\bconst\s+registerAction\s*=/.test(line)) {
				registerActionCalls.push({ line: i + 1, text: line.trim() });
			}
		}

		expect(registerActionCalls.length).toBe(1);
	});
});
