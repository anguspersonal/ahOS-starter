import { describe, expect, it, vi } from "vitest";
import type { NotionApiError, NotionPort } from "../../ports/notion.js";
import type { ConfigRepository } from "../../ports/config.js";
import { createDailyLogCreateAction, DailyLogDuplicateRefusalError } from "./dailyLogCreate.js";

function makeConfigRepo(
	dosConfig: Record<string, unknown>,
	integrationConfig: Record<string, unknown> | null = {
		tasks_database_id: "db1",
		daily_log_database_id: "db-work",
		daily_log_data_source_id: "ds-work",
	},
): Pick<ConfigRepository, "loadConfigDetailed" | "loadDosConfigRow"> {
	return {
		loadConfigDetailed: vi.fn().mockImplementation(async (_provider, schema) => {
			if (!integrationConfig) return { status: "unwired" as const };
			const parsed = schema.safeParse(integrationConfig);
			return parsed.success ? { status: "ok" as const, data: parsed.data } : { status: "unwired" as const };
		}),
		loadDosConfigRow: vi.fn().mockResolvedValue(dosConfig),
	};
}

function makeNotionPort(overrides: Partial<NotionPort> = {}): NotionPort {
	return {
		resolveToken: vi.fn().mockResolvedValue("ntn_fake"),
		retrieveDatabase: vi.fn().mockResolvedValue({
			id: "db-work",
			properties: {
				Name: { type: "title" },
				Date: { type: "date" },
				Covers: { type: "multi_select", options: [{ name: "2026-08-21" }, { name: "2026-08-22" }] },
				Pillars: { type: "multi_select", options: [{ name: "Product" }, { name: "Growth" }] },
				Summary: { type: "rich_text" },
			},
		}),
		queryDataSource: vi.fn().mockResolvedValue({ results: [], has_more: false, next_cursor: null }),
		createPage: vi.fn().mockResolvedValue({ id: "page-1", url: "https://www.notion.so/page-1" }),
		appendBlockChildren: vi.fn().mockResolvedValue({ results: [] }),
		...overrides,
	} as unknown as NotionPort;
}

const WORK_DOS_CONFIG = {
	by_domain: {
		work: {
			daily_log_schema: {
				properties: [
					{ name: "Name", notion_type: "title", required: true },
					{ name: "Date", notion_type: "date", required: true },
					{ name: "Covers", notion_type: "multi_select", required: false, role: "covers" },
					{ name: "Pillars", notion_type: "multi_select", required: false, role: "pillars" },
					{ name: "Summary", notion_type: "rich_text", required: true },
				],
			},
		},
	},
};

// #2285: the shape Notion-Version 2025-09-03 actually returns. The SDK the adapter uses
// defaults to that version, so this is what production sees; every fixture above is the
// older shape, which is how the regression shipped.
describe("daily_log_create against the 2025-09-03 database shape (#2285)", () => {
	const PROPERTIES = {
		Name: { type: "title" },
		Date: { type: "date" },
		Summary: { type: "rich_text" },
	};
	const input = {
		domain: "work" as const,
		date: "2026-11-13",
		title: "13 Nov (unattended)",
		body: "Swept.",
		properties: { Summary: { rich_text: [{ text: { content: "Swept." } }] } },
	};

	it("reads the title and date properties from the data source and writes the entry", async () => {
		const notion = makeNotionPort({
			retrieveDatabase: vi.fn().mockResolvedValue({ id: "db-work", data_sources: [{ id: "ds-work" }] }),
			retrieveDataSource: vi.fn().mockResolvedValue({ id: "ds-work", properties: PROPERTIES }),
		});
		const action = createDailyLogCreateAction({ notion, config: makeConfigRepo(WORK_DOS_CONFIG) });

		const out = await action.run(input, { caller: "mcp" });

		expect(out.id).toBe("page-1");
		expect(notion.retrieveDataSource).toHaveBeenCalled();
		const created = vi.mocked(notion.createPage).mock.calls[0][0];
		expect(created.properties).toMatchObject({
			Name: { title: [{ text: { content: "13 Nov (unattended)" } }] },
			Date: { date: { start: "2026-11-13" } },
		});
	});

	it("says the schema is missing, naming both ids, when neither place has properties", async () => {
		const notion = makeNotionPort({
			retrieveDatabase: vi.fn().mockResolvedValue({ id: "db-work", data_sources: [{ id: "ds-work" }] }),
			retrieveDataSource: vi.fn().mockResolvedValue({ id: "ds-work" }),
		});
		const action = createDailyLogCreateAction({ notion, config: makeConfigRepo(WORK_DOS_CONFIG) });

		const err = await action.run(input, { caller: "mcp" }).catch((e) => e);

		expect(err.message).toContain("returned no properties");
		expect(err.message).toContain("ds-work");
		expect(err.message).not.toContain("should be impossible");
		expect(notion.createPage).not.toHaveBeenCalled();
	});
});

describe("createDailyLogCreateAction (#1503)", () => {
	it("creates a Daily Log entry via NotionPort, appends overflow blocks, and formats MCP output", async () => {
		const notion = makeNotionPort();
		const config = makeConfigRepo(WORK_DOS_CONFIG);
		const action = createDailyLogCreateAction({ notion, config });

		const body = Array.from({ length: 105 }, (_, i) => `Line ${i + 1}`).join("\n");
		const out = await action.run(
			{
				domain: "work",
				date: "2026-08-21",
				covers: ["2026-08-21", "2026-08-22"],
				pillars: ["Product"],
				title: "Aug 21 Log",
				body,
				properties: {
					Summary: { rich_text: [{ text: { content: "Closed sprint." } }] },
				},
			},
			{ caller: "mcp" },
		);

		expect(out).toMatchObject({
			id: "page-1",
			url: "https://www.notion.so/page-1",
			domain: "work",
			provider: "notion_work",
			blocksWritten: 105,
		});
		expect(notion.createPage).toHaveBeenCalledTimes(1);
		expect(notion.appendBlockChildren).toHaveBeenCalledTimes(1);

		const text = action.formatMcp!(out);
		expect(text).toContain("Daily Log entry created (work): Aug 21 Log");
		expect(text).toContain("  page_id: page-1");
		expect(text).toContain("  page_url: https://www.notion.so/page-1");
		expect(text).toContain("  provider: notion_work");
		expect(text).toContain("  blocks written: 105");
		expect(text).toContain("  covers: 2026-08-21, 2026-08-22");
		expect(text).toContain("  pillars: Product");
		expect(text).toContain("Consumption markers, dos ritual only:");
		expect(text).toContain("synthesized");
		expect(text).toContain("synthesized_unattended");
		expect(text).toContain("evidence_aggregated");
		expect(text).toContain("evidence_aggregated_unattended");
	});

	it("enforces #1139 required-property guard from dos_config.daily_log_schema before writing to Notion", async () => {
		const notion = makeNotionPort();
		const config = makeConfigRepo(WORK_DOS_CONFIG);
		const action = createDailyLogCreateAction({ notion, config });

		await expect(
			action.run(
				{
					domain: "work",
					date: "2026-08-21",
					title: "Missing Summary",
				},
				{ caller: "mcp" },
			),
		).rejects.toThrow(
			"Domain 'work' Daily Log write refused: missing required property 'Summary' (declared required: true in dos_config.daily_log_schema). Provide 'Summary' in properties (#1139).",
		);
		expect(notion.createPage).not.toHaveBeenCalled();
	});

	it("refuses duplicate covered days with twin_present lookup unless allow_duplicate is true", async () => {
		const notion = makeNotionPort({
			queryDataSource: vi.fn().mockResolvedValue({
				results: [
					{
						id: "existing-page-9",
						properties: {
							Covers: { type: "multi_select", multi_select: [{ name: "2026-08-21" }] },
						},
					},
				],
				has_more: false,
				next_cursor: null,
			}),
		});
		const config = makeConfigRepo(WORK_DOS_CONFIG);
		const hasDailyLogTwin = vi.fn().mockResolvedValue(true);
		const action = createDailyLogCreateAction({
			notion,
			config,
			externalLinks: { hasDailyLogTwin },
		});

		const baseArgs = {
			domain: "work" as const,
			date: "2026-08-21",
			covers: ["2026-08-21", "2026-08-22"],
			title: "Dup Log",
			properties: {
				Summary: { rich_text: [{ text: { content: "Summary." } }] },
			},
		};

		const err = await action.run(baseArgs, { caller: "mcp" }).catch((e) => e);
		expect(err).toBeInstanceOf(DailyLogDuplicateRefusalError);
		expect(err.twin_present).toBe(true);
		expect(err.existing_page_ids).toEqual(["existing-page-9"]);
		expect(err.message).toContain("an existing Daily Log entry already covers 2026-08-21 (existing-page-9)");
		expect(hasDailyLogTwin).toHaveBeenCalledWith(["existing-page-9"]);
		expect(notion.createPage).not.toHaveBeenCalled();

		const allowed = await action.run({ ...baseArgs, allow_duplicate: true }, { caller: "mcp" });
		expect(allowed.id).toBe("page-1");
		expect(notion.createPage).toHaveBeenCalledTimes(1);
	});

	it("maps Notion 404 on retrieveDatabase to reachabilityError", async () => {
		const notFoundErr = Object.assign(new Error("Notion API error (404): Not found"), {
			name: "NotionApiError" as const,
			status: 404,
			code: "object_not_found",
		}) as NotionApiError;
		const notion = makeNotionPort({
			retrieveDatabase: vi.fn().mockRejectedValue(notFoundErr),
		});
		const config = makeConfigRepo(WORK_DOS_CONFIG);
		const action = createDailyLogCreateAction({ notion, config });

		await expect(
			action.run(
				{
					domain: "work",
					date: "2026-08-21",
					title: "Unreachable DB",
				},
				{ caller: "mcp" },
			),
		).rejects.toThrow(/pointer db-work[\s\S]*cannot see it \(Notion returned 404\)/);
	});
});

// #2258: the twin and its `daily_log` pointer are written by this tool, in one call, when
// the caller opts in with `write_twin: true`. Without the argument nothing about the tool
// changes, because old skill copies still run Step 8b and capture never dedups a
// `daily_log` twin (#1124).
describe("daily_log_create write_twin (#2258)", () => {
	const BODY = "## Shipped\n- The twin moved server-side.";
	const baseArgs = {
		domain: "work" as const,
		date: "2026-08-21",
		pillars: ["Product"],
		title: "Aug 21 Log",
		body: BODY,
		properties: { Summary: { rich_text: [{ text: { content: "Closed sprint." } }] } },
	};

	function makeTwinPorts(calls: string[] = []) {
		const capture = vi.fn().mockImplementation(async () => {
			calls.push("capture");
			return { id: "twin-1", deduplicated: false };
		});
		const recordExternalLink = vi.fn().mockImplementation(async () => {
			calls.push("pointer");
			return { ok: true };
		});
		const mutateByIds = vi.fn().mockImplementation(async () => {
			calls.push("archive");
			return [{ id: "twin-1", title: "Aug 21 Log" }];
		});
		return {
			capture,
			recordExternalLink,
			mutateByIds,
			twin: { capture: { capture }, links: { recordExternalLink }, artifacts: { mutateByIds } },
		};
	}

	function makeAction(
		twin?: ReturnType<typeof makeTwinPorts>["twin"],
		notionOverrides: Partial<NotionPort> = {},
		calls: string[] = [],
	) {
		const notion = makeNotionPort({
			createPage: vi.fn().mockImplementation(async () => {
				calls.push("page");
				return { id: "page-1", url: "https://www.notion.so/page-1" };
			}),
			...notionOverrides,
		});
		const action = createDailyLogCreateAction({
			notion,
			config: makeConfigRepo(WORK_DOS_CONFIG),
			...(twin ? { twin } : {}),
		} as Parameters<typeof createDailyLogCreateAction>[0]);
		return { action, notion };
	}

	it("1. writes page, then twin, then pointer, and returns the twin artifact_id", async () => {
		const calls: string[] = [];
		const ports = makeTwinPorts(calls);
		const { action } = makeAction(ports.twin, {}, calls);

		const out = await action.run({ ...baseArgs, write_twin: true }, { caller: "mcp", userId: "user-1" });

		expect(calls).toEqual(["page", "capture", "pointer"]);
		expect(ports.capture).toHaveBeenCalledTimes(1);
		expect(ports.capture.mock.calls[0][0]).toEqual({
			title: "Aug 21 Log",
			text: BODY,
			content_subtype: "daily_log",
			captured_at: "2026-08-21",
			surface: "dos",
			processing_metadata: { pillars: ["Product"] },
		});
		expect(ports.capture.mock.calls[0][1]).toBe("user-1");
		expect(ports.recordExternalLink).toHaveBeenCalledWith("twin-1", {
			kind: "daily_log",
			provider: "notion_work",
			external_id: "page-1",
			external_url: "https://www.notion.so/page-1",
		});
		expect(ports.mutateByIds).not.toHaveBeenCalled();
		expect((out as { twin_artifact_id?: string }).twin_artifact_id).toBe("twin-1");
		expect(out.text).toContain("  twin_artifact_id: twin-1");
		expect(out.text).not.toContain("twin: MISSING");
	});

	it("1b. captured_at is the `date` argument and pillars default to an empty array", async () => {
		const ports = makeTwinPorts();
		const { action } = makeAction(ports.twin);
		const { pillars: _pillars, ...noPillars } = baseArgs;

		await action.run({ ...noPillars, date: "2026-08-14", write_twin: true }, { caller: "mcp" });

		expect(ports.capture.mock.calls[0][0]).toMatchObject({
			captured_at: "2026-08-14",
			processing_metadata: { pillars: [] },
		});
	});

	it("2. capture rejects: success for the page, twin: MISSING, no pointer and no archive", async () => {
		const ports = makeTwinPorts();
		ports.capture.mockRejectedValue(new Error("storage down"));
		const { action } = makeAction(ports.twin);

		const out = await action.run({ ...baseArgs, write_twin: true }, { caller: "mcp" });

		expect(out.id).toBe("page-1");
		expect(out.text).toContain("twin: MISSING");
		expect(out.text).toContain("page-1");
		expect(out.text).toContain("storage down");
		expect((out as { twin_artifact_id?: string }).twin_artifact_id).toBeUndefined();
		expect(out.text).not.toContain("twin_artifact_id:");
		expect(ports.recordExternalLink).not.toHaveBeenCalled();
		expect(ports.mutateByIds).not.toHaveBeenCalled();
	});

	it("3. pointer rejects once then succeeds: two attempts, no archive, no warning", async () => {
		const ports = makeTwinPorts();
		ports.recordExternalLink.mockRejectedValueOnce(new Error("blip")).mockResolvedValue({ ok: true });
		const { action } = makeAction(ports.twin);

		const out = await action.run({ ...baseArgs, write_twin: true }, { caller: "mcp" });

		expect(ports.recordExternalLink).toHaveBeenCalledTimes(2);
		expect(ports.mutateByIds).not.toHaveBeenCalled();
		expect(out.text).not.toContain("twin: MISSING");
		expect((out as { twin_artifact_id?: string }).twin_artifact_id).toBe("twin-1");
	});

	it("3b. a pointer write that resolves ok: false counts as a failure and is retried", async () => {
		const ports = makeTwinPorts();
		ports.recordExternalLink
			.mockResolvedValueOnce({ ok: false, error: "rls" })
			.mockResolvedValue({ ok: true });
		const { action } = makeAction(ports.twin);

		const out = await action.run({ ...baseArgs, write_twin: true }, { caller: "mcp" });

		expect(ports.recordExternalLink).toHaveBeenCalledTimes(2);
		expect(out.text).not.toContain("twin: MISSING");
	});

	it("4. pointer rejects twice: two attempts, one soft archive of this call's twin, twin: MISSING", async () => {
		const ports = makeTwinPorts();
		ports.recordExternalLink.mockRejectedValue(new Error("links down"));
		const { action } = makeAction(ports.twin);

		const out = await action.run({ ...baseArgs, write_twin: true }, { caller: "mcp" });

		expect(out.id).toBe("page-1");
		expect(ports.recordExternalLink).toHaveBeenCalledTimes(2);
		expect(ports.mutateByIds).toHaveBeenCalledTimes(1);
		const [ids, archiveOnly] = ports.mutateByIds.mock.calls[0];
		expect(ids).toEqual(["twin-1"]);
		expect(archiveOnly).toBe(true);
		expect(out.text).toContain("twin: MISSING");
		expect(out.text).toContain("links down");
		expect(out.text).toContain("was archived (reversible)");
		expect((out as { twin_artifact_id?: string }).twin_artifact_id).toBeUndefined();
	});

	it("4b. never throws when the compensating archive fails too, and names the stranded twin", async () => {
		const ports = makeTwinPorts();
		ports.recordExternalLink.mockRejectedValue(new Error("links down"));
		ports.mutateByIds.mockRejectedValue(new Error("archive down"));
		const { action } = makeAction(ports.twin);

		const out = await action.run({ ...baseArgs, write_twin: true }, { caller: "mcp" });

		expect(out.id).toBe("page-1");
		expect(out.text).toContain("twin: MISSING");
		expect(out.text).toContain("twin-1");
		expect(out.text).toContain("archive down");
	});

	it("4c. an archive that matches no row is not reported as archived: the twin is named as live with no pointer", async () => {
		const ports = makeTwinPorts();
		ports.recordExternalLink.mockRejectedValue(new Error("links down"));
		ports.mutateByIds.mockResolvedValue([]);
		const { action } = makeAction(ports.twin);

		const out = await action.run({ ...baseArgs, write_twin: true }, { caller: "mcp" });

		expect(out.id).toBe("page-1");
		expect(ports.mutateByIds).toHaveBeenCalledTimes(1);
		expect(out.text).toContain("twin: MISSING");
		expect(out.text).toContain("twin twin-1 failed too (the archive matched no row)");
		expect(out.text).toContain("live with NO pointer");
		expect(out.text).toContain("external_link_create");
		expect(out.text).not.toContain("was archived (reversible)");
		expect((out as { twin_artifact_id?: string }).twin_artifact_id).toBeUndefined();
	});

	it("5. a deduplicated twin is never archived; the warning names the existing twin", async () => {
		const ports = makeTwinPorts();
		ports.capture.mockResolvedValue({ id: "twin-earlier", deduplicated: true });
		ports.recordExternalLink.mockRejectedValue(new Error("links down"));
		const { action } = makeAction(ports.twin);

		const out = await action.run({ ...baseArgs, write_twin: true }, { caller: "mcp" });

		expect(ports.recordExternalLink).toHaveBeenCalledTimes(2);
		expect(ports.mutateByIds).not.toHaveBeenCalled();
		expect(out.text).toContain("twin: MISSING");
		expect(out.text).toContain("twin-earlier");
	});

	it("6. allow_duplicate: true still writes the twin and pointer", async () => {
		const ports = makeTwinPorts();
		const { action } = makeAction(ports.twin);

		const out = await action.run(
			{ ...baseArgs, allow_duplicate: true, write_twin: true },
			{ caller: "mcp" },
		);

		expect(ports.capture).toHaveBeenCalledTimes(1);
		expect(ports.recordExternalLink).toHaveBeenCalledTimes(1);
		expect((out as { twin_artifact_id?: string }).twin_artifact_id).toBe("twin-1");
	});

	it.each([
		["with write_twin: true", { write_twin: true }],
		["without write_twin", {}],
	])("7. a page with no twin is still refused twin_present: false and nothing heals it (%s)", async (_label, extra) => {
		const ports = makeTwinPorts();
		const existing = {
			results: [
				{
					id: "existing-page-9",
					properties: { Covers: { type: "multi_select", multi_select: [{ name: "2026-08-21" }] } },
				},
			],
			has_more: false,
			next_cursor: null,
		};
		const notion = makeNotionPort({ queryDataSource: vi.fn().mockResolvedValue(existing) });
		const action = createDailyLogCreateAction({
			notion,
			config: makeConfigRepo(WORK_DOS_CONFIG),
			externalLinks: { hasDailyLogTwin: vi.fn().mockResolvedValue(false) },
			twin: ports.twin,
		} as Parameters<typeof createDailyLogCreateAction>[0]);

		const err = await action.run({ ...baseArgs, ...extra }, { caller: "mcp" }).catch((e) => e);

		expect(err).toBeInstanceOf(DailyLogDuplicateRefusalError);
		expect(err.twin_present).toBe(false);
		expect(err.message).toContain("twin_present: false");
		expect(notion.createPage).not.toHaveBeenCalled();
		expect(ports.capture).not.toHaveBeenCalled();
		expect(ports.recordExternalLink).not.toHaveBeenCalled();
		expect(ports.mutateByIds).not.toHaveBeenCalled();
	});

	it("8. write ports absent with write_twin: true: page written, twin: MISSING", async () => {
		const { action, notion } = makeAction(undefined);

		const out = await action.run({ ...baseArgs, write_twin: true }, { caller: "mcp" });

		expect(notion.createPage).toHaveBeenCalledTimes(1);
		expect(out.id).toBe("page-1");
		expect(out.text).toContain("twin: MISSING");
		expect(out.text).toContain("page-1");
	});

	it("8b. an entry with no body: page written, twin: MISSING, capture never called with empty text", async () => {
		const ports = makeTwinPorts();
		const { action } = makeAction(ports.twin);
		const { body: _body, ...noBody } = baseArgs;

		const out = await action.run({ ...noBody, write_twin: true }, { caller: "mcp" });

		expect(out.id).toBe("page-1");
		expect(out.text).toContain("twin: MISSING");
		expect(ports.capture).not.toHaveBeenCalled();
		expect(ports.recordExternalLink).not.toHaveBeenCalled();
	});

	it("9. body overflow failure and twin success are both reported", async () => {
		const ports = makeTwinPorts();
		const { action } = makeAction(ports.twin, {
			appendBlockChildren: vi.fn().mockRejectedValue(new Error("append failed")),
		});
		const body = Array.from({ length: 105 }, (_, i) => `Line ${i + 1}`).join("\n");

		const out = await action.run({ ...baseArgs, body, write_twin: true }, { caller: "mcp" });

		expect(out.text).toContain("WARNING: the entry was created but its body is incomplete");
		expect(out.text).toContain("  twin_artifact_id: twin-1");
		expect((out as { twin_artifact_id?: string }).twin_artifact_id).toBe("twin-1");
		expect(ports.capture.mock.calls[0][0].text).toBe(body);
	});

	// The exact reply `dev` gave for this input before #2258. Old skill copies still call
	// the tool this way, so it is pinned byte for byte.
	const UNCHANGED_TEXT = [
		"Daily Log entry created (work): Aug 21 Log",
		"  page_id: page-1",
		"  page_url: https://www.notion.so/page-1",
		"  provider: notion_work",
		"  blocks written: 2",
		"  covers: 2026-08-21",
		"  pillars: Product",
		"Consumption markers, dos ritual only: stamp each narrative atom this entry synthesised with external_link_create, provider 'notion_work', kind 'synthesized' (attended, requires ritual run_id) or 'synthesized_unattended' (#561 sweep only), external_id page-1, and when dos_evidence_aggregate had material_total > 0 stamp one twin-level link on the Daily Log twin artifact_id with kind 'evidence_aggregated' (attended, requires ritual run_id) or 'evidence_aggregated_unattended' (#561 sweep only). One marker closes the whole day for the sweep, so any other caller must stamp none.",
	].join("\n");
	const UNCHANGED_OUTPUT = {
		id: "page-1",
		url: "https://www.notion.so/page-1",
		domain: "work",
		provider: "notion_work",
		title: "Aug 21 Log",
		date: "2026-08-21",
		covers: ["2026-08-21"],
		pillars: ["Product"],
		blocksWritten: 2,
		text: UNCHANGED_TEXT,
	};

	it.each([
		["10. argument absent", {}],
		["11. write_twin: false", { write_twin: false }],
	])("%s: no capture, pointer or archive, and the output is what dev returns today", async (_label, extra) => {
		const ports = makeTwinPorts();
		const { action } = makeAction(ports.twin);

		const out = await action.run({ ...baseArgs, ...extra }, { caller: "mcp" });

		expect(out).toEqual(UNCHANGED_OUTPUT);
		expect(ports.capture).not.toHaveBeenCalled();
		expect(ports.recordExternalLink).not.toHaveBeenCalled();
		expect(ports.mutateByIds).not.toHaveBeenCalled();
	});

	it.each([
		["10. argument absent", {}],
		["11. write_twin: false", { write_twin: false }],
	])("%s, write ports absent: same output, no twin: MISSING warning", async (_label, extra) => {
		const { action } = makeAction(undefined);

		const out = await action.run({ ...baseArgs, ...extra }, { caller: "mcp" });

		expect(out).toEqual(UNCHANGED_OUTPUT);
		expect(out.text).not.toContain("twin:");
	});

	it("12. the input schema declares write_twin as an optional boolean defaulting to false", async () => {
		const { dailyLogCreateSchema } = await import("./dailyLogCreate.js");
		const shape = dailyLogCreateSchema.shape as Record<string, { safeParse(v: unknown): { success: boolean } }>;

		expect(shape.write_twin).toBeDefined();
		expect(dailyLogCreateSchema.parse({})).toMatchObject({ write_twin: false });
		expect(dailyLogCreateSchema.parse({ write_twin: true })).toMatchObject({ write_twin: true });
		expect(shape.write_twin.safeParse("yes").success).toBe(false);
	});
});
