import { describe, it, expect, vi } from "vitest";
import { createFakeSupabase } from "../fakeSupabase.testkit.js";
import {
	createSupabaseDerivePorts,
	ARTIFACT_COLUMNS,
	ARTIFACT_ENTITY_LINKS_TABLE,
	ARTIFACT_ENTITY_LINKS_CONFLICT,
	ENTITY_RELATIONSHIPS_TABLE,
	ENTITY_RELATIONSHIPS_CONFLICT,
	UNDERIVED_FILTER,
} from "./supabaseDerivePorts.js";
import { executeEntityDerive } from "../../actions/definitions/entityDerive.js";
import { createActionContext } from "../../actions/defineAction.js";
import {
	createDeriveLlmPort,
	DEFAULT_DERIVE_ANTHROPIC_MODEL,
	type AnthropicLike,
	type GeminiLike,
} from "./llmDerivePort.js";
import { createDerivePorts } from "./index.js";

const USER = "11111111-1111-4111-8111-111111111111";

describe("createSupabaseDerivePorts (real table names and failure behaviour)", () => {
	it("links go to artifact_entity_links with the composite conflict target (#1306 C2)", async () => {
		const fake = createFakeSupabase();
		await createSupabaseDerivePorts(fake.client).linkArtifactEntity(USER, "art-1", "ent-1", 0.9);

		const call = fake.calls[0];
		expect(call.table).toBe("artifact_entity_links");
		expect(call.table).not.toBe("artifact_entities");
		expect(ARTIFACT_ENTITY_LINKS_TABLE).toBe("artifact_entity_links");
		expect(call.op).toBe("upsert");
		expect(call.options).toEqual({ onConflict: ARTIFACT_ENTITY_LINKS_CONFLICT });
		expect(ARTIFACT_ENTITY_LINKS_CONFLICT).toBe("user_id,artifact_id,entity_id,link_type");
		expect(call.payload).toEqual([
			expect.objectContaining({
				user_id: USER,
				artifact_id: "art-1",
				entity_id: "ent-1",
				link_type: "mentioned",
				created_by: "entity_derive",
			}),
		]);
	});

	it("a non-ok link write (e.g. 404 on a missing table) fails loudly", async () => {
		const fake = createFakeSupabase(() => ({ error: { message: 'relation "artifact_entities" does not exist' } }));
		await expect(createSupabaseDerivePorts(fake.client).linkArtifactEntity(USER, "a", "e", 0.9)).rejects.toThrow(
			/Artifact-entity link failed: relation/,
		);
	});

	it("relationships use entity_relationships with a user-scoped conflict target and confidence_score", async () => {
		const fake = createFakeSupabase();
		await createSupabaseDerivePorts(fake.client).createRelationship(USER, {
			fromEntityId: "e1",
			toEntityId: "e2",
			relationshipType: "employed_by",
			confidence: 0.876,
			artifactId: "art-1",
		});
		const call = fake.calls[0];
		expect(call.table).toBe(ENTITY_RELATIONSHIPS_TABLE);
		expect(call.options).toEqual({ onConflict: ENTITY_RELATIONSHIPS_CONFLICT, ignoreDuplicates: true });
		const row = (call.payload as any[])[0];
		expect(row.confidence_score).toBe(0.88);
		expect(row).not.toHaveProperty("confidence");
		expect(row.user_id).toBe(USER);
	});

	it("a failed relationship write throws instead of being counted", async () => {
		const fake = createFakeSupabase(() => ({ error: { message: "boom" } }));
		await expect(
			createSupabaseDerivePorts(fake.client).createRelationship(USER, {
				fromEntityId: "e1",
				toEntityId: "e2",
				relationshipType: "x",
				confidence: 0.9,
				artifactId: "a",
			}),
		).rejects.toThrow(/Relationship create failed: boom/);
	});

	it("entity lookup is exact-equality, owner-scoped and never a pattern match (#1306 H2)", async () => {
		const fake = createFakeSupabase(() => ({ data: [{ id: "ent-9" }] }));
		const id = await createSupabaseDerivePorts(fake.client).findEntity(USER, "people", "Jane % Doe");
		expect(id).toBe("ent-9");
		const call = fake.calls[0];
		const methods = call.filters.map((f) => f.method);
		expect(methods).not.toContain("ilike");
		expect(methods).not.toContain("like");
		expect(fake.filtersOf(call, "eq")).toEqual(
			expect.arrayContaining([["user_id", USER], ["entity_type", "people"], ["title", "Jane % Doe"], ["archived", false]]),
		);
	});

	it("a failed entity lookup throws (it is not 'not found')", async () => {
		const fake = createFakeSupabase(() => ({ error: { message: "timeout" } }));
		await expect(createSupabaseDerivePorts(fake.client).findEntity(USER, "people", "A")).rejects.toThrow(/timeout/);
	});

	it("createEntity inserts an owner-scoped row and throws on error", async () => {
		const fake = createFakeSupabase();
		const id = await createSupabaseDerivePorts(fake.client).createEntity(USER, {
			entity_type: "people",
			title: "Jane",
			confidence: 0.9,
			properties: { email: "j@example.com" },
		});
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
		const row = (fake.calls[0].payload as any[])[0];
		expect(fake.calls[0].table).toBe("entities");
		expect(row).toMatchObject({ user_id: USER, entity_type: "people", title: "Jane", properties: { email: "j@example.com" } });

		const bad = createFakeSupabase(() => ({ error: { message: "entities_user_id_fkey" } }));
		await expect(
			createSupabaseDerivePorts(bad.client).createEntity(USER, { entity_type: "people", title: "J", confidence: 0.9 }),
		).rejects.toThrow(/entities_user_id_fkey/);
	});

	it("createEntity recovers from concurrent unique_violation (23505) by returning existing id (#1352)", async () => {
		const fake = createFakeSupabase((call) => {
			if (call.op === "insert") {
				return { error: { message: "duplicate key value violates unique constraint", code: "23505" } };
			}
			if (call.op === "select") {
				return { data: [{ id: "existing-entity-123" }] };
			}
			return {};
		});
		const ports = createSupabaseDerivePorts(fake.client);
		const id = await ports.createEntity(USER, {
			entity_type: "people",
			title: "Jane",
			confidence: 0.9,
		});
		expect(id).toBe("existing-entity-123");
	});

	it("createEntity recovers from 23505 via case-insensitive fallback if exact match misses (#1352)", async () => {
		let selectCount = 0;
		const fake = createFakeSupabase((call) => {
			if (call.op === "insert") {
				return { error: { message: "duplicate key value violates unique constraint", code: "23505" } };
			}
			if (call.op === "select") {
				selectCount++;
				if (selectCount === 1) {
					// First select (exact match): returns nothing
					return { data: [] };
				}
				// Second select (ilike fallback): returns existing entity
				return { data: [{ id: "case-insensitive-match-456" }] };
			}
			return {};
		});
		const ports = createSupabaseDerivePorts(fake.client);
		const id = await ports.createEntity(USER, {
			entity_type: "people",
			title: "jane doe",
			confidence: 0.9,
		});
		expect(id).toBe("case-insensitive-match-456");
		expect(selectCount).toBe(2);
	});

	it("candidate pages are filtered in SQL (not in JS), owner-scoped and paged", async () => {
		const fake = createFakeSupabase();
		await createSupabaseDerivePorts(fake.client).fetchCandidatePage({ userId: USER, offset: 50, pageSize: 50 });
		const call = fake.calls[0];
		expect(call.selected).toBe(ARTIFACT_COLUMNS);
		expect(ARTIFACT_COLUMNS).toContain("surface,trust_override");
		expect(fake.filtersOf(call, "eq")).toEqual(expect.arrayContaining([["user_id", USER], ["archived", false]]));
		expect(fake.filtersOf(call, "or")).toEqual([[UNDERIVED_FILTER]]);
		expect(UNDERIVED_FILTER).toContain("processing_metadata->derivation->>status");
		expect(fake.filtersOf(call, "range")).toEqual([[50, 99]]);
	});

	it("selects surface,trust_override on artifact queries and persists low-trust 0.71 confidence while dropping 0.8 (0.60 < 0.7)", async () => {
		const fake = createFakeSupabase((call) => {
			if (call.table === "artifacts" && call.op === "select") {
				return {
					data: [
						{
							id: "1111aaaa-1111-4111-8111-111111111111",
							title: "Forwarded Clip",
							plain_text: "Jane Doe works with Marginal Person at Acme Corp on the new initiative.",
							surface: "whatsapp",
							trust_override: "low",
							lifecycle_stage: "processed",
							processing_metadata: {},
						},
					],
				};
			}
			return { data: [] };
		});

		const dbPorts = createSupabaseDerivePorts(fake.client);
		const out = await executeEntityDerive(
			{
				artifact_id: "1111aaaa-1111-4111-8111-111111111111",
				limit: 5,
				force: false,
			},
			createActionContext({ userId: USER, caller: "worker" }),
			{
				...dbPorts,
				generate: async () => ({
					text: JSON.stringify({
						entities: [
							{ entity_type: "people", title: "Marginal Person", confidence: 0.8, ego_salience: 0.8 },
							{ entity_type: "people", title: "Jane Doe", confidence: 0.95, ego_salience: 0.9 },
						],
						relationships: [],
					}),
					provider: "gemini",
					model: "gemini-2.5-flash",
				}),
			},
		);

		expect(fake.calls[0].selected).toContain("surface,trust_override");
		expect(out).toMatchObject({
			processed: 1,
			entities_created: 1,
			entities_linked: 1,
			failed: 0,
		});
		const entityInsert = fake.calls.find((c) => c.table === "entities" && c.op === "insert");
		expect((entityInsert?.payload as any[])[0]).toMatchObject({
			title: "Jane Doe",
			properties: { confidence: 0.71 },
		});
		const linkUpsert = fake.calls.find((c) => c.table === "artifact_entity_links" && c.op === "upsert");
		expect((linkUpsert?.payload as any[])[0]).toMatchObject({
			confidence_score: 0.71,
		});
	});

	it("saveDerivation merges via the set_artifact_derivation RPC and fails when no row updates", async () => {
		const fake = createFakeSupabase();
		const ports = createSupabaseDerivePorts(fake.client);
		const rec = { derived_at: "2026-10-04T00:00:00Z", status: "completed" as const, attempts: 1 };
		await ports.saveDerivation(USER, "art-1", rec);
		expect(fake.rpcCalls[0]).toEqual({
			fn: "set_artifact_derivation",
			args: { p_user_id: USER, p_artifact_id: "art-1", p_derivation: rec },
		});

		fake.setRpcResponder(() => ({ data: 0 }));
		await expect(ports.saveDerivation(USER, "art-1", rec)).rejects.toThrow(/no artifact row updated/);
		fake.setRpcResponder(() => ({ error: { message: "rpc missing" } }));
		await expect(ports.saveDerivation(USER, "art-1", rec)).rejects.toThrow(/rpc missing/);
	});

	it("recordDecision writes a system_decisions row (ADR-079 / ADR-101 §4)", async () => {
		const fake = createFakeSupabase();
		await createSupabaseDerivePorts(fake.client).recordDecision({
			userId: USER,
			artifactId: "art-1",
			provider: "gemini",
			model: "m",
			confidence: 0.9,
			entities: [{ id: "e1", title: "Jane", entity_type: "people", created: true }],
			relationships: [],
		});
		const call = fake.calls[0];
		expect(call.table).toBe("system_decisions");
		expect((call.payload as any[])[0]).toMatchObject({
			user_id: USER,
			artifact_id: "art-1",
			decision_type: "entity_derive",
			stage: "extract",
			status: "auto_applied",
		});
	});

	it("recordDecision branches status and governance fields for mid-confidence (0.55..0.89) pending clarifications (#2121)", async () => {
		const fake = createFakeSupabase();
		await createSupabaseDerivePorts(fake.client).recordDecision({
			userId: USER,
			artifactId: "art-mid",
			provider: "gemini",
			model: "m",
			confidence: 0.72,
			judge_probabilities: { "entity:people:Jane": 0.72 },
			entities: [{ id: "e1", title: "Jane", entity_type: "people", created: true }],
			relationships: [],
		});
		const call = fake.calls[0];
		expect(call.table).toBe("system_decisions");
		expect((call.payload as any[])[0]).toMatchObject({
			user_id: USER,
			artifact_id: "art-mid",
			decision_type: "entity_derive",
			stage: "extract",
			status: "pending",
			requires_user_action: true,
			user_visible: true,
			review_type: "clarification",
			decision_payload: expect.objectContaining({
				judge_probabilities: { "entity:people:Jane": 0.72 },
			}),
		});
	});
});

describe("createDeriveLlmPort", () => {
	it("defaults the Anthropic model to claude-haiku-4-5, not the retired 3.5 haiku (#1306 H5)", async () => {
		const create = vi.fn(async () => ({ content: [{ type: "text", text: "{}" }] }));
		const run = createDeriveLlmPort({ anthropicApiKey: "k", defaultProvider: "anthropic" }, {
			anthropic: { messages: { create } } as AnthropicLike,
		});
		const out = await run({ system: "s", prompt: "p" });
		expect(DEFAULT_DERIVE_ANTHROPIC_MODEL).toBe("claude-haiku-4-5-20251001");
		expect(out.model).toBe("claude-haiku-4-5-20251001");
		expect((create.mock.calls[0] as any[])[0].model).not.toContain("claude-3-5-haiku");
	});

	it("falls back to Anthropic when no Gemini key exists, and never puts a key in a URL", async () => {
		const create = vi.fn(async () => ({ content: [{ type: "text", text: "hi" }] }));
		const run = createDeriveLlmPort({ anthropicApiKey: "secret-key" }, { anthropic: { messages: { create } } as AnthropicLike });
		const out = await run({ system: "s", prompt: "p" });
		expect(out.provider).toBe("anthropic");
		expect(JSON.stringify(create.mock.calls)).not.toContain("secret-key");
	});

	it("calls Gemini through the SDK with a system instruction and JSON mime type", async () => {
		const generateContent = vi.fn(async () => ({ text: '{"entities":[]}' }));
		const run = createDeriveLlmPort({ geminiApiKey: "g" }, { gemini: { models: { generateContent } } as GeminiLike });
		const out = await run({ system: "SYS", prompt: "P" });
		expect(out).toEqual({ text: '{"entities":[]}', provider: "gemini", model: "gemini-2.5-flash" });
		expect(generateContent).toHaveBeenCalledWith(
			expect.objectContaining({
				contents: "P",
				config: expect.objectContaining({ systemInstruction: "SYS", responseMimeType: "application/json" }),
			}),
		);
	});

	it("transparently retries with gemini-3.8-flash when gemini-2.5-flash is blocked for new Google API keys", async () => {
		const generateContent = vi
			.fn()
			.mockRejectedValueOnce(
				new Error(
					"This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features and improvements.",
				),
			)
			.mockResolvedValueOnce({ text: '{"entities":[{"title":"Alice"}]}' });
		const run = createDeriveLlmPort({ geminiApiKey: "g" }, { gemini: { models: { generateContent } } as GeminiLike });
		const out = await run({ system: "SYS", prompt: "P" });
		expect(out).toEqual({
			text: '{"entities":[{"title":"Alice"}]}',
			provider: "gemini",
			model: "gemini-3.8-flash",
		});
		expect(generateContent).toHaveBeenCalledTimes(2);
		expect((generateContent.mock.calls[0] as any[])[0].model).toBe("gemini-2.5-flash");
		expect((generateContent.mock.calls[1] as any[])[0].model).toBe("gemini-3.8-flash");
	});

	it("provider errors propagate instead of being turned into a skip", async () => {
		const generateContent = vi.fn(async () => {
			throw new Error("429 quota");
		});
		const run = createDeriveLlmPort({ geminiApiKey: "g" }, { gemini: { models: { generateContent } } as GeminiLike });
		await expect(run({ system: "s", prompt: "p" })).rejects.toThrow("429 quota");
	});

	it("an explicit provider without its key fails loudly", async () => {
		const run = createDeriveLlmPort({ anthropicApiKey: "k" });
		await expect(run({ system: "s", prompt: "p", provider: "gemini" })).rejects.toThrow(/GEMINI_API_KEY not set/);
	});

	it("wiring fails when no provider key is configured", () => {
		expect(() => createDeriveLlmPort({})).toThrow(/GEMINI_API_KEY or ANTHROPIC_API_KEY/);
	});
});

describe("createDerivePorts (the code that ships)", () => {
	it("assembles every port from a client and explicit config, reading no environment", async () => {
		vi.stubEnv("GEMINI_API_KEY", "should-not-be-read");
		const fake = createFakeSupabase();
		const ports = createDerivePorts(fake.client, { anthropicApiKey: "k" }, {
			anthropic: { messages: { create: async () => ({ content: [{ type: "text", text: "x" }] }) } } as AnthropicLike,
		});
		for (const m of [
			"fetchCandidatePage",
			"fetchArtifactsByIds",
			"countUnderived",
			"generate",
			"findEntity",
			"createEntity",
			"linkArtifactEntity",
			"createRelationship",
			"saveDerivation",
			"recordDecision",
		] as const) {
			expect(typeof ports[m]).toBe("function");
		}
		expect((await ports.generate({ system: "s", prompt: "p" })).provider).toBe("anthropic");
		vi.unstubAllEnvs();
	});
});
