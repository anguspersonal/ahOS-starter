import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../server.js";
import { serverRegistry } from "../../actions/serverRegistry.js";
import { supabase } from "../../supabase.js";
import { readLegacyBaseline } from "../legacyBaseline.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function connectClient() {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

describe("contact_create migration (#1577)", () => {
	it("serves contact_create from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = JSON.parse(readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"));
		expect(manifest.actions.contact_create?.expose).toEqual({ mcp: true, http: true, ui_agent: true, worker: true, cli: false, a2a: false });
		expect(serverRegistry().get("contact_create")).toBeDefined();
		expect(readLegacyBaseline()).not.toContain("contact_create");

		const client = await connectClient();
		const { tools } = await client.listTools();
		await client.close();
		const tool = tools.find((t) => t.name === "contact_create")!;
		expect(tool?.description).toBe(
			"Create a contact in either workspace, or return the existing one. Deduplicates on email first and exact name second, so calling it twice writes once — which is what makes it safe for meeting_create to call per external attendee.",
		);
		expect(tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
		const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
		expect(Object.keys(props).sort()).toEqual(["company", "contact_type", "domain", "email", "name", "role"]);
		expect(tool.inputSchema.required).toEqual(["domain", "name"]);
		expect(props.domain?.description).toContain("Which workspace: 'work' (Contacts) or 'angus' (People).");
		expect(props.name?.description).toBe("The contact's full name. Used as the page title, and as the dedup key when no email is given.");
		expect(props.email?.description).toContain("Email address. The primary dedup key:");
		expect(props.company?.description).toBe("Company or organisation.");
		expect(props.role?.description).toBe("Job title or role.");
		expect(props.contact_type?.description).toContain("Validated against the destination's own options before anything is written");
	});

	it("executes contact_create through MCP with byte-for-byte text parity", async () => {
		const b: any = {
			select: () => b,
			eq: () => b,
			maybeSingle: async () => ({ data: { config: { tasks_database_id: "db1", contacts_data_source_id: "2b09e609-fe01-8169-a3ae-000b07763b87" }, enabled: true }, error: null }),
		};
		(supabase as any).from = vi.fn(() => b);
		const rows: Array<{ id: string; properties: Record<string, unknown> }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL, init: RequestInit = {}) => {
				const path = new URL(typeof url === "string" ? url : url.toString()).pathname;
				const ok = (p: unknown) => ({ ok: true, status: 200, json: async () => p, text: async () => JSON.stringify(p) }) as Response;
				if (path.endsWith("/query")) return ok({ results: rows, has_more: false, next_cursor: null });
				if (path.startsWith("/v1/data_sources/")) return ok({ parent: { type: "database_id", database_id: "2b09e609-fe01-81b5-a2c3-ff2d2e81e712" } });
				if (path.startsWith("/v1/databases/")) return ok({ properties: { Name: { type: "title" }, Email: { type: "email" } } });
				rows.push({ id: "new-page-id", properties: { Name: { title: [{ plain_text: "Ada Lovelace" }] }, Email: { email: "ada@example.com" } } });
				return ok({ id: "new-page-id", url: "https://notion.so/new-page-id" });
			}),
		);

		const client = await connectClient();
		const args = { domain: "work", name: "Ada Lovelace", email: "ada@example.com" };
		const created = await client.callTool({ name: "contact_create", arguments: args });
		expect(((created.content as any)[0] as any).text).toBe("Created contact 'Ada Lovelace' in 'work': new-page-id\nhttps://notion.so/new-page-id");
		const dup = await client.callTool({ name: "contact_create", arguments: args });
		expect(((dup.content as any)[0] as any).text).toBe(
			"Contact 'Ada Lovelace' already exists in 'work' — returning it, nothing was written: new-page-id\nhttps://www.notion.so/newpageid",
		);
		await client.close();
	});
});
