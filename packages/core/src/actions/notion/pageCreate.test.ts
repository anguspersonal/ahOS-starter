import { describe, expect, it, vi } from "vitest";
import { createNotionPageCreateAction } from "./pageCreate.js";
import { ExternalItemCreatedButUnreadable } from "../outwardWrite.js";
import type { NotionPort } from "../../ports/notion.js";

const MEETINGS_DB = "11112222-3333-4444-5555-666677778888";
const MEETINGS_DS = "99990000-1111-2222-3333-444455556666";
const STATE_DOC = "aaaabbbb-cccc-dddd-eeee-ffff00001111";
const ORDINARY_PAGE = "12121212-3434-5656-7878-909090909090";
const DAILY_LOG_DB = "35ab7b8b-edcd-811a-a3bc-e37d4ced1d87";
const DAILY_LOG_DS = "35ab7b8b-edcd-8179-b15d-000b26ea11fd";

const MEETINGS_SCHEMA = {
	Name: { type: "title" },
	"Event time": { type: "date" },
	Type: { type: "select", select: { options: [{ name: "General" }, { name: "1:1" }] } },
	Tags: { type: "multi_select", multi_select: { options: [{ name: "Board" }] } },
};

const DAILY_LOG_SCHEMA = { Name: { type: "title" }, Date: { type: "date" } };
const ctx = { caller: "test", requestId: "req-1" };

function notFound(msg: string) {
	return Object.assign(new Error(msg), { name: "NotionApiError" as const, status: 404 });
}

function fakePort(
	stub: {
		schemas?: Record<string, Record<string, any>>;
		dataSources?: Record<string, string>;
		stateDocId?: string;
		dailyLogIds?: string[];
		unwiredStateDoc?: boolean;
		unwiredDailyLog?: boolean;
		unreadableCreate?: boolean;
		failAppend?: boolean;
	} = {},
): NotionPort {
	return {
		resolveToken: vi.fn(async (w) => `token_${w}`),
		search: vi.fn(),
		retrievePage: vi.fn(),
		listBlockChildren: vi.fn(),
		retrieveDatabase: vi.fn(async ({ databaseId }) => {
			const properties = stub.schemas?.[databaseId];
			if (!properties) throw notFound("Notion retrieve database failed (404): Could not find database");
			return { id: databaseId, properties };
		}),
		retrieveDataSource: vi.fn(async ({ dataSourceId }) => {
			const databaseId = stub.dataSources?.[dataSourceId];
			if (!databaseId) throw notFound("Notion retrieve data source failed (404): Could not find data source");
			return { id: dataSourceId, parent: { type: "database_id", database_id: databaseId } };
		}),
		queryDataSource: vi.fn(),
		retrieveBlock: vi.fn(),
		deleteBlock: vi.fn(),
		listComments: vi.fn(),
		createComment: vi.fn(),
		createPage: vi.fn(async () => {
			if (stub.unreadableCreate) {
				throw new ExternalItemCreatedButUnreadable("Notion page", new Error("Unexpected end of JSON input"));
			}
			return { id: "created-page-id", url: "https://notion.so/created-page-id" };
		}),
		appendBlockChildren: vi.fn(async () => {
			if (stub.failAppend) throw new Error("Notion append block children failed (500): boom");
		}),
		...(stub.unwiredStateDoc ? {} : { getStateDocPageId: vi.fn(async () => stub.stateDocId) }),
		...(stub.unwiredDailyLog ? {} : { getDailyLogTargetIds: vi.fn(async () => stub.dailyLogIds ?? []) }),
	};
}

describe("notion_page_create — validation happens before any write", () => {
	it("refuses an unknown property name and names the valid ones", async () => {
		const port = fakePort({ schemas: { [MEETINGS_DB]: MEETINGS_SCHEMA } });
		const err = await createNotionPageCreateAction(port)
			.run(
				{
					domain: "work",
					database_id: MEETINGS_DB,
					title: "Board sync",
					properties: { Attendeez: { rich_text: [] } },
				},
				ctx,
			)
			.catch((e) => e);

		expect(String(err)).toMatch(/Unknown property for this database: 'Attendeez'/);
		expect(String(err)).toMatch(/Event time/);
		expect(port.createPage).not.toHaveBeenCalled();
	});

	it("refuses an invalid select option — Notion would have created it silently", async () => {
		const port = fakePort({ schemas: { [MEETINGS_DB]: MEETINGS_SCHEMA } });
		const err = await createNotionPageCreateAction(port)
			.run(
				{
					domain: "work",
					database_id: MEETINGS_DB,
					title: "Board sync",
					properties: { Type: { select: { name: "Genral" } } },
				},
				ctx,
			)
			.catch((e) => e);

		expect(String(err)).toMatch(/'Type' does not have option 'Genral'/);
		expect(String(err)).toMatch(/General \| 1:1/);
		expect(port.createPage).not.toHaveBeenCalled();
	});

	it("refuses `properties` that also sets the title, rather than picking a winner", async () => {
		const port = fakePort({ schemas: { [MEETINGS_DB]: MEETINGS_SCHEMA } });
		const err = await createNotionPageCreateAction(port)
			.run(
				{
					domain: "work",
					database_id: MEETINGS_DB,
					title: "Board sync",
					properties: { Name: { title: [{ text: { content: "Something else" } }] } },
				},
				ctx,
			)
			.catch((e) => e);

		expect(String(err)).toMatch(/must not set 'Name'/);
		expect(port.createPage).not.toHaveBeenCalled();
	});

	it("requires exactly one parent", async () => {
		const port = fakePort();
		const action = createNotionPageCreateAction(port);

		const none = await action.run({ domain: "work", title: "x" }, ctx).catch((e) => e);
		expect(String(none)).toMatch(/exactly one parent/);

		const both = await action
			.run({ domain: "work", database_id: MEETINGS_DB, parent_page_id: ORDINARY_PAGE, title: "x" }, ctx)
			.catch((e) => e);
		expect(String(both)).toMatch(/exactly one parent, not 2/);
		expect(port.createPage).not.toHaveBeenCalled();
	});

	it("requires a domain, with no default", async () => {
		const port = fakePort();
		const err = await createNotionPageCreateAction(port)
			.run({ database_id: MEETINGS_DB, title: "x" } as any, ctx)
			.catch((e) => e);
		expect(String(err)).toMatch(/`domain` is required/);
		expect(port.createPage).not.toHaveBeenCalled();
	});
});

describe("notion_page_create — the State Doc stays single-writer (ADR-053)", () => {
	it("refuses the State Doc as a page parent and names state_doc_update", async () => {
		const port = fakePort({ stateDocId: STATE_DOC });
		const err = await createNotionPageCreateAction(port)
			.run({ domain: "work", parent_page_id: STATE_DOC, title: "sneaky child page" }, ctx)
			.catch((e) => e);

		expect(String(err)).toMatch(/State Doc/);
		expect(String(err)).toMatch(/state_doc_update/);
		expect(port.createPage).not.toHaveBeenCalled();
	});

	it("refuses it however the id is spelled — undashed, and as a URL", async () => {
		const port = fakePort({ stateDocId: STATE_DOC });
		const action = createNotionPageCreateAction(port);

		for (const spelling of [
			STATE_DOC.replace(/-/g, ""),
			`https://www.notion.so/Weekly-State-${STATE_DOC.replace(/-/g, "")}`,
		]) {
			const err = await action
				.run({ domain: "work", parent_page_id: spelling, title: "sneaky" }, ctx)
				.catch((e) => e);
			expect(String(err)).toMatch(/State Doc/);
		}
		expect(port.createPage).not.toHaveBeenCalled();
	});

	it("refuses instead of writing when getStateDocPageId is unwired", async () => {
		const port = fakePort({ unwiredStateDoc: true });
		const err = await createNotionPageCreateAction(port)
			.run({ domain: "work", parent_page_id: ORDINARY_PAGE, title: "child" }, ctx)
			.catch((e) => e);

		expect(String(err)).toMatch(/getStateDocPageId.*is not wired/);
		expect(port.createPage).not.toHaveBeenCalled();
	});
});

describe("notion_page_create — the Daily Log stays single-writer (#1017)", () => {
	it("refuses the domain's Daily Log database and names daily_log_create and capture", async () => {
		const port = fakePort({
			schemas: { [DAILY_LOG_DB]: DAILY_LOG_SCHEMA },
			dailyLogIds: [DAILY_LOG_DB],
		});
		const err = await createNotionPageCreateAction(port)
			.run(
				{
					domain: "angus",
					database_id: DAILY_LOG_DB,
					title: "Daily Log — Monday 14 September 2026",
					properties: { Date: { date: { start: "2026-09-14" } } },
				},
				ctx,
			)
			.catch((e) => e);

		expect(String(err)).toMatch(/Daily Log/);
		expect(String(err)).toMatch(/daily_log_create/);
		expect(String(err)).toMatch(/capture/);
		expect(port.createPage).not.toHaveBeenCalled();
	});

	it("refuses it by data source id too, before any Notion call", async () => {
		const port = fakePort({
			schemas: { [DAILY_LOG_DB]: DAILY_LOG_SCHEMA },
			dataSources: { [DAILY_LOG_DS]: DAILY_LOG_DB },
			dailyLogIds: [DAILY_LOG_DB, DAILY_LOG_DS],
		});
		const err = await createNotionPageCreateAction(port)
			.run(
				{
					domain: "work",
					data_source_id: DAILY_LOG_DS.replace(/-/g, ""),
					title: "GCP Billing Migration",
				},
				ctx,
			)
			.catch((e) => e);

		expect(String(err)).toMatch(/Daily Log/);
		expect(port.retrieveDataSource).not.toHaveBeenCalled();
		expect(port.createPage).not.toHaveBeenCalled();
	});

	it("refuses a data source the config does not name when it resolves to the Daily Log", async () => {
		const port = fakePort({
			schemas: { [DAILY_LOG_DB]: DAILY_LOG_SCHEMA },
			dataSources: { [DAILY_LOG_DS]: DAILY_LOG_DB },
			dailyLogIds: [DAILY_LOG_DB],
		});
		const err = await createNotionPageCreateAction(port)
			.run({ domain: "work", data_source_id: DAILY_LOG_DS, title: "Fleet pre-flight" }, ctx)
			.catch((e) => e);

		expect(String(err)).toMatch(/Daily Log/);
		expect(port.createPage).not.toHaveBeenCalled();
	});
});

describe("notion_page_create — writes", () => {
	it("creates a database row, discovering the title property from the schema", async () => {
		const port = fakePort({ schemas: { [MEETINGS_DB]: MEETINGS_SCHEMA } });
		const action = createNotionPageCreateAction(port);
		const out = await action.run(
			{
				domain: "work",
				database_id: MEETINGS_DB,
				title: "Board sync",
				properties: {
					"Event time": { date: { start: "2026-09-14T10:00:00Z" } },
					Type: { select: { name: "General" } },
				},
				body: "## Agenda\n- one\n- two",
			},
			ctx,
		);

		const call = vi.mocked(port.createPage).mock.calls[0][0];
		expect(call.databaseId).toBe(MEETINGS_DB);
		expect((call.properties.Name as any).title[0].text.content).toBe("Board sync");
		expect(call.properties.Type).toEqual({ select: { name: "General" } });
		expect(call.children?.length).toBeGreaterThan(0);
		expect(action.formatMcp!(out)).toMatch(/created-page-id/);
	});

	it("resolves a data source id to its database, because the write pin needs database_id", async () => {
		const port = fakePort({
			schemas: { [MEETINGS_DB]: MEETINGS_SCHEMA },
			dataSources: { [MEETINGS_DS]: MEETINGS_DB },
		});
		await createNotionPageCreateAction(port).run(
			{ domain: "work", data_source_id: MEETINGS_DS, title: "Board sync" },
			ctx,
		);

		expect(vi.mocked(port.createPage).mock.calls[0][0].databaseId).toBe(MEETINGS_DB);
	});

	it("creates a child page under an ordinary page, with no schema read", async () => {
		const port = fakePort();
		await createNotionPageCreateAction(port).run(
			{ domain: "angus", parent_page_id: ORDINARY_PAGE, title: "Scratch", icon: "📝" },
			ctx,
		);

		const call = vi.mocked(port.createPage).mock.calls[0][0];
		expect(call.workspace).toBe("angus");
		expect(call.parentPageId).toBe(ORDINARY_PAGE);
		expect(call.icon).toEqual({ emoji: "📝" });
		expect(port.retrieveDatabase).not.toHaveBeenCalled();
	});

	it("150 body blocks produce one create with 100 children and one append of 50 under the domain workspace", async () => {
		const port = fakePort();
		const body = Array.from({ length: 150 }, (_, i) => `- line ${i}`).join("\n");

		await createNotionPageCreateAction(port).run(
			{ domain: "angus", parent_page_id: ORDINARY_PAGE, title: "Long", body },
			ctx,
		);

		expect(port.createPage).toHaveBeenCalledTimes(1);
		expect(vi.mocked(port.createPage).mock.calls[0][0].workspace).toBe("angus");
		expect(vi.mocked(port.createPage).mock.calls[0][0].children).toHaveLength(100);
		expect(port.appendBlockChildren).toHaveBeenCalledTimes(1);
		const appendCall = vi.mocked(port.appendBlockChildren).mock.calls[0][0];
		expect(appendCall.workspace).toBe("angus");
		expect(appendCall.blockId).toBe("created-page-id");
		expect(appendCall.children).toHaveLength(50);
	});

	it("reports a truncated body rather than throwing — the page already exists", async () => {
		const port = fakePort({ failAppend: true });
		const action = createNotionPageCreateAction(port);
		const body = Array.from({ length: 130 }, (_, i) => `- line ${i}`).join("\n");
		const out = await action.run(
			{ domain: "angus", parent_page_id: ORDINARY_PAGE, title: "Long", body },
			ctx,
		);

		expect(out.page_id).toBe("created-page-id");
		expect(out.domain).toBe("angus");
		expect(out.unappended_block_count).toBe(30);
		expect(action.formatMcp!(out)).toMatch(/could not be appended/);
		expect(action.formatMcp!(out)).toMatch(/created-page-id/);
	});

	it("says the page exists when Notion's response is unreadable, and forbids a retry", async () => {
		const port = fakePort({ unreadableCreate: true });
		const action = createNotionPageCreateAction(port);
		const out = await action.run(
			{ domain: "angus", parent_page_id: ORDINARY_PAGE, title: "Ghost" },
			ctx,
		);

		expect(out.unreadable).toBe(true);
		expect(out.domain).toBe("angus");
		expect(action.formatMcp!(out)).toMatch(/WAS created/);
		expect(action.formatMcp!(out)).toMatch(/Do NOT retry/);
		expect(action.formatMcp!(out)).toMatch(/notion_search/);
	});
});
