import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { executeAction } from "@ahkms/core";
import { supabase } from "../supabase.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { createServer } from "../server.js";

const createDailyLogEntryHandler = async (args: Record<string, unknown>) => {
	const action = serverRegistry().get("daily_log_create")!;
	const out = await executeAction(action, args as any, {
		auditSink: () => {},
		context: { caller: "mcp" },
	});
	return { content: [{ type: "text" as const, text: action.formatMcp!(out) }] };
};

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/**
 * Stub loadIntegrationConfig's query: from('user_integrations')…eq('provider', …)…
 * maybeSingle(). Provider-aware, because the two domains resolve two different rows and
 * a stub that ignored the provider would pass while the tool read the wrong workspace.
 */
function stubIntegrations(
	rows: Record<string, Record<string, unknown> | undefined>,
	dosConfig?: Record<string, unknown>,
	twinPageIds: string[] = [],
	twinQueryError = false,
) {
	(supabase as any).from = vi.fn((table: string) => {
		if (table === "artifact_external_links") {
			const a: any = {
				select: () => a,
				eq: () => a,
				in: (_column: string, values: string[]) => {
					if (twinQueryError) {
						return Promise.resolve({ data: null, error: { message: "boom" } });
					}
					const matches = values.filter((id) => twinPageIds.includes(id));
					return Promise.resolve({
						data: matches.map((id) => ({ external_id: id })),
						error: null,
					});
				},
			};
			return a;
		}
		if (table === "user_preferences") {
			const p: any = {
				select: () => p,
				eq: () => p,
				maybeSingle: () =>
					Promise.resolve({ data: dosConfig ? { dos_config: dosConfig } : null, error: null }),
			};
			return p;
		}
		let provider = "";
		const b: any = {
			select: () => b,
			eq: (column: string, value: string) => {
				if (column === "provider") provider = value;
				return b;
			},
			maybeSingle: () => {
				const config = rows[provider];
				return Promise.resolve(
					config ? { data: { config, enabled: true }, error: null } : { data: null, error: null },
				);
			},
		};
		return b;
	});
}

// Set by vitest.config.ts, one per workspace. The whole point of the domain axis is
// that these two never cross.
const WORK_TOKEN = "Bearer secret_test_token";
const ANGUS_TOKEN = "Bearer secret_personal_test_token";

const ANGUS_DB = "35ab7b8b-edcd-811a-a3bc-e37d4ced1d87";
const ANGUS_DS = "35ab7b8b-edcd-8179-b15d-000b26ea11fd";
const WORK_DB = "hl-daily-log-db";

const ANGUS_ROW = {
	tasks_database_id: "db-personal",
	daily_log_database_id: ANGUS_DB,
	daily_log_data_source_id: ANGUS_DS,
};
const WORK_ROW = {
	tasks_database_id: "db1",
	daily_log_database_id: WORK_DB,
	daily_log_data_source_id: "hl-ds",
};

/**
 * The personal Daily Log's real schema, read live 2026-08-21 and updated the same day
 * for #692: the five pillar checkbox properties were replaced by one `Pillars`
 * multi-select carrying their names as options, so `Reflection included` is now the
 * only checkbox on the database.
 */
const PERSONAL_SCHEMA = {
	Name: { type: "title" },
	Date: { type: "date" },
	Type: { type: "select", select: { options: [] } },
	Summary: { type: "rich_text" },
	Pillars: {
		type: "multi_select",
		multi_select: {
			options: [
				{ name: "P1 Laura" },
				{ name: "P2 Friends and Family" },
				{ name: "P3 Health and Fitness" },
				{ name: "P4 Home and Admin" },
				{ name: "P5 Finances" },
			],
		},
	},
	"Other domains": { type: "multi_select", multi_select: { options: [] } },
	"Artefacts generated": { type: "multi_select", multi_select: { options: [] } },
	"Reflection included": { type: "checkbox" },
};

type Call = { method: string; url: string; body?: any; auth?: string };

type NotionStub = {
	/** Property schema returned by GET /v1/databases/{id}, keyed by database id. */
	schemas?: Record<string, Record<string, unknown>>;
	/** Rows the duplicate-guard query returns, keyed by data source id. */
	queryResults?: Record<string, { id: string; properties?: Record<string, unknown> }[]>;
	/** Database ids that 404 on every call (the "not shared with ahKMS" case). */
	notFound?: string[];
	/** Make the block-append call fail, to exercise the truncated-body warning. */
	failAppend?: boolean;
};

function fakeNotion(stub: NotionStub): { calls: Call[] } {
	const calls: Call[] = [];

	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit = {}) => {
			const method = init.method ?? "GET";
			const body = init.body ? JSON.parse(init.body as string) : undefined;
			const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
			calls.push({ method, url, body, auth });

			const path = new URL(url).pathname;

			const notFound = (id: string) => ({
				ok: false,
				status: 404,
				statusText: "Not Found",
				text: async () =>
					JSON.stringify({
						object: "error",
						code: "object_not_found",
						message: `Could not find database with ID: ${id}. Make sure the relevant pages and databases are shared with your integration.`,
					}),
			});
			const ok = (payload: unknown) => ({
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => payload,
				text: async () => JSON.stringify(payload),
			});

			const db = /^\/v1\/databases\/([^/]+)$/.exec(path);
			if (db) {
				const id = decodeURIComponent(db[1]);
				if (stub.notFound?.includes(id)) return notFound(id);
				return ok({ properties: stub.schemas?.[id] ?? PERSONAL_SCHEMA });
			}

			const query = /^\/v1\/data_sources\/([^/]+)\/query$/.exec(path);
			if (query) {
				const id = decodeURIComponent(query[1]);
				if (stub.notFound?.includes(id)) return notFound(id);
				return ok({ results: stub.queryResults?.[id] ?? [], has_more: false, next_cursor: null });
			}

			if (path === "/v1/pages" && method === "POST") {
				const parent = body?.parent?.database_id;
				if (stub.notFound?.includes(parent)) return notFound(parent);
				return ok({ id: "page-created", url: "https://notion.so/page-created" });
			}

			if (/^\/v1\/blocks\/[^/]+\/children$/.test(path) && method === "PATCH") {
				if (stub.failAppend) {
					return {
						ok: false,
						status: 400,
						statusText: "Bad Request",
						text: async () => JSON.stringify({ message: "too many blocks" }),
					};
				}
				return ok({ results: [] });
			}

			throw new Error(`fakeNotion: unexpected ${method} ${path}`);
		}),
	);

	return { calls };
}

const GOOD_ARGS = { domain: "angus" as const, date: "2026-08-21", title: "Thu 21 Aug 2026" };

describe("daily_log_create — required arguments", () => {
	it("names the two destinations when `domain` is omitted, rather than defaulting to one", async () => {
		await expect(createDailyLogEntryHandler({ date: "2026-08-21", title: "x" })).rejects.toThrow(
			/`domain` is required/,
		);
	});

	it("lets an OMITTED domain reach the handler's own error through the MCP boundary", async () => {
		const server = createServer();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		const result = await client.callTool({
			name: "daily_log_create",
			arguments: { date: "2026-08-21", title: "x" },
		});

		expect(result.isError).toBe(true);
		const text = (result.content as { type: "text"; text: string }[])[0].text;
		// The explanatory message, NOT the SDK's generic "Required" — that is the whole
		// reason `domain` is `.optional()` at the zod layer.
		expect(text).toMatch(/`domain` is required/);
		expect(text).toMatch(/different token/);

		await client.close();
		await server.close();
	});

	it("still rejects a WRONG domain at the schema layer", async () => {
		const server = createServer();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		const result = await client.callTool({
			name: "daily_log_create",
			arguments: { domain: "infra", date: "2026-08-21", title: "x" },
		});

		expect(result.isError).toBe(true);
		const text = (result.content as { type: "text"; text: string }[])[0].text;
		expect(text).not.toMatch(/`domain` is required/);

		await client.close();
		await server.close();
	});

	it("refuses to invent a date", async () => {
		await expect(
			createDailyLogEntryHandler({ domain: "angus", title: "x" }),
		).rejects.toThrow(/`date` is required/);
		await expect(
			createDailyLogEntryHandler({ domain: "angus", title: "x", date: "21 Aug 2026" }),
		).rejects.toThrow(/must be YYYY-MM-DD/);
	});
});

describe("daily_log_create — destination resolution", () => {
	it("fails loudly on an unwired domain, naming the exact integration_set call", async () => {
		stubIntegrations({ notion_personal: { tasks_database_id: "db-personal" } });
		fakeNotion({});

		await expect(createDailyLogEntryHandler(GOOD_ARGS)).rejects.toThrow(
			/No daily_log_database_id for domain 'angus'/,
		);
		await expect(createDailyLogEntryHandler(GOOD_ARGS)).rejects.toThrow(
			/integration_set\(\{ provider: 'notion_personal'/,
		);
	});

	it("reports a configured-but-unshared destination as a sharing problem, not an unconfigured one", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW });
		fakeNotion({ notFound: [ANGUS_DB] });

		const err = await createDailyLogEntryHandler(GOOD_ARGS).catch((e: Error) => e);
		expect(String(err)).toMatch(/IS configured/);
		expect(String(err)).toMatch(/Connections → ahKMS/);
		expect(String(err)).toMatch(/#655/);
		expect(String(err)).not.toMatch(/No daily_log_database_id/);
	});

	it("authenticates the angus write with the PERSONAL token and the work one with the work token", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW, notion_work: WORK_ROW });

		const personal = fakeNotion({});
		await createDailyLogEntryHandler(GOOD_ARGS);
		expect(personal.calls.length).toBeGreaterThan(0);
		expect(personal.calls.every((c) => c.auth === ANGUS_TOKEN)).toBe(true);
		vi.unstubAllGlobals();

		const work = fakeNotion({ schemas: { [WORK_DB]: PERSONAL_SCHEMA } });
		await createDailyLogEntryHandler({ ...GOOD_ARGS, domain: "work" });
		expect(work.calls.length).toBeGreaterThan(0);
		expect(work.calls.every((c) => c.auth === WORK_TOKEN)).toBe(true);
	});
});

describe("daily_log_create — the write", () => {
	it("posts parent:{database_id} with the discovered title and date properties", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW });
		const { calls } = fakeNotion({});

		const out = await createDailyLogEntryHandler(GOOD_ARGS);

		const create = calls.find((c) => c.url.endsWith("/v1/pages"));
		expect(create?.body.parent).toEqual({ database_id: ANGUS_DB });
		expect(create?.body.properties.Name).toEqual({
			title: [{ text: { content: "Thu 21 Aug 2026" } }],
		});
		// Discovered, not assumed: the tool is never told the property is called "Date".
		expect(create?.body.properties.Date).toEqual({ date: { start: "2026-08-21" } });

		const text = out.content[0].text;
		expect(text).toMatch(/page_id: page-created/);
		expect(text).toMatch(/page_url: https:\/\/notion.so\/page-created/);
		// Returned so the Step 9 marker is stamped with the provider this write actually
		// authenticated as, rather than a literal the caller guessed.
		expect(text).toMatch(/provider: notion_personal/);
	});

	it("renders a multi-section body as one block per line, headings included", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW });
		const { calls } = fakeNotion({});

		await createDailyLogEntryHandler({
			...GOOD_ARGS,
			body: ["## What I did", "- shipped #674", "", "## Reflection", "quiet day"].join("\n"),
		});

		const children = calls.find((c) => c.url.endsWith("/v1/pages"))?.body.children;
		expect(children.map((b: any) => b.type)).toEqual([
			"heading_2",
			"bulleted_list_item",
			"heading_2",
			"paragraph",
		]);
		expect(children[0].heading_2.rich_text[0].text.content).toBe("What I did");
	});

	it("splits a >2000-character line across rich-text runs instead of 400ing on it", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW });
		const { calls } = fakeNotion({});

		await createDailyLogEntryHandler({ ...GOOD_ARGS, body: "x".repeat(4500) });

		const children = calls.find((c) => c.url.endsWith("/v1/pages"))?.body.children;
		expect(children).toHaveLength(1);
		const runs = children[0].paragraph.rich_text;
		expect(runs).toHaveLength(3);
		expect(runs.map((r: any) => r.text.content.length)).toEqual([2000, 2000, 500]);
	});

	it("appends the overflow when a body exceeds Notion's 100-block-per-call cap", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW });
		const { calls } = fakeNotion({});

		const body = Array.from({ length: 150 }, (_, i) => `line ${i}`).join("\n");
		const out = await createDailyLogEntryHandler({ ...GOOD_ARGS, body });

		expect(calls.find((c) => c.url.endsWith("/v1/pages"))?.body.children).toHaveLength(100);
		const append = calls.find((c) => c.url.includes("/v1/blocks/"));
		expect(append?.body.children).toHaveLength(50);
		expect(out.content[0].text).toMatch(/blocks written: 150/);
		expect(out.content[0].text).not.toMatch(/WARNING/);
	});

	it("says so rather than reporting a clean write when the overflow append fails", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW });
		fakeNotion({ failAppend: true });

		const body = Array.from({ length: 150 }, (_, i) => `line ${i}`).join("\n");
		const out = await createDailyLogEntryHandler({ ...GOOD_ARGS, body });

		expect(out.content[0].text).toMatch(/WARNING: the entry was created but its body is incomplete/);
		expect(out.content[0].text).toMatch(/50 block\(s\)/);
	});
});

describe("daily_log_create — property validation", () => {
	it("rejects an unknown property name, listing the valid ones, before writing anything", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW });
		const { calls } = fakeNotion({});

		// "P1 Launch" was a Work pillar checkbox. Since #692 it is not a property on
		// EITHER database — pillars are one `Pillars` multi-select whose options differ
		// per domain. Baking one domain's schema into a two-domain tool is what
		// ADR-054 §6 forbids, and the error has to say which names would have worked.
		const err = await createDailyLogEntryHandler({
			...GOOD_ARGS,
			properties: { "P1 Launch": { checkbox: true } },
		}).catch((e: Error) => e);

		expect(String(err)).toMatch(/Unknown property for this Daily Log: 'P1 Launch'/);
		expect(String(err)).toMatch(/Pillars \(multi_select: P1 Laura \| /);
		expect(calls.some((c) => c.url.endsWith("/v1/pages"))).toBe(false);
	});

	it("passes a pillars multi-select through as a real Notion REST shape (#692)", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW });
		const { calls } = fakeNotion({});

		// The write shape pillars now take. Property names AND option values are both
		// validated against a live read since #695 — Notion CREATES an unknown option
		// rather than rejecting it, so an unvalidated write pollutes the vocabulary.
		// "P1 Laura" is a real declared option, so this passes.
		await createDailyLogEntryHandler({
			...GOOD_ARGS,
			properties: { Pillars: { multi_select: [{ name: "P1 Laura" }] } },
		});

		const props = calls.find((c) => c.url.endsWith("/v1/pages"))?.body.properties;
		expect(props.Pillars).toEqual({ multi_select: [{ name: "P1 Laura" }] });
	});

	it("passes known properties through as real Notion REST shapes", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW });
		const { calls } = fakeNotion({});

		await createDailyLogEntryHandler({
			...GOOD_ARGS,
			properties: {
				"Reflection included": { checkbox: true },
				Type: { select: { name: "Daily" } },
			},
		});

		const props = calls.find((c) => c.url.endsWith("/v1/pages"))?.body.properties;
		expect(props["Reflection included"]).toEqual({ checkbox: true });
		expect(props.Type).toEqual({ select: { name: "Daily" } });
	});

	// #695: Notion does not reject an unknown select-like option, it CREATES one. So an
	// option that was re-derived, guessed, or carried from a stale config silently adds
	// to the owner's vocabulary — and #692 made the pillar option set the identity space
	// the whole design rests on, under a config rule of NEVER RENAME, ONLY ADD.
	it("refuses an unknown multi-select option, naming the valid ones, before writing anything", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW });
		const { calls } = fakeNotion({});

		const err = await createDailyLogEntryHandler({
			...GOOD_ARGS,
			properties: { Pillars: { multi_select: [{ name: "P1 Lorra" }] } },
		}).catch((e: Error) => e);

		expect(String(err)).toMatch(/does not have option 'P1 Lorra'/);
		expect(String(err)).toMatch(/Its options are: P1 Laura \| /);
		expect(String(err)).toMatch(/Nothing was written, and nothing was created/);
		expect(calls.some((c) => c.url.endsWith("/v1/pages"))).toBe(false);
	});

	it("refuses an unknown option even when a valid one is alongside it", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW });
		const { calls } = fakeNotion({});

		const err = await createDailyLogEntryHandler({
			...GOOD_ARGS,
			properties: {
				Pillars: { multi_select: [{ name: "P1 Laura" }, { name: "P9 Invented" }] },
			},
		}).catch((e: Error) => e);

		expect(String(err)).toMatch(/'P9 Invented'/);
		expect(String(err)).not.toMatch(/'P1 Laura'\b(?!.*options are)/);
		expect(calls.some((c) => c.url.endsWith("/v1/pages"))).toBe(false);
	});

	it("refuses an unknown single-select option too, not just multi-select", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW });
		const { calls } = fakeNotion({
			schemas: {
				[ANGUS_DB]: {
					Name: { type: "title" },
					Date: { type: "date" },
					Type: { type: "select", select: { options: [{ name: "Daily" }] } },
				},
			},
		});

		const err = await createDailyLogEntryHandler({
			...GOOD_ARGS,
			properties: { Type: { select: { name: "Weekly" } } },
		}).catch((e: Error) => e);

		expect(String(err)).toMatch(/'Type' does not have option 'Weekly'/);
		expect(calls.some((c) => c.url.endsWith("/v1/pages"))).toBe(false);
	});

	// `status` shares the single-value code path with `select` (`value[type].name`).
	// Identical by construction, but asserted rather than inferred: the guard names
	// three types and only two were covered.
	it("refuses an unknown status option, the third select-like type", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW });
		const { calls } = fakeNotion({
			schemas: {
				[ANGUS_DB]: {
					Name: { type: "title" },
					Date: { type: "date" },
					"Synthesis Status": {
						type: "status",
						status: { options: [{ name: "Confirmed" }, { name: "Unconfirmed" }] },
					},
				},
			},
		});

		const err = await createDailyLogEntryHandler({
			...GOOD_ARGS,
			properties: { "Synthesis Status": { status: { name: "Provisional" } } },
		}).catch((e: Error) => e);

		expect(String(err)).toMatch(/'Synthesis Status' does not have option 'Provisional'/);
		expect(String(err)).toMatch(/Confirmed \| Unconfirmed/);
		expect(calls.some((c) => c.url.endsWith("/v1/pages"))).toBe(false);
	});

	// The flattener omits `options` entirely for a property that declares none, so a
	// free-form select-like property stays free-form. `Other domains` is exactly that.
	it("leaves a select-like property with no declared options unguarded", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW });
		const { calls } = fakeNotion({});

		await createDailyLogEntryHandler({
			...GOOD_ARGS,
			properties: { "Other domains": { multi_select: [{ name: "anything at all" }] } },
		});

		const props = calls.find((c) => c.url.endsWith("/v1/pages"))?.body.properties;
		expect(props["Other domains"]).toEqual({ multi_select: [{ name: "anything at all" }] });
	});

	it("refuses to take the title or date from two sources at once", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW });
		fakeNotion({});

		await expect(
			createDailyLogEntryHandler({
				...GOOD_ARGS,
				properties: { Date: { date: { start: "2020-01-01" } } },
			}),
		).rejects.toThrow(/must not set 'Date'/);
	});

	it("demands date_property when the destination has more than one date property", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW });
		fakeNotion({
			schemas: {
				[ANGUS_DB]: {
					Name: { type: "title" },
					Date: { type: "date" },
					"Reviewed on": { type: "date" },
				},
			},
		});

		await expect(createDailyLogEntryHandler(GOOD_ARGS)).rejects.toThrow(
			/has 2 date properties \(Date, Reviewed on\).*Pass date_property/s,
		);

		const out = await createDailyLogEntryHandler({ ...GOOD_ARGS, date_property: "Reviewed on" });
		expect(out.content[0].text).toMatch(/page_id: page-created/);
	});
});

describe("daily_log_create — duplicate guard (#673)", () => {
	it("refuses a second entry for a date that already has one, naming the existing page and reports twin_present: false when no twin exists (#721)", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW });
		const { calls } = fakeNotion({ queryResults: { [ANGUS_DS]: [{ id: "existing-page" }] } });

		const err = await createDailyLogEntryHandler(GOOD_ARGS).catch((e: Error) => e);
		expect(String(err)).toMatch(/already has a Daily Log entry for 2026-08-21 \(existing-page\)/);
		expect(String(err)).toMatch(/twin_present: false/);
		expect((err as any).twin_present).toBe(false);
		expect((err as any).existing_page_ids).toEqual(["existing-page"]);
		expect(String(err)).toMatch(/allow_duplicate: true/);
		expect(calls.some((c) => c.url.endsWith("/v1/pages"))).toBe(false);

		// The guard asks Notion for that one date rather than paging the whole log.
		const query = calls.find((c) => c.url.includes("/query"));
		expect(query?.body.filter).toEqual({ property: "Date", date: { equals: "2026-08-21" } });
	});

	it("reports twin_present: true when an ahKMS Daily Log twin link exists for the existing page (#721)", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW }, undefined, ["existing-page"]);
		fakeNotion({ queryResults: { [ANGUS_DS]: [{ id: "existing-page" }] } });

		const err = await createDailyLogEntryHandler(GOOD_ARGS).catch((e: Error) => e);
		expect(String(err)).toMatch(/already has a Daily Log entry for 2026-08-21 \(existing-page\)/);
		expect(String(err)).toMatch(/twin_present: true/);
		expect((err as any).twin_present).toBe(true);
		expect((err as any).existing_page_ids).toEqual(["existing-page"]);
	});

	it("logs a query failure distinguishably instead of reporting it as a plain foreign twin_present: false (#721 qa round 1)", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW }, undefined, [], true);
		fakeNotion({ queryResults: { [ANGUS_DS]: [{ id: "existing-page" }] } });
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const err = await createDailyLogEntryHandler(GOOD_ARGS).catch((e: Error) => e);

		expect((err as any).twin_present).toBe(false);
		expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/checkTwinPresent.*boom/));
	});

	it("writes anyway when allow_duplicate is true, and skips the query", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW });
		const { calls } = fakeNotion({ queryResults: { [ANGUS_DS]: [{ id: "existing-page" }] } });

		const out = await createDailyLogEntryHandler({ ...GOOD_ARGS, allow_duplicate: true });
		expect(out.content[0].text).toMatch(/Duplicate guard skipped/);
		expect(calls.some((c) => c.url.includes("/query"))).toBe(false);
	});

	it("says the guard did not run when only the database id is wired", async () => {
		stubIntegrations({
			notion_personal: { tasks_database_id: "db-personal", daily_log_database_id: ANGUS_DB },
		});
		fakeNotion({});

		const out = await createDailyLogEntryHandler(GOOD_ARGS);
		// Visible, not silent: a guard nobody knows is off is worse than no guard.
		expect(out.content[0].text).toMatch(/No duplicate guard ran: daily_log_data_source_id is unset/);
	});
});

// #1017. Three Daily Log pages were written in September by an IDE session logging its
// own work, not by the dos ritual. Two of them carry a `synthesized` marker, which is
// what this tool's reply told every caller to stamp, and a marker tells the #561 sweep
// the whole day is closed: twenty atoms on 16 Sep were never swept. The tool cannot
// tell its callers apart, so what it says to them is the guard.
describe("daily_log_create — who it is for (#1017)", () => {
	it("scopes marker stamping to the dos ritual instead of telling every caller to stamp", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW });
		fakeNotion({});

		const text = (await createDailyLogEntryHandler(GOOD_ARGS)).content[0].text;

		expect(text).toMatch(/dos ritual only/);
		expect(text).toMatch(/closes the whole day/);
		expect(text).toMatch(/stamp none/);
		// The provider hand-off the ritual needs is unchanged.
		expect(text).toMatch(/provider 'notion_personal'/);
	});

	it("says in its description that a session note belongs in capture, not here", async () => {
		const server = createServer();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		const { tools } = await client.listTools();
		const description = tools.find((t) => t.name === "daily_log_create")?.description ?? "";

		expect(description).toMatch(/dos ritual/);
		expect(description).toMatch(/session notes/);
		expect(description).toMatch(/capture/);

		await client.close();
		await server.close();
	});
});

// #1016. An entry is keyed on the days it COVERS, not the day it was written. A
// catch-up run dated 5 Sep whose markers landed on 28 Aug and 4 Sep used to hold 5 Sep
// against the sweep forever; with `Covers` declared it holds only the days it consumed.
const COVERS_SCHEMA = { ...PERSONAL_SCHEMA, Covers: { type: "rich_text" } };

/** A dos_config blob whose `angus` block declares the Covers property by role. */
function dosConfigWithCovers(name = "Covers", notion_type = "rich_text") {
	return {
		by_domain: {
			angus: {
				daily_log_schema: {
					properties: [
						{ name: "Date", notion_type: "date", required: true },
						{ name, notion_type, required: false, role: "covers" },
					],
				},
			},
		},
	};
}

const richText = (content: string) => ({
	type: "rich_text",
	rich_text: [{ type: "text", plain_text: content, text: { content } }],
});

describe("daily_log_create — Covers (#1016)", () => {
	it("writes the covered dates, deduped and sorted, to the config-declared Covers property", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW }, dosConfigWithCovers());
		const { calls } = fakeNotion({ schemas: { [ANGUS_DB]: COVERS_SCHEMA } });

		const out = await createDailyLogEntryHandler({
			...GOOD_ARGS,
			date: "2026-09-05",
			covers: ["2026-09-04", "2026-08-28", "2026-09-04"],
		});

		const props = calls.find((c) => c.url.endsWith("/v1/pages"))?.body.properties;
		expect(props.Date).toEqual({ date: { start: "2026-09-05" } });
		expect(props.Covers).toEqual({
			rich_text: [{ text: { content: "2026-08-28, 2026-09-04" } }],
		});
		expect(out.content[0].text).toMatch(/covers: 2026-08-28, 2026-09-04/);
	});

	it("defaults Covers to [date] when the caller names no covered days", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW }, dosConfigWithCovers());
		const { calls } = fakeNotion({ schemas: { [ANGUS_DB]: COVERS_SCHEMA } });

		await createDailyLogEntryHandler(GOOD_ARGS);

		const props = calls.find((c) => c.url.endsWith("/v1/pages"))?.body.properties;
		expect(props.Covers).toEqual({ rich_text: [{ text: { content: "2026-08-21" } }] });
	});

	it("writes a multi_select Covers as one option per date", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW }, dosConfigWithCovers("Covers", "multi_select"));
		const { calls } = fakeNotion({
			schemas: {
				[ANGUS_DB]: { ...PERSONAL_SCHEMA, Covers: { type: "multi_select", multi_select: { options: [] } } },
			},
		});

		await createDailyLogEntryHandler({ ...GOOD_ARGS, covers: ["2026-08-21", "2026-08-20"] });

		const props = calls.find((c) => c.url.endsWith("/v1/pages"))?.body.properties;
		expect(props.Covers).toEqual({
			multi_select: [{ name: "2026-08-20" }, { name: "2026-08-21" }],
		});
	});

	it("rejects a covered date that is not YYYY-MM-DD before reading anything", async () => {
		const err = await createDailyLogEntryHandler({
			...GOOD_ARGS,
			covers: ["28 Aug"],
		}).catch((e: Error) => e);
		expect(String(err)).toMatch(/`covers` must hold YYYY-MM-DD dates, got '28 Aug'/);
	});

	it("refuses `Covers` in `properties`: the tool writes it from `covers`", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW }, dosConfigWithCovers());
		fakeNotion({ schemas: { [ANGUS_DB]: COVERS_SCHEMA } });

		const err = await createDailyLogEntryHandler({
			...GOOD_ARGS,
			properties: { Covers: richText("2026-08-21") },
		}).catch((e: Error) => e);
		expect(String(err)).toMatch(/must not set 'Covers'/);
	});

	it("guards on the covered days: asks for any entry covering, or dated, one of them", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW }, dosConfigWithCovers());
		const { calls } = fakeNotion({ schemas: { [ANGUS_DB]: COVERS_SCHEMA } });

		await createDailyLogEntryHandler({ ...GOOD_ARGS, date: "2026-09-05", covers: ["2026-09-05"] });

		const query = calls.find((c) => c.url.includes("/query"));
		expect(query?.body.filter).toEqual({
			or: [
				{ property: "Covers", rich_text: { contains: "2026-09-05" } },
				{ property: "Date", date: { equals: "2026-09-05" } },
			],
		});
	});

	it("does NOT refuse a day whose only same-Date entry declares it covers other days", async () => {
		// The live 5 Sep case: a catch-up page dated 5 Sep whose markers sit on 28 Aug
		// and 4 Sep. It comes back from the Date half of the filter, and is not a clash.
		stubIntegrations({ notion_personal: ANGUS_ROW }, dosConfigWithCovers());
		const { calls } = fakeNotion({
			schemas: { [ANGUS_DB]: COVERS_SCHEMA },
			queryResults: {
				[ANGUS_DS]: [
					{
						id: "catch-up-page",
						properties: {
							Date: { type: "date", date: { start: "2026-09-05" } },
							Covers: richText("2026-08-28, 2026-09-04"),
						},
					},
				],
			},
		});

		const out = await createDailyLogEntryHandler({
			...GOOD_ARGS,
			date: "2026-09-05",
			covers: ["2026-09-05"],
		});
		expect(out.content[0].text).toMatch(/page_id: page-created/);
		expect(calls.some((c) => c.url.endsWith("/v1/pages"))).toBe(true);
	});

	it("refuses when an existing entry's Covers holds one of the covered days, naming the day", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW }, dosConfigWithCovers());
		const { calls } = fakeNotion({
			schemas: { [ANGUS_DB]: COVERS_SCHEMA },
			queryResults: {
				[ANGUS_DS]: [
					{
						id: "catch-up-page",
						properties: {
							Date: { type: "date", date: { start: "2026-09-05" } },
							Covers: richText("2026-08-28, 2026-09-04"),
						},
					},
				],
			},
		});

		const err = await createDailyLogEntryHandler({
			...GOOD_ARGS,
			date: "2026-09-06",
			covers: ["2026-09-04", "2026-09-06"],
		}).catch((e: Error) => e);
		expect(String(err)).toMatch(/already covers 2026-09-04 \(catch-up-page\)/);
		expect(calls.some((c) => c.url.endsWith("/v1/pages"))).toBe(false);
	});

	it("reads an EMPTY Covers as covering its own Date (no backfill)", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW }, dosConfigWithCovers());
		fakeNotion({
			schemas: { [ANGUS_DB]: COVERS_SCHEMA },
			queryResults: {
				[ANGUS_DS]: [
					{
						id: "legacy-page",
						properties: {
							Date: { type: "date", date: { start: "2026-09-05" } },
							Covers: { type: "rich_text", rich_text: [] },
						},
					},
				],
			},
		});

		const err = await createDailyLogEntryHandler({
			...GOOD_ARGS,
			date: "2026-09-05",
		}).catch((e: Error) => e);
		expect(String(err)).toMatch(/already covers 2026-09-05 \(legacy-page\)/);
		expect(String(err)).toMatch(/twin_present: false/);
		expect((err as any).twin_present).toBe(false);
		expect((err as any).existing_page_ids).toEqual(["legacy-page"]);
	});

	it("reports twin_present: true when an ahKMS Daily Log twin link exists for a Covers-clashing page (#721)", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW }, dosConfigWithCovers(), ["catch-up-page"]);
		fakeNotion({
			schemas: { [ANGUS_DB]: COVERS_SCHEMA },
			queryResults: {
				[ANGUS_DS]: [
					{
						id: "catch-up-page",
						properties: {
							Date: { type: "date", date: { start: "2026-09-05" } },
							Covers: richText("2026-08-28, 2026-09-04"),
						},
					},
				],
			},
		});

		const err = await createDailyLogEntryHandler({
			...GOOD_ARGS,
			date: "2026-09-06",
			covers: ["2026-09-04", "2026-09-06"],
		}).catch((e: Error) => e);
		expect(String(err)).toMatch(/already covers 2026-09-04 \(catch-up-page\)/);
		expect(String(err)).toMatch(/twin_present: true/);
		expect((err as any).twin_present).toBe(true);
		expect((err as any).existing_page_ids).toEqual(["catch-up-page"]);
	});

	it("does not treat an incidental date-shaped substring in hand-edited free text as a declared day", async () => {
		// Round-1 QA nit (#1148): effectiveCovers used to scan the whole rich_text for ANY
		// YYYY-MM-DD-shaped substring, so a human note mentioning a date in prose would
		// silently join the guard set. It now splits on the writer's own ", " delimiter, so
		// free text never parses into a covered day.
		stubIntegrations({ notion_personal: ANGUS_ROW }, dosConfigWithCovers());
		fakeNotion({
			schemas: { [ANGUS_DB]: COVERS_SCHEMA },
			queryResults: {
				[ANGUS_DS]: [
					{
						id: "hand-edited-page",
						properties: {
							Date: { type: "date", date: { start: "2026-09-01" } },
							Covers: richText("see the note from 2026-09-05 for context"),
						},
					},
				],
			},
		});

		const out = await createDailyLogEntryHandler({
			...GOOD_ARGS,
			date: "2026-09-05",
			covers: ["2026-09-05"],
		});
		expect(out.content[0].text).toMatch(/page_id: page-created/);
	});

	it("falls back to the Date guard, and says Covers was not written, when config declares no Covers", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW });
		const { calls } = fakeNotion({});

		const out = await createDailyLogEntryHandler({ ...GOOD_ARGS, covers: ["2026-08-20"] });

		const query = calls.find((c) => c.url.includes("/query"));
		expect(query?.body.filter).toEqual({ property: "Date", date: { equals: "2026-08-21" } });
		const props = calls.find((c) => c.url.endsWith("/v1/pages"))?.body.properties;
		expect(props.Covers).toBeUndefined();
		expect(out.content[0].text).toMatch(/Covers not written/);
		expect(out.content[0].text).toMatch(/role 'covers'/);
	});

	it("degrades with a note, never a failed write, when config declares Covers but Notion lacks it", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW }, dosConfigWithCovers());
		const { calls } = fakeNotion({});

		const out = await createDailyLogEntryHandler(GOOD_ARGS);

		expect(calls.some((c) => c.url.endsWith("/v1/pages"))).toBe(true);
		expect(out.content[0].text).toMatch(/Covers not written/);
		expect(out.content[0].text).toMatch(/'Covers'.*not a rich_text or multi_select property/);
	});
});

describe("daily_log_create — Pillars (#703)", () => {
	function dosConfigWithPillars(name = "Pillars", notion_type = "multi_select") {
		return {
			by_domain: {
				angus: {
					daily_log_schema: {
						properties: [
							{ name: "Date", notion_type: "date", required: true },
							{ name, notion_type, required: false, role: "pillars" },
						],
					},
				},
			},
		};
	}

	it("refuses a pillars argument with 'pillars → none declared; write none' when config declares no property with role 'pillars'", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW }); // default config has no role "pillars"
		fakeNotion({});

		await expect(
			createDailyLogEntryHandler({
				...GOOD_ARGS,
				pillars: ["P1 Laura"],
			}),
		).rejects.toThrow("pillars → none declared; write none");
	});

	it("writes pillars to the config-declared pillars property", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW }, dosConfigWithPillars());
		const { calls } = fakeNotion({});

		const out = await createDailyLogEntryHandler({
			...GOOD_ARGS,
			pillars: ["P1 Laura", "P3 Health and Fitness"],
		});

		const props = calls.find((c) => c.url.endsWith("/v1/pages"))?.body.properties;
		expect(props.Pillars).toEqual({
			multi_select: [{ name: "P1 Laura" }, { name: "P3 Health and Fitness" }],
		});
		expect(out.content[0].text).toMatch(/pillars: P1 Laura, P3 Health and Fitness/);
	});

	it("rejects an unknown pillar option against live Notion schema", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW }, dosConfigWithPillars());
		fakeNotion({});

		await expect(
			createDailyLogEntryHandler({
				...GOOD_ARGS,
				pillars: ["Unknown Pillar"],
			}),
		).rejects.toThrow(/`pillars: 'Unknown Pillar'` is not an option of 'Pillars'/);
	});

	it("distinguishes a transient config-read failure from a genuine no-declaration refusal (round 1 QA, Low)", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW }); // baseline: no role "pillars"
		fakeNotion({});
		// Make the user_preferences read throw outright (not a {error} result —
		// loadDosConfig already degrades that shape to DEFAULT_DOS_CONFIG itself).
		// This simulates the network-layer exception the .catch(() => null) call
		// site exists to catch.
		const originalFrom = (supabase as any).from;
		(supabase as any).from = (table: string) => {
			if (table === "user_preferences") {
				throw new Error("connection reset");
			}
			return originalFrom(table);
		};

		await expect(
			createDailyLogEntryHandler({
				...GOOD_ARGS,
				pillars: ["P1 Laura"],
			}),
		).rejects.toThrow("pillars → dos config unreachable; refusing to write rather than guessing");
	});

	it("refuses when pillars property is supplied in both pillars arg and properties", async () => {
		stubIntegrations({ notion_personal: ANGUS_ROW }, dosConfigWithPillars());
		fakeNotion({});

		await expect(
			createDailyLogEntryHandler({
				...GOOD_ARGS,
				pillars: ["P1 Laura"],
				properties: {
					Pillars: { multi_select: [{ name: "P1 Laura" }] },
				},
			}),
		).rejects.toThrow(/`properties` must not set 'Pillars'/);
	});
});

describe("daily_log_create — enforces required properties from dos_config.daily_log_schema (#1139)", () => {
	function dosConfigWithRequired(
		requiredProperties: { name: string; notion_type: string; required: boolean; role?: string }[],
	) {
		return {
			by_domain: {
				angus: {
					daily_log_schema: {
						properties: requiredProperties,
					},
				},
			},
		};
	}

	it("refuses a write missing a required: true property, naming the property", async () => {
		const config = dosConfigWithRequired([
			{ name: "Synthesis Status", notion_type: "select", required: true },
		]);
		stubIntegrations({ notion_personal: ANGUS_ROW }, config);
		fakeNotion({
			schemas: {
				[ANGUS_DB]: {
					...PERSONAL_SCHEMA,
					"Synthesis Status": { type: "select", select: { options: [{ name: "Confirmed" }] } },
				},
			},
		});

		const err = await createDailyLogEntryHandler(GOOD_ARGS).catch((e: Error) => e);
		expect(String(err)).toMatch(
			/Domain 'angus' Daily Log write refused: missing required property 'Synthesis Status' \(declared required: true in dos_config.daily_log_schema\)/,
		);
	});

	it("succeeds when all required properties are supplied in properties", async () => {
		const config = dosConfigWithRequired([
			{ name: "Synthesis Status", notion_type: "select", required: true },
		]);
		stubIntegrations({ notion_personal: ANGUS_ROW }, config);
		const { calls } = fakeNotion({
			schemas: {
				[ANGUS_DB]: {
					...PERSONAL_SCHEMA,
					"Synthesis Status": { type: "select", select: { options: [{ name: "Confirmed" }] } },
				},
			},
		});

		const out = await createDailyLogEntryHandler({
			...GOOD_ARGS,
			properties: {
				"Synthesis Status": { select: { name: "Confirmed" } },
			},
		});

		const props = calls.find((c) => c.url.endsWith("/v1/pages"))?.body.properties;
		expect(props["Synthesis Status"]).toEqual({ select: { name: "Confirmed" } });
		expect(out.content[0].text).toMatch(/page_id: page-created/);
	});

	it("considers Name, Date and covers satisfied when configured required", async () => {
		const config = dosConfigWithRequired([
			{ name: "Name", notion_type: "title", required: true },
			{ name: "Date", notion_type: "date", required: true },
			{ name: "Covers", notion_type: "rich_text", required: true, role: "covers" },
		]);
		stubIntegrations({ notion_personal: ANGUS_ROW }, config);
		const { calls } = fakeNotion({
			schemas: {
				[ANGUS_DB]: COVERS_SCHEMA,
			},
		});

		const out = await createDailyLogEntryHandler({
			...GOOD_ARGS,
			covers: ["2026-08-21"],
		});

		expect(calls.some((c) => c.url.endsWith("/v1/pages"))).toBe(true);
		expect(out.content[0].text).toMatch(/page_id: page-created/);
	});

	it.each([
		["a null select", { select: null }],
		["an empty multi_select", { multi_select: [] }],
		["an empty rich_text", { rich_text: [] }],
	])(
		"refuses a required property supplied as %s — present but empty for its type",
		async (_label, emptyValue) => {
			const config = dosConfigWithRequired([
				{ name: "Synthesis Status", notion_type: "select", required: true },
			]);
			stubIntegrations({ notion_personal: ANGUS_ROW }, config);
			fakeNotion({
				schemas: {
					[ANGUS_DB]: {
						...PERSONAL_SCHEMA,
						"Synthesis Status": { type: "select", select: { options: [{ name: "Confirmed" }] } },
					},
				},
			});

			const err = await createDailyLogEntryHandler({
				...GOOD_ARGS,
				properties: { "Synthesis Status": emptyValue },
			}).catch((e: Error) => e);

			expect(String(err)).toMatch(
				/Domain 'angus' Daily Log write refused: missing required property 'Synthesis Status'/,
			);
		},
	);

	it("accepts Type: Daily for angus when declared required and live schema contains Daily option (#1727)", async () => {
		const config = dosConfigWithRequired([
			{ name: "Type", notion_type: "select", required: true },
		]);
		stubIntegrations({ notion_personal: ANGUS_ROW }, config);
		const { calls } = fakeNotion({
			schemas: {
				[ANGUS_DB]: {
					...PERSONAL_SCHEMA,
					Type: { type: "select", select: { options: [{ name: "Daily" }, { name: "Catch-up" }] } },
				},
			},
		});

		const out = await createDailyLogEntryHandler({
			...GOOD_ARGS,
			properties: {
				Type: { select: { name: "Daily" } },
			},
		});

		const props = calls.find((c) => c.url.endsWith("/v1/pages"))?.body.properties;
		expect(props.Type).toEqual({ select: { name: "Daily" } });
		expect(out.content[0].text).toMatch(/page_id: page-created/);
	});

	it("refuses Type: Daily for angus when live schema only contains Catch-up (#1727)", async () => {
		const config = dosConfigWithRequired([
			{ name: "Type", notion_type: "select", required: true },
		]);
		stubIntegrations({ notion_personal: ANGUS_ROW }, config);
		fakeNotion({
			schemas: {
				[ANGUS_DB]: {
					...PERSONAL_SCHEMA,
					Type: { type: "select", select: { options: [{ name: "Catch-up" }] } },
				},
			},
		});

		const err = await createDailyLogEntryHandler({
			...GOOD_ARGS,
			properties: {
				Type: { select: { name: "Daily" } },
			},
		}).catch((e: Error) => e);

		expect(String(err)).toMatch(/'Type' does not have option 'Daily'/);
	});

	it("refuses write for angus when Type is declared required but omitted from properties (#1727)", async () => {
		const config = dosConfigWithRequired([
			{ name: "Type", notion_type: "select", required: true },
		]);
		stubIntegrations({ notion_personal: ANGUS_ROW }, config);
		fakeNotion({
			schemas: {
				[ANGUS_DB]: {
					...PERSONAL_SCHEMA,
					Type: { type: "select", select: { options: [{ name: "Daily" }, { name: "Catch-up" }] } },
				},
			},
		});

		const err = await createDailyLogEntryHandler(GOOD_ARGS).catch((e: Error) => e);

		expect(String(err)).toMatch(
			/Domain 'angus' Daily Log write refused: missing required property 'Type' \(declared required: true in dos_config.daily_log_schema\)/,
		);
	});
});
