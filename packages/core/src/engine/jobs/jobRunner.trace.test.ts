import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { executeAction, setDefaultAuditSink, stderrAuditSink } from "../../actions/adapters/direct.js";
import { defineAction } from "../../actions/defineAction.js";
import { ActionRegistry } from "../../actions/registry.js";
import { noopActionScope, setActionScope } from "../../actions/scope.js";
import type { ActionAuditRecord, ActionAuditSink } from "../../actions/types.js";
import { configureEngineActionScope } from "../main.js";
import { processSystemJobs, type JobRunnerPorts, type SystemJobRow } from "./jobRunner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OWNER = "11111111-1111-4111-8111-111111111111";
const RO_ANNOTATIONS = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

function makePorts(pending: SystemJobRow[]) {
	const completed: Array<{ id: string; result: Record<string, unknown> }> = [];
	const failed: Array<{ id: string; message: string; retryAt: string | null }> = [];
	const ports: JobRunnerPorts = {
		fetchPendingJobs: async (limit) => pending.slice(0, limit),
		fetchStaleJobs: async () => [],
		claimJob: async (id) => {
			const row = pending.find((j) => j.id === id);
			return row
				? { ...row, status: "processing", current_attempt: (row.current_attempt ?? 0) + 1 }
				: null;
		},
		completeJob: async (job, result) => {
			completed.push({ id: job.id, result });
		},
		failJob: async (job, message, retryAt) => {
			failed.push({ id: job.id, message, retryAt });
		},
	};
	return { ports, completed, failed };
}

describe("Engine job runner trace_id correlation (#1468)", () => {
	beforeEach(() => {
		configureEngineActionScope();
	});

	afterEach(() => {
		setActionScope(noopActionScope);
		setDefaultAuditSink(stderrAuditSink);
	});

	it("runs a job whose action dispatches a nested action with traceId equal to job.id and nested parentRequestId equal to outer requestId", async () => {
		const nestedAction = defineAction({
			id: "nested_step",
			description: "Nested child action invoked inside a job",
			schema: z.object({ value: z.string() }),
			annotations: RO_ANNOTATIONS,
			run: async (input, ctx) => ({
				echoed: input.value,
				nestedRequestId: ctx.requestId,
				nestedParentRequestId: ctx.parentRequestId,
				nestedTraceId: ctx.traceId,
			}),
		});

		const jobAction = defineAction({
			id: "job_parent",
			description: "Parent job action that dispatches a nested action",
			schema: z.object({ value: z.string() }),
			annotations: RO_ANNOTATIONS,
			run: async (input) => {
				const childResult = await executeAction(nestedAction, { value: input.value });
				return { ok: true, childResult };
			},
		});

		const registry = new ActionRegistry();
		registry.register(jobAction);
		registry.register(nestedAction);

		const jobId = "77777777-7777-4777-8777-777777777777";
		const { ports, completed, failed } = makePorts([
			{
				id: jobId,
				user_id: OWNER,
				type: "job_parent",
				status: "pending",
				payload: { value: "hello" },
				max_retries: 3,
				current_attempt: 0,
			},
		]);

		const records: ActionAuditRecord[] = [];
		const auditSink: ActionAuditSink = (record) => {
			records.push(record);
		};

		const counts = await processSystemJobs(ports, registry, { auditSink });
		expect(counts).toEqual({
			processed: 1,
			completed: 1,
			failed: 0,
			retried: 0,
			recovered: 0,
		});
		expect(failed).toEqual([]);
		expect(completed).toHaveLength(1);

		expect(records).toHaveLength(2);
		const outerRec = records.find((r) => r.actionId === "job_parent")!;
		const nestedRec = records.find((r) => r.actionId === "nested_step")!;

		expect(outerRec).toBeDefined();
		expect(nestedRec).toBeDefined();
		expect(outerRec.traceId).toBe(jobId);
		expect(nestedRec.traceId).toBe(jobId);
		expect(outerRec.parentRequestId).toBeNull();
		expect(nestedRec.parentRequestId).toBe(outerRec.requestId);
	});

	it("isolates traceId per job when processing multiple jobs in a batch", async () => {
		const childAction = defineAction({
			id: "child_op",
			description: "Child operation",
			schema: z.object({ tag: z.string() }),
			annotations: RO_ANNOTATIONS,
			run: async (input) => ({ tag: input.tag }),
		});

		const parentAction = defineAction({
			id: "parent_op",
			description: "Parent operation",
			schema: z.object({ tag: z.string() }),
			annotations: RO_ANNOTATIONS,
			run: async (input) => executeAction(childAction, { tag: input.tag }),
		});

		const registry = new ActionRegistry();
		registry.register(parentAction);
		registry.register(childAction);

		const jobId1 = "11111111-2222-4333-8444-555555555555";
		const jobId2 = "66666666-7777-4888-8999-aaaaaaaaaaaa";
		const { ports } = makePorts([
			{
				id: jobId1,
				user_id: OWNER,
				type: "parent_op",
				status: "pending",
				payload: { tag: "first" },
			},
			{
				id: jobId2,
				user_id: OWNER,
				type: "parent_op",
				status: "pending",
				payload: { tag: "second" },
			},
		]);

		const records: ActionAuditRecord[] = [];
		await processSystemJobs(ports, registry, {
			auditSink: (rec) => {
				records.push(rec);
			},
		});

		expect(records).toHaveLength(4);
		const job1Records = records.filter((r) => r.traceId === jobId1);
		const job2Records = records.filter((r) => r.traceId === jobId2);
		expect(job1Records).toHaveLength(2);
		expect(job2Records).toHaveLength(2);

		const job1Parent = job1Records.find((r) => r.actionId === "parent_op")!;
		const job1Child = job1Records.find((r) => r.actionId === "child_op")!;
		expect(job1Child.parentRequestId).toBe(job1Parent.requestId);

		const job2Parent = job2Records.find((r) => r.actionId === "parent_op")!;
		const job2Child = job2Records.find((r) => r.actionId === "child_op")!;
		expect(job2Child.parentRequestId).toBe(job2Parent.requestId);
	});

	it("installs the AsyncLocalStorage action scope in engine/main.ts before starting the runner", () => {
		const mainSrc = readFileSync(resolve(HERE, "../main.ts"), "utf8");
		expect(mainSrc).toContain("node:async_hooks");
		const bootSlice = mainSrc.slice(mainSrc.indexOf("async function bootEngine()"));
		const scopeIdx = bootSlice.indexOf("configureEngineActionScope(");
		const startIdx = bootSlice.indexOf("runner.start(");
		expect(scopeIdx).toBeGreaterThan(0);
		expect(startIdx).toBeGreaterThan(scopeIdx);
	});
});
