import { describe, expect, it, vi } from "vitest";
import { createSupabaseEmbeddingStore } from "./embeddingStore.js";

describe("createSupabaseEmbeddingStore", () => {
	it("serialises the vector as JSON and updates <table>.embedding for the given id", async () => {
		let updatedTable = "";
		let updatedPayload: unknown;
		let updatedCol = "";
		let updatedId = "";

		const supabase = {
			from: vi.fn((table: string) => {
				updatedTable = table;
				return {
					update: (payload: unknown) => ({
						eq: (col: string, id: string) => {
							updatedPayload = payload;
							updatedCol = col;
							updatedId = id;
							return Promise.resolve({ error: null });
						},
					}),
				};
			}),
		};

		const store = createSupabaseEmbeddingStore(supabase as any);
		await store.setEmbedding("entities", "e-123", [0.1, 0.2, 0.3]);

		expect(updatedTable).toBe("entities");
		expect(updatedCol).toBe("id");
		expect(updatedId).toBe("e-123");
		expect(updatedPayload).toEqual({ embedding: JSON.stringify([0.1, 0.2, 0.3]) });
	});

	it("throws when the Supabase update returns an error", async () => {
		const supabase = {
			from: vi.fn(() => ({
				update: () => ({
					eq: () => Promise.resolve({ error: { message: "db failure" } }),
				}),
			})),
		};

		const store = createSupabaseEmbeddingStore(supabase as any);
		await expect(store.setEmbedding("artifacts", "a-1", [0.1])).rejects.toThrow("db failure");
	});

	it("selects unembedded rows scoped to user_id and archived=false with keyset cursor", async () => {
		const calls: Array<{ op: string; args: unknown[] }> = [];
		const chain: any = {
			select: (...args: unknown[]) => {
				calls.push({ op: "select", args });
				return chain;
			},
			eq: (...args: unknown[]) => {
				calls.push({ op: "eq", args });
				return chain;
			},
			is: (...args: unknown[]) => {
				calls.push({ op: "is", args });
				return chain;
			},
			order: (...args: unknown[]) => {
				calls.push({ op: "order", args });
				return chain;
			},
			limit: (...args: unknown[]) => {
				calls.push({ op: "limit", args });
				return chain;
			},
			gt: (...args: unknown[]) => {
				calls.push({ op: "gt", args });
				return chain;
			},
			then: (resolve: (v: unknown) => void) =>
				resolve({ data: [{ id: "a-2", title: "Doc 2" }], error: null }),
		};
		const supabase = {
			from: vi.fn(() => chain),
		};

		const store = createSupabaseEmbeddingStore({
			client: supabase as any,
			ownerId: () => "owner-1",
		});
		const rows = await store.selectUnembeddedBatch("artifacts", 25, "a-1");

		expect(rows).toEqual([{ id: "a-2", title: "Doc 2" }]);
		expect(calls).toContainEqual({ op: "eq", args: ["user_id", "owner-1"] });
		expect(calls).toContainEqual({ op: "eq", args: ["archived", false] });
		expect(calls).toContainEqual({ op: "is", args: ["embedding", null] });
		expect(calls).toContainEqual({ op: "gt", args: ["id", "a-1"] });
		expect(calls).toContainEqual({ op: "limit", args: [25] });
	});

	it("counts remaining unembedded rows", async () => {
		const chain: any = {
			select: () => chain,
			eq: () => chain,
			is: () => chain,
			then: (resolve: (v: unknown) => void) => resolve({ count: 7, error: null }),
		};
		const supabase = {
			from: vi.fn(() => chain),
		};

		const store = createSupabaseEmbeddingStore({
			client: supabase as any,
			ownerId: "owner-1",
		});
		const remaining = await store.countRemaining("entities");
		expect(remaining).toBe(7);
	});
});

