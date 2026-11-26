import { describe, expect, it, vi } from "vitest";
import { createNotionDatabaseQueryAction } from "./databaseQuery.js";
import type {
	NotionPageResponse,
	NotionPort,
	NotionQueryDataSourceResponse,
} from "../../ports/notion.js";

const DS_ID = "28e9e609-fe01-81b4-bf9f-000b243e40ba";

function row(id: string, name: string, extra: Record<string, unknown> = {}, archived = false): NotionPageResponse {
	return {
		id,
		archived,
		last_edited_time: "2026-09-03T12:33:46.041Z",
		properties: {
			"Task name": { type: "title", title: [{ plain_text: name }] },
			Status: { type: "status", status: { name: "To do" } },
			Priority: { type: "select", select: { name: "P1" } },
			"Due date": { type: "date", date: { start: "2026-09-08" } },
			Owner: { type: "people", people: [{ id: "u1", name: "Angus" }] },
			Done: { type: "checkbox", checkbox: false },
			...extra,
		},
	};
}

function createMockPort(options?: {
	response?: NotionQueryDataSourceResponse;
	queryError?: Error;
}): NotionPort {
	return {
		resolveToken: vi.fn(async (workspace: string) => `secret_token_${workspace}`),
		search: vi.fn(async () => {
			throw new Error("not implemented");
		}),
		retrievePage: vi.fn(async () => {
			throw new Error("not implemented");
		}),
		listBlockChildren: vi.fn(async () => {
			throw new Error("not implemented");
		}),
		retrieveDatabase: vi.fn(async () => {
			throw new Error("not implemented");
		}),
		retrieveDataSource: vi.fn(async () => {
			throw new Error("not implemented");
		}),
		queryDataSource: vi.fn(async () => {
			if (options?.queryError) throw options.queryError;
			return (
				options?.response ?? {
					results: [row("p1", "Chase Mitesh")],
					has_more: false,
					next_cursor: null,
				}
			);
		}),
	};
}

describe("notionDatabaseQueryAction", () => {
	it("requires domain, naming both workspaces when omitted, and requires data_source_id", async () => {
		const port = createMockPort();
		const action = createNotionDatabaseQueryAction(port);

		await expect(
			action.run({ data_source_id: DS_ID } as any, { caller: "test", requestId: "1" }),
		).rejects.toThrow(/'work'.*'angus'|'angus'.*'work'/);

		await expect(
			action.run({ domain: "work" } as any, { caller: "test", requestId: "2" }),
		).rejects.toThrow(/`data_source_id` is required/);
	});

	it("queries data source, normalizing id, and returns typed rows", async () => {
		const port = createMockPort();
		const action = createNotionDatabaseQueryAction(port);

		const filter = { property: "Status", status: { equals: "To do" } };
		const sorts = [{ property: "Due date", direction: "ascending" }];

		const result = await action.run(
			{
				domain: "work",
				data_source_id: DS_ID.replace(/-/g, ""),
				filter,
				sorts,
				limit: 10,
				cursor: "c1",
			},
			{ caller: "test", requestId: "3" },
		);

		expect(port.queryDataSource).toHaveBeenCalledWith({
			workspace: "work",
			dataSourceId: DS_ID,
			pageSize: 10,
			cursor: "c1",
			filter,
			sorts,
		});

		expect(result.domain).toBe("work");
		expect(result.dataSourceId).toBe(DS_ID);
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0].id).toBe("p1");
		expect(result.rows[0].title).toBe("Chase Mitesh");
		expect(result.rows[0].properties.Status).toBe("To do");
		// Title property is not repeated as a column
		expect(result.rows[0].properties["Task name"]).toBeUndefined();

		const formatted = action.formatMcp!(result);
		expect(formatted).toContain(`Notion query: data source ${DS_ID} in the 'work' workspace, 1 row(s), filtered, sorted.`);
		expect(formatted).toContain("1. Chase Mitesh  (id p1)");
		expect(formatted).toContain("   Status: To do");
		expect(formatted).toContain("```json\n" + JSON.stringify({ rows: result.rows, has_more: false, next_cursor: null }) + "\n```");
	});

	it("narrows to specified properties", async () => {
		const port = createMockPort();
		const action = createNotionDatabaseQueryAction(port);

		const result = await action.run(
			{
				domain: "work",
				data_source_id: DS_ID,
				properties: ["Status", "NonExistent"],
			},
			{ caller: "test", requestId: "4" },
		);

		expect(result.rows[0].properties).toEqual({
			Status: "To do",
			NonExistent: "(no such property)",
		});
		expect(result.rows[0].properties.Priority).toBeUndefined();
	});

	it("filters out archived rows and reports their count", async () => {
		const port = createMockPort({
			response: {
				results: [row("p1", "Live"), row("p2", "Archived", {}, true)],
				has_more: true,
				next_cursor: "cur_next",
			},
		});
		const action = createNotionDatabaseQueryAction(port);

		const result = await action.run(
			{ domain: "work", data_source_id: DS_ID },
			{ caller: "test", requestId: "5" },
		);

		expect(result.rows).toHaveLength(1);
		expect(result.archivedCount).toBe(1);
		expect(result.hasMore).toBe(true);
		expect(result.nextCursor).toBe("cur_next");

		const formatted = action.formatMcp!(result);
		expect(formatted).toContain("(1 archived row(s) were returned by Notion and not listed.)");
		expect(formatted).toContain("More rows exist. Pass cursor 'cur_next' to fetch the next page; do not treat this list as complete.");
	});

	it("formats empty responses explaining the three causes", async () => {
		const port = createMockPort({
			response: {
				results: [],
				has_more: false,
				next_cursor: null,
			},
		});
		const action = createNotionDatabaseQueryAction(port);

		const result = await action.run(
			{ domain: "work", data_source_id: DS_ID, filter: { property: "Status", status: { equals: "Done" } } },
			{ caller: "test", requestId: "6" },
		);

		expect(result.rows).toHaveLength(0);

		const formatted = action.formatMcp!(result);
		expect(formatted).toContain("0 rows on this page");
		expect(formatted).toContain("Three things this can mean:");
		expect(formatted).toContain("The filter matched nothing.");
		expect(formatted).toContain("retry with domain='angus'");
	});

	it("wraps 404 status with cross-workspace hint even without (404) in message, and ignores (404) text when status is 500", async () => {
		const notFoundErr = Object.assign(new Error("Notion API error: object_not_found"), {
			name: "NotionApiError" as const,
			status: 404,
		});
		const port404 = createMockPort({
			queryError: notFoundErr,
		});
		const action404 = createNotionDatabaseQueryAction(port404);

		await expect(
			action404.run({ domain: "angus", data_source_id: DS_ID }, { caller: "test", requestId: "7" }),
		).rejects.toThrow(/retry with domain='work'.*\*\_database_id/s);

		const serverErr = Object.assign(new Error("Notion API error (404): internal failure"), {
			name: "NotionApiError" as const,
			status: 500,
		});
		const port500 = createMockPort({
			queryError: serverErr,
		});
		const action500 = createNotionDatabaseQueryAction(port500);

		await expect(
			action500.run({ domain: "angus", data_source_id: DS_ID }, { caller: "test", requestId: "8" }),
		).rejects.not.toThrow(/retry with domain/);
	});
});
