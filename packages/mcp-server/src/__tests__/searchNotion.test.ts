import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../server.js";
import { searchNotionHandler } from "../tools/searchNotion.js";

// Title search over both workspaces (#830). The assertions that matter are the ones the
// issue was filed about: the domain is required with no default, the SELECTED workspace's
// token authenticates the call, and an empty result is never allowed to read as "the page
// does not exist" — that inference is what made a findable page unfindable on 2026-08-23.

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const WORK_TOKEN = "Bearer secret_test_token";
const ANGUS_TOKEN = "Bearer secret_personal_test_token";

type Call = { body: any; auth?: string };

function fakeSearch(results: unknown[], hasMore = false): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init: RequestInit = {}) => {
			calls.push({
				body: JSON.parse(init.body as string),
				auth: (init.headers as Record<string, string> | undefined)?.Authorization,
			});
			const payload = { results, has_more: hasMore, next_cursor: hasMore ? "cur" : null };
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => payload,
				text: async () => JSON.stringify(payload),
			} as Response;
		}),
	);
	return calls;
}

function page(id: string, title: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		object: "page",
		url: `https://notion.so/${id.replace(/-/g, "")}`,
		last_edited_time: "2026-08-23T10:00:00.000Z",
		properties: { Name: { type: "title", title: [{ plain_text: title }] } },
		...extra,
	};
}

function textOf(result: { content: { type: "text"; text: string }[] }): string {
	return result.content[0].text;
}

describe("notion_search", () => {
	it("requires domain, naming both workspaces — no default", async () => {
		await expect(searchNotionHandler({ query: "notepad" })).rejects.toThrow(
			/'work'.*'angus'|'angus'.*'work'/,
		);
	});

	it("authenticates with the SELECTED workspace's token and sends the query", async () => {
		const calls = fakeSearch([page("1fbb7b8b-edcd-80dd-819d-ecf7f2eb1e89", "Notepad")]);

		const out = textOf(await searchNotionHandler({ domain: "angus", query: "notepad" }));

		expect(calls[0].auth).toBe(ANGUS_TOKEN);
		expect(calls[0].body.query).toBe("notepad");
		expect(out).toContain("Notepad");
		expect(out).toContain("1fbb7b8b-edcd-80dd-819d-ecf7f2eb1e89");
		expect(out).toContain("notion_page_get");
	});

	it("omits the sort when a query is given so Notion ranks by relevance, not recency", async () => {
		const calls = fakeSearch([page("a".repeat(32), "Hit")]);
		await searchNotionHandler({ domain: "work", query: "roadmap" });
		expect(calls[0].auth).toBe(WORK_TOKEN);
		expect(calls[0].body.sort).toBeUndefined();
	});

	it("keeps the newest-first sort when listing with no query (the discover-cadence shape)", async () => {
		const calls = fakeSearch([page("b".repeat(32), "Recent")]);
		await searchNotionHandler({ domain: "angus" });
		expect(calls[0].body.query).toBeUndefined();
		expect(calls[0].body.sort).toEqual({ direction: "descending", timestamp: "last_edited_time" });
	});

	it("passes a type filter through mapped to Notion 2025-09-03 data_source (#1993)", async () => {
		const calls = fakeSearch([]);
		await searchNotionHandler({ domain: "angus", query: "tasks", type: "database" });
		expect(calls[0].body.filter).toEqual({ property: "object", value: "data_source" });
	});

	it("drops archived matches from the listing and says how many", async () => {
		fakeSearch([
			page("c".repeat(32), "Live one"),
			page("d".repeat(32), "Old one", { archived: true }),
		]);
		const out = textOf(await searchNotionHandler({ domain: "angus", query: "one" }));
		expect(out).toContain("Live one");
		expect(out).not.toContain("Old one");
		expect(out).toContain("1 archived object(s) matched and were not listed");
	});

	it("an empty result names all three causes instead of reading as 'not there'", async () => {
		fakeSearch([]);
		const out = textOf(await searchNotionHandler({ domain: "angus", query: "general" }));
		expect(out).toContain("does NOT mean the page does not exist");
		expect(out).toContain("TITLE");
		expect(out).toContain("domain='work'"); // wrong workspace
		expect(out).toContain("notion_personal"); // not shared with the integration
		expect(out).toContain("ask for the page URL");
	});

	it("says so when more matches exist than were shown", async () => {
		fakeSearch([page("e".repeat(32), "One"), page("f".repeat(32), "Two")], true);
		const out = textOf(await searchNotionHandler({ domain: "work", query: "note", limit: 1 }));
		expect(out).toContain("more matches; pass cursor 'cur'");
		expect(out).not.toContain("Two");
	});
});

describe("registration", () => {
	it("serves notion_search over a real client connection", async () => {
		const server = createServer();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		const tools = (await client.listTools()).tools.map((t) => t.name);
		expect(tools).toContain("notion_search");

		await client.close();
		await server.close();
	});
});
