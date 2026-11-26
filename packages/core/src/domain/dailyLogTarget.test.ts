import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupabaseConfigRepository, type ConfigSupabaseClient } from "../adapters/supabase/config.js";
import {
	COVERS_ROLE,
	COVERS_TYPES,
	coversGuardFilter,
	coversType,
	coversValue,
	effectiveCovers,
	normalizeCovers,
} from "./dailyLogCovers.js";
import {
	createDailyLogTargetResolver,
	DailyLogUnwiredError,
	dailyLogTargetIds,
	getDailyLogTargetIds,
	isDailyLogUnwired,
	isNotionNotFound,
	peekDailyLogTarget,
	reachabilityError,
	resolveDailyLogPortTarget,
	resolveDailyLogTarget,
} from "./dailyLogTarget.js";
import { notionConfigSchema } from "./integrations.js";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const WORK_DB = "hl-daily-log-db";
const WORK_DS = "hl-daily-log-ds";
const ANGUS_DB = "angus-daily-log-db";
const ANGUS_DS = "angus-daily-log-ds";

function createStubbedConfigRepo(result: { data: unknown; error: unknown }) {
	const client: ConfigSupabaseClient = {
		from: vi.fn(() => ({
			select: vi.fn(() => ({
				eq: vi.fn(() => ({
					eq: vi.fn(() => ({
						maybeSingle: vi.fn().mockResolvedValue(result),
					})),
				})),
			})),
		})),
	} as unknown as ConfigSupabaseClient;

	return createSupabaseConfigRepository({
		client,
		ownerId: "owner-1",
	});
}

describe("loadIntegrationConfigDetailed and loadIntegrationConfig (#710)", () => {
	it("returns ok when row is present, enabled, and valid", async () => {
		const repo = createStubbedConfigRepo({
			data: {
				config: {
					tasks_database_id: "tasks-123",
					daily_log_database_id: WORK_DB,
					daily_log_data_source_id: WORK_DS,
				},
				enabled: true,
			},
			error: null,
		});

		const detailed = await repo.loadConfigDetailed("notion_work", notionConfigSchema);
		expect(detailed.status).toBe("ok");
		if (detailed.status === "ok") {
			expect(detailed.data.daily_log_database_id).toBe(WORK_DB);
		}

		const standard = await repo.loadConfig("notion_work", notionConfigSchema);
		expect(standard?.daily_log_database_id).toBe(WORK_DB);
	});

	it("returns unwired when no row exists", async () => {
		const repo = createStubbedConfigRepo({ data: null, error: null });

		const detailed = await repo.loadConfigDetailed("notion_work", notionConfigSchema);
		expect(detailed.status).toBe("unwired");

		const standard = await repo.loadConfig("notion_work", notionConfigSchema);
		expect(standard).toBeNull();
	});

	it("returns unwired when row is disabled", async () => {
		const repo = createStubbedConfigRepo({
			data: {
				config: { tasks_database_id: "tasks-123" },
				enabled: false,
			},
			error: null,
		});

		const detailed = await repo.loadConfigDetailed("notion_work", notionConfigSchema);
		expect(detailed.status).toBe("unwired");

		const standard = await repo.loadConfig("notion_work", notionConfigSchema);
		expect(standard).toBeNull();
	});

	it("returns error when Supabase read encounters a DB error", async () => {
		const dbError = new Error("connection timeout");
		const repo = createStubbedConfigRepo({ data: null, error: dbError });

		const detailed = await repo.loadConfigDetailed("notion_work", notionConfigSchema);
		expect(detailed.status).toBe("error");
		if (detailed.status === "error") {
			expect(detailed.error).toBe(dbError);
		}

		// Backward-compatible loadConfig still swallows into null
		const standard = await repo.loadConfig("notion_work", notionConfigSchema);
		expect(standard).toBeNull();
	});
});

describe("resolveDailyLogTarget (#710, #1487)", () => {
	it("resolves target when domain is properly configured and takes token from injected resolver", async () => {
		const repo = createStubbedConfigRepo({
			data: {
				config: {
					tasks_database_id: "tasks-123",
					daily_log_database_id: WORK_DB,
					daily_log_data_source_id: WORK_DS,
				},
				enabled: true,
			},
			error: null,
		});
		const resolveToken = vi.fn().mockResolvedValue("injected-work-token");

		const target = await resolveDailyLogTarget("work", {
			config: repo,
			resolveToken,
		});
		expect(target.databaseId).toBe(WORK_DB);
		expect(target.dataSourceId).toBe(WORK_DS);
		expect(target.provider).toBe("notion_work");
		expect(target.token).toBe("injected-work-token");
		expect(resolveToken).toHaveBeenCalledWith("work", "notion_work");
	});

	it("accepts a NotionPort-compatible object with resolveToken(workspace)", async () => {
		const repo = createStubbedConfigRepo({
			data: {
				config: {
					tasks_database_id: "tasks-personal",
					daily_log_database_id: ANGUS_DB,
					daily_log_data_source_id: ANGUS_DS,
				},
				enabled: true,
			},
			error: null,
		});
		const notionPort = {
			resolveToken: vi.fn().mockResolvedValue("notion-port-angus-token"),
		};

		const target = await resolveDailyLogTarget("angus", {
			config: repo,
			notion: notionPort,
		});
		expect(target).toEqual({
			databaseId: ANGUS_DB,
			dataSourceId: ANGUS_DS,
			provider: "notion_personal",
			token: "notion-port-angus-token",
		});
		expect(notionPort.resolveToken).toHaveBeenCalledWith("angus");
	});

	it("throws DailyLogUnwiredError with default attempted sentence when unwired", async () => {
		const repo = createStubbedConfigRepo({ data: null, error: null });
		const deps = { config: repo, resolveToken: () => "tok" };

		await expect(resolveDailyLogTarget("work", deps)).rejects.toThrow(
			/that Daily Log is unwired, so nothing was written./,
		);
		try {
			await resolveDailyLogTarget("work", deps);
		} catch (err) {
			expect(isDailyLogUnwired(err)).toBe(true);
			expect(err).toBeInstanceOf(DailyLogUnwiredError);
		}
	});

	it("throws DailyLogUnwiredError with custom attempted sentence when passed", async () => {
		const repo = createStubbedConfigRepo({
			data: {
				config: { tasks_database_id: "tasks-123" }, // missing daily_log_database_id
				enabled: true,
			},
			error: null,
		});
		const deps = { config: repo, resolveToken: () => "tok" };

		await expect(
			resolveDailyLogTarget("work", "so nothing was read.", deps),
		).rejects.toThrow(/that Daily Log is unwired, so nothing was read./);
	});

	it("throws DB read error (NOT unwired error) when Supabase fails transiently", async () => {
		const dbError = new Error("Supabase internal error (500)");
		const repo = createStubbedConfigRepo({ data: null, error: dbError });
		const deps = { config: repo, resolveToken: () => "tok" };

		await expect(resolveDailyLogTarget("work", deps)).rejects.toThrow(
			/Failed to read integration config for provider 'notion_work': Supabase internal error \(500\)/,
		);

		try {
			await resolveDailyLogTarget("work", deps);
		} catch (err) {
			expect(isDailyLogUnwired(err)).toBe(false);
			expect(err).not.toBeInstanceOf(DailyLogUnwiredError);
		}
	});
});

describe("peekDailyLogTarget and NotionPort target compositions (#710, #1572, #1576, #1487)", () => {
	it("returns pointer when configured", async () => {
		const repo = createStubbedConfigRepo({
			data: {
				config: {
					tasks_database_id: "tasks-123",
					daily_log_database_id: WORK_DB,
					daily_log_data_source_id: WORK_DS,
				},
				enabled: true,
			},
			error: null,
		});

		const pointer = await peekDailyLogTarget("work", repo);
		expect(pointer).toEqual({
			databaseId: WORK_DB,
			dataSourceId: WORK_DS,
		});
	});

	it("returns null when not configured", async () => {
		const repo = createStubbedConfigRepo({ data: null, error: null });
		expect(await peekDailyLogTarget("work", repo)).toBeNull();
	});

	it("returns null when Supabase read fails", async () => {
		const repo = createStubbedConfigRepo({ data: null, error: new Error("DB error") });
		expect(await peekDailyLogTarget("work", repo)).toBeNull();
	});

	it("shares the resolver across getDailyLogTargetIds (#1572), resolveDailyLogPortTarget (#1576), and createDailyLogTargetResolver", async () => {
		const repo = createStubbedConfigRepo({
			data: {
				config: {
					tasks_database_id: "tasks-123",
					daily_log_database_id: WORK_DB,
					daily_log_data_source_id: WORK_DS,
				},
				enabled: true,
			},
			error: null,
		});
		const resolveToken = vi.fn().mockResolvedValue("shared-token");

		expect(await dailyLogTargetIds("work", repo)).toEqual([WORK_DB, WORK_DS]);
		expect(await getDailyLogTargetIds("work", repo)).toEqual([WORK_DB, WORK_DS]);

		const portTarget = await resolveDailyLogPortTarget("work", repo);
		expect(portTarget).toEqual({
			databaseId: WORK_DB,
			dataSourceId: WORK_DS,
			workspace: "work",
			provider: "notion_work",
		});

		const bound = createDailyLogTargetResolver({ config: repo, resolveToken });
		expect(await bound.peekDailyLogTarget("work")).toEqual({
			databaseId: WORK_DB,
			dataSourceId: WORK_DS,
		});
		expect(await bound.getDailyLogTargetIds("work")).toEqual([WORK_DB, WORK_DS]);
		expect(await bound.resolveDailyLogPortTarget("work")).toEqual({
			databaseId: WORK_DB,
			dataSourceId: WORK_DS,
			workspace: "work",
		});
		expect(await bound.resolveDailyLogTarget("work")).toEqual({
			databaseId: WORK_DB,
			dataSourceId: WORK_DS,
			provider: "notion_work",
			token: "shared-token",
		});
	});
});

describe("isNotionNotFound and reachabilityError (#1569, #1487)", () => {
	it("branches on err.status === 404 when status is present on the error", () => {
		const err404 = Object.assign(new Error("Notion API error"), { status: 404 });
		const err500 = Object.assign(new Error("Notion API error (404) in body"), { status: 500 });
		const legacy404 = new Error("Notion API error (404): Could not find database");

		expect(isNotionNotFound(err404)).toBe(true);
		expect(isNotionNotFound(err500)).toBe(false);
		expect(isNotionNotFound(legacy404)).toBe(true);
	});

	it("formats reachabilityError with Notion sharing instructions on 404 and passes through other errors", () => {
		const err404 = Object.assign(new Error("object_not_found"), { status: 404 });
		const formatted = reachabilityError("work", WORK_DB, err404, "Nothing was checked.");
		expect(formatted.message).toContain(
			`The Daily Log for domain 'work' IS configured — pointer ${WORK_DB} — but the ahKMS Notion integration cannot see it (Notion returned 404). Nothing was checked.`,
		);
		expect(formatted.message).toContain("Connections → ahKMS");

		const err502 = Object.assign(new Error("Bad gateway"), { status: 502 });
		expect(reachabilityError("work", WORK_DB, err502)).toBe(err502);
	});
});

describe("dailyLogCovers (#1016, #1487)", () => {
	it("exports COVERS_ROLE and COVERS_TYPES", () => {
		expect(COVERS_ROLE).toBe("covers");
		expect(COVERS_TYPES).toEqual(["rich_text", "multi_select"]);
	});

	it("normalizes, deduplicates, and sorts covered dates or defaults to [date]", () => {
		expect(normalizeCovers(undefined, "2026-04-10")).toEqual(["2026-04-10"]);
		expect(normalizeCovers([], "2026-04-10")).toEqual(["2026-04-10"]);
		expect(normalizeCovers(["2026-04-10", "2026-04-08", "2026-04-10"], "2026-04-10")).toEqual([
			"2026-04-08",
			"2026-04-10",
		]);
		expect(() => normalizeCovers(["04/10/2026"], "2026-04-10")).toThrow(
			/`covers` must hold YYYY-MM-DD dates/,
		);
	});

	it("resolves coversType and builds coversValue and coversGuardFilter", () => {
		const schema = {
			properties: [
				{ name: "Covers", type: "multi_select" },
				{ name: "Notes", type: "rich_text" },
				{ name: "Title", type: "title" },
			],
		};
		expect(coversType(schema, "Covers")).toBe("multi_select");
		expect(coversType(schema, "Notes")).toBe("rich_text");
		expect(coversType(schema, "Title")).toBeNull();
		expect(coversType(schema, "Missing")).toBeNull();

		expect(coversValue("multi_select", ["2026-04-08", "2026-04-09"])).toEqual({
			multi_select: [{ name: "2026-04-08" }, { name: "2026-04-09" }],
		});
		expect(coversValue("rich_text", ["2026-04-08", "2026-04-09"])).toEqual({
			rich_text: [{ text: { content: "2026-04-08, 2026-04-09" } }],
		});

		expect(coversGuardFilter("Covers", "multi_select", "Date", ["2026-04-08"])).toEqual({
			or: [
				{ property: "Covers", multi_select: { contains: "2026-04-08" } },
				{ property: "Date", date: { equals: "2026-04-08" } },
			],
		});
	});

	it("computes effectiveCovers from multi_select, rich_text, or fallback Date property", () => {
		expect(
			effectiveCovers(
				{
					properties: {
						Covers: { multi_select: [{ name: "2026-04-07" }, { name: "2026-04-08" }] },
						Date: { date: { start: "2026-04-09" } },
					},
				},
				"Covers",
				"Date",
			),
		).toEqual(["2026-04-07", "2026-04-08"]);

		expect(
			effectiveCovers(
				{
					properties: {
						Covers: { rich_text: [{ plain_text: "2026-04-05, 2026-04-06" }] },
						Date: { date: { start: "2026-04-09" } },
					},
				},
				"Covers",
				"Date",
			),
		).toEqual(["2026-04-05", "2026-04-06"]);

		expect(
			effectiveCovers(
				{
					properties: {
						Covers: { rich_text: [] },
						Date: { date: { start: "2026-04-09T12:00:00.000Z" } },
					},
				},
				"Covers",
				"Date",
			),
		).toEqual(["2026-04-09"]);
	});
});
