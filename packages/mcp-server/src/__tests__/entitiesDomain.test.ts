import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { entitiesUpdateInput, entitiesUpsertInput } from "@ahkms/core";
import { supabase } from "../supabase.js";
import { buildRegistry } from "@ahkms/core/actions";
import { createSupabaseGraphReadAdapter } from "@ahkms/core/adapters";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";

const entitiesGetHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_get")!).handler(args);
const entitiesQueryHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_query")!).handler(args);

const entityNeighbourhoodHandler = toMcpTool(
	buildRegistry({ graphRead: createSupabaseGraphReadAdapter({ client: supabase as any }) }).get(
		"entity_neighbourhood",
	)!,
).handler;

// ADR-084: entities_get/entities_query/entity_neighbourhood carry the entity's
// resolved `domain` (+ `domain_resolution`), and entities_update/entities_upsert
// accept a settable `domain_override`, validated against DOMAINS. Round trip
// on `entities_get` covers the read side; the write side is covered at the
// zod-schema boundary, same as createTask.test.ts's `due` validation, since
// that boundary is what the MCP SDK actually enforces before a handler runs.

describe("domain_override validation (ADR-084 step 5, ADR-107, `entities_update`)", () => {
	it("accepts all live ENTITY_DOMAINS", () => {
		for (const domain of ["work", "angus", "cross-domain"]) {
			const result = z.object(entitiesUpdateInput).safeParse({
				ids: ["11111111-1111-4111-8111-111111111111"],
				patch: { domain_override: domain },
			});
			expect(result.success).toBe(true);
		}
	});

	it("accepts null to clear the override", () => {
		const result = z.object(entitiesUpdateInput).safeParse({
			ids: ["11111111-1111-4111-8111-111111111111"],
			patch: { domain_override: null },
		});
		expect(result.success).toBe(true);
	});

	it("rejects a domain not in ENTITY_DOMAINS (including 'meta' which belongs to properties.level)", () => {
		for (const invalid of ["meta", "bogus", "personal"]) {
			const result = z.object(entitiesUpdateInput).safeParse({
				ids: ["11111111-1111-4111-8111-111111111111"],
				patch: { domain_override: invalid },
			});
			expect(result.success).toBe(false);
		}
	});
});

describe("domain_override validation (`entities_upsert`)", () => {
	it("rejects a domain not in ENTITY_DOMAINS", () => {
		const result = z.object(entitiesUpsertInput).safeParse({
			entities: [{ title: "Test", domain_override: "meta" }],
		});
		expect(result.success).toBe(false);
	});

	it("accepts all live ENTITY_DOMAINS", () => {
		for (const domain of ["work", "angus", "cross-domain"]) {
			const result = z.object(entitiesUpsertInput).safeParse({
				entities: [{ title: "Test", domain_override: domain }],
			});
			expect(result.success).toBe(true);
		}
	});
});

describe("entities_get carries the resolved domain (ADR-084 step 2 wiring)", () => {
	const origFrom = supabase.from;
	afterEach(() => {
		(supabase as any).from = origFrom;
		vi.restoreAllMocks();
	});

	it("reports domain and domain_resolution from a set domain_override", async () => {
		const row = {
			id: "e1",
			entity_type: "event",
			title: "Wedding",
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
			domain_override: "angus",
		};
		// One builder handles both entities.ts's own select (get) and
		// entityDomain.ts's resolver select — both filter to this same row by id.
		const b: any = {
			select: () => b,
			eq: () => b,
			limit: () => b,
			maybeSingle: async () => ({ data: row, error: null }),
		};
		(supabase as any).from = vi.fn(() => b);

		const res = await entitiesGetHandler({ id: "e1" });

		expect(res.content[0].text).toContain("domain: angus");
		expect(res.content[0].text).toContain("domain_resolution: override");
	});

	it("reports domain: cross-domain and domain_resolution: override from domain_override (ADR-107)", async () => {
		const row = {
			id: "e-cross",
			entity_type: "concept",
			title: "Day Plan Routine",
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
			domain_override: "cross-domain",
		};
		const b: any = {
			select: () => b,
			eq: () => b,
			limit: () => b,
			maybeSingle: async () => ({ data: row, error: null }),
		};
		(supabase as any).from = vi.fn(() => b);

		const res = await entitiesGetHandler({ id: "e-cross" });

		expect(res.content[0].text).toContain("domain: cross-domain");
		expect(res.content[0].text).toContain("domain_resolution: override");
	});

	it("reports domain: cross-domain and domain_resolution: is_self when is_self is true (ADR-107)", async () => {
		const row = {
			id: "self-angus",
			entity_type: "people",
			title: "Angus Hally",
			description: "System owner",
			archived: false,
			archived_at: null,
			properties: { is_self: true },
			tags: [],
			source_url: null,
			user_id: "u1",
			team_id: null,
			created_at: null,
			updated_at: null,
			domain_override: null,
		};
		const b: any = {
			select: () => b,
			eq: () => b,
			limit: () => b,
			maybeSingle: async () => ({ data: row, error: null }),
		};
		(supabase as any).from = vi.fn(() => b);

		const res = await entitiesGetHandler({ id: "self-angus" });

		expect(res.content[0].text).toContain("domain: cross-domain");
		expect(res.content[0].text).toContain("domain_resolution: is_self");
	});

	it("reports unresolved when nothing derives a domain", async () => {
		const row = {
			id: "e2",
			entity_type: "resource",
			title: "Untitled",
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
			domain_override: null,
		};
		const b: any = {
			select: () => b,
			eq: () => b,
			limit: () => b,
			maybeSingle: async () => ({ data: row, error: null }),
		};
		(supabase as any).from = vi.fn(() => b);

		const res = await entitiesGetHandler({ id: "e2" });

		expect(res.content[0].text).toContain("domain: unresolved");
		expect(res.content[0].text).toContain("domain_resolution: unresolved");
	});
});

// QA round 1 (High): entities_get was the only wired read surface with a test
// asserting the new fields. entities_query and entity_neighbourhood are
// covered below — each asserts `domain`/`domain_resolution` on every
// returned/starting entity, including one resolvable and one unresolved case
// per tool, so an off-by-one between rows and their resolved domains would
// fail these.

describe("entities_query carries domain/domain_resolution per row (ADR-084 wiring, QA round 1 High)", () => {
	const origFrom = supabase.from;
	afterEach(() => {
		(supabase as any).from = origFrom;
		vi.restoreAllMocks();
	});

	it("resolves each row independently and keeps rows/domains in the same order", async () => {
		const rows = [
			{
				id: "q1",
				entity_type: "event",
				title: "Work kickoff",
				description: null,
				archived: false,
				archived_at: null,
				properties: {},
				tags: [],
				source_url: null,
				user_id: "u1",
				team_id: null,
				created_at: null,
				updated_at: "2026-01-02T00:00:00Z",
				domain_override: "work",
			},
			{
				id: "q2",
				entity_type: "task",
				title: "Untitled",
				description: null,
				archived: false,
				archived_at: null,
				properties: {},
				tags: [],
				source_url: null,
				user_id: "u1",
				team_id: null,
				created_at: null,
				updated_at: "2026-01-01T00:00:00Z",
				domain_override: null,
			},
		];
		const rowsById = new Map(rows.map((r) => [r.id, r]));

		(supabase as any).from = vi.fn((table: string) => {
			if (table === "entities") {
				return {
					select: (cols: string) => {
						// entities.ts's own list select (entitiesQueryHandler /
						// loadEntityRows) vs. entityDomain.ts's per-id resolver select
						// — routed by their distinct column lists, same pattern
						// entityNeighbourhoodArchive.test.ts already uses.
						if (cols.includes("archived_at")) {
							const b: any = {
								select: () => b,
								order: () => b,
								eq: () => b,
								in: () => b,
								limit: async () => ({ data: rows, error: null }),
							};
							return b;
						}
						let id: string | undefined;
						const b: any = {
							select: () => b,
							eq: (col: string, val: unknown) => {
								if (col === "id") id = val as string;
								return b;
							},
							maybeSingle: async () => ({ data: id ? (rowsById.get(id) ?? null) : null, error: null }),
						};
						return b;
					},
				};
			}
			if (table === "entity_relationships") {
				// Batched primary-parent lookup (QA round 1, Medium): neither row has
				// a parent, so an empty result is correct for both.
				const b: any = {
					select: () => b,
					eq: () => b,
					in: () => b,
					then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
				};
				return b;
			}
			if (table === "user_preferences") {
				return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
			}
			throw new Error(`Unexpected table in test: ${table}`);
		});

		const res = await entitiesQueryHandler({});
		const text = res.content[0].text;

		expect(text).toContain("[q1]");
		expect(text).toContain("[q2]");
		// q1 -> resolvable via its own domain_override; q2 -> unresolved (no
		// override, no parent, no signal match). Order must match `rows`.
		const q1Line = text.split("\n").find((line: string) => line.includes("[q1]"));
		const q2Line = text.split("\n").find((line: string) => line.includes("[q2]"));
		expect(q1Line).toContain("domain: work | domain_resolution: override");
		expect(q2Line).toContain("domain: unresolved | domain_resolution: unresolved");
	});
});

describe("entity_neighbourhood carries domain/domain_resolution on starting entities (ADR-084 wiring, QA round 1 High)", () => {
	const origFrom = supabase.from;
	afterEach(() => {
		(supabase as any).from = origFrom;
		vi.restoreAllMocks();
	});

	it("reports a resolvable starting entity's domain via its own domain_override", async () => {
		const START_ID = "33333333-3333-4333-8333-333333333333";
		const startRow = { id: START_ID, entity_type: "people", title: "Start", properties: {} };
		const resolverRow = { id: START_ID, title: "Start", description: null, tags: [], properties: {}, domain_override: "angus" };

		(supabase as any).from = vi.fn((table: string) => {
			if (table === "entities") {
				return {
					select: (cols: string) => {
						if (cols.includes("domain_override")) {
							const b: any = {
								select: () => b,
								eq: () => b,
								maybeSingle: async () => ({ data: resolverRow, error: null }),
							};
							return b;
						}
						// entityNeighbourhoodHandler's own starting-entity lookup
						// (.eq("user_id",...).eq("id",...).maybeSingle()) and its
						// node-details fetch (.eq("user_id",...).in("id",...)).
						return {
							eq: () => ({
								eq: () => ({ maybeSingle: async () => ({ data: startRow, error: null }) }),
								in: async () => ({ data: [startRow], error: null }),
							}),
						};
					},
				};
			}
			if (table === "entity_relationships") {
				return {
					select: (cols: string) => {
						if (cols === "from_entity_id, to_entity_id") {
							const b: any = {
								eq: () => b,
								in: () => b,
								then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
							};
							return b;
						}
						// The BFS edge query — no edges for this test.
						const b: any = {
							eq: () => b,
							in: () => b,
							then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
						};
						return b;
					},
				};
			}
			if (table === "artifact_entity_links") {
				return { select: () => ({ in: async () => ({ data: [], error: null }) }) };
			}
			if (table === "user_preferences") {
				return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
			}
			throw new Error(`Unexpected table in test: ${table}`);
		});

		const res = await entityNeighbourhoodHandler({ entity_id: START_ID } as any);
		const text = res.content[0].text;
		const parsed = JSON.parse(text.slice(text.indexOf("\n") + 1));

		expect(parsed.entities).toHaveLength(1);
		expect(parsed.entities[0].domain).toBe("angus");
		expect(parsed.entities[0].domain_resolution).toEqual(
			expect.objectContaining({ resolved_by: "override" }),
		);
	});
});
