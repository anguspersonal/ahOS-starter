import { describe, expect, it } from "vitest";
import {
	graphNodeLevelInputSchema,
	nextZoomLevel,
	createGraphNodeLevelAction,
} from "./nodeLevel.js";
import { createFakeSupabase } from "../../adapters/fakeSupabase.testkit.js";
import { createActionContext } from "../defineAction.js";

describe("graph_node_level core action", () => {
	const validId = "11111111-1111-4111-8111-111111111111";
	const validUserId = "22222222-2222-4222-8222-222222222222";

	// 1. Entity with properties: { zoom_level: 5, keep: "x" }. { direction: "up", delta: 1 } records exactly one update, with payload { properties: { zoom_level: 4, keep: "x" } }. The read and the update both carry eq("id", id) and eq("user_id", ctx.userId). The output has success: true, previous_level: 5 and new_level: 4, and entity is the row the update returned.
	it("moves node up and updates properties with user_id scoping", async () => {
		const existingRow = {
			id: validId,
			title: "Test Node",
			entity_type: "concept",
			properties: { zoom_level: 5, keep: "x" },
		};
		const updatedRow = {
			...existingRow,
			properties: { zoom_level: 4, keep: "x" },
		};

		const fakeDb = createFakeSupabase((call) => {
			if (call.op === "select") {
				return { data: existingRow, error: null };
			}
			if (call.op === "update") {
				return { data: updatedRow, error: null };
			}
			return { data: null, error: null };
		});

		const action = createGraphNodeLevelAction({
			supabase: fakeDb.client,
		});

		const result = await action.run(
			{ id: validId, direction: "up", delta: 1 },
			createActionContext({ userId: validUserId }),
		);

		const updates = fakeDb.calls.filter((c) => c.op === "update");
		expect(updates).toHaveLength(1);
		expect(updates[0].payload).toEqual({
			properties: { zoom_level: 4, keep: "x" },
		});

		const selects = fakeDb.calls.filter((c) => c.op === "select");
		expect(selects).toHaveLength(1);

		for (const call of [selects[0], updates[0]]) {
			expect(call.filters).toEqual(
				expect.arrayContaining([
					{ method: "eq", args: ["id", validId] },
					{ method: "eq", args: ["user_id", validUserId] },
				]),
			);
		}

		expect(result.success).toBe(true);
		expect(result.previous_level).toBe(5);
		expect(result.new_level).toBe(4);
		expect(result.entity).toEqual(updatedRow);
	});

	// 2. Table-driven over nextZoomLevel:
	// - up past 1 gives 1;
	// - down past 14 gives 14;
	// - set with target_level: 8 gives 8;
	// - a row with no numeric zoom_level reads as 1.
	describe("nextZoomLevel table-driven", () => {
		it.each([
			{
				name: "up past 1 gives 1",
				current: 2,
				options: { direction: "up" as const, delta: 5 },
				expected: 1,
			},
			{
				name: "down past 14 gives 14",
				current: 12,
				options: { direction: "down" as const, delta: 5 },
				expected: 14,
			},
			{
				name: "set with target_level: 8 gives 8",
				current: 3,
				options: { direction: "set" as const, target_level: 8 },
				expected: 8,
			},
			{
				name: "a row with no numeric zoom_level reads as 1",
				current: { properties: { keep: "y" } },
				options: { direction: "up" as const, delta: 0 },
				expected: 1,
			},
			{
				name: "a row with undefined properties reads as 1",
				current: {},
				options: { direction: "set" as const, target_level: 8 },
				expected: 8,
			},
		])("$name", ({ current, options, expected }) => {
			expect(nextZoomLevel(current, options)).toBe(expected);
		});
	});

	// 3. { direction: "set" } without target_level fails graphNodeLevelInputSchema.safeParse. Today the web silently sets level 1 (graphLevelActions.ts:89).
	it("fails schema validation when direction is set without target_level", () => {
		const res = graphNodeLevelInputSchema.safeParse({
			id: validId,
			direction: "set",
		});
		expect(res.success).toBe(false);
	});

	// 4. The read answers null: the action rejects with an error whose status is 404, and no update is recorded.
	it("rejects with status 404 when read answers null and records no update", async () => {
		const fakeDb = createFakeSupabase(() => ({
			data: null,
			error: null,
		}));

		const action = createGraphNodeLevelAction({
			supabase: fakeDb.client,
		});

		let thrownErr: any;
		try {
			await action.run(
				{ id: validId, direction: "up" },
				createActionContext({ userId: validUserId }),
			);
		} catch (err) {
			thrownErr = err;
		}

		expect(thrownErr).toBeDefined();
		expect(thrownErr.status).toBe(404);
		const updates = fakeDb.calls.filter((c) => c.op === "update");
		expect(updates).toHaveLength(0);
	});

	// 5. Errors:
	// - the read answers an error: rejects with the PostgREST message, and no update is recorded;
	// - separately, the update answers an error: rejects with the PostgREST message.
	it("rejects with PostgREST message on read error and records no update", async () => {
		const fakeDb = createFakeSupabase(() => ({
			data: null,
			error: { message: "PGRST_READ_FAILED", code: "PGRST001" },
		}));

		const action = createGraphNodeLevelAction({
			supabase: fakeDb.client,
		});

		await expect(
			action.run(
				{ id: validId, direction: "up" },
				createActionContext({ userId: validUserId }),
			),
		).rejects.toThrow(/PGRST_READ_FAILED/);

		const updates = fakeDb.calls.filter((c) => c.op === "update");
		expect(updates).toHaveLength(0);
	});

	it("rejects with PostgREST message on update error", async () => {
		const existingRow = {
			id: validId,
			title: "Node",
			properties: { zoom_level: 5 },
		};

		const fakeDb = createFakeSupabase((call) => {
			if (call.op === "select") {
				return { data: existingRow, error: null };
			}
			return { data: null, error: { message: "PGRST_UPDATE_FAILED", code: "PGRST002" } };
		});

		const action = createGraphNodeLevelAction({
			supabase: fakeDb.client,
		});

		await expect(
			action.run(
				{ id: validId, direction: "up" },
				createActionContext({ userId: validUserId }),
			),
		).rejects.toThrow(/PGRST_UPDATE_FAILED/);
	});

	// 6. The update answers no row (data: null, no error): the action rejects and never resolves with success: true.
	it("rejects when update answers no row without error", async () => {
		const existingRow = {
			id: validId,
			title: "Node",
			properties: { zoom_level: 5 },
		};

		const fakeDb = createFakeSupabase((call) => {
			if (call.op === "select") {
				return { data: existingRow, error: null };
			}
			return { data: null, error: null };
		});

		const action = createGraphNodeLevelAction({
			supabase: fakeDb.client,
		});

		await expect(
			action.run(
				{ id: validId, direction: "up" },
				createActionContext({ userId: validUserId }),
			),
		).rejects.toThrow();
	});

	// 7. Neither ctx.userId nor deps.getUserId is set: rejects before any call is recorded.
	it("rejects before any database call when userId is not available", async () => {
		const fakeDb = createFakeSupabase(() => ({
			data: null,
			error: null,
		}));

		const action = createGraphNodeLevelAction({
			supabase: fakeDb.client,
		});

		await expect(
			action.run({ id: validId, direction: "up" }, createActionContext({ userId: undefined })),
		).rejects.toThrow(/userId/);

		expect(fakeDb.calls).toHaveLength(0);
	});
});
