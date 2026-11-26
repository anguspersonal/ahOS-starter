import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../server.js";
import { serverRegistry } from "../../actions/serverRegistry.js";
import { readLegacyBaseline } from "../legacyBaseline.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function connectClient() {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return { client, server };
}

describe("notion_user_list migration (#1570)", () => {
	it("serves notion_user_list from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = JSON.parse(readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"));
		expect(manifest.actions.notion_user_list?.expose).toEqual({ mcp: true, http: true, ui_agent: true, worker: true, cli: false, a2a: false });
		expect(serverRegistry().get("notion_user_list")).toBeDefined();
		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("notion_user_list");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();
		const tool = tools.find((t) => t.name === "notion_user_list")!;
		expect(tool?.description).toBe(
			"List the people and bots in one Notion workspace with their ids, for filling a person-typed property. Read these rather than reusing an id from a skill body: a stale id assigns real work to nobody, and says nothing when it does.",
		);
		expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
		const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
		expect(Object.keys(props).sort()).toEqual(["domain"]);
		expect(tool.inputSchema.required).toEqual(["domain"]);
		expect(props.domain?.description).toContain("Which workspace: 'work' (work) or 'angus' (personal).");
	});

	it("executes notion_user_list through MCP with byte-for-byte text parity", async () => {
		const payload = {
			results: [
				{ id: "bot-1", name: "ahKMS", type: "bot" },
				{ id: "user-2", name: "Briana", type: "person", person: { email: "briana@example.com" } },
				{ id: "user-1", name: "Angus", type: "person", person: { email: "owner@example.com" } },
			],
			has_more: false,
			next_cursor: null,
		};
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, statusText: "OK", json: async () => payload, text: async () => JSON.stringify(payload) } as Response)));
		const { client } = await connectClient();
		const out = await client.callTool({ name: "notion_user_list", arguments: { domain: "work" } });
		await client.close();
		expect(out.isError).toBeFalsy();
		expect(((out.content as any)[0] as any).text).toBe(
			"Notion users (work), 3 total:\n  Angus — person <owner@example.com> — user-1\n  Briana — person <briana@example.com> — user-2\n  ahKMS — bot — bot-1",
		);
	});
});
