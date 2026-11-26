import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { serverRegistry } from "../actions/serverRegistry.js";
import { toMcpTool } from "../actions/index.js";
import { readLegacyBaseline } from "./legacyBaseline.js";

const require = createRequire(import.meta.url);
const manifest = require("@ahkms/core/action-manifest.json") as {
	actions: Record<
		string,
		{
			description: string;
			domain: string | null;
			annotations: {
				readOnlyHint: boolean;
				destructiveHint: boolean;
				idempotentHint: boolean;
				openWorldHint: boolean;
			};
			expose: {
				mcp: boolean;
				http: boolean;
				ui_agent: boolean;
				worker: boolean;
				cli: boolean;
				a2a: boolean;
			};
			input_schema: {
				properties?: Record<string, { type?: string }>;
				required?: string[];
			};
		}
	>;
};


describe("artifact_sync_entities MCP action registration (#1477)", () => {
	it("preserves contract parity (schema keys, required list, description, annotations)", () => {
		const action = serverRegistry().get("artifact_sync_entities");
		expect(action).toBeDefined();

		const tool = toMcpTool(action!);
		expect(tool.name).toBe("artifact_sync_entities");
		expect(tool.config.description).toBe(
			"Resolve extracted entities against the entities table, create missing rows, and link all resolved entities back to the artifact in one idempotent pass.",
		);
		expect(tool.config.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});

		const entry = manifest.actions.artifact_sync_entities;
		expect(entry).toBeDefined();
		expect(Object.keys(entry.input_schema.properties ?? {}).sort()).toEqual([
			"artifact_id",
			"created_by",
			"entities",
			"link_type",
		]);
		expect(entry.input_schema.required?.slice().sort()).toEqual(["artifact_id", "entities"]);
		expect(entry.input_schema.properties?.artifact_id?.type).toBe("string");
		expect(entry.input_schema.properties?.entities?.type).toBe("array");
		expect(entry.input_schema.properties?.link_type?.type).toBe("string");
		expect(entry.input_schema.properties?.created_by?.type).toBe("string");
	});

	it("has default exposure in action-manifest.json and is absent from legacy-tools-baseline.txt", () => {
		const entry = manifest.actions.artifact_sync_entities;
		expect(entry?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("artifact_sync_entities");
	});
});
