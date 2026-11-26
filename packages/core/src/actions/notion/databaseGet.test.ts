import { describe, expect, it, vi } from "vitest";
import { createNotionDatabaseGetAction } from "./databaseGet.js";
import type {
	NotionDatabaseResponse,
	NotionDataSourceResponse,
	NotionPort,
} from "../../ports/notion.js";

const DB_ID = "28e9e609-fe01-81b4-bf9f-000b243e40ba";
const DS_ID = "39f0f71a-0f12-82c5-c0a0-111c354f51cb";

function createMockPort(options?: {
	database?: NotionDatabaseResponse;
	dataSource?: NotionDataSourceResponse;
	retrieveDbError?: Error;
	retrieveDsError?: Error;
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
			if (options?.retrieveDbError) throw options.retrieveDbError;
			return (
				options?.database ?? {
					id: DB_ID,
					title: [{ plain_text: "Test DB" }],
					properties: {
						Name: { type: "title" },
						Status: {
							type: "status",
							status: { options: [{ name: "To do" }, { name: "Done" }] },
						},
						Category: {
							type: "select",
							select: { options: [{ name: "A" }, { name: "B" }] },
						},
						Tags: {
							type: "multi_select",
							multi_select: { options: [{ name: "urgent" }] },
						},
					},
				}
			);
		}),
		retrieveDataSource: vi.fn(async () => {
			if (options?.retrieveDsError) throw options.retrieveDsError;
			return (
				options?.dataSource ?? {
					id: DS_ID,
					parent: { type: "database_id", database_id: DB_ID },
				}
			);
		}),
		queryDataSource: vi.fn(async () => {
			throw new Error("not implemented");
		}),
		retrieveBlock: vi.fn(async () => {
			throw new Error("not implemented");
		}),
		deleteBlock: vi.fn(async () => {
			throw new Error("not implemented");
		}),
		listComments: vi.fn(async () => {
			throw new Error("not implemented");
		}),
		createComment: vi.fn(async () => {
			throw new Error("not implemented");
		}),
		createPage: vi.fn(async () => {
			throw new Error("not implemented");
		}),
		appendBlockChildren: vi.fn(async () => {
			throw new Error("not implemented");
		}),
	};
}

describe("notionDatabaseGetAction", () => {
	it("requires domain, naming both workspaces when omitted", async () => {
		const port = createMockPort();
		const action = createNotionDatabaseGetAction(port);

		await expect(
			action.run({ database_id: DB_ID } as any, { caller: "test", requestId: "1" }),
		).rejects.toThrow(/'work'.*'angus'|'angus'.*'work'/);
		expect(port.retrieveDatabase).not.toHaveBeenCalled();
	});

	it("refuses when neither or both ids are passed", async () => {
		const port = createMockPort();
		const action = createNotionDatabaseGetAction(port);

		await expect(
			action.run({ domain: "work" } as any, { caller: "test", requestId: "2" }),
		).rejects.toThrow(/Pass exactly one of `database_id` or `data_source_id`/);

		await expect(
			action.run(
				{ domain: "work", database_id: DB_ID, data_source_id: DS_ID },
				{ caller: "test", requestId: "3" },
			),
		).rejects.toThrow(/Pass exactly one of `database_id` or `data_source_id`/);
	});

	it("introspects database by database_id, normalizing id and returning properties", async () => {
		const port = createMockPort();
		const action = createNotionDatabaseGetAction(port);

		const result = await action.run(
			{ domain: "work", database_id: DB_ID.replace(/-/g, "") },
			{ caller: "test", requestId: "4" },
		);

		expect(port.retrieveDatabase).toHaveBeenCalledWith({
			workspace: "work",
			databaseId: DB_ID,
		});
		expect(port.retrieveDataSource).not.toHaveBeenCalled();

		expect(result).toEqual({
			domain: "work",
			databaseId: DB_ID,
			properties: [
				{ name: "Name", type: "title" },
				{ name: "Status", type: "status", options: ["To do", "Done"] },
				{ name: "Category", type: "select", options: ["A", "B"] },
				{ name: "Tags", type: "multi_select", options: ["urgent"] },
			],
		});

		const formatted = action.formatMcp!(result);
		expect(formatted).toContain(`Database schema (work, db ${DB_ID}):`);
		expect(formatted).toContain("  Name — title");
		expect(formatted).toContain("  Status — status (options: To do, Done)");
		expect(formatted).toContain("  Category — select (options: A, B)");
		expect(formatted).toContain("  Tags — multi_select (options: urgent)");
	});

	it("resolves data_source_id to parent database_id before retrieving database", async () => {
		const port = createMockPort();
		const action = createNotionDatabaseGetAction(port);

		const result = await action.run(
			{ domain: "angus", data_source_id: DS_ID },
			{ caller: "test", requestId: "5" },
		);

		expect(port.retrieveDataSource).toHaveBeenCalledWith({
			workspace: "angus",
			dataSourceId: DS_ID,
		});
		expect(port.retrieveDatabase).toHaveBeenCalledWith({
			workspace: "angus",
			databaseId: DB_ID,
		});
		expect(result.databaseId).toBe(DB_ID);
	});

	it("reads properties from data_sources[0] when database response carries data_sources and no properties (2025-09-03 API)", async () => {
		const port = createMockPort({
			database: {
				id: DB_ID,
				data_sources: [{ id: "ds1" }],
			},
			dataSource: {
				id: "ds1",
				parent: { database_id: DB_ID },
				properties: {
					Status: {
						type: "status",
						status: { options: [{ name: "To Do" }] },
					},
					Priority: {
						type: "select",
						select: { options: [{ name: "High" }] },
					},
				},
			},
		});
		const action = createNotionDatabaseGetAction(port);

		const result = await action.run(
			{ domain: "work", database_id: DB_ID },
			{ caller: "test", requestId: "9" },
		);

		expect(port.retrieveDataSource).toHaveBeenCalledTimes(1);
		expect(port.retrieveDataSource).toHaveBeenCalledWith({
			workspace: "work",
			dataSourceId: "ds1",
		});
		expect(result).toEqual({
			domain: "work",
			databaseId: DB_ID,
			dataSourceId: "ds1",
			properties: [
				{ name: "Status", type: "status", options: ["To Do"] },
				{ name: "Priority", type: "select", options: ["High"] },
			],
		});
	});

	it("returns data source properties and sets dataSourceId when data_source_id is given and data source carries properties", async () => {
		const port = createMockPort({
			database: {
				id: DB_ID,
				data_sources: [{ id: DS_ID }],
			},
			dataSource: {
				id: DS_ID,
				parent: { type: "database_id", database_id: DB_ID },
				properties: {
					Status: {
						type: "status",
						status: { options: [{ name: "In Progress" }] },
					},
				},
			},
		});
		const action = createNotionDatabaseGetAction(port);

		const result = await action.run(
			{ domain: "angus", data_source_id: DS_ID },
			{ caller: "test", requestId: "10" },
		);

		expect(port.retrieveDataSource).toHaveBeenCalledWith({
			workspace: "angus",
			dataSourceId: DS_ID,
		});
		expect(port.retrieveDatabase).toHaveBeenCalledWith({
			workspace: "angus",
			databaseId: DB_ID,
		});
		expect(result.databaseId).toBe(DB_ID);
		expect(result.dataSourceId).toBe(DS_ID);
		expect(result.properties).toEqual([
			{ name: "Status", type: "status", options: ["In Progress"] },
		]);
	});

	it("rejects naming the database id when retrieveDatabase resolves neither properties nor data_sources", async () => {
		const port = createMockPort({
			database: { id: DB_ID },
		});
		const action = createNotionDatabaseGetAction(port);

		await expect(
			action.run(
				{ domain: "work", database_id: DB_ID },
				{ caller: "test", requestId: "11" },
			),
		).rejects.toThrow(new RegExp(DB_ID));
	});

	it("uses the first data source and names it in dataSourceId when a database has two data sources", async () => {
		const port = createMockPort({
			database: {
				id: DB_ID,
				data_sources: [{ id: "ds-first" }, { id: "ds-second" }],
			},
			dataSource: {
				id: "ds-first",
				parent: { database_id: DB_ID },
				properties: {
					Name: { type: "title" },
				},
			},
		});
		const action = createNotionDatabaseGetAction(port);

		const result = await action.run(
			{ domain: "work", database_id: DB_ID },
			{ caller: "test", requestId: "12" },
		);

		expect(port.retrieveDataSource).toHaveBeenCalledTimes(1);
		expect(port.retrieveDataSource).toHaveBeenCalledWith({
			workspace: "work",
			dataSourceId: "ds-first",
		});
		expect(result.dataSourceId).toBe("ds-first");
		expect(result.properties).toEqual([{ name: "Name", type: "title" }]);
	});

	it("throws if data source reports no parent database", async () => {
		const port = createMockPort({
			dataSource: { id: DS_ID, parent: undefined },
		});
		const action = createNotionDatabaseGetAction(port);

		await expect(
			action.run(
				{ domain: "work", data_source_id: DS_ID },
				{ caller: "test", requestId: "6" },
			),
		).rejects.toThrow(/reports no parent database/);
	});

	it("wraps 404 status with cross-workspace hint even without (404) in message, and ignores (404) text when status is 500", async () => {
		const notFoundErr = Object.assign(new Error("Notion API error: object_not_found"), {
			name: "NotionApiError" as const,
			status: 404,
		});
		const port404 = createMockPort({
			retrieveDbError: notFoundErr,
		});
		const action404 = createNotionDatabaseGetAction(port404);

		await expect(
			action404.run(
				{ domain: "work", database_id: DB_ID },
				{ caller: "test", requestId: "7" },
			),
		).rejects.toThrow(/retry with domain='angus'/);

		const serverErr = Object.assign(new Error("Notion API error (404): internal failure"), {
			name: "NotionApiError" as const,
			status: 500,
		});
		const port500 = createMockPort({
			retrieveDbError: serverErr,
		});
		const action500 = createNotionDatabaseGetAction(port500);

		await expect(
			action500.run(
				{ domain: "work", database_id: DB_ID },
				{ caller: "test", requestId: "8" },
			),
		).rejects.not.toThrow(/retry with domain/);
	});
});
