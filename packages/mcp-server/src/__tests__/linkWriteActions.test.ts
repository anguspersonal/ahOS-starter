import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildRegistry } from "@ahkms/core/actions";
import { createServer } from "../server.js";
import { supabase } from "../supabase.js";
import { getCurrentUserId } from "../identity.js";
import { readLegacyBaseline } from "./legacyBaseline.js";

const require = createRequire(import.meta.url);
const manifest = require("@ahkms/core/action-manifest.json") as {
	actions: Record<string, { expose: Record<string, boolean> }>;
};

const origFrom = supabase.from;
const origRpc = supabase.rpc;

afterEach(() => {
	(supabase as any).from = origFrom;
	(supabase as any).rpc = origRpc;
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

describe("link_create, link_upsert, and link_delete MCP surface parity (#1474)", () => {
	it("case 1: preserves dev inputSchema properties, required list, types, descriptions, annotations, and MCP output text", async () => {
		const ART_1 = "61d7dc07-313c-4f41-abfe-17b73b4872e7";
		const ENT_1 = "a535fa35-9424-4ef6-8aa5-b5c9f01e2d31";
		const LINK_1 = "11111111-1111-4111-8111-111111111111";

		const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
		let deleteMiss = false;

		(supabase as any).from = vi.fn((table: string) => {
			if (table !== "artifact_entity_links") {
				throw new Error(`Unexpected table: ${table}`);
			}
			return {
				insert: (rows: unknown[]) => ({
					select: async () => ({ data: rows, error: null }),
				}),
				upsert: (rows: unknown[]) => ({
					select: async () => ({ data: rows, error: null }),
				}),
				delete: () => ({
					eq: () => ({
						eq: () => ({
							select: async () => ({
								data: deleteMiss
									? []
									: [{ id: LINK_1, artifact_id: ART_1, entity_id: ENT_1 }],
								error: null,
							}),
						}),
					}),
				}),
			};
		});
		(supabase as any).rpc = vi.fn(async (fn: string, params: Record<string, unknown>) => {
			rpcCalls.push({ fn, params });
			return { data: null, error: null };
		});

		await withMcpClient(async (client) => {
			const { tools } = await client.listTools();
			const linkCreate = tools.find((t) => t.name === "link_create");
			const linkUpsert = tools.find((t) => t.name === "link_upsert");
			const linkDelete = tools.find((t) => t.name === "link_delete");

			expect(linkCreate).toBeDefined();
			expect(linkCreate?.description).toBe("Create one or many artifact-entity links.");
			expect(Object.keys(linkCreate?.inputSchema.properties ?? {})).toEqual(["links"]);
			expect(linkCreate?.inputSchema.required).toEqual(["links"]);
			const createLinksProp = (linkCreate?.inputSchema.properties as Record<string, any>).links;
			expect(createLinksProp.type).toBe("array");
			expect(createLinksProp.items.required).toEqual(["artifact_id", "entity_id"]);
			expect(Object.keys(createLinksProp.items.properties).sort()).toEqual(
				["artifact_id", "confidence_score", "created_by", "entity_id", "link_type", "notes"].sort(),
			);
			expect(createLinksProp.items.properties.artifact_id.type).toBe("string");
			expect(createLinksProp.items.properties.entity_id.type).toBe("string");
			expect(createLinksProp.items.properties.link_type.type).toBe("string");
			expect(createLinksProp.items.properties.confidence_score.type).toBe("number");
			expect(createLinksProp.items.properties.created_by.type).toBe("string");
			expect(createLinksProp.items.properties.notes.type).toBe("string");
			expect(linkCreate?.annotations).toMatchObject({
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			});

			expect(linkUpsert).toBeDefined();
			expect(linkUpsert?.description).toBe(
				"Create or update one or many artifact-entity links using the unique artifact/entity/link_type key. On an existing link, omitted optional fields (confidence_score, created_by, notes) are left unchanged.",
			);
			expect(Object.keys(linkUpsert?.inputSchema.properties ?? {}).sort()).toEqual(
				["links", "mark_artifact_derived"].sort(),
			);
			expect(linkUpsert?.inputSchema.required).toEqual(["links"]);
			const upsertProps = linkUpsert?.inputSchema.properties as Record<string, any>;
			expect(upsertProps.links.type).toBe("array");
			expect(upsertProps.links.items.required).toEqual(["artifact_id", "entity_id"]);
			expect(upsertProps.mark_artifact_derived.type).toBe("boolean");
			expect(linkUpsert?.annotations).toMatchObject({
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			});

			expect(linkDelete).toBeDefined();
			expect(linkDelete?.description).toBe("Delete one artifact-entity link by id.");
			expect(Object.keys(linkDelete?.inputSchema.properties ?? {})).toEqual(["id"]);
			expect(linkDelete?.inputSchema.required).toEqual(["id"]);
			expect((linkDelete?.inputSchema.properties as Record<string, { type?: string }>).id.type).toBe(
				"string",
			);
			expect(linkDelete?.annotations).toMatchObject({
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			});

			const createRes = await client.callTool({
				name: "link_create",
				arguments: { links: [{ artifact_id: ART_1, entity_id: ENT_1 }] },
			});
			expect((createRes.content as Array<{ text: string }>)[0].text).toBe(
				"Created 1 artifact-entity link(s).",
			);

			const upsertRes = await client.callTool({
				name: "link_upsert",
				arguments: {
					links: [{ artifact_id: ART_1, entity_id: ENT_1, link_type: "mentioned" }],
					mark_artifact_derived: true,
				},
			});
			expect((upsertRes.content as Array<{ text: string }>)[0].text).toBe(
				"Upserted 1 artifact-entity link(s).",
			);
			expect(rpcCalls).toEqual([
				{
					fn: "set_artifact_derivation",
					params: {
						p_user_id: getCurrentUserId(),
						p_artifact_id: ART_1,
						p_derivation: {
							status: "completed",
							derived_at: expect.any(String),
							attempts: 1,
							provider: "interactive",
						},
					},
				},
			]);

			const deleteHitRes = await client.callTool({
				name: "link_delete",
				arguments: { id: LINK_1 },
			});
			expect((deleteHitRes.content as Array<{ text: string }>)[0].text).toBe(
				`Deleted artifact-entity link ${LINK_1}.`,
			);

			deleteMiss = true;
			const deleteMissRes = await client.callTool({
				name: "link_delete",
				arguments: { id: LINK_1 },
			});
			expect((deleteMissRes.content as Array<{ text: string }>)[0].text).toBe(
				"No artifact-entity link deleted.",
			);
		});
	});

	it("case 2: exposes link_create, link_upsert, and link_delete in action-manifest.json with default surface flags", () => {
		const actions = manifest.actions;
		for (const id of ["link_create", "link_upsert", "link_delete"]) {
			expect(actions[id]).toBeDefined();
			expect(actions[id].expose).toEqual({
				mcp: true,
				http: true,
				ui_agent: true,
				worker: true,
				cli: false,
				a2a: false,
			});
		}
	});

	it("case 3: registers link_create, link_upsert, and link_delete in buildRegistry and removes them from legacy-tools-baseline.txt", () => {
		const registryIds = buildRegistry({}).list().map((a) => a.id);
		expect(registryIds).toContain("link_create");
		expect(registryIds).toContain("link_upsert");
		expect(registryIds).toContain("link_delete");

		const baselineTools = readLegacyBaseline();
		expect(baselineTools).not.toContain("link_create");
		expect(baselineTools).not.toContain("link_upsert");
		expect(baselineTools).not.toContain("link_delete");
	});
});
