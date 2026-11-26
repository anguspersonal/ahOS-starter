import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the two boundaries are stubbed — the DB read and the Notion read. The
// reconciliation itself stays real, so what these tests assert is the text a ritual
// would actually be handed.
vi.mock("../dosConfig.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../dosConfig.js")>();
	return { ...actual, loadDosConfig: vi.fn() };
});
vi.mock("../dailyLogTarget.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../dailyLogTarget.js")>();
	return { ...actual, resolveDailyLogTarget: vi.fn() };
});
vi.mock("../notion.js", () => ({ retrieveDatabaseSchema: vi.fn() }));
vi.mock("../integrations.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../integrations.js")>();
	return { ...actual, loadIntegrationConfig: vi.fn() };
});

import {
	createDosConfigDriftAction,
	type DosConfigDriftInput,
	type NotionDatabasePropertyItem,
} from "@ahkms/core";
import { toMcpTool } from "../actions/adapters/mcp.js";
import { DailyLogUnwiredError, resolveDailyLogTarget } from "../dailyLogTarget.js";
import { dosConfigSchema, loadDosConfig } from "../dosConfig.js";
import { loadIntegrationConfig } from "../integrations.js";
import { retrieveDatabaseSchema } from "../notion.js";

const DAILY_LOG_DB = "3499e609-fe01-8046-913a-d59df0ce9b9d";

let activeToken: string | undefined;
const driftTool = toMcpTool(
	createDosConfigDriftAction({
		resolveDailyLogTarget: async (domain, attempted) => {
			const target = await resolveDailyLogTarget(domain, attempted);
			activeToken = target.token;
			return target;
		},
		config: {
			loadDosConfigRow: async () => await loadDosConfig(),
			loadConfigDetailed: async () => ({ status: "unwired" }),
			loadConfig: async (provider, schema) => await loadIntegrationConfig(provider, schema),
		},
		notion: {
			retrieveDatabase: async ({ databaseId }) => {
				try {
					const schema = await retrieveDatabaseSchema(databaseId, activeToken);
					const properties: Record<string, NotionDatabasePropertyItem> = {};
					for (const p of schema.properties) {
						const opts = p.options ? { options: p.options.map((name) => ({ name })) } : undefined;
						properties[p.name] = {
							type: p.type,
							...(p.type === "select" && opts ? { select: opts } : {}),
							...(p.type === "multi_select" && opts ? { multi_select: opts } : {}),
							...(p.type === "status" && opts ? { status: opts } : {}),
						};
					}
					return { id: databaseId, properties };
				} catch (err) {
					const m = err instanceof Error ? err.message.match(/\((\d{3})\)/) : null;
					if (m) {
						throw Object.assign(new Error(err instanceof Error ? err.message : String(err)), {
							status: Number(m[1]),
						});
					}
					throw err;
				}
			},
		},
	}),
);

const run = async (args: DosConfigDriftInput = {}) =>
	(await driftTool.handler(args)).content[0].text;

const withWork = (block: unknown) => {
	vi.mocked(loadDosConfig).mockResolvedValue(
		dosConfigSchema.parse({ by_domain: { work: block }, types: [], tone: [] }),
	);
};

/** The pre-090 blob, i.e. what production carries the moment this code deploys. */
const PRE_090_BLOCK = {
	topics: ["Apple", "Round", "EHS", "Ops"],
	pillars: [{ key: "Pillar 1", label: "Product", description: "…", notion_option: "Product" }],
	daily_log_schema: {
		properties: [
			{ name: "Other domains", notion_type: "multi_select", required: false },
			{ name: "Pillars", notion_type: "multi_select", required: false, role: "pillars" },
		],
		body_sections: [],
	},
};

const LIVE_SCHEMA = {
	properties: [
		{ name: "Other domains", type: "multi_select", options: ["Apple", "Ops", "Personal"] },
		{ name: "Pillars", type: "multi_select", options: ["Product", "P1 Launch"] },
	],
};

const TASKS_DB = "1499e609-fe01-8046-913a-d59df0ce9b9d";

beforeEach(() => {
	vi.mocked(loadDosConfig).mockReset();
	vi.mocked(resolveDailyLogTarget).mockReset();
	vi.mocked(retrieveDatabaseSchema).mockReset();
	vi.mocked(loadIntegrationConfig).mockReset();

	vi.mocked(resolveDailyLogTarget).mockResolvedValue({
		databaseId: DAILY_LOG_DB,
		token: "tok",
		provider: "notion_work",
	});
	// No tasks integration configured by default — the tasks-drift tests below opt back
	// in explicitly. Keeps every pre-existing test (none of which cares about the tasks
	// section) from having to know it exists.
	vi.mocked(loadIntegrationConfig).mockResolvedValue(null);
});

describe("severity: drift reports and quarantines, it never stops the ritual (#656)", () => {
	it("returns a report — it does not throw — when config offers values Notion lacks", async () => {
		withWork(PRE_090_BLOCK);
		vi.mocked(retrieveDatabaseSchema).mockResolvedValue(LIVE_SCHEMA);

		const text = await run();

		expect(text).toContain("DRIFT");
		expect(text).toContain("QUARANTINED");
		expect(text).toContain("Round, EHS");
		expect(text).toContain("the ritual CONTINUES");
	});

	it("reports a Notion-only option without calling it a fault", async () => {
		withWork(PRE_090_BLOCK);
		vi.mocked(retrieveDatabaseSchema).mockResolvedValue(LIVE_SCHEMA);

		const text = await run();

		expect(text).toContain("notion also offers");
		expect(text).toContain("Personal");
	});

	it("says ok when every configured value is live", async () => {
		withWork({ ...PRE_090_BLOCK, topics: ["Apple", "Ops"] });
		vi.mocked(retrieveDatabaseSchema).mockResolvedValue(LIVE_SCHEMA);

		const text = await run();

		expect(text).toContain("verdict: ok");
		expect(text).not.toContain("QUARANTINED");
	});
});

describe("the verdict never claims to have checked what it did not (#656)", () => {
	// `verdict: ok` reads as "every configured value exists in Notion", so it may only
	// be printed when that was actually established. A vocabulary reconciled against
	// nothing is unknown, and the unknown cases are the SILENT ones — Notion creates an
	// unknown option rather than refusing it (#695).

	it("an option-less property is NOT FULLY VERIFIED, never an all-clear", async () => {
		// This is the live `angus` shape: `Other domains` is declared in config and, per
		// the migration-088 block, has no options defined in Notion. It is the first
		// verdict `domain:'angus'` will ever produce.
		withWork({
			topics: ["Health", "Fitness"],
			pillars: [],
			daily_log_schema: {
				properties: [{ name: "Other domains", notion_type: "multi_select", required: false }],
				body_sections: [],
			},
		});
		vi.mocked(retrieveDatabaseSchema).mockResolvedValue({
			properties: [{ name: "Other domains", type: "multi_select" }],
		});

		const text = await run();

		expect(text).toContain("UNENFORCEABLE");
		expect(text).toContain("NOT FULLY VERIFIED");
		expect(text).toContain("not verified: topics");
		expect(text).not.toContain("verdict: ok");
	});

	it("an undeclared binding is reported as unverified alongside a real drift", async () => {
		// pillars drifts, topics binding does not resolve: the drift verdict must carry the
		// unverified note rather than let it disappear behind the louder finding.
		withWork({
			...PRE_090_BLOCK,
			topics: ["Apple", "Ops"],
			pillars: [
				{ key: "Pillar 1", label: "Product", description: "…", notion_option: "Nonexistent" },
			],
			daily_log_schema: {
				properties: [
					{ name: "Pillars", notion_type: "multi_select", required: false, role: "pillars" },
				],
				body_sections: [],
			},
		});
		vi.mocked(retrieveDatabaseSchema).mockResolvedValue(LIVE_SCHEMA);

		const text = await run();

		expect(text).toContain("verdict: DRIFT");
		expect(text).toContain("not verified: topics");
	});

	it("flags drift when pillars[] is non-empty while no property carries role 'pillars' (#703)", async () => {
		withWork({
			...PRE_090_BLOCK,
			daily_log_schema: {
				properties: [
					{ name: "Other domains", notion_type: "multi_select", required: false },
					{ name: "Pillars", notion_type: "multi_select", required: false },
				],
				body_sections: [],
			},
		});
		vi.mocked(retrieveDatabaseSchema).mockResolvedValue(LIVE_SCHEMA);

		const text = await run();

		expect(text).toContain("pillars → (unresolved): DRIFT");
		expect(text).toContain("daily_log_schema declares no property with role 'pillars'");
		expect(text).toContain("QUARANTINED, do not write any of: Product");
		expect(text).toContain("verdict: DRIFT");
	});

	it("counts the whole vocabulary when the destination property itself is gone", async () => {
		// `absent`: nothing is individually missing, but nothing is writable either. The
		// count in the verdict must agree with the QUARANTINED line above it.
		withWork({ ...PRE_090_BLOCK, topics: ["Apple", "Ops"], pillars: [] });
		vi.mocked(retrieveDatabaseSchema).mockResolvedValue({
			properties: [{ name: "Pillars", type: "multi_select", options: ["Product"] }],
		});

		const text = await run();

		expect(text).toContain("verdict: DRIFT — 2 configured value(s)");
		expect(text).toContain("QUARANTINED, do not write any of: Apple, Ops");
	});
});

describe("severity: the hard stops are an unreachable destination or unwired domain (#655, #710)", () => {
	it("throws the sharing instruction on a 404", async () => {
		withWork(PRE_090_BLOCK);
		vi.mocked(retrieveDatabaseSchema).mockRejectedValue(
			new Error("Notion retrieve database failed (404): object_not_found"),
		);

		await expect(run()).rejects.toThrow(/Connections → ahKMS/);
		await expect(run()).rejects.toThrow(/cannot see it/);
	});

	it("throws when the domain's Daily Log is genuinely unwired (#710)", async () => {
		withWork(PRE_090_BLOCK);
		vi.mocked(resolveDailyLogTarget).mockRejectedValue(
			new DailyLogUnwiredError("work", "notion_work", "so nothing was read."),
		);

		await expect(run()).rejects.toThrow(
			/that Daily Log is unwired, so nothing was read./,
		);
	});

	it("does NOT throw on a Notion non-404 read failure — a transient says nothing about config", async () => {
		withWork(PRE_090_BLOCK);
		vi.mocked(retrieveDatabaseSchema).mockRejectedValue(
			new Error("Notion retrieve database failed (503): service unavailable"),
		);

		const text = await run();

		expect(text).toContain("COULD NOT VERIFY");
		expect(text).toContain("503");
	});

	it("does NOT throw on a DB/resolver read failure — a transient says nothing about config (#710)", async () => {
		withWork(PRE_090_BLOCK);
		vi.mocked(resolveDailyLogTarget).mockRejectedValue(
			new Error("Supabase read timeout (500)"),
		);

		const text = await run();

		expect(text).toContain("COULD NOT VERIFY");
		expect(text).toContain("500");
	});
});

describe("an unconfigured domain is reported, never reconciled against nothing", () => {
	it("says NOT CHECKED rather than producing an all-clear", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(
			dosConfigSchema.parse({ by_domain: { work: {} }, types: [], tone: [] }),
		);

		const text = await run({ domain: "angus" });

		expect(text).toContain("NOT CHECKED");
		expect(text).toContain("This is not an all-clear");
		// It must not have gone near Notion for a domain it has no config for.
		expect(retrieveDatabaseSchema).not.toHaveBeenCalled();
	});
});

describe("tasks db property_map reconciliation (#1001)", () => {
	const TASKS_CONFIG = (property_map: Record<string, string>) => ({
		tasks_database_id: TASKS_DB,
		title_property: "Name",
		property_map,
	});

	/** Route retrieveDatabaseSchema by which database id it was asked for. */
	function mockSchemas(tasksSchema: unknown) {
		vi.mocked(retrieveDatabaseSchema).mockImplementation(async (databaseId: string) =>
			databaseId === TASKS_DB ? (tasksSchema as never) : LIVE_SCHEMA,
		);
	}

	beforeEach(() => {
		// Every test in this block has a clean Daily Log so failures read unambiguously as
		// about the tasks section.
		withWork({ ...PRE_090_BLOCK, topics: ["Apple", "Ops"], pillars: [] });
	});

	it("says NOT CHECKED when no tasks integration is configured", async () => {
		vi.mocked(loadIntegrationConfig).mockResolvedValue(null);
		vi.mocked(retrieveDatabaseSchema).mockResolvedValue(LIVE_SCHEMA);

		const text = await run();

		expect(text).toContain("tasks db↔property_map reconciliation");
		expect(text).toContain("NOT CHECKED — no 'notion_work' tasks integration is configured");
	});

	it("reports an empty property_map on a configured integration as DRIFT", async () => {
		vi.mocked(loadIntegrationConfig).mockResolvedValue(TASKS_CONFIG({}));
		vi.mocked(retrieveDatabaseSchema).mockResolvedValue(LIVE_SCHEMA);

		const text = await run();

		expect(text).toContain("tasks db↔property_map reconciliation");
		expect(text).toContain("verdict: DRIFT — property_map is empty");
		// The empty-map path must not attempt a Tasks DB read — there is nothing to
		// introspect against yet.
		expect(retrieveDatabaseSchema).not.toHaveBeenCalledWith(TASKS_DB, expect.anything());
	});

	it("names a stale mapped property that does not exist on the live tasks database", async () => {
		vi.mocked(loadIntegrationConfig).mockResolvedValue(
			TASKS_CONFIG({ owner: "Owner", status: "Status" }),
		);
		mockSchemas({
			properties: [
				{ name: "Status", type: "status", options: ["Not started", "Done"] },
				{ name: "Assignee", type: "people" },
				{ name: "Task name", type: "title" },
			],
		});

		const text = await run();

		expect(text).toContain("verdict: DRIFT — 1 mapped property does not exist");
		expect(text).toContain("'owner' → \"Owner\": NOT FOUND.");
		expect(text).toContain("Available properties: Status, Assignee, Task name.");
		// The correctly-mapped key must not also be reported as missing.
		expect(text).not.toContain("'status' → \"Status\": NOT FOUND.");
	});

	it("says ok when every mapped property exists on the live tasks database", async () => {
		vi.mocked(loadIntegrationConfig).mockResolvedValue(
			TASKS_CONFIG({ owner: "Assignee", status: "Status" }),
		);
		mockSchemas({
			properties: [
				{ name: "Status", type: "status", options: ["Not started", "Done"] },
				{ name: "Assignee", type: "people" },
				{ name: "Task name", type: "title" },
			],
		});

		const text = await run();

		expect(text).toContain("verdict: ok — every mapped property exists on the tasks database.");
		expect(text).not.toContain("DRIFT");
		expect(text).toContain('mapped and present: status → "Status", owner → "Assignee"');
	});

	it("reports an unmapped key whose fallback name the database happens to have, informationally", async () => {
		vi.mocked(loadIntegrationConfig).mockResolvedValue(TASKS_CONFIG({ owner: "Assignee" }));
		mockSchemas({
			properties: [
				// "Priority" is create_task's fallback name for the unmapped 'priority' key.
				{ name: "Priority", type: "select", options: ["High", "Low"] },
				{ name: "Assignee", type: "people" },
			],
		});

		const text = await run();

		expect(text).toContain("verdict: ok");
		expect(text).toContain("not mapped, but the database has a property under the default name");
		expect(text).toContain("priority");
	});

	it("reports COULD NOT VERIFY, never a throw, when the Tasks DB read fails — even a 404", async () => {
		vi.mocked(loadIntegrationConfig).mockResolvedValue(TASKS_CONFIG({ owner: "Owner" }));
		vi.mocked(retrieveDatabaseSchema).mockImplementation(async (databaseId: string) => {
			if (databaseId === TASKS_DB) {
				throw new Error("Notion retrieve database failed (404): object_not_found");
			}
			return LIVE_SCHEMA as never;
		});

		const text = await run();

		expect(text).toContain("tasks db↔property_map reconciliation");
		expect(text).toContain("COULD NOT VERIFY");
		expect(text).toContain("404");
		// The Daily Log half must still have succeeded and reported its own verdict.
		expect(text).toContain("verdict: ok — every configured value exists in Notion.");
	});
});

describe("schema property validation in drift report (#1728)", () => {
	it("reports Angus Type deadlock with actionable remediation", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(
			dosConfigSchema.parse({
				by_domain: {
					angus: {
						topics: [],
						pillars: [],
						daily_log_schema: {
							properties: [
								{ name: "Name", notion_type: "title", required: true },
								{ name: "Type", notion_type: "select", required: true },
							],
							body_sections: [],
						},
					},
				},
				types: [],
				tone: [],
			}),
		);
		vi.mocked(retrieveDatabaseSchema).mockResolvedValue({
			properties: [
				{ name: "Name", type: "title" },
				{ name: "Type", type: "select", options: ["Catch-up"] },
			],
		});

		const text = await run({ domain: "angus" });
		expect(text).toContain("daily log schema properties:");
		expect(text).toContain('"Type" (select, required): DRIFT — missing required option(s): Daily.');
		expect(text).toContain("Available in Notion: Catch-up.");
		expect(text).toContain("fix: Add option(s) 'Daily' to the 'Type' property in Notion (angus workspace).");
		expect(text).toContain("verdict: DRIFT — 1 schema property defect (Type) cannot be written to Notion.");
	});

	it("reports Work Covers type mismatch with #1016 remediation", async () => {
		withWork({
			topics: [],
			pillars: [],
			daily_log_schema: {
				properties: [
					{ name: "Name", notion_type: "title", required: true },
					{ name: "Covers", notion_type: "rich_text", required: false, role: "covers" },
				],
				body_sections: [],
			},
		});
		vi.mocked(retrieveDatabaseSchema).mockResolvedValue({
			properties: [
				{ name: "Name", type: "title" },
				{ name: "Covers", type: "people" },
			],
		});

		const text = await run({ domain: "work" });
		expect(text).toContain("daily log schema properties:");
		expect(text).toContain('"Covers" (rich_text | multi_select, role \'covers\'): DRIFT');
		expect(text).toContain("Notion type is 'people', expected 'rich_text | multi_select'.");
		expect(text).toContain("expected rich_text or multi_select (#1016). Covers will be omitted from entries.");
		expect(text).toContain("fix: Change 'Covers' property type in Notion (work workspace) to rich_text or multi_select");
		expect(text).toContain("verdict: DRIFT — 1 schema property defect (Covers) cannot be written to Notion.");
	});

	it("reports ok for properties when all declared match live Notion", async () => {
		withWork({
			topics: [],
			pillars: [],
			daily_log_schema: {
				properties: [
					{ name: "Name", notion_type: "title", required: true },
					{ name: "Type", notion_type: "select", required: true },
				],
				body_sections: [],
			},
		});
		vi.mocked(retrieveDatabaseSchema).mockResolvedValue({
			properties: [
				{ name: "Name", type: "title" },
				{ name: "Type", type: "select", options: ["Daily", "Catch-up"] },
			],
		});

		const text = await run({ domain: "work" });
		expect(text).toContain("daily log schema properties:");
		expect(text).toContain("ok — all 2 declared properties match Notion types and options.");
		expect(text).toContain("verdict: ok");
	});
});

describe("domain selection", () => {
	it("defaults to work when the caller names no domain", async () => {
		withWork(PRE_090_BLOCK);
		vi.mocked(retrieveDatabaseSchema).mockResolvedValue(LIVE_SCHEMA);

		expect(await run()).toContain("domain: work");
		expect(resolveDailyLogTarget).toHaveBeenCalledWith("work", "so nothing was read.");
	});

	it("reads only the named domain's own destination", async () => {
		vi.mocked(loadDosConfig).mockResolvedValue(
			dosConfigSchema.parse({
				by_domain: { work: PRE_090_BLOCK, angus: PRE_090_BLOCK },
				types: [],
				tone: [],
			}),
		);
		vi.mocked(retrieveDatabaseSchema).mockResolvedValue(LIVE_SCHEMA);

		await run({ domain: "angus" });

		expect(resolveDailyLogTarget).toHaveBeenCalledWith("angus", "so nothing was read.");
		expect(resolveDailyLogTarget).not.toHaveBeenCalledWith("work", "so nothing was read.");
	});
});
