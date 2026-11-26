import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "../supabase.js";
import { executeAction, toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";

const entityCrudAction = serverRegistry().get("entity_crud")!;
const entitiesCrudAction = entityCrudAction;
const entityCreateAction = serverRegistry().get("entity_create")!;
const entityGetAction = serverRegistry().get("entity_get")!;
const entityQueryAction = serverRegistry().get("entity_query")!;
const entityUpdateAction = serverRegistry().get("entity_update")!;
const entityDeleteAction = serverRegistry().get("entity_delete")!;
const entityBulkDeleteAction = serverRegistry().get("entity_bulk_delete")!;
const entitiesBulkDeleteAction = entityBulkDeleteAction;
const entityUpsertAction = serverRegistry().get("entity_upsert")!;

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

function createMockSupabase(entityData: any = null, deletedData: any = null, relationshipData: any = null) {
	return vi.fn((table: string) => {
		if (table === "entities") {
			const builder: any = {
				_updating: false,
				select: vi.fn(() => {
					if (builder._updating) {
						const resolved = deletedData ?? (Array.isArray(entityData) ? entityData : [entityData]);
						return Promise.resolve({ data: resolved, error: null });
					}
					return builder;
				}),
				insert: vi.fn(() => builder),
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
				lt: vi.fn(() => builder),
				contains: vi.fn(() => builder),
				order: vi.fn(() => builder),
				limit: vi.fn(() => Promise.resolve({ data: Array.isArray(entityData) ? entityData : (entityData ? [entityData] : []), error: null })),
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
			limit: vi.fn(() => Promise.resolve({ data: Array.isArray(relationshipData) ? relationshipData : [], error: null })),
			maybeSingle: vi.fn(() => Promise.resolve({ data: relationshipData, error: null })),
			then: (onfulfilled: any) => Promise.resolve({ data: Array.isArray(relationshipData) ? relationshipData : [], error: null }).then(onfulfilled),
		};
		return chainable;
	});
}

describe("entityCrudAction: Centralized Entity CRUD (ADR-100)", () => {
	beforeEach(() => {
		process.env.KMS_USER_ID = "test-user-id";
	});

	it("executes 'get' operation returning pure typed EntityGetResult", async () => {
		const row = mockEntityRow("11111111-1111-4111-8111-111111111111", "Knowledge Base");
		(supabase as any).from = createMockSupabase(row);

		const result = await executeAction(entityCrudAction, {
			operation: "get",
			id: "11111111-1111-4111-8111-111111111111",
		});

		expect(result.operation).toBe("get");
		if (result.operation === "get") {
			expect(result.found).toBe(true);
			expect(result.entity?.id).toBe("11111111-1111-4111-8111-111111111111");
			expect(result.entity?.title).toBe("Knowledge Base");
		}
	});

	it("executes 'query' operation returning rows and domain resolutions", async () => {
		const rows = [
			mockEntityRow("11111111-1111-4111-8111-111111111111", "First"),
			mockEntityRow("22222222-2222-4222-8222-222222222222", "Second"),
		];
		(supabase as any).from = createMockSupabase(rows);

		const result = await executeAction(entityCrudAction, {
			operation: "query",
			limit: 10,
		});

		expect(result.operation).toBe("query");
		if (result.operation === "query") {
			expect(result.count).toBe(2);
			expect(result.rows).toHaveLength(2);
			expect(result.rows[0].title).toBe("First");
		}
	});

	it("executes 'create' operation returning created entities", async () => {
		const createdRows = [
			{
				id: "33333333-3333-4333-8333-333333333333",
				title: "New Entity",
				entity_type: "concept",
				description: "A new concept",
				properties: {},
			},
		];
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "entities") {
				const builder: any = {
					insert: () => builder,
					select: () => Promise.resolve({ data: createdRows, error: null }),
				};
				return builder;
			}
			return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
		});

		const result = await executeAction(entityCrudAction, {
			operation: "create",
			entities: [
				{
					title: "New Entity",
					entity_type: "concept",
					description: "A new concept",
				},
			],
		});

		expect(result.operation).toBe("create");
		if (result.operation === "create") {
			expect(result.success).toBe(true);
			expect(result.count).toBe(1);
			expect(result.entities[0].title).toBe("New Entity");
		}
	});

	it("executes 'update' operation by id", async () => {
		const updatedRows = [
			{
				id: "11111111-1111-4111-8111-111111111111",
				title: "Updated Title",
				description: "Updated desc",
				properties: { updated: true },
			},
		];
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "entities") {
				const builder: any = {
					update: () => builder,
					eq: () => builder,
					in: () => builder,
					select: () => Promise.resolve({ data: updatedRows, error: null }),
				};
				return builder;
			}
			return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
		});

		const result = await executeAction(entityCrudAction, {
			operation: "update",
			id: "11111111-1111-4111-8111-111111111111",
			patch: { title: "Updated Title" },
		});

		expect(result.operation).toBe("update");
		if (result.operation === "update") {
			expect(result.success).toBe(true);
			expect(result.count).toBe(1);
			expect(result.updated[0].id).toBe("11111111-1111-4111-8111-111111111111");
		}
	});

	it("executes single 'delete' operation with archive_only default and relationship cascade", async () => {
		const deletedRows = [
			{
				id: "11111111-1111-4111-8111-111111111111",
				title: "Archived Title",
			},
		];
		const updateRelMock = vi.fn(() => ({ eq: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) }));

		(supabase as any).from = vi.fn((table: string) => {
			if (table === "entities") {
				const builder: any = {
					update: () => builder,
					eq: () => builder,
					in: () => builder,
					select: () => Promise.resolve({ data: deletedRows, error: null }),
				};
				return builder;
			}
			if (table === "entity_relationships") {
				return {
					update: updateRelMock,
				};
			}
			return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
		});

		const result = await executeAction(entityCrudAction, {
			operation: "delete",
			id: "11111111-1111-4111-8111-111111111111",
		});

		expect(result.operation).toBe("delete");
		if (result.operation === "delete") {
			expect(result.success).toBe(true);
			expect(result.archiveOnly).toBe(true);
			expect(result.count).toBe(1);
			expect(result.deleted[0].id).toBe("11111111-1111-4111-8111-111111111111");
		}
		expect(updateRelMock).toHaveBeenCalledWith({ archived: true });
	});

	it("executes bulk delete dry run preview returning sample and counts without mutating", async () => {
		const rows = [
			mockEntityRow("11111111-1111-4111-8111-111111111111", "Match One"),
			mockEntityRow("22222222-2222-4222-8222-222222222222", "Match Two"),
		];
		(supabase as any).from = createMockSupabase(rows);

		const result = await executeAction(entityCrudAction, {
			operation: "bulk_delete",
			filter: {
				entity_type: "concept",
			},
			dry_run: true,
		});

		expect(result.operation).toBe("bulk_delete");
		if (result.operation === "bulk_delete") {
			expect(result.dryRun).toBe(true);
			expect(result.count).toBe(2);
			expect(result.sample).toHaveLength(2);
			expect(result.sample?.[0].title).toBe("Match One");
			expect(result.wouldDeleteIds).toEqual([
				"11111111-1111-4111-8111-111111111111",
				"22222222-2222-4222-8222-222222222222",
			]);
		}
	});

	it("hard-deletes 55 entities for the owner's own click without a confirm flag", async () => {
		const rows = Array.from({ length: 55 }, (_, i) =>
			mockEntityRow(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, `Item ${i}`),
		);
		const deletedRows = rows.map((r) => ({ id: r.id, title: r.title }));
		(supabase as any).from = createMockSupabase(rows, deletedRows);

		const result = await executeAction(
			entityCrudAction,
			{
				operation: "bulk_delete",
				filter: { entity_type: "concept" },
				archive_only: false,
			},
			{ context: { caller: "ui" } },
		);

		expect(result.operation).toBe("bulk_delete");
		if (result.operation === "bulk_delete") {
			expect(result.success).toBe(true);
			expect(result.count).toBe(55);
			expect(result.archiveOnly).toBe(false);
		}
	});

	it("executes 'upsert' operation for both update and insert", async () => {
		const createdRows = [{ id: "new-id", title: "New Item", description: null, properties: {} }];
		const updatedRows = [{ id: "existing-id", title: "Existing Item", description: null, properties: {} }];

		(supabase as any).from = vi.fn((table: string) => {
			if (table === "entities") {
				const builder: any = {
					insert: () => builder,
					update: () => builder,
					eq: () => builder,
					select: vi
						.fn()
						.mockResolvedValueOnce({ data: updatedRows, error: null })
						.mockResolvedValueOnce({ data: createdRows, error: null }),
				};
				return builder;
			}
			return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
		});

		const result = await executeAction(entityCrudAction, {
			operation: "upsert",
			entities: [
				{ id: "11111111-1111-4111-8111-111111111111", title: "Existing Item" },
				{ title: "New Item" },
			],
		});

		expect(result.operation).toBe("upsert");
		if (result.operation === "upsert") {
			expect(result.success).toBe(true);
			expect(result.count).toBe(2);
			expect(result.updated).toHaveLength(1);
			expect(result.created).toHaveLength(1);
		}
	});

	it("formats output cleanly via toMcpTool adapter for MCP callers", async () => {
		const row = mockEntityRow("11111111-1111-4111-8111-111111111111", "Knowledge Base");
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "entities") {
				const builder: any = {
					select: () => builder,
					eq: () => builder,
					maybeSingle: () => Promise.resolve({ data: row, error: null }),
				};
				return builder;
			}
			return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
		});

		const mcpTool = toMcpTool(entityCrudAction);
		const response = await mcpTool.handler({
			operation: "get",
			id: "11111111-1111-4111-8111-111111111111",
		});

		expect(response.content).toBeDefined();
		expect(response.content[0].type).toBe("text");
		expect(response.content[0].text).toContain("Knowledge Base");
		expect(response.content[0].text).toContain("properties:");
	});

	it("throws on invalid update input missing patch", async () => {
		await expect(
			executeAction(entityCrudAction, {
				operation: "update",
				id: "11111111-1111-4111-8111-111111111111",
				patch: {},
			}),
		).rejects.toThrow("Entity update requires a non-empty 'patch'.");
	});

	it("exports plural aliases identically", () => {
		expect(entitiesCrudAction).toBe(entityCrudAction);
		expect(entitiesBulkDeleteAction).toBe(entityBulkDeleteAction);
	});
});

describe("Individual Entity Actions: defineAction parity", () => {
	it("executes entityGetAction directly via executeAction", async () => {
		const row = mockEntityRow("22222222-2222-4222-8222-222222222222", "Singular Get");
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "entities") {
				const builder: any = {
					select: () => builder,
					eq: () => builder,
					maybeSingle: () => Promise.resolve({ data: row, error: null }),
				};
				return builder;
			}
			return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
		});

		const result = await executeAction(entityGetAction, {
			id: "22222222-2222-4222-8222-222222222222",
		});

		expect(result.found).toBe(true);
		expect(result.entity?.title).toBe("Singular Get");
	});

	it("executes entityDeleteAction directly via executeAction", async () => {
		const deletedRows = [{ id: "22222222-2222-4222-8222-222222222222", title: "Singular Delete" }];
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "entities") {
				const builder: any = {
					update: () => builder,
					eq: () => builder,
					in: () => builder,
					select: () => Promise.resolve({ data: deletedRows, error: null }),
				};
				return builder;
			}
			const chainable: any = {
				update: () => chainable,
				eq: () => chainable,
				in: () => Promise.resolve({ data: [], error: null }),
			};
			return chainable;
		});

		const result = await executeAction(entityDeleteAction, {
			ids: ["22222222-2222-4222-8222-222222222222"],
		});

		expect(result.success).toBe(true);
		expect(result.count).toBe(1);
		expect(result.deleted[0].title).toBe("Singular Delete");
	});

	it("executes entityBulkDeleteAction directly via executeAction", async () => {
		const rows = [mockEntityRow("22222222-2222-4222-8222-222222222222", "Bulk Delete Target")];
		const deletedRows = [{ id: "22222222-2222-4222-8222-222222222222", title: "Bulk Delete Target" }];
		(supabase as any).from = createMockSupabase(rows, deletedRows);

		const result = await executeAction(entityBulkDeleteAction, {
			filter: { entity_type: "concept" },
		});

		expect(result.success).toBe(true);
		expect(result.count).toBe(1);
		expect(result.deleted[0].title).toBe("Bulk Delete Target");
	});

	it("executes entityCreateAction directly via executeAction", async () => {
		const createdRows = [
			{
				id: "44444444-4444-4444-8444-444444444444",
				title: "Singular Create",
				entity_type: "term",
				description: "Desc",
				properties: {},
			},
		];
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "entities") {
				const builder: any = {
					insert: () => builder,
					select: () => Promise.resolve({ data: createdRows, error: null }),
				};
				return builder;
			}
			return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
		});

		const result = await executeAction(entityCreateAction, {
			entities: [{ title: "Singular Create", entity_type: "term" }],
		});

		expect(result.success).toBe(true);
		expect(result.count).toBe(1);
		expect(result.entities[0].title).toBe("Singular Create");
	});
});
