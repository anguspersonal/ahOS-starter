import { describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "../../adapters/fakeSupabase.testkit.js";
import { createSupabaseJobQueue } from "../../adapters/supabase/jobs.js";
import type { JobListQuery, JobListRow, JobQueuePort } from "../../ports/jobQueue.js";
import type { ActionContext } from "../types.js";
import {
	JOB_LIST_DEFAULT_LIMIT,
	JOB_LIST_PAYLOAD_SUMMARY_MAX,
	createJobListAction,
	formatJobListMcp,
	jobListSchema,
} from "./list.js";

const USER_ID = "user-owner-1";
const ctx: ActionContext = { caller: "test", requestId: "req-1", userId: USER_ID };

function row(overrides: Partial<JobListRow> = {}): JobListRow {
	return {
		id: "job-1",
		type: "entity_derive",
		status: "pending",
		payload: { limit: 5, force: false },
		current_attempt: 0,
		max_retries: 3,
		scheduled_for: null,
		error_log: null,
		created_at: "2026-11-21T09:00:00.000Z",
		...overrides,
	};
}

function makeQueue(rows: JobListRow[] = []) {
	const list = vi.fn(async (_userId: string, _query: JobListQuery) => rows);
	const port: JobQueuePort = {
		list,
		listPending: vi.fn(async () => []),
		enqueue: vi.fn(async () => ({ id: "never" })),
	};
	return { port, list };
}

describe("job_list action (#2329)", () => {
	it("case 1: with no arguments asks the port for the caller's pending and processing rows, limit 50", async () => {
		const { port, list } = makeQueue();
		const out = await createJobListAction(port).run({}, ctx);

		expect(JOB_LIST_DEFAULT_LIMIT).toBe(50);
		expect(list).toHaveBeenCalledTimes(1);
		expect(list).toHaveBeenCalledWith(USER_ID, { statuses: ["pending", "processing"], limit: 50 });
		expect(out.statuses).toEqual(["pending", "processing"]);
		expect(out.limit).toBe(50);
		expect(out.jobs).toEqual([]);
	});

	it("case 1: the adapter reads newest first", async () => {
		const fake = createFakeSupabase(() => ({ data: [] }));
		await createJobListAction(createSupabaseJobQueue(fake.client)).run({}, ctx);

		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]).toMatchObject({ table: "system_jobs", op: "select" });
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([["user_id", USER_ID]]);
		expect(fake.filtersOf(fake.calls[0], "in")).toEqual([["status", ["pending", "processing"]]]);
		expect(fake.filtersOf(fake.calls[0], "order")).toEqual([["created_at", { ascending: false }]]);
		expect(fake.filtersOf(fake.calls[0], "limit")).toEqual([[50]]);
	});

	it("case 2: status, type and limit narrow the read", async () => {
		const { port, list } = makeQueue();
		const out = await createJobListAction(port).run(
			{ status: "failed", type: "entity_derive", limit: 200 },
			ctx,
		);

		expect(list).toHaveBeenCalledWith(USER_ID, {
			statuses: ["failed"],
			type: "entity_derive",
			limit: 200,
		});
		expect(out.statuses).toEqual(["failed"]);
		expect(out.type).toBe("entity_derive");
		expect(out.limit).toBe(200);
	});

	it("case 2: an unknown status and an out-of-range limit are validation errors", () => {
		expect(jobListSchema.safeParse({ status: "queued" }).success).toBe(false);
		expect(jobListSchema.safeParse({ limit: 0 }).success).toBe(false);
		expect(jobListSchema.safeParse({ limit: 201 }).success).toBe(false);
		expect(jobListSchema.safeParse({ limit: 1.5 }).success).toBe(false);
		expect(jobListSchema.safeParse({ type: "" }).success).toBe(false);
		for (const status of ["pending", "processing", "completed", "failed", "cancelled"]) {
			expect(jobListSchema.safeParse({ status }).success).toBe(true);
		}
		expect(jobListSchema.safeParse({ limit: 1 }).success).toBe(true);
		expect(jobListSchema.safeParse({ limit: 200 }).success).toBe(true);
	});

	it("case 3: each row carries the listed fields, the last error and a bounded payload summary, never the payload", async () => {
		const bigPayload = { artifact_ids: Array.from({ length: 40 }, (_, i) => `artifact-${i}`), secret_tail: "TAIL" };
		const { port } = makeQueue([
			row({
				id: "job-big",
				status: "processing",
				payload: bigPayload,
				current_attempt: 2,
				max_retries: 3,
				scheduled_for: "2026-11-21T10:00:00.000Z",
				error_log: ["first failure", "second failure"],
			}),
			row({ id: "job-small" }),
			row({ id: "job-null", payload: null, error_log: [] }),
		]);

		const out = await createJobListAction(port).run({}, ctx);

		expect(Object.keys(out.jobs[0]).sort()).toEqual([
			"created_at",
			"current_attempt",
			"id",
			"last_error",
			"max_retries",
			"payload_summary",
			"scheduled_for",
			"status",
			"type",
		]);
		expect(out.jobs[0]).toMatchObject({
			id: "job-big",
			type: "entity_derive",
			status: "processing",
			created_at: "2026-11-21T09:00:00.000Z",
			scheduled_for: "2026-11-21T10:00:00.000Z",
			current_attempt: 2,
			max_retries: 3,
			last_error: "second failure",
		});
		expect(JOB_LIST_PAYLOAD_SUMMARY_MAX).toBe(200);
		expect(JSON.stringify(bigPayload).length).toBeGreaterThan(200);
		expect(out.jobs[0].payload_summary.length).toBeLessThanOrEqual(200);
		expect(out.jobs[0].payload_summary.startsWith('{"artifact_ids":["artifact-0"')).toBe(true);
		expect(out.jobs[0].payload_summary).not.toContain("TAIL");

		expect(out.jobs[1].payload_summary).toBe('{"limit":5,"force":false}');
		expect(out.jobs[1].last_error).toBeNull();
		expect(out.jobs[2].payload_summary).toBe("");
		expect(out.jobs[2].last_error).toBeNull();

		const text = formatJobListMcp(out);
		expect(text).not.toContain("TAIL");
		expect(JSON.stringify(out)).not.toContain("TAIL");
	});

	it("case 4: the reply opens with counts by type and status for the rows returned", async () => {
		const { port } = makeQueue([
			row({ id: "a", type: "entity_derive", status: "pending" }),
			row({ id: "b", type: "entity_derive", status: "processing" }),
			row({ id: "c", type: "knowledge_search", status: "pending" }),
		]);

		const out = await createJobListAction(port).run({}, ctx);

		expect(out.counts).toEqual({
			total: 3,
			by_type: { entity_derive: 2, knowledge_search: 1 },
			by_status: { pending: 2, processing: 1 },
		});
		const firstLine = formatJobListMcp(out).split("\n")[0];
		expect(firstLine).toBe(
			"3 job(s). By type: entity_derive 2, knowledge_search 1. By status: pending 2, processing 1.",
		);
	});

	it("case 4: an empty result says so on the opening line", async () => {
		const { port } = makeQueue([]);
		const out = await createJobListAction(port).run({ status: "failed" }, ctx);

		expect(out.counts).toEqual({ total: 0, by_type: {}, by_status: {} });
		expect(formatJobListMcp(out).split("\n")[0]).toBe("0 job(s) with status failed.");
	});

	it("case 5: the read is scoped to ctx.userId and a call with no user id throws", async () => {
		const { port, list } = makeQueue();
		const action = createJobListAction(port);

		await action.run({}, { ...ctx, userId: "someone-else" });
		expect(list.mock.calls[0][0]).toBe("someone-else");

		await expect(action.run({}, { caller: "test", requestId: "req-2" })).rejects.toThrow(
			/job_list requires an authenticated userId/,
		);
		await expect(action.run({}, { ...ctx, userId: "   " })).rejects.toThrow(
			/job_list requires an authenticated userId/,
		);
		expect(list).toHaveBeenCalledTimes(1);
	});

	it("case 6: annotations declare a closed-world, idempotent read", () => {
		const action = createJobListAction(makeQueue().port);

		expect(action.id).toBe("job_list");
		expect(action.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it("case 6: the adapter issues one select and no insert, update or delete", async () => {
		const fake = createFakeSupabase(() => ({ data: [row()] }));
		const out = await createJobListAction(createSupabaseJobQueue(fake.client)).run(
			{ status: "pending", type: "entity_derive", limit: 5 },
			ctx,
		);

		expect(out.jobs).toHaveLength(1);
		expect(fake.calls.map((c) => c.op)).toEqual(["select"]);
		expect(fake.rpcCalls).toEqual([]);
	});
});
