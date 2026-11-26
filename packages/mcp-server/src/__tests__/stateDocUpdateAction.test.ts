import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AdapterUnavailableError, buildRegistry } from "@ahkms/core/actions";
import { createServer } from "../server.js";
import { supabase } from "../supabase.js";
import { stateDocFixture } from "./stateDocFixture.js";
import { readLegacyBaseline } from "./legacyBaseline.js";

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function stubIntegrations(rows: Record<string, Record<string, unknown> | undefined>) {
	(supabase as any).from = vi.fn(() => {
		let provider = "";
		const b: any = {
			select: () => b,
			eq: (column: string, value: string) => {
				if (column === "provider") provider = value;
				return b;
			},
			maybeSingle: () => {
				const config = rows[provider];
				return Promise.resolve(
					config ? { data: { config, enabled: true }, error: null } : { data: null, error: null },
				);
			},
		};
		return b;
	});
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "state-doc-update-action-test", version: "0.0.0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	try {
		return await fn(client);
	} finally {
		await client.close();
		await server.close();
	}
}

describe("state_doc_update action parity (#1478)", () => {
	it("case 1: preserves MCP tool name, input schema properties, annotations, and description", async () => {
		await withClient(async (client) => {
			const { tools } = await client.listTools();
			const tool = tools.find((t) => t.name === "state_doc_update");
			expect(tool).toBeDefined();

			const props = tool!.inputSchema.properties ?? {};
			expect(Object.keys(props)).toEqual([
				"domain",
				"op",
				"heading",
				"new_heading",
				"body",
				"after_heading",
				"before_heading",
				"at_end",
				"heading_level",
			]);
			expect(tool!.inputSchema.required ?? []).toEqual([]);
			expect(tool!.annotations).toMatchObject({
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			});
			expect(tool!.description).toContain("docs/guides/tools/state_doc_update.md");
		});
	});

	it("case 2: exposes default surfaces in packages/core/action-manifest.json", () => {
		const manifestPath = resolve(import.meta.dirname, "../../../core/action-manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		expect(manifest.actions.state_doc_update).toBeDefined();
		expect(manifest.actions.state_doc_update.expose).toEqual({
			mcp: true,
			http: true,
			cli: false,
			ui_agent: true,
			worker: true,
			a2a: false,
		});
	});

	it("case 3: registers in buildRegistry, is absent from legacy-tools-baseline.txt, and throws AdapterUnavailableError when unwired", async () => {
		const registry = buildRegistry({});
		const action = registry.get("state_doc_update");
		expect(action).toBeDefined();

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("state_doc_update");

		await expect(
			action!.run(
				{ domain: "work", op: "delete", heading: "🧱 Tech stack" } as any,
				{ caller: "test", requestId: "req-1" },
			),
		).rejects.toThrow(AdapterUnavailableError);
	});

	it("case 4: returns ADR-053 back-compat refusal without op, refuses duplicate heading insert, and refuses zero/two anchors", async () => {
		stubIntegrations({
			notion_work: { tasks_database_id: "db1", state_doc_page_id: "sdp-1" },
		});
		const page = stateDocFixture();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({ results: page, has_more: false, next_cursor: null }),
				text: async () => JSON.stringify({ results: page, has_more: false, next_cursor: null }),
			})),
		);

		await withClient(async (client) => {
			const noOp = await client.callTool({
				name: "state_doc_update",
				arguments: { heading: "EOD 2026-06-10", body: "x" },
			});
			expect(noOp.isError).toBe(true);
			expect((noOp.content as Array<{ text: string }>)[0].text).toMatch(
				/`op` is required \u2014 one of replace \| rename \| insert \| delete/,
			);

			const dupHeading = await client.callTool({
				name: "state_doc_update",
				arguments: {
					domain: "work",
					op: "insert",
					new_heading: "🧱 Tech stack",
					body: "x",
					at_end: true,
				},
			});
			expect(dupHeading.isError).toBe(true);
			expect((dupHeading.content as Array<{ text: string }>)[0].text).toMatch(/already a heading/);

			const zeroAnchors = await client.callTool({
				name: "state_doc_update",
				arguments: {
					domain: "work",
					op: "insert",
					new_heading: "🧪 Experiments",
					body: "x",
				},
			});
			expect(zeroAnchors.isError).toBe(true);
			expect((zeroAnchors.content as Array<{ text: string }>)[0].text).toMatch(
				/exactly one anchor/,
			);

			const twoAnchors = await client.callTool({
				name: "state_doc_update",
				arguments: {
					domain: "work",
					op: "insert",
					new_heading: "🧪 Experiments",
					body: "x",
					at_end: true,
					before_heading: "📌 Open Actions",
				},
			});
			expect(twoAnchors.isError).toBe(true);
			expect((twoAnchors.content as Array<{ text: string }>)[0].text).toMatch(/exactly one anchor/);
		});
	});

	it("case 5: notion_block_delete still refuses State Doc blocks", async () => {
		const stateDocId = "aaaabbbb-cccc-dddd-eeee-ffff00001111";
		const blockId = "11112222-3333-4444-5555-666677778888";
		stubIntegrations({
			notion_work: {
				tasks_database_id: "db1",
				state_doc_page_id: stateDocId,
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({
					id: blockId,
					type: "paragraph",
					parent: { type: "page_id", page_id: stateDocId },
				}),
				text: async () =>
					JSON.stringify({
						id: blockId,
						type: "paragraph",
						parent: { type: "page_id", page_id: stateDocId },
					}),
			})),
		);

		await withClient(async (client) => {
			const res = await client.callTool({
				name: "notion_block_delete",
				arguments: { domain: "work", block_id: blockId },
			});
			expect(res.isError).toBe(true);
			expect((res.content as Array<{ text: string }>)[0].text).toMatch(/state_doc_update/);
		});
	});
});
