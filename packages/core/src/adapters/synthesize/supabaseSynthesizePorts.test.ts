import { describe, expect, it } from "vitest";
import {
	createSupabaseSynthesizePorts,
	type SynthesizeSupabaseClient,
} from "./supabaseSynthesizePorts.js";
import { createSynthesizePorts } from "./index.js";

function createMockSupabase(overrides: Record<string, any> = {}): SynthesizeSupabaseClient {
	return {
		from: (table: string) => {
			if (overrides[table]) return overrides[table];
			return {
				select: () => ({
					eq: () => ({
						eq: () => ({
							eq: () => ({
								maybeSingle: async () => ({ data: null, error: null }),
								limit: () => ({ data: [], error: null }),
							}),
							limit: async () => ({ data: [], error: null }),
							maybeSingle: async () => ({ data: null, error: null }),
						}),
						in: () => ({
							eq: () => ({
								eq: async () => ({ data: [], error: null }),
							}),
						}),
					}),
				}),
				update: () => ({
					eq: () => ({
						eq: () => ({
							eq: () => ({
								select: async () => ({ data: [{ id: "mock-id" }], error: null }),
							}),
						}),
					}),
				}),
				insert: async () => ({ error: null }),
			};
		},
	} as unknown as SynthesizeSupabaseClient;
}

describe("supabaseSynthesizePorts", () => {
	it("fetchEntity returns null when entity not found", async () => {
		const mock = createMockSupabase();
		const ports = createSupabaseSynthesizePorts(mock);
		const entity = await ports.fetchEntity("user-1", "entity-1");
		expect(entity).toBeNull();
	});

	it("fetchLinkedArtifacts returns empty array when no links found", async () => {
		const mock = createMockSupabase();
		const ports = createSupabaseSynthesizePorts(mock);
		const artifacts = await ports.fetchLinkedArtifacts("user-1", "entity-1", 5);
		expect(artifacts).toEqual([]);
	});

	it("updateEntityProfile returns true when update succeeds", async () => {
		const mock = createMockSupabase();
		const ports = createSupabaseSynthesizePorts(mock);
		const success = await ports.updateEntityProfile("user-1", {
			entityId: "entity-1",
			description: "New description",
			properties: {},
			expectedUpdatedAt: "2026-10-01T00:00:00Z",
		});
		expect(success).toBe(true);
	});

	it("updateEntityProfile returns false when conflict (0 rows matched)", async () => {
		const mock = {
			from: () => ({
				update: () => ({
					eq: () => ({
						eq: () => ({
							eq: () => ({
								select: async () => ({ data: [], error: null }),
							}),
						}),
					}),
				}),
			}),
		} as unknown as SynthesizeSupabaseClient;

		const ports = createSupabaseSynthesizePorts(mock);
		const success = await ports.updateEntityProfile("user-1", {
			entityId: "entity-1",
			description: "New description",
			properties: {},
			expectedUpdatedAt: "2026-10-01T00:00:00Z",
		});
		expect(success).toBe(false);
	});

	it("recordDecision records system decision without error", async () => {
		let insertedRows: any[] = [];
		const mock = {
			from: (table: string) => ({
				insert: async (rows: any[]) => {
					insertedRows = rows;
					return { error: null };
				},
			}),
		} as unknown as SynthesizeSupabaseClient;

		const ports = createSupabaseSynthesizePorts(mock);
		await ports.recordDecision({
			userId: "user-1",
			entityId: "entity-1",
			artifactIds: ["art-1"],
			provider: "gemini",
			model: "gemini-2.5-flash",
			outcome: "completed",
		});

		expect(insertedRows).toHaveLength(1);
		expect(insertedRows[0].decision_type).toBe("entity_synthesize");
		expect(insertedRows[0].stage).toBe("refine");
		expect(insertedRows[0].decision_payload.outcome).toBe("completed");
	});

	it("createSynthesizePorts returns composite ports with generate", () => {
		const mock = createMockSupabase();
		const ports = createSynthesizePorts(mock, { geminiApiKey: "fake-key" });
		expect(typeof ports.fetchEntity).toBe("function");
		expect(typeof ports.generate).toBe("function");
	});
});
