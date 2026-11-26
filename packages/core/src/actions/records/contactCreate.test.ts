import { describe, expect, it, vi } from "vitest";
import { createContactCreateAction } from "./contactCreate.js";
import type { NotionPort } from "../../ports/notion.js";

const CONTACTS_DS = "2b09e609-fe01-8169-a3ae-000b07763b87";
const CONTACTS_DB = "2b09e609-fe01-81b5-a2c3-ff2d2e81e712";
const CONTACTS_SCHEMA = {
	Name: { type: "title" },
	Email: { type: "email" },
	Company: { type: "rich_text" },
	"Contact Type": { type: "select", select: { options: [{ name: "Candidate" }, { name: "Investor" }, { name: "Other" }] } },
};
const ctx = { caller: "test", requestId: "r1" };
type Row = { id: string; properties: Record<string, any>; archived?: boolean };
const titleRow = (id: string, name: string, email?: string): Row => ({
	id,
	properties: { Name: { title: [{ plain_text: name }] }, ...(email ? { Email: { email } } : {}) },
});

function fakePort(opts: { contacts?: Row[]; unwired?: boolean; dataSourceShape?: boolean } = {}) {
	const rows = [...(opts.contacts ?? [])];
	const createPage = vi.fn(async ({ properties }: { properties: Record<string, any> }) => {
		const id = `new-page-${rows.length + 1}`;
		rows.push(titleRow(id, properties.Name?.title?.[0]?.text?.content ?? "", properties.Email?.email));
		return { id, url: `https://notion.so/${id}` };
	});
	const port = {
		...(opts.unwired ? {} : { resolveRecordTarget: vi.fn(async (_k, domain) => ({ dataSourceId: CONTACTS_DS, databaseId: CONTACTS_DB, workspace: domain })) }),
		// `dataSourceShape` is what Notion-Version 2025-09-03 returns: no `properties` on the
		// database, the schema on its data source (#2285).
		retrieveDatabase: vi.fn(async () =>
			opts.dataSourceShape
				? { id: CONTACTS_DB, data_sources: [{ id: "first-ds" }] }
				: { id: CONTACTS_DB, properties: CONTACTS_SCHEMA },
		),
		retrieveDataSource: vi.fn(async ({ dataSourceId }: { dataSourceId: string }) => ({
			id: dataSourceId,
			properties: CONTACTS_SCHEMA,
		})),
		queryDataSource: vi.fn(async ({ filter }: { filter?: any }) => ({
			results: filter?.email?.equals ? rows.filter((r) => r.properties.Email?.email === filter.email.equals) : rows,
			has_more: false,
			next_cursor: null,
		})),
		createPage,
	} as unknown as NotionPort;
	return { port, createPage };
}

describe("contact_create — dedup is the feature (#1577)", () => {
	it("returns existing contact on email or exact name match, and does NOT match near-miss name", async () => {
		const { port, createPage } = fakePort({
			contacts: [titleRow("existing-1", "Ada Lovelace", "ada@example.com"), titleRow("existing-2", "Grace Hopper"), titleRow("existing-3", "Alan Turing Jr")],
		});
		const action = createContactCreateAction(port);
		const byEmail = await action.run({ domain: "work", name: "Ada Lovelace", email: "ada@example.com" }, ctx);
		expect(byEmail).toEqual({ id: "existing-1", url: "https://www.notion.so/existing1", created: false, name: "Ada Lovelace", domain: "work" });
		expect(action.formatMcp!(byEmail)).toBe(
			"Contact 'Ada Lovelace' already exists in 'work' — returning it, nothing was written: existing-1\nhttps://www.notion.so/existing1",
		);
		const byName = await action.run({ domain: "work", name: "Grace Hopper" }, ctx);
		expect(byName).toMatchObject({ id: "existing-2", created: false });
		expect(createPage).not.toHaveBeenCalled();

		const miss = await action.run({ domain: "work", name: "Alan Turing" }, ctx);
		expect(miss.created).toBe(true);
		expect(createPage).toHaveBeenCalledTimes(1);
	});

	it("creates a new contact with validated contact_type, and calling twice writes once (idempotentHint: true)", async () => {
		const { port, createPage } = fakePort();
		const action = createContactCreateAction(port);
		const input = { domain: "work" as const, name: "Ada Lovelace", email: "ada@example.com", company: "Analytical Engines", contact_type: "Investor" };
		const first = await action.run(input, ctx);
		expect(first.created).toBe(true);
		expect(action.formatMcp!(first)).toBe("Created contact 'Ada Lovelace' in 'work': new-page-1\nhttps://notion.so/new-page-1");
		expect(createPage.mock.calls[0][0].properties).toEqual({
			Name: { title: [{ text: { content: "Ada Lovelace" } }] },
			Email: { email: "ada@example.com" },
			"Contact Type": { select: { name: "Investor" } },
			Company: { rich_text: [{ text: { content: "Analytical Engines" } }] },
		});
		const second = await action.run(input, ctx);
		expect(second).toMatchObject({ id: "new-page-1", created: false });
		expect(createPage).toHaveBeenCalledTimes(1);
	});

	it("refuses unknown contact_type before writing and gives #1576's error on an unwired domain", async () => {
		const { port, createPage } = fakePort();
		await expect(createContactCreateAction(port).run({ domain: "work", name: "Ada", contact_type: "Investorr" }, ctx)).rejects.toThrow(
			/not an option of 'Contact Type'[\s\S]*Candidate \| Investor \| Other/,
		);
		expect(createPage).not.toHaveBeenCalled();
		await expect(createContactCreateAction(fakePort({ unwired: true }).port).run({ domain: "work", name: "Ada" }, ctx)).rejects.toThrow(
			/No contacts_data_source_id for domain 'work'[\s\S]*integration_set\(\{ provider: 'notion_work'/,
		);
	});
});

describe("contact_create against the 2025-09-03 database shape (#2285)", () => {
	it("reads the schema from the configured data source and creates the contact", async () => {
		const { port, createPage } = fakePort({ dataSourceShape: true });
		const action = createContactCreateAction(port);

		const out = await action.run({ domain: "work", name: "Ada Lovelace", email: "ada@example.com" }, ctx);

		expect(out.created).toBe(true);
		expect(port.retrieveDataSource).toHaveBeenCalledWith({ workspace: "work", dataSourceId: CONTACTS_DS });
		expect(createPage.mock.calls[0][0].properties.Name).toEqual({
			title: [{ text: { content: "Ada Lovelace" } }],
		});
	});
});
