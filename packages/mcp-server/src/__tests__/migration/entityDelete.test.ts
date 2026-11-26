/**
 * Migration acceptance test: entity_delete served from registry with widened schema (#1566).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../server.js";
import { actionsRouter } from "../../actions/actionsRouter.js";
import { serverRegistry } from "../../actions/serverRegistry.js";
import { supabase } from "../../supabase.js";
import { readLegacyBaseline } from "../legacyBaseline.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../../../../../");

const EXPECTED_PROPERTIES = ["archive_only", "dry_run", "filter", "ids"].sort();

const origFrom = supabase.from;

afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

const mockEntityRow = (id: string, title: string, entityType = "concept") => ({
	id,
	entity_type: entityType,
	title,
	description: `Description for ${title}`,
	archived: false,
	archived_at: null,
	properties: { key: "value" },
	tags: ["tag1"],
	source_url: null,
	local_name: "test_local",
	namespace: null,
	user_id: "test-user-id",
	team_id: null,
	created_at: new Date().toISOString(),
	updated_at: new Date().toISOString(),
});

function createMockSupabase(entityData: any = null, mutatedData: any = null) {
	return vi.fn((table: string) => {
		if (table === "entities") {
			const builder: any = {
				_updating: false,
				select: vi.fn(() => {
					if (builder._updating) {
						const data = mutatedData ?? (Array.isArray(entityData) ? entityData : entityData ? [entityData] : []);
						return Promise.resolve({ data, error: null });
					}
					return builder;
				}),
				update: vi.fn(() => {
					builder._updating = true;
					return builder;
				}),
				delete: vi.fn(() => {
					builder._updating = true;
					return builder;
				}),
				eq: vi.fn(() => builder),
				in: vi.fn(() => builder),
				is: vi.fn(() => builder),
				order: vi.fn(() => builder),
				limit: vi.fn(() =>
					Promise.resolve({
						data: Array.isArray(entityData) ? entityData : entityData ? [entityData] : [],
						error: null,
					}),
				),
				maybeSingle: vi.fn(() => Promise.resolve({ data: entityData, error: null })),
			};
			return builder;
		}
		const chainable: any = {
			select: vi.fn(() => chainable),
			update: vi.fn(() => chainable),
			delete: vi.fn(() => chainable),
			eq: vi.fn(() => chainable),
			in: vi.fn(() => chainable),
			is: vi.fn(() => chainable),
			order: vi.fn(() => chainable),
			limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
			maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
			then: (onfulfilled: any) => Promise.resolve({ data: [], error: null }).then(onfulfilled),
		};
		return chainable;
	});
}

describe("entity_delete migration acceptance (#1566)", () => {
	it("Case 1: One contract — inputSchema properties keys equal sorted keys of action schema", async () => {
		const action = serverRegistry().get("entity_delete");
		expect(action).toBeDefined();

		const actionKeys = Object.keys((action!.schema as any).shape).sort();
		expect(actionKeys).toEqual(EXPECTED_PROPERTIES);

		const { server } = createServer();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		const client = new Client({ name: "test-client", version: "1.0.0" });
		await client.connect(clientTransport);

		const toolsList = await client.listTools();
		const tool = toolsList.tools.find((t) => t.name === "entity_delete");
		expect(tool).toBeDefined();
		expect(tool?.description).toBe(
			"Delete or archive one or many entities by ids or filter criteria. Parks for the owner's approval when archive_only is false and more than 50 rows match.",
		);
		expect(tool?.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		});

		const toolKeys = Object.keys(tool?.inputSchema?.properties ?? {}).sort();
		expect(toolKeys).toEqual(EXPECTED_PROPERTIES);
		expect(toolKeys).toEqual(actionKeys);

		await client.close();
		await server.close();
	});

	it("Case 2: Routing parity — single id routes to single delete, multiple/filter/dry_run route to bulk", async () => {
		const { server } = createServer();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		const client = new Client({ name: "test-client", version: "1.0.0" });
		await client.connect(clientTransport);

		const id1 = "11111111-1111-4111-8111-111111111111";
		const id2 = "22222222-2222-4222-8222-222222222222";
		const row1 = mockEntityRow(id1, "Entity 1");
		const row2 = mockEntityRow(id2, "Entity 2");

		// Branch A: Single id -> archives 1 entity and returns single-delete formatted text
		(supabase as any).from = createMockSupabase([row1], [{ id: id1, title: "Entity 1" }]);
		const resSingle = await client.callTool({
			name: "entity_delete",
			arguments: { ids: [id1], archive_only: true },
		});
		expect(resSingle.isError).toBeFalsy();
		const textSingle = ((resSingle as any).content[0] as any).text;
		expect(textSingle).toBe(`Archived 1 entities: [${id1}] Entity 1`);

		// Branch B: Multiple ids -> routes to bulk delete
		(supabase as any).from = createMockSupabase([row1, row2], [{ id: id1, title: "Entity 1" }, { id: id2, title: "Entity 2" }]);
		const resMultiple = await client.callTool({
			name: "entity_delete",
			arguments: { ids: [id1, id2], archive_only: true },
		});
		expect(resMultiple.isError).toBeFalsy();
		const textMultiple = ((resMultiple as any).content[0] as any).text;
		expect(textMultiple).toBe(`Archived 2 entities: [${id1}] Entity 1, [${id2}] Entity 2`);

		// Branch C: dry_run: true -> routes to bulk preview
		(supabase as any).from = createMockSupabase([row1]);
		const resDryRun = await client.callTool({
			name: "entity_delete",
			arguments: { ids: [id1], dry_run: true },
		});
		expect(resDryRun.isError).toBeFalsy();
		const textDryRun = ((resDryRun as any).content[0] as any).text;
		expect(textDryRun).toBe(`[Dry Run] Would archive 1 entities. Preview sample: [${id1}] Entity 1`);

		// Branch D: filter -> routes to bulk delete
		(supabase as any).from = createMockSupabase([row1], [{ id: id1, title: "Entity 1" }]);
		const resFilter = await client.callTool({
			name: "entity_delete",
			arguments: { filter: { entity_type: "concept" }, archive_only: true },
		});
		expect(resFilter.isError).toBeFalsy();
		const textFilter = ((resFilter as any).content[0] as any).text;
		expect(textFilter).toBe(`Archived 1 entities: [${id1}] Entity 1`);

		await client.close();
		await server.close();
	});

	it("Case 3: Registry check — entity_delete is exposed in manifest and removed from legacy baseline", () => {
		const manifestRaw = readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf8");
		const manifest = JSON.parse(manifestRaw);

		expect(manifest.actions.entity_delete).toBeDefined();
		expect(manifest.actions.entity_delete.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});

		const legacyLines = readLegacyBaseline();
		expect(legacyLines).not.toContain("entity_delete");
	});

	it("Case 4: HTTP check — POST /api/actions/entity_delete routes with owner token and rejects invalid input", async () => {
		const id1 = "11111111-1111-4111-8111-111111111111";
		(supabase as any).from = createMockSupabase([mockEntityRow(id1, "HTTP Entity")], [{ id: id1, title: "HTTP Entity" }]);

		const stubSupabase = {
			auth: {
				getUser: vi.fn(async (token: string) => {
					if (token === "valid-token") {
						return { data: { user: { id: "user-123", email: "owner@example.com" } }, error: null };
					}
					return { data: { user: null }, error: new Error("Invalid token") };
				}),
			},
		};

		const app = express();
		app.use(express.json());
		app.use(
			"/api/actions",
			actionsRouter({
				supabaseClient: stubSupabase as any,
				ownerUserId: "user-123",
				registry: serverRegistry(),
			}),
		);

		// Valid request with ids (and a stray confirm: true ignored by zod strip)
		const resValid = await request(app)
			.post("/api/actions/entity_delete")
			.set("Authorization", "Bearer valid-token")
			.send({ ids: [id1], confirm: true });

		expect(resValid.status).toBe(200);
		expect(resValid.body.success).toBe(true);
		expect(resValid.body.count).toBe(1);

		// Invalid request with non-UUID id
		const resInvalid = await request(app)
			.post("/api/actions/entity_delete")
			.set("Authorization", "Bearer valid-token")
			.send({ ids: ["invalid-uuid"] });

		expect(resInvalid.status).toBe(400);
	});
});
