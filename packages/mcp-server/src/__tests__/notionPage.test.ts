import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { supabase } from "../supabase.js";
import { createServer } from "../server.js";
import { readNotionPageHandler } from "../tools/readNotionPage.js";
import { normalizeNotionId } from "../notionDomain.js";

// The generic Notion page surface (#625 read / #818 write). The load-bearing
// assertions are the ones the issues wrote down as acceptance criteria: domain is
// required with no default, every call authenticates with the SELECTED workspace's
// token (the #424 defect-1 regression), a 404 teaches the cross-workspace retry
// instead of reading as "Notion is unavailable", and the State Doc stays behind its
// one writer (ADR-053) even now that a generic page writer exists.

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// Set by vitest.config.ts, one per workspace.
const ANGUS_TOKEN = "Bearer secret_personal_test_token";

const PAGE = "8db39ce2-4513-4593-9a57-f3a9a0a05ed7";

type Call = { method: string; path: string; body?: any; auth?: string };

/** Record every Notion API call; answer with canned payloads (or a 404 everywhere). */
function fakeNotion(opts: { blocks?: unknown[]; page?: unknown; notFound?: boolean } = {}): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit = {}) => {
			const method = init.method ?? "GET";
			const path = new URL(url).pathname;
			calls.push({
				method,
				path,
				body: init.body ? JSON.parse(init.body as string) : undefined,
				auth: (init.headers as Record<string, string> | undefined)?.Authorization,
			});
			if (opts.notFound) {
				return {
					ok: false,
					status: 404,
					statusText: "Not Found",
					text: async () => JSON.stringify({ code: "object_not_found" }),
				} as Response;
			}
			const payload = path.endsWith("/children")
				? { results: opts.blocks ?? [], has_more: false, next_cursor: null }
				: (opts.page ?? { id: PAGE, properties: {} });
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

function textOf(result: { content: { type: "text"; text: string }[] }): string {
	return result.content[0].text;
}

describe("normalizeNotionId", () => {
	it("accepts dashed ids, undashed ids, and full URLs (query stripped, last id wins)", () => {
		expect(normalizeNotionId(PAGE)).toBe(PAGE);
		expect(normalizeNotionId(PAGE.replace(/-/g, ""))).toBe(PAGE);
		expect(
			normalizeNotionId(`https://app.notion.com/p/${PAGE.replace(/-/g, "")}?pvs=204`),
		).toBe(PAGE);
	});

	it("rejects input with no id in it", () => {
		expect(() => normalizeNotionId("not-an-id")).toThrow(/32-hex/);
	});

	// #839: a URL whose SLUG ends in hex characters. Stripping dashes from the whole
	// input welds `…-817-` onto the front of the id, and reading 32 characters from the
	// start of that run yields a well-formed id pointing at nothing. Notion emitted this
	// exact URL from task_create, and feeding it straight back in 400'd. Every earlier
	// test used a slug ending in a non-hex letter, so the bug was invisible.
	it("takes the id from the END of the run when the slug ends in hex (#839)", () => {
		expect(
			normalizeNotionId(
				"https://app.notion.com/p/DELETE-ME-ahkms-due-date-verification-817-3c5b7b8bedcd81f8b5dedf1c4a83bcb3",
			),
		).toBe("3c5b7b8b-edcd-81f8-b5de-df1c4a83bcb3");

		// The same shape, other hex-ish slug tails.
		expect(
			normalizeNotionId(`https://www.notion.so/Retro-2026-${PAGE.replace(/-/g, "")}`),
		).toBe(PAGE);
		expect(normalizeNotionId(`https://www.notion.so/Draft-1-${PAGE.replace(/-/g, "")}`)).toBe(
			PAGE,
		);
	});

	it("ignores ids elsewhere in the path, using only the last segment (#839)", () => {
		const other = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		expect(
			normalizeNotionId(
				`https://www.notion.so/${other.replace(/-/g, "")}/Child-page-${PAGE.replace(/-/g, "")}`,
			),
		).toBe(PAGE);
	});

	it("tolerates a trailing slash", () => {
		expect(normalizeNotionId(`https://www.notion.so/Page-${PAGE.replace(/-/g, "")}/`)).toBe(PAGE);
	});
});

describe("notion_page_get", () => {
	it("requires domain, naming both values — no default (#625 / ADR-054 §9)", async () => {
		await expect(readNotionPageHandler({ page_id: PAGE })).rejects.toThrow(
			/'work'.*'angus'|'angus'.*'work'/,
		);
	});

	it("authenticates with the SELECTED workspace's token and lists block ids/types/text (#424 regression)", async () => {
		const calls = fakeNotion({
			page: {
				id: PAGE,
				last_edited_time: "2026-08-23T10:00:00.000Z",
				properties: {
					Name: { type: "title", title: [{ plain_text: "Wedding hub" }] },
					Status: { type: "select", select: { name: "Green" } },
				},
			},
			blocks: [
				{
					id: "b1b1b1b1-0000-0000-0000-000000000001",
					type: "heading_2",
					heading_2: { rich_text: [{ plain_text: "RAG" }] },
				},
				{
					id: "b2b2b2b2-0000-0000-0000-000000000002",
					type: "to_do",
					has_children: true,
					to_do: { rich_text: [{ plain_text: "Passport check" }], checked: false },
				},
			],
		});

		const out = textOf(await readNotionPageHandler({ domain: "angus", page_id: PAGE }));

		for (const call of calls) expect(call.auth).toBe(ANGUS_TOKEN);
		expect(out).toContain("Wedding hub");
		expect(out).toContain("Status: Green");
		expect(out).toContain("[b1b1b1b1-0000-0000-0000-000000000001] heading_2: RAG");
		expect(out).toContain("▸has_children");
		expect(out).toContain("Passport check");
	});

	it("a 404 teaches the cross-workspace retry instead of reading as 'Notion unavailable'", async () => {
		fakeNotion({ notFound: true });
		await expect(readNotionPageHandler({ domain: "angus", page_id: PAGE })).rejects.toThrow(
			/retry with domain='work'/,
		);
	});

	it("tolerates a block-container id: children list, no page envelope, no error", async () => {
		const calls = fakeNotion({ blocks: [], notFound: false });
		// Page retrieve 404s, children succeed: override fetch per-path.
		(fetch as any).mockImplementation(async (url: string, init: RequestInit = {}) => {
			const path = new URL(url).pathname;
			calls.push({ method: init.method ?? "GET", path });
			if (path.endsWith("/children")) {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({ results: [], has_more: false, next_cursor: null }),
					text: async () => "{}",
				} as Response;
			}
			return {
				ok: false,
				status: 404,
				statusText: "Not Found",
				text: async () => "{}",
			} as Response;
		});

		const out = textOf(await readNotionPageHandler({ domain: "work", page_id: PAGE }));
		expect(out).toContain("block or database container");
		expect(out).toContain("Blocks (0)");
	});

	it("tolerates a DATABASE id, which Notion rejects with 400 rather than 404", async () => {
		// Production, 2026-08-23: passing the personal tasks database id listed its children
		// fine and then failed the whole read on the decorative page-envelope fetch, because
		// only 404 was treated as "no envelope". Notion says 400 validation_error here.
		const calls: Call[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit = {}) => {
				const path = new URL(url).pathname;
				calls.push({ method: init.method ?? "GET", path });
				if (path.endsWith("/children")) {
					return {
						ok: true,
						status: 200,
						statusText: "OK",
						json: async () => ({ results: [], has_more: false, next_cursor: null }),
						text: async () => "{}",
					} as Response;
				}
				return {
					ok: false,
					status: 400,
					statusText: "Bad Request",
					text: async () =>
						JSON.stringify({
							object: "error",
							status: 400,
							code: "validation_error",
							message: `Provided ID ${PAGE} is a database, not a page. Use the retrieve database API instead.`,
						}),
				} as Response;
			}),
		);

		const out = textOf(await readNotionPageHandler({ domain: "angus", page_id: PAGE }));
		expect(out).toContain("block or database container");
		expect(calls.some((c) => c.path.endsWith("/children"))).toBe(true);
		// The empty listing must not read as "the database is empty".
		expect(out).toContain("not evidence the database is empty");
	});

	it("still surfaces an unrelated page-envelope failure rather than swallowing it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				const path = new URL(url).pathname;
				if (path.endsWith("/children")) {
					return {
						ok: true,
						status: 200,
						statusText: "OK",
						json: async () => ({ results: [], has_more: false, next_cursor: null }),
						text: async () => "{}",
					} as Response;
				}
				return {
					ok: false,
					status: 500,
					statusText: "Internal Server Error",
					text: async () => "{}",
				} as Response;
			}),
		);

		await expect(readNotionPageHandler({ domain: "angus", page_id: PAGE })).rejects.toThrow(/500/);
	});
});

describe("registration", () => {
	it("serves both page tools over a real client connection", async () => {
		const server = createServer();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		const tools = (await client.listTools()).tools.map((t) => t.name);
		expect(tools).toContain("notion_page_get");
		expect(tools).toContain("notion_page_update");

		await client.close();
		await server.close();
	});
});
