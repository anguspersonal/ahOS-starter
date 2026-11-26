import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { executeAction } from "../adapters/direct.js";
import { buildRegistry } from "../buildRegistry.js";
import type { ActionManifest } from "../manifest.js";
import { createGraphFilterAction, graphFilterAction } from "./graphFilter.js";
import { createViewScreenAction, viewScreenAction } from "./viewScreen.js";
import {
	graphFilterInputSchema,
	viewScreenInputSchema,
} from "../../domain/uiActions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(__dirname, "../../../action-manifest.json");

describe("client_local UI actions in core (#1557, ADR-105)", () => {
	it("lists graph_filter and view_screen in action-manifest.json with only ui_agent on and reason client_local", () => {
		const raw = fs.readFileSync(manifestPath, "utf8");
		const manifest = JSON.parse(raw) as ActionManifest;

		for (const id of ["graph_filter", "view_screen"] as const) {
			const entry = manifest.actions[id];
			expect(entry, `missing manifest entry for ${id}`).toBeDefined();
			expect(entry.expose).toMatchObject({
				mcp: false,
				http: false,
				ui_agent: true,
				worker: false,
				cli: false,
				a2a: false,
				reason: "client_local",
			});
			expect(typeof entry.expose.note).toBe("string");
			expect(entry.expose.note!.length).toBeGreaterThan(0);
		}
	});

	it("rejects executeAction in core with 'client_local action runs in the browser'", async () => {
		const registry = buildRegistry({});

		const graphFilter = registry.get("graph_filter");
		expect(graphFilter).toBeDefined();
		await expect(
			executeAction(graphFilter!, { query: "test" }),
		).rejects.toThrow("client_local action runs in the browser");
		await expect(
			executeAction(createGraphFilterAction(), { reset: true }),
		).rejects.toThrow("client_local action runs in the browser");
		await expect(
			executeAction(graphFilterAction, {}),
		).rejects.toThrow("client_local action runs in the browser");

		const viewScreen = registry.get("view_screen");
		expect(viewScreen).toBeDefined();
		await expect(
			executeAction(viewScreen!, { include_record: true }),
		).rejects.toThrow("client_local action runs in the browser");
		await expect(
			executeAction(createViewScreenAction(), {}),
		).rejects.toThrow("client_local action runs in the browser");
		await expect(
			executeAction(viewScreenAction, {}),
		).rejects.toThrow("client_local action runs in the browser");
	});

	it("validates schemas for graph_filter and view_screen strictly", () => {
		expect(
			graphFilterInputSchema.parse({
				query: "ahos",
				entity_types: ["project", "concept"],
				hierarchy_level: 2,
				detail_strategy: "clusters",
				scope_tier: "core",
			}),
		).toEqual({
			query: "ahos",
			entity_types: ["project", "concept"],
			hierarchy_level: 2,
			detail_strategy: "clusters",
			scope_tier: "core",
		});

		expect(() =>
			graphFilterInputSchema.parse({ unknown_key: true }),
		).toThrow();

		expect(viewScreenInputSchema.parse({ include_record: false })).toEqual({
			include_record: false,
		});
		expect(() =>
			viewScreenInputSchema.parse({ extra_field: 123 }),
		).toThrow();
	});
});
