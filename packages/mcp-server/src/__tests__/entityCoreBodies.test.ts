import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import request from "supertest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildRegistry,
	createCoreEntitiesPort,
	executeAction,
	formatEntitiesCreateMcp,
	formatEntitiesCrudMcp,
	formatEntitiesDeleteMcp,
	formatEntitiesGetMcp,
	formatEntitiesQueryMcp,
	formatEntitiesUpdateMcp,
	formatEntitiesUpsertMcp,
	PendingApprovalError,
	setActionApprovalStore,
	setDefaultAuditSink,
	stderrAuditSink,
	type ApprovalRequest,
} from "@ahkms/core/actions";
import type {
	EmbeddingPort,
	EntityInsertInput,
	EntityPatchInput,
	EntityRepository,
	EntityRow,
} from "@ahkms/core";
import { actionsRouter } from "../actions/actionsRouter.js";
import { serverAdapters } from "../actions/serverRegistry.js";
import { createServer } from "../server.js";
import { supabase } from "../supabase.js";

const origFrom = supabase.from;
const makeId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const makeIds = (n: number) => Array.from({ length: n }, (_, i) => makeId(i + 1));

const makeRow = (id: string, title: string, entityType = "concept"): EntityRow => ({
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
	user_id: "user-123",
	team_id: null,
	domain_override: null,
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
});

function createFakeEntitiesBackend(seed: EntityRow[] = []) {
	const store = new Map<string, EntityRow>(seed.map((r) => [r.id, { ...r }]));
	let seq = seed.length + 100;
	const repo: EntityRepository = {
		getById: vi.fn(async (id) => store.get(id) ?? null),
		loadRows: vi.fn(async (filter) => {
			let rows = [...store.values()];
			if (!filter.include_archived) rows = rows.filter((r) => !r.archived);
			if (filter.entity_type) rows = rows.filter((r) => r.entity_type === filter.entity_type);
			if (filter.ids?.length) {
				const set = new Set(filter.ids);
				rows = rows.filter((r) => set.has(r.id));
			}
			const limit = filter.limit ?? 20;
			return { rows: rows.slice(0, limit), truncated: false };
		}),
		insert: vi.fn(async (items: readonly EntityInsertInput[]) =>
			items.map((item) => {
				const id = makeId(++seq);
				const row: EntityRow = {
					id,
					entity_type: item.entity_type ?? "concept",
					title: item.title ?? null,
					description: item.description ?? null,
					archived: false,
					archived_at: null,
					properties: item.properties ?? {},
					tags: item.tags ?? [],
					source_url: item.source_url ?? null,
					user_id: "user-123",
					team_id: null,
					domain_override: item.domain_override ?? null,
					created_at: "2026-01-01T00:00:00Z",
					updated_at: "2026-01-01T00:00:00Z",
				};
				store.set(id, row);
				return row;
			}),
		),
		update: vi.fn(async (ids: string | readonly string[], patch: EntityPatchInput) => {
			const list = typeof ids === "string" ? [ids] : [...ids];
			return list.flatMap((id) => {
				const cur = store.get(id);
				if (!cur) return [];
				const next: EntityRow = {
					...cur,
					...(patch.title !== undefined ? { title: patch.title } : {}),
					...(patch.description !== undefined ? { description: patch.description } : {}),
				};
				store.set(id, next);
				return [next];
			});
		}),
		mutateByIds: vi.fn(async (ids, archiveOnly) => {
			const out: Array<{ id: string; title: string | null }> = [];
			for (const id of ids) {
				const cur = store.get(id);
				if (!cur) continue;
				out.push({ id: cur.id, title: cur.title });
				if (archiveOnly) {
					store.set(id, { ...cur, archived: true });
				} else {
					store.delete(id);
				}
			}
			return out;
		}),
		getDomainRow: vi.fn(async (id) => {
			const cur = store.get(id);
			return cur
				? {
						id: cur.id,
						title: cur.title,
						description: cur.description,
						tags: cur.tags,
						properties: cur.properties,
						domain_override: (cur.domain_override as string | null) ?? null,
					}
				: null;
		}),
		fetchPrimaryParentId: vi.fn(async () => null),
		fetchPrimaryParentsBatch: vi.fn(async () => new Map()),
		getEdgeById: vi.fn(async () => null),
		findOwnedEntityIds: vi.fn(async () => new Set<string>()),
		insertArrangementNodes: vi.fn(async () => {}),
		insertParticipantEdges: vi.fn(async () => {}),
		insertProvenanceLinks: vi.fn(async () => {}),
		archiveEdge: vi.fn(async () => {}),
		findTrackedResources: vi.fn(async () => []),
		getTitleById: vi.fn(async () => null),
	};
	const embedding: EmbeddingPort = {
		embed: vi.fn(async () => [0.1, 0.2]),
		embedBatch: vi.fn(async (texts) => texts.map(() => [0.1, 0.2])),
	};
	const port = createCoreEntitiesPort({ repo, embedding });
	const registry = buildRegistry({ ...serverAdapters(), entities: port });
	return { store, repo, embedding, port, registry };
}

async function connectClient(registry: ReturnType<typeof buildRegistry>) {
	const server = createServer([], [], registry);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

const textOf = (res: Awaited<ReturnType<Client["callTool"]>>) =>
	((res.content as Array<{ type: string; text: string }>)[0]?.text ?? "");

describe("entity core bodies over createServer() and /api/actions (#1623)", () => {
	beforeEach(() => {
		setDefaultAuditSink(() => {});
	});

	afterEach(() => {
		(supabase as any).from = origFrom;
		setActionApprovalStore(undefined);
		setDefaultAuditSink(stderrAuditSink);
		vi.restoreAllMocks();
	});

	it("1. Contract parity: entity_crud (all 7 ops), entity_bulk_delete, and single-op tools match dev output byte for byte", async () => {
		const id1 = "11111111-1111-4111-8111-111111111111";
		const id2 = "22222222-2222-4222-8222-222222222222";
		const row1 = makeRow(id1, "Knowledge Base");
		const row2 = makeRow(id2, "Second");
		const { registry } = createFakeEntitiesBackend([row1, row2]);
		const client = await connectClient(registry);

		const unresolved = { domain: null, resolved_by: "unresolved" as const };
		expect(textOf(await client.callTool({ name: "entity_get", arguments: { id: id1 } }))).toBe(
			formatEntitiesGetMcp({ found: true, entity: row1, domain: unresolved }),
		);
		expect(
			textOf(await client.callTool({ name: "entity_crud", arguments: { operation: "get", id: id1 } })),
		).toBe(formatEntitiesCrudMcp({ operation: "get", found: true, entity: row1, domain: unresolved }, false));

		expect(textOf(await client.callTool({ name: "entity_query", arguments: { limit: 10 } }))).toBe(
			formatEntitiesQueryMcp({ count: 2, rows: [row1, row2], domains: [unresolved, unresolved], truncated: false }, false),
		);
		expect(
			textOf(await client.callTool({ name: "entity_crud", arguments: { operation: "query", limit: 10 } })),
		).toBe(
			formatEntitiesCrudMcp(
				{ operation: "query", count: 2, rows: [row1, row2], domains: [unresolved, unresolved], truncated: false },
				false,
			),
		);

		const createSingle = await client.callTool({
			name: "entity_create",
			arguments: { entities: [{ title: "New Entity", entity_type: "concept" }] },
		});
		expect(textOf(createSingle)).toBe(
			formatEntitiesCreateMcp({
				success: true,
				count: 1,
				entities: [{ id: makeId(103), title: "New Entity", entity_type: "concept" }],
			}),
		);

		const createCrud = await client.callTool({
			name: "entity_crud",
			arguments: { operation: "create", entities: [{ title: "Crud Entity", entity_type: "term" }] },
		});
		expect(textOf(createCrud)).toBe(
			formatEntitiesCrudMcp(
				{
					operation: "create",
					success: true,
					count: 1,
					entities: [{ id: makeId(104), title: "Crud Entity", entity_type: "term" }],
				},
				false,
			),
		);

		expect(
			textOf(await client.callTool({ name: "entity_update", arguments: { ids: [id1], patch: { title: "Updated Title" } } })),
		).toBe(formatEntitiesUpdateMcp({ success: true, count: 1, updated: [{ id: id1, title: "Updated Title" }] }));
		expect(
			textOf(
				await client.callTool({
					name: "entity_crud",
					arguments: { operation: "update", id: id2, patch: { title: "Second v2" } },
				}),
			),
		).toBe(
			formatEntitiesCrudMcp(
				{ operation: "update", success: true, count: 1, updated: [{ id: id2, title: "Second v2" }] },
				false,
			),
		);

		expect(
			textOf(
				await client.callTool({
					name: "entity_upsert",
					arguments: { entities: [{ id: id1, title: "Existing Item" }, { title: "New Item" }] },
				}),
			),
		).toBe(formatEntitiesUpsertMcp({ success: true, count: 2, created: ["New Item"], updated: [id1] }));
		expect(
			textOf(
				await client.callTool({
					name: "entity_crud",
					arguments: { operation: "upsert", entities: [{ id: id2, title: "Second v3" }] },
				}),
			),
		).toBe(formatEntitiesCrudMcp({ operation: "upsert", success: true, count: 1, created: [], updated: [id2] }, false));

		expect(
			textOf(
				await client.callTool({
					name: "entity_crud",
					arguments: { operation: "bulk_delete", filter: { entity_type: "concept" }, dry_run: true },
				}),
			),
		).toContain("[Dry Run] Would archive");

		expect(textOf(await client.callTool({ name: "entity_delete", arguments: { ids: [id1] } }))).toBe(
			formatEntitiesDeleteMcp({
				success: true,
				count: 1,
				archiveOnly: true,
				deleted: [{ id: id1, title: "Existing Item" }],
			}),
		);
		expect(
			textOf(await client.callTool({ name: "entity_crud", arguments: { operation: "delete", id: id2 } })),
		).toBe(
			formatEntitiesCrudMcp(
				{ operation: "delete", success: true, count: 1, archiveOnly: true, deleted: [{ id: id2, title: "Second v3" }] },
				false,
			),
		);
		expect(
			textOf(await client.callTool({ name: "entity_bulk_delete", arguments: { ids: [makeId(103)] } })),
		).toBe(
			formatEntitiesDeleteMcp({
				success: true,
				count: 1,
				archiveOnly: true,
				deleted: [{ id: makeId(103), title: "New Entity" }],
			}),
		);

		await client.close();
	});

	it("2. Gate travels: entity_bulk_delete with 51 ids + archive_only: false parks on mcp with no delete; 50 ids and ui caller do not park", async () => {
		const parked: ApprovalRequest[] = [];
		setActionApprovalStore({
			park: vi.fn(async (req: ApprovalRequest) => {
				parked.push(req);
				return { decisionId: `dec-${parked.length}` };
			}),
		});

		const ids51 = makeIds(51);
		const { repo, registry } = createFakeEntitiesBackend(ids51.map((id) => makeRow(id, id)));
		const action = registry.get("entity_bulk_delete")!;

		await expect(
			executeAction(action, { ids: ids51, archive_only: false }, { context: { caller: "mcp", userId: "user-123" } }),
		).rejects.toBeInstanceOf(PendingApprovalError);
		expect(repo.mutateByIds).not.toHaveBeenCalled();
		expect(parked).toHaveLength(1);

		const res50 = await executeAction(
			action,
			{ ids: ids51.slice(0, 50), archive_only: false },
			{ context: { caller: "mcp", userId: "user-123" } },
		);
		expect(res50.count).toBe(50);
		expect(parked).toHaveLength(1);

		const uiBackend = createFakeEntitiesBackend(ids51.map((id) => makeRow(id, id)));
		const resUi = await executeAction(
			uiBackend.registry.get("entity_bulk_delete")!,
			{ ids: ids51, archive_only: false },
			{ context: { caller: "ui", userId: "user-123" } },
		);
		expect(resUi.count).toBe(51);
		expect(parked).toHaveLength(1);
	});

	it("3. No mcp-server code runs: with supabase singleton mocked to throw, every operation succeeds through fake repository", async () => {
		(supabase as any).from = vi.fn(() => {
			throw new Error("mcp-server supabase singleton must not be called");
		});

		const { registry, embedding } = createFakeEntitiesBackend([makeRow(makeId(1), "Seed")]);
		const client = await connectClient(registry);

		const created = await client.callTool({
			name: "entity_create",
			arguments: { entities: [{ title: "Isolated", entity_type: "concept" }] },
		});
		expect(created.isError).toBeFalsy();
		expect(embedding.embed).toHaveBeenCalledTimes(1);

		const got = await client.callTool({ name: "entity_get", arguments: { id: makeId(1) } });
		expect(textOf(got)).toContain("Seed");

		const queried = await client.callTool({ name: "entity_query", arguments: {} });
		expect(textOf(queried)).toContain("Entities (2):");

		const updated = await client.callTool({
			name: "entity_update",
			arguments: { ids: [makeId(1)], patch: { title: "Seed Updated" } },
		});
		expect(textOf(updated)).toContain("Seed Updated");

		const upserted = await client.callTool({
			name: "entity_upsert",
			arguments: { entities: [{ id: makeId(1), title: "Seed v3" }] },
		});
		expect(textOf(upserted)).toContain("Upserted 1 entities");

		const crud = await client.callTool({
			name: "entity_crud",
			arguments: { operation: "get", id: makeId(1) },
		});
		expect(textOf(crud)).toContain("Seed v3");

		const bulkDel = await client.callTool({
			name: "entity_bulk_delete",
			arguments: { ids: [makeId(102)] },
		});
		expect(textOf(bulkDel)).toContain("Archived 1 entities");

		const singleDel = await client.callTool({
			name: "entity_delete",
			arguments: { ids: [makeId(1)] },
		});
		expect(textOf(singleDel)).toContain("Archived 1 entities");

		await client.close();

		expect(existsSync(resolve(import.meta.dirname, "../tools/entities.ts"))).toBe(false);
	});

	it("4. /api/actions/entity_crud and /api/actions/entity_bulk_delete answer for the owner", async () => {
		const id1 = makeId(1);
		const { registry } = createFakeEntitiesBackend([makeRow(id1, "HTTP Entity")]);

		const stubAuth = {
			auth: {
				getUser: vi.fn(async (token: string) =>
					token === "valid-token"
						? { data: { user: { id: "user-123", email: "owner@example.com" } }, error: null }
						: { data: { user: null }, error: new Error("Invalid token") },
				),
			},
		};

		const app = express();
		app.use(express.json());
		app.use(
			"/api/actions",
			actionsRouter({
				supabaseClient: stubAuth as any,
				ownerUserId: "user-123",
				registry,
			}),
		);

		const crudRes = await request(app)
			.post("/api/actions/entity_crud")
			.set("Authorization", "Bearer valid-token")
			.send({ operation: "get", id: id1 });
		expect(crudRes.status).toBe(200);
		expect(crudRes.body.found).toBe(true);
		expect(crudRes.body.entity.title).toBe("HTTP Entity");

		const bulkRes = await request(app)
			.post("/api/actions/entity_bulk_delete")
			.set("Authorization", "Bearer valid-token")
			.send({ ids: [id1], archive_only: false });
		expect(bulkRes.status).toBe(200);
		expect(bulkRes.body.success).toBe(true);
		expect(bulkRes.body.count).toBe(1);
	});
});
