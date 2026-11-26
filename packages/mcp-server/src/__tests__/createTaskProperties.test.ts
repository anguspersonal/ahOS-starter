import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildNotionProperties,
	pickDefaultPriority,
} from "../tools/createTaskProperties.js";

type FetchCall = { url: string; init: RequestInit & { body?: string } };

/** Stub the single GET /databases/{id} call retrieveDatabaseSchema makes. */
function stubDatabaseSchema(properties: Record<string, unknown>): FetchCall[] {
	const calls: FetchCall[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			calls.push({ url, init: init as FetchCall["init"] });
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({ properties }),
				text: async () => "",
			} as Response;
		}),
	);
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

const TASKS_DB_SCHEMA = {
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
	Domain: {
		type: "select",
		select: { options: [{ name: "Product and Engineering" }, { name: "Ops" }] },
	},
	Estimates: {
		type: "select",
		select: { options: [{ name: "S" }, { name: "M" }, { name: "L" }] },
	},
	Type: {
		type: "multi_select",
		multi_select: { options: [{ name: "Task" }, { name: "Polish" }] },
	},
	Tags: {
		type: "multi_select",
		multi_select: { options: [{ name: "launch-v1.0.0" }, { name: "Mobile" }] },
	},
	Owner: { type: "people", people: {} },
	Meetings: { type: "relation", relation: {} },
	Due: { type: "date", date: {} },
};

describe("buildNotionProperties — value shape correctness", () => {
	it("builds select/status values correctly by introspected type", async () => {
		stubDatabaseSchema(TASKS_DB_SCHEMA);

		const result = await buildNotionProperties({
			tasksDatabaseId: "db1",
			propertyMap: {},
			properties: {
				status: "Done",
				priority: "High",
				domain: "Product and Engineering",
				estimates: "S",
			},
		});

		expect(result.Status).toEqual({ status: { name: "Done" } });
		expect(result.Priority).toEqual({ select: { name: "High" } });
		expect(result.Domain).toEqual({ select: { name: "Product and Engineering" } });
		expect(result.Estimates).toEqual({ select: { name: "S" } });
	});

	it("builds multi_select values for type and tags", async () => {
		stubDatabaseSchema(TASKS_DB_SCHEMA);

		const result = await buildNotionProperties({
			tasksDatabaseId: "db1",
			propertyMap: {},
			properties: {
				type: ["Task", "Polish"],
				tags: ["launch-v1.0.0", "Mobile"],
			},
		});

		expect(result.Type).toEqual({
			multi_select: [{ name: "Task" }, { name: "Polish" }],
		});
		expect(result.Tags).toEqual({
			multi_select: [{ name: "launch-v1.0.0" }, { name: "Mobile" }],
		});
	});

	it("builds a people value for an explicit owner", async () => {
		stubDatabaseSchema(TASKS_DB_SCHEMA);

		const result = await buildNotionProperties({
			tasksDatabaseId: "db1",
			propertyMap: {},
			properties: { owner: "person_explicit" },
		});

		expect(result.Owner).toEqual({ people: [{ id: "person_explicit" }] });
	});

	it("defaults owner to defaultOwnerPersonId when omitted ('assign to me unless clearly someone else')", async () => {
		stubDatabaseSchema(TASKS_DB_SCHEMA);

		const result = await buildNotionProperties({
			tasksDatabaseId: "db1",
			propertyMap: {},
			properties: {},
			defaultOwnerPersonId: "person_me",
		});

		expect(result.Owner).toEqual({ people: [{ id: "person_me" }] });
	});

	it("an explicit owner wins over the default", async () => {
		stubDatabaseSchema(TASKS_DB_SCHEMA);

		const result = await buildNotionProperties({
			tasksDatabaseId: "db1",
			propertyMap: {},
			properties: { owner: "person_explicit" },
			defaultOwnerPersonId: "person_me",
		});

		expect(result.Owner).toEqual({ people: [{ id: "person_explicit" }] });
	});

	it("skips owner entirely when no explicit value and no defaultOwnerPersonId (never invents an owner)", async () => {
		stubDatabaseSchema(TASKS_DB_SCHEMA);

		const result = await buildNotionProperties({
			tasksDatabaseId: "db1",
			propertyMap: {},
			properties: {},
		});

		expect(result.Owner).toBeUndefined();
	});

	it("builds a relation value from page_ids, resolving the property name via property_map", async () => {
		stubDatabaseSchema(TASKS_DB_SCHEMA);

		const result = await buildNotionProperties({
			tasksDatabaseId: "db1",
			propertyMap: { relation: "Meetings" },
			properties: {
				relation: { property: "relation", page_ids: ["page_a", "page_b"] },
			},
		});

		expect(result.Meetings).toEqual({
			relation: [{ id: "page_a" }, { id: "page_b" }],
		});
	});

	it("builds a relation value for for_person, resolving default 'Person' property name", async () => {
		stubDatabaseSchema({
			...TASKS_DB_SCHEMA,
			Person: { type: "relation", relation: {} },
		});

		const result = await buildNotionProperties({
			tasksDatabaseId: "db1",
			propertyMap: {},
			properties: {
				for_person: { property: "for_person", page_ids: ["page_person_1"] },
			},
		});

		expect(result.Person).toEqual({
			relation: [{ id: "page_person_1" }],
		});
	});

	it("resolves abstract property names via property_map over the built-in defaults", async () => {
		const customSchema = {
			...TASKS_DB_SCHEMA,
			"Custom Status": TASKS_DB_SCHEMA.Status,
		};
		stubDatabaseSchema(customSchema);

		const result = await buildNotionProperties({
			tasksDatabaseId: "db1",
			propertyMap: { status: "Custom Status" },
			properties: { status: "Done" },
		});

		expect(result["Custom Status"]).toEqual({ status: { name: "Done" } });
		expect(result.Status).toBeUndefined();
	});
});

describe("buildNotionProperties — option validation", () => {
	it("throws a clear error listing valid options for an invalid select value", async () => {
		stubDatabaseSchema(TASKS_DB_SCHEMA);

		await expect(
			buildNotionProperties({
				tasksDatabaseId: "db1",
				propertyMap: {},
				properties: { priority: "Urgent" },
			}),
		).rejects.toThrow(/Valid options: Low, High/);
	});

	it("throws a clear error listing valid options for an invalid status value", async () => {
		stubDatabaseSchema(TASKS_DB_SCHEMA);

		await expect(
			buildNotionProperties({
				tasksDatabaseId: "db1",
				propertyMap: {},
				properties: { status: "Blocked" },
			}),
		).rejects.toThrow(/Valid options: Not started, In progress, Done/);
	});

	it("throws a clear error listing valid options for an invalid multi_select value", async () => {
		stubDatabaseSchema(TASKS_DB_SCHEMA);

		await expect(
			buildNotionProperties({
				tasksDatabaseId: "db1",
				propertyMap: {},
				properties: { tags: ["Mobile", "NotAValidTag"] },
			}),
		).rejects.toThrow(/'NotAValidTag' is not a valid option for 'Tags'.*Valid options: launch-v1\.0\.0, Mobile/s);
	});

	it("throws a clear error when the mapped property name isn't in the database schema", async () => {
		stubDatabaseSchema(TASKS_DB_SCHEMA);

		await expect(
			buildNotionProperties({
				tasksDatabaseId: "db1",
				propertyMap: { status: "Nonexistent Property" },
				properties: { status: "Done" },
			}),
		).rejects.toThrow(/'Nonexistent Property' was not found on the tasks database/);
	});

	it("throws a clear error when the introspected type doesn't match what the field expects (e.g. tags mapped to a non-multi_select property)", async () => {
		stubDatabaseSchema(TASKS_DB_SCHEMA);

		await expect(
			buildNotionProperties({
				tasksDatabaseId: "db1",
				propertyMap: { tags: "Priority" },
				properties: { tags: ["Mobile"] },
			}),
		).rejects.toThrow(/'Priority' has type 'select', but 'tags' expects a multi_select property/);
	});
});

// Issue #298: the triage priority default must be schema-aware — the picked value is
// always one the DB actually accepts (ADR-040 §3's top tier: High, then P1, then P0),
// and a miss degrades to a skip reason, never a throw.
describe("pickDefaultPriority — schema-aware triage default (#298)", () => {
	it("prefers 'High' when the DB uses High/Medium/Low", () => {
		expect(
			pickDefaultPriority(
				[
					{ name: "Priority", type: "select", options: ["Low", "Medium", "High"] },
				],
				"Priority",
			),
		).toEqual({ applied: "High" });
	});

	it("falls back to 'P1' (not 'P0' — P0 means emergency) on the P0–P4 framework", () => {
		expect(
			pickDefaultPriority(
				[
					{ name: "Priority", type: "select", options: ["P0", "P1", "P2", "P3", "P4"] },
				],
				"Priority",
			),
		).toEqual({ applied: "P1" });
	});

	it("uses 'P0' only when neither 'High' nor 'P1' exists", () => {
		expect(
			pickDefaultPriority(
				[{ name: "Priority", type: "select", options: ["P0", "P2"] }],
				"Priority",
			),
		).toEqual({ applied: "P0" });
	});

	it("works for a Notion 'status'-type priority property too", () => {
		expect(
			pickDefaultPriority(
				[{ name: "Priority", type: "status", options: ["Low", "High"] }],
				"Priority",
			),
		).toEqual({ applied: "High" });
	});

	it("skips with 'property-missing' when the property does not exist on the DB", () => {
		expect(
			pickDefaultPriority([{ name: "Name", type: "title" }], "Priority"),
		).toEqual({ skipped: "property-missing" });
	});

	it("skips with 'property-missing' when the property exists but is not select-like", () => {
		expect(
			pickDefaultPriority([{ name: "Priority", type: "rich_text" }], "Priority"),
		).toEqual({ skipped: "property-missing" });
	});

	it("skips with 'no-candidate-option' when no top-tier option is configured — never invents an option", () => {
		expect(
			pickDefaultPriority(
				[{ name: "Priority", type: "select", options: ["Urgent", "Later"] }],
				"Priority",
			),
		).toEqual({ skipped: "no-candidate-option" });
	});
});
