import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildRegistry } from "@ahkms/core/actions";
import { createServer } from "../server.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { supabase } from "../supabase.js";
import { readLegacyBaseline } from "./legacyBaseline.js";

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

function stubSupabase(dosConfig: Record<string, unknown>, twinRows: Array<{ external_id: string }> = []) {
	(supabase as any).from = (table: string) => {
		if (table === "artifact_external_links") {
			const a: any = {
				select: () => a,
				eq: () => a,
				in: async () => ({ data: twinRows, error: null }),
			};
			return a;
		}
		if (table === "user_preferences") {
			const p: any = {
				select: () => p,
				eq: () => p,
				maybeSingle: async () => ({ data: { dos_config: dosConfig }, error: null }),
			};
			return p;
		}
		let provider = "";
		const b: any = {
			select: () => b,
			eq: (col: string, val: string) => {
				if (col === "provider") provider = val;
				return b;
			},
			maybeSingle: async () =>
				provider === "notion_work"
					? {
							data: {
								enabled: true,
								config: {
									token: "ntn_work",
									tasks_database_id: "db1",
									daily_log_database_id: "db-work",
									daily_log_data_source_id: "ds-work",
								},
							},
							error: null,
						}
					: { data: null, error: null },
		};
		return b;
	};
}

const WORK_DOS_CONFIG = {
	by_domain: {
		work: {
			daily_log_schema: {
				properties: [
					{ name: "Name", notion_type: "title", required: true },
					{ name: "Date", notion_type: "date", required: true },
					{ name: "Covers", notion_type: "multi_select", required: false, role: "covers" },
					{ name: "Summary", notion_type: "rich_text", required: true },
				],
			},
		},
	},
};

function stubNotionFetch(queryResults: Array<{ id: string; properties?: Record<string, unknown> }> = []) {
	const pageWrites: unknown[] = [];
	const fetchMock = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
		const url = typeof input === "string" ? input : input.toString();
		const path = new URL(url).pathname;
		const method = init.method ?? "GET";
		const ok = (body: unknown) =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		if (path.startsWith("/v1/databases/") && method === "GET") {
			return ok({
				id: "db-work",
				properties: {
					Name: { type: "title" },
					Date: { type: "date" },
					Covers: {
						type: "multi_select",
						multi_select: { options: [{ name: "2026-08-21" }, { name: "2026-08-22" }] },
					},
					Summary: { type: "rich_text" },
				},
			});
		}
		if (path.endsWith("/query") && method === "POST") {
			return ok({ results: queryResults, has_more: false, next_cursor: null });
		}
		if (path === "/v1/pages" && method === "POST") {
			const parsed = init.body ? JSON.parse(String(init.body)) : {};
			pageWrites.push(parsed);
			return ok({ id: "page-new-1", url: "https://www.notion.so/page-new-1" });
		}
		return ok({ results: [] });
	});
	vi.stubGlobal("fetch", fetchMock);
	return { fetchMock, pageWrites };
}

describe("daily_log_create core action surface & guards (#1503)", () => {
	it("1-3. exposes daily_log_create from core buildRegistry with exact MCP contract, default expose, and no legacy baseline entry", async () => {
		// Case 2: exposure in action-manifest.json
		const manifest = require("@ahkms/core/action-manifest.json");
		expect(manifest.actions.daily_log_create?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});

		// Case 3: registration path in buildRegistry() and absent from legacy-tools-baseline.txt
		expect(buildRegistry({}).list().map((a) => a.id)).toContain("daily_log_create");
		expect(serverRegistry().get("daily_log_create")).toBeDefined();
		expect(readLegacyBaseline()).not.toContain("daily_log_create");

		// Case 1: contract parity on tools/list and MCP output text on write
		const client = await connectClient();
		const { tools } = await client.listTools();
		const tool = tools.find((t) => t.name === "daily_log_create")!;
		expect(tool).toBeDefined();
		expect(tool.description).toBe(
			"The dos ritual's Daily Log writer: ONE entry per domain per covered day, holding those days against " +
				"the ritual. Not for session notes or working logs; record those with capture. `domain` " +
				"('work' or 'angus') is required with no default, and so are `date` and `title`. Full notes: " +
				"docs/guides/tools/daily_log_create.md",
		);
		expect(tool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});

		const props = (tool.inputSchema.properties ?? {}) as Record<
			string,
			{ description?: string; type?: string; enum?: string[] }
		>;
		expect(Object.keys(props).sort()).toEqual([
			"allow_duplicate",
			"body",
			"covers",
			"date",
			"date_property",
			"domain",
			"pillars",
			"properties",
			"title",
			"write_twin",
		]);
		expect(tool.inputSchema.required).toBeUndefined();
		expect(props.domain?.enum).toEqual(["work", "angus"]);
		expect(props.date?.type).toBe("string");
		expect(props.covers?.type).toBe("array");
		expect(props.pillars?.type).toBe("array");
		expect(props.title?.type).toBe("string");
		expect(props.body?.type).toBe("string");
		expect(props.properties?.type).toBe("object");
		expect(props.date_property?.type).toBe("string");
		expect(props.allow_duplicate?.type).toBe("boolean");
		// #2258 case 12: optional, boolean, off unless asked for. An old caller that omits
		// it is not refused (`required` stays undefined above).
		expect(props.write_twin?.type).toBe("boolean");
		expect((props.write_twin as { default?: unknown }).default).toBe(false);
		const manifestWriteTwin = manifest.actions.daily_log_create.input_schema.properties.write_twin;
		expect(manifestWriteTwin).toMatchObject({ type: "boolean", default: false });
		expect(manifest.actions.daily_log_create.input_schema.required ?? []).not.toContain("write_twin");

		stubSupabase(WORK_DOS_CONFIG);
		stubNotionFetch();
		const written = await client.callTool({
			name: "daily_log_create",
			arguments: {
				domain: "work",
				date: "2026-08-21",
				title: "Ritual Close",
				body: "Closed atoms.",
				properties: {
					Summary: { rich_text: [{ text: { content: "Closed." } }] },
				},
			},
		});
		expect(written.isError).toBeFalsy();
		const text = ((written.content as any)[0] as any).text as string;
		expect(text).toBe(
			[
				"Daily Log entry created (work): Ritual Close",
				"  page_id: page-new-1",
				"  page_url: https://www.notion.so/page-new-1",
				"  provider: notion_work",
				"  blocks written: 1",
				"  covers: 2026-08-21",
				"Consumption markers, dos ritual only: stamp each narrative atom this entry synthesised with external_link_create, provider 'notion_work', kind 'synthesized' (attended, requires ritual run_id) or 'synthesized_unattended' (#561 sweep only), external_id page-new-1, and when dos_evidence_aggregate had material_total > 0 stamp one twin-level link on the Daily Log twin artifact_id with kind 'evidence_aggregated' (attended, requires ritual run_id) or 'evidence_aggregated_unattended' (#561 sweep only). One marker closes the whole day for the sweep, so any other caller must stamp none.",
			].join("\n"),
		);
		await client.close();
	});

	it("4. refuses missing #1139 required property from dos_config.daily_log_schema without writing to Notion", async () => {
		stubSupabase(WORK_DOS_CONFIG);
		const { pageWrites } = stubNotionFetch();
		const client = await connectClient();

		const res = await client.callTool({
			name: "daily_log_create",
			arguments: {
				domain: "work",
				date: "2026-08-21",
				title: "Ad-hoc Note",
			},
		});

		expect(res.isError).toBe(true);
		expect(((res.content as any)[0] as any).text).toContain(
			"Domain 'work' Daily Log write refused: missing required property 'Summary' (declared required: true in dos_config.daily_log_schema). Provide 'Summary' in properties (#1139).",
		);
		expect(pageWrites).toHaveLength(0);
		await client.close();
	});

	it("5. refuses write when an entry already covers one of covers unless allow_duplicate: true", async () => {
		stubSupabase(WORK_DOS_CONFIG, [{ external_id: "existing-log-1" }]);
		const { pageWrites } = stubNotionFetch([
			{
				id: "existing-log-1",
				properties: {
					Covers: { type: "multi_select", multi_select: [{ name: "2026-08-21" }] },
				},
			},
		]);
		const client = await connectClient();

		const baseArgs = {
			domain: "work",
			date: "2026-08-22",
			covers: ["2026-08-21", "2026-08-22"],
			title: "Catchup Run",
			properties: {
				Summary: { rich_text: [{ text: { content: "Catchup." } }] },
			},
		};

		const refused = await client.callTool({
			name: "daily_log_create",
			arguments: baseArgs,
		});
		expect(refused.isError).toBe(true);
		const refusalText = ((refused.content as any)[0] as any).text as string;
		expect(refusalText).toContain("Domain 'work': an existing Daily Log entry already covers 2026-08-21 (existing-log-1). Nothing was written.");
		expect(refusalText).toContain("twin_present: true");
		expect(pageWrites).toHaveLength(0);

		const allowed = await client.callTool({
			name: "daily_log_create",
			arguments: { ...baseArgs, allow_duplicate: true },
		});
		expect(allowed.isError).toBeFalsy();
		expect(pageWrites).toHaveLength(1);
		await client.close();
	});

	it("6. write_twin: true reaches capture, the pointer writer and the archive port through buildRegistry (#2258)", async () => {
		const calls: string[] = [];
		const capture = vi.fn(async () => {
			calls.push("capture");
			return { id: "twin-1", deduplicated: false };
		});
		const recordExternalLink = vi.fn(async () => {
			calls.push("pointer");
			return { ok: false, error: "links down" };
		});
		const mutateByIds = vi.fn(async () => {
			calls.push("archive");
			return [{ id: "twin-1", title: "Ritual Close" }];
		});
		const notion = {
			resolveToken: vi.fn().mockResolvedValue("ntn_fake"),
			retrieveDatabase: vi.fn().mockResolvedValue({
				id: "db-work",
				properties: { Name: { type: "title" }, Date: { type: "date" }, Summary: { type: "rich_text" } },
			}),
			queryDataSource: vi.fn().mockResolvedValue({ results: [], has_more: false, next_cursor: null }),
			createPage: vi.fn(async () => {
				calls.push("page");
				return { id: "page-new-1", url: "https://www.notion.so/page-new-1" };
			}),
			appendBlockChildren: vi.fn().mockResolvedValue({ results: [] }),
		};
		const config = {
			loadConfigDetailed: vi.fn(async (_provider: string, schema: { parse(v: unknown): unknown }) => ({
				status: "ok" as const,
				data: schema.parse({
					tasks_database_id: "db1",
					daily_log_database_id: "db-work",
					daily_log_data_source_id: "ds-work",
				}),
			})),
			loadDosConfigRow: vi.fn().mockResolvedValue(WORK_DOS_CONFIG),
		};
		const registry = buildRegistry({
			notion,
			config,
			artifacts: { capture },
			externalLinks: { recordExternalLink },
			artifactRepository: { mutateByIds },
		} as unknown as Parameters<typeof buildRegistry>[0]);
		const action = registry.get("daily_log_create")!;
		const args = {
			domain: "work",
			date: "2026-08-21",
			title: "Ritual Close",
			body: "Closed atoms.",
			properties: { Summary: { rich_text: [{ text: { content: "Closed." } }] } },
		};

		const out = (await action.run({ ...args, write_twin: true }, { caller: "mcp", userId: "user-1", requestId: "req-2258" })) as {
			id: string;
			text: string;
		};

		expect(calls).toEqual(["page", "capture", "pointer", "pointer", "archive"]);
		expect(capture).toHaveBeenCalledWith(
			expect.objectContaining({ content_subtype: "daily_log", captured_at: "2026-08-21", surface: "dos" }),
			"user-1",
		);
		expect(recordExternalLink).toHaveBeenCalledWith(
			"twin-1",
			expect.objectContaining({ kind: "daily_log", provider: "notion_work", external_id: "page-new-1" }),
		);
		expect(mutateByIds.mock.calls[0].slice(0, 2)).toEqual([["twin-1"], true]);
		expect(out.id).toBe("page-new-1");
		expect(out.text).toContain("twin: MISSING");
		expect(out.text).toContain("was archived (reversible)");

		// The old-skill call through the same wiring touches none of the three.
		calls.length = 0;
		await action.run(args, { caller: "mcp", userId: "user-1", requestId: "req-2258" });
		expect(calls).toEqual(["page"]);
	});
});
