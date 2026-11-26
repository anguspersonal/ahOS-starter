import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildRegistry } from "@ahkms/core/actions";
import { createServer } from "../server.js";
import { supabase } from "../supabase.js";
import { readLegacyBaseline } from "./legacyBaseline.js";

const require = createRequire(import.meta.url);
const manifest = require("@ahkms/core/action-manifest.json");


const FROM_ID = "11111111-1111-4111-8111-111111111111";
const TO_ID = "22222222-2222-4222-8222-222222222222";

const origFrom = supabase.from;

afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
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

describe("entity_relate core action registration & parity (#1484)", () => {
	it("Criterion 1: preserves MCP tool contract (schema, description, annotations, and output formatting)", async () => {
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "entities") {
				return {
					select: () => ({
						eq: () => ({
							in: () =>
								Promise.resolve({
									data: [
										{ id: FROM_ID, entity_type: "person" },
										{ id: TO_ID, entity_type: "person" },
									],
									error: null,
								}),
						}),
					}),
				};
			}
			return {
				select: () => {
					const b: any = {
						eq: () => b,
						limit: () => b,
						maybeSingle: () => Promise.resolve({ data: null, error: null }),
					};
					return b;
				},
				insert: () => ({
					select: () => ({
						single: () => Promise.resolve({ data: { id: "edge-mcp-1" }, error: null }),
					}),
				}),
			};
		});

		await withMcpClient(async (client) => {
			const { tools } = await client.listTools();
			const tool = tools.find((t) => t.name === "entity_relate");
			expect(tool).toBeDefined();
			expect(tool!.description).toBe(
				"Create or update one entity-to-entity edge in the knowledge graph. Both endpoints must already exist \u2014 use entity_upsert or person_upsert first. Deduplicates on (from, to, relationship_type), so re-running is safe. Prefer the canonical ADR-021 relationship vocabulary. Full notes: docs/guides/tools/entity_relate.md",
			);
			expect(tool!.annotations).toEqual({
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			});

			const props = (tool!.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
			expect(Object.keys(props)).toEqual([
				"from_entity_id",
				"to_entity_id",
				"relationship_type",
				"confidence",
				"metadata",
				"notes",
				"valid_from",
				"valid_to",
				"clear_window",
				"archive",
				"overwrite",
				"supersedes_relationship_id",
				"relationships",
			]);
			expect(tool!.inputSchema.required).toBeUndefined();
			expect(props.from_entity_id.type).toBe("string");
			expect(props.confidence.type).toBe("number");
			expect(props.metadata.type).toBe("object");
			expect(props.clear_window.type).toBe("boolean");
			expect(props.relationships.type).toBe("array");

			const callRes = await client.callTool({
				name: "entity_relate",
				arguments: {
					from_entity_id: FROM_ID,
					to_entity_id: TO_ID,
					relationship_type: "sister",
				},
			});
			const content = callRes.content as Array<{ type: string; text: string }>;
			expect(content[0].text).toBe(
				`Created edge edge-mcp-1: ${FROM_ID} -[siblingOf]-> ${TO_ID}. (normalised from "sister")`,
			);
		});
	});

	it("Criterion 2: exposes entity_relate on mcp, http, ui_agent, worker in action-manifest.json", () => {
		expect(manifest.actions.entity_relate).toBeDefined();
		expect(manifest.actions.entity_relate.expose).toEqual({
			mcp: true,
			http: true,
			cli: false,
			ui_agent: true,
			worker: true,
			a2a: false,
		});
	});

	it("Criterion 3: registers entity_relate in buildRegistry and removes it from legacy-tools-baseline.txt", () => {
		const ids = buildRegistry()
			.list()
			.map((a) => a.id);
		expect(ids).toContain("entity_relate");

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("entity_relate");
	});
});
