import { describe, expect, it, vi } from "vitest";
import type { EntityRepository, LinkRepository, SyncEntityRow } from "../../ports/entities.js";
import { buildRegistry } from "../buildRegistry.js";
import {
	ARTIFACT_SYNC_ENTITIES_DESCRIPTION,
	createArtifactSyncEntitiesAction,
	formatArtifactSyncEntitiesMcp,
} from "./artifactSync.js";

const ARTIFACT_ID = "aaaaaaaa-0000-0000-0000-000000000001";

function createInMemoryRepos(initialEntities: SyncEntityRow[] = []) {
	const entitiesStore = new Map<string, SyncEntityRow>(
		initialEntities.map((row) => [row.id, { ...row }]),
	);
	const linksStore = new Map<
		string,
		{ id: string; artifact_id: string; entity_id: string; link_type: string | null; created_by: string | null }
	>();
	let linkSeq = 0;

	const entities: Partial<EntityRepository> = {
		findExactForSync: vi.fn(async (query) => {
			if (query.id && entitiesStore.has(query.id)) {
				return entitiesStore.get(query.id)!;
			}
			for (const row of entitiesStore.values()) {
				if (row.entity_type !== query.entity_type || row.title !== query.title) continue;
				if (query.place_type) {
					const rowPlaceType =
						typeof row.properties?.place_type === "string"
							? row.properties.place_type.trim().toLowerCase()
							: null;
					if (rowPlaceType !== query.place_type) continue;
				}
				return row;
			}
			return null;
		}),
		findSyncCandidates: vi.fn(async (query) => {
			return [...entitiesStore.values()].filter((row) => row.entity_type === query.entity_type);
		}),
		createForSync: vi.fn(async (input) => {
			const row: SyncEntityRow = {
				id: input.id,
				entity_type: input.entity_type,
				title: input.title,
				description: input.description,
				archived: false,
				properties: input.properties,
				tags: input.tags,
				aliases: [],
			};
			entitiesStore.set(row.id, row);
			return { created: row, conflict: false };
		}),
	};

	const links: Partial<LinkRepository> = {
		upsert: vi.fn(async (items) => {
			return items.map((item) => {
				const linkType = item.link_type ?? "related";
				const key = `${item.artifact_id}:${item.entity_id}:${linkType}`;
				const existing = linksStore.get(key);
				if (existing) {
					return {
						id: existing.id,
						artifact_id: existing.artifact_id,
						entity_id: existing.entity_id,
						link_type: existing.link_type,
					};
				}
				linkSeq += 1;
				const created = {
					id: `link-${linkSeq}`,
					artifact_id: item.artifact_id,
					entity_id: item.entity_id,
					link_type: linkType,
					created_by: item.created_by ?? null,
				};
				linksStore.set(key, created);
				return {
					id: created.id,
					artifact_id: created.artifact_id,
					entity_id: created.entity_id,
					link_type: created.link_type,
				};
			});
		}),
	};

	return {
		entities: entities as EntityRepository,
		links: links as LinkRepository,
		entitiesStore,
		linksStore,
	};
}

describe("artifact_sync_entities core action (#1477)", () => {
	it("registers in buildRegistry with expected contract, domain, and annotations", () => {
		const registry = buildRegistry({});
		const action = registry.get("artifact_sync_entities");
		expect(action).toBeDefined();
		expect(action?.id).toBe("artifact_sync_entities");
		expect(action?.domain).toBe("kg");
		expect(action?.description).toBe(ARTIFACT_SYNC_ENTITIES_DESCRIPTION);
		expect(action?.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(action?.expose).toMatchObject({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
	});

	it("is idempotent across repeated runs and defaults link_type='mentioned' and created_by='artifact_entity_sync'", async () => {
		const { entities, links, entitiesStore, linksStore } = createInMemoryRepos();
		const embedEntity = vi.fn(async () => "embedded");
		const action = createArtifactSyncEntitiesAction({ entities, links, embedEntity });

		const input = {
			artifact_id: ARTIFACT_ID,
			entities: [
				{
					entity_type: "people",
					title: "Alice Example",
					email: "alice@example.com",
					tags: ["contact"],
				},
			],
		};

		const first = await action.run(input, { caller: "test", requestId: "req-1", userId: "u-1" });
		const second = await action.run(input, { caller: "test", requestId: "req-2", userId: "u-1" });

		expect(first.created).toBe(1);
		expect(first.reused).toBe(0);
		expect(second.created).toBe(0);
		expect(second.reused).toBe(1);
		expect(second.results[0]?.entity_id).toBe(first.results[0]?.entity_id);
		expect(second.results[0]?.link_id).toBe(first.results[0]?.link_id);

		expect(entitiesStore.size).toBe(1);
		expect(linksStore.size).toBe(1);
		expect(embedEntity).toHaveBeenCalledTimes(1);

		const [storedLink] = [...linksStore.values()];
		expect(storedLink?.link_type).toBe("mentioned");
		expect(storedLink?.created_by).toBe("artifact_entity_sync");

		const formatted = formatArtifactSyncEntitiesMcp(first);
		expect(formatted).toContain(`Synced 1 entities to artifact ${ARTIFACT_ID}: 1 created, 0 matched/linked.`);
		expect(formatted).toContain("Alice Example (people)");
	});

	it("matches by alias without creating a duplicate entity", async () => {
		const existingId = "bbbbbbbb-0000-0000-0000-000000000001";
		const { entities, links, entitiesStore } = createInMemoryRepos([
			{
				id: existingId,
				entity_type: "organization",
				title: "Man and Van Collective",
				description: "Edinburgh & London removals",
				archived: false,
				properties: { aliases: ["Man & Van"] },
				tags: ["vendor"],
				aliases: ["MVC"],
			},
		]);
		const embedEntity = vi.fn(async () => "embedded");
		const action = createArtifactSyncEntitiesAction({ entities, links, embedEntity });

		const result = await action.run(
			{
				artifact_id: ARTIFACT_ID,
				entities: [{ entity_type: "organization", title: "MVC" }],
			},
			{ caller: "test", requestId: "req-3", userId: "u-1" },
		);

		expect(result.created).toBe(0);
		expect(result.reused).toBe(1);
		expect(result.results[0]?.entity_id).toBe(existingId);
		expect(entitiesStore.size).toBe(1);
		expect(embedEntity).not.toHaveBeenCalled();
	});
});
