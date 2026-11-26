/**
 * Migration acceptance test: entity single-ops twins served from registry (#1565).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
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

const FIVE_IDS = [
	"entity_get",
	"entity_query",
	"entity_create",
	"entity_upsert",
	"entity_update",
] as const;

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

function createMockSupabase(entityData: any = null) {
	return vi.fn((table: string) => {
		if (table === "entities") {
			const builder: any = {
				_updating: false,
				select: vi.fn(() => {
					if (builder._updating) {
						return Promise.resolve({
							data: Array.isArray(entityData) ? entityData : entityData ? [entityData] : [],
							error: null,
						});
					}
					return builder;
				}),
				insert: vi.fn(() => {
					builder._updating = true;
					return builder;
				}),
				update: vi.fn(() => {
					builder._updating = true;
					return builder;
				}),
				upsert: vi.fn(() => {
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
				lt: vi.fn(() => builder),
				contains: vi.fn(() => builder),
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

async function listTools() {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools;
}

describe("entity twins migration (#1565)", () => {
	it("Case 1: Registry - each id is a manifest key with mcp exposure and none is in legacy baseline", () => {
		const manifestPath = resolve(repoRoot, "packages/core/action-manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

		const legacyBaseline = readLegacyBaseline();
		const legacySet = new Set(legacyBaseline);

		for (const id of FIVE_IDS) {
			const action = manifest.actions[id];
			expect(action, `${id} should exist in manifest`).toBeDefined();
			expect(action.expose.mcp, `${id} should have expose.mcp === true`).toBe(true);
			expect(legacySet.has(id), `${id} should not be in legacy-tools-baseline.txt`).toBe(false);
		}
	});

	it("Case 2: Contract - tool descriptions, annotations and schemas match contract", async () => {
		const tools = await listTools();
		const toolMap = new Map(tools.map((t) => [t.name, t]));

		// Verify all 5 are advertised
		for (const id of FIVE_IDS) {
			expect(toolMap.has(id), `${id} should be advertised`).toBe(true);
		}

		// entity_get
		const entityGet = toolMap.get("entity_get")!;
		expect(entityGet.description).toBe(
			"Read a single entity row by id, including its full properties JSON. entity_update replaces properties wholesale, so read here first and write the merged whole.",
		);
		expect(entityGet.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(Object.keys(entityGet.inputSchema.properties ?? {}).sort()).toEqual(["id"].sort());

		// entity_query
		const entityQuery = toolMap.get("entity_query")!;
		expect(entityQuery.description).toBe(
			"Read entity rows from the entities table with filtering across type, ids, team/user scope, archived state, and a broad text query. Pass include_properties to also print each row's properties JSON.",
		);
		expect(entityQuery.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});

		// entity_create
		const entityCreate = toolMap.get("entity_create")!;
		expect(entityCreate.description).toBe("Create one or many entities.");
		expect(entityCreate.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		});

		// entity_upsert
		const entityUpsert = toolMap.get("entity_upsert")!;
		expect(entityUpsert.description).toBe(
			"Create or update one or many entities. If id is supplied, updates that row; otherwise creates a new row.",
		);
		expect(entityUpsert.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});

		// entity_update
		const entityUpdate = toolMap.get("entity_update")!;
		expect(entityUpdate.description).toBe("Update one or many entities by ids or filter criteria.");
		expect(entityUpdate.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("Case 3: Output - mocked Supabase returns expected text for each tool", async () => {
		const row = mockEntityRow("11111111-1111-4111-8111-111111111111", "Knowledge Base");
		(supabase as any).from = createMockSupabase(row);

		const server = createServer();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		// entity_get
		const getResult = await client.callTool({
			name: "entity_get",
			arguments: { id: "11111111-1111-4111-8111-111111111111" },
		});
		expect(getResult.content).toBeDefined();
		expect((getResult.content as any)[0].text).toContain("Knowledge Base");
		expect((getResult.content as any)[0].text).toContain("properties: {\"key\":\"value\"}");

		// entity_query
		const queryResult = await client.callTool({
			name: "entity_query",
			arguments: { query: "Knowledge" },
		});
		expect(queryResult.content).toBeDefined();
		expect((queryResult.content as any)[0].text).toContain("Knowledge Base");

		// entity_create
		const createResult = await client.callTool({
			name: "entity_create",
			arguments: { entities: [{ entity_type: "concept", title: "Knowledge Base" }] },
		});
		expect(createResult.content).toBeDefined();
		expect((createResult.content as any)[0].text).toContain("Created 1 entities");

		// entity_upsert
		const upsertResult = await client.callTool({
			name: "entity_upsert",
			arguments: { entities: [{ entity_type: "concept", title: "Knowledge Base" }] },
		});
		expect(upsertResult.content).toBeDefined();
		expect((upsertResult.content as any)[0].text).toContain("Upserted 1 entities");

		// entity_update
		const updateResult = await client.callTool({
			name: "entity_update",
			arguments: { ids: ["11111111-1111-4111-8111-111111111111"], patch: { title: "Knowledge Base Updated" } },
		});
		expect(updateResult.content).toBeDefined();
		expect((updateResult.content as any)[0].text).toContain("Updated 1 entities");

		await client.close();
	});

	it("Case 4: HTTP - POST /api/actions/entity_get reaches action with owner token", async () => {
		const row = mockEntityRow("11111111-1111-4111-8111-111111111111", "Knowledge Base");
		(supabase as any).from = createMockSupabase(row);

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

		// Valid request reaches action
		const res = await request(app)
			.post("/api/actions/entity_get")
			.set("Authorization", "Bearer valid-token")
			.send({ id: "11111111-1111-4111-8111-111111111111" });

		expect(res.status).toBe(200);
		expect(res.body.found).toBe(true);
		expect(res.body.entity.title).toBe("Knowledge Base");

		// Invalid schema rejected with 400
		const badRes = await request(app)
			.post("/api/actions/entity_get")
			.set("Authorization", "Bearer valid-token")
			.send({});

		expect(badRes.status).toBe(400);
	});
});
