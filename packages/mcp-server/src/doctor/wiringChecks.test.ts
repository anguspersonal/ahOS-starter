import { beforeEach, describe, expect, it, vi } from "vitest";

// The three reads are stubbed at their module boundary; the classification is real.
vi.mock("../integrations.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../integrations.js")>();
	return { ...actual, listIntegrations: vi.fn(), loadIntegrationConfigDetailed: vi.fn() };
});
vi.mock("../captureConfig.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../captureConfig.js")>();
	return {
		...actual,
		loadCapturePreferences: vi.fn(),
		// Real by default; one test below empties it to reach the warn branch, which the
		// shipped floor otherwise makes unreachable (#1767).
		effectiveSurfaceRoleMap: vi.fn(actual.effectiveSurfaceRoleMap),
	};
});
vi.mock("@ahkms/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ahkms/core")>();
	return { ...actual, reconcileDomainAgainstNotion: vi.fn(), loadDosConfigDetailed: vi.fn() };
});
vi.mock("../links.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../links.js")>();
	return { ...actual, getSynthesisCoverage: vi.fn() };
});
vi.mock("./ledgerChecks.js", () => ({ ledgerChecks: vi.fn(async () => []) }));
vi.mock("./approvalChecks.js", () => ({ approvalChecks: vi.fn(async () => []) }));

// A fake `scheduler_runs` that behaves like the capped API (#2320): `schedulerRuns.data`
// is the whole table in the order the API would return it, and a read hands back at most
// `API_MAX_ROWS` of the rows that pass its filters (`supabase/config.toml` `max_rows`).
// `vi.hoisted` because the `vi.mock` factory below is hoisted above ordinary declarations.
const schedulerRuns = vi.hoisted(() => ({
	API_MAX_ROWS: 1000,
	data: [] as Array<{ cadence: string }>,
	error: null as Error | null,
	// Per-cadence failures: a filtered read for a key here returns that error.
	errorByCadence: {} as Record<string, Error>,
	// Every read issued, so a test can assert on its shape.
	reads: [] as Array<{ cadence: string | null; limit: number | null }>,
}));

vi.mock("../supabase.js", () => {
	const select = vi.fn(() => {
		const read = { cadence: null as string | null, limit: null as number | null };
		const builder = {
			eq: (column: string, value: string) => {
				if (column === "cadence") read.cadence = value;
				return builder;
			},
			limit: (n: number) => {
				read.limit = n;
				return builder;
			},
			then: (resolve: (val: any) => any) => {
				schedulerRuns.reads.push({ ...read });
				const error = schedulerRuns.error ?? (read.cadence ? schedulerRuns.errorByCadence[read.cadence] : null) ?? null;
				if (error) return resolve({ data: null, error });
				const matching = schedulerRuns.data.filter((r) => read.cadence === null || r.cadence === read.cadence);
				const cap = Math.min(read.limit ?? schedulerRuns.API_MAX_ROWS, schedulerRuns.API_MAX_ROWS);
				return resolve({ data: matching.slice(0, cap), error: null });
			},
		};
		return builder;
	});
	return {
		supabase: {
			from: vi.fn(() => ({ select })),
		},
	};
});

import {
	DEFAULT_CAPTURE_PREFERENCES,
	capturePreferencesSchema,
	effectiveSurfaceRoleMap,
	loadCapturePreferences,
} from "../captureConfig.js";
import { listIntegrations, loadIntegrationConfigDetailed, type IntegrationSummary } from "../integrations.js";
import { DEFAULT_DOS_CONFIG, loadDosConfigDetailed, reconcileDomainAgainstNotion } from "@ahkms/core";
import { getSynthesisCoverage } from "../links.js";
import type { DoctorCheck } from "./report.js";
import {
	checkWiring,
	rpcWiringChecks,
	driveWatchWiringChecks,
	schedulerCadenceChecks,
	DEFINED_SCHEDULER_CADENCES,
	REQUIRED_SERVER_RPCS,
} from "./wiringChecks.js";

const WORK_DOS_KEYS = [
	"tasks_database_id",
	"state_doc_page_id",
	"tasks_source_data_source_id",
	"meetings_source_data_source_id",
	"investor_crm_data_source_id",
	"notion_user_id",
];

const row = (provider: string, keys: string[], over: Partial<IntegrationSummary> = {}): IntegrationSummary => ({
	provider,
	enabled: true,
	routing: "native",
	status: "connected",
	config_keys: keys,
	...over,
});

const OK_TASKS = { status: "not_configured", provider: "notion_work" } as const;
const cleanReport = {
	vocabularies: [
		{ vocabulary: "topics", property: "Other domains", status: "ok", configured: ["Ops"], missing: [], unused: [] },
	],
};

const find = (checks: DoctorCheck[], name: string) => checks.find((c) => c.name === name);

beforeEach(() => {
	vi.mocked(listIntegrations).mockResolvedValue([
		row("notion_work", WORK_DOS_KEYS),
		row("notion_personal", ["tasks_database_id", "state_doc_page_id"]),
		row("github", ["issue_repos", "default_repo"]),
		row("slack", ["owner_user_id"]),
	]);
	vi.mocked(loadCapturePreferences).mockResolvedValue(
		capturePreferencesSchema.parse({
			surface_role_map: { github: "evidence", slack: "evidence", slack_dm: "excluded", derived: "evidence" },
		}),
	);
	vi.mocked(reconcileDomainAgainstNotion).mockResolvedValue({
		kind: "checked",
		databaseId: "db",
		report: cleanReport as never,
		tasks: OK_TASKS,
	});
	vi.mocked(loadDosConfigDetailed).mockResolvedValue({ config: DEFAULT_DOS_CONFIG, status: "absent", issues: [] });
	vi.mocked(getSynthesisCoverage).mockResolvedValue([]);
	const paths: Record<string, unknown> = {};
	for (const rpc of REQUIRED_SERVER_RPCS) {
		paths[`/rpc/${rpc}`] = {};
	}
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
		if (String(url).includes("/rest/v1/")) {
			return {
				ok: true,
				json: async () => ({ paths }),
			} as unknown as Response;
		}
		return { ok: false, status: 404 } as Response;
	});
	schedulerRuns.data = DEFINED_SCHEDULER_CADENCES.map((c) => ({ cadence: c }));
	schedulerRuns.error = null;
	schedulerRuns.errorByCadence = {};
	schedulerRuns.reads = [];
});

describe("wiring: integration rows and dos pointers", () => {
	it("is all ok on a fully wired store", async () => {
		const checks = await checkWiring();
		expect(checks.filter((c) => c.status !== "ok")).toEqual([]);
	});

	it("fails a missing notion integration row and names the call that wires it", async () => {
		vi.mocked(listIntegrations).mockResolvedValue([row("notion_work", WORK_DOS_KEYS)]);
		const c = find(await checkWiring(), "integration notion_personal");
		expect(c?.status).toBe("fail");
		expect(c?.fix).toContain("integration_set");
	});

	it("fails a domain whose dos pointers are unset, naming each missing key", async () => {
		vi.mocked(listIntegrations).mockResolvedValue([
			row("notion_work", ["tasks_database_id", "state_doc_page_id"]),
			row("notion_personal", ["tasks_database_id", "state_doc_page_id"]),
		]);
		const c = find(await checkWiring(), "dos pointers work");
		expect(c?.status).toBe("fail");
		expect(c?.detail).toContain("investor_crm_data_source_id");
		expect(c?.detail).toContain("notion_user_id");
	});

	it("flags a key stored on the wrong provider — invisible to every reader (the #1024 tasks_data_source_id case)", async () => {
		vi.mocked(listIntegrations).mockResolvedValue([
			row("notion_work", [...WORK_DOS_KEYS, "tasks_data_source_id"]),
			row("notion_personal", ["tasks_database_id", "state_doc_page_id"]),
		]);
		const c = find(await checkWiring(), "config keys notion_work");
		expect(c?.status).toBe("warn");
		expect(c?.detail).toContain("tasks_data_source_id");
		expect(c?.detail).toContain("notion_personal");
	});

	it("warns a disabled or disconnected row", async () => {
		vi.mocked(listIntegrations).mockResolvedValue([
			row("notion_work", WORK_DOS_KEYS),
			row("notion_personal", ["tasks_database_id", "state_doc_page_id"]),
			row("dex", [], { status: "error" }),
		]);
		expect(find(await checkWiring(), "integration dex")?.status).toBe("warn");
	});

	it("warns when github integration row is missing", async () => {
		vi.mocked(listIntegrations).mockResolvedValue([
			row("notion_work", WORK_DOS_KEYS),
			row("notion_personal", ["tasks_database_id", "state_doc_page_id"]),
		]);
		const c = find(await checkWiring(), "integration github");
		expect(c?.status).toBe("warn");
		expect(c?.detail).toContain("no user_integrations row");
		expect(c?.fix).toContain("integration_set");
	});

	it("warns when github integration row is missing issue_repos", async () => {
		vi.mocked(listIntegrations).mockResolvedValue([
			row("notion_work", WORK_DOS_KEYS),
			row("notion_personal", ["tasks_database_id", "state_doc_page_id"]),
			row("github", ["default_repo"]),
		]);
		const c = find(await checkWiring(), "integration github");
		expect(c?.status).toBe("warn");
		expect(c?.detail).toContain("no issue_repos configured");
		expect(c?.fix).toContain("integration_set");
	});

	it("warns on stray config keys for github", async () => {
		vi.mocked(listIntegrations).mockResolvedValue([
			row("notion_work", WORK_DOS_KEYS),
			row("notion_personal", ["tasks_database_id", "state_doc_page_id"]),
			row("github", ["issue_repos", "default_repo", "unknown_key"]),
		]);
		const c = find(await checkWiring(), "config keys github");
		expect(c?.status).toBe("warn");
		expect(c?.detail).toContain("unknown_key");
	});

	it("warns when slack owner_user_id is not configured for approval cards (#1534)", async () => {
		vi.mocked(listIntegrations).mockResolvedValue([
			row("notion_work", WORK_DOS_KEYS),
			row("notion_personal", ["tasks_database_id", "state_doc_page_id"]),
			row("github", ["issue_repos", "default_repo"]),
		]);
		const c = find(await checkWiring(), "approval cards");
		expect(c?.status).toBe("warn");
		expect(c?.detail).toBe("approval cards off: no slack owner_user_id");
		expect(c?.fix).toContain("owner_user_id");
	});
});

describe("wiring: surface_role_map covers every bulk-writing surface", () => {
	it("is ok on an owner row with an empty stored map, because the shipped floor carries act_receipt, github, slack, slack_dm, derived, gmail_ingest (#1767, #1771)", async () => {
		vi.mocked(loadCapturePreferences).mockResolvedValue(DEFAULT_CAPTURE_PREFERENCES);
		const checks = await checkWiring();
		expect(find(checks, "surface_role_map")?.status).toBe("ok");
		expect(checks.filter((c) => c.name.startsWith("surface_role_map "))).toEqual([]);
	});

	it("still warns a bulk surface that falls through to default_role when the floor does not carry it (#567)", async () => {
		vi.mocked(loadCapturePreferences).mockResolvedValue(DEFAULT_CAPTURE_PREFERENCES);
		vi.mocked(effectiveSurfaceRoleMap).mockReturnValueOnce({});
		const c = find(await checkWiring(), "surface_role_map github");
		expect(c?.status).toBe("warn");
		expect(c?.detail).toContain("narrative");
		expect(c?.fix).toContain("MACHINE_INGEST_SURFACES");
	});

	it("is ok for the Drive discover surfaces, which the shipped seed already floors", async () => {
		vi.mocked(loadCapturePreferences).mockResolvedValue(DEFAULT_CAPTURE_PREFERENCES);
		const checks = await checkWiring();
		expect(checks.filter((c) => c.name.startsWith("surface_role_map discovered_"))).toEqual([]);
	});
});

describe("wiring: Notion carries the options config claims (dos_config_drift reused)", () => {
	it("fails a domain with quarantined values, naming them", async () => {
		vi.mocked(reconcileDomainAgainstNotion).mockResolvedValue({
			kind: "checked",
			databaseId: "db",
			report: {
				vocabularies: [
					{ vocabulary: "topics", property: "Other domains", status: "drift", configured: ["Ops", "Round"], missing: ["Round"], unused: [] },
				],
			} as never,
			tasks: OK_TASKS,
		});
		const c = find(await checkWiring(), "notion options work");
		expect(c?.status).toBe("fail");
		expect(c?.detail).toContain("Round");
	});

	it("warns a property with no options — Notion silently creates whatever is written (#695)", async () => {
		vi.mocked(reconcileDomainAgainstNotion).mockResolvedValue({
			kind: "checked",
			databaseId: "db",
			report: {
				vocabularies: [
					{ vocabulary: "topics", property: "Topics", status: "no_options", configured: ["Health"], missing: [], unused: [] },
				],
			} as never,
			tasks: OK_TASKS,
		});
		const c = find(await checkWiring(), "notion options angus");
		expect(c?.status).toBe("warn");
		expect(c?.detail).toContain("topics");
	});

	it("fails a domain with schema property defects (issue #1728)", async () => {
		vi.mocked(reconcileDomainAgainstNotion).mockResolvedValue({
			kind: "checked",
			databaseId: "db",
			report: {
				vocabularies: [],
				properties: [
					{
						name: "Type",
						required: true,
						status: "missing_options",
						expectedType: "select",
						detail: "property 'Type' is missing required option(s): Daily. Available: Catch-up.",
						remediation: "Add option(s) 'Daily' to the 'Type' property in Notion (angus workspace).",
					},
				],
			} as never,
			tasks: OK_TASKS,
		});
		const c = find(await checkWiring(), "notion options angus");
		expect(c?.status).toBe("fail");
		expect(c?.detail).toContain("schema property defects:");
		expect(c?.detail).toContain("Daily");
		expect(c?.fix).toContain("Add option(s) 'Daily' to the 'Type' property in Notion (angus workspace).");
	});

	it("fails an unconfigured dos domain", async () => {
		vi.mocked(reconcileDomainAgainstNotion).mockResolvedValue({ kind: "unconfigured", domainsPresent: ["work"] });
		const c = find(await checkWiring(), "notion options angus");
		expect(c?.status).toBe("fail");
		expect(c?.fix).toContain("by_domain.angus");
	});

	it("reports a stored but unparseable dos config as such, with issue paths, not as a missing block (#2256)", async () => {
		vi.mocked(reconcileDomainAgainstNotion).mockResolvedValue({ kind: "unconfigured", domainsPresent: [] });
		vi.mocked(loadDosConfigDetailed).mockResolvedValue({
			config: DEFAULT_DOS_CONFIG,
			status: "unparseable",
			issues: ["by_domain.work.topics: Invalid input: expected array, received string"],
		});

		const c = find(await checkWiring(), "notion options work");

		expect(c?.status).toBe("fail");
		expect(c?.detail).toContain("stored but unparseable");
		expect(c?.detail).toContain("by_domain.work.topics");
		expect(c?.detail).not.toContain("no dos config block");
		expect(c?.fix).not.toContain("add a by_domain.work block");
	});

	it("keeps the missing-block report when the parse diagnostic itself cannot be read", async () => {
		vi.mocked(reconcileDomainAgainstNotion).mockResolvedValue({ kind: "unconfigured", domainsPresent: ["work"] });
		vi.mocked(loadDosConfigDetailed).mockRejectedValue(new Error("db down"));

		const c = find(await checkWiring(), "notion options angus");

		expect(c?.status).toBe("fail");
		expect(c?.detail).toContain("no dos config block for 'angus'");
	});

	it("fails, rather than throws, when the Daily Log is unreachable or unwired", async () => {
		vi.mocked(reconcileDomainAgainstNotion).mockRejectedValue(new Error("Daily Log 404: share it with the integration"));
		const c = find(await checkWiring(), "notion options work");
		expect(c?.status).toBe("fail");
		expect(c?.detail).toContain("404");
	});

	it("fails an empty tasks property_map on a configured integration (#1001)", async () => {
		vi.mocked(reconcileDomainAgainstNotion).mockResolvedValue({
			kind: "checked",
			databaseId: "db",
			report: cleanReport as never,
			tasks: { status: "empty_map", provider: "notion_personal", databaseId: "t" },
		});
		expect(find(await checkWiring(), "tasks property_map angus")?.status).toBe("fail");
	});
});

describe("wiring: dos sweep outcome moved to the outcomes family (#2268)", () => {
	it("no longer reports a dos sweep check from wiring", async () => {
		const checks = await checkWiring();

		expect(checks.filter((c) => c.name.startsWith("dos sweep"))).toEqual([]);
		expect(getSynthesisCoverage).not.toHaveBeenCalled();
	});
});

describe("wiring: database rpc schema", () => {
	it("requires get_dos_coverage_days, so a pending migration 158 push is reported (#2264)", async () => {
		expect(REQUIRED_SERVER_RPCS).toContain("get_dos_coverage_days");

		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			const paths: Record<string, unknown> = {};
			for (const rpc of REQUIRED_SERVER_RPCS) {
				if (rpc !== "get_dos_coverage_days") paths[`/rpc/${rpc}`] = {};
			}
			return { ok: true, json: async () => ({ paths }) } as unknown as Response;
		});

		const checks = await rpcWiringChecks();
		expect(checks.map((c) => [c.name, c.status])).toEqual([
			["database rpc get_dos_coverage_days", "fail"],
		]);
	});

	it("is ok when all required RPCs exist in PostgREST schema cache", async () => {
		const checks = await rpcWiringChecks();
		expect(checks).toEqual([
			{
				family: "wiring",
				name: "database rpc schema",
				status: "ok",
				detail: `all ${REQUIRED_SERVER_RPCS.length} required server RPCs exist in live PostgREST schema cache.`,
				fix: "",
			},
		]);
	});

	it("fails and names missing RPCs when schema cache lacks them (issue #1367)", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			return {
				ok: true,
				json: async () => ({
					paths: {
						"/rpc/document_duplicate_clusters": {},
						"/rpc/fts_search_artifacts": {},
					},
				}),
			} as unknown as Response;
		});

		const checks = await rpcWiringChecks();
		const failed = checks.filter((c) => c.status === "fail");
		expect(failed.length).toBeGreaterThan(0);
		expect(find(checks, "database rpc merge_entities")).toEqual({
			family: "wiring",
			name: "database rpc merge_entities",
			status: "fail",
			detail: "RPC 'merge_entities' is called by the server but missing from the live PostgREST schema cache",
			fix: "run `supabase db push` from main to apply pending migrations, or reload the PostgREST schema cache",
		});
		expect(find(checks, "database rpc unmerge_entities")).toEqual({
			family: "wiring",
			name: "database rpc unmerge_entities",
			status: "fail",
			detail: "RPC 'unmerge_entities' is called by the server but missing from the live PostgREST schema cache",
			fix: "run `supabase db push` from main to apply pending migrations, or reload the PostgREST schema cache",
		});
	});

	describe("driveWatchWiringChecks", () => {
		it("returns empty array when google_drive is not in configured integrations", async () => {
			const checks = await driveWatchWiringChecks([
				row("notion_personal", ["state_doc_page_id"]),
			]);
			expect(checks).toEqual([]);
		});

		it("warns when google_drive is configured but has no active watch channel", async () => {
			vi.mocked(loadIntegrationConfigDetailed).mockResolvedValue({
				status: "ok",
				data: { default_folder_id: "folder-123" } as any,
			});

			const checks = await driveWatchWiringChecks([
				row("google_drive", ["default_folder_id"]),
			]);

			const personalCheck = find(checks, "drive watch personal");
			expect(personalCheck).toBeDefined();
			expect(personalCheck?.status).toBe("warn");
			expect(personalCheck?.detail).toContain("no active changes.watch channel registered");
			expect(personalCheck?.fix).toContain("run the engine drive-watch cadence");
		});

		it("warns when watch channel is expired", async () => {
			vi.mocked(loadIntegrationConfigDetailed).mockResolvedValue({
				status: "ok",
				data: {
					watch_channels: {
						personal: {
							id: "chan-old",
							expiration: String(Date.now() - 10000), // expired 10s ago
						},
					},
				} as any,
			});

			const checks = await driveWatchWiringChecks([
				row("google_drive", ["watch_channels"]),
			]);

			const personalCheck = find(checks, "drive watch personal");
			expect(personalCheck).toBeDefined();
			expect(personalCheck?.status).toBe("warn");
			expect(personalCheck?.detail).toContain("expired at");
			expect(personalCheck?.fix).toContain("run the engine drive-watch cadence to renew");
		});

		it("reports ok when an active watch channel is registered", async () => {
			const futureExp = Date.now() + 5 * 24 * 60 * 60 * 1000;
			vi.mocked(loadIntegrationConfigDetailed).mockResolvedValue({
				status: "ok",
				data: {
					watch_channels: {
						personal: {
							id: "chan-active",
							expiration: String(futureExp),
						},
					},
				} as any,
			});

			const checks = await driveWatchWiringChecks([
				row("google_drive", ["watch_channels"]),
			]);

			const personalCheck = find(checks, "drive watch personal");
			expect(personalCheck).toBeDefined();
			expect(personalCheck?.status).toBe("ok");
			expect(personalCheck?.detail).toContain("active changes.watch channel 'chan-active' registered until");
		});
	});

	describe("wiring: scheduler cadences (#1754)", () => {
		it("is ok when all defined cadences have recorded runs", async () => {
			const checks = await schedulerCadenceChecks();
			expect(checks).toEqual([
				{
					family: "wiring",
					name: "scheduler cadences",
					status: "ok",
					detail: `all ${DEFINED_SCHEDULER_CADENCES.length} defined scheduler cadences have recorded runs in scheduler_runs.`,
					fix: "",
				},
			]);
		});

		it("warns when cadences have never recorded a run", async () => {
			// Only discover and enrich have run; alerts and dedup are dormant
			schedulerRuns.data = [{ cadence: "discover" }, { cadence: "enrich" }];
			const checks = await schedulerCadenceChecks();

			const alertsCheck = find(checks, "scheduler cadence alerts");
			expect(alertsCheck?.status).toBe("warn");
			expect(alertsCheck?.detail).toContain(
				"cadence 'alerts' is defined in code but has never recorded a run in scheduler_runs",
			);
			expect(alertsCheck?.fix).toContain("KMS_ALERT_EVALUATOR_ENABLED");

			const dedupCheck = find(checks, "scheduler cadence dedup");
			expect(dedupCheck?.status).toBe("warn");
			expect(dedupCheck?.detail).toContain(
				"cadence 'dedup' is defined in code but has never recorded a run in scheduler_runs",
			);
			expect(dedupCheck?.fix).toContain("KMS_DEDUP_SWEEP_ENABLED");
		});

		it("warns when scheduler_runs query fails", async () => {
			schedulerRuns.data = [];
			schedulerRuns.error = new Error("database timeout");
			const checks = await schedulerCadenceChecks();

			expect(checks).toEqual([
				{
					family: "wiring",
					name: "scheduler cadences",
					status: "warn",
					detail: "could not query scheduler_runs: database timeout",
					fix: "verify Supabase network connectivity and scheduler_runs permissions",
				},
			]);
		});

		describe("against a table larger than the API row cap (#2320)", () => {
			const OK = [
				{
					family: "wiring",
					name: "scheduler cadences",
					status: "ok",
					detail: "all 10 defined scheduler cadences have recorded runs in scheduler_runs.",
					fix: "",
				},
			];
			// 1000 `jobs` rows come back first, so an unfiltered read is all `jobs`.
			const jobsFlood = () => Array.from({ length: schedulerRuns.API_MAX_ROWS }, () => ({ cadence: "jobs" }));

			it("is ok when every cadence has a run that an unfiltered read would not return", async () => {
				schedulerRuns.data = [...jobsFlood(), ...DEFINED_SCHEDULER_CADENCES.map((c) => ({ cadence: c }))];
				expect(DEFINED_SCHEDULER_CADENCES).toHaveLength(10);

				expect(await schedulerCadenceChecks()).toEqual(OK);
			});

			it("still reports a cadence whose own read returns no row, with the same wording", async () => {
				schedulerRuns.data = [
					...jobsFlood(),
					...DEFINED_SCHEDULER_CADENCES.filter((c) => c !== "learning").map((c) => ({ cadence: c })),
				];

				expect(await schedulerCadenceChecks()).toEqual([
					{
						family: "wiring",
						name: "scheduler cadence learning",
						status: "warn",
						detail:
							"cadence 'learning' is defined in code but has never recorded a run in scheduler_runs; cadence may be inert or missing env gate",
						fix: "verify host environment variables on worker or mcp-server (e.g. KMS_LEARNING_SWEEP_ENABLED)",
					},
				]);
			});

			it("reports the query failure alone when any one cadence read errors", async () => {
				// `enrich` cannot be read and `dedup` has no rows: no dormant claim is made for either.
				schedulerRuns.data = DEFINED_SCHEDULER_CADENCES.filter((c) => c !== "dedup").map((c) => ({ cadence: c }));
				schedulerRuns.errorByCadence = { enrich: new Error("statement timeout") };

				expect(await schedulerCadenceChecks()).toEqual([
					{
						family: "wiring",
						name: "scheduler cadences",
						status: "warn",
						detail: "could not query scheduler_runs: statement timeout",
						fix: "verify Supabase network connectivity and scheduler_runs permissions",
					},
				]);
			});

			it("issues one read per defined cadence, each filtered and limited to one row, and none unfiltered", async () => {
				await schedulerCadenceChecks();

				expect(schedulerRuns.reads.filter((r) => r.cadence === null)).toEqual([]);
				expect([...schedulerRuns.reads].sort((a, b) => String(a.cadence).localeCompare(String(b.cadence)))).toEqual(
					[...DEFINED_SCHEDULER_CADENCES].sort().map((cadence) => ({ cadence, limit: 1 })),
				);
			});
		});

		it("is included in checkWiring() report", async () => {
			schedulerRuns.data = [{ cadence: "discover" }];
			const checks = await checkWiring();
			const alertsCheck = find(checks, "scheduler cadence alerts");
			expect(alertsCheck?.status).toBe("warn");
		});
	});
});
