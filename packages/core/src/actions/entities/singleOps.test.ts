import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry, AdapterUnavailableError } from "../buildRegistry.js";
import { executeAction } from "../adapters/direct.js";
import { actionResolver, executeApproved } from "../approvals.js";
import {
	ApprovalDeniedError,
	PendingApprovalError,
	setActionApprovalStore,
	type ActionApprovalLifecycleStore,
	type ApprovalRequest,
} from "../gate.js";
import { exposureOf } from "../exposure.js";
import type { EntitiesPort } from "../../ports/entities.js";
import {
	createSchema,
	getSchema,
	querySchema,
	updateSchema,
	deleteSchema,
	upsertSchema,
} from "../domain/entities.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("single-op entity actions in @ahkms/core (Issue #1549 / ADR-105)", () => {
	afterEach(() => {
		setActionApprovalStore(undefined);
	});
	it("1. buildRegistry({ entities: fakePort }) holds the six ids, each running its port method once with parsed input and ctx", async () => {
		const fakePort: EntitiesPort = {
			entityCrud: vi.fn(),
			entityBulkDelete: vi.fn(),
			entityCreate: vi.fn().mockResolvedValue({ success: true, count: 1, entities: [{ id: "e1", title: "Test", entity_type: "concept" }] }),
			entityGet: vi.fn().mockResolvedValue({ found: true, entity: { id: "e1", title: "Test", entity_type: "concept" } }),
			entityQuery: vi.fn().mockResolvedValue({ count: 1, rows: [{ id: "e1", title: "Test", entity_type: "concept" }], domains: [], truncated: false, include_properties: false }),
			entityUpdate: vi.fn().mockResolvedValue({ success: true, count: 1, updated: [{ id: "e1", title: "Test" }] }),
			entityDelete: vi.fn().mockResolvedValue({ success: true, count: 1, archiveOnly: true, deleted: [{ id: "e1", title: "Test" }] }),
			entityUpsert: vi.fn().mockResolvedValue({ success: true, count: 1, created: ["e1"], updated: [] }),
		};

		const registry = buildRegistry({ entities: fakePort });
		const ids = ["entity_create", "entity_get", "entity_query", "entity_update", "entity_delete", "entity_upsert"];
		for (const id of ids) {
			expect(registry.get(id)).toBeDefined();
		}

		const ctx = { userId: "user-456" };

		// entity_create
		const createInput = { entities: [{ title: "Test", entity_type: "concept" }] };
		await registry.get("entity_create")!.run(createInput, ctx);
		expect(fakePort.entityCreate).toHaveBeenCalledTimes(1);
		expect(fakePort.entityCreate).toHaveBeenCalledWith(createInput, ctx);

		// entity_get
		const getInput = { id: "11111111-1111-1111-1111-111111111111" };
		await registry.get("entity_get")!.run(getInput, ctx);
		expect(fakePort.entityGet).toHaveBeenCalledTimes(1);
		expect(fakePort.entityGet).toHaveBeenCalledWith(getInput, ctx);

		// entity_query
		const queryInput = { query: "hello", include_properties: true };
		await registry.get("entity_query")!.run(queryInput, ctx);
		expect(fakePort.entityQuery).toHaveBeenCalledTimes(1);
		expect(fakePort.entityQuery).toHaveBeenCalledWith(queryInput, ctx);

		// entity_update
		const updateInput = { patch: { title: "Updated" }, ids: ["11111111-1111-1111-1111-111111111111"] };
		await registry.get("entity_update")!.run(updateInput, ctx);
		expect(fakePort.entityUpdate).toHaveBeenCalledTimes(1);
		expect(fakePort.entityUpdate).toHaveBeenCalledWith(updateInput, ctx);

		// entity_delete
		const deleteInput = { ids: ["11111111-1111-1111-1111-111111111111"], archive_only: true };
		await registry.get("entity_delete")!.run(deleteInput, ctx);
		expect(fakePort.entityDelete).toHaveBeenCalledTimes(1);
		expect(fakePort.entityDelete).toHaveBeenCalledWith({ id: "11111111-1111-1111-1111-111111111111", archive_only: true }, ctx);

		// entity_upsert
		const upsertInput = { entities: [{ title: "Upserted", entity_type: "concept" }] };
		await registry.get("entity_upsert")!.run(upsertInput, ctx);
		expect(fakePort.entityUpsert).toHaveBeenCalledTimes(1);
		expect(fakePort.entityUpsert).toHaveBeenCalledWith(upsertInput, ctx);
	});

	it("2. each keeps its dev contract: descriptions and annotations; entity_delete schema keys are exactly id, archive_only", () => {
		const fakePort: EntitiesPort = {
			entityCrud: vi.fn(),
			entityBulkDelete: vi.fn(),
			entityCreate: vi.fn(),
			entityGet: vi.fn(),
			entityQuery: vi.fn(),
			entityUpdate: vi.fn(),
			entityDelete: vi.fn(),
			entityUpsert: vi.fn(),
		};
		const registry = buildRegistry({ entities: fakePort });

		const createAction = registry.get("entity_create")!;
		expect(createAction.description).toBe("Create one or many entities.");
		expect(createAction.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		});
		expect(createAction.schema).toBe(createSchema);

		const getAction = registry.get("entity_get")!;
		expect(getAction.description).toBe(
			"Read a single entity row by id, including its full properties JSON. entity_update replaces properties wholesale, so read here first and write the merged whole.",
		);
		expect(getAction.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(getAction.schema).toBe(getSchema);

		const queryAction = registry.get("entity_query")!;
		expect(queryAction.description).toBe(
			"Read entity rows from the entities table with filtering across type, ids, team/user scope, archived state, and a broad text query. Pass include_properties to also print each row's properties JSON.",
		);
		expect(queryAction.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(queryAction.schema).toBe(querySchema);

		const updateAction = registry.get("entity_update")!;
		expect(updateAction.description).toBe("Update one or many entities by ids or filter criteria.");
		expect(updateAction.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(updateAction.schema).toBe(updateSchema);

		const deleteAction = registry.get("entity_delete")!;
		expect(deleteAction.description).toBe(
			"Delete or archive one or many entities by ids or filter criteria. Parks for the owner's approval when archive_only is false and more than 50 rows match.",
		);
		expect(deleteAction.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		});
		expect(deleteAction.schema).toBe(deleteSchema);
		expect(Object.keys(deleteSchema.shape).sort()).toEqual(["archive_only", "dry_run", "filter", "ids"]);

		const upsertAction = registry.get("entity_upsert")!;
		expect(upsertAction.description).toBe(
			"Create or update one or many entities. If id is supplied, updates that row; otherwise creates a new row.",
		);
		expect(upsertAction.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(upsertAction.schema).toBe(upsertSchema);
	});

	it("3. exposureOf for the six actions is default-on (#1565, #1566)", () => {
		const fakePort: EntitiesPort = {
			entityCrud: vi.fn(),
			entityBulkDelete: vi.fn(),
			entityCreate: vi.fn(),
			entityGet: vi.fn(),
			entityQuery: vi.fn(),
			entityUpdate: vi.fn(),
			entityDelete: vi.fn(),
			entityUpsert: vi.fn(),
		};
		const registry = buildRegistry({ entities: fakePort });
		const allIds = ["entity_create", "entity_get", "entity_query", "entity_update", "entity_upsert", "entity_delete"];

		for (const id of allIds) {
			const action = registry.get(id)!;
			const exp = exposureOf(action);
			expect(exp.mcp, `${id}.mcp`).toBe(true);
			expect(exp.http, `${id}.http`).toBe(true);
			expect(exp.ui_agent, `${id}.ui_agent`).toBe(true);
			expect(exp.worker, `${id}.worker`).toBe(true);
			expect(exp.cli, `${id}.cli`).toBe(false);
			expect(exp.a2a, `${id}.a2a`).toBe(false);
		}
	});

	it("4. static: no defineAction( remains under packages/*/src outside core, and baseline file does not exist", () => {
		const repoRoot = path.resolve(__dirname, "../../../../..");
		const baselinePath = path.join(repoRoot, "packages/mcp-server/actions-outside-core-baseline.txt");
		expect(fs.existsSync(baselinePath), "actions-outside-core-baseline.txt must be deleted once empty").toBe(false);

		// Scan packages for any defineAction( outside core
		const packagesDir = path.join(repoRoot, "packages");
		const packageNames = fs.readdirSync(packagesDir).filter((name) => name !== "core");

		const violations: string[] = [];
		for (const pkg of packageNames) {
			const srcDir = path.join(packagesDir, pkg, "src");
			if (!fs.existsSync(srcDir)) continue;

			function walk(dir: string) {
				for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
					const full = path.join(dir, ent.name);
					if (ent.isDirectory()) {
						if (!["node_modules", "dist", "build", ".turbo", "__tests__"].includes(ent.name)) {
							walk(full);
						}
					} else if (ent.isFile() && (ent.name.endsWith(".ts") || ent.name.endsWith(".tsx"))) {
						if (ent.name.endsWith(".test.ts") || ent.name.endsWith(".spec.ts")) continue;
						const content = fs.readFileSync(full, "utf8");
						if (/defineAction\s*\(/.test(content)) {
							violations.push(path.relative(repoRoot, full));
						}
					}
				}
			}
			walk(srcDir);
		}

		expect(violations, `defineAction calls found outside @ahkms/core: ${violations.join(", ")}`).toEqual([]);
	});

	it("5. entity_create and entity_upsert review-band confidence gating (#1976): >= 0.85 executes, [0.30, 0.85) parks and replays via executeApproved, < 0.30 denies", async () => {
		const parked: ApprovalRequest[] = [];
		const lifecycleStore: ActionApprovalLifecycleStore = {
			park: vi.fn(async (req: ApprovalRequest) => {
				parked.push(req);
				return { decisionId: `dec-${parked.length}` };
			}),
			claim: vi.fn(async (decisionId: string) => {
				const idx = Number(decisionId.replace("dec-", "")) - 1;
				const req = parked[idx];
				if (!req) return null;
				return {
					decisionId,
					actionId: req.actionId,
					input: req.input,
					inputSha256: req.inputSha256,
					caller: req.caller,
					userId: req.userId ?? "u-1",
				};
			}),
			finish: vi.fn(async () => {}),
			reject: vi.fn(async () => true),
		};
		setActionApprovalStore(lifecycleStore);

		const fakeCreateResult = {
			success: true,
			count: 1,
			entities: [{ id: "e1", title: "Candidate", entity_type: "concept" }],
		};
		const fakeUpsertResult = {
			success: true,
			count: 1,
			created: ["e1"],
			updated: [],
		};
		const fakePort: EntitiesPort = {
			entityCrud: vi.fn(),
			entityBulkDelete: vi.fn(),
			entityCreate: vi.fn().mockResolvedValue(fakeCreateResult),
			entityGet: vi.fn(),
			entityQuery: vi.fn(),
			entityUpdate: vi.fn(),
			entityDelete: vi.fn(),
			entityUpsert: vi.fn().mockResolvedValue(fakeUpsertResult),
		};

		const registry = buildRegistry({ entities: fakePort });
		const entityCreate = registry.get("entity_create")!;
		const entityUpsert = registry.get("entity_upsert")!;

		// 1) >= 0.85 executes immediately for both
		await expect(
			executeAction(
				entityCreate,
				{ entities: [{ title: "Auto", entity_type: "concept" }], confidence: { epistemic: 0.9 } },
				{ context: { caller: "mcp", userId: "u-1" } },
			),
		).resolves.toEqual(fakeCreateResult);
		expect(fakePort.entityCreate).toHaveBeenCalledTimes(1);

		await expect(
			executeAction(
				entityUpsert,
				{ entities: [{ title: "Auto", entity_type: "concept" }], confidence: { epistemic: 0.85 } },
				{ context: { caller: "mcp", userId: "u-1" } },
			),
		).resolves.toEqual(fakeUpsertResult);
		expect(fakePort.entityUpsert).toHaveBeenCalledTimes(1);
		expect(parked).toHaveLength(0);

		// 2) [0.30, 0.85) parks as PendingApprovalError
		await expect(
			executeAction(
				entityCreate,
				{ entities: [{ title: "Review Create", entity_type: "concept" }], confidence: { epistemic: 0.55 } },
				{ context: { caller: "mcp", userId: "u-1" } },
			),
		).rejects.toBeInstanceOf(PendingApprovalError);
		expect(fakePort.entityCreate).toHaveBeenCalledTimes(1);
		expect(parked).toHaveLength(1);
		expect(parked[0].actionId).toBe("entity_create");

		await expect(
			executeAction(
				entityUpsert,
				{ entities: [{ title: "Review Upsert", entity_type: "concept" }], confidence: { epistemic: 0.65 } },
				{ context: { caller: "mcp", userId: "u-1" } },
			),
		).rejects.toBeInstanceOf(PendingApprovalError);
		expect(fakePort.entityUpsert).toHaveBeenCalledTimes(1);
		expect(parked).toHaveLength(2);
		expect(parked[1].actionId).toBe("entity_upsert");

		// Replay parked entity_upsert decision via executeApproved
		const replayUpsert = await executeApproved("dec-2", {
			store: lifecycleStore,
			resolve: actionResolver(registry),
			approvedBy: { userId: "u-1", via: "web_inbox" },
		});
		expect(replayUpsert).toEqual({ status: "executed", result: fakeUpsertResult });
		expect(fakePort.entityUpsert).toHaveBeenCalledTimes(2);

		// 3) < 0.30 throws ApprovalDeniedError without parking or calling port
		await expect(
			executeAction(
				entityCreate,
				{ entities: [{ title: "Blocked Create", entity_type: "concept" }], confidence: { epistemic: 0.1 } },
				{ context: { caller: "mcp", userId: "u-1" } },
			),
		).rejects.toBeInstanceOf(ApprovalDeniedError);

		await expect(
			executeAction(
				entityUpsert,
				{ entities: [{ title: "Blocked Upsert", entity_type: "concept" }], confidence: { epistemic: 0.2 } },
				{ context: { caller: "mcp", userId: "u-1" } },
			),
		).rejects.toBeInstanceOf(ApprovalDeniedError);
		expect(fakePort.entityCreate).toHaveBeenCalledTimes(1);
		expect(fakePort.entityUpsert).toHaveBeenCalledTimes(2);
		expect(parked).toHaveLength(2);
	});
});
