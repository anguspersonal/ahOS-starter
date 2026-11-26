import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "../supabase.js";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";

const getNotionConfigHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("notion_config_get")!).handler(args);

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
});

/**
 * Stub the `user_integrations` lookup for both `notion_work` and `notion_personal`
 * rows in one go, keyed by the `provider` value each `.eq()` chain queries for.
 */
function stubUserIntegrations(rows: Record<string, Record<string, unknown>>) {
	const b: any = {
		select: () => b,
		eq(this: any, col: string, value: string) {
			if (col === "provider") this._provider = value;
			return this;
		},
		maybeSingle(this: any) {
			const config = rows[this._provider as string];
			return Promise.resolve(
				config
					? { data: { config, enabled: true }, error: null }
					: { data: null, error: null },
			);
		},
	};
	(supabase as any).from = vi.fn(() => Object.create(b));
}

describe("getNotionConfigHandler", () => {
	it("recognises both 'notion_work' and 'notion_personal' rows (the #144 repro shape) when no provider filter is given", async () => {
		stubUserIntegrations({
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: {},
				notion_user_id: "u1",
				state_doc_page_id: "sdp1",
				daily_log_data_source_id: "dl1",
				investor_crm_data_source_id: "crm1",
				tasks_source_data_source_id: "to1",
				meetings_source_data_source_id: "mo1",
			},
			notion_personal: {
				tasks_database_id: "db_personal",
				title_property: "Name",
				property_map: {},
				people_database_id: "people1",
				tasks_data_source_id: "tds1",
				people_data_source_id: "pds1",
				meeting_notes_database_id: "mnd1",
				meeting_notes_data_source_id: "mnds1",
				notion_user_id: "u2",
			},
		});

		const out = await getNotionConfigHandler({});
		const text = out.content[0].text;

		expect(text).toContain("notion_work (Work workspace):");
		expect(text).toContain("tasks_database_id: db_work");
		expect(text).toContain("notion_personal (personal workspace):");
		expect(text).toContain("tasks_database_id: db_personal");
		expect(text).not.toContain("not configured");
	});

	it("surfaces the personal state_doc_page_id, and reports it unset when the `angus` domain is unwired (ADR-054 §9)", async () => {
		stubUserIntegrations({
			notion_personal: {
				tasks_database_id: "db_personal",
				title_property: "Name",
				property_map: {},
			},
		});

		const unwired = (await getNotionConfigHandler({ provider: "notion_personal" })).content[0].text;
		expect(unwired).toContain("dos pointers (`angus` domain):");
		expect(unwired).toContain("state_doc_page_id: (unset)");

		stubUserIntegrations({
			notion_personal: {
				tasks_database_id: "db_personal",
				title_property: "Name",
				property_map: {},
				state_doc_page_id: "sdp_angus",
			},
		});

		const wired = (await getNotionConfigHandler({ provider: "notion_personal" })).content[0].text;
		expect(wired).toContain("state_doc_page_id: sdp_angus");
	});

	// #1017. The dos ritual's Setup read 7 reads the personal Tasks DB for the `angus`
	// Open Actions projection, keyed on tasks_data_source_id and filtered on
	// notion_user_id. Printing both only above the dos-pointer block made them read as
	// "not an angus dos pointer", and an audit took that as a miswired domain. The raw
	// config is flat; the grouping is this formatter's alone, so it is fixed here.
	it("lists the two optional Open Actions keys inside the `angus` dos-pointer block (#1017)", async () => {
		stubUserIntegrations({
			notion_personal: {
				tasks_database_id: "db_personal",
				title_property: "Name",
				property_map: {},
				tasks_data_source_id: "tds_angus",
				notion_user_id: "u_angus",
				state_doc_page_id: "sdp_angus",
			},
		});

		const text = (await getNotionConfigHandler({ provider: "notion_personal" })).content[0].text;
		const block = text.split("dos pointers (`angus` domain):")[1].split("capture routing destinations")[0];

		expect(block).toContain("state_doc_page_id: sdp_angus");
		expect(block).toMatch(/tasks_data_source_id: tds_angus/);
		expect(block).toMatch(/notion_user_id: u_angus/);
		expect(block).toContain("optional");
	});

	it("reports the two optional Open Actions keys as unset in the dos-pointer block when absent (#1017)", async () => {
		stubUserIntegrations({
			notion_personal: {
				tasks_database_id: "db_personal",
				title_property: "Name",
				property_map: {},
			},
		});

		const text = (await getNotionConfigHandler({ provider: "notion_personal" })).content[0].text;
		const block = text.split("dos pointers (`angus` domain):")[1].split("capture routing destinations")[0];

		expect(block).toMatch(/tasks_data_source_id[^\n]*: \(unset\)/);
		expect(block).toMatch(/notion_user_id[^\n]*: \(unset\)/);
	});

	it("reports 'notion_work: not configured' (not the legacy 'notion' row name) when only notion_personal exists", async () => {
		stubUserIntegrations({
			notion_personal: {
				tasks_database_id: "db_personal",
				title_property: "Name",
				property_map: {},
			},
		});

		const out = await getNotionConfigHandler({});
		const text = out.content[0].text;

		expect(text).toContain(
			"notion_work: not configured (add a 'notion_work' row to user_integrations via integration_set(",
		);
		expect(text).toContain("notion_personal (personal workspace):");
		expect(text).not.toMatch(/add a 'notion' row/);
	});

	// #299 (capture consolidation slice 4): routing DB ids live in user_integrations,
	// never in a skill body. notion_config_get is the runtime read surface.
	it("surfaces capture routing destinations (#299) when configured, with no setup hint", async () => {
		stubUserIntegrations({
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: {},
				meetings_source_data_source_id: "mo1",
				dos_inbox_data_source_id: "dosinbox1",
			},
			notion_personal: {
				tasks_database_id: "db_personal",
				title_property: "Name",
				property_map: {},
				inbox_database_id: "pinbox1",
				inbox_data_source_id: "pinboxds1",
				resources_database_id: "pres1",
				resources_data_source_id: "presds1",
			},
		});

		const out = await getNotionConfigHandler({});
		const text = out.content[0].text;

		expect(text).toContain("capture routing destinations (#299):");
		expect(text).toContain(
			"dos_inbox_data_source_id (decommissioned per ADR-050): dosinbox1",
		);
		expect(text).toContain("inbox_database_id: pinbox1");
		expect(text).toContain("resources_database_id: pres1");
		expect(text).not.toContain("routing destination(s)");
	});

	it("degrades gracefully when routing destinations are unset: prints a setup hint pointing at integration_set (#299)", async () => {
		stubUserIntegrations({
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: {},
			},
			notion_personal: {
				tasks_database_id: "db_personal",
				title_property: "Name",
				property_map: {},
			},
		});

		const out = await getNotionConfigHandler({});
		const text = out.content[0].text;

		expect(text).toContain(
			"dos_inbox_data_source_id (decommissioned per ADR-050): (unset)",
		);
		expect(text).toContain(
			"routing destination(s) [meetings_source_data_source_id] unset",
		);
		expect(text).toContain("integration_set({ provider: 'notion_work'");
		expect(text).toContain(
			"routing destination(s) [inbox_database_id, inbox_data_source_id, resources_database_id, resources_data_source_id] unset",
		);
		expect(text).toContain("integration_set({ provider: 'notion_personal'");
	});

	it("names the data_source_id keys in the setup hint when only the database_id half of notion_personal routing is set (#299 M1)", async () => {
		stubUserIntegrations({
			notion_personal: {
				tasks_database_id: "db_personal",
				title_property: "Name",
				property_map: {},
				inbox_database_id: "pinbox1",
				resources_database_id: "pres1",
				// inbox_data_source_id / resources_data_source_id intentionally left unset —
				// this is exactly the state the PR's documented operator step leaves behind.
			},
		});

		const out = await getNotionConfigHandler({ provider: "notion_personal" });
		const text = out.content[0].text;

		expect(text).toContain("inbox_database_id: pinbox1");
		expect(text).toContain("resources_database_id: pres1");
		expect(text).toContain("inbox_data_source_id: (unset)");
		expect(text).toContain("resources_data_source_id: (unset)");
		expect(text).toContain(
			"routing destination(s) [inbox_data_source_id, resources_data_source_id] unset",
		);
		expect(text).toContain("integration_set({ provider: 'notion_personal'");
	});

	it("surfaces no setup hint for notion_personal once all four routing keys (database_id + data_source_id) are set", async () => {
		stubUserIntegrations({
			notion_personal: {
				tasks_database_id: "db_personal",
				title_property: "Name",
				property_map: {},
				inbox_database_id: "pinbox1",
				inbox_data_source_id: "pinboxds1",
				resources_database_id: "pres1",
				resources_data_source_id: "presds1",
			},
		});

		const out = await getNotionConfigHandler({ provider: "notion_personal" });
		const text = out.content[0].text;

		expect(text).not.toContain("routing destination(s)");
	});

	// #617 / ADR-053 §6: a SECOND named pointer for the private Meetings DB. dos
	// reads both; Recent Communications projects from the public one only. The read
	// surface has to say so, because it is what the ritual reads at runtime.
	it("surfaces the private meetings source and names the public source as the only projection source (#617)", async () => {
		stubUserIntegrations({
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: {},
				meetings_source_data_source_id: "public_meetings_1",
				private_meetings_source_data_source_id: "private_meetings_1",
			},
		});

		const out = await getNotionConfigHandler({ provider: "notion_work" });
		const text = out.content[0].text;

		expect(text).toContain("private_meetings_source_data_source_id: private_meetings_1");
		expect(text).toContain("dos may read: public_meetings_1, private_meetings_1");
		expect(text).toContain("Recent Communications projects from: public_meetings_1");
		expect(text).toContain("captured meetings are written to: public_meetings_1");
		expect(text).toContain("NOT an enforced permission");

		// The projection line must never name the private source.
		const projectionLine = text
			.split("\n")
			.find((l) => l.includes("Recent Communications projects from:"));
		expect(projectionLine).toBeDefined();
		expect(projectionLine).not.toContain("private_meetings_1");
	});

	it("leaves the projection source unset rather than falling back to the private one (#617)", async () => {
		stubUserIntegrations({
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: {},
				private_meetings_source_data_source_id: "private_meetings_1",
			},
		});

		const out = await getNotionConfigHandler({ provider: "notion_work" });
		const text = out.content[0].text;

		expect(text).toContain("dos may read: private_meetings_1");
		expect(text).toContain("Recent Communications projects from: (unset)");
	});

	it("reports the private meetings source as (unset) for a config that predates it (#617 additive)", async () => {
		stubUserIntegrations({
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: {},
				meetings_source_data_source_id: "public_meetings_1",
				dos_inbox_data_source_id: "dosinbox1",
			},
		});

		const out = await getNotionConfigHandler({ provider: "notion_work" });
		const text = out.content[0].text;

		expect(text).toContain("private_meetings_source_data_source_id: (unset)");
		expect(text).toContain("dos may read: public_meetings_1");
		expect(text).toContain("Recent Communications projects from: public_meetings_1");
		// The new key is not a capture routing destination, so it must not widen the
		// #299 setup hint.
		expect(text).not.toContain("routing destination(s)");
	});

	it("filters to just notion_personal when provider='notion_personal' is passed", async () => {
		stubUserIntegrations({
			notion_personal: {
				tasks_database_id: "db_personal",
				title_property: "Name",
				property_map: {},
			},
		});

		const out = await getNotionConfigHandler({ provider: "notion_personal" });
		const text = out.content[0].text;

		expect(text).toContain("notion_personal (personal workspace):");
		expect(text).not.toContain("notion_work");
	});

	// #674. This is the regression test for the silent-drop path, and the check that
	// would have caught 097bf71f: integration_set persists the RAW merged object
	// while loadIntegrationConfig returns the zod-PARSED one, and z.object strips unknown
	// keys rather than erroring. Wire a pointer whose key the schema does not declare and
	// you get a success message, a row that holds the value, and every reader — including
	// this tool, whose whole job is to show you the config — seeing nothing. Adding the
	// zod key without a print line here leaves half of that defect in place.
	it("prints the daily-log pointer pair for BOTH domains, wired and unwired (#674)", async () => {
		stubUserIntegrations({
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: {},
				daily_log_data_source_id: "hl_dl_ds",
				// daily_log_database_id deliberately unset: the Work Daily Log DB is not
				// connected to the ahKMS integration yet (#655), so there is nothing to point at.
			},
			notion_personal: {
				tasks_database_id: "db_personal",
				title_property: "Name",
				property_map: {},
				daily_log_database_id: "angus_dl_db",
				daily_log_data_source_id: "angus_dl_ds",
			},
		});

		const text = (await getNotionConfigHandler({})).content[0].text;

		expect(text).toContain("daily_log_database_id: angus_dl_db");
		expect(text).toContain("daily_log_data_source_id: angus_dl_ds");
		expect(text).toContain("daily_log_database_id: (unset)");
		expect(text).toContain("daily_log_data_source_id: hl_dl_ds");

		// The raw line is the other half of the check: a key the schema does not declare
		// is stripped before it ever reaches this string.
		expect(text).toContain('"daily_log_database_id":"angus_dl_db"');
	});
});
