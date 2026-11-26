/**
 * Embed-on-write wiring for entity/people writers (#551 / ADR-047 §2, slice 2).
 *
 * `embedAndStore` itself (table routing, embedEntityText composition) is
 * covered by embedAndStore.test.ts and embedEntityText.test.ts. This file pins
 * that every write path §2 lists actually CALLS it — with the right table and
 * the row's current (post-write) title/description/properties — and that
 * paths which don't change embeddable text (archive/delete) don't call it at
 * all. `embedAndStore` is mocked throughout: whether it embeds successfully is
 * not this file's concern, only whether each handler invokes it correctly.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../embeddings.js", () => ({
	embedAndStore: vi.fn(async () => "embedded"),
}));

import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { supabase } from "../supabase.js";
import { embedAndStore } from "../embeddings.js";
import { upsertEntityHandler } from "../tools/upsertEntity.js";

const artifactEntitySyncHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("artifact_sync_entities")!).handler(args);

const entitiesCreateHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_create")!).handler(args);
const entitiesUpsertHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_upsert")!).handler(args);
const entitiesUpdateHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_update")!).handler(args);
const entitiesDeleteHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_delete")!).handler(args);

const peopleCreateHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("person_create")!).handler(args);
const peopleUpsertHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("person_upsert")!).handler(args);
const peopleUpdateHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("person_update")!).handler(args);
const peopleDeleteHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("person_delete")!).handler(args);
const promoteEdgeToNodeHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_promote_edge")!).handler(args);

const mockEmbed = vi.mocked(embedAndStore);
const origFrom = supabase.from;

afterEach(() => {
	(supabase as any).from = origFrom;
	vi.clearAllMocks();
});

/** A chainable stub: insert/update return `row` via .select(), everything else chains. */
function stubRow(row: Record<string, unknown> | Record<string, unknown>[]) {
	const rows = Array.isArray(row) ? row : [row];
	const b: any = {
		insert: () => b,
		update: () => b,
		eq: () => b,
		in: () => b,
		select: () => Promise.resolve({ data: rows, error: null }),
	};
	(supabase as any).from = vi.fn(() => b);
	return b;
}

describe("entities.ts — embed-on-write", () => {
	it("entitiesCreateHandler embeds each newly-created row", async () => {
		stubRow({ id: "e1", title: "Acme", entity_type: "organization", description: "A company", properties: { role: "vendor" } });

		await entitiesCreateHandler({ entities: [{ title: "Acme", entity_type: "organization" }] } as any);

		expect(mockEmbed).toHaveBeenCalledWith("entities", "e1", {
			title: "Acme",
			description: "A company",
			properties: { role: "vendor" },
		});
	});

	it("entitiesUpsertHandler embeds on the create branch", async () => {
		stubRow({ id: "e2", title: "New Co", description: null, properties: {} });

		await entitiesUpsertHandler({ entities: [{ title: "New Co", entity_type: "organization" }] } as any);

		expect(mockEmbed).toHaveBeenCalledWith("entities", "e2", { title: "New Co", description: null, properties: {} });
	});

	it("entitiesUpsertHandler embeds on the update branch (existing id supplied)", async () => {
		stubRow({ id: "e3", title: "Renamed Co", description: "updated", properties: { role: "customer" } });

		await entitiesUpsertHandler({ entities: [{ id: "e3", title: "Renamed Co", description: "updated" }] } as any);

		expect(mockEmbed).toHaveBeenCalledWith("entities", "e3", { title: "Renamed Co", description: "updated", properties: { role: "customer" } });
	});

	it("entitiesUpdateHandler embeds using the post-update row values", async () => {
		stubRow([{ id: "e4", title: "Updated Title", description: "new desc", properties: { role: "partner" } }]);

		await entitiesUpdateHandler({ ids: ["e4"], patch: { description: "new desc" } } as any);

		expect(mockEmbed).toHaveBeenCalledWith("entities", "e4", { title: "Updated Title", description: "new desc", properties: { role: "partner" } });
	});

	it("entitiesDeleteHandler (archive-only) does NOT re-embed — archiving doesn't change embed text", async () => {
		stubRow([{ id: "e5", title: "Gone", description: null, properties: {} }]);

		await entitiesDeleteHandler({ ids: ["e5"] } as any);

		expect(mockEmbed).not.toHaveBeenCalled();
	});
});

describe("people.ts — embed-on-write (people is a view over entities, #551)", () => {
	it("peopleCreateHandler embeds each newly-created row", async () => {
		stubRow({ id: "p1", title: "Sam", description: "bio text", properties: { role: "CEO" } });

		await peopleCreateHandler({ people: [{ name: "Sam", bio: "bio text", role: "CEO" }] } as any);

		expect(mockEmbed).toHaveBeenCalledWith("entities", "p1", { title: "Sam", description: "bio text", properties: { role: "CEO" } });
	});

	it("peopleUpsertHandler embeds on the create branch", async () => {
		stubRow({ id: "p2", title: "Robbie", description: null, properties: {} });

		await peopleUpsertHandler({ people: [{ name: "Robbie" }] } as any);

		expect(mockEmbed).toHaveBeenCalledWith("entities", "p2", { title: "Robbie", description: null, properties: {} });
	});

	it("peopleUpsertHandler embeds on the update branch (existing id supplied)", async () => {
		stubRow({ id: "p3", title: "Robbie", description: null, properties: { organization: "Acme" } });

		await peopleUpsertHandler({ people: [{ id: "p3", organization: "Acme" }] } as any);

		expect(mockEmbed).toHaveBeenCalledWith("entities", "p3", { title: "Robbie", description: null, properties: { organization: "Acme" } });
	});

	it("peopleUpdateHandler embeds using the post-update row values", async () => {
		stubRow([{ id: "p4", title: "Sam", description: null, properties: { role: "CTO" } }]);

		await peopleUpdateHandler({ ids: ["p4"], patch: { role: "CTO" } } as any);

		expect(mockEmbed).toHaveBeenCalledWith("entities", "p4", { title: "Sam", description: null, properties: { role: "CTO" } });
	});

	it("peopleDeleteHandler (archive-only) does NOT re-embed", async () => {
		stubRow([{ id: "p5", title: "Gone", description: null, properties: {} }]);

		await peopleDeleteHandler({ ids: ["p5"] } as any);

		expect(mockEmbed).not.toHaveBeenCalled();
	});
});

describe("upsertEntityHandler — embed-on-write", () => {
	it("embeds a freshly-created entity", async () => {
		(supabase as any).from = vi.fn(() => ({
			select: () => ({
				eq: () => ({ eq: () => ({ eq: () => ({ ilike: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) }) }),
			}),
			insert: () => Promise.resolve({ error: null }),
		}));

		await upsertEntityHandler({ entity_type: "people", title: "New Person", description: "desc" } as any);

		expect(mockEmbed).toHaveBeenCalledWith(
			"entities",
			expect.any(String),
			expect.objectContaining({ title: "New Person", description: "desc" }),
		);
	});

	it("re-embeds an existing entity it merges properties into", async () => {
		(supabase as any).from = vi.fn(() => ({
			select: () => ({
				eq: () => ({
					eq: () => ({
						eq: () => ({
							ilike: () => ({
								limit: () => ({
									maybeSingle: () =>
										Promise.resolve({
											data: { id: "u1", title: "Existing", properties: { role: "old" }, tags: [], description: "old desc" },
											error: null,
										}),
								}),
							}),
						}),
					}),
				}),
			}),
			update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
		}));

		await upsertEntityHandler({ entity_type: "people", title: "Existing", properties: { role: "new" } } as any);

		expect(mockEmbed).toHaveBeenCalledWith("entities", "u1", { title: "Existing", description: "old desc", properties: { role: "new" } });
	});
});

describe("promoteEdgeToNodeHandler — embed-on-write for reified arrangement nodes", () => {
	it("embeds each newly-created arrangement node from its own inserted fields", async () => {
		const EDGE_ID = "33333333-3333-3333-3333-333333333333";
		const ORG_ID = "44444444-4444-4444-4444-444444444444";
		const PERSON_ID = "55555555-5555-5555-5555-555555555555";
		(supabase as any).from = vi.fn((table: string) => ({
			select: () => {
				const b: any = {
					eq: () => b,
					in: () => Promise.resolve({ data: [{ id: ORG_ID }, { id: PERSON_ID }], error: null }),
					maybeSingle: () =>
						Promise.resolve({
							data: {
								id: EDGE_ID,
								from_entity_id: PERSON_ID,
								to_entity_id: ORG_ID,
								relationship_type: "employed_by",
								archived: false,
							},
							error: null,
						}),
				};
				return b;
			},
			insert: (rows: any[]) => Promise.resolve({ data: rows, error: null }),
			update: () => {
				const ub: any = { eq: () => ub, then: (resolve: (v: { error: null }) => void) => resolve({ error: null }) };
				return ub;
			},
		}));

		await promoteEdgeToNodeHandler({
			edge_id: EDGE_ID,
			kind: "employment",
			arrangements: [
				{
					title: "PM at Acme",
					participants: [
						{ role: "employer", entity_id: ORG_ID },
						{ role: "employee", entity_id: PERSON_ID },
					],
				},
			],
		} as any);

		expect(mockEmbed).toHaveBeenCalledTimes(1);
		expect(mockEmbed).toHaveBeenCalledWith(
			"entities",
			expect.any(String),
			expect.objectContaining({ title: "PM at Acme", description: null }),
		);
	});
});

describe("artifactEntitySyncHandler — embed-on-write (also serves artifact_sync_people)", () => {
	it("embeds a newly-created entity, not one that matched an existing row", async () => {
		const existing = { id: "existing-1", entity_type: "people", title: "Sam", description: null, archived: false, properties: {}, tags: [] };
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "artifact_entity_links") {
				return { upsert: () => ({ select: () => Promise.resolve({ data: [{ id: "link-1" }], error: null }) }) };
			}
			return {
				select: () => {
					const b: any = {
						eq: () => b,
						maybeSingle: () => Promise.resolve({ data: existing, error: null }),
						limit: () => b,
					};
					return b;
				},
			};
		});

		await artifactEntitySyncHandler({
			artifact_id: "art-1",
			entities: [{ entity_type: "people", title: "Sam" }],
		} as any);

		expect(mockEmbed).not.toHaveBeenCalled();
	});

	it("embeds a newly-created entity when no existing row matches", async () => {
		(supabase as any).from = vi.fn((table: string) => {
			if (table === "artifact_entity_links") {
				return { upsert: () => ({ select: () => Promise.resolve({ data: [{ id: "link-2" }], error: null }) }) };
			}
			return {
				select: () => {
					const b: any = {
						eq: () => b,
						maybeSingle: () => Promise.resolve({ data: null, error: null }),
						limit: () => Promise.resolve({ data: [], error: null }),
						insert: () => b,
					};
					return b;
				},
				insert: () => ({
					select: () =>
						Promise.resolve({
							data: [{ id: "new-1", entity_type: "people", title: "New Person", description: null, archived: false, properties: {}, tags: [] }],
							error: null,
						}),
				}),
			};
		});

		await artifactEntitySyncHandler({
			artifact_id: "art-2",
			entities: [{ entity_type: "people", title: "New Person" }],
		} as any);

		expect(mockEmbed).toHaveBeenCalledWith("entities", "new-1", { title: "New Person", description: null, properties: {} });
	});
});
