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

describe("meeting_create migration (#1469)", () => {
	it("serves meeting_create from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = JSON.parse(readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"));
		expect(manifest.actions.meeting_create?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("meeting_create")).toBeDefined();
		expect(readLegacyBaseline()).not.toContain("meeting_create");

		const client = await connectClient();
		const { tools } = await client.listTools();
		await client.close();
		const tool = tools.find((t) => t.name === "meeting_create")!;
		expect(tool?.description).toBe(
			"File a meeting in either workspace with its time, type, internal attendees and external contacts. Every convention is checked against the live database schema first: an unknown Type option, an unresolvable attendee name, or a value the database has nowhere to put all fail before anything is written.",
		);
		expect(tool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
		expect(Object.keys(props).sort()).toEqual([
			"attendees",
			"body",
			"date_property",
			"domain",
			"end",
			"external",
			"source_url",
			"start",
			"title",
			"type",
		]);
		expect(tool.inputSchema.required).toEqual(["domain", "title", "start"]);
		expect(props.domain?.description).toContain(
			"Which workspace: 'work' (Meetings) or 'angus' (Meeting Notes).",
		);
		expect(props.title?.description).toBe("Meeting title. Sentence case, descriptive and concise.");
		expect(props.start?.description).toContain("Start as an ISO 8601 datetime");
		expect(props.end?.description).toBe("End as an ISO 8601 datetime. Written as the date property's end.");
		expect(props.type?.description).toContain("Validated against the destination's own Type options");
		expect(props.attendees?.description).toContain("Internal attendees, as Notion user ids or exact display names.");
		expect(props.external?.description).toContain("External attendees, as existing contact page ids or objects");
		expect(props.body?.description).toContain("Meeting notes as Markdown");
		expect(props.source_url?.description).toBe("Link to the calendar event or call.");
		expect(props.date_property?.description).toBe(
			"Name the date property explicitly, for a database with more than one.",
		);
	});

	it("executes meeting_create through MCP with byte-for-byte text parity", async () => {
		const b: any = {
			select: () => b,
			eq: () => b,
			maybeSingle: async () => ({
				data: {
					config: {
						tasks_database_id: "db1",
						meetings_source_data_source_id: "ad82bbfd-203a-4d78-8676-33e6edd711dd",
						contacts_data_source_id: "2b09e609-fe01-8169-a3ae-000b07763b87",
					},
					enabled: true,
				},
				error: null,
			}),
		};
		(supabase as any).from = vi.fn(() => b);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) => {
				const path = new URL(typeof url === "string" ? url : url.toString()).pathname;
				const ok = (p: unknown) =>
					({ ok: true, status: 200, json: async () => p, text: async () => JSON.stringify(p) }) as Response;
				if (path.startsWith("/v1/data_sources/")) {
					return ok({ parent: { type: "database_id", database_id: "dea2a239-ff82-49c8-bacb-4ea1179ed925" } });
				}
				if (path.startsWith("/v1/databases/")) {
					return ok({
						properties: {
							Name: { type: "title" },
							"Event time": { type: "date" },
							Type: { type: "select", select: { options: [{ name: "General" }] } },
							Attendees: { type: "people" },
						},
					});
				}
				if (path === "/v1/users") {
					return ok({
						results: [{ id: "aaaaaaaa-1111-2222-3333-444444444444", name: "Angus Hally", type: "person" }],
						has_more: false,
						next_cursor: null,
					});
				}
				return ok({ id: "new-page-id", url: "https://notion.so/new-page-id" });
			}),
		);

		const client = await connectClient();
		const created = await client.callTool({
			name: "meeting_create",
			arguments: {
				domain: "work",
				title: "Google call",
				start: "2026-09-15T10:15:00+01:00",
				type: "General",
				attendees: ["Angus Hally"],
			},
		});
		expect(((created.content as any)[0] as any).text).toBe(
			"Created meeting 'Google call' in 'work': new-page-id\nhttps://notion.so/new-page-id",
		);
		await client.close();
	});
});
