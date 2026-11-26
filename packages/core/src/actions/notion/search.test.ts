import { describe, expect, it, vi } from "vitest";
import { createNotionSearchAction, extractResultTitle } from "./search.js";
import type { NotionPort, NotionSearchResponse } from "../../ports/notion.js";

function createMockPort(customSearch?: (params: any) => Promise<NotionSearchResponse>): NotionPort {
	return {
		resolveToken: vi.fn(async (workspace: string) => `secret_token_${workspace}`),
		search: vi.fn(async (params: any) => {
			if (customSearch) return customSearch(params);
			return { results: [], has_more: false, next_cursor: null };
		}),
		retrievePage: vi.fn(async () => {
			throw new Error("not implemented");
		}),
		listBlockChildren: vi.fn(async () => {
			throw new Error("not implemented");
		}),
	};
}

describe("notionSearchAction", () => {
	it("requires domain, naming both workspaces when omitted", async () => {
		const port = createMockPort();
		const action = createNotionSearchAction(port);

		await expect(
			action.run({ query: "notepad" } as any, { caller: "test", requestId: "1" }),
		).rejects.toThrow(/'work'.*'angus'|'angus'.*'work'/);
		expect(port.resolveToken).not.toHaveBeenCalled();
		expect(port.search).not.toHaveBeenCalled();
	});

	it("calls resolveToken with the domain and returns typed domain output", async () => {
		const port = createMockPort(async () => ({
			results: [
				{
					id: "1fbb7b8b-edcd-80dd-819d-ecf7f2eb1e89",
					object: "page",
					url: "https://notion.so/1fbb7b8bedcd80dd819decf7f2eb1e89",
					last_edited_time: "2026-08-23T10:00:00.000Z",
					properties: { Name: { type: "title", title: [{ plain_text: "Notepad" }] } },
				},
			],
			has_more: false,
			next_cursor: null,
		}));

		const action = createNotionSearchAction(port);
		const result = await action.run(
			{ domain: "angus", query: "notepad" },
			{ caller: "test", requestId: "2" },
		);

		expect(port.resolveToken).toHaveBeenCalledWith("angus");
		expect(port.search).toHaveBeenCalledWith({
			workspace: "angus",
			query: "notepad",
			objectType: undefined,
			pageSize: 35,
		});

		// Typed result verification (not MCP envelope)
		expect(result).toEqual({
			domain: "angus",
			query: "notepad",
			type: undefined,
			results: [
				{
					id: "1fbb7b8b-edcd-80dd-819d-ecf7f2eb1e89",
					object: "page",
					title: "Notepad",
					url: "https://notion.so/1fbb7b8bedcd80dd819decf7f2eb1e89",
					lastEditedTime: "2026-08-23T10:00:00.000Z",
					archived: undefined,
				},
			],
			totalResults: 1,
			hasMore: false,
			next_cursor: null,
			archivedCount: 0,
			limit: 25,
		});

		// formatMcp renders identical text
		const formatted = action.formatMcp!(result);
		expect(formatted).toContain("Notepad");
		expect(formatted).toContain("1fbb7b8b-edcd-80dd-819d-ecf7f2eb1e89");
		expect(formatted).toContain("notion_page_get");
	});

	it("filters out archived matches and counts them", async () => {
		const port = createMockPort(async () => ({
			results: [
				{
					id: "c".repeat(32),
					object: "page",
					properties: { Name: { type: "title", title: [{ plain_text: "Live one" }] } },
				},
				{
					id: "d".repeat(32),
					object: "page",
					archived: true,
					properties: { Name: { type: "title", title: [{ plain_text: "Old one" }] } },
				},
			],
			has_more: false,
			next_cursor: null,
		}));

		const action = createNotionSearchAction(port);
		const result = await action.run(
			{ domain: "angus", query: "one" },
			{ caller: "test", requestId: "3" },
		);

		expect(result.results).toHaveLength(1);
		expect(result.results[0].title).toBe("Live one");
		expect(result.archivedCount).toBe(1);

		const formatted = action.formatMcp!(result);
		expect(formatted).toContain("Live one");
		expect(formatted).not.toContain("Old one");
		expect(formatted).toContain("1 archived object(s) matched and were not listed");
	});

	it("empty result formats explanation with 3 causes", async () => {
		const port = createMockPort(async () => ({
			results: [],
			has_more: false,
			next_cursor: null,
		}));

		const action = createNotionSearchAction(port);
		const result = await action.run(
			{ domain: "angus", query: "general" },
			{ caller: "test", requestId: "4" },
		);

		const formatted = action.formatMcp!(result);
		expect(formatted).toContain("does NOT mean the page does not exist");
		expect(formatted).toContain("TITLE");
		expect(formatted).toContain("domain='work'");
		expect(formatted).toContain("notion_personal");
		expect(formatted).toContain("ask for the page URL");
	});

	it("normalizes 'data_source' and 'database' results to object: 'database' and extracts titles (#1993)", async () => {
		const port = createMockPort(async () => ({
			results: [
				{
					id: "ds-123",
					object: "data_source",
					url: "https://notion.so/ds123",
					last_edited_time: "2026-10-26T10:00:00.000Z",
					title: [{ plain_text: "Tasks Data Source" }],
					properties: { Name: { type: "title", title: {} } },
				},
				{
					id: "db-456",
					object: "database",
					url: "https://notion.so/db456",
					last_edited_time: "2026-10-26T11:00:00.000Z",
					title: [{ text: { content: "Meetings DB" } }],
				},
			],
			has_more: false,
			next_cursor: null,
		}));

		const action = createNotionSearchAction(port);
		const result = await action.run(
			{ domain: "work", query: "Tasks", type: "database" },
			{ caller: "test", requestId: "5" },
		);

		expect(port.search).toHaveBeenCalledWith({
			workspace: "work",
			query: "Tasks",
			objectType: "database",
			pageSize: 35,
		});
		expect(result.type).toBe("database");
		expect(result.results).toEqual([
			{
				id: "ds-123",
				object: "database",
				title: "Tasks Data Source",
				url: "https://notion.so/ds123",
				lastEditedTime: "2026-10-26T10:00:00.000Z",
				archived: undefined,
			},
			{
				id: "db-456",
				object: "database",
				title: "Meetings DB",
				url: "https://notion.so/db456",
				lastEditedTime: "2026-10-26T11:00:00.000Z",
				archived: undefined,
			},
		]);

		const formatted = action.formatMcp!(result);
		expect(formatted).toContain("1. Tasks Data Source — database, edited 2026-10-26");
		expect(formatted).toContain("2. Meetings DB — database, edited 2026-10-26");
	});

	it("accepts type: 'data_source' and normalizes output.type to 'database' (#1993)", async () => {
		const port = createMockPort(async () => ({
			results: [],
			has_more: false,
			next_cursor: null,
		}));

		const action = createNotionSearchAction(port);
		const result = await action.run(
			{ domain: "work", type: "data_source" },
			{ caller: "test", requestId: "6" },
		);

		expect(port.search).toHaveBeenCalledWith({
			workspace: "work",
			query: undefined,
			objectType: "data_source",
			pageSize: 35,
		});
		expect(result.type).toBe("database");
	});

	it("extractResultTitle handles data_source name fallback and untitled objects", () => {
		expect(
			extractResultTitle({
				id: "ds-name",
				object: "data_source",
				name: "  Contacts  ",
			}),
		).toBe("Contacts");

		expect(
			extractResultTitle({
				id: "ds-empty",
				object: "data_source",
			}),
		).toBe("Untitled");
	});
});
