import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../integrations.js", async (importOriginal) => {
	// Keep the real schemas (the rule config parses through them); mock only the
	// Supabase-backed loader.
	const actual = await importOriginal<typeof import("../integrations.js")>();
	return { ...actual, loadIntegrationConfig: vi.fn() };
});
vi.mock("../credentials.js", () => ({ getCredential: vi.fn() }));
vi.mock("../notion.js", () => ({
	retrieveNotionPage: vi.fn(),
	updateNotionPageProperties: vi.fn(),
	queryNotionDataSource: vi.fn(),
}));

import { loadIntegrationConfig } from "../integrations.js";
import { getCredential } from "../credentials.js";
import {
	retrieveNotionPage,
	updateNotionPageProperties,
	queryNotionDataSource,
} from "../notion.js";
import {
	decideCompletedAt,
	handleNotionPagePropertiesUpdated,
	pageInDataSource,
	statusPropertyUpdated,
	sweepCompletedAtDrift,
	SETUP_HINT,
} from "./completedAtStamp.js";

const RULE = {
	data_source_id: "ds-123",
	status_property: "Status",
	done_values: ["Done"],
	completed_at_property: "Completed at",
};

// A valid notion_personal config carrying the rule (loadIntegrationConfig is
// mocked, so this is exactly what the loader hands back).
const CONFIG = {
	tasks_database_id: "db-1",
	title_property: "Name",
	property_map: {},
	automations: { completed_at_stamp: RULE },
};

const EVENT_TS = "2026-08-05T10:00:00.000Z";

function page(opts: {
	status?: string | null;
	completedAt?: string | null;
	dataSourceId?: string;
	statusPropId?: string;
}) {
	return {
		id: "page-1",
		last_edited_time: "2026-08-04T09:00:00.000Z",
		parent: { type: "data_source_id", data_source_id: opts.dataSourceId ?? "ds-123" },
		properties: {
			Status: {
				id: opts.statusPropId ?? "XGe@",
				type: "status",
				status: opts.status === null ? null : { name: opts.status ?? "Done" },
			},
			"Completed at": {
				id: "DbAu",
				type: "date",
				date: opts.completedAt ? { start: opts.completedAt } : null,
			},
		},
	};
}

function makeEvent(updatedProperties: string[] = ["XGe%40"]) {
	return {
		timestamp: EVENT_TS,
		entity: { id: "page-1", type: "page" },
		data: { updated_properties: updatedProperties },
	};
}

beforeEach(() => {
	(loadIntegrationConfig as any).mockResolvedValue(CONFIG);
	(getCredential as any).mockResolvedValue("personal-token");
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("decideCompletedAt (pure decision core)", () => {
	it("stamps with the source timestamp when Done and empty", () => {
		expect(decideCompletedAt(page({ status: "Done", completedAt: null }), RULE, EVENT_TS)).toEqual({
			action: "stamp",
			timestamp: EVENT_TS,
		});
	});

	it("clears when not Done and set", () => {
		expect(
			decideCompletedAt(page({ status: "In progress", completedAt: "2026-08-01" }), RULE, EVENT_TS),
		).toEqual({ action: "clear" });
	});

	it("no-ops when Done and already stamped (loop terminator)", () => {
		expect(
			decideCompletedAt(page({ status: "Done", completedAt: "2026-08-01" }), RULE, EVENT_TS),
		).toEqual({ action: "none", reason: "already-stamped" });
	});

	it("no-ops when not Done and already clear (loop terminator)", () => {
		expect(
			decideCompletedAt(page({ status: "To do", completedAt: null }), RULE, EVENT_TS),
		).toEqual({ action: "none", reason: "already-clear" });
	});

	it("treats a null status as not-Done", () => {
		expect(
			decideCompletedAt(page({ status: null, completedAt: null }), RULE, EVENT_TS),
		).toEqual({ action: "none", reason: "already-clear" });
	});
});

describe("pageInDataSource", () => {
	it("matches ignoring dash formatting and case", () => {
		const p = page({});
		p.parent = { type: "data_source_id", data_source_id: "DS-123" };
		expect(pageInDataSource(p as any, RULE)).toBe(true);
	});

	it("rejects a page from another data source", () => {
		expect(pageInDataSource(page({ dataSourceId: "ds-other" }) as any, RULE)).toBe(false);
	});
});

describe("statusPropertyUpdated", () => {
	it("matches URL-encoded webhook property ids against the page's property id", () => {
		expect(statusPropertyUpdated(page({}) as any, RULE, ["XGe%40", "bDf%5B"])).toBe(true);
	});

	it("matches raw (unencoded) ids too", () => {
		expect(statusPropertyUpdated(page({ statusPropId: "abc" }) as any, RULE, ["abc"])).toBe(true);
	});

	it("returns false when only other properties changed", () => {
		expect(statusPropertyUpdated(page({}) as any, RULE, ["DbAu"])).toBe(false);
	});
});

describe("handleNotionPagePropertiesUpdated (webhook fast path)", () => {
	it("stamps Completed at from the EVENT timestamp when ticked Done", async () => {
		(retrieveNotionPage as any).mockResolvedValue(page({ status: "Done", completedAt: null }));

		const outcome = await handleNotionPagePropertiesUpdated(makeEvent());

		expect(outcome).toBe("stamped");
		expect(updateNotionPageProperties).toHaveBeenCalledWith(
			"page-1",
			{ "Completed at": { date: { start: EVENT_TS } } },
			"personal-token",
		);
	});

	it("clears Completed at when un-ticked", async () => {
		(retrieveNotionPage as any).mockResolvedValue(
			page({ status: "To do", completedAt: "2026-08-01" }),
		);

		const outcome = await handleNotionPagePropertiesUpdated(makeEvent());

		expect(outcome).toBe("cleared");
		expect(updateNotionPageProperties).toHaveBeenCalledWith(
			"page-1",
			{ "Completed at": { date: null } },
			"personal-token",
		);
	});

	it("no-ops (no PATCH) when already correct in both directions — our own PATCH's event terminates", async () => {
		(retrieveNotionPage as any).mockResolvedValue(
			page({ status: "Done", completedAt: "2026-08-01" }),
		);
		expect(await handleNotionPagePropertiesUpdated(makeEvent())).toBe("noop");

		(retrieveNotionPage as any).mockResolvedValue(page({ status: "To do", completedAt: null }));
		expect(await handleNotionPagePropertiesUpdated(makeEvent())).toBe("noop");

		expect(updateNotionPageProperties).not.toHaveBeenCalled();
	});

	it("ignores a page from a different data source without patching", async () => {
		(retrieveNotionPage as any).mockResolvedValue(
			page({ status: "Done", completedAt: null, dataSourceId: "ds-other" }),
		);

		const outcome = await handleNotionPagePropertiesUpdated(makeEvent());

		expect(outcome).toBe("ignored-other-data-source");
		expect(updateNotionPageProperties).not.toHaveBeenCalled();
	});

	it("ignores events where the status property was not among updated_properties (e.g. our own completed-at PATCH)", async () => {
		(retrieveNotionPage as any).mockResolvedValue(page({ status: "Done", completedAt: null }));

		// Only the Completed-at property id changed — exactly what our own PATCH fires.
		const outcome = await handleNotionPagePropertiesUpdated(makeEvent(["DbAu"]));

		expect(outcome).toBe("ignored-status-unchanged");
		expect(updateNotionPageProperties).not.toHaveBeenCalled();
	});

	it("skips gracefully with a setup hint when the rule is not configured", async () => {
		(loadIntegrationConfig as any).mockResolvedValue({ ...CONFIG, automations: undefined });
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const outcome = await handleNotionPagePropertiesUpdated(makeEvent());

		expect(outcome).toBe("unconfigured");
		expect(retrieveNotionPage).not.toHaveBeenCalled();
		expect(updateNotionPageProperties).not.toHaveBeenCalled();
		expect(errSpy).toHaveBeenCalledWith(SETUP_HINT);
		errSpy.mockRestore();
	});

	it("ignores an event with no page id", async () => {
		expect(await handleNotionPagePropertiesUpdated({ timestamp: EVENT_TS })).toBe(
			"ignored-no-page",
		);
		expect(loadIntegrationConfig).not.toHaveBeenCalled();
	});
});

describe("sweepCompletedAtDrift (reconciliation net)", () => {
	it("converges both directions: stamps Done+empty from last_edited_time, clears not-Done+set", async () => {
		const donePage = { ...page({ status: "Done", completedAt: null }), id: "p-done" };
		const undonePage = {
			...page({ status: "To do", completedAt: "2026-08-01" }),
			id: "p-undone",
		};
		const okPage = { ...page({ status: "Done", completedAt: "2026-08-01" }), id: "p-ok" };
		(queryNotionDataSource as any).mockResolvedValue({
			results: [donePage, undonePage, okPage],
			next_cursor: null,
			has_more: false,
		});

		const counts = await sweepCompletedAtDrift();

		expect(counts).toEqual({ scanned: 3, stamped: 1, cleared: 1, unchanged: 1, errors: 0 });
		expect(updateNotionPageProperties).toHaveBeenCalledTimes(2);
		expect(updateNotionPageProperties).toHaveBeenCalledWith(
			"p-done",
			{ "Completed at": { date: { start: donePage.last_edited_time } } },
			"personal-token",
		);
		expect(updateNotionPageProperties).toHaveBeenCalledWith(
			"p-undone",
			{ "Completed at": { date: null } },
			"personal-token",
		);
	});

	it("paginates through has_more/next_cursor", async () => {
		(queryNotionDataSource as any)
			.mockResolvedValueOnce({
				results: [{ ...page({ status: "Done", completedAt: null }), id: "p1" }],
				next_cursor: "c2",
				has_more: true,
			})
			.mockResolvedValueOnce({
				results: [{ ...page({ status: "Done", completedAt: null }), id: "p2" }],
				next_cursor: null,
				has_more: false,
			});

		const counts = await sweepCompletedAtDrift();

		expect(counts).toEqual({ scanned: 2, stamped: 2, cleared: 0, unchanged: 0, errors: 0 });
		expect(queryNotionDataSource).toHaveBeenCalledTimes(2);
		expect((queryNotionDataSource as any).mock.calls[0][0]).toBe("ds-123");
		expect((queryNotionDataSource as any).mock.calls[1][2]).toEqual({ cursor: "c2" });
	});

	it("skips archived pages", async () => {
		(queryNotionDataSource as any).mockResolvedValue({
			results: [{ ...page({ status: "Done", completedAt: null }), archived: true }],
			next_cursor: null,
			has_more: false,
		});

		const counts = await sweepCompletedAtDrift();

		expect(counts).toEqual({ scanned: 0, stamped: 0, cleared: 0, unchanged: 0, errors: 0 });
		expect(updateNotionPageProperties).not.toHaveBeenCalled();
	});

	it("counts a per-page write failure and keeps sweeping", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		(queryNotionDataSource as any).mockResolvedValue({
			results: [
				{ ...page({ status: "Done", completedAt: null }), id: "p-fail" },
				{ ...page({ status: "Done", completedAt: null }), id: "p-ok" },
			],
			next_cursor: null,
			has_more: false,
		});
		(updateNotionPageProperties as any)
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce(undefined);

		const counts = await sweepCompletedAtDrift();

		expect(counts).toEqual({ scanned: 2, stamped: 1, cleared: 0, unchanged: 0, errors: 1 });
		errSpy.mockRestore();
	});

	it("returns null with the setup hint when the rule is not configured (no queries, no writes)", async () => {
		(loadIntegrationConfig as any).mockResolvedValue(null);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(await sweepCompletedAtDrift()).toBeNull();

		expect(queryNotionDataSource).not.toHaveBeenCalled();
		expect(updateNotionPageProperties).not.toHaveBeenCalled();
		expect(errSpy).toHaveBeenCalledWith(SETUP_HINT);
		errSpy.mockRestore();
	});
});
