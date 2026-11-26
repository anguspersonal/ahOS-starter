import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "../supabase.js";
import { notionDatabaseGetHandler } from "../tools/notionDatabaseGet.js";

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const MEETINGS_DB = "11112222-3333-4444-5555-666677778888";
const MEETINGS_DS = "99990000-1111-2222-3333-444455556666";

const MEETINGS_SCHEMA = {
	Name: { type: "title" },
	"Event time": { type: "date" },
	Type: { type: "select", select: { options: [{ name: "General" }, { name: "1:1" }] } },
	Tags: { type: "multi_select", multi_select: { options: [{ name: "Board" }] } },
};

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

function fakeNotion(
	stub: {
		schemas?: Record<string, Record<string, unknown>>;
		dataSources?: Record<string, string>;
		users?: unknown[];
	} = {},
) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init: RequestInit = {}) => {
			const href = typeof url === "string" ? url : url.toString();
			const method = init.method ?? "GET";
			const path = new URL(href).pathname;
			const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json });

			if (path.startsWith("/v1/data_sources/")) {
				const id = path.split("/")[3];
				const databaseId = stub.dataSources?.[id];
				if (!databaseId) {
					return {
						ok: false,
						status: 404,
						statusText: "Not Found",
						text: async () => JSON.stringify({ message: "Could not find data source" }),
					};
				}
				return ok({ parent: { type: "database_id", database_id: databaseId } });
			}

			if (path.startsWith("/v1/databases/")) {
				const id = path.split("/")[3];
				const properties = stub.schemas?.[id];
				if (!properties) {
					return {
						ok: false,
						status: 404,
						statusText: "Not Found",
						text: async () => JSON.stringify({ message: "Could not find database" }),
					};
				}
				return ok({ properties });
			}

			if (path === "/v1/users") {
				return ok({ results: stub.users ?? [], has_more: false, next_cursor: null });
			}

			throw new Error(`unexpected fetch: ${method} ${href}`);
		}),
	);
}

describe("notion_database_get", () => {
	it("returns property names, types and select options", async () => {
		stubIntegrations({ notion_work: {} });
		fakeNotion({ schemas: { [MEETINGS_DB]: MEETINGS_SCHEMA } });

		const out = await notionDatabaseGetHandler({ domain: "work", database_id: MEETINGS_DB } as any);

		expect(out.content[0].text).toMatch(/Name — title/);
		expect(out.content[0].text).toMatch(/Type — select \(options: General, 1:1\)/);
	});

	it("accepts a data source id too", async () => {
		stubIntegrations({ notion_work: {} });
		fakeNotion({ schemas: { [MEETINGS_DB]: MEETINGS_SCHEMA }, dataSources: { [MEETINGS_DS]: MEETINGS_DB } });

		const out = await notionDatabaseGetHandler({ domain: "work", data_source_id: MEETINGS_DS } as any);
		expect(out.content[0].text).toMatch(/Event time — date/);
	});

	it("refuses both ids at once", async () => {
		const err = await notionDatabaseGetHandler({
			domain: "work",
			database_id: MEETINGS_DB,
			data_source_id: MEETINGS_DS,
		} as any).catch((e) => e);
		expect(String(err)).toMatch(/exactly one of/i);
	});

	it("adds the cross-workspace hint on a 404", async () => {
		stubIntegrations({ notion_work: {} });
		fakeNotion({ schemas: {} });

		const err = await notionDatabaseGetHandler({ domain: "work", database_id: MEETINGS_DB } as any).catch(
			(e) => e,
		);
		expect(String(err)).toMatch(/retry with domain='angus'/);
	});
});
