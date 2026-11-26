import { describe, it, expect } from "vitest";
import { createFakeSupabase } from "../fakeSupabase.testkit.js";
import { createSupabaseJobPorts, createSupabaseJobQueue, enqueueActionJob } from "./jobs.js";

const job = { id: "j1", user_id: "u1", type: "entity_derive", status: "processing", payload: { limit: 3 }, error_log: ["old"] } as const;

describe("enqueueActionJob", () => {
	it("inserts { type: actionId, status: 'pending', payload: input, user_id: userId }", async () => {
		const fake = createFakeSupabase(() => ({ data: [{ id: "job-42" }] }));
		const input = { limit: 5, force: false };
		const res = await enqueueActionJob(fake.client, { actionId: "entity_derive", input, userId: "u1" });
		expect(res).toEqual({ id: "job-42" });
		expect(fake.calls[0]).toMatchObject({
			table: "system_jobs",
			op: "insert",
			payload: { type: "entity_derive", status: "pending", payload: input, user_id: "u1" },
		});
	});
});

describe("createSupabaseJobQueue", () => {
	it("listPending queries system_jobs filtered by user_id, type, and status='pending' with limit", async () => {
		const fake = createFakeSupabase(() => ({
			data: [{ id: "job-1", payload: { limit: 5, force: false } }],
		}));
		const queue = createSupabaseJobQueue(fake.client);
		const rows = await queue.listPending("u1", "entity_derive", 11);
		expect(rows).toEqual([{ id: "job-1", payload: { limit: 5, force: false } }]);
		expect(fake.calls[0]).toMatchObject({
			table: "system_jobs",
			op: "select",
			selected: "id,payload",
		});
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([
			["user_id", "u1"],
			["type", "entity_derive"],
			["status", "pending"],
		]);
		expect(fake.filtersOf(fake.calls[0], "limit")).toEqual([[11]]);
	});

	it("listPending throws when Supabase returns an error", async () => {
		const fake = createFakeSupabase(() => ({ error: { message: "read error" } }));
		const queue = createSupabaseJobQueue(fake.client);
		await expect(queue.listPending("u1", "entity_derive", 11)).rejects.toThrow(/read error/);
	});

	it("list issues one bounded, ordered select scoped to the user and the statuses (#2329)", async () => {
		const stored = {
			id: 7,
			type: "entity_derive",
			status: "processing",
			payload: { limit: 5 },
			current_attempt: 1,
			max_retries: 3,
			scheduled_for: null,
			error_log: ["boom"],
			created_at: "2026-11-21T09:00:00.000Z",
		};
		const fake = createFakeSupabase(() => ({ data: [stored] }));
		const queue = createSupabaseJobQueue(fake.client);
		const rows = await queue.list("u1", { statuses: ["pending", "processing"], limit: 50 });

		expect(rows).toEqual([{ ...stored, id: "7" }]);
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]).toMatchObject({
			table: "system_jobs",
			op: "select",
			selected: "id,type,status,payload,current_attempt,max_retries,scheduled_for,error_log,created_at",
		});
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([["user_id", "u1"]]);
		expect(fake.filtersOf(fake.calls[0], "in")).toEqual([["status", ["pending", "processing"]]]);
		expect(fake.filtersOf(fake.calls[0], "order")).toEqual([["created_at", { ascending: false }]]);
		expect(fake.filtersOf(fake.calls[0], "limit")).toEqual([[50]]);
	});

	it("list narrows by type when one is given", async () => {
		const fake = createFakeSupabase(() => ({ data: [] }));
		const queue = createSupabaseJobQueue(fake.client);
		await queue.list("u1", { statuses: ["failed"], type: "entity_derive", limit: 5 });

		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([
			["user_id", "u1"],
			["type", "entity_derive"],
		]);
		expect(fake.filtersOf(fake.calls[0], "in")).toEqual([["status", ["failed"]]]);
		expect(fake.filtersOf(fake.calls[0], "limit")).toEqual([[5]]);
	});

	it("list throws when Supabase returns an error", async () => {
		const fake = createFakeSupabase(() => ({ error: { message: "read error" } }));
		const queue = createSupabaseJobQueue(fake.client);
		await expect(queue.list("u1", { statuses: ["pending"], limit: 50 })).rejects.toThrow(
			/Failed to list jobs: read error/,
		);
	});

	it("enqueue delegates to enqueueActionJob and inserts a pending system_jobs row", async () => {
		const fake = createFakeSupabase(() => ({ data: [{ id: "job-99" }] }));
		const queue = createSupabaseJobQueue(fake.client);
		const payload = { limit: 5, force: false };
		const res = await queue.enqueue("u1", "entity_derive", payload);
		expect(res).toEqual({ id: "job-99" });
		expect(fake.calls[0]).toMatchObject({
			table: "system_jobs",
			op: "insert",
			payload: { user_id: "u1", type: "entity_derive", status: "pending", payload },
		});
	});
});

describe("createSupabaseJobPorts", () => {
	it("claims atomically: UPDATE is conditional on status=pending and a lost race returns null (#1306 H1)", async () => {
		const fake = createFakeSupabase((call) =>
			call.op === "update" ? { data: [] } : { data: [{ current_attempt: 0 }] },
		);
		const claimed = await createSupabaseJobPorts(fake.client).claimJob("j1");
		expect(claimed).toBeNull();
		const update = fake.calls.find((c) => c.op === "update")!;
		expect(fake.filtersOf(update, "eq")).toEqual(expect.arrayContaining([["id", "j1"], ["status", "pending"]]));
		expect(update.payload).toMatchObject({ status: "processing", current_attempt: 1 });
	});

	it("returns the claimed row when the conditional update matches", async () => {
		const fake = createFakeSupabase((call) =>
			call.op === "update" ? { data: [{ id: "j1", current_attempt: 2 }] } : { data: [{ current_attempt: 1 }] },
		);
		const claimed = await createSupabaseJobPorts(fake.client).claimJob("j1");
		expect(claimed).toMatchObject({ id: "j1" });
	});

	it("claim errors throw instead of being swallowed", async () => {
		const fake = createFakeSupabase(() => ({ error: { message: "db down" } }));
		await expect(createSupabaseJobPorts(fake.client).claimJob("j1")).rejects.toThrow(/db down/);
		await expect(createSupabaseJobPorts(fake.client).fetchPendingJobs(5)).rejects.toThrow(/db down/);
	});

	it("failJob writes error_log as a TEXT[] array and marks failed (not left processing)", async () => {
		const fake = createFakeSupabase(() => ({ data: [{ id: "j1" }] }));
		await createSupabaseJobPorts(fake.client).failJob(job as any, "kaboom", null);
		const update = fake.calls[0];
		expect(update.payload).toEqual({ status: "failed", error_log: ["old", "kaboom"] });
		expect(Array.isArray((update.payload as any).error_log)).toBe(true);
		expect(fake.filtersOf(update, "eq")).toEqual(expect.arrayContaining([["status", "processing"]]));
	});

	it("failJob with retryAt returns the job to pending with a schedule", async () => {
		const fake = createFakeSupabase(() => ({ data: [{ id: "j1" }] }));
		await createSupabaseJobPorts(fake.client).failJob(job as any, "x", "2026-10-04T12:00:00.000Z");
		expect(fake.calls[0].payload).toMatchObject({ status: "pending", scheduled_for: "2026-10-04T12:00:00.000Z" });
	});

	it("completeJob preserves the original payload and nests the result", async () => {
		const fake = createFakeSupabase(() => ({ data: [{ id: "j1" }] }));
		await createSupabaseJobPorts(fake.client).completeJob(job as any, { processed: 1 });
		const payload = (fake.calls[0].payload as any).payload;
		expect(payload).toEqual({ limit: 3, result: { processed: 1 } });
	});

	it("completeJob / failJob throw when the row is no longer processing", async () => {
		const fake = createFakeSupabase(() => ({ data: [] }));
		await expect(createSupabaseJobPorts(fake.client).completeJob(job as any, {})).rejects.toThrow(/no longer processing/);
		await expect(createSupabaseJobPorts(fake.client).failJob(job as any, "m", null)).rejects.toThrow(/no longer processing/);
	});

	it("fetches stale jobs by last_attempt_at", async () => {
		const fake = createFakeSupabase();
		await createSupabaseJobPorts(fake.client).fetchStaleJobs("2026-10-04T00:00:00Z");
		expect(fake.filtersOf(fake.calls[0], "lt")).toEqual([["last_attempt_at", "2026-10-04T00:00:00Z"]]);
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([["status", "processing"]]);
	});
});
