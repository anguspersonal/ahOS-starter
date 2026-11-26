import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createNotionTask,
	appendNotionBlockChildren,
	deleteNotionBlock,
	listNotionBlockChildren,
	updateNotionBlock,
	retrieveDatabaseSchema,
	searchNotion,
	notionResultTitle,
	retrieveNotionPage,
	updateNotionPageProperties,
	queryNotionDataSource,
} from "../notion.js";

type FetchCall = { url: string; init: RequestInit & { body?: string } };

/** Install a fake fetch that records the request and returns `payload`. */
function stubFetch(payload: unknown, ok = true, status = 200): FetchCall[] {
	const calls: FetchCall[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			calls.push({ url, init: init as FetchCall["init"] });
			return {
				ok,
				status,
				statusText: ok ? "OK" : "Error",
				json: async () => payload,
				text: async () => JSON.stringify(payload),
			} as Response;
		}),
	);
	return calls;
}

function bodyOf(call: FetchCall): any {
	return JSON.parse(call.init.body as string);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("createNotionTask", () => {
	it("POSTs to /pages with the configured title property and optional due + body block", async () => {
		const calls = stubFetch({ id: "page_1", url: "https://notion.so/page_1" });

		const page = await createNotionTask({
			databaseId: "db_abc",
			titleProperty: "Name",
			title: "Email supplier",
			body: "Ask about Q3 pricing",
			due: "2026-06-10",
			dueProperty: "Due",
		});

		expect(page).toEqual({ id: "page_1", url: "https://notion.so/page_1" });
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.notion.com/v1/pages");
		expect(calls[0].init.method).toBe("POST");

		const body = bodyOf(calls[0]);
		expect(body.parent).toEqual({ database_id: "db_abc" });
		expect(body.properties.Name.title[0].text.content).toBe("Email supplier");
		expect(body.properties.Due).toEqual({ date: { start: "2026-06-10" } });
		expect(body.children[0].type).toBe("paragraph");

		const mdCalls = stubFetch({ id: "page_md", url: "https://notion.so/page_md" });
		await createNotionTask({
			databaseId: "db_abc",
			titleProperty: "Name",
			title: "Follow up",
			body: "Check [the thread](https://example.com/thread)\n- [ ] Reply to **Alice**",
		});
		const mdBody = bodyOf(mdCalls[0]);
		expect(mdBody.children).toHaveLength(2);
		expect(mdBody.children[0].paragraph.rich_text).toEqual([
			{ type: "text", text: { content: "Check " } },
			{
				type: "text",
				text: { content: "the thread", link: { url: "https://example.com/thread" } },
			},
		]);
		expect(mdBody.children[1].to_do).toEqual({
			rich_text: [
				{ type: "text", text: { content: "Reply to " } },
				{ type: "text", text: { content: "Alice" }, annotations: { bold: true } },
			],
			checked: false,
		});
		expect(body.children[0].paragraph.rich_text[0].text.content).toBe(
			"Ask about Q3 pricing",
		);
	});

	it("omits the date property and children when due/body are absent", async () => {
		const calls = stubFetch({ id: "page_2", url: "" });

		await createNotionTask({
			databaseId: "db_abc",
			titleProperty: "Task",
			title: "Just a title",
		});

		const body = bodyOf(calls[0]);
		expect(body.properties.Task.title[0].text.content).toBe("Just a title");
		expect(body.properties.Due).toBeUndefined();
		expect(body.children).toBeUndefined();
	});

	it("throws a descriptive error on a non-ok response", async () => {
		stubFetch({ message: "bad db" }, false, 404);
		await expect(
			createNotionTask({ databaseId: "x", titleProperty: "Name", title: "t" }),
		).rejects.toThrow(/Notion create page failed \(404\)/);
	});

	it("authenticates with the provided workspace token (issue #424 defect 1)", async () => {
		const calls = stubFetch({ id: "page_3", url: "" });
		await createNotionTask(
			{ databaseId: "db_personal", titleProperty: "Name", title: "personal task" },
			"secret_personal_token",
		);
		expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
			"Bearer secret_personal_token",
		);
	});
});

describe("retrieveDatabaseSchema", () => {
	it("flattens properties into { name, type, options }, with options only on select-like types", async () => {
		const calls = stubFetch({
			properties: {
				Name: { type: "title", title: {} },
				Status: {
					type: "status",
					status: {
						options: [{ name: "Not started" }, { name: "In progress" }, { name: "Done" }],
					},
				},
				Priority: {
					type: "select",
					select: { options: [{ name: "Low" }, { name: "High" }] },
				},
				Tags: {
					type: "multi_select",
					multi_select: { options: [{ name: "Mobile" }, { name: "Web" }] },
				},
				Due: { type: "date", date: {} },
			},
		});

		const schema = await retrieveDatabaseSchema("db_abc");

		expect(calls[0].url).toBe("https://api.notion.com/v1/databases/db_abc");
		expect(calls[0].init.method).toBe("GET");

		expect(schema.properties).toEqual(
			expect.arrayContaining([
				{ name: "Name", type: "title" },
				{
					name: "Status",
					type: "status",
					options: ["Not started", "In progress", "Done"],
				},
				{ name: "Priority", type: "select", options: ["Low", "High"] },
				{ name: "Tags", type: "multi_select", options: ["Mobile", "Web"] },
				{ name: "Due", type: "date" },
			]),
		);
		// Non-select-like properties must not get an `options` key at all.
		const dueProp = schema.properties.find((p) => p.name === "Due");
		expect(dueProp).not.toHaveProperty("options");
		const nameProp = schema.properties.find((p) => p.name === "Name");
		expect(nameProp).not.toHaveProperty("options");
	});

	it("throws a descriptive error on a non-ok response", async () => {
		stubFetch({ message: "not found" }, false, 404);
		await expect(retrieveDatabaseSchema("bad_db")).rejects.toThrow(
			/Notion retrieve database failed \(404\)/,
		);
	});

	it("authenticates with the provided workspace token (issue #424 defect 1)", async () => {
		const calls = stubFetch({ properties: {} });
		await retrieveDatabaseSchema("db_personal", "secret_personal_token");
		expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
			"Bearer secret_personal_token",
		);
	});
});

describe("block API (the State Doc's section writer, ADR-053)", () => {
	it("lists every child block, following the cursor to the end", async () => {
		const pages = [
			{ results: [{ id: "b1", type: "paragraph" }], has_more: true, next_cursor: "c2" },
			{ results: [{ id: "b2", type: "paragraph" }], has_more: false, next_cursor: null },
		];
		let call = 0;
		const calls: FetchCall[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				calls.push({ url, init: init as FetchCall["init"] });
				const payload = pages[call++];
				return { ok: true, status: 200, statusText: "OK", json: async () => payload } as Response;
			}),
		);

		const blocks = await listNotionBlockChildren("page9");

		expect(blocks.map((b) => b.id)).toEqual(["b1", "b2"]);
		expect(calls[0].url).toBe("https://api.notion.com/v1/blocks/page9/children?page_size=100");
		expect(calls[1].url).toContain("start_cursor=c2");
	});

	it("appends children after a named sibling so a section replace lands in place", async () => {
		const calls = stubFetch({});

		await appendNotionBlockChildren(
			"page9",
			[{ object: "block", type: "paragraph", paragraph: { rich_text: [] } }],
			{ after: "heading-block" },
		);

		expect(calls[0].url).toBe("https://api.notion.com/v1/blocks/page9/children");
		expect(calls[0].init.method).toBe("PATCH");
		expect(bodyOf(calls[0]).after).toBe("heading-block");
	});

	it("patches one block and deletes one block by id", async () => {
		const calls = stubFetch({});

		await updateNotionBlock("block1", { callout: { rich_text: [] } });
		await deleteNotionBlock("block2");

		expect(calls[0].url).toBe("https://api.notion.com/v1/blocks/block1");
		expect(calls[0].init.method).toBe("PATCH");
		expect(calls[1].url).toBe("https://api.notion.com/v1/blocks/block2");
		expect(calls[1].init.method).toBe("DELETE");
	});
});

describe("searchNotion", () => {
	it("POSTs to /v1/search with the workspace token, sorted by last_edited_time desc, and returns the page", async () => {
		const calls = stubFetch({
			results: [{ id: "p1" }, { id: "db1" }],
			next_cursor: "cursor-2",
			has_more: true,
		});

		const page = await searchNotion("secret_work_token");

		expect(page).toEqual({
			results: [{ id: "p1" }, { id: "db1" }],
			next_cursor: "cursor-2",
			has_more: true,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.notion.com/v1/search");
		expect(calls[0].init.method).toBe("POST");
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer secret_work_token");
		expect(headers["Notion-Version"]).toBe("2022-06-28");

		const body = bodyOf(calls[0]);
		expect(body.sort).toEqual({ direction: "descending", timestamp: "last_edited_time" });
		expect(body.page_size).toBe(100);
		// No object filter → both pages and databases are returned.
		expect(body.filter).toBeUndefined();
		// First page: no start_cursor.
		expect(body.start_cursor).toBeUndefined();
	});

	it("passes start_cursor when a cursor is supplied", async () => {
		const calls = stubFetch({ results: [], next_cursor: null, has_more: false });
		await searchNotion("t", { cursor: "abc123" });
		expect(bodyOf(calls[0]).start_cursor).toBe("abc123");
	});

	it("defaults missing pagination fields to empty/false", async () => {
		stubFetch({ results: undefined });
		const page = await searchNotion("t");
		expect(page).toEqual({ results: [], next_cursor: null, has_more: false });
	});

	it("throws a descriptive error on a non-ok response without retrying a non-429 4xx", async () => {
		const calls = stubFetch({ message: "unauthorized" }, false, 401);
		await expect(searchNotion("bad")).rejects.toThrow(/Notion search failed \(401\)/);
		expect(calls).toHaveLength(1);
	});

	it("retries a 429, honouring Retry-After, and succeeds on the next attempt (#474)", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const responses = [
			{
				ok: false,
				status: 429,
				statusText: "Too Many Requests",
				headers: new Headers({ "retry-after": "1" }),
				json: async () => ({}),
				text: async () => "rate limited",
			},
			{
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({ results: [{ id: "p1" }], next_cursor: null, has_more: false }),
				text: async () => "",
			},
		];
		const fetchMock = vi.fn(async () => responses.shift() as unknown as Response);
		vi.stubGlobal("fetch", fetchMock);

		const promise = searchNotion("t");
		await vi.runAllTimersAsync();

		await expect(promise).resolves.toEqual({
			results: [{ id: "p1" }],
			next_cursor: null,
			has_more: false,
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe("webhook-payload id encoding (#546 QA)", () => {
	// Page/data-source ids in these helpers can arrive from webhook payloads —
	// they must be treated as data, never as URL structure.
	const TRICKY_ID = "abc/../def?x=1";
	const ENCODED = encodeURIComponent(TRICKY_ID);

	it("retrieveNotionPage percent-encodes the page id", async () => {
		const calls = stubFetch({ id: "p1" });
		await retrieveNotionPage(TRICKY_ID, "tok");
		expect(calls[0].url).toContain(`/pages/${ENCODED}`);
		expect(calls[0].url).not.toContain("abc/../def");
	});

	it("updateNotionPageProperties percent-encodes the page id", async () => {
		const calls = stubFetch({});
		await updateNotionPageProperties(TRICKY_ID, { X: { date: null } }, "tok");
		expect(calls[0].url).toContain(`/pages/${ENCODED}`);
	});

	it("queryNotionDataSource percent-encodes the data source id", async () => {
		const calls = stubFetch({ results: [], next_cursor: null, has_more: false });
		await queryNotionDataSource(TRICKY_ID, "tok");
		expect(calls[0].url).toContain(`/data_sources/${ENCODED}/query`);
	});
});

describe("notionResultTitle", () => {
	it("extracts a database's top-level title, concatenating rich-text runs", () => {
		expect(
			notionResultTitle({
				id: "db1",
				object: "database",
				title: [{ plain_text: "Quarterly " }, { plain_text: "Roadmap" }],
			}),
		).toBe("Quarterly Roadmap");
	});

	it("extracts a page's title from the property whose type is 'title'", () => {
		expect(
			notionResultTitle({
				id: "p1",
				object: "page",
				properties: {
					Status: { type: "status" },
					Name: { type: "title", title: [{ plain_text: "Email supplier" }] },
				},
			}),
		).toBe("Email supplier");
	});

	it("falls back to 'Untitled' when no title text is present", () => {
		expect(notionResultTitle({ id: "x", properties: { Name: { type: "title", title: [] } } })).toBe(
			"Untitled",
		);
		expect(notionResultTitle({ id: "y" })).toBe("Untitled");
	});

	it("handles malformed non-array title values without throwing", () => {
		expect(
			notionResultTitle({
				id: "bad1",
				object: "database",
				title: { not: "an array" } as any,
			}),
		).toBe("Untitled");

		expect(
			notionResultTitle({
				id: "bad2",
				object: "database",
				title: "Direct string title" as any,
			}),
		).toBe("Direct string title");

		expect(
			notionResultTitle({
				id: "bad3",
				object: "page",
				properties: {
					Name: { type: "title", title: { malformed: true } as any },
				},
			}),
		).toBe("Untitled");
	});
});
