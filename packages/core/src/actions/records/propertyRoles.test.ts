import { describe, expect, it } from "vitest";
import type { NotionDatabaseSchema } from "../notion/schemaGuard.js";
import { assertOption, findRole, PILLARS_ROLE, resolveRole, ROLES } from "./propertyRoles.js";

const baseSchema: NotionDatabaseSchema = {
	databaseId: "db-1",
	title: "Meetings",
	properties: [
		{ name: "Name", type: "title" },
		{ name: "Event time", type: "date" },
		{ name: "Type", type: "select", options: ["Internal", "External"] },
	],
};

describe("propertyRoles", () => {
	it("findRole prefers case-insensitive preferred name, falls back to sole candidate, and returns null on ambiguity", () => {
		expect(PILLARS_ROLE).toBe("pillars");
		expect(findRole(baseSchema, ROLES.meetingDate)).toBe("Event time");

		const customDateSchema: NotionDatabaseSchema = {
			databaseId: "db-2",
			title: "Notes",
			properties: [{ name: "Held on", type: "date" }],
		};
		expect(findRole(customDateSchema, ROLES.meetingDate)).toBe("Held on");

		const ambiguousDateSchema: NotionDatabaseSchema = {
			databaseId: "db-3",
			title: "Notes",
			properties: [
				{ name: "Start", type: "date" },
				{ name: "End", type: "date" },
			],
		};
		expect(findRole(ambiguousDateSchema, ROLES.meetingDate)).toBeNull();
		expect(findRole(baseSchema, ROLES.attendees)).toBeNull();
	});

	it("resolveRole honors explicit overrides and refuses missing or ambiguous properties", () => {
		const twoDates: NotionDatabaseSchema = {
			databaseId: "db-3",
			title: "Notes",
			properties: [
				{ name: "Name", type: "title" },
				{ name: "Start", type: "date" },
				{ name: "End", type: "date" },
			],
		};
		expect(resolveRole(twoDates, ROLES.meetingDate, "db-3", "Start")).toBe("Start");
		expect(() => resolveRole(twoDates, ROLES.meetingDate, "db-3", "Missing")).toThrow(
			/'Missing' is not a property of Notion database db-3/,
		);
		expect(() => resolveRole(twoDates, ROLES.meetingDate, "db-3", "Name")).toThrow(
			/'Name' is of type 'title', which cannot carry `start` \(needs date\)/,
		);
		expect(() => resolveRole(twoDates, ROLES.meetingDate, "db-3")).toThrow(
			/`start` is ambiguous on Notion database db-3[\s\S]*Pass `start_property`/,
		);
		expect(() => resolveRole(baseSchema, ROLES.attendees, "db-1")).toThrow(
			/You passed `attendees`, but Notion database db-1 has no people property to put it in\. Nothing was written\./,
		);
	});

	it("assertOption allows declared options and rejects undeclared values", () => {
		expect(() => assertOption(baseSchema, "Type", "Internal", "type")).not.toThrow();
		expect(() => assertOption(baseSchema, "Type", "Ad-hoc", "type")).toThrow(
			/`type: 'Ad-hoc'` is not an option of 'Type'[\s\S]*Its options are: Internal \| External/,
		);
	});
});
