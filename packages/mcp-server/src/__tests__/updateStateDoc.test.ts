import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { supabase } from "../supabase.js";
import type { NotionBlock } from "../notion.js";
import { blockPlainText } from "../stateDoc.js";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { createServer } from "../server.js";
import { renderSections, stateDocFixture } from "./stateDocFixture.js";

const updateStateDocHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("state_doc_update")!).handler(args);

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
function stubIntegrations(rows: Record<string, Record<string, unknown> | undefined>) {
	(supabase as any).from = vi.fn(() => {
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

const WORK_ROW = { tasks_database_id: "db1", state_doc_page_id: "sdp-1" };
const ANGUS_ROW = { tasks_database_id: "db-personal", state_doc_page_id: "sdp-angus" };
// Set by vitest.config.ts, one per workspace.
const WORK_TOKEN = "Bearer secret_test_token";
const ANGUS_TOKEN = "Bearer secret_personal_test_token";

type Call = { method: string; url: string; body?: any; auth?: string };

/**
 * An in-memory Notion page backed by a real block array, so a test can assert what the
 * PAGE looks like afterwards rather than only which requests were sent. Supports the
 * four calls the tool makes: list children, append children (with `after`), patch a
 * block, delete a block.
 */
function fakeNotion(blocks: NotionBlock[]): { calls: Call[]; writes: Call[] } {
	const calls: Call[] = [];
	let seq = 0;

	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit = {}) => {
			const method = init.method ?? "GET";
			const body = init.body ? JSON.parse(init.body as string) : undefined;
			const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
			calls.push({ method, url, body, auth });

			const path = new URL(url).pathname;
			const match = /^\/v1\/blocks\/([^/]+)(\/children)?$/.exec(path);
			if (!match) throw new Error(`fakeNotion: unexpected path ${path}`);
			const [, target, children] = match;

			const ok = (payload: unknown) =>
				({
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => payload,
					text: async () => JSON.stringify(payload),
				}) as Response;

			if (children && method === "GET") {
				// A copy, as the real call returns: the tool plans against a snapshot.
				return ok({ results: [...blocks], has_more: false, next_cursor: null });
			}

			if (children && method === "PATCH") {
				const created: NotionBlock[] = body.children.map((child: any) => {
					seq += 1;
					return { ...child, id: `new-${seq}` } as NotionBlock;
				});
				const at = body.after
					? blocks.findIndex((b) => b.id === body.after) + 1
					: blocks.length;
				blocks.splice(at, 0, ...created);
				return ok({ results: created });
			}

			if (method === "PATCH") {
				const block = blocks.find((b) => b.id === target);
				if (!block) throw new Error(`fakeNotion: no block ${target}`);
				// Notion replaces the fields it is given and leaves the rest (e.g. a
				// callout's icon) alone.
				for (const [key, value] of Object.entries(body)) {
					block[key] = { ...(block[key] as object), ...(value as object) };
				}
				return ok(block);
			}

			if (method === "DELETE") {
				const at = blocks.findIndex((b) => b.id === target);
				if (at === -1) throw new Error(`fakeNotion: no block ${target}`);
				blocks.splice(at, 1);
				return ok({ id: target, archived: true });
			}

			throw new Error(`fakeNotion: unexpected ${method} ${path}`);
		}),
	);

	// `writes` must stay live as calls accumulate, so expose a getter-backed view.
	return {
		calls,
		get writes() {
			return calls.filter((c) => c.method !== "GET");
		},
	} as { calls: Call[]; writes: Call[] };
}

/**
 * Like fakeNotion, but the `writeIndex`th write (1-based, GETs don't count) throws
 * instead of applying — so a test can assert what a mid-plan Notion 429/5xx actually
 * leaves behind on the page, not just that the writes were issued in some order. Every
 * write before `writeIndex` still applies to `blocks`, exactly as in the real
 * multi-step plans `replace`/`delete` build.
 */
function fakeNotionFailingOnWrite(
	blocks: NotionBlock[],
	writeIndex: number,
): { calls: Call[]; writes: Call[] } {
	const notion = fakeNotion(blocks);
	const real = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
	let writeCount = 0;

	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit = {}) => {
			const method = init.method ?? "GET";
			if (method !== "GET") {
				writeCount += 1;
				if (writeCount === writeIndex) {
					throw new Error("fakeNotion: simulated 5xx mid-plan");
				}
			}
			return real(url, init);
		}),
	);

	return notion;
}

let page: NotionBlock[];

beforeEach(() => {
	page = stateDocFixture();
	stubIntegrations({ notion_work: WORK_ROW, notion_personal: ANGUS_ROW });
	// Only Date is faked — the stamp is date-derived and must be assertable.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-08-10T09:00:00Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("the retired append-only surface", () => {
	it("rejects an old-style heading + body call, naming the operations that replaced it", async () => {
		const notion = fakeNotion(page);
		await expect(updateStateDocHandler({ heading: "EOD 2026-06-10", body: "x" })).rejects.toThrow(
			/`op` is required — one of replace \| rename \| insert \| delete/,
		);
		await expect(updateStateDocHandler({ heading: "EOD 2026-06-10", body: "x" })).rejects.toThrow(
			/op:'replace'/,
		);
		expect(notion.calls).toHaveLength(0);
	});

	it("rejects arguments that mean nothing for the chosen op", async () => {
		fakeNotion(page);
		await expect(
			updateStateDocHandler({ domain: "work", op: "delete", heading: "🧱 Tech stack", body: "oops" }),
		).rejects.toThrow(/op:'delete' does not take `body`/);
	});
});

/**
 * The tests above call `updateStateDocHandler` directly, which bypasses the MCP SDK's
 * own input validation entirely. That matters here specifically: `domain` and `op` are
 * `z.enum(...)` fields in `updateStateDocInput`, and the SDK's `validateToolInput`
 * (`safeParseAsync` against that shape, in `@modelcontextprotocol/sdk`'s
 * `server/mcp.js`) runs — and can reject the call — *before* the handler, and
 * therefore the ADR-053 messages above, ever run. A round trip through a real
 * `McpServer` + `Client` over an in-memory transport is the only way to prove the
 * retired-surface message in this file is reachable through `state_doc_update` as
 * registered, not just through the handler function in isolation.
 */
describe("the retired append-only surface, through the real registered MCP tool", () => {
	it("forwards an old-style heading + body call (no domain, no op) to the handler's own ADR-053 error, rather than a generic schema-validation rejection", async () => {
		const server = createServer();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "0.0.0" });

		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		const result = await client.callTool({
			name: "state_doc_update",
			arguments: { heading: "EOD 2026-06-10", body: "x" },
		});

		expect(result.isError).toBe(true);
		const text = (result.content as { type: "text"; text: string }[])[0].text;
		expect(text).toMatch(/`op` is required — one of replace \| rename \| insert \| delete/);
		expect(text).toMatch(/op:'replace'/);

		await client.close();
		await server.close();
	});

	it("still rejects a malformed (not merely missing) op at the schema layer", async () => {
		const server = createServer();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "0.0.0" });

		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		// `.optional()` on `op`/`domain` (see updateStateDocInput) is meant to let an
		// OMITTED value reach the handler's own error — not to let a WRONG value
		// through. A bogus enum member must still fail before the handler runs. The SDK
		// surfaces this as a resolved, `isError: true` CallToolResult (it catches its
		// own McpError rather than letting it reject the RPC call) — never as a call
		// into `updateStateDocHandler`.
		const result = await client.callTool({
			name: "state_doc_update",
			arguments: { domain: "work", op: "not-a-real-op", heading: "x", body: "y" },
		});

		expect(result.isError).toBe(true);
		const text = (result.content as { type: "text"; text: string }[])[0].text;
		expect(text).toMatch(/Invalid arguments for tool state_doc_update/);
		expect(text).not.toMatch(/`op` is required/); // must fail at the schema layer, not the handler

		await client.close();
		await server.close();
	});
});

describe("configuration", () => {
	it("errors when no state_doc_page_id is configured", async () => {
		stubIntegrations({ notion_work: { tasks_database_id: "db1" } });
		await expect(
			updateStateDocHandler({ domain: "work", op: "replace", heading: "🧱 Tech stack", body: "x" }),
		).rejects.toThrow(/No state_doc_page_id/);
	});

	it("points at the current 'notion_work' row name (not the legacy 'notion' row)", async () => {
		stubIntegrations({ notion_work: { tasks_database_id: "db1" } });
		await expect(
			updateStateDocHandler({ domain: "work", op: "replace", heading: "🧱 Tech stack", body: "x" }),
		).rejects.toThrow(/'notion_work' row/);
	});
});

describe("domain routing", () => {
	it("requires a domain rather than defaulting to one", async () => {
		const notion = fakeNotion(page);
		await expect(
			updateStateDocHandler({ op: "delete", heading: "🧱 Tech stack" }),
		).rejects.toThrow(/`domain` is required/);
		expect(notion.calls).toHaveLength(0);
	});

	it("routes 'work' to the Work row and the Work token", async () => {
		const notion = fakeNotion(page);
		await updateStateDocHandler({ domain: "work", op: "delete", heading: "🧱 Tech stack" });

		expect(notion.calls[0].url).toBe("https://api.notion.com/v1/blocks/sdp-1/children?page_size=100");
		expect(notion.calls.map((c) => c.auth)).toEqual(notion.calls.map(() => WORK_TOKEN));
	});

	it("routes 'angus' to the personal row and the PERSONAL token, on every call", async () => {
		const notion = fakeNotion(page);
		await updateStateDocHandler({
			domain: "angus",
			op: "replace",
			heading: "🧱 Tech stack",
			body: "- A personal stack line",
		});

		// The page pointer comes from the personal row…
		expect(notion.calls[0].url).toBe(
			"https://api.notion.com/v1/blocks/sdp-angus/children?page_size=100",
		);
		// …and every request — read, append, delete, and the Last updated stamp — carries
		// the personal token. A test that only checked which config row was read would
		// pass while every request still went to the Work workspace (#424 defect 1).
		expect(notion.calls.length).toBeGreaterThan(3);
		expect(notion.calls.map((c) => c.auth)).toEqual(notion.calls.map(() => ANGUS_TOKEN));
		expect(notion.writes.map((c) => c.method)).toEqual(["PATCH", "DELETE", "PATCH"]);
	});

	it("fails loudly when 'angus' is selected but unwired, naming the call that wires it", async () => {
		stubIntegrations({ notion_work: WORK_ROW, notion_personal: undefined });
		const notion = fakeNotion(page);

		const call = updateStateDocHandler({ domain: "angus", op: "delete", heading: "🧱 Tech stack" });

		await expect(call).rejects.toThrow(/No state_doc_page_id for domain 'angus'/);
		await expect(call).rejects.toThrow(/integration_set\(\{ provider: 'notion_personal'/);
		await expect(call).rejects.toThrow(/Connections → ahKMS/);
		// Not a silent no-op, and above all not a fall back to the Work page.
		expect(notion.calls).toHaveLength(0);
	});

	it("does not fall back to Work when the personal row exists but carries no pointer", async () => {
		stubIntegrations({
			notion_work: WORK_ROW,
			notion_personal: { tasks_database_id: "db-personal" },
		});
		const notion = fakeNotion(page);

		await expect(
			updateStateDocHandler({ domain: "angus", op: "delete", heading: "🧱 Tech stack" }),
		).rejects.toThrow(/domain 'angus'/);
		expect(notion.calls).toHaveLength(0);
	});
});

describe("addressing errors write nothing", () => {
	it("refuses a heading that is not on the page", async () => {
		const notion = fakeNotion(page);
		await expect(
			updateStateDocHandler({ domain: "work", op: "replace", heading: "Open Actions", body: "x" }),
		).rejects.toThrow(/No section headed "Open Actions"/);
		expect(notion.writes).toHaveLength(0);
	});

	it("refuses an ambiguous heading rather than guessing", async () => {
		page.push({ ...page[8], id: "dupe" });
		const notion = fakeNotion(page);
		await expect(
			updateStateDocHandler({ domain: "work", op: "replace", heading: "📌 Open Actions", body: "x" }),
		).rejects.toThrow(/matches 2 headings/);
		expect(notion.writes).toHaveLength(0);
	});

	it("refuses to create a duplicate heading", async () => {
		const notion = fakeNotion(page);
		await expect(
			updateStateDocHandler({ domain: "work", op: "insert", new_heading: "🧱 Tech stack", body: "x", at_end: true }),
		).rejects.toThrow(/already a heading/);
		expect(notion.writes).toHaveLength(0);
	});
});

describe("op: replace", () => {
	it("leaves every other section byte-identical", async () => {
		const before = renderSections(page);
		fakeNotion(page);

		await updateStateDocHandler({
			domain: "work",
			op: "replace",
			heading: "🎯 This week focus — Week 27 Jul – 2 Aug 2026",
			body: "- Ship 4.8\n- Sign the pilot",
		});

		const after = renderSections(page);
		const target = "🎯 This week focus — Week 27 Jul – 2 Aug 2026";

		// The stray `#` sits second among fifteen `##`s on the real page. Under the
		// conventional same-or-higher-level rule this replace would have swallowed every
		// section below it; under the flat-span rule they are untouched.
		expect(Object.keys(after)).toEqual(Object.keys(before));
		for (const heading of Object.keys(before)) {
			if (heading === target || heading === "(page header)") continue;
			expect(after[heading]).toBe(before[heading]);
		}

		expect(after[target]).toBe("bulleted_list_item\tShip 4.8\nbulleted_list_item\tSign the pilot");
	});

	it("inserts the new body before deleting the old, so a mid-way failure duplicates rather than empties", async () => {
		const notion = fakeNotion(page);
		await updateStateDocHandler({ domain: "work", op: "replace", heading: "🧱 Tech stack", body: "Next.js only." });

		expect(notion.writes.map((c) => c.method)).toEqual(["PATCH", "DELETE", "PATCH"]);
		const [append] = notion.writes;
		expect(append.url).toBe("https://api.notion.com/v1/blocks/sdp-1/children");
		expect(append.body.after).toBe(page.find((b) => blockPlainText(b) === "🧱 Tech stack")!.id);
	});

	it("reports what it did", async () => {
		fakeNotion(page);
		const out = await updateStateDocHandler({
			domain: "work",
			op: "replace",
			heading: "🧱 Tech stack",
			body: "Next.js, Supabase.",
		});
		expect(out.content[0].text).toContain('replaced section "🧱 Tech stack" (1 block(s) → 1)');
	});

	it("leaves the section DUPLICATED, not emptied, when the write fails between the insert and the delete", async () => {
		// Write #1 is the append (succeeds), write #2 is the first old-block delete
		// (fails) — exactly the gap the insert-before-delete ordering exists to protect.
		fakeNotionFailingOnWrite(page, 2);

		await expect(
			updateStateDocHandler({
				domain: "work",
				op: "replace",
				heading: "🧱 Tech stack",
				body: "Next.js only.",
			}),
		).rejects.toThrow(/simulated 5xx/);

		const after = renderSections(page);
		// Both the old body and the new body are present under the one heading: visible
		// and fixable by a human/agent, never silently lost.
		expect(after["🧱 Tech stack"]).toContain("Next.js, Supabase, Railway.");
		expect(after["🧱 Tech stack"]).toContain("Next.js only.");
	});
});

describe("op: rename", () => {
	it("rewrites the heading and leaves the body alone when no body is given", async () => {
		const before = renderSections(page);
		fakeNotion(page);

		await updateStateDocHandler({
			domain: "work",
			op: "rename",
			heading: "🎯 This week focus — Week 27 Jul – 2 Aug 2026",
			new_heading: "🎯 This week focus — Week 3 – 9 Aug 2026",
		});

		const after = renderSections(page);
		expect(after["🎯 This week focus — Week 3 – 9 Aug 2026"]).toBe(
			before["🎯 This week focus — Week 27 Jul – 2 Aug 2026"],
		);
		expect(after["🎯 This week focus — Week 27 Jul – 2 Aug 2026"]).toBeUndefined();
		// The heading keeps its level: a rename is not a re-level.
		expect(page.find((b) => blockPlainText(b).startsWith("🎯"))!.type).toBe("heading_1");
	});

	it("replaces heading and body in one call", async () => {
		fakeNotion(page);
		await updateStateDocHandler({
			domain: "work",
			op: "rename",
			heading: "🎯 This week focus — Week 27 Jul – 2 Aug 2026",
			new_heading: "🎯 This week focus — Week 3 – 9 Aug 2026",
			body: "- New focus",
		});

		expect(renderSections(page)["🎯 This week focus — Week 3 – 9 Aug 2026"]).toBe(
			"bulleted_list_item\tNew focus",
		);
	});

	it("refuses a rename to the heading it already has", async () => {
		fakeNotion(page);
		await expect(
			updateStateDocHandler({ domain: "work", op: "rename", heading: "🧱 Tech stack", new_heading: "🧱 Tech stack" }),
		).rejects.toThrow(/identical to `heading`/);
	});
});

describe("op: insert", () => {
	it("places a new section after the whole anchor section, not inside it", async () => {
		fakeNotion(page);
		await updateStateDocHandler({
			domain: "work",
			op: "insert",
			new_heading: "🧪 Experiments",
			body: "- Try the new onboarding",
			after_heading: "📌 Open Actions",
		});

		const headings = page.filter((b) => b.type.startsWith("heading_")).map(blockPlainText);
		expect(headings).toEqual([
			"🏢 Company snapshot",
			"🎯 This week focus — Week 27 Jul – 2 Aug 2026",
			"📌 Open Actions",
			"🧪 Experiments",
			"📣 Recent communications log",
			"🚧 Known blockers",
			"🧱 Tech stack",
			"⚖️ Legal / Compliance",
		]);
		expect(renderSections(page)["📌 Open Actions"]).toContain("Chase Mitesh for PR fix ETA");
	});

	it("places a new section immediately before an anchor", async () => {
		fakeNotion(page);
		await updateStateDocHandler({
			domain: "work",
			op: "insert",
			new_heading: "🧪 Experiments",
			body: "- Try it",
			before_heading: "📌 Open Actions",
		});

		const headings = page.filter((b) => b.type.startsWith("heading_")).map(blockPlainText);
		expect(headings[2]).toBe("🧪 Experiments");
		expect(headings[3]).toBe("📌 Open Actions");
	});

	it("appends at the end of the page", async () => {
		fakeNotion(page);
		await updateStateDocHandler({
			domain: "work",
			op: "insert",
			new_heading: "🧪 Experiments",
			body: "- Try it",
			at_end: true,
			heading_level: 2,
		});

		expect(blockPlainText(page[page.length - 2])).toBe("🧪 Experiments");
		expect(page[page.length - 2].type).toBe("heading_2");
	});

	it("requires exactly one anchor", async () => {
		const notion = fakeNotion(page);
		await expect(
			updateStateDocHandler({ domain: "work", op: "insert", new_heading: "🧪 Experiments", body: "x" }),
		).rejects.toThrow(/exactly one anchor/);
		await expect(
			updateStateDocHandler({
				domain: "work",
				op: "insert",
				new_heading: "🧪 Experiments",
				body: "x",
				at_end: true,
				before_heading: "📌 Open Actions",
			}),
		).rejects.toThrow(/exactly one anchor/);
		expect(notion.writes).toHaveLength(0);
	});
});

describe("op: delete", () => {
	it("removes the heading and its body, and nothing else", async () => {
		const before = renderSections(page);
		fakeNotion(page);

		await updateStateDocHandler({ domain: "work", op: "delete", heading: "🧱 Tech stack" });

		const after = renderSections(page);
		expect(after["🧱 Tech stack"]).toBeUndefined();
		for (const heading of Object.keys(after)) {
			if (heading === "(page header)") continue;
			expect(after[heading]).toBe(before[heading]);
		}
	});

	it("deletes body blocks before the heading", async () => {
		const headingBlock = page.find((b) => blockPlainText(b) === "🧱 Tech stack")!;
		const bodyBlock = page.find((b) => blockPlainText(b) === "Next.js, Supabase, Railway.")!;
		const notion = fakeNotion(page);

		await updateStateDocHandler({ domain: "work", op: "delete", heading: "🧱 Tech stack" });

		// Third write is the "Last updated" stamp (a PATCH on the header callout) —
		// unrelated to the body/heading ordering under test.
		expect(notion.writes.map((c) => c.method)).toEqual(["DELETE", "DELETE", "PATCH"]);
		expect(notion.writes[0].url).toBe(`https://api.notion.com/v1/blocks/${bodyBlock.id}`);
		expect(notion.writes[1].url).toBe(`https://api.notion.com/v1/blocks/${headingBlock.id}`);
	});

	it("leaves the heading — addressable, if incomplete — rather than orphaning the body, when the write fails between the body-delete and the heading-delete", async () => {
		// Write #1 is the body-block delete (succeeds), write #2 is the heading delete
		// (fails) — the gap the body-before-heading ordering exists to protect.
		fakeNotionFailingOnWrite(page, 2);

		await expect(
			updateStateDocHandler({ domain: "work", op: "delete", heading: "🧱 Tech stack" }),
		).rejects.toThrow(/simulated 5xx/);

		const after = renderSections(page);
		// The heading survived: the section is still on the page and still addressable
		// by heading (re-running op:'delete' on the same heading finishes the job),
		// never left as a body block silently annexed into the section before it.
		expect(Object.keys(after)).toContain("🧱 Tech stack");
		expect(after["🧱 Tech stack"]).toBe("");
	});
});

describe("the Last updated stamp", () => {
	it("is written on every successful mutation, naming the op and the section", async () => {
		fakeNotion(page);
		const out = await updateStateDocHandler({
			domain: "work",
			op: "replace",
			heading: "🧱 Tech stack",
			body: "Next.js only.",
		});

		const callout = blockPlainText(page[0]);
		expect(callout.split("\n")[0]).toBe(
			'📌 Last updated: 2026-08-10 (state_doc_update: replace "🧱 Tech stack")',
		);
		expect(out.content[0].text).toContain("Stamped: Last updated: 2026-08-10");
	});

	it("leaves Sole writer and Read by in the same callout untouched", async () => {
		fakeNotion(page);
		await updateStateDocHandler({ domain: "work", op: "delete", heading: "🧱 Tech stack" });

		const lines = blockPlainText(page[0]).split("\n");
		expect(lines.slice(1)).toEqual([
			"Sole writer: dos-hl ritual",
			"Read by: every operating-partner session",
		]);
	});

	it("goes through the block API against that block, never the page content path", async () => {
		const notion = fakeNotion(page);
		await updateStateDocHandler({ domain: "work", op: "delete", heading: "🧱 Tech stack" });

		const stamp = notion.writes[notion.writes.length - 1];
		expect(stamp.method).toBe("PATCH");
		expect(stamp.url).toBe(`https://api.notion.com/v1/blocks/${page[0].id}`);
		expect(Object.keys(stamp.body)).toEqual(["callout"]);
		expect(notion.calls.some((c) => c.url.includes("/v1/pages/"))).toBe(false);
	});

	it("reports rather than throws when the page has no Last updated line", async () => {
		page = page.slice(1); // drop the header callout
		fakeNotion(page);

		const out = await updateStateDocHandler({ domain: "work", op: "delete", heading: "🧱 Tech stack" });
		expect(out.content[0].text).toContain("nothing was stamped");
		expect(page.some((b) => blockPlainText(b) === "🧱 Tech stack")).toBe(false);
	});
});
