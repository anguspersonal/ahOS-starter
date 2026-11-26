import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	buildCanonicalInstructions,
	DEFAULT_DOS_CONFIG,
	getCanonicalInstructionsHash,
	getInstructionsSchema,
	markInstructionsPastedSchema,
} from "@ahkms/core";
import { buildRegistry } from "@ahkms/core/actions";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { makeRegistrar, registerAllTools } from "../server.js";
import { readLegacyBaseline } from "./legacyBaseline.js";

const mcpServerSpy = vi.hoisted(() => ({ count: 0 }));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@modelcontextprotocol/sdk/server/mcp.js")>();
	class TrackedMcpServer extends actual.McpServer {
		constructor(...args: ConstructorParameters<typeof actual.McpServer>) {
			super(...args);
			mcpServerSpy.count += 1;
		}
	}
	return {
		...actual,
		McpServer: TrackedMcpServer,
	};
});

const require = createRequire(import.meta.url);
const manifest = require("@ahkms/core/action-manifest.json") as {
	actions: Record<string, any>;
};


describe("instructions_get & instructions_mark_pasted core actions (#1601)", () => {
	it("case 1: contract parity with pre-migration schemas, descriptions, and annotations", () => {
		const registry = buildRegistry({});

		const getAction = registry.get("instructions_get");
		expect(getAction).toBeDefined();
		expect(getAction!.description).toBe(
			"Fetch the canonical system instructions block (system-instructions) and its staleness / drift status. Copy the returned text into your client system instructions, then run instructions_mark_pasted.",
		);
		expect(getAction!.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(
			z.toJSONSchema(getAction!.schema, { target: "openapi-3.0", io: "input" }),
		).toEqual(z.toJSONSchema(getInstructionsSchema, { target: "openapi-3.0", io: "input" }));

		const markAction = registry.get("instructions_mark_pasted");
		expect(markAction).toBeDefined();
		expect(markAction!.description).toBe(
			"Record that the canonical system instructions block (system-instructions) was pasted into a non-MCP client surface. Saves the pasted sha256 and timestamp in user_preferences under system_instructions_sync. Defaults to the current canonical hash and now.",
		);
		expect(markAction!.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(
			z.toJSONSchema(markAction!.schema, { target: "openapi-3.0", io: "input" }),
		).toEqual(
			z.toJSONSchema(markInstructionsPastedSchema, { target: "openapi-3.0", io: "input" }),
		);
	});

	it("case 2: manifest entries have default-on expose flags and empty former_ids", () => {
		for (const id of ["instructions_get", "instructions_mark_pasted"]) {
			const entry = manifest.actions[id];
			expect(entry).toBeDefined();
			expect(entry.expose).toEqual({
				mcp: true,
				http: true,
				ui_agent: true,
				worker: true,
				cli: false,
				a2a: false,
			});
			expect(entry.former_ids).toEqual([]);
		}
	});

	it("case 3: registered via registerAction (not legacy register) and absent from legacy-tools-baseline.txt", () => {
		const sdkHandlers = new Map<string, (...args: any[]) => any>();
		const stub = {
			registerTool: vi.fn((name: string, _config: unknown, handler: (...args: any[]) => any) => {
				sdkHandlers.set(name, handler);
				return {};
			}),
		} as any;

		const registered = registerAllTools(stub);
		for (const id of ["instructions_get", "instructions_mark_pasted"]) {
			const entry = registered.get(id);
			expect(entry).toBeDefined();
			expect(sdkHandlers.get(id)).toBe(entry!.handler);
		}

		const baselineLines = readLegacyBaseline();
		expect(baselineLines).not.toContain("instructions_get");
		expect(baselineLines).not.toContain("instructions_mark_pasted");

		expect(typeof makeRegistrar).toBe("function");
		expect(serverRegistry().has("instructions_get")).toBe(true);
		expect(serverRegistry().has("instructions_mark_pasted")).toBe(true);
	});

	it("case 4: canonical hash equality over a fixed fixture catalog", async () => {
		const fixtureCatalog = [
			{ name: "capture", description: "Dump a note into the knowledge store." },
			{ name: "knowledge_search", description: "Search the knowledge store." },
		];
		const expectedText = buildCanonicalInstructions(fixtureCatalog, [], DEFAULT_DOS_CONFIG);
		const expectedHash = getCanonicalInstructionsHash(fixtureCatalog, [], DEFAULT_DOS_CONFIG);

		const registry = buildRegistry({
			instructions: {
				toolCatalog: () => fixtureCatalog,
				loadDosConfig: async () => DEFAULT_DOS_CONFIG,
				loadPastedInstructions: async () => null,
			},
		});
		const tool = toMcpTool(registry.get("instructions_get")!);
		const result = await tool.handler({}, {} as any);
		const text = result.content[0]?.text ?? "";

		expect(text).toContain(`Canonical sha256: ${expectedHash}`);
		expect(text).toContain(expectedText);
	});

	it("case 5: invoking instructions_get records 0 McpServer constructions", async () => {
		mcpServerSpy.count = 0;

		const registry = buildRegistry({
			instructions: {
				loadDosConfig: async () => DEFAULT_DOS_CONFIG,
				loadPastedInstructions: async () => null,
			},
		});
		const tool = toMcpTool(registry.get("instructions_get")!);
		const res = await tool.handler({}, {} as any);

		expect(res.content[0]?.text).toContain("# Canonical System Instructions");
		expect(mcpServerSpy.count).toBe(0);
	});
});
