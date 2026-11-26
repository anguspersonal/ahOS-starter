import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../server.js";
import { queryNotionDatabaseHandler } from "../tools/queryNotionDatabase.js";
import { propertyPlain } from "../tools/readNotionPage.js";

// The list-shaped half of the Notion surface (#830). What matters: the domain is
// required with no default; the SELECTED workspace's token authenticates the call and
// hits the data-source query endpoint on the 2025-09-03 pin; filter and sorts pass
// through untouched; properties flatten the same way notion_page_get flattens them;
// pagination is surfaced, never silently cut; and an empty answer names its causes.

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const WORK_TOKEN = "Bearer secret_test_token";
const ANGUS_TOKEN = "Bearer secret_personal_test_token";
const DS = "28e9e609-fe01-81b4-bf9f-000b243e40ba";

type Call = { url: string; body: any; auth?: string; version?: string };

function fakeQuery(results: unknown[], opts: { hasMore?: boolean; status?: number; error?: string } = {}): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit = {}) => {
			const headers = init.headers as Record<string, string> | undefined;
			calls.push({ url, body: JSON.parse(init.body as string), auth: headers?.Authorization, version: headers?.["Notion-Version"] });
			if (opts.status && opts.status >= 400) {
				return {
					ok: false,
					status: opts.status,
					statusText: "err",
					json: async () => ({}),
					text: async () => opts.error ?? "object_not_found",
				} as Response;
			}
			const payload = { results, has_more: opts.hasMore ?? false, next_cursor: opts.hasMore ? "cur-2" : null };
			return { ok: true, status: 200, statusText: "OK", json: async () => payload, text: async () => JSON.stringify(payload) } as Response;
		}),
	);
	return calls;
}

function row(id: string, name: string, extra: Record<string, unknown> = {}, archived = false) {
	return {
		id,
		object: "page",
		archived,
		last_edited_time: "2026-09-03T12:33:46.041Z",
		properties: {
			"Task name": { type: "title", title: [{ plain_text: name }] },
			Status: { type: "status", status: { name: "To do" } },
			Priority: { type: "select", select: { name: "P1" } },
			"Due date": { type: "date", date: { start: "2026-09-08" } },
			Owner: { type: "people", people: [{ id: "25ed872b-594c-8107-a019-0002023c963c", name: "Angus" }] },
			Project: { type: "relation", relation: [{ id: "aaaa" }, { id: "bbbb" }] },
			Done: { type: "checkbox", checkbox: false },
			...extra,
		},
	};
}

const text = (r: { content: { type: "text"; text: string }[] }) => r.content[0].text;
const jsonOf = (t: string) => JSON.parse(t.split("```json\n")[1].split("\n```")[0]);

describe("notion_database_query", () => {
	it("requires domain, naming both workspaces, and requires a data source id", async () => {
		await expect(queryNotionDatabaseHandler({ data_source_id: DS })).rejects.toThrow(/'work'.*'angus'|'angus'.*'work'/);
		await expect(queryNotionDatabaseHandler({ domain: "work" })).rejects.toThrow(/data_source_id/);
	});

	it("queries the data-source endpoint on the 2025-09-03 pin with the SELECTED workspace's token", async () => {
		const calls = fakeQuery([row("p1", "Chase Mitesh")]);
		await queryNotionDatabaseHandler({ domain: "work", data_source_id: DS });
		expect(calls[0].url).toBe(`https://api.notion.com/v1/data_sources/${DS}/query`);
		expect(calls[0].auth).toBe(WORK_TOKEN);
		expect(calls[0].version).toBe("2025-09-03");

		const calls2 = fakeQuery([]);
		await queryNotionDatabaseHandler({ domain: "angus", data_source_id: DS.replace(/-/g, "") });
		expect(calls2[0].auth).toBe(ANGUS_TOKEN);
		// An undashed id is normalised before it reaches the URL.
		expect(calls2[0].url).toContain(DS);
	});

	it("passes filter, sorts, limit and cursor through untouched", async () => {
		const calls = fakeQuery([row("p1", "A")]);
		const filter = { and: [{ property: "Status", status: { does_not_equal: "Done" } }, { property: "Owner", people: { contains: "u1" } }] };
		const sorts = [{ property: "Due date", direction: "ascending" }];
		await queryNotionDatabaseHandler({ domain: "work", data_source_id: DS, filter, sorts, limit: 7, cursor: "cur-1" });
		expect(calls[0].body).toEqual({ page_size: 7, start_cursor: "cur-1", filter, sorts });
	});

	it("flattens every property type the way notion_page_get does, title always first", async () => {
		fakeQuery([row("p1", "Chase Mitesh")]);
		const out = text(await queryNotionDatabaseHandler({ domain: "work", data_source_id: DS }));
		expect(out).toContain("1. Chase Mitesh  (id p1)");
		expect(out).toContain("Status: To do");
		expect(out).toContain("Priority: P1");
		expect(out).toContain("Due date: 2026-09-08");
		expect(out).toContain("Owner: Angus (25ed872b-594c-8107-a019-0002023c963c)");
		expect(out).toContain("Project: 2 related: aaaa, bbbb");
		expect(out).toContain("Done: false");
		const json = jsonOf(out);
		expect(json.rows[0]).toMatchObject({ id: "p1", title: "Chase Mitesh", url: "https://www.notion.so/p1" });
		// The title is the row's heading, not repeated as a column.
		expect(json.rows[0].properties["Task name"]).toBeUndefined();
	});

	it("narrows to the requested columns and names a column that does not exist", async () => {
		fakeQuery([row("p1", "A")]);
		const out = text(await queryNotionDatabaseHandler({ domain: "work", data_source_id: DS, properties: ["Status", "Nope"] }));
		expect(out).toContain("Status: To do");
		expect(out).toContain("Nope: (no such property)");
		expect(out).not.toContain("Priority: P1");
	});

	it("never repeats the title as a column, even when properties names it", async () => {
		fakeQuery([row("p1", "Chase Mitesh")]);
		const out = text(await queryNotionDatabaseHandler({ domain: "work", data_source_id: DS, properties: ["Task name", "Status"] }));
		expect(out).toContain("1. Chase Mitesh  (id p1)");
		expect(out).not.toContain("Task name: Chase Mitesh");
		expect(jsonOf(out).rows[0].properties).toEqual({ Status: "To do" });
	});

	it("asks Notion for fifty rows when no limit is given", async () => {
		const calls = fakeQuery([row("p1", "A")]);
		await queryNotionDatabaseHandler({ domain: "work", data_source_id: DS });
		expect(calls[0].body).toEqual({ page_size: 50 });
	});

	it("surfaces pagination and archived rows rather than cutting silently", async () => {
		fakeQuery([row("p1", "A"), row("p2", "B", {}, true)], { hasMore: true });
		const out = text(await queryNotionDatabaseHandler({ domain: "work", data_source_id: DS }));
		expect(out).toContain("1 row(s)");
		expect(out).toContain("cursor 'cur-2'");
		expect(out).toContain("1 archived row(s)");
		expect(jsonOf(out)).toMatchObject({ has_more: true, next_cursor: "cur-2" });
	});

	it("hands the cursor on when a page is empty but Notion says more rows follow", async () => {
		// Every row on this page archived, and has_more true: a paging loop that
		// stopped here would silently lose the rest of the database.
		fakeQuery([row("p1", "Old", {}, true), row("p2", "Older", {}, true)], { hasMore: true });
		const out = text(await queryNotionDatabaseHandler({ domain: "work", data_source_id: DS }));
		expect(out).toContain("0 rows on this page");
		expect(out).toContain("cursor 'cur-2'");
		expect(out).toContain("2 archived row(s)");
		expect(out).not.toContain("Three things this can mean");
		expect(jsonOf(out)).toEqual({ rows: [], has_more: true, next_cursor: "cur-2" });
	});

	it("names the three causes of an empty answer instead of reading as 'nothing there'", async () => {
		fakeQuery([]);
		const out = text(await queryNotionDatabaseHandler({ domain: "work", data_source_id: DS, filter: { property: "Status", status: { equals: "X" } } }));
		expect(out).toContain("0 rows");
		expect(out).toContain("filter matched nothing");
		expect(out).toContain("domain='angus'");
		expect(out).toContain("notion_work");
		expect(jsonOf(out)).toEqual({ rows: [], has_more: false, next_cursor: null });
	});

	it("turns a 404 into the cross-workspace hint plus the database-id trap", async () => {
		fakeQuery([], { status: 404 });
		await expect(queryNotionDatabaseHandler({ domain: "angus", data_source_id: DS })).rejects.toThrow(/retry with domain='work'.*\*_database_id/s);
	});

	it("relays a Notion validation error on a bad filter verbatim", async () => {
		fakeQuery([], { status: 400, error: '{"code":"validation_error","message":"body.filter.property should be defined"}' });
		await expect(queryNotionDatabaseHandler({ domain: "work", data_source_id: DS, filter: { bad: true } })).rejects.toThrow(/body.filter.property should be defined/);
	});
});

describe("propertyPlain, the shapes a database row adds to a page read", () => {
	it("resolves a formula to its value", () => {
		expect(propertyPlain({ type: "formula", formula: { type: "string", string: "Week 36" } })).toBe("Week 36");
		expect(propertyPlain({ type: "formula", formula: { type: "number", number: 0 } })).toBe("0");
		expect(propertyPlain({ type: "formula", formula: { type: "boolean", boolean: false } })).toBe("false");
		expect(propertyPlain({ type: "formula", formula: { type: "date", date: { start: "2026-09-05" } } })).toBe("2026-09-05");
		expect(propertyPlain({ type: "formula", formula: { type: "string", string: null } })).toBe("(empty)");
	});

	it("flattens a rollup array element by element instead of dumping JSON", () => {
		const rollup = {
			type: "rollup",
			rollup: {
				type: "array",
				array: [
					{ type: "title", title: [{ plain_text: "Alpha" }] },
					{ type: "status", status: { name: "Done" } },
				],
				function: "show_original",
			},
		};
		expect(propertyPlain(rollup)).toBe("Alpha, Done");
		expect(propertyPlain({ type: "rollup", rollup: { type: "array", array: [] } })).toBe("(empty)");
		expect(propertyPlain({ type: "rollup", rollup: { type: "number", number: 3 } })).toBe("3");
	});

	it("renders authorship and timestamps as notion_page_get does", () => {
		expect(propertyPlain({ type: "created_by", created_by: { id: "u1", name: "Angus" } })).toBe("Angus (u1)");
		expect(propertyPlain({ type: "last_edited_by", last_edited_by: { id: "u2" } })).toBe("u2");
		expect(propertyPlain({ type: "created_time", created_time: "2026-09-01T08:00:00.000Z" })).toBe("2026-09-01T08:00:00.000Z");
		expect(propertyPlain({ type: "last_edited_time", last_edited_time: "2026-09-02T08:00:00.000Z" })).toBe("2026-09-02T08:00:00.000Z");
	});
});

describe("registration", () => {
	it("serves notion_database_query over a real client connection", async () => {
		const server = createServer();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		const tools = (await client.listTools()).tools.map((t) => t.name);
		expect(tools).toContain("notion_database_query");

		await client.close();
		await server.close();
	});
});
