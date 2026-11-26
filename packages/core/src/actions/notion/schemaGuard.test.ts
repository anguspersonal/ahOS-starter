import { describe, expect, it, vi } from "vitest";
import {
	assertOptionsMatchSchema,
	assertPropertiesMatchSchema,
	describeProperties,
	DatabasePropertiesMissingError,
	readDatabaseProperties,
	requireDatabaseProperties,
	resolveTitleProperty,
	type NotionDatabaseSchema,
} from "./schemaGuard.js";

const SAMPLE_SCHEMA: NotionDatabaseSchema = {
	properties: [
		{ name: "Name", type: "title" },
		{ name: "Date", type: "date" },
		{ name: "Category", type: "select", options: ["General", "Weekly"] },
		{ name: "Tags", type: "multi_select", options: ["ops", "product"] },
		{ name: "State", type: "status", options: ["Todo", "Done"] },
	],
};

describe("schemaGuard", () => {
	it("describeProperties lists property names, types, and options", () => {
		expect(describeProperties(SAMPLE_SCHEMA)).toBe(
			"Name (title), Date (date), Category (select: General | Weekly), Tags (multi_select: ops | product), State (status: Todo | Done)",
		);
	});

	it("resolveTitleProperty returns the title property name and names the database when none is a title", () => {
		expect(resolveTitleProperty(SAMPLE_SCHEMA, "db-123")).toBe("Name");
		expect(() =>
			resolveTitleProperty({ properties: [{ name: "Date", type: "date" }] }, "db-missing-title"),
		).toThrow(
			/Notion database db-missing-title reports no property of type 'title'.*Nothing was written\./,
		);
	});

	it("assertPropertiesMatchSchema refuses an unknown property name with the schema listed", () => {
		expect(() =>
			assertPropertiesMatchSchema(
				{ UnknownField: { rich_text: [] } },
				SAMPLE_SCHEMA,
				{ destination: "this Daily Log" },
			),
		).toThrow(
			/Unknown property for this Daily Log: 'UnknownField'\. Nothing was written\. Valid properties are: Name \(title\), Date \(date\), Category \(select: General \| Weekly\)/,
		);
	});

	it("assertPropertiesMatchSchema refuses a reserved property collision", () => {
		expect(() =>
			assertPropertiesMatchSchema(
				{ Name: { title: [] } },
				SAMPLE_SCHEMA,
				{ destination: "this database", reserved: { title: "Name" } },
			),
		).toThrow(/`properties` must not set 'Name' — this tool writes the title from `title`/);
	});

	it("assertOptionsMatchSchema refuses unknown select, multi_select and status options", () => {
		expect(() =>
			assertOptionsMatchSchema(
				{
					Category: { select: { name: "Genral" } },
					Tags: { multi_select: [{ name: "ops" }, { name: "invented" }] },
					State: { status: { name: "InProgress" } },
				},
				SAMPLE_SCHEMA,
				{ destination: "this Daily Log" },
			),
		).toThrow(
			/Unknown option values for this Daily Log\. Nothing was written, and nothing was created: Notion would have added the option rather than rejecting it\. 'Category' does not have option 'Genral'\. Its options are: General \| Weekly 'Tags' does not have option 'invented'\. Its options are: ops \| product 'State' does not have option 'InProgress'\. Its options are: Todo \| Done/,
		);
	});

	it("assertOptionsMatchSchema accepts valid select, multi_select and status options", () => {
		expect(() =>
			assertOptionsMatchSchema(
				{
					Category: { select: { name: "General" } },
					Tags: { multi_select: [{ name: "ops" }, { name: "product" }] },
					State: { status: { name: "Done" } },
				},
				SAMPLE_SCHEMA,
				{ destination: "this Daily Log" },
			),
		).not.toThrow();
	});
});

// #2285: under Notion-Version 2025-09-03 a database object carries `data_sources` and no
// `properties`. daily_log_create read `db.properties ?? {}`, got an empty schema, and
// refused every write for a week.
describe("readDatabaseProperties / requireDatabaseProperties (#2285)", () => {
	const PROPS = { Name: { type: "title" }, Date: { type: "date" } };
	const where = { workspace: "work", databaseId: "db-1" };

	it("uses the database's own properties when the response carries them (older API shape)", async () => {
		const notion = {
			retrieveDatabase: vi.fn(async () => ({ id: "db-1", properties: PROPS })),
			retrieveDataSource: vi.fn(),
		};

		expect(await readDatabaseProperties(notion as never, where)).toEqual({
			properties: PROPS,
			dataSourceId: null,
		});
		expect(notion.retrieveDataSource).not.toHaveBeenCalled();
	});

	it("reads them from the first data source when the database has none (2025-09-03 shape)", async () => {
		const notion = {
			retrieveDatabase: vi.fn(async () => ({ id: "db-1", data_sources: [{ id: "ds-1" }, { id: "ds-2" }] })),
			retrieveDataSource: vi.fn(async () => ({ id: "ds-1", properties: PROPS })),
		};

		expect(await readDatabaseProperties(notion as never, where)).toEqual({
			properties: PROPS,
			dataSourceId: "ds-1",
		});
		expect(notion.retrieveDataSource).toHaveBeenCalledWith({ workspace: "work", dataSourceId: "ds-1" });
	});

	it("treats an empty properties object the same as an absent one", async () => {
		const notion = {
			retrieveDatabase: vi.fn(async () => ({ id: "db-1", properties: {}, data_sources: [{ id: "ds-1" }] })),
			retrieveDataSource: vi.fn(async () => ({ id: "ds-1", properties: PROPS })),
		};

		expect((await readDatabaseProperties(notion as never, where)).properties).toEqual(PROPS);
	});

	it("prefers the data source the caller already resolved from config over the database's first", async () => {
		const notion = {
			retrieveDatabase: vi.fn(async () => ({ id: "db-1", data_sources: [{ id: "ds-first" }] })),
			retrieveDataSource: vi.fn(async () => ({ id: "ds-configured", properties: PROPS })),
		};

		await readDatabaseProperties(notion as never, { ...where, dataSourceId: "ds-configured" });

		expect(notion.retrieveDataSource).toHaveBeenCalledWith({
			workspace: "work",
			dataSourceId: "ds-configured",
		});
	});

	it("returns null, not an empty schema, when neither place has properties", async () => {
		const notion = {
			retrieveDatabase: vi.fn(async () => ({ id: "db-1", data_sources: [{ id: "ds-1" }] })),
			retrieveDataSource: vi.fn(async () => ({ id: "ds-1" })),
		};

		expect(await readDatabaseProperties(notion as never, where)).toEqual({
			properties: null,
			dataSourceId: "ds-1",
		});
	});

	it("returns null when there is no data source to ask, or no way to ask it", async () => {
		const bare = { retrieveDatabase: vi.fn(async () => ({ id: "db-1" })), retrieveDataSource: vi.fn() };
		expect(await readDatabaseProperties(bare as never, where)).toEqual({ properties: null, dataSourceId: null });
		expect(bare.retrieveDataSource).not.toHaveBeenCalled();

		const noReader = { retrieveDatabase: vi.fn(async () => ({ id: "db-1", data_sources: [{ id: "ds-1" }] })) };
		expect(await readDatabaseProperties(noReader as never, where)).toEqual({
			properties: null,
			dataSourceId: "ds-1",
		});
	});

	it("does not swallow a Notion error: the caller owns how a 404 reads", async () => {
		const notion = { retrieveDatabase: vi.fn(async () => { throw new Error("object_not_found"); }) };

		await expect(readDatabaseProperties(notion as never, where)).rejects.toThrow("object_not_found");
	});

	it("requireDatabaseProperties returns the properties, or names both ids when there are none", async () => {
		const ok = {
			retrieveDatabase: vi.fn(async () => ({ id: "db-1", data_sources: [{ id: "ds-1" }] })),
			retrieveDataSource: vi.fn(async () => ({ id: "ds-1", properties: PROPS })),
		};
		expect(await requireDatabaseProperties(ok as never, where)).toEqual(PROPS);

		const empty = {
			retrieveDatabase: vi.fn(async () => ({ id: "db-1", data_sources: [{ id: "ds-1" }] })),
			retrieveDataSource: vi.fn(async () => ({ id: "ds-1" })),
		};
		const err = await requireDatabaseProperties(empty as never, where).catch((e) => e);
		expect(err).toBeInstanceOf(DatabasePropertiesMissingError);
		expect(err.message).toContain("db-1");
		expect(err.message).toContain("ds-1");
		expect(err.message).toContain("Nothing was written");

		const none = { retrieveDatabase: vi.fn(async () => ({ id: "db-1" })), retrieveDataSource: vi.fn() };
		await expect(requireDatabaseProperties(none as never, where)).rejects.toThrow(
			"lists no data source to read them from",
		);
	});
});
