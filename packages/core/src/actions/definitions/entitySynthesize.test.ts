import { describe, expect, it } from "vitest";
import {
	createEntitySynthesizeAction,
	executeEntitySynthesize,
} from "./entitySynthesize.js";
import type {
	EntitySynthesizePorts,
	SynthesizeArtifactRecord,
	SynthesizeDecisionRecord,
	SynthesizeEntityRecord,
} from "../domain/synthesizePorts.js";
import {
	DEFAULT_SYNTHESIZE_ANTHROPIC_MODEL,
	DEFAULT_SYNTHESIZE_GEMINI_MODEL,
} from "../domain/synthesize.js";

const TEST_ENTITY_ID = "11111111-1111-4111-8111-111111111111";
const TEST_ART_ID = "22222222-2222-4222-8222-222222222222";

interface FakePortState {
	entity: SynthesizeEntityRecord | null;
	artifacts: SynthesizeArtifactRecord[];
	llmResponseText: string;
	updateSuccess: boolean;
	recordedDecisions: SynthesizeDecisionRecord[];
	updatedProfiles: Array<{
		userId: string;
		entityId: string;
		description: string;
		properties: Record<string, unknown>;
		expectedUpdatedAt: string;
	}>;
	generateCalls: Array<{
		system: string;
		prompt: string;
		provider?: "gemini" | "anthropic";
		model?: string;
	}>;
}

function createFakePorts(initialState: Partial<FakePortState> = {}): {
	ports: EntitySynthesizePorts;
	state: FakePortState;
} {
	const state: FakePortState = {
		entity: {
			id: TEST_ENTITY_ID,
			title: "Ada Lovelace",
			entity_type: "people",
			description: "Pioneer computer programmer",
			properties: { existing_prop: "value" },
			updated_at: "2026-10-01T00:00:00Z",
		},
		artifacts: [
			{
				id: TEST_ART_ID,
				title: "Notes on Analytical Engine",
				plain_text: "Ada wrote the first algorithm intended to be executed by a machine.",
			},
		],
		llmResponseText: JSON.stringify({
			summary: "Ada Lovelace was a pioneer of computer science and creator of the first algorithm.",
			key_facts: ["First computer programmer", "Worked with Charles Babbage"],
			timeline: [{ date: "1843", event: "Published translation and notes on Analytical Engine" }],
		}),
		updateSuccess: true,
		recordedDecisions: [],
		updatedProfiles: [],
		generateCalls: [],
		...initialState,
	};

	const ports: EntitySynthesizePorts = {
		async fetchEntity(userId, entityId) {
			if (state.entity && state.entity.id === entityId) {
				return state.entity;
			}
			return null;
		},
		async fetchLinkedArtifacts(userId, entityId, limit) {
			return state.artifacts.slice(0, limit);
		},
		async generate(request) {
			state.generateCalls.push(request);
			return {
				text: state.llmResponseText,
				provider: request.provider ?? "gemini",
				model: request.model ?? DEFAULT_SYNTHESIZE_GEMINI_MODEL,
			};
		},
		async updateEntityProfile(userId, update) {
			state.updatedProfiles.push({ userId, ...update });
			return state.updateSuccess;
		},
		async recordDecision(decision) {
			state.recordedDecisions.push(decision);
		},
	};

	return { ports, state };
}

import type { ActionContext } from "../types.js";

describe("entitySynthesize action", { timeout: 30_000 }, () => {
	const validContext: ActionContext = {
		caller: "mcp",
		requestId: "req-test",
		userId: "user-abc-123",
	};

	describe("userId requirement", () => {
		it("throws when context has no userId", async () => {
			const { ports } = createFakePorts();
			await expect(
				executeEntitySynthesize(
					{ entity_id: TEST_ENTITY_ID },
					{ caller: "mcp", requestId: "req-test" },
					ports,
				),
			).rejects.toThrow("entity_synthesize requires an owner userId");
		});
	});

	describe("provider and model routing (#1307 H1)", () => {
		it("routes Anthropic provider with an Anthropic model id and never Gemini", async () => {
			const { ports, state } = createFakePorts();
			const result = await executeEntitySynthesize(
				{
					entity_id: TEST_ENTITY_ID,
					provider: "anthropic",
				},
				validContext,
				ports,
			);

			expect(result.status).toBe("completed");
			expect(state.generateCalls).toHaveLength(1);
			const call = state.generateCalls[0];
			expect(call.provider).toBe("anthropic");
			expect(call.model).toBe(DEFAULT_SYNTHESIZE_ANTHROPIC_MODEL);
			expect(call.model).not.toContain("gemini");
		});

		it("routes Gemini provider by default with Gemini model", async () => {
			const { ports, state } = createFakePorts();
			const result = await executeEntitySynthesize(
				{ entity_id: TEST_ENTITY_ID },
				validContext,
				ports,
			);

			expect(result.status).toBe("completed");
			expect(state.generateCalls).toHaveLength(1);
			const call = state.generateCalls[0];
			expect(call.provider).toBe("gemini");
			expect(call.model).toBe(DEFAULT_SYNTHESIZE_GEMINI_MODEL);
		});
	});

	describe("no evidence handling (#1307 H4)", () => {
		it("returns skipped: no evidence and makes zero LLM calls when entity has no linked artifacts", async () => {
			const { ports, state } = createFakePorts({ artifacts: [] });
			const result = await executeEntitySynthesize(
				{ entity_id: TEST_ENTITY_ID },
				validContext,
				ports,
			);

			expect(result.status).toBe("skipped");
			expect(result.reason).toBe("no evidence");
			expect(state.generateCalls).toHaveLength(0);
			expect(state.updatedProfiles).toHaveLength(0);
			expect(state.recordedDecisions).toHaveLength(1);
			expect(state.recordedDecisions[0].outcome).toBe("skipped");
		});

		it("treats artifacts with only empty or whitespace plain_text as no evidence", async () => {
			const { ports, state } = createFakePorts({
				artifacts: [{ id: "22222222-2222-4222-8222-222222222223", title: "Blank", plain_text: "   " }],
			});
			const result = await executeEntitySynthesize(
				{ entity_id: TEST_ENTITY_ID },
				validContext,
				ports,
			);

			expect(result.status).toBe("skipped");
			expect(result.reason).toBe("no evidence");
			expect(state.generateCalls).toHaveLength(0);
		});
	});

	describe("output validation and safety (#1307 H3)", () => {
		it("returns error and writes nothing when LLM returns invalid JSON", async () => {
			const { ports, state } = createFakePorts({
				llmResponseText: "I am unable to synthesize a profile.",
			});
			const result = await executeEntitySynthesize(
				{ entity_id: TEST_ENTITY_ID },
				validContext,
				ports,
			);

			expect(result.status).toBe("error");
			expect(result.reason).toContain("validation failed");
			expect(state.updatedProfiles).toHaveLength(0);
			expect(state.recordedDecisions).toHaveLength(1);
			expect(state.recordedDecisions[0].outcome).toBe("error");
		});

		it("returns error and writes nothing when summary is empty string", async () => {
			const { ports, state } = createFakePorts({
				llmResponseText: JSON.stringify({ summary: "", key_facts: [] }),
			});
			const result = await executeEntitySynthesize(
				{ entity_id: TEST_ENTITY_ID },
				validContext,
				ports,
			);

			expect(result.status).toBe("error");
			expect(result.reason).toContain("validation failed");
			expect(state.updatedProfiles).toHaveLength(0);
		});
	});

	describe("dry run mode", () => {
		it("calls LLM and returns profile without writing back when dry_run is true", async () => {
			const { ports, state } = createFakePorts();
			const result = await executeEntitySynthesize(
				{ entity_id: TEST_ENTITY_ID, dry_run: true },
				validContext,
				ports,
			);

			expect(result.status).toBe("completed");
			expect(result.dry_run).toBe(true);
			expect(result.profile?.summary).toContain("Ada Lovelace");
			expect(state.generateCalls).toHaveLength(1);
			expect(state.updatedProfiles).toHaveLength(0);
			expect(state.recordedDecisions).toHaveLength(1);
			expect(state.recordedDecisions[0].outcome).toBe("completed");
		});
	});

	describe("optimistic concurrency conflict", () => {
		it("returns conflict and does not retry if updated_at changed since read", async () => {
			const { ports, state } = createFakePorts({ updateSuccess: false });
			const result = await executeEntitySynthesize(
				{ entity_id: TEST_ENTITY_ID },
				validContext,
				ports,
			);

			expect(result.status).toBe("conflict");
			expect(result.reason).toBe("Entity was updated concurrently");
			expect(state.updatedProfiles).toHaveLength(1);
			expect(state.recordedDecisions).toHaveLength(1);
			expect(state.recordedDecisions[0].outcome).toBe("conflict");
		});
	});

	describe("successful write-back", () => {
		it("updates entity description, merges synthesis into properties, and records decision", async () => {
			const { ports, state } = createFakePorts();
			const result = await executeEntitySynthesize(
				{ entity_id: TEST_ENTITY_ID },
				validContext,
				ports,
			);

			expect(result.status).toBe("completed");
			expect(result.dry_run).toBe(false);
			expect(state.updatedProfiles).toHaveLength(1);
			const update = state.updatedProfiles[0];
			expect(update.entityId).toBe(TEST_ENTITY_ID);
			expect(update.description).toBe(
				"Ada Lovelace was a pioneer of computer science and creator of the first algorithm.",
			);
			expect(update.properties.existing_prop).toBe("value");
			const synthesis = update.properties.synthesis as Record<string, unknown>;
			expect(synthesis).toBeDefined();
			expect(synthesis.artifacts_used).toEqual([TEST_ART_ID]);
			expect(synthesis.key_facts).toEqual([
				"First computer programmer",
				"Worked with Charles Babbage",
			]);

			expect(state.recordedDecisions).toHaveLength(1);
			expect(state.recordedDecisions[0].outcome).toBe("completed");
			expect(state.recordedDecisions[0].entityId).toBe(TEST_ENTITY_ID);
		});
	});

	describe("createEntitySynthesizeAction wrapper", () => {
		it("creates a CAR action with id entity_synthesize", async () => {
			const { ports } = createFakePorts();
			const action = createEntitySynthesizeAction(ports);
			expect(action.id).toBe("entity_synthesize");
			expect(action.domain).toBe("kg");

			const result = await action.run(
				{ entity_id: TEST_ENTITY_ID, dry_run: true },
				validContext,
			);
			expect(result.status).toBe("completed");
		});
	});

	describe("mcp contract", () => {
		it("1. action description equals MCP text and expose defaults to R4", () => {
			const { ports } = createFakePorts();
			const action = createEntitySynthesizeAction(ports);
			expect(action.description).toBe(
				"Synthesize a concise, factual profile for an entity from evidence in its linked artifacts and update " +
					"entities.description and properties.synthesis. Supports dry_run (makes LLM call and returns profile " +
					"without writing back). Uses Gemini by default, with optional Anthropic routing. Returns plain text with " +
					"LLM output safely quoted.",
			);
			expect(action.expose).toEqual({
				mcp: true,
				http: true,
				ui_agent: true,
				worker: true,
				cli: false,
				a2a: false,
			});
		});

		it("2. formatMcp on a fixture output equals formatSynthesizeResult byte for byte", () => {
			const { ports } = createFakePorts();
			const action = createEntitySynthesizeAction(ports);
			expect(action.formatMcp).toBeDefined();

			const formatted = action.formatMcp!({
				status: "completed",
				entity_id: TEST_ENTITY_ID,
				dry_run: false,
				artifacts_used: ["art-1"],
				provider: "gemini",
				model: "gemini-2.5-flash",
				profile: {
					summary: "A markdown payload: **bold** and [link](http://example.com) and <script>",
					key_facts: ["Fact with *italics*"],
					timeline: [{ date: "2024", event: "Event with # header" }],
				},
			});

			expect(formatted).toBe(
				[
					"Entity Synthesis Result:",
					"Status: completed",
					`Entity ID: ${TEST_ENTITY_ID}`,
					"Dry Run: false",
					"Artifacts Used: 1",
					"Provider: gemini",
					"Model: gemini-2.5-flash",
					"",
					"Synthesized Summary:",
					JSON.stringify("A markdown payload: **bold** and [link](http://example.com) and <script>"),
					"",
					"Key Facts:",
					`- ${JSON.stringify("Fact with *italics*")}`,
					"",
					"Timeline:",
					`- [2024] ${JSON.stringify("Event with # header")}`,
				].join("\n"),
			);
		});

		it("3. building the action with a key resolver that throws does not throw; the first run calls the resolver once", async () => {
			const { createSynthesizePorts } = await import("../../adapters/synthesize/index.js");
			const { ports, state } = createFakePorts();
			let resolverCalls = 0;

			// Building with a throwing resolver must not throw at construction time
			expect(() =>
				createEntitySynthesizeAction(
					createSynthesizePorts({} as any, () => {
						throw new Error("missing key");
					}),
				),
			).not.toThrow();

			// First run calls the resolver once
			const builtPorts = createSynthesizePorts(
				{} as any,
				async () => {
					resolverCalls += 1;
					return { geminiApiKey: "test-key" };
				},
				{
					gemini: {
						models: {
							generateContent: async (args) => {
								state.generateCalls.push({
									system: String(args.config?.systemInstruction ?? ""),
									prompt: args.contents,
									model: args.model,
								});
								return { text: state.llmResponseText };
							},
						},
					},
				},
			);
			const action = createEntitySynthesizeAction({
				...ports,
				generate: builtPorts.generate,
			});
			expect(resolverCalls).toBe(0);

			const result = await action.run(
				{ entity_id: TEST_ENTITY_ID, dry_run: true },
				validContext,
			);
			expect(result.status).toBe("completed");
			expect(resolverCalls).toBe(1);
			expect(state.generateCalls).toHaveLength(1);
		});
	});
});



