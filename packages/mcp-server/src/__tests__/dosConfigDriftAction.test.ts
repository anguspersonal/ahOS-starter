import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AdapterUnavailableError, buildRegistry } from "@ahkms/core/actions";
import { serverAdapters } from "../actions/serverRegistry.js";
import { createServer } from "../server.js";
import { supabase } from "../supabase.js";
import { readLegacyBaseline } from "./legacyBaseline.js";

const DAILY_LOG_DB = "3499e609-fe01-8046-913a-d59df0ce9b9d";
const TASKS_DB = "1499e609-fe01-8046-913a-d59df0ce9b9d";

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function stubSupabase(opts: {
	dosConfig?: Record<string, unknown>;
	integrations?: Record<string, Record<string, unknown> | undefined>;
}) {
	(supabase as any).from = vi.fn((table: string) => {
		let provider = "";
		const b: any = {
			select: () => b,
			eq: (column: string, value: string) => {
				if (column === "provider") provider = value;
				return b;
			},
			maybeSingle: () => {
				if (table === "user_preferences") {
					return Promise.resolve({
						data: opts.dosConfig ? { dos_config: opts.dosConfig } : null,
						error: null,
					});
				}
				if (table === "user_integrations") {
					const config = opts.integrations?.[provider];
					return Promise.resolve(
						config ? { data: { config, enabled: true }, error: null } : { data: null, error: null },
					);
				}
				return Promise.resolve({ data: null, error: null });
			},
		};
		return b;
	});
}

async function withClient<T>(
	fn: (client: Client) => Promise<T>,
	registry = buildRegistry(serverAdapters()),
): Promise<T> {
	const server = createServer([], [], registry);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "dos-config-drift-action-test", version: "0.0.0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	try {
		return await fn(client);
	} finally {
		await client.close();
		await server.close();
	}
}

describe("dos_config_drift action parity (#1494)", () => {
	it("case 1: preserves MCP tool name, inputSchema, annotations, description, and output text", async () => {
		stubSupabase({
			dosConfig: {
				by_domain: {
					work: {
						topics: ["Apple", "Ops"],
						pillars: [],
						daily_log_schema: {
							properties: [{ name: "Other domains", notion_type: "multi_select", required: false }],
							body_sections: [],
						},
					},
				},
				types: [],
				tone: [],
			},
			integrations: {
				notion_work: {
					tasks_database_id: TASKS_DB,
					daily_log_database_id: DAILY_LOG_DB,
					property_map: { status: "Status" },
				},
			},
		});

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) => {
				const path = new URL(typeof url === "string" ? url : url.toString()).pathname;
				if (path === `/v1/databases/${DAILY_LOG_DB}`) {
					return {
						ok: true,
						status: 200,
						json: async () => ({
							id: DAILY_LOG_DB,
							properties: {
								"Other domains": {
									type: "multi_select",
									multi_select: { options: [{ name: "Apple" }, { name: "Ops" }] },
								},
							},
						}),
					};
				}
				if (path === `/v1/databases/${TASKS_DB}`) {
					return {
						ok: true,
						status: 200,
						json: async () => ({
							id: TASKS_DB,
							properties: {
								Status: { type: "status", status: { options: [{ name: "Done" }] } },
							},
						}),
					};
				}
				return { ok: false, status: 404, text: async () => "{}" };
			}),
		);

		await withClient(async (client) => {
			const { tools } = await client.listTools();
			const tool = tools.find((t) => t.name === "dos_config_drift");
			expect(tool).toBeDefined();

			const props = (tool!.inputSchema.properties ?? {}) as Record<string, any>;
			expect(Object.keys(props)).toEqual(["domain"]);
			expect(tool!.inputSchema.required ?? []).toEqual([]);
			expect(props.domain).toMatchObject({
				type: "string",
				enum: ["work", "angus"],
				description:
					"Which domain's config to reconcile against its live Notion Daily Log. Defaults to 'work'. Each domain is a different database in a different workspace behind a different token, and only that domain's own destination is read.",
			});
			expect(tool!.annotations).toMatchObject({
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			});
			expect(tool!.description).toBe(
				"Reconcile one domain's dos config against the live Notion Daily Log schema, AND its tasks " +
					"integration's property_map against the live Tasks DB, and report what cannot be written. Checks " +
					"config against Notion one way only: every configured value must exist in Notion, never the " +
					"reverse. Read-only \u2014 it edits neither side. Full notes: docs/guides/tools/dos_config_drift.md",
			);

			const res = await client.callTool({ name: "dos_config_drift", arguments: {} });
			expect(res.isError).toBeFalsy();
			const text = (res.content as Array<{ text: string }>)[0].text;
			expect(text).toContain(`config\u2194notion reconciliation \u2014 domain: work (Daily Log ${DAILY_LOG_DB})`);
			expect(text).toContain("verdict: ok \u2014 every configured value exists in Notion.");
			expect(text).toContain("verdict: ok \u2014 every mapped property exists on the tasks database.");
		});
	});

	it("case 2: exposes default surfaces in packages/core/action-manifest.json", () => {
		const manifestPath = resolve(import.meta.dirname, "../../../core/action-manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		expect(manifest.actions.dos_config_drift).toBeDefined();
		expect(manifest.actions.dos_config_drift.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
	});

	it("case 3: registers in buildRegistry, is absent from legacy-tools-baseline.txt, and throws AdapterUnavailableError when unwired", async () => {
		const registry = buildRegistry({});
		const action = registry.get("dos_config_drift");
		expect(action).toBeDefined();
		expect(registry.list().map((a) => a.id)).toContain("dos_config_drift");

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("dos_config_drift");

		await expect(
			action!.run({} as any, { caller: "test", requestId: "req-1" }),
		).rejects.toThrow(AdapterUnavailableError);
	});

	it("case 4: an unreachable Tasks database reports COULD NOT VERIFY and continues; an unreachable Daily Log reports the stop text", async () => {
		stubSupabase({
			dosConfig: {
				by_domain: {
					work: {
						topics: ["Apple", "Round"],
						pillars: [],
						daily_log_schema: {
							properties: [{ name: "Other domains", notion_type: "multi_select", required: false }],
							body_sections: [],
						},
					},
				},
				types: [],
				tone: [],
			},
			integrations: {
				notion_work: {
					tasks_database_id: TASKS_DB,
					daily_log_database_id: DAILY_LOG_DB,
					property_map: { owner: "Owner" },
				},
			},
		});

		// 4a: Daily Log reachable (with drift so ritual-continues text renders) + Tasks DB 404
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) => {
				const path = new URL(typeof url === "string" ? url : url.toString()).pathname;
				if (path === `/v1/databases/${DAILY_LOG_DB}`) {
					return {
						ok: true,
						status: 200,
						json: async () => ({
							id: DAILY_LOG_DB,
							properties: {
								"Other domains": {
									type: "multi_select",
									multi_select: { options: [{ name: "Apple" }] },
								},
							},
						}),
					};
				}
				return {
					ok: false,
					status: 404,
					statusText: "Not Found",
					text: async () => JSON.stringify({ code: "object_not_found", message: "Tasks DB unshared" }),
				};
			}),
		);

		await withClient(async (client) => {
			const res = await client.callTool({ name: "dos_config_drift", arguments: { domain: "work" } });
			expect(res.isError).toBeFalsy();
			const text = (res.content as Array<{ text: string }>)[0].text;
			expect(text).toContain("the ritual CONTINUES");
			expect(text).toContain(`tasks db\u2194property_map reconciliation \u2014 domain: work, provider: notion_work (Tasks DB ${TASKS_DB})`);
			expect(text).toContain("COULD NOT VERIFY");
			expect(text).toContain("task_create itself is unaffected");
		});

		// 4b: Daily Log 404 -> hard stop text
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: false,
				status: 404,
				statusText: "Not Found",
				text: async () => JSON.stringify({ code: "object_not_found", message: "Daily Log unshared" }),
			})),
		);

		await withClient(async (client) => {
			const res = await client.callTool({ name: "dos_config_drift", arguments: { domain: "work" } });
			expect(res.isError).toBe(true);
			const text = (res.content as Array<{ text: string }>)[0].text;
			expect(text).toContain(
				"Nothing was read, and the ritual must not proceed to a write it now knows will fail.",
			);
			expect(text).toContain("Connections \u2192 ahKMS");
		});
	});

	it("case 5: branches Notion status check on error.status (#1569) and never parses message text", async () => {
		stubSupabase({
			dosConfig: {
				by_domain: { work: { topics: [], pillars: [] } },
				types: [],
				tone: [],
			},
			integrations: {
				notion_work: {
					tasks_database_id: TASKS_DB,
					daily_log_database_id: DAILY_LOG_DB,
					property_map: {},
				},
			},
		});

		const baseAdapters = serverAdapters();

		// 5a: Error with status: 404 and NO '404' in message -> triggers hard stop
		const reg404 = buildRegistry({
			...baseAdapters,
			notion: {
				...baseAdapters.notion!,
				resolveToken: async () => "tok",
				retrieveDatabase: async () => {
					throw Object.assign(new Error("Database invisible to integration"), { status: 404 });
				},
			},
		});
		await withClient(async (client) => {
			const res = await client.callTool({ name: "dos_config_drift", arguments: { domain: "work" } });
			expect(res.isError).toBe(true);
			expect((res.content as Array<{ text: string }>)[0].text).toContain("Connections \u2192 ahKMS");
		}, reg404);

		// 5b: Error WITHOUT status=404 whose message contains '(404)' -> degrades to COULD NOT VERIFY
		const regMsgOnly = buildRegistry({
			...baseAdapters,
			notion: {
				...baseAdapters.notion!,
				resolveToken: async () => "tok",
				retrieveDatabase: async () => {
					throw new Error("Notion retrieve database failed (404): object_not_found");
				},
			},
		});
		await withClient(async (client) => {
			const res = await client.callTool({ name: "dos_config_drift", arguments: { domain: "work" } });
			expect(res.isError).toBeFalsy();
			const text = (res.content as Array<{ text: string }>)[0].text;
			expect(text).toContain("COULD NOT VERIFY");
		}, regMsgOnly);
	});
});
