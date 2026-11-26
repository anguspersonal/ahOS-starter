import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCUMENT_RESOLVE_DESCRIPTION } from "@ahkms/core";
import { buildRegistry } from "@ahkms/core/actions";
import { toMcpTool } from "../actions/adapters/mcp.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { supabase } from "../supabase.js";
import { readLegacyBaseline } from "./legacyBaseline.js";

const require = createRequire(import.meta.url);
const manifest = require("@ahkms/core/action-manifest.json");


const origFrom = supabase.from;
const origRpc = supabase.rpc;

afterEach(() => {
	(supabase as any).from = origFrom;
	(supabase as any).rpc = origRpc;
	vi.restoreAllMocks();
});

describe("document_resolve core action registration & parity (#1622)", () => {
	it("Criterion 1: preserves MCP tool contract (inputSchema keys, annotations, description)", () => {
		const action = serverRegistry().get("document_resolve");
		expect(action).toBeDefined();

		const mcpTool = toMcpTool(action!);
		expect(mcpTool.name).toBe("document_resolve");
		expect(mcpTool.config.description).toBe(DOCUMENT_RESOLVE_DESCRIPTION);
		expect(Object.keys(mcpTool.config.inputSchema)).toEqual([
			"query",
			"entity_id",
			"doc_kind",
			"include_archived",
			"limit",
		]);
		expect(mcpTool.config.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("Criterion 2: exposes document_resolve on mcp, http, ui_agent, worker in action-manifest.json", () => {
		expect(manifest.actions.document_resolve).toBeDefined();
		expect(manifest.actions.document_resolve.expose).toEqual({
			mcp: true,
			http: true,
			cli: false,
			ui_agent: true,
			worker: true,
			a2a: false,
		});
	});

	it("Criterion 3: registers document_resolve in buildRegistry and removes it from legacy-tools-baseline.txt", () => {
		const ids = buildRegistry()
			.list()
			.map((a) => a.id);
		expect(ids).toContain("document_resolve");

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("document_resolve");
	});

	it("Criterion 4: degrades gracefully when entities.aliases column is missing (pre-migration-110)", async () => {
		let attempts = 0;
		(supabase as any).from = vi.fn((table: string) => {
			let selected = "";
			const builder: any = new Proxy(
				{},
				{
					get(_target, prop) {
						if (prop === "select") {
							return (cols: string) => {
								selected = cols;
								return builder;
							};
						}
						if (prop === "then") {
							return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
								if (table === "entities") {
									attempts += 1;
									if (selected.includes("aliases")) {
										return Promise.resolve({
											data: null,
											error: { code: "42703", message: "column entities.aliases does not exist" },
										}).then(res, rej);
									}
									return Promise.resolve({
										data: [
											{
												id: "aaaaaaaa-0000-4000-8000-000000000001",
												title: "CV - Angus Hally",
												archived: false,
												properties: { tracked: true, doc_kind: "cv", aliases: ["CV"] },
											},
										],
										error: null,
									}).then(res, rej);
								}
								return Promise.resolve({ data: [], error: null }).then(res, rej);
							};
						}
						return () => builder;
					},
				},
			);
			return builder;
		});

		const action = serverRegistry().get("document_resolve")!;
		const res = await toMcpTool(action).handler({ query: "CV" });
		expect(attempts).toBe(2);
		expect(res.content[0].text).toContain("## CV - Angus Hally");
	});
});
