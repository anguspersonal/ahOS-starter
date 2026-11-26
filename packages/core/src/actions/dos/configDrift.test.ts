import { describe, expect, it, vi } from "vitest";
import { executeAction } from "../adapters/direct.js";
import { DailyLogUnwiredError } from "../../domain/dailyLogTarget.js";
import { dosConfigSchema } from "../../domain/dosConfig.js";
import type { NotionPort } from "../../ports/notion.js";
import {
	createDosConfigDriftAction,
	formatDosConfigDriftMcp,
	reconcileDomainAgainstNotion,
	type DosConfigDriftPorts,
	type DosConfigPort,
} from "./configDrift.js";

const DAILY_LOG_DB = "3499e609-fe01-8046-913a-d59df0ce9b9d";
const TASKS_DB = "1499e609-fe01-8046-913a-d59df0ce9b9d";

const PRE_090_BLOCK = {
	topics: ["Apple", "Round", "EHS", "Ops"],
	pillars: [{ key: "Pillar 1", label: "Product", description: "desc", notion_option: "Product" }],
	daily_log_schema: {
		properties: [
			{ name: "Other domains", notion_type: "multi_select", required: false },
			{ name: "Pillars", notion_type: "multi_select", required: false, role: "pillars" },
		],
		body_sections: [],
	},
};

const LIVE_DAILY_LOG_PROPS = {
	"Other domains": {
		type: "multi_select",
		multi_select: { options: [{ name: "Apple" }, { name: "Ops" }, { name: "Personal" }] },
	},
	Pillars: {
		type: "multi_select",
		multi_select: { options: [{ name: "Product" }, { name: "P1 Launch" }] },
	},
};

function makePorts(opts: {
	dosConfig?: unknown;
	workIntegration?: Record<string, unknown> | null;
	angusIntegration?: Record<string, unknown> | null;
	configError?: Error;
	retrieveDatabase?: NotionPort["retrieveDatabase"];
	retrieveDataSource?: NotionPort["retrieveDataSource"];
	resolveToken?: NotionPort["resolveToken"];
} = {}): DosConfigDriftPorts {
	const rawIntegration = (provider: string) =>
		provider === "notion_work"
			? opts.workIntegration !== undefined
				? opts.workIntegration
				: {
						tasks_database_id: TASKS_DB,
						daily_log_database_id: DAILY_LOG_DB,
						property_map: { status: "Status" },
					}
			: opts.angusIntegration ?? null;

	const config: DosConfigPort = {
		loadDosConfigRow: vi.fn(async () => opts.dosConfig ?? { by_domain: { work: PRE_090_BLOCK }, types: [], tone: [] }),
		loadConfigDetailed: vi.fn(async (provider, schema) => {
			if (opts.configError) return { status: "error", error: opts.configError };
			const row = rawIntegration(provider);
			if (!row) return { status: "unwired" };
			const parsed = schema.safeParse(row);
			return parsed.success ? { status: "ok", data: parsed.data } : { status: "unwired" };
		}),
		loadConfig: vi.fn(async (provider, schema) => {
			const row = rawIntegration(provider);
			if (!row) return null;
			const parsed = schema.safeParse(row);
			return parsed.success ? parsed.data : null;
		}),
	};

	const notion = {
		resolveToken: opts.resolveToken ?? vi.fn(async (w: string) => `tok-${w}`),
		retrieveDatabase:
			opts.retrieveDatabase ??
			vi.fn(async ({ databaseId }) => ({
				id: databaseId,
				properties:
					databaseId === TASKS_DB
						? { Status: { type: "status", status: { options: [{ name: "Done" }] } } }
						: (LIVE_DAILY_LOG_PROPS as any),
			})),
		...(opts.retrieveDataSource ? { retrieveDataSource: opts.retrieveDataSource } : {}),
	} as unknown as NotionPort;

	return { notion, config };
}

describe("dos_config_drift core action (#1494)", () => {
	it("exposes expected metadata, default surfaces, and input schema", () => {
		const action = createDosConfigDriftAction(makePorts());
		expect(action.id).toBe("dos_config_drift");
		expect(action.domain).toBe("ops");
		expect(action.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(action.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(action.description).toContain("docs/guides/tools/dos_config_drift.md");
		expect(Object.keys((action.schema as any).shape)).toEqual(["domain"]);
	});

	it("reports quarantined drift without aborting the ritual", async () => {
		const action = createDosConfigDriftAction(makePorts());
		const out = await executeAction(action, {});
		const text = formatDosConfigDriftMcp(out);

		expect(out.domain).toBe("work");
		expect(text).toContain("DRIFT");
		expect(text).toContain("QUARANTINED");
		expect(text).toContain("Round, EHS");
		expect(text).toContain("the ritual CONTINUES");
		expect(text).toContain("notion also offers");
		expect(text).toContain("Personal");
	});

	it("resolves database properties through first data_source when 2025-09-03 database omits properties", async () => {
		const retrieveDataSource = vi.fn(async () => ({
			id: "ds-1",
			properties: LIVE_DAILY_LOG_PROPS as any,
		}));
		const ports = makePorts({
			dosConfig: dosConfigSchema.parse({
				by_domain: { work: { ...PRE_090_BLOCK, topics: ["Apple", "Ops"] } },
				types: [],
				tone: [],
			}),
			workIntegration: {
				tasks_database_id: TASKS_DB,
				daily_log_database_id: DAILY_LOG_DB,
				property_map: {},
			},
			retrieveDatabase: vi.fn(async ({ databaseId }) => ({
				id: databaseId,
				data_sources: [{ id: "ds-1" }],
			})),
			retrieveDataSource,
		});

		const result = await reconcileDomainAgainstNotion("work", ports);
		expect(retrieveDataSource).toHaveBeenCalledWith({ workspace: "work", dataSourceId: "ds-1" });
		expect(result.kind).toBe("checked");
	});

	it("throws DailyLogUnwiredError when daily_log_database_id is missing and degrades DB errors to target_unresolved", async () => {
		const unwired = makePorts({
			workIntegration: { tasks_database_id: TASKS_DB, property_map: {} },
		});
		await expect(reconcileDomainAgainstNotion("work", unwired)).rejects.toThrow(DailyLogUnwiredError);
		await expect(reconcileDomainAgainstNotion("work", unwired)).rejects.toThrow(
			/that Daily Log is unwired, so nothing was read\./,
		);

		const dbErr = makePorts({ configError: new Error("Supabase timeout") });
		const res = await reconcileDomainAgainstNotion("work", dbErr);
		expect(res).toEqual({
			kind: "target_unresolved",
			error: "Failed to read integration config for provider 'notion_work': Supabase timeout",
		});
	});

	it("reports COULD NOT VERIFY for an unreachable Tasks DB (even 404) while throwing stop text for a 404 Daily Log", async () => {
		const tasksUnreachable = makePorts({
			dosConfig: {
				by_domain: { work: { ...PRE_090_BLOCK, topics: ["Apple", "Ops"] } },
				types: [],
				tone: [],
			},
			retrieveDatabase: vi.fn(async ({ databaseId }) => {
				if (databaseId === TASKS_DB) {
					throw Object.assign(new Error("Tasks DB missing"), { status: 404 });
				}
				return { id: databaseId, properties: LIVE_DAILY_LOG_PROPS as any };
			}),
		});
		const action = createDosConfigDriftAction(tasksUnreachable);
		const text = formatDosConfigDriftMcp(await executeAction(action, {}));
		expect(text).toContain("COULD NOT VERIFY");
		expect(text).toContain("task_create itself is unaffected");
		expect(text).toContain("verdict: ok \u2014 every configured value exists in Notion.");

		const dailyLog404 = makePorts({
			retrieveDatabase: vi.fn(async () => {
				throw Object.assign(new Error("object_not_found"), { status: 404 });
			}),
		});
		await expect(reconcileDomainAgainstNotion("work", dailyLog404)).rejects.toThrow(
			/Nothing was read, and the ritual must not proceed to a write it now knows will fail\./,
		);
	});

	it("branches strictly on err.status === 404 (#1569) and never parses error message text", async () => {
		// 1. status: 404 with plain message (no '(404)' substring) -> hard stop throw
		const plain404 = makePorts({
			retrieveDatabase: vi.fn(async () => {
				throw Object.assign(new Error("Could not find database"), { status: 404 });
			}),
		});
		await expect(reconcileDomainAgainstNotion("work", plain404)).rejects.toThrow(
			/Connections \u2192 ahKMS/,
		);

		// 2. status: 503 whose message happens to contain '(404)' -> COULD NOT VERIFY, never throws
		const status503With404Text = makePorts({
			workIntegration: {
				tasks_database_id: TASKS_DB,
				daily_log_database_id: DAILY_LOG_DB,
				property_map: {},
			},
			retrieveDatabase: vi.fn(async () => {
				throw Object.assign(new Error("Upstream proxy mentioned (404) in body"), { status: 503 });
			}),
		});
		const res503 = await reconcileDomainAgainstNotion("work", status503With404Text);
		expect(res503.kind).toBe("could_not_verify");

		// 3. Error with NO status property whose message contains '(404)' -> COULD NOT VERIFY, never parses message text
		const statuslessWith404Text = makePorts({
			workIntegration: {
				tasks_database_id: TASKS_DB,
				daily_log_database_id: DAILY_LOG_DB,
				property_map: {},
			},
			retrieveDatabase: vi.fn(async () => {
				throw new Error("Notion retrieve database failed (404): object_not_found");
			}),
		});
		const resStatusless = await reconcileDomainAgainstNotion("work", statuslessWith404Text);
		expect(resStatusless.kind).toBe("could_not_verify");
	});
});
