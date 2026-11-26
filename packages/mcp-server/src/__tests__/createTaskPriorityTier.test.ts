import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	PRIORITY_LEVELS,
	PRIORITY_SURFACE_MAPPINGS,
} from "@ahkms/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { supabase } from "../supabase.js";
import { createTaskHandler, createTaskInput } from "../tools/createTask.js";

const REPO_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);

const origFrom = supabase.from;
const origStorageFrom = supabase.storage.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	(supabase.storage as any).from = origStorageFrom;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function stubUserIntegrations(rows: Record<string, Record<string, unknown>>) {
	(supabase as any).from = vi.fn((table: string) => {
		if (table === "user_integrations") {
			let currentProvider: string | undefined;
			const b: any = {
				select: () => b,
				eq: (col: string, value: string) => {
					if (col === "provider") currentProvider = value;
					return b;
				},
				maybeSingle: () => {
					const config = currentProvider ? rows[currentProvider] : undefined;
					return Promise.resolve(
						config
							? { data: { config, enabled: true }, error: null }
							: { data: null, error: null },
					);
				},
			};
			return b;
		}
		if (table === "artifacts") {
			return { insert: () => Promise.resolve({ error: null }) };
		}
		if (table === "artifact_external_links") {
			const b: any = {
				select: () => b,
				eq: () => b,
				upsert: () => Promise.resolve({ error: null }),
			};
			return b;
		}
		throw new Error(`Unexpected table in test stub: ${table}`);
	});
	(supabase.storage as any).from = vi.fn(() => ({
		upload: vi.fn(async () => ({ error: null })),
		remove: vi.fn(async () => ({ error: null })),
	}));
}

function stubNotionWithSchema(schemaProperties: Record<string, unknown>) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		if (url.includes("/databases/") && init.method === "GET") {
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({ properties: schemaProperties }),
				text: async () => "",
			} as Response;
		}
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({ id: "page_1", url: "https://notion.so/page_1" }),
			text: async () => "",
		} as Response;
	});
	return { fetchMock, calls };
}

const SCHEMA_WITH_HML_PRIORITY = {
	Name: { type: "title", title: {} },
	Due: { type: "date", date: {} },
	Priority: {
		type: "select",
		select: { options: [{ name: "Low" }, { name: "Medium" }, { name: "High" }] },
	},
};

const SCHEMA_WITH_URGENT_NORMAL_PRIORITY = {
	Name: { type: "title", title: {} },
	Due: { type: "date", date: {} },
	Priority: {
		type: "select",
		select: { options: [{ name: "Urgent" }, { name: "Normal" }] },
	},
};

describe("createTaskHandler — priority_tier (#1920)", () => {
	it("resolves priority_tier: 2 against Low/Medium/High schema to Medium and notes resolution without Defaulted priority", async () => {
		stubUserIntegrations({
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: { due: "Due", priority: "Priority" },
			},
		});
		const { fetchMock, calls } = stubNotionWithSchema(SCHEMA_WITH_HML_PRIORITY);
		vi.stubGlobal("fetch", fetchMock);

		const out = await createTaskHandler({
			domain: "work",
			title: "Ship it",
			properties: { priority_tier: 2 },
		});

		const postCall = calls.find((c) => c.url.endsWith("/pages") && c.init.method === "POST");
		expect(postCall).toBeDefined();
		const body = JSON.parse(postCall!.init.body as string);
		expect(body.properties.Priority).toEqual({ select: { name: "Medium" } });
		expect(out.content[0].text).toContain("Priority tier 2 resolved to 'Medium'");
		expect(out.content[0].text).not.toContain("Defaulted priority");
	});

	it("rejects passing both properties.priority and properties.priority_tier at the schema and in createTaskHandler before any fetch", async () => {
		const parsed = z.object(createTaskInput).safeParse({
			title: "t",
			domain: "work",
			properties: { priority: "High", priority_tier: 1 },
		});
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			expect(parsed.error.issues.map((i) => i.message)).toContain(
				"pass properties.priority or properties.priority_tier, not both",
			);
		}

		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			createTaskHandler({
				title: "t",
				domain: "work",
				properties: { priority: "High", priority_tier: 1 },
			}),
		).rejects.toThrow("pass properties.priority or properties.priority_tier, not both");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses priority_tier: 1 against Urgent/Normal schema naming priority_tier 1, tried names, and live options without POST /pages", async () => {
		stubUserIntegrations({
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: { due: "Due", priority: "Priority" },
			},
		});
		const { fetchMock, calls } = stubNotionWithSchema(SCHEMA_WITH_URGENT_NORMAL_PRIORITY);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			createTaskHandler({
				domain: "work",
				title: "Ship it",
				properties: { priority_tier: 1 },
			}),
		).rejects.toThrow(
			"task_create: priority_tier 1 has no option on 'Priority' in the 'notion_work' tasks database: tried 1 High, High, P1, P0; it offers Urgent, Normal.",
		);

		const postCalls = calls.filter((c) => c.url.endsWith("/pages") && c.init.method === "POST");
		expect(postCalls).toHaveLength(0);
	});

	it("resolves priority_level (1..7) against Low/Medium/High schema and rejects combining priority_level with priority or priority_tier (#1986)", async () => {
		stubUserIntegrations({
			notion_work: {
				tasks_database_id: "db_work",
				title_property: "Name",
				property_map: { due: "Due", priority: "Priority" },
			},
		});
		const { fetchMock, calls } = stubNotionWithSchema(SCHEMA_WITH_HML_PRIORITY);
		vi.stubGlobal("fetch", fetchMock);

		const out = await createTaskHandler({
			domain: "work",
			title: "Critical launch fix",
			properties: { priority_level: 7 },
		});

		const postCall = calls.find((c) => c.url.endsWith("/pages") && c.init.method === "POST");
		expect(postCall).toBeDefined();
		const body = JSON.parse(postCall!.init.body as string);
		expect(body.properties.Priority).toEqual({ select: { name: "High" } });
		expect(out.content[0].text).toContain("Priority level 7 resolved to 'High'");
		expect(out.content[0].text).not.toContain("Defaulted priority");

		await expect(
			createTaskHandler({
				domain: "work",
				title: "Conflict",
				properties: { priority_level: 5, priority: "High" },
			}),
		).rejects.toThrow(
			"pass properties.priority_level, properties.priority, or properties.priority_tier, not more than one",
		);
	});

	it("keeps migration 147 priority_levels and priority_surface_mappings in lockstep with @ahkms/core (#1986)", () => {
		const sql = readFileSync(
			resolve(
				REPO_ROOT,
				"supabase/migrations/20261031150000_147_priority_scale_and_surface_mappings.sql",
			),
			"utf8",
		);
		expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.priority_levels");
		expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.priority_surface_mappings");
		expect(sql).toContain("ADD COLUMN IF NOT EXISTS priority_level integer");

		const normalizedSql = sql.replace(/\s+/g, " ");
		for (const levelDef of PRIORITY_LEVELS) {
			expect(normalizedSql).toContain(`(${levelDef.level}, '${levelDef.title}',`);
		}
		for (const mapping of PRIORITY_SURFACE_MAPPINGS) {
			expect(normalizedSql).toContain(
				`('${mapping.surface}', ${mapping.level}, '${mapping.externalValue}', ${mapping.isCanonicalReverse},`,
			);
		}
	});
});
