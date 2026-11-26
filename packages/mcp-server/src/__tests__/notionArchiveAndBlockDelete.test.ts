import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "../supabase.js";
import { notionBlockDeleteHandler } from "../tools/notionBlockDelete.js";
import { patchNotionPage } from "../notion.js";

// #1058. Archive/restore on notion_page_update, and notion_block_delete.
//
// Both are reversible — Notion's public API has no permanent delete, only a trash —
// so the risk here is not deletion. It is the two ways a reversible edit can still do
// damage: silently un-trashing a page nobody asked to restore, and editing the State
// Doc through a back door ADR-053's one-writer rule did not anticipate, by addressing
// its content one level down as a block id.

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const WORK_TOKEN = "Bearer secret_test_token";
const PAGE = "8db39ce2-4513-4593-9a57-f3a9a0a05ed7";
const STATE_DOC = "aaaabbbb-cccc-dddd-eeee-ffff00001111";
const BLOCK = "11112222-3333-4444-5555-666677778888";
const OUTER_BLOCK = "99998888-7777-6666-5555-444433332222";

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

type Call = { method: string; path: string; body?: any; auth?: string };

/** Records every Notion call. `blockParents` answers GET /v1/blocks/{id} with a parent
 *  pointer, which is what the block-delete guard walks. */
function fakeNotion(
	opts: { blockParents?: Record<string, unknown>; notFound?: boolean } = {},
): Call[] {
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
			const blockMatch = /^\/v1\/blocks\/([^/]+)$/.exec(path);
			const payload =
				blockMatch && method === "GET"
					? { id: blockMatch[1], type: "paragraph", parent: opts.blockParents?.[blockMatch[1]] }
					: { id: PAGE };
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

const textOf = (r: { content: { type: "text"; text: string }[] }) => r.content[0].text;
const patches = (calls: Call[]) => calls.filter((c) => c.method === "PATCH");
const deletes = (calls: Call[]) => calls.filter((c) => c.method === "DELETE");

describe("patchNotionPage — only the keys the caller supplied", () => {
	it("sends no `archived` key when the caller only patched properties", async () => {
		// The bug this blocks is silent and unreported: normalising an absent `archived`
		// to false would make every ordinary property patch ALSO restore the page from
		// trash. Someone archives a page deliberately, an unrelated automation stamps a
		// property on it, and the page is quietly back.
		const calls = fakeNotion();
		await patchNotionPage(PAGE, { properties: { Status: { select: { name: "Done" } } } }, "t");

		expect(patches(calls)).toHaveLength(1);
		expect(patches(calls)[0].body).toEqual({
			properties: { Status: { select: { name: "Done" } } },
		});
		expect(patches(calls)[0].body).not.toHaveProperty("archived");
		expect(patches(calls)[0].body).not.toHaveProperty("icon");
	});

	it("sends an explicit null icon, which is a real Notion instruction", async () => {
		// `icon: null` means "remove the icon". Collapsing undefined and null together
		// would make it unreachable.
		const calls = fakeNotion();
		await patchNotionPage(PAGE, { icon: null }, "t");

		expect(patches(calls)[0].body).toEqual({ icon: null });
	});
});

describe("notion_block_delete (#1058)", () => {
	it("deletes a block whose parent is an ordinary page, and calls it a trash move", async () => {
		stubIntegrations({ notion_work: { tasks_database_id: "db" } });
		const calls = fakeNotion({
			blockParents: { [BLOCK]: { type: "page_id", page_id: PAGE } },
		});

		const out = await notionBlockDeleteHandler({ domain: "work", block_id: BLOCK });

		expect(deletes(calls)).toHaveLength(1);
		expect(deletes(calls)[0].path).toContain(BLOCK);
		expect(deletes(calls)[0].auth).toBe(WORK_TOKEN);
		expect(textOf(out)).toContain("trash");
	});

	it("walks up nested block parents to find the owning page", async () => {
		// A block inside a toggle inside a column has a BLOCK parent, not a page one.
		// Stopping at the first parent would leave every nested block unguarded.
		stubIntegrations({ notion_work: { tasks_database_id: "db" } });
		const calls = fakeNotion({
			blockParents: {
				[BLOCK]: { type: "block_id", block_id: OUTER_BLOCK },
				[OUTER_BLOCK]: { type: "page_id", page_id: PAGE },
			},
		});

		await notionBlockDeleteHandler({ domain: "work", block_id: BLOCK });

		expect(deletes(calls)).toHaveLength(1);
	});

	it("refuses a block nested inside the State Doc, not just one addressed by page", async () => {
		// The whole reason this tool reads before it writes. Without the parent walk,
		// `notion_block_delete` would be an unguarded editor for the one page ADR-053
		// says has a single writer — reachable by anyone holding a block id.
		stubIntegrations({
			notion_personal: {
				tasks_database_id: "db-personal",
				state_doc_page_id: STATE_DOC.replace(/-/g, ""),
			},
		});
		const calls = fakeNotion({
			blockParents: {
				[BLOCK]: { type: "block_id", block_id: OUTER_BLOCK },
				[OUTER_BLOCK]: { type: "page_id", page_id: STATE_DOC },
			},
		});

		// Matched on `state_doc_update`, not on "State Doc": the UNRESOLVABLE-parent
		// refusal also says "the State Doc guard cannot be applied", so the looser
		// pattern passed even with the parent walk removed — it could not tell "this
		// IS the State Doc" from "we could not tell", which are different outcomes.
		await expect(
			notionBlockDeleteHandler({ domain: "angus", block_id: BLOCK }),
		).rejects.toThrow(/state_doc_update/);

		expect(deletes(calls)).toHaveLength(0);
	});

	it("refuses when the owning page cannot be resolved, rather than deleting unguarded", async () => {
		stubIntegrations({ notion_work: { tasks_database_id: "db" } });
		const calls = fakeNotion({
			blockParents: { [BLOCK]: { type: "database_id", database_id: "db-1" } },
		});

		await expect(
			notionBlockDeleteHandler({ domain: "work", block_id: BLOCK }),
		).rejects.toThrow(/Could not resolve which page/);

		expect(deletes(calls)).toHaveLength(0);
	});

	it("refuses a parent chain that never terminates, instead of walking forever", async () => {
		// A block whose parent is itself. Notion should never serve this, which is
		// exactly why an unbounded walk would hang rather than fail.
		stubIntegrations({ notion_work: { tasks_database_id: "db" } });
		const calls = fakeNotion({
			blockParents: { [BLOCK]: { type: "block_id", block_id: BLOCK } },
		});

		await expect(
			notionBlockDeleteHandler({ domain: "work", block_id: BLOCK }),
		).rejects.toThrow(/Could not resolve which page/);

		expect(deletes(calls)).toHaveLength(0);
	});

	it("refuses a missing block_id with a teaching error and deletes nothing", async () => {
		stubIntegrations({ notion_work: { tasks_database_id: "db" } });
		const calls = fakeNotion();

		await expect(notionBlockDeleteHandler({ domain: "work" })).rejects.toThrow(
			/block_id` is required/,
		);

		expect(calls).toHaveLength(0);
	});

	it("requires a domain, with no default", async () => {
		stubIntegrations({ notion_work: { tasks_database_id: "db" } });
		await expect(notionBlockDeleteHandler({ block_id: BLOCK })).rejects.toThrow(/domain/i);
	});

	it("teaches the cross-workspace retry on a 404 instead of reading as an outage", async () => {
		stubIntegrations({ notion_work: { tasks_database_id: "db" } });
		fakeNotion({ notFound: true });

		await expect(
			notionBlockDeleteHandler({ domain: "work", block_id: BLOCK }),
		).rejects.toThrow(/angus/);
	});
});
