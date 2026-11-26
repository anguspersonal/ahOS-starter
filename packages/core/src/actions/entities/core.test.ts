import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DOS_CONFIG } from "../../domain/dosConfig.js";
import type { EmbeddingPort, EmbeddingStorePort } from "../../ports/embeddings.js";
import type {
	EntityInsertInput,
	EntityPatchInput,
	EntityRepository,
	EntityRow,
} from "../../ports/entities.js";
import {
	entitiesBulkDeleteCore,
	entitiesCreateCore,
	entitiesDeleteCore,
	entitiesGetCore,
	entitiesQueryCore,
	entitiesUpdateCore,
	entitiesUpsertCore,
	entityBulkDeleteRun,
	entityCrudRun,
	entityHardDeleteNeedsApproval,
} from "./core.js";

const makeId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

function makeFakeRepo(initial: EntityRow[] = []): EntityRepository & { rows: Map<string, EntityRow> } {
	const rows = new Map<string, EntityRow>(initial.map((r) => [r.id, { ...r }]));
	let seq = initial.length;
	return {
		rows,
		getById: vi.fn(async (id) => rows.get(id) ?? null),
		loadRows: vi.fn(async (filter) => {
			let list = [...rows.values()];
			if (!filter.include_archived) list = list.filter((r) => !r.archived);
			if (filter.entity_type) list = list.filter((r) => r.entity_type === filter.entity_type);
			if (filter.ids?.length) {
				const set = new Set(filter.ids);
				list = list.filter((r) => set.has(r.id));
			}
			if (filter.query) {
				const q = filter.query.toLowerCase();
				list = list.filter((r) => (r.title ?? "").toLowerCase().includes(q));
			}
			const limit = filter.limit ?? 20;
			return { rows: list.slice(0, limit), truncated: false };
		}),
		insert: vi.fn(async (items: readonly EntityInsertInput[], userId?: string) =>
			items.map((item) => {
				const id = makeId(++seq);
				const row: EntityRow = {
					id,
					entity_type: item.entity_type ?? "concept",
					title: item.title ?? null,
					description: item.description ?? null,
					archived: item.archived ?? false,
					archived_at: null,
					properties: item.properties ?? {},
					tags: item.tags ?? [],
					source_url: item.source_url ?? null,
					user_id: userId ?? "user-1",
					team_id: item.team_id ?? null,
					domain_override: item.domain_override ?? null,
					aliases: item.aliases,
					created_at: "2026-01-01T00:00:00Z",
					updated_at: "2026-01-01T00:00:00Z",
				};
				rows.set(id, row);
				return row;
			}),
		),
		update: vi.fn(async (ids: string | readonly string[], patch: EntityPatchInput) => {
			const targets = typeof ids === "string" ? [ids] : [...ids];
			const out: EntityRow[] = [];
			for (const id of targets) {
				const cur = rows.get(id);
				if (!cur) continue;
				const next: EntityRow = {
					...cur,
					...(patch.title !== undefined ? { title: patch.title } : {}),
					...(patch.description !== undefined ? { description: patch.description } : {}),
					...(patch.properties !== undefined ? { properties: patch.properties ?? {} } : {}),
					...(patch.aliases !== undefined ? { aliases: patch.aliases } : {}),
				};
				rows.set(id, next);
				out.push(next);
			}
			return out;
		}),
		mutateByIds: vi.fn(async (ids, archiveOnly) => {
			const out: Array<{ id: string; title: string | null }> = [];
			for (const id of ids) {
				const cur = rows.get(id);
				if (!cur) continue;
				out.push({ id: cur.id, title: cur.title });
				if (archiveOnly) {
					rows.set(id, { ...cur, archived: true });
				} else {
					rows.delete(id);
				}
			}
			return out;
		}),
		getDomainRow: vi.fn(async (id) => {
			const r = rows.get(id);
			if (!r) return null;
			return {
				id: r.id,
				title: r.title,
				description: r.description,
				tags: r.tags,
				properties: r.properties,
				domain_override: (r.domain_override as string | null) ?? null,
			};
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
		getTitleById: vi.fn(async (id) => rows.get(id)?.title ?? null),
	};
}

describe("entity core bodies over EntityRepository and EmbeddingPort (#1623)", () => {
	it("creates, gets, queries (with domain filter), updates, upserts, and embeds on write via EmbeddingPort", async () => {
		const repo = makeFakeRepo();
		const embed = vi.fn(async () => [0.1, 0.2]);
		const setEmbedding = vi.fn(async () => {});
		const embedding: EmbeddingPort = { embed, embedBatch: vi.fn(async (t) => t.map(() => [0.1])) };
		const embeddingStore: EmbeddingStorePort = { setEmbedding };
		const deps = { repo, embedding, embeddingStore, loadDosConfig: async () => DEFAULT_DOS_CONFIG };

		const created = await entitiesCreateCore(
			deps,
			{
				entities: [
					{ title: "Work Plan", entity_type: "project", domain_override: "work" },
					{ title: "Personal Note", entity_type: "concept", domain_override: "angus" },
				],
			},
			"user-1",
		);
		expect(created.count).toBe(2);
		expect(embed).toHaveBeenCalledTimes(2);
		expect(setEmbedding).toHaveBeenCalledTimes(2);
		expect(setEmbedding).toHaveBeenCalledWith("entities", created.entities[0].id, [0.1, 0.2]);

		const got = await entitiesGetCore(deps, { id: created.entities[0].id }, "user-1");
		expect(got.found).toBe(true);
		expect(got.domain?.domain).toBe("work");
		expect(got.domain?.resolved_by).toBe("override");

		const missing = await entitiesGetCore(deps, { id: makeId(999) }, "user-1");
		expect(missing).toEqual({ found: false, entity: null });

		const queried = await entitiesQueryCore(deps, { domain: "work" }, "user-1");
		expect(queried.count).toBe(1);
		expect(queried.rows[0].title).toBe("Work Plan");
		expect(queried.domains?.[0].domain).toBe("work");

		embed.mockClear();
		setEmbedding.mockClear();
		const updated = await entitiesUpdateCore(
			deps,
			{ ids: [created.entities[0].id], patch: { description: "Revised" } },
			"user-1",
		);
		expect(updated.count).toBe(1);
		expect(embed).toHaveBeenCalledTimes(1);
		expect(setEmbedding).toHaveBeenCalledWith("entities", created.entities[0].id, [0.1, 0.2]);

		embed.mockClear();
		const upserted = await entitiesUpsertCore(
			deps,
			{
				entities: [
					{ id: created.entities[1].id, title: "Personal Note v2" },
					{ title: "Third Item", entity_type: "term" },
				],
			},
			"user-1",
		);
		expect(upserted).toEqual({
			success: true,
			count: 2,
			created: ["Third Item"],
			updated: [created.entities[1].id],
		});
		expect(embed).toHaveBeenCalledTimes(2);
	});

	it("deletes, bulk-deletes (dry_run, archive, hard), does not re-embed on delete, and evaluates hard-delete gate", async () => {
		const initial = Array.from({ length: 52 }, (_, i) => ({
			id: makeId(i + 1),
			entity_type: "concept",
			title: `Item ${i + 1}`,
			description: null,
			archived: false,
			archived_at: null,
			properties: {},
			tags: [],
			source_url: null,
			user_id: "user-1",
			team_id: null,
			created_at: null,
			updated_at: null,
		}));
		const repo = makeFakeRepo(initial);
		const embed = vi.fn(async () => [0.5]);
		const deps = {
			repo,
			embedding: { embed, embedBatch: vi.fn() },
		};

		expect(
			await entityHardDeleteNeedsApproval(deps, {
				ids: initial.slice(0, 51).map((r) => r.id),
				archive_only: false,
			}),
		).toBe(true);
		expect(
			await entityHardDeleteNeedsApproval(deps, {
				ids: initial.slice(0, 50).map((r) => r.id),
				archive_only: false,
			}),
		).toBe(false);
		expect(
			await entityHardDeleteNeedsApproval(deps, {
				filter: { entity_type: "concept" },
				archive_only: false,
			}),
		).toBe(true);
		expect(
			await entityHardDeleteNeedsApproval(deps, {
				ids: initial.slice(0, 51).map((r) => r.id),
				archive_only: true,
			}),
		).toBe(false);

		const preview = await entitiesBulkDeleteCore(deps, {
			filter: { entity_type: "concept" },
			dry_run: true,
		});
		expect(preview.dryRun).toBe(true);
		expect(preview.count).toBe(52);
		expect(preview.sample).toHaveLength(5);

		const singleDel = await entitiesDeleteCore(deps, { ids: [makeId(1)] });
		expect(singleDel).toEqual({
			success: true,
			count: 1,
			archiveOnly: true,
			deleted: [{ id: makeId(1), title: "Item 1" }],
		});
		expect(embed).not.toHaveBeenCalled();

		const crudRes = await entityCrudRun(
			deps,
			{ operation: "bulk_delete", ids: [makeId(2)], archive_only: false },
			{ userId: "user-1" },
		);
		expect(crudRes).toMatchObject({ operation: "bulk_delete", count: 1, archiveOnly: false });

		const runnerRes = await entityBulkDeleteRun(deps, { ids: [makeId(999)] }, { userId: "user-1" });
		expect(runnerRes.count).toBe(0);
	});
});
