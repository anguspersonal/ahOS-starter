import { describe, expect, it } from "vitest";
import { createFakeSupabase, type RecordedCall } from "../fakeSupabase.testkit.js";
import {
	createSupabasePeopleRepository,
	PERSON_BASE_COLUMNS,
	PERSON_COLUMNS,
	SELF_PREFS_MIGRATION_HINT,
	type PeopleSupabaseClient,
} from "./people.js";
import { PEOPLE_SCAN_LIMIT } from "../../actions/people/shared.js";
import type { PersonRow } from "../../ports/people.js";

function createPeopleFakeSupabase(respond?: Parameters<typeof createFakeSupabase>[0]) {
	const fake = createFakeSupabase(respond);
	const origFrom = fake.client.from;
	fake.client.from = (table: string) => {
		const api = origFrom(table);
		const call: RecordedCall = fake.calls[fake.calls.length - 1];
		api.contains = (...args: unknown[]) => {
			call.filters.push({ method: "contains", args });
			return api;
		};
		return api;
	};
	return fake;
}

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
const PERSON_ID = "11111111-1111-4111-8111-111111111111";

function makeRow(id: string, name: string, overrides: Partial<PersonRow> = {}): PersonRow {
	return {
		id,
		name,
		bio: null,
		role: null,
		organization: null,
		email: null,
		phone: null,
		relationship: null,
		last_contact: null,
		tags: [],
		archived: false,
		archived_at: null,
		properties: {},
		source_url: null,
		user_id: USER_ID,
		team_id: null,
		created_at: null,
		updated_at: null,
		aliases: [],
		hot: false,
		...overrides,
	};
}

describe("createSupabasePeopleRepository (#1508)", () => {
	it("getById scopes by id and user_id and retries without migration-110 columns when missing", async () => {
		const row = makeRow(PERSON_ID, "Todd Martinez", { aliases: ["todd"], hot: true });
		const fake = createFakeSupabase((call) => {
			if (call.selected?.includes("aliases")) {
				return {
					data: null,
					error: { code: "42703", message: "column people.aliases does not exist" },
				};
			}
			return { data: row, error: null };
		});
		const repo = createSupabasePeopleRepository({
			client: fake.client as unknown as PeopleSupabaseClient,
			ownerId: USER_ID,
		});

		const found = await repo.getById(PERSON_ID);
		expect(found).toEqual(row);
		expect(fake.calls).toHaveLength(2);
		expect(fake.calls[0].selected).toBe(PERSON_COLUMNS);
		expect(fake.calls[1].selected).toBe(PERSON_BASE_COLUMNS);
		expect(fake.filtersOf(fake.calls[1], "eq")).toEqual([
			["id", PERSON_ID],
			["user_id", USER_ID],
		]);
	});

	it("load scans at most PEOPLE_SCAN_LIMIT (2000) rows when query is set and sets truncated when scan window is full", async () => {
		const filler = Array.from({ length: PEOPLE_SCAN_LIMIT - 1 }, (_, i) =>
			makeRow(`filler-${i}`, `Filler ${i}`),
		);
		const target = makeRow(PERSON_ID, "Todd Martinez", { role: "Partner" });
		const fake = createFakeSupabase(() => ({ data: [...filler, target], error: null }));
		const repo = createSupabasePeopleRepository({
			client: fake.client as unknown as PeopleSupabaseClient,
			ownerId: USER_ID,
		});

		const res = await repo.load({ query: "partner", limit: 5 });
		expect(fake.filtersOf(fake.calls[0], "limit")).toEqual([[PEOPLE_SCAN_LIMIT]]);
		expect(res.rows).toEqual([target]);
		expect(res.truncated).toBe(true);
	});

	it("load retries once without aliases/hot on migration-110 column error and rejects other errors with 'People query failed: ...'", async () => {
		const row = makeRow(PERSON_ID, "Robert Smith", {
			properties: { aliases: ["Bob"] },
		});
		const fakeRetry = createFakeSupabase((call) => {
			if (call.selected?.includes("hot")) {
				return {
					data: null,
					error: { code: "42703", message: "column people.hot does not exist" },
				};
			}
			return { data: [row], error: null };
		});
		const repoRetry = createSupabasePeopleRepository({
			client: fakeRetry.client as unknown as PeopleSupabaseClient,
			ownerId: USER_ID,
		});

		const ok = await repoRetry.load({ query: "bob" });
		expect(ok.rows).toEqual([row]);
		expect(fakeRetry.calls).toHaveLength(2);
		expect(fakeRetry.calls[0].selected).toBe(PERSON_COLUMNS);
		expect(fakeRetry.calls[1].selected).toBe(PERSON_BASE_COLUMNS);

		const fakeErr = createFakeSupabase(() => ({
			data: null,
			error: { code: "42501", message: "permission denied for view people" },
		}));
		const repoErr = createSupabasePeopleRepository({
			client: fakeErr.client as unknown as PeopleSupabaseClient,
			ownerId: USER_ID,
		});

		await expect(repoErr.load({})).rejects.toThrow(
			"People query failed: permission denied for view people",
		);
	});

	it("load refuses a foreign user_id naming the field", async () => {
		const fake = createFakeSupabase();
		const repo = createSupabasePeopleRepository({
			client: fake.client as unknown as PeopleSupabaseClient,
			ownerId: USER_ID,
		});

		await expect(repo.load({ user_id: OTHER_USER_ID }, USER_ID)).rejects.toThrow(
			/user_id/,
		);
		expect(fake.calls).toHaveLength(0);
	});

	it("self methods handle prefs read/insert/update, migration 053 hint, lookups, create, and is_self stamp (#1512)", async () => {
		const fake = createPeopleFakeSupabase((call) => {
			if (call.table === "user_preferences" && call.op === "select") {
				return { data: { self_entity_id: PERSON_ID, identity: { display_name: "Angus" } }, error: null };
			}
			if (call.table === "people") {
				return { data: { id: PERSON_ID, name: "Angus", email: "owner@example.com", properties: { email: "owner@example.com" } }, error: null };
			}
			return { data: { id: PERSON_ID, title: "Angus", properties: { role: "Founder" } }, error: null };
		});
		const repo = createSupabasePeopleRepository({ client: fake.client as unknown as PeopleSupabaseClient, ownerId: USER_ID });

		expect(await repo.readSelfPreferences()).toEqual({ self_entity_id: PERSON_ID, identity: { display_name: "Angus" }, exists: true });
		await repo.writeSelfPreferences(true, PERSON_ID, { display_name: "Angus" });
		expect(fake.calls[1]).toMatchObject({ table: "user_preferences", op: "update" });
		await repo.writeSelfPreferences(false, PERSON_ID, { display_name: "Angus" });
		expect(fake.calls[2]).toMatchObject({ table: "user_preferences", op: "insert", payload: { user_id: USER_ID, self_entity_id: PERSON_ID, identity: { display_name: "Angus" } } });

		await repo.findSelfEntityById(PERSON_ID);
		expect(fake.filtersOf(fake.calls[3], "eq")).toEqual([["user_id", USER_ID], ["id", PERSON_ID], ["archived", false]]);
		await repo.findSelfEntityByFlag();
		expect(fake.filtersOf(fake.calls[4], "contains")).toEqual([["properties", { is_self: true }]]);
		expect(await repo.findSelfEntityByEmail(["Owner@Example.com"])).toEqual({ id: PERSON_ID, title: "Angus", properties: { email: "owner@example.com" } });
		await repo.findSelfEntityByName("Angus");
		expect(fake.filtersOf(fake.calls[6], "ilike")).toEqual([["title", "Angus"]]);
		await repo.createSelfEntity({ id: PERSON_ID, title: "Angus", properties: { is_self: true } });
		expect(fake.calls[7]).toMatchObject({ table: "entities", op: "insert", payload: expect.objectContaining({ id: PERSON_ID, user_id: USER_ID, entity_type: "people" }) });
		await repo.markSelfEntity({ id: PERSON_ID, title: "Angus", properties: { role: "Founder" } });
		expect(fake.calls[8]).toMatchObject({ table: "entities", op: "update", payload: expect.objectContaining({ properties: { role: "Founder", is_self: true } }) });

		const fakeErr = createPeopleFakeSupabase(() => ({ data: null, error: { code: "42703", message: "missing col" } }));
		const repoErr = createSupabasePeopleRepository({ client: fakeErr.client as unknown as PeopleSupabaseClient, ownerId: USER_ID });
		await expect(repoErr.writeSelfPreferences(true, PERSON_ID, {})).rejects.toThrow(SELF_PREFS_MIGRATION_HINT);
		await expect(repoErr.writeSelfPreferences(false, PERSON_ID, {})).rejects.toThrow(SELF_PREFS_MIGRATION_HINT);
	});

	it("insertPeople, updatePersonById, and findExistingPeopleForEmails scope writes to entities and user_id (#1518)", async () => {
		const fake = createFakeSupabase((call) => {
			if (call.op === "select") {
				return { data: [{ id: PERSON_ID, properties: { email: "old@example.com" } }], error: null };
			}
			return {
				data: [{ id: PERSON_ID, title: "Todd", description: null, properties: {}, aliases: ["todd"] }],
				error: null,
			};
		});
		const repo = createSupabasePeopleRepository({
			client: fake.client as unknown as PeopleSupabaseClient,
			ownerId: USER_ID,
		});

		const inserted = await repo.insertPeople([
			{
				id: PERSON_ID,
				entity_type: "people",
				title: "Todd",
				description: null,
				tags: [],
				archived: false,
				archived_at: null,
				properties: {},
				source_url: null,
				team_id: null,
				aliases: ["todd"],
			},
		]);
		expect(inserted).toHaveLength(1);
		expect(fake.calls[0]).toMatchObject({
			table: "entities",
			op: "insert",
			payload: [expect.objectContaining({ id: PERSON_ID, entity_type: "people", user_id: USER_ID })],
		});

		const updated = await repo.updatePersonById(PERSON_ID, { title: "Todd M" });
		expect(updated?.id).toBe(PERSON_ID);
		expect(fake.filtersOf(fake.calls[1], "eq")).toEqual([
			["entity_type", "people"],
			["user_id", USER_ID],
			["id", PERSON_ID],
		]);

		const existing = await repo.findExistingPeopleForEmails([PERSON_ID], undefined, true);
		expect(existing.get(PERSON_ID)?.properties).toEqual({ email: "old@example.com" });
	});

	it("updatePeopleByIds and deletePeopleByIds scope to entity_type='people', user_id, and ids (#1522)", async () => {
		const fake = createPeopleFakeSupabase((call) => {
			if (call.op === "update") {
				return {
					data: [{ id: PERSON_ID, title: "Updated", description: null, properties: {}, aliases: [] }],
					error: null,
				};
			}
			return { data: [{ id: PERSON_ID, title: "Deleted" }], error: null };
		});
		const repo = createSupabasePeopleRepository({
			client: fake.client as unknown as PeopleSupabaseClient,
			ownerId: USER_ID,
		});

		const updated = await repo.updatePeopleByIds([PERSON_ID], { title: "Updated" });
		expect(updated).toEqual([
			{ id: PERSON_ID, title: "Updated", description: null, properties: {}, aliases: [] },
		]);
		expect(fake.calls[0]).toMatchObject({ table: "entities", op: "update" });
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([
			["entity_type", "people"],
			["user_id", USER_ID],
		]);
		expect(fake.filtersOf(fake.calls[0], "in")).toEqual([["id", [PERSON_ID]]]);

		const deleted = await repo.deletePeopleByIds([PERSON_ID], OTHER_USER_ID);
		expect(deleted).toEqual([{ id: PERSON_ID, title: "Deleted" }]);
		expect(fake.calls[1]).toMatchObject({ table: "entities", op: "delete" });
		expect(fake.filtersOf(fake.calls[1], "eq")).toEqual([
			["entity_type", "people"],
			["user_id", OTHER_USER_ID],
		]);
		expect(fake.filtersOf(fake.calls[1], "in")).toEqual([["id", [PERSON_ID]]]);
	});
});
