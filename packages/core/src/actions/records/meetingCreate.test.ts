import { describe, expect, it, vi } from "vitest";
import { createMeetingCreateAction } from "./meetingCreate.js";
import type { NotionPort } from "../../ports/notion.js";
import { unwiredRecordTargetError } from "./recordTarget.js";

const MEETINGS_DS = "ad82bbfd-203a-4d78-8676-33e6edd711dd";
const MEETINGS_DB = "dea2a239-ff82-49c8-bacb-4ea1179ed925";
const CONTACTS_DS = "2b09e609-fe01-8169-a3ae-000b07763b87";
const CONTACTS_DB = "2b09e609-fe01-81b5-a2c3-ff2d2e81e712";
const PERSONAL_MEETINGS_DS = "51515151-0000-1111-2222-333344445555";
const PERSONAL_MEETINGS_DB = "61616161-0000-1111-2222-333344445555";
const ANGUS_USER = "aaaaaaaa-1111-2222-3333-444444444444";

const MEETINGS_SCHEMA = {
	Name: { type: "title" },
	"Event time": { type: "date" },
	Type: {
		type: "select",
		select: { options: [{ name: "Standup" }, { name: "General" }, { name: "Workshop" }] },
	},
	Attendees: { type: "people" },
	External: { type: "relation" },
	Source: { type: "url" },
};

const PERSONAL_MEETINGS_SCHEMA = {
	Title: { type: "title" },
	When: { type: "date" },
};

const CONTACTS_SCHEMA = {
	Name: { type: "title" },
	Email: { type: "email" },
	Company: { type: "rich_text" },
	"Contact Type": {
		type: "select",
		select: { options: [{ name: "Candidate" }, { name: "Investor" }, { name: "Other" }] },
	},
};

const ctx = { caller: "test", requestId: "r1" };
type Row = { id: string; properties: Record<string, any>; archived?: boolean };
const titleRow = (id: string, name: string, email?: string): Row => ({
	id,
	properties: {
		Name: { title: [{ plain_text: name }] },
		...(email ? { Email: { email } } : {}),
	},
});

function fakePort(
	opts: {
		contacts?: Row[];
		users?: Array<{ id: string; name: string; type: string; email?: string }>;
		unwired?: boolean;
		/** Databases in the Notion-Version 2025-09-03 shape: no `properties`, a data source that has them (#2285). */
		dataSourceShape?: boolean;
	} = {},
) {
	const contacts = [...(opts.contacts ?? [])];
	const schemas: Record<string, Record<string, any>> = {
		[MEETINGS_DB]: MEETINGS_SCHEMA,
		[CONTACTS_DB]: CONTACTS_SCHEMA,
		[PERSONAL_MEETINGS_DB]: PERSONAL_MEETINGS_SCHEMA,
	};
	const createPage = vi.fn(async ({ properties }: { properties: Record<string, any> }) => ({
		id: "new-page-id",
		url: "https://notion.so/new-page-id",
		properties,
	}));
	const queryDataSource = vi.fn(async ({ dataSourceId, filter }: { dataSourceId: string; filter?: any }) => {
		if (dataSourceId !== CONTACTS_DS) return { results: [], has_more: false, next_cursor: null };
		const results = filter?.email?.equals
			? contacts.filter((r) => r.properties.Email?.email === filter.email.equals)
			: contacts;
		return { results, has_more: false, next_cursor: null };
	});
	const appendBlockChildren = vi.fn(async () => ["block-1"]);
	const DS_TO_DB: Record<string, string> = {
		[MEETINGS_DS]: MEETINGS_DB,
		[CONTACTS_DS]: CONTACTS_DB,
		[PERSONAL_MEETINGS_DS]: PERSONAL_MEETINGS_DB,
	};
	const retrieveDatabase = vi.fn(async ({ databaseId }: { databaseId: string }) =>
		opts.dataSourceShape
			? { id: databaseId, data_sources: [{ id: `first-ds-of-${databaseId}` }] }
			: { id: databaseId, properties: schemas[databaseId] ?? {} },
	);
	const retrieveDataSource = vi.fn(async ({ dataSourceId }: { dataSourceId: string }) => ({
		id: dataSourceId,
		properties: schemas[DS_TO_DB[dataSourceId]] ?? {},
	}));
	const listUsers = vi.fn(async () => opts.users ?? []);
	const resolveRecordTarget = vi.fn(async (kind: "meetings" | "contacts" | "investor_crm", domain: "work" | "angus") => {
		if (opts.unwired) throw unwiredRecordTargetError(kind, domain);
		if (kind === "contacts") return { dataSourceId: CONTACTS_DS, databaseId: CONTACTS_DB, workspace: domain };
		if (domain === "angus") return { dataSourceId: PERSONAL_MEETINGS_DS, databaseId: PERSONAL_MEETINGS_DB, workspace: domain };
		return { dataSourceId: MEETINGS_DS, databaseId: MEETINGS_DB, workspace: domain };
	});

	const port = {
		resolveRecordTarget,
		retrieveDatabase,
		retrieveDataSource,
		queryDataSource,
		listUsers,
		createPage,
		appendBlockChildren,
	} as unknown as NotionPort;

	return { port, createPage, queryDataSource, appendBlockChildren, retrieveDatabase, retrieveDataSource, listUsers };
}

describe("meeting_create (#1469)", () => {
	it("files a meeting with time, type, attendees and body", async () => {
		const { port, createPage } = fakePort({
			users: [{ id: ANGUS_USER, name: "Angus Hally", type: "person", email: "a@example.com" }],
		});
		const action = createMeetingCreateAction(port);
		const out = await action.run(
			{
				domain: "work",
				title: "Google call",
				start: "2026-09-15T10:15:00+01:00",
				end: "2026-09-15T11:00:00+01:00",
				type: "General",
				attendees: ["Angus Hally"],
				source_url: "https://meet.google.com/abc",
				body: "## Agenda\n- one\n- two",
			},
			ctx,
		);

		expect(action.formatMcp!(out)).toBe(
			"Created meeting 'Google call' in 'work': new-page-id\nhttps://notion.so/new-page-id",
		);
		const call = createPage.mock.calls[0][0];
		expect(call.properties["Event time"].date).toEqual({
			start: "2026-09-15T10:15:00+01:00",
			end: "2026-09-15T11:00:00+01:00",
		});
		expect(call.properties.Type).toEqual({ select: { name: "General" } });
		expect(call.properties.Attendees.people).toEqual([{ object: "user", id: ANGUS_USER }]);
		expect(call.properties.Source).toEqual({ url: "https://meet.google.com/abc" });
		expect(call.children.length).toBeGreaterThan(0);
	});

	it("refuses an invalid type before any write and lists the valid options", async () => {
		const { port, createPage } = fakePort();
		const err = await createMeetingCreateAction(port)
			.run(
				{
					domain: "work",
					title: "x",
					start: "2026-09-15T10:15:00+01:00",
					type: "Genral",
				},
				ctx,
			)
			.catch((e) => e);

		expect(String(err)).toMatch(/not an option of 'Type'/);
		expect(String(err)).toMatch(/Standup \| General \| Workshop/);
		expect(createPage).not.toHaveBeenCalled();
	});

	it("refuses an unknown attendee name rather than filing the meeting without them", async () => {
		const { port, createPage } = fakePort({
			users: [{ id: ANGUS_USER, name: "Angus Hally", type: "person" }],
		});
		const err = await createMeetingCreateAction(port)
			.run(
				{
					domain: "work",
					title: "x",
					start: "2026-09-15T10:15:00+01:00",
					attendees: ["Nobody Here"],
				},
				ctx,
			)
			.catch((e) => e);

		expect(String(err)).toMatch(/No user named 'Nobody Here'/);
		expect(String(err)).toMatch(/Angus Hally/);
		expect(createPage).not.toHaveBeenCalled();
	});

	it("creates external contacts through the dedup path, reusing an existing one", async () => {
		const { port, createPage } = fakePort({
			contacts: [titleRow("known-contact", "Ada Lovelace", "ada@example.com")],
		});
		const action = createMeetingCreateAction(port);
		const out = await action.run(
			{
				domain: "work",
				title: "Google call",
				start: "2026-09-15T10:15:00+01:00",
				external: [
					{ name: "Ada Lovelace", email: "ada@example.com" },
					{ name: "Alan Turing", email: "alan@example.com" },
				],
			},
			ctx,
		);

		const text = action.formatMcp!(out);
		expect(text).toMatch(/Reused existing contact 'Ada Lovelace'/);
		expect(text).toMatch(/Created contact 'Alan Turing'/);
		expect(createPage).toHaveBeenCalledTimes(2);
		expect(createPage.mock.calls[1][0].properties.External.relation).toEqual([
			{ id: "known-contact" },
			{ id: "new-page-id" },
		]);
	});

	it("accepts existing contact page ids without touching the Contacts database", async () => {
		const { port, createPage, queryDataSource } = fakePort();
		await createMeetingCreateAction(port).run(
			{
				domain: "work",
				title: "x",
				start: "2026-09-15T10:15:00+01:00",
				external: ["contact-a", "contact-b"],
			},
			ctx,
		);

		expect(createPage.mock.calls[0][0].properties.External.relation).toEqual([
			{ id: "contact-a" },
			{ id: "contact-b" },
		]);
		expect(queryDataSource).not.toHaveBeenCalled();
	});
});

describe("meeting_create - the personal workspace, whose columns are named differently", () => {
	it("finds the date property by role, not by name, and passes the personal workspace", async () => {
		const { port, createPage, retrieveDatabase } = fakePort();
		await createMeetingCreateAction(port).run(
			{
				domain: "angus",
				title: "Dentist",
				start: "2026-09-15T09:00:00+01:00",
			},
			ctx,
		);

		expect(retrieveDatabase).toHaveBeenCalledWith({ workspace: "angus", databaseId: PERSONAL_MEETINGS_DB });
		const call = createPage.mock.calls[0][0];
		expect(call.workspace).toBe("angus");
		expect(call.databaseId).toBe(PERSONAL_MEETINGS_DB);
		expect(call.properties.When.date.start).toBe("2026-09-15T09:00:00+01:00");
		expect(call.properties.Title.title[0].text.content).toBe("Dentist");
	});

	it("refuses a supplied value the database cannot hold, rather than dropping it", async () => {
		const { port, createPage } = fakePort();
		const err = await createMeetingCreateAction(port)
			.run(
				{
					domain: "angus",
					title: "Dentist",
					start: "2026-09-15T09:00:00+01:00",
					attendees: ["Angus Hally"],
				},
				ctx,
			)
			.catch((e) => e);

		expect(String(err)).toMatch(/no people property to put it in/);
		expect(String(err)).toMatch(/silently ignored/);
		expect(createPage).not.toHaveBeenCalled();
	});
});

describe("unwired config names the call that fixes it", () => {
	it("meeting_create on an unwired domain", async () => {
		const { port } = fakePort({ unwired: true });
		const err = await createMeetingCreateAction(port)
			.run(
				{
					domain: "angus",
					title: "x",
					start: "2026-09-15T09:00:00+01:00",
				},
				ctx,
			)
			.catch((e) => e);

		expect(String(err)).toMatch(/No meeting_notes_data_source_id for domain 'angus'/);
		expect(String(err)).toMatch(/integration_set\(\{ provider: 'notion_personal'/);
		expect(String(err)).toMatch(/Connections → ahKMS/);
	});

	it("requires a domain, with no default", async () => {
		const { port } = fakePort();
		const err = await createMeetingCreateAction(port)
			.run({ title: "x", start: "2026-09-15T09:00:00+01:00" } as any, ctx)
			.catch((e) => e);
		expect(String(err)).toMatch(/`domain` is required/);
	});
});

describe("meeting_create against the 2025-09-03 database shape (#2285)", () => {
	it("reads the schema from the configured data source when the database carries no properties", async () => {
		const { port, createPage, retrieveDataSource } = fakePort({ dataSourceShape: true });
		const action = createMeetingCreateAction(port);

		const out = await action.run(
			{ domain: "work", title: "Google call", start: "2026-09-15T10:15:00+01:00" },
			ctx,
		);

		expect(out.id).toBe("new-page-id");
		// The data source resolved from config, not the database's first.
		expect(retrieveDataSource).toHaveBeenCalledWith({ workspace: "work", dataSourceId: MEETINGS_DS });
		expect(createPage).toHaveBeenCalledTimes(1);
	});
});
