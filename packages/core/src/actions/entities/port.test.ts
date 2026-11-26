import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAction } from "../adapters/direct.js";
import { buildRegistry } from "../buildRegistry.js";
import { PendingApprovalError, setActionApprovalStore, type ApprovalRequest } from "../gate.js";
import type { EmbeddingPort } from "../../ports/embeddings.js";
import type { EntityRepository, EntityRow } from "../../ports/entities.js";
import { createCoreEntitiesPort } from "./port.js";

const makeId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

function makeRepo(seed: EntityRow[] = []): EntityRepository {
	const store = new Map<string, EntityRow>(seed.map((r) => [r.id, r]));
	let n = seed.length;
	return {
		getById: vi.fn(async (id) => store.get(id) ?? null),
		loadRows: vi.fn(async (filter) => {
			let rows = [...store.values()];
			if (filter.ids?.length) {
				const set = new Set(filter.ids);
				rows = rows.filter((r) => set.has(r.id));
			}
			return { rows: rows.slice(0, filter.limit ?? 20), truncated: false };
		}),
		insert: vi.fn(async (items) =>
			items.map((item) => {
				const id = makeId(++n);
				const row: EntityRow = {
					id,
					entity_type: item.entity_type ?? "concept",
					title: item.title ?? null,
					description: item.description ?? null,
					archived: false,
					archived_at: null,
					properties: item.properties ?? {},
					tags: item.tags ?? [],
					source_url: null,
					user_id: "u1",
					team_id: null,
					created_at: null,
					updated_at: null,
				};
				store.set(id, row);
				return row;
			}),
		),
		update: vi.fn(async (ids, patch) => {
			const list = typeof ids === "string" ? [ids] : [...ids];
			return list.flatMap((id) => {
				const cur = store.get(id);
				if (!cur) return [];
				const next = { ...cur, ...(patch.title !== undefined ? { title: patch.title } : {}) };
				store.set(id, next);
				return [next];
			});
		}),
		mutateByIds: vi.fn(async (ids) =>
			ids.flatMap((id) => {
				const cur = store.get(id);
				return cur ? [{ id: cur.id, title: cur.title }] : [];
			}),
		),
		getDomainRow: vi.fn(async (id) => {
			const cur = store.get(id);
			return cur
				? {
						id: cur.id,
						title: cur.title,
						description: cur.description,
						tags: cur.tags,
						properties: cur.properties,
						domain_override: null,
					}
				: null;
		}),
		fetchPrimaryParentId: vi.fn(async () => null),
		fetchPrimaryParentsBatch: vi.fn(async () => new Map()),
		getEdgeById: vi.fn(async () => null),
		findOwnedEntityIds: vi.fn(async () => new Set()),
		insertArrangementNodes: vi.fn(async () => {}),
		insertParticipantEdges: vi.fn(async () => {}),
		insertProvenanceLinks: vi.fn(async () => {}),
		archiveEdge: vi.fn(async () => {}),
		findTrackedResources: vi.fn(async () => []),
		getTitleById: vi.fn(async () => null),
	};
}

describe("createCoreEntitiesPort (#1623)", () => {
	afterEach(() => {
		setActionApprovalStore(undefined);
	});

	it("implements every EntitiesPort method and drives all eight entity actions in buildRegistry", async () => {
		const repo = makeRepo();
		const embedding: EmbeddingPort = {
			embed: vi.fn(async () => [0.25]),
			embedBatch: vi.fn(async (t) => t.map(() => [0.25])),
		};
		const port = createCoreEntitiesPort({ repo, embedding });
		const registry = buildRegistry({ entities: port });

		const created = await executeAction(registry.get("entity_create")!, {
			entities: [{ title: "Alpha", entity_type: "concept" }],
		});
		expect(created.count).toBe(1);
		expect(embedding.embed).toHaveBeenCalledTimes(1);
		const id = created.entities[0].id;

		const got = await executeAction(registry.get("entity_get")!, { id });
		expect(got.found).toBe(true);

		const queried = await executeAction(registry.get("entity_query")!, { include_properties: true });
		expect(queried.count).toBe(1);
		expect(queried.include_properties).toBe(true);

		const updated = await executeAction(registry.get("entity_update")!, {
			ids: [id],
			patch: { title: "Alpha Prime" },
		});
		expect(updated.updated[0].title).toBe("Alpha Prime");

		const upserted = await executeAction(registry.get("entity_upsert")!, {
			entities: [{ id, title: "Alpha v3" }],
		});
		expect(upserted.updated).toEqual([id]);

		const deleted = await executeAction(registry.get("entity_delete")!, { ids: [id] });
		expect(deleted.count).toBe(1);

		const crud = await executeAction(registry.get("entity_crud")!, { operation: "get", id });
		expect(crud.operation).toBe("get");

		const bulk = await executeAction(registry.get("entity_bulk_delete")!, { ids: [id] });
		expect(bulk.count).toBe(1);
	});

	it("evaluates needsHardDeleteApproval through the registry gate without mcp-server state", async () => {
		const parked: ApprovalRequest[] = [];
		setActionApprovalStore({
			park: vi.fn(async (req: ApprovalRequest) => {
				parked.push(req);
				return { decisionId: `dec-${parked.length}` };
			}),
		});
		const ids51 = Array.from({ length: 51 }, (_, i) => makeId(i + 1));
		const seed = ids51.map((id) => ({
			id,
			entity_type: "concept",
			title: id,
			description: null,
			archived: false,
			archived_at: null,
			properties: {},
			tags: [],
			source_url: null,
			user_id: "u1",
			team_id: null,
			created_at: null,
			updated_at: null,
		}));
		const repo = makeRepo(seed);
		const registry = buildRegistry({ entities: createCoreEntitiesPort({ repo }) });

		await expect(
			executeAction(
				registry.get("entity_bulk_delete")!,
				{ ids: ids51, archive_only: false },
				{ context: { caller: "mcp", userId: "u1" } },
			),
		).rejects.toBeInstanceOf(PendingApprovalError);
		expect(repo.mutateByIds).not.toHaveBeenCalled();

		const okUi = await executeAction(
			registry.get("entity_bulk_delete")!,
			{ ids: ids51, archive_only: false },
			{ context: { caller: "ui", userId: "u1" } },
		);
		expect(okUi.count).toBe(51);
	});
});
