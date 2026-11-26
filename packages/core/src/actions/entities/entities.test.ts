import { describe, expect, it, vi } from "vitest";
import { buildRegistry, AdapterUnavailableError } from "../buildRegistry.js";
import { entityCrudSchema, bulkDeleteSchema, type EntitiesCrudResult } from "../domain/entities.js";
import type { EntitiesPort } from "../../ports/entities.js";
import {
	formatEntitiesCreateMcp,
	formatEntitiesGetMcp,
	formatEntitiesQueryMcp,
	formatEntitiesUpdateMcp,
	formatEntitiesDeleteMcp,
	formatEntitiesUpsertMcp,
} from "./format.js";

describe("entities family actions in @ahkms/core (Issue #1548 / ADR-105)", () => {
	it("1. buildRegistry({ entities: fakePort }) holds entity_crud and entity_bulk_delete, each running port method once", async () => {
		const fakePort: EntitiesPort = {
			entityCrud: vi.fn().mockResolvedValue({
				operation: "get",
				found: true,
				entity: {
					id: "11111111-1111-1111-1111-111111111111",
					entity_type: "concept",
					title: "Test",
					description: null,
					tags: null,
					properties: null,
					archived: false,
					archived_at: null,
					source_url: null,
					user_id: null,
					team_id: null,
					created_at: null,
					updated_at: null,
				},
			}),
			entityBulkDelete: vi.fn().mockResolvedValue({
				success: true,
				count: 1,
				archiveOnly: true,
				deleted: [{ id: "11111111-1111-1111-1111-111111111111", title: "Test" }],
			}),
		};

		const registry = buildRegistry({ entities: fakePort });
		const crudAction = registry.get("entity_crud");
		const bulkDeleteAction = registry.get("entity_bulk_delete");

		expect(crudAction).toBeDefined();
		expect(bulkDeleteAction).toBeDefined();

		const ctx = { userId: "user-123" };
		const crudInput = {
			operation: "get" as const,
			id: "11111111-1111-1111-1111-111111111111",
		};
		await crudAction!.run(crudInput, ctx);
		expect(fakePort.entityCrud).toHaveBeenCalledTimes(1);
		expect(fakePort.entityCrud).toHaveBeenCalledWith(crudInput, ctx);

		const bulkDeleteInput = {
			ids: ["11111111-1111-1111-1111-111111111111"],
			archive_only: true,
		};
		await bulkDeleteAction!.run(bulkDeleteInput, ctx);
		expect(fakePort.entityBulkDelete).toHaveBeenCalledTimes(1);
		expect(fakePort.entityBulkDelete).toHaveBeenCalledWith(bulkDeleteInput, ctx);
	});

	it("2. contracts unchanged: descriptions, schemas, domain, annotations", () => {
		const fakePort: EntitiesPort = {
			entityCrud: vi.fn(),
			entityBulkDelete: vi.fn(),
		};
		const registry = buildRegistry({ entities: fakePort });
		const crudAction = registry.get("entity_crud")!;
		const bulkDeleteAction = registry.get("entity_bulk_delete")!;

		expect(crudAction.description).toBe(
			"Centralized action for CRUD operations on entities in the knowledge graph: create, get, query, update, delete, bulk_delete, or upsert. Parks for the owner's approval when archive_only is false and more than 50 rows match.",
		);
		expect(crudAction.domain).toBe("kg");
		expect(crudAction.schema).toBe(entityCrudSchema);
		expect(crudAction.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		});

		expect(bulkDeleteAction.description).toBe(
			"Delete or archive multiple entities by ids or filter criteria, with optional dry_run preview. Parks for the owner's approval when archive_only is false and more than 50 rows match.",
		);
		expect(bulkDeleteAction.domain).toBe("kg");
		expect(bulkDeleteAction.schema).toBe(bulkDeleteSchema);
		expect(bulkDeleteAction.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		});
	});

	it("3. formatMcp on fixture results equals the text the mcp-server formatters give on dev", () => {
		const fakePort: EntitiesPort = {
			entityCrud: vi.fn(),
			entityBulkDelete: vi.fn(),
		};
		const registry = buildRegistry({ entities: fakePort });
		const crudAction = registry.get("entity_crud")!;
		const bulkDeleteAction = registry.get("entity_bulk_delete")!;

		// create
		const createResult: EntitiesCrudResult = {
			operation: "create",
			success: true,
			count: 2,
			entities: [
				{ id: "e1", title: "Alpha", entity_type: "concept" },
				{ id: "e2", title: "Beta", entity_type: "project" },
			],
		};
		const expectedCreate = "Created 2 entities: [e1] Alpha (concept), [e2] Beta (project)";
		expect(formatEntitiesCreateMcp(createResult)).toBe(expectedCreate);
		expect(crudAction.formatMcp!(createResult)).toBe(expectedCreate);

		// get
		const getResult: EntitiesCrudResult = {
			operation: "get",
			found: true,
			entity: {
				id: "e1",
				entity_type: "concept",
				title: "Alpha",
				description: "A test concept",
				tags: ["t1", "t2"],
				properties: { key: "value" },
				archived: false,
				archived_at: null,
				source_url: "https://example.com",
				user_id: null,
				team_id: null,
				created_at: null,
				updated_at: null,
			},
			domain: {
				domain: "work",
				resolved_by: "override",
			},
		};
		const expectedGet =
			'• [e1] concept | Alpha | desc: A test concept | tags: t1, t2 | source: https://example.com | domain: work | domain_resolution: override\n  properties: {"key":"value"}';
		expect(formatEntitiesGetMcp(getResult)).toBe(expectedGet);
		expect(crudAction.formatMcp!(getResult)).toBe(expectedGet);

		// query without include_properties
		const queryResult: EntitiesCrudResult = {
			operation: "query",
			count: 1,
			rows: [
				{
					id: "e1",
					entity_type: "concept",
					title: "Alpha",
					description: null,
					tags: null,
					properties: { key: "value" },
					archived: false,
					archived_at: null,
					source_url: null,
					user_id: null,
					team_id: null,
					created_at: null,
					updated_at: null,
				},
			],
			domains: [{ domain: "angus", resolved_by: "signals" }],
			truncated: false,
			include_properties: false,
		};
		const expectedQueryNoProps = "Entities (1):\n• [e1] concept | Alpha | domain: angus | domain_resolution: signals";
		expect(formatEntitiesQueryMcp(queryResult, false)).toBe(expectedQueryNoProps);
		expect(crudAction.formatMcp!(queryResult)).toBe(expectedQueryNoProps);

		// query with include_properties
		const queryResultProps: EntitiesCrudResult = {
			...queryResult,
			include_properties: true,
		};
		const expectedQueryProps =
			'Entities (1):\n• [e1] concept | Alpha | domain: angus | domain_resolution: signals\n  properties: {"key":"value"}';
		expect(formatEntitiesQueryMcp(queryResultProps, true)).toBe(expectedQueryProps);
		expect(crudAction.formatMcp!(queryResultProps)).toBe(expectedQueryProps);

		// update
		const updateResult: EntitiesCrudResult = {
			operation: "update",
			success: true,
			count: 1,
			updated: [{ id: "e1", title: "Alpha Updated" }],
		};
		const expectedUpdate = "Updated 1 entities: [e1] Alpha Updated";
		expect(formatEntitiesUpdateMcp(updateResult)).toBe(expectedUpdate);
		expect(crudAction.formatMcp!(updateResult)).toBe(expectedUpdate);

		// delete
		const deleteResult: EntitiesCrudResult = {
			operation: "delete",
			success: true,
			count: 1,
			archiveOnly: false,
			deleted: [{ id: "e1", title: "Alpha" }],
		};
		const expectedDelete = "Deleted 1 entities: [e1] Alpha";
		expect(formatEntitiesDeleteMcp(deleteResult)).toBe(expectedDelete);
		expect(crudAction.formatMcp!(deleteResult)).toBe(expectedDelete);

		// bulk delete dry run
		const bulkDeleteDryRunResult: EntitiesCrudResult = {
			operation: "bulk_delete",
			success: true,
			count: 2,
			archiveOnly: true,
			deleted: [],
			dryRun: true,
			sample: [
				{ id: "e1", title: "Alpha" },
				{ id: "e2", title: "Beta" },
			],
		};
		const expectedDryRun = "[Dry Run] Would archive 2 entities. Preview sample: [e1] Alpha, [e2] Beta";
		expect(formatEntitiesDeleteMcp(bulkDeleteDryRunResult)).toBe(expectedDryRun);
		expect(crudAction.formatMcp!(bulkDeleteDryRunResult)).toBe(expectedDryRun);
		expect(bulkDeleteAction.formatMcp!(bulkDeleteDryRunResult)).toBe(expectedDryRun);

		// upsert
		const upsertResult: EntitiesCrudResult = {
			operation: "upsert",
			success: true,
			count: 2,
			created: ["e1"],
			updated: ["e2"],
		};
		const expectedUpsert = "Upserted 2 entities: created e1; updated e2";
		expect(formatEntitiesUpsertMcp(upsertResult)).toBe(expectedUpsert);
		expect(crudAction.formatMcp!(upsertResult)).toBe(expectedUpsert);
	});

	it("4. with {}, entity_crud rejects with AdapterUnavailableError naming entities", async () => {
		const registry = buildRegistry({});
		const action = registry.get("entity_crud")!;
		await expect(
			action.run({ operation: "get", id: "11111111-1111-1111-1111-111111111111" }),
		).rejects.toThrow(AdapterUnavailableError);
		await expect(
			action.run({ operation: "get", id: "11111111-1111-1111-1111-111111111111" }),
		).rejects.toThrow(/entities/);
	});
});
