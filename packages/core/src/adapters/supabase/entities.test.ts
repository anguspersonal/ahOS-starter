import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "../fakeSupabase.testkit.js";
import {
	ARTIFACT_ENTITY_LINK_COLUMNS,
	createSupabaseEntityRepository,
	createSupabaseLinkRepository,
	ENTITY_BASE_COLUMNS,
	ENTITY_COLUMNS,
	SCAN_LIMIT,
} from "./entities.js";

describe("createSupabaseEntityRepository", () => {
	it("loadRows retries without aliases/hot and then without local_name/namespace on missing-column errors, and caps scan at SCAN_LIMIT 2000", async () => {
		let attempt = 0;
		const fake = createFakeSupabase(() => {
			attempt++;
			if (attempt === 1) {
				return {
					data: null,
					error: { code: "42703", message: 'column entities.aliases does not exist' },
				};
			}
			if (attempt === 2) {
				return {
					data: null,
					error: { code: "42703", message: 'column entities.local_name does not exist' },
				};
			}
			return {
				data: [
					{
						id: "e1",
						entity_type: "concept",
						title: "Alpha Match",
						description: null,
						archived: false,
						archived_at: null,
						properties: {},
						tags: [],
						source_url: null,
						user_id: "owner-1",
						team_id: null,
						domain_override: null,
						created_at: "2026-01-01T00:00:00Z",
						updated_at: "2026-01-01T00:00:00Z",
					},
				],
				error: null,
			};
		});

		const repo = createSupabaseEntityRepository({ client: fake.client, ownerId: "owner-1" });
		const res = await repo.loadRows({ query: "alpha", limit: 5 });

		expect(fake.calls).toHaveLength(3);
		expect(fake.calls[0].selected).toBe(ENTITY_COLUMNS);
		expect(fake.calls[1].selected).not.toContain("aliases");
		expect(fake.calls[1].selected).toContain("local_name");
		expect(fake.calls[2].selected).toBe(ENTITY_BASE_COLUMNS);
		expect(fake.filtersOf(fake.calls[2], "eq")).toContainEqual(["user_id", "owner-1"]);
		expect(fake.filtersOf(fake.calls[2], "limit")).toEqual([[SCAN_LIMIT]]);
		expect(res.rows).toHaveLength(1);
		expect(res.rows[0].id).toBe("e1");
		expect(res.truncated).toBe(false);
	});

	it("mutateByIds: hard delete removes entity_relationships in both directions first; archive archives them; both scoped to owner", async () => {
		const fake = createFakeSupabase((call) => {
			if (call.table === "entities") {
				return { data: [{ id: "e1", title: "Target" }], error: null };
			}
			return { data: [], error: null };
		});
		const repo = createSupabaseEntityRepository({ client: fake.client, ownerId: "owner-1" });

		const hardDeleted = await repo.mutateByIds(["e1", "e2"], false);
		expect(hardDeleted).toEqual([{ id: "e1", title: "Target" }]);
		expect(fake.calls.slice(0, 3).map((c) => `${c.table}:${c.op}`)).toEqual([
			"entity_relationships:delete",
			"entity_relationships:delete",
			"entities:delete",
		]);
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([["user_id", "owner-1"]]);
		expect(fake.filtersOf(fake.calls[0], "in")).toEqual([["from_entity_id", ["e1", "e2"]]]);
		expect(fake.filtersOf(fake.calls[1], "eq")).toEqual([["user_id", "owner-1"]]);
		expect(fake.filtersOf(fake.calls[1], "in")).toEqual([["to_entity_id", ["e1", "e2"]]]);
		expect(fake.filtersOf(fake.calls[2], "eq")).toEqual([["user_id", "owner-1"]]);
		expect(fake.filtersOf(fake.calls[2], "in")).toEqual([["id", ["e1", "e2"]]]);

		fake.calls.length = 0;
		const archived = await repo.mutateByIds(["e1"], true);
		expect(archived).toEqual([{ id: "e1", title: "Target" }]);
		expect(fake.calls.map((c) => `${c.table}:${c.op}`)).toEqual([
			"entities:update",
			"entity_relationships:update",
			"entity_relationships:update",
		]);
		expect(fake.calls[0].payload).toMatchObject({
			archived: true,
			archived_at: expect.any(String),
		});
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([["user_id", "owner-1"]]);
		expect(fake.calls[1].payload).toEqual({ archived: true });
		expect(fake.filtersOf(fake.calls[1], "eq")).toEqual([["user_id", "owner-1"]]);
		expect(fake.filtersOf(fake.calls[1], "in")).toEqual([["from_entity_id", ["e1"]]]);
		expect(fake.calls[2].payload).toEqual({ archived: true });
		expect(fake.filtersOf(fake.calls[2], "eq")).toEqual([["user_id", "owner-1"]]);
		expect(fake.filtersOf(fake.calls[2], "in")).toEqual([["to_entity_id", ["e1"]]]);
	});

	it("insert and update write the columns toInsert / toUpdate build", async () => {
		const fake = createFakeSupabase(() => ({
			data: [{ id: "e1", title: "Acme", entity_type: "organization", description: null, properties: {} }],
			error: null,
		}));
		const repo = createSupabaseEntityRepository({ client: fake.client, ownerId: "owner-1" });

		await repo.insert([
			{
				title: "Acme",
				entity_type: "organization",
				source_url: "",
				local_name: "",
				namespace: "ahos",
				aliases: ["  Acme Corp ", "acme corp", ""],
				hot: true,
			},
		]);

		expect(fake.calls[0].op).toBe("insert");
		const inserted = (fake.calls[0].payload as Array<Record<string, unknown>>)[0];
		expect(inserted).toMatchObject({
			id: expect.any(String),
			entity_type: "organization",
			title: "Acme",
			description: null,
			archived: false,
			archived_at: null,
			properties: {},
			tags: [],
			source_url: null,
			user_id: "owner-1",
			team_id: null,
			domain_override: null,
			local_name: null,
			namespace: null,
			aliases: ["Acme Corp"],
			hot: true,
		});

		fake.calls.length = 0;
		await repo.update(["e1"], {
			title: "Acme Updated",
			source_url: "",
			namespace: "ahos",
			aliases: ["ACME", "acme"],
			archived: true,
		});

		expect(fake.calls[0].op).toBe("update");
		expect(fake.calls[0].payload).toMatchObject({
			title: "Acme Updated",
			source_url: null,
			namespace: null,
			aliases: ["ACME"],
			archived: true,
			archived_at: expect.any(String),
		});
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([["user_id", "owner-1"]]);
		expect(fake.filtersOf(fake.calls[0], "in")).toEqual([["id", ["e1"]]]);
	});

	it("getEdgeById, findOwnedEntityIds, insertArrangementNodes, insertParticipantEdges, insertProvenanceLinks, and archiveEdge scope to owner (#1501)", async () => {
		const edgeRow = {
			id: "edge-1",
			from_entity_id: "p1",
			to_entity_id: "o1",
			relationship_type: "employed_by",
			valid_from: "2018-01-01T00:00:00.000Z",
			valid_to: null,
			archived: false,
		};
		const fake = createFakeSupabase((call) => {
			if (call.table === "entity_relationships" && call.op === "select") {
				return { data: edgeRow, error: null };
			}
			if (call.table === "entities" && call.op === "select") {
				return { data: [{ id: "o1" }, { id: "p1" }], error: null };
			}
			return { data: [], error: null };
		});
		const repo = createSupabaseEntityRepository({ client: fake.client, ownerId: "owner-1" });

		const edge = await repo.getEdgeById("edge-1", "owner-2");
		expect(edge).toEqual(edgeRow);
		expect(fake.calls[0].table).toBe("entity_relationships");
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([
			["id", "edge-1"],
			["user_id", "owner-2"],
		]);

		const owned = await repo.findOwnedEntityIds(["o1", "p1"], "owner-2");
		expect([...owned]).toEqual(["o1", "p1"]);
		expect(fake.calls[1].table).toBe("entities");
		expect(fake.filtersOf(fake.calls[1], "eq")).toEqual([["user_id", "owner-2"]]);
		expect(fake.filtersOf(fake.calls[1], "in")).toEqual([["id", ["o1", "p1"]]]);

		await repo.insertArrangementNodes(
			[
				{
					id: "n1",
					entity_type: "arrangement",
					title: "PM at Acme",
					description: null,
					properties: { kind: "employment" },
					tags: [],
					archived: false,
					user_id: "owner-2",
					team_id: null,
				},
			],
			"owner-2",
		);
		expect(fake.calls[2].table).toBe("entities");
		expect(fake.calls[2].op).toBe("insert");
		expect(fake.calls[2].payload).toEqual([
			expect.objectContaining({ id: "n1", entity_type: "arrangement", user_id: "owner-2" }),
		]);

		await repo.insertParticipantEdges(
			[
				{
					user_id: "owner-2",
					from_entity_id: "n1",
					to_entity_id: "o1",
					relationship_type: "employer",
					confidence_score: null,
					metadata: {},
					created_by: "entity_promote_edge",
					notes: "note",
					valid_from: null,
					valid_to: null,
				},
			],
			"owner-2",
		);
		expect(fake.calls[3].table).toBe("entity_relationships");
		expect(fake.calls[3].op).toBe("insert");

		await repo.insertProvenanceLinks(
			[
				{
					user_id: "owner-2",
					artifact_id: "a1",
					entity_id: "n1",
					link_type: "primary",
					confidence_score: null,
					created_by: "entity_promote_edge",
					notes: null,
				},
			],
			"owner-2",
		);
		expect(fake.calls[4].table).toBe("artifact_entity_links");
		expect(fake.calls[4].op).toBe("insert");

		await repo.archiveEdge("edge-1", "owner-2");
		expect(fake.calls[5].table).toBe("entity_relationships");
		expect(fake.calls[5].op).toBe("update");
		expect(fake.calls[5].payload).toEqual({ archived: true });
		expect(fake.filtersOf(fake.calls[5], "eq")).toEqual([
			["id", "edge-1"],
			["user_id", "owner-2"],
		]);
	});

	it("findTrackedResources falls back to pre-110 columns when aliases is missing and getTitleById returns trimmed title (#1622)", async () => {
		const recorded: Array<{ selected: string; filters: Array<[string, unknown[]]> }> = [];
		let attempt = 0;
		const client: any = {
			from() {
				const entry = { selected: "", filters: [] as Array<[string, unknown[]]> };
				recorded.push(entry);
				const builder: any = new Proxy(
					{},
					{
						get(_t, prop) {
							if (prop === "select") {
								return (cols: string) => {
									entry.selected = cols;
									return builder;
								};
							}
							if (prop === "maybeSingle") {
								return () =>
									Promise.resolve({ data: { title: "  Tenancy agreement  " }, error: null });
							}
							if (prop === "then") {
								return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
									attempt++;
									if (attempt === 1) {
										return Promise.resolve({
											data: null,
											error: { code: "42703", message: "column entities.aliases does not exist" },
										}).then(res, rej);
									}
									return Promise.resolve({
										data: [
											{
												id: "e1",
												title: "CV",
												properties: { tracked: true, doc_kind: "cv" },
												archived: false,
											},
										],
										error: null,
									}).then(res, rej);
								};
							}
							return (...args: unknown[]) => {
								entry.filters.push([String(prop), args]);
								return builder;
							};
						},
					},
				);
				return builder;
			},
		};

		const repo = createSupabaseEntityRepository({ client, ownerId: "owner-1" });
		const tracked = await repo.findTrackedResources({ entity_id: "e1", limit: 501 });
		expect(tracked).toHaveLength(1);
		expect(recorded[0].selected).toContain("aliases");
		expect(recorded[1].selected).not.toContain("aliases");
		expect(recorded[1].filters).toContainEqual(["contains", ["properties", { tracked: true }]]);
		expect(recorded[1].filters).toContainEqual(["eq", ["archived", false]]);
		expect(recorded[1].filters).toContainEqual(["eq", ["id", "e1"]]);

		const title = await repo.getTitleById("e1");
		expect(title).toBe("Tenancy agreement");
		expect(recorded[2].selected).toBe("title");
	});

	it("scopes entity_relate relationship queries and writes by owner or explicit userId (#1484)", async () => {
		let step = 0;
		const fake = createFakeSupabase(() => {
			step++;
			if (step === 1) return { data: [{ id: "e1", entity_type: "project" }], error: null };
			if (step === 2) return { data: [{ id: "r-prim", to_entity_id: "area-1" }], error: null };
			if (step === 3) return { data: { id: "r-1", archived: false }, error: null };
			if (step === 5) {
				return {
					data: { id: "r-sup", user_id: "u-explicit", valid_from: null, valid_to: null, metadata: {} },
					error: null,
				};
			}
			if (step === 7) return { data: { id: "r-new" }, error: null };
			return { data: null, error: null };
		});

		const repo = createSupabaseEntityRepository({ client: fake.client, ownerId: "owner-1" });
		expect(await repo.findEntityEndpoints(["e1", "e2"], "u-explicit")).toEqual([
			{ id: "e1", entity_type: "project" },
		]);
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([["user_id", "u-explicit"]]);

		expect(await repo.findLivePrimaryContainmentEdges("e1", "u-explicit")).toEqual([
			{ id: "r-prim", to_entity_id: "area-1" },
		]);
		expect(await repo.findRelationshipEdge("e1", "e2", "belongs_to", "u-explicit")).toEqual({
			id: "r-1",
			archived: false,
		});
		await repo.archiveEdgesByIds(["r-prim"], "u-explicit");
		expect(await repo.getRelationshipForSupersession("r-sup", "u-explicit")).toMatchObject({
			id: "r-sup",
		});
		await repo.updateRelationshipEdge("r-1", { archived: false }, "u-explicit");
		expect(
			await repo.insertRelationshipEdge(
				{
					from_entity_id: "e1",
					to_entity_id: "e2",
					relationship_type: "belongs_to",
					confidence_score: 0.9,
					metadata: {},
					created_by: "mcp",
					notes: null,
					valid_from: null,
					valid_to: null,
				},
				"u-explicit",
			),
		).toEqual({ id: "r-new" });
		expect(fake.calls[6].payload).toMatchObject({
			user_id: "u-explicit",
			from_entity_id: "e1",
			to_entity_id: "e2",
		});
	});
});

describe("createSupabaseLinkRepository (#1472)", () => {
	it("get and query read artifact_entity_links scoped to owner with optional filters and limit", async () => {
		const row = {
			id: "l1",
			artifact_id: "a1",
			entity_id: "e1",
			link_type: "mentions",
			confidence_score: 0.85,
			created_by: "derive",
			notes: null,
			created_at: "2026-04-17T00:00:00.000Z",
		};
		let callCount = 0;
		const fake = createFakeSupabase(() => {
			callCount++;
			return {
				data: callCount === 1 ? row : [row],
				error: null,
			};
		});

		const repo = createSupabaseLinkRepository({ client: fake.client, ownerId: "owner-1" });
		const single = await repo.get("l1");
		expect(single).toEqual(row);
		expect(fake.calls[0].table).toBe("artifact_entity_links");
		expect(fake.calls[0].selected).toBe(ARTIFACT_ENTITY_LINK_COLUMNS);
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([
			["user_id", "owner-1"],
			["id", "l1"],
		]);

		const rows = await repo.query({
			artifact_id: "a1",
			entity_id: "e1",
			link_type: "mentions",
			limit: 5,
		});
		expect(rows).toEqual([row]);
		expect(fake.calls[1].table).toBe("artifact_entity_links");
		expect(fake.calls[1].selected).toBe(ARTIFACT_ENTITY_LINK_COLUMNS);
		expect(fake.filtersOf(fake.calls[1], "eq")).toEqual([
			["user_id", "owner-1"],
			["artifact_id", "a1"],
			["entity_id", "e1"],
			["link_type", "mentions"],
		]);
		expect(fake.filtersOf(fake.calls[1], "order")).toEqual([["created_at", { ascending: false }]]);
		expect(fake.filtersOf(fake.calls[1], "limit")).toEqual([[5]]);
	});

	it("create, upsert (with set_artifact_derivation), and delete scope to owner (#1474)", async () => {
		const fake = createFakeSupabase((call) => {
			if (call.op === "insert") {
				return {
					data: [{ id: "l-created", artifact_id: "a1", entity_id: "e1" }],
					error: null,
				};
			}
			if (call.op === "upsert") {
				return {
					data: [
						{ id: "l1", artifact_id: "a1", entity_id: "e1", link_type: "mentioned" },
						{ id: "l2", artifact_id: "a1", entity_id: "e2", link_type: "related" },
						{ id: "l3", artifact_id: "a2", entity_id: "e1", link_type: "related" },
					],
					error: null,
				};
			}
			if (call.op === "delete") {
				return {
					data: [{ id: "l1", artifact_id: "a1", entity_id: "e1" }],
					error: null,
				};
			}
			return { data: [], error: null };
		});

		const repo = createSupabaseLinkRepository({ client: fake.client, ownerId: "owner-1" });

		const created = await repo.create([
			{ artifact_id: "a1", entity_id: "e1", confidence_score: 0.75, created_by: "agent" },
		]);
		expect(created).toEqual([{ id: "l-created", artifact_id: "a1", entity_id: "e1" }]);
		expect(fake.calls[0].table).toBe("artifact_entity_links");
		expect(fake.calls[0].op).toBe("insert");
		expect(fake.calls[0].payload).toEqual([
			{
				user_id: "owner-1",
				artifact_id: "a1",
				entity_id: "e1",
				link_type: "related",
				confidence_score: 0.75,
				created_by: "agent",
				notes: null,
			},
		]);

		const upserted = await repo.upsert(
			[
				{ artifact_id: "a1", entity_id: "e1", link_type: "mentioned" },
				{ artifact_id: "a1", entity_id: "e2" },
				{ artifact_id: "a2", entity_id: "e1" },
			],
			{ markArtifactDerived: true, userId: "owner-2" },
		);
		expect(upserted).toHaveLength(3);
		expect(fake.calls[1].op).toBe("upsert");
		expect(fake.calls[1].options).toEqual({ onConflict: "user_id,artifact_id,entity_id,link_type" });
		expect(fake.rpcCalls).toHaveLength(2);
		expect(fake.rpcCalls[0]).toEqual({
			fn: "set_artifact_derivation",
			args: {
				p_user_id: "owner-2",
				p_artifact_id: "a1",
				p_derivation: {
					status: "completed",
					derived_at: expect.any(String),
					attempts: 1,
					provider: "interactive",
				},
			},
		});
		expect(fake.rpcCalls[1]).toMatchObject({
			fn: "set_artifact_derivation",
			args: { p_user_id: "owner-2", p_artifact_id: "a2" },
		});

		const deleted = await repo.delete("l1", "owner-2");
		expect(deleted).toEqual([{ id: "l1", artifact_id: "a1", entity_id: "e1" }]);
		expect(fake.calls[2].op).toBe("delete");
		expect(fake.filtersOf(fake.calls[2], "eq")).toEqual([
			["user_id", "owner-2"],
			["id", "l1"],
		]);
	});

	describe("upsert leaves omitted optional columns out of the payload (#2295)", () => {
		const ON_CONFLICT = { onConflict: "user_id,artifact_id,entity_id,link_type" };
		const echo = () =>
			createFakeSupabase((call) => {
				if (call.op !== "upsert") return { data: [], error: null };
				const rows = call.payload as Array<Record<string, unknown>>;
				return {
					data: rows.map((row) => ({
						id: `l-${row.entity_id}`,
						artifact_id: row.artifact_id,
						entity_id: row.entity_id,
						link_type: row.link_type,
					})),
					error: null,
				};
			});

		it("a four-field row carries no notes or confidence_score key", async () => {
			const fake = echo();
			const repo = createSupabaseLinkRepository({ client: fake.client, ownerId: "owner-1" });

			await repo.upsert([
				{
					artifact_id: "a1",
					entity_id: "e1",
					link_type: "primary",
					created_by: "ingest_meeting_notes",
				},
			]);

			expect(fake.calls).toHaveLength(1);
			const payload = fake.calls[0].payload as Array<Record<string, unknown>>;
			expect(payload).toEqual([
				{
					user_id: "owner-1",
					artifact_id: "a1",
					entity_id: "e1",
					link_type: "primary",
					created_by: "ingest_meeting_notes",
				},
			]);
			expect(payload[0]).not.toHaveProperty("notes");
			expect(payload[0]).not.toHaveProperty("confidence_score");
		});

		it("a two-field row defaults link_type to related and carries no created_by key", async () => {
			const fake = echo();
			const repo = createSupabaseLinkRepository({ client: fake.client, ownerId: "owner-1" });

			await repo.upsert([{ artifact_id: "a1", entity_id: "e1" }]);

			const payload = fake.calls[0].payload as Array<Record<string, unknown>>;
			expect(payload).toEqual([
				{ user_id: "owner-1", artifact_id: "a1", entity_id: "e1", link_type: "related" },
			]);
			expect(payload[0]).not.toHaveProperty("created_by");
			expect(payload[0]).not.toHaveProperty("notes");
			expect(payload[0]).not.toHaveProperty("confidence_score");
		});

		it("supplied notes, confidence_score and created_by pass through unchanged", async () => {
			const fake = echo();
			const repo = createSupabaseLinkRepository({ client: fake.client, ownerId: "owner-1" });

			await repo.upsert([
				{
					artifact_id: "a1",
					entity_id: "e1",
					link_type: "mentioned",
					confidence_score: 0.4,
					created_by: "agent",
					notes: "seen in minutes",
				},
			]);

			expect(fake.calls[0].payload).toEqual([
				{
					user_id: "owner-1",
					artifact_id: "a1",
					entity_id: "e1",
					link_type: "mentioned",
					confidence_score: 0.4,
					created_by: "agent",
					notes: "seen in minutes",
				},
			]);
		});

		it("a mixed-shape batch issues one upsert per shape, in first-appearance order, and returns every row", async () => {
			const fake = echo();
			const repo = createSupabaseLinkRepository({ client: fake.client, ownerId: "owner-1" });

			const out = await repo.upsert([
				{ artifact_id: "a1", entity_id: "e1", notes: "keep me" },
				{ artifact_id: "a1", entity_id: "e2" },
				{ artifact_id: "a2", entity_id: "e3", notes: "and me" },
			]);

			const upserts = fake.calls.filter((call) => call.op === "upsert");
			expect(upserts).toHaveLength(2);
			for (const call of upserts) {
				expect(call.table).toBe("artifact_entity_links");
				expect(call.options).toEqual(ON_CONFLICT);
			}
			expect(upserts[0].payload).toEqual([
				{ user_id: "owner-1", artifact_id: "a1", entity_id: "e1", link_type: "related", notes: "keep me" },
				{ user_id: "owner-1", artifact_id: "a2", entity_id: "e3", link_type: "related", notes: "and me" },
			]);
			expect(upserts[1].payload).toEqual([
				{ user_id: "owner-1", artifact_id: "a1", entity_id: "e2", link_type: "related" },
			]);
			expect((upserts[1].payload as Array<Record<string, unknown>>)[0]).not.toHaveProperty("notes");
			expect(out.map((row) => row.entity_id).sort()).toEqual(["e1", "e2", "e3"]);
		});

		it("a uniform batch is exactly one upsert call", async () => {
			const fake = echo();
			const repo = createSupabaseLinkRepository({ client: fake.client, ownerId: "owner-1" });

			const out = await repo.upsert([
				{ artifact_id: "a1", entity_id: "e1", created_by: "agent" },
				{ artifact_id: "a1", entity_id: "e2", created_by: "agent" },
				{ artifact_id: "a2", entity_id: "e1", created_by: "agent" },
			]);

			expect(fake.calls.filter((call) => call.op === "upsert")).toHaveLength(1);
			expect(out).toHaveLength(3);
		});

		it("the data == null fallback is applied per group", async () => {
			const fake = createFakeSupabase((call) => {
				const rows = call.payload as Array<Record<string, unknown>>;
				if ("notes" in rows[0]) return { data: null, error: null };
				return {
					data: [{ id: "l-e2", artifact_id: "a1", entity_id: "e2", link_type: "related" }],
					error: null,
				};
			});
			const repo = createSupabaseLinkRepository({ client: fake.client, ownerId: "owner-1" });

			const out = await repo.upsert([
				{ artifact_id: "a1", entity_id: "e1", link_type: "primary", notes: "n" },
				{ artifact_id: "a1", entity_id: "e2" },
			]);

			expect(out).toEqual([
				{ id: "", artifact_id: "a1", entity_id: "e1", link_type: "primary" },
				{ id: "l-e2", artifact_id: "a1", entity_id: "e2", link_type: "related" },
			]);
		});

		it("markArtifactDerived fires once per distinct artifact across groups", async () => {
			const fake = echo();
			const repo = createSupabaseLinkRepository({ client: fake.client, ownerId: "owner-1" });

			await repo.upsert(
				[
					{ artifact_id: "a1", entity_id: "e1", notes: "n" },
					{ artifact_id: "a1", entity_id: "e2" },
					{ artifact_id: "a2", entity_id: "e3" },
				],
				{ markArtifactDerived: true },
			);

			expect(fake.calls.filter((call) => call.op === "upsert")).toHaveLength(2);
			expect(fake.rpcCalls.map((call) => (call.args as { p_artifact_id: string }).p_artifact_id)).toEqual([
				"a1",
				"a2",
			]);
		});

		it("a failing group throws, stops later groups, and marks no artifact derived", async () => {
			const fake = createFakeSupabase((call) => {
				const rows = call.payload as Array<Record<string, unknown>>;
				if (!("notes" in rows[0])) return { data: null, error: { message: "boom" } };
				return { data: [], error: null };
			});
			const repo = createSupabaseLinkRepository({ client: fake.client, ownerId: "owner-1" });

			await expect(
				repo.upsert(
					[
						{ artifact_id: "a1", entity_id: "e1", notes: "n" },
						{ artifact_id: "a1", entity_id: "e2" },
						{ artifact_id: "a2", entity_id: "e3", confidence_score: 0.9 },
					],
					{ markArtifactDerived: true },
				),
			).rejects.toThrow("Upsert artifact_entity_links failed: boom");

			expect(fake.calls.filter((call) => call.op === "upsert")).toHaveLength(2);
			expect(fake.rpcCalls).toHaveLength(0);
		});
	});

	it("relationship CRUD methods scope by user_id when ownerId is set and omit user_id when undefined", async () => {
		const row = {
			id: "rel-1",
			from_entity_id: "e1",
			to_entity_id: "e2",
			relationship_type: "contains",
			confidence_score: 1,
			metadata: {},
		};
		const fake = createFakeSupabase((call) => {
			if (call.op === "select" && call.filters.some((f) => f.op === "order")) {
				return { data: [row], error: null };
			}
			if (call.op === "delete") {
				return { data: [], error: null };
			}
			return { data: row, error: null };
		});

		const scopedRepo = createSupabaseEntityRepository({ client: fake.client, ownerId: "owner-1" });
		await scopedRepo.insertRelationship(row);
		expect(fake.calls[0].payload).toMatchObject({ ...row, user_id: "owner-1" });

		await scopedRepo.getRelationship("rel-1");
		expect(fake.filtersOf(fake.calls[1], "eq")).toEqual([
			["id", "rel-1"],
			["user_id", "owner-1"],
		]);

		await scopedRepo.queryRelationships({ entity_id: "e1", direction: "both", limit: 25 });
		expect(fake.filtersOf(fake.calls[2], "eq")).toEqual([["user_id", "owner-1"]]);
		expect(fake.filtersOf(fake.calls[2], "or")).toEqual([["from_entity_id.eq.e1,to_entity_id.eq.e1"]]);
		expect(fake.filtersOf(fake.calls[2], "order")).toEqual([["created_at", { ascending: false }]]);
		expect(fake.filtersOf(fake.calls[2], "limit")).toEqual([[25]]);

		await scopedRepo.updateRelationship("rel-1", { updated_at: "2026-01-01T00:00:00Z", confidence_score: 0.5 });
		expect(fake.filtersOf(fake.calls[3], "eq")).toEqual([
			["id", "rel-1"],
			["user_id", "owner-1"],
		]);

		await scopedRepo.deleteRelationships({ from_entity_id: "e1", to_entity_id: "e2", relationship_type: "contains" });
		expect(fake.filtersOf(fake.calls[4], "eq")).toEqual([
			["user_id", "owner-1"],
			["from_entity_id", "e1"],
			["to_entity_id", "e2"],
			["relationship_type", "contains"],
		]);

		fake.calls.length = 0;
		const unscopedRepo = createSupabaseEntityRepository({ client: fake.client, ownerId: () => undefined });
		await unscopedRepo.insertRelationship(row);
		expect(fake.calls[0].payload).not.toHaveProperty("user_id");
		await unscopedRepo.getRelationship("rel-1");
		expect(fake.filtersOf(fake.calls[1], "eq")).toEqual([["id", "rel-1"]]);
	});
});



describe("createSupabaseEntityRepository.findByExactTitle (#2294)", () => {
	const row = (id: string, title: string) => ({
		id,
		entity_type: "event",
		title,
		description: null,
		archived: false,
		archived_at: null,
		properties: {},
		tags: [],
		source_url: null,
		user_id: "owner-1",
		team_id: null,
		domain_override: null,
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
	});

	it("matches the title in the query: owner, type, active rows, an escaped ilike with no wildcards, and a small limit", async () => {
		const fake = createFakeSupabase(() => ({
			data: [row("e1", "50%_sync"), row("e2", "50%_SYNC")],
			error: null,
		}));
		const repo = createSupabaseEntityRepository({ client: fake.client, ownerId: "fallback" });

		const rows = await repo.findByExactTitle(
			{ entity_type: "event", title: " 50%_Sync " },
			"owner-1",
		);

		expect(fake.calls).toHaveLength(1);
		const call = fake.calls[0];
		expect(call.table).toBe("entities");
		expect(call.op).toBe("select");
		const eqs = fake.filtersOf(call, "eq");
		expect(eqs).toContainEqual(["user_id", "owner-1"]);
		expect(eqs).toContainEqual(["entity_type", "event"]);
		expect(eqs).toContainEqual(["archived", false]);
		expect(fake.filtersOf(call, "ilike")).toEqual([["title", "50\\%\\_Sync"]]);
		expect(fake.filtersOf(call, "limit")).toEqual([[50]]);
		expect(50).toBeLessThan(SCAN_LIMIT);
		expect(fake.filtersOf(call, "order")).toEqual([
			["updated_at", { ascending: false, nullsFirst: false }],
		]);

		expect(rows.map((r) => r.id)).toEqual(["e1", "e2"]);
	});

	it("drops rows the server over-matched because PostgREST reads `*` as a wildcard", async () => {
		// `ilike 'Q*A'` is `ILIKE 'Q%A'` on the server, so it also returns "Q and A".
		const fake = createFakeSupabase(() => ({
			data: [row("e1", "Q and A"), row("e2", "q*a"), row("e3", "QA")],
			error: null,
		}));
		const repo = createSupabaseEntityRepository({ client: fake.client, ownerId: "owner-1" });

		const rows = await repo.findByExactTitle({ entity_type: "event", title: "Q*A" });

		expect(fake.filtersOf(fake.calls[0], "ilike")).toEqual([["title", "Q*A"]]);
		expect(rows.map((r) => r.id)).toEqual(["e2"]);
	});

	it("honours an explicit limit and escapes a backslash", async () => {
		const fake = createFakeSupabase(() => ({ data: [], error: null }));
		const repo = createSupabaseEntityRepository({ client: fake.client, ownerId: "owner-1" });

		await expect(
			repo.findByExactTitle({ entity_type: "event", title: "a\\b", limit: 5 }),
		).resolves.toEqual([]);

		expect(fake.filtersOf(fake.calls[0], "eq")).toContainEqual(["user_id", "owner-1"]);
		expect(fake.filtersOf(fake.calls[0], "ilike")).toEqual([["title", "a\\\\b"]]);
		expect(fake.filtersOf(fake.calls[0], "limit")).toEqual([[5]]);
	});

	it("surfaces a Supabase error as 'Entities query failed'", async () => {
		const fake = createFakeSupabase(() => ({ data: null, error: { message: "boom" } }));
		const repo = createSupabaseEntityRepository({ client: fake.client, ownerId: "owner-1" });

		await expect(
			repo.findByExactTitle({ entity_type: "event", title: "Sync" }),
		).rejects.toThrow("Entities query failed: boom");
	});
});

describe("createSupabaseEntityRepository.getHotTierCandidates (#2392)", () => {
	it("calls rpc('get_hot_tier_candidates', ...) with user id and parameters and maps the jsonb result", async () => {
		const calls: Array<{ fn: string; params: Record<string, unknown> }> = [];
		const fakeClient = {
			from: createFakeSupabase(() => ({ data: [], error: null })).client.from,
			async rpc(fn: string, params: Record<string, unknown>) {
				calls.push({ fn, params });
				return {
					data: {
						hot_count: 2,
						candidates: [
							{
								id: "e1",
								entity_type: "people",
								title: "Alice",
								aliases: ["Al"],
								mentions: 6,
								last_mention_at: "2026-11-20T10:00:00Z",
							},
						],
					},
					error: null,
				};
			},
		};

		const repo = createSupabaseEntityRepository({
			client: fakeClient as never,
			ownerId: "owner-1",
		});

		const result = await repo.getHotTierCandidates({
			windowStart: "2026-10-22T12:00:00.000Z",
			minMentions: 3,
			limit: 5,
			quietStart: "2026-08-23T12:00:00.000Z",
			excludedSurfaces: ["gmail_ingest", "slack", "slack_dm"],
			entityTypes: ["people", "term"],
		});

		expect(calls).toEqual([
			{
				fn: "get_hot_tier_candidates",
				params: {
					p_user_id: "owner-1",
					p_window_start: "2026-10-22T12:00:00.000Z",
					p_min_mentions: 3,
					p_limit: 5,
					p_quiet_start: "2026-08-23T12:00:00.000Z",
					p_excluded_surfaces: ["gmail_ingest", "slack", "slack_dm"],
					p_entity_types: ["people", "term"],
				},
			},
		]);
		expect(result).toEqual({
			hot_count: 2,
			candidates: [
				{
					id: "e1",
					entity_type: "people",
					title: "Alice",
					aliases: ["Al"],
					mentions: 6,
					last_mention_at: "2026-11-20T10:00:00Z",
				},
			],
		});
	});

	it("throws when rpc returns an error", async () => {
		const fakeClient = {
			from: createFakeSupabase(() => ({ data: [], error: null })).client.from,
			async rpc() {
				return {
					data: null,
					error: { message: "function public.get_hot_tier_candidates does not exist" },
				};
			},
		};

		const repo = createSupabaseEntityRepository({
			client: fakeClient as never,
			ownerId: "owner-1",
		});

		await expect(
			repo.getHotTierCandidates({
				windowStart: "2026-10-22T12:00:00.000Z",
				minMentions: 3,
				limit: 5,
				quietStart: "2026-08-23T12:00:00.000Z",
				excludedSurfaces: ["gmail_ingest"],
				entityTypes: ["people"],
			}),
		).rejects.toThrow("get_hot_tier_candidates failed");
	});

	it("loadRows applies .contains('properties', ...) when properties_contains is set", async () => {
		const fake = createFakeSupabase(() => ({ data: [], error: null }));
		const repo = createSupabaseEntityRepository({ client: fake.client, ownerId: "owner-1" });

		await repo.loadRows({
			entity_type: "arrangement",
			properties_contains: { kind: "job_application" },
			limit: 500,
		});

		expect(fake.filtersOf(fake.calls[0], "eq")).toContainEqual(["entity_type", "arrangement"]);
		expect(fake.filtersOf(fake.calls[0], "contains")).toContainEqual([
			"properties",
			{ kind: "job_application" },
		]);
		expect(fake.filtersOf(fake.calls[0], "limit")).toEqual([[500]]);
	});
});
