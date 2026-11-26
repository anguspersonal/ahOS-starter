import { describe, expect, it, vi } from "vitest";
import { createSupabaseTaskRepository } from "./tasks.js";

function createFakeClient(options?: {
	listData?: unknown[] | null;
	singleData?: unknown | null;
	error?: { message: string } | null;
}) {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const listResult = {
		data: options?.listData !== undefined ? options.listData : [{ id: "task-1", title: "Sample" }],
		error: options?.error ?? null,
	};
	const singleResult = {
		data: options?.singleData !== undefined ? options.singleData : { id: "task-1", title: "Sample" },
		error: options?.error ?? null,
	};

	const chain: Record<string, unknown> = {};
	for (const method of ["select", "order", "limit", "eq", "lte", "gte", "ilike", "in", "insert", "update", "delete"]) {
		chain[method] = vi.fn((...args: unknown[]) => {
			calls.push({ method, args });
			return chain;
		});
	}
	chain.single = vi.fn(async () => {
		calls.push({ method: "single", args: [] });
		return singleResult;
	});
	// Make chain awaitable for query / deleteOne / deleteMany
	// biome-ignore lint/suspicious/noThenProperty: builder mock
	chain.then = (resolve: (value: unknown) => unknown) => resolve(listResult);

	const from = vi.fn((table: string) => {
		calls.push({ method: "from", args: [table] });
		return chain;
	});

	return {
		client: { from } as unknown as Parameters<typeof createSupabaseTaskRepository>[0],
		calls,
	};
}

describe("createSupabaseTaskRepository", () => {
	it("1. query applies every provided filter and wraps query in %...% after trimming", async () => {
		const { client, calls } = createFakeClient();
		const repo = createSupabaseTaskRepository(client);

		await repo.query(
			{
				limit: 10,
				status: "todo",
				priority: "high",
				priority_level: 5,
				entity_id: "ent-1",
				due_before: "2026-10-20T00:00:00.000Z",
				due_after: "2026-10-01T00:00:00.000Z",
				query: "  quarterly review  ",
			},
			"user-1",
		);

		expect(calls).toEqual([
			{ method: "from", args: ["user_tasks"] },
			{ method: "select", args: ["*"] },
			{ method: "order", args: ["created_at", { ascending: false }] },
			{ method: "limit", args: [10] },
			{ method: "eq", args: ["user_id", "user-1"] },
			{ method: "eq", args: ["status", "todo"] },
			{ method: "eq", args: ["priority", "high"] },
			{ method: "eq", args: ["priority_level", 5] },
			{ method: "eq", args: ["entity_id", "ent-1"] },
			{ method: "lte", args: ["due_date", "2026-10-20T00:00:00.000Z"] },
			{ method: "gte", args: ["due_date", "2026-10-01T00:00:00.000Z"] },
			{ method: "ilike", args: ["title", "%quarterly review%"] },
		]);
	});

	it("gets, inserts, updates, deletes one, and bulk deletes tasks", async () => {
		const { client, calls } = createFakeClient({
			listData: [{ id: "t-1" }, { id: "t-2" }],
			singleData: { id: "t-1", title: "Task 1" },
		});
		const repo = createSupabaseTaskRepository(client);

		const got = await repo.get("t-1", "user-1");
		expect(got.id).toBe("t-1");

		const inserted = await repo.insert({ id: "t-1", title: "Task 1" }, "user-1");
		expect(inserted.id).toBe("t-1");

		const updated = await repo.update("t-1", { status: "done" }, "user-1");
		expect(updated.id).toBe("t-1");

		const deletedOne = await repo.deleteOne("t-1", "user-1");
		expect(deletedOne).toEqual(["t-1", "t-2"]);

		const deletedMany = await repo.deleteMany(["t-1", "t-2"], "user-1");
		expect(deletedMany).toEqual(["t-1", "t-2"]);
		expect(calls.some((c) => c.method === "in" && JSON.stringify(c.args) === JSON.stringify(["id", ["t-1", "t-2"]]))).toBe(
			true,
		);
	});

	it("supports entity_ids batch filtering and short-circuits empty entity_ids", async () => {
		const { client, calls } = createFakeClient({ listData: [{ id: "t-1", entity_id: "e-1" }] });
		const repo = createSupabaseTaskRepository(client);

		expect(await repo.query({ entity_ids: [] }, "user-1")).toEqual([]);
		expect(calls).toHaveLength(0);

		const rows = await repo.query({ entity_ids: ["e-1", "e-2"], limit: 500 }, "user-1");
		expect(rows).toHaveLength(1);
		expect(calls).toContainEqual({ method: "limit", args: [500] });
		expect(calls).toContainEqual({ method: "in", args: ["entity_id", ["e-1", "e-2"]] });
	});
});
