import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../server.js";
import { serverRegistry } from "../../actions/serverRegistry.js";
import { supabase } from "../../supabase.js";
import { readLegacyBaseline } from "../legacyBaseline.js";

const require = createRequire(import.meta.url);
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

describe("communication_create migration (#1605)", () => {
	it("serves communication_create from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = require("@ahkms/core/action-manifest.json");
		expect(manifest.actions.communication_create?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("communication_create")).toBeDefined();
		expect(readLegacyBaseline()).not.toContain("communication_create");

		const client = await connectClient();
		const { tools } = await client.listTools();
		await client.close();

		const tool = tools.find((t) => t.name === "communication_create")!;
		expect(tool?.description).toBe(
			"Create or file a communication in the appropriate destination per domain and audience register " +
				"(Meetings database or Investor CRM; Daily Log body for private meetings in the 'angus' domain). " +
				"Mirrors task_create with lineage (artifact_id, kind='communication') and dedup guards (single_communication, dedup_key). " +
				"Refuses a private_meeting write to any public destination (ADR-053 §6 amendment).",
		);
		expect(tool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});

		const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string; type?: string; enum?: string[] }>;
		expect(Object.keys(props).sort()).toEqual([
			"artifact_id",
			"attendees",
			"audience",
			"body",
			"date",
			"date_property",
			"dedup_key",
			"destination",
			"domain",
			"external",
			"properties",
			"single_communication",
			"source",
			"source_url",
			"title",
			"type",
		]);
		expect(tool.inputSchema.required).toEqual(["domain", "title"]);
		expect(props.domain?.enum).toEqual(["work", "angus"]);
		expect(props.domain?.description).toBe(
			"Which workspace: 'work' or 'angus'. Required, no default \u2014 each is a separate Notion integration.",
		);
		expect(props.title?.description).toBe("Communication title or summary. Required and must not be blank.");
		expect(props.date?.description).toBe("Date (YYYY-MM-DD) or ISO datetime. Defaults to current date/time if omitted.");
		expect(props.audience?.description).toBe(
			"Audience register / spec, e.g. 'investor', 'team', 'advisor', 'bri', 'mitesh'. If 'investor', routes to Investor CRM; otherwise routes to Meetings DB.",
		);
		expect(props.destination?.enum).toEqual(["meetings", "investor_crm", "daily_log"]);
		expect(props.destination?.description).toBe(
			"Explicit destination override ('meetings', 'investor_crm', or 'daily_log'). If omitted, routes automatically by audience ('investor' -> investor_crm, others -> meetings).",
		);
		expect(props.source?.description).toBe(
			"Source of the communication, e.g. 'private_meeting', 'meeting', 'email', 'slack'. Note: 'private_meeting' may ONLY be routed to the Daily Log body in the 'angus' domain (ADR-053 §6 amendment).",
		);
		expect(props.body?.description).toBe("Communication notes or body as Markdown.");
		expect(props.artifact_id?.description).toBe("Lineage: source atom id (recorded under kind='communication').");
		expect(props.single_communication?.description).toBe(
			"Dedup: when true with artifact_id, skips creation if ANY kind='communication' link exists for this artifact in this workspace.",
		);
		expect(props.dedup_key?.description).toBe("Dedup: stable per-communication key for 1:N case.");
		expect(props.type?.description).toBe(
			"Communication / meeting type option, validated against schema if destination has a type role.",
		);
		expect(props.attendees?.description).toBe("Internal attendees as Notion user ids or exact display names.");
		expect(props.external?.description).toBe("External attendees as existing contact page ids or contact objects.");
		expect(props.source_url?.description).toBe("Link to the calendar event, message, or thread.");
		expect(props.date_property?.description).toBe(
			"Name the date property explicitly, for a destination with more than one.",
		);
		expect(props.properties?.description).toBe("Custom Notion properties matching destination schema.");

		expect(tools.find((t) => t.name === "create_communication")).toBeUndefined();
	});

	it("executes communication_create through MCP with byte-for-byte text parity", async () => {
		let dailyLogResults: Array<{ id: string; url?: string }> = [
			{ id: "daily-log-page-1", url: "https://notion.so/daily-log-page-1" },
		];
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "user_integrations") {
				let provider = "";
				const b: any = {
					select: () => b,
					eq: (col: string, val: string) => {
						if (col === "provider") provider = val;
						return b;
					},
					maybeSingle: async () => ({
						data: {
							config:
								provider === "notion_work"
									? {
											tasks_database_id: "db1",
											meetings_source_database_id: "hl-meetings-db",
											meetings_source_data_source_id: "hl-meetings-ds",
											investor_crm_database_id: "hl-investor-crm-db",
											investor_crm_data_source_id: "hl-investor-crm-ds",
										}
									: {
											tasks_database_id: "db-personal",
											meeting_notes_database_id: "angus-meetings-db",
											meeting_notes_data_source_id: "angus-meetings-ds",
											daily_log_database_id: "angus-daily-log-db",
											daily_log_data_source_id: "angus-daily-log-ds",
										},
							enabled: true,
						},
						error: null,
					}),
				};
				return b;
			}
			const empty: any = {
				select: () => empty,
				eq: () => empty,
				upsert: async () => ({ error: null }),
				then: (fn: any) => Promise.resolve({ data: [], error: null }).then(fn),
			};
			return empty;
		});

		const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
			const path = new URL(typeof url === "string" ? url : url.toString()).pathname;
			const ok = (p: unknown) =>
				({ ok: true, status: 200, json: async () => p, text: async () => JSON.stringify(p) }) as Response;
			const ds = /^\/v1\/data_sources\/([^/]+)$/.exec(path);
			if (ds) {
				return ok({ parent: { type: "database_id", database_id: decodeURIComponent(ds[1]).replace("-ds", "-db") } });
			}
			const db = /^\/v1\/databases\/([^/]+)$/.exec(path);
			if (db) {
				const id = decodeURIComponent(db[1]);
				return ok({
					properties:
						id === "angus-daily-log-db"
							? { Name: { type: "title" }, Date: { type: "date" } }
							: { Name: { type: "title" }, "Event time": { type: "date" } },
				});
			}
			if (path.endsWith("/query")) {
				return ok({ results: dailyLogResults, has_more: false, next_cursor: null });
			}
			if (path === "/v1/pages" && (init.method ?? "GET") === "POST") {
				return ok({ id: "page-created-123", url: "https://notion.so/page-created-123" });
			}
			return ok({ results: [] });
		});
		vi.stubGlobal("fetch", fetchMock);

		const client = await connectClient();

		const created = await client.callTool({
			name: "communication_create",
			arguments: {
				domain: "work",
				title: "Q3 Update Call",
				audience: "investor",
				body: "Spoke with VC partners.",
			},
		});
		expect(((created.content as any)[0] as any).text).toBe(
			"Created communication 'Q3 Update Call' in 'work' (investor_crm): page-created-123\nhttps://notion.so/page-created-123",
		);

		const appended = await client.callTool({
			name: "communication_create",
			arguments: {
				domain: "angus",
				title: "Confidential 1:1",
				source: "private_meeting",
				date: "2026-09-26",
				body: "Notes.",
			},
		});
		expect(((appended.content as any)[0] as any).text).toBe(
			"Appended communication 'Confidential 1:1' to Daily Log in 'angus': daily-log-page-1\nhttps://notion.so/daily-log-page-1",
		);

		dailyLogResults = [];
		const missingDailyLog = await client.callTool({
			name: "communication_create",
			arguments: {
				domain: "angus",
				title: "Evening Thoughts",
				destination: "daily_log",
				date: "2026-09-26",
			},
		});
		expect(missingDailyLog.isError).toBe(true);
		expect(((missingDailyLog.content as any)[0] as any).text).toContain(
			"no Daily Log entry for 2026-09-26 in 'angus'; only the dos ritual creates Daily Log entries (#1139); run dos or pass a date that has an entry",
		);

		fetchMock.mockClear();
		const refusedPrivate = await client.callTool({
			name: "communication_create",
			arguments: {
				domain: "work",
				title: "Private Catch-up",
				source: "private_meeting",
			},
		});
		expect(refusedPrivate.isError).toBe(true);
		expect(((refusedPrivate.content as any)[0] as any).text).toContain(
			"Communications from a private meeting may only be written to the Daily Log body in the 'angus' domain (ADR-053 §6 amendment). Never the State Doc, never the Team, Investor or Advisor projections, never the Work Meetings DB.",
		);
		expect(fetchMock).not.toHaveBeenCalled();

		await client.close();
	});
});
