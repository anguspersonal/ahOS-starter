import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildRegistry } from "@ahkms/core/actions";
import { createServer } from "../server.js";
import { serverAdapters, serverRegistry } from "../actions/serverRegistry.js";
import { toMcpTool } from "../actions/index.js";
import { supabase } from "../supabase.js";
import { readLegacyBaseline } from "./legacyBaseline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../");
const origFrom = supabase.from;

afterEach(() => {
	(supabase as any).from = origFrom;
});

async function withMcpClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	try {
		return await fn(client);
	} finally {
		await client.close();
	}
}

describe("configWriteActions (#1598)", () => {
	it("1. Contract parity: integration_set and notion_config_get match dev inputSchema and annotations", async () => {
		const tools = await withMcpClient(async (c) => (await c.listTools()).tools);

		const integrationSet = tools.find((t) => t.name === "integration_set");
		expect(integrationSet, "integration_set should be listed").toBeDefined();
		const isProps = (integrationSet!.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(isProps)).toEqual(["provider", "config", "enabled", "merge_arrays"]);
		expect(integrationSet!.inputSchema.required ?? []).toEqual(["provider"]);
		expect(isProps.provider?.type).toBe("string");
		expect(isProps.config?.type).toBe("object");
		expect(isProps.enabled?.type).toBe("boolean");
		expect(isProps.merge_arrays?.type).toBe("boolean");
		expect(integrationSet!.description).toContain("docs/guides/tools/integration_set.md");
		expect(integrationSet!.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});

		const notionConfigGet = tools.find((t) => t.name === "notion_config_get");
		expect(notionConfigGet, "notion_config_get should be listed").toBeDefined();
		const ncgProps = (notionConfigGet!.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(ncgProps)).toEqual(["provider"]);
		expect(notionConfigGet!.inputSchema.required ?? []).toEqual([]);
		expect(ncgProps.provider?.type).toBe("string");
		expect(ncgProps.provider?.enum).toEqual(["notion_work", "notion_personal"]);
		expect(notionConfigGet!.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
	});

	it("2. Exposure: integration_set, notion_config_get, and config_preferences_update are in action-manifest.json with default exposure", () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(repoRoot, "packages/core/action-manifest.json"), "utf8"),
		);
		for (const id of ["integration_set", "notion_config_get", "config_preferences_update"] as const) {
			expect(manifest.actions[id]?.expose).toEqual({
				mcp: true,
				http: true,
				ui_agent: true,
				worker: true,
				cli: false,
				a2a: false,
			});
		}
	});

	it("3. Registration path: all ids are in buildRegistry and absent from legacy-tools-baseline.txt", () => {
		const registry = buildRegistry(serverAdapters());
		const ids = registry.list().map((a) => a.id);
		expect(ids).toContain("integration_set");
		expect(ids).toContain("notion_config_get");
		expect(ids).toContain("config_preferences_update");

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("integration_set");
		expect(baseline).not.toContain("notion_config_get");
		expect(baseline).not.toContain("config_preferences_update");
	});

	it("4. integration_set validates config against provider schema, merges into existing row, reports key names only, and refuses invalid unknown provider config", async () => {
		let updatedPayload: any;
		const existingRow = {
			config: { tasks_database_id: "secret-db-id", title_property: "Name" },
			enabled: true,
		};
		const b: any = {
			select() {
				return this;
			},
			eq() {
				return this;
			},
			maybeSingle() {
				return Promise.resolve({ data: existingRow, error: null });
			},
			update(this: any, payload: any) {
				updatedPayload = payload;
				this._result = { ...existingRow, ...payload };
				return this;
			},
			single() {
				return Promise.resolve({ data: this._result, error: null });
			},
		};
		(supabase as any).from = vi.fn(() => Object.create(b));

		const handler = toMcpTool(serverRegistry().get("integration_set")!).handler;

		const res = await handler({
			provider: "notion_work",
			config: { state_doc_page_id: "secret-page-id" },
		});
		const text = res.content[0].text;
		expect(updatedPayload.config).toEqual({
			tasks_database_id: "secret-db-id",
			title_property: "Name",
			state_doc_page_id: "secret-page-id",
		});
		expect(text).toContain("Updated integration 'notion_work' (enabled: true).");
		expect(text).toContain("config keys: tasks_database_id, title_property, state_doc_page_id");
		expect(text).not.toContain("secret-db-id");
		expect(text).not.toContain("secret-page-id");

		await expect(
			handler({
				provider: "notion_work",
				config: { tasks_database_id: "" },
			}),
		).rejects.toThrow(/does not match its schema/);

		await expect(
			handler({
				provider: "unknown_custom_provider",
				config: { nested: { invalid: true } },
			}),
		).rejects.toThrow(/Invalid config for unknown provider 'unknown_custom_provider'/);
	});

	it("5. config_preferences_update updates scalar fields, deep-merges dos_config sections, and enforces the #692 pillar removal guard", async () => {
		let updatedPayload: any;
		const existingRow = {
			user_id: "user-1",
			user_mode: "casual",
			automation_level: "balanced",
			global_confidence_threshold: 80,
			show_lifecycle_details: false,
			safe_mode: true,
			has_completed_onboarding: true,
			updated_at: "2026-10-30T00:00:00Z",
			confidence_thresholds: { task_creation: { block: 30, review: 70, auto_apply: 90 } },
			notification_preferences: { review_items: true },
			dos_config: {
				tone: ["Direct"],
				operating_principles: [{ key: "capture-first", description: "Write raw" }],
				by_domain: {
					work: {
						pillars: [
							{ key: "product", label: "Product", description: "Core product", notion_option: "Product" },
							{ key: "growth", label: "Growth", description: "Acquisition", notion_option: "Growth" },
						],
					},
				},
			},
		};
		const b: any = {
			select() {
				return this;
			},
			eq() {
				return this;
			},
			maybeSingle() {
				return Promise.resolve({ data: existingRow, error: null });
			},
			update(this: any, payload: any) {
				updatedPayload = payload;
				this._result = { ...existingRow, ...payload };
				return this;
			},
			single() {
				return Promise.resolve({ data: this._result, error: null });
			},
		};
		(supabase as any).from = vi.fn(() => Object.create(b));

		const action = serverRegistry().get("config_preferences_update")!;
		const handler = toMcpTool(action).handler;

		const input = action.schema.parse({
			user_mode: "power",
			dos_config: {
				tone: { add: ["No fluff"] },
				by_domain: {
					work: {
						pillars: {
							add: [{ key: "ops", label: "Ops", description: "Operations", notion_option: "Ops" }],
						},
					},
				},
			},
		});
		const res = await handler(input);
		const text = res.content[0].text;
		expect(updatedPayload.user_mode).toBe("power");
		expect(updatedPayload.dos_config.tone).toEqual(["Direct", "No fluff"]);
		expect(updatedPayload.dos_config.by_domain.work.pillars).toEqual([
			{ key: "product", label: "Product", description: "Core product", notion_option: "Product" },
			{ key: "growth", label: "Growth", description: "Acquisition", notion_option: "Growth" },
			{ key: "ops", label: "Ops", description: "Operations", notion_option: "Ops" },
		]);
		expect(text).toContain("Updated user_preferences (changed: user_mode, dos_config).");
		expect(text).toContain("dos_config:");

		expect(() =>
			action.schema.parse({
				dos_config: {
					by_domain: {
						work: {
							pillars: {
								add: [{ key: "invalid", name: "Invalid", description: "Missing label" }],
							},
						},
					},
				},
			}),
		).toThrow();

		const removeInput = action.schema.parse({
			dos_config: {
				by_domain: {
					work: {
						pillars: {
							remove: ["growth"],
						},
					},
				},
			},
		});
		await expect(handler(removeInput)).rejects.toThrow(/append-only \(#692\)/);
	});
});
