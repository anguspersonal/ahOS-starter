import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAction } from "../../actions/defineAction.js";
import { ActionRegistry } from "../../actions/registry.js";
import type { ActionAuditRecord, ActionAuditSink, ActionContext } from "../../actions/types.js";
import { createFakeSupabase } from "../../adapters/fakeSupabase.testkit.js";
import { enqueueActionJob } from "../../adapters/supabase/jobs.js";
import { processSystemJobs, type JobRunnerPorts, type SystemJobRow } from "./jobRunner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OWNER = "00000000-0000-0000-0000-000000000001";
const RO_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function mkJob(overrides: Partial<SystemJobRow> & { id: string }): SystemJobRow {
	return { user_id: OWNER, type: "echo", status: "pending", payload: { v: 1 }, max_retries: 3, current_attempt: 0, error_log: [], ...overrides };
}

function makePorts(pending: SystemJobRow[]) {
	const completed: Array<{ id: string; result: Record<string, unknown> }> = [];
	const failed: Array<{ id: string; message: string; retryAt: string | null }> = [];
	const ports: JobRunnerPorts = {
		fetchPendingJobs: async (limit) => pending.slice(0, limit),
		fetchStaleJobs: async () => [],
		claimJob: async (id) => {
			const row = pending.find((j) => j.id === id);
			return row ? { ...row, status: "processing", current_attempt: (row.current_attempt ?? 0) + 1 } : null;
		},
		completeJob: async (job, result) => { completed.push({ id: job.id, result }); },
		failJob: async (job, message, retryAt) => { failed.push({ id: job.id, message, retryAt }); },
	};
	return { ports, completed, failed };
}

describe("processSystemJobs — ActionRegistry dispatch (#1553)", () => {
	it("runs a worker-exposed action once and emits an audit record with caller='worker' and metadata.job_id", async () => {
		const calls: Array<{ input: { v: number }; ctx: ActionContext }> = [];
		const echo = defineAction({
			id: "echo",
			domain: "system",
			description: "Echoes input",
			schema: z.object({ v: z.number() }),
			annotations: RO_ANNOTATIONS,
			async run(input, ctx) {
				calls.push({ input, ctx });
				return { echoed: input.v };
			},
		});
		const registry = new ActionRegistry();
		registry.register(echo);

		const { ports, completed, failed } = makePorts([mkJob({ id: "job-1", type: "echo", payload: { v: 1 } })]);
		const records: Array<ActionAuditRecord & { metadata?: Record<string, unknown> }> = [];
		const auditSink: ActionAuditSink = (r) => { records.push(r as ActionAuditRecord & { metadata?: Record<string, unknown> }); };

		const counts = await processSystemJobs(ports, registry, { auditSink });
		expect(counts).toEqual({ processed: 1, completed: 1, failed: 0, retried: 0, recovered: 0 });
		expect(failed).toEqual([]);
		expect(completed).toEqual([{ id: "job-1", result: { echoed: 1 } }]);
		expect(calls[0]?.ctx).toMatchObject({ caller: "worker", metadata: { job_id: "job-1" } });
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ actionId: "echo", caller: "worker", outcome: "success", metadata: { job_id: "job-1" } });
	});

	it("fails unknown action ids and actions with expose.worker=false without retrying (retryAt: null)", async () => {
		const clientOnly = defineAction({
			id: "ui_only",
			domain: "system",
			description: "UI-only action",
			schema: z.object({}),
			annotations: RO_ANNOTATIONS,
			expose: { mcp: false, http: false, worker: false, reason: "client_local", note: "Browser view-state action" },
			async run() { return { ok: true }; },
		});
		const registry = new ActionRegistry();
		registry.register(clientOnly);

		const { ports, completed, failed } = makePorts([
			mkJob({ id: "job-unknown", type: "missing_action", payload: {} }),
			mkJob({ id: "job-unexposed", type: "ui_only", payload: {} }),
		]);
		const counts = await processSystemJobs(ports, registry);
		expect(counts).toEqual({ processed: 2, completed: 0, failed: 2, retried: 0, recovered: 0 });
		expect(completed).toEqual([]);
		expect(failed).toEqual([
			{ id: "job-unknown", message: "Unknown job action: missing_action", retryAt: null },
			{ id: "job-unexposed", message: "Action ui_only is not exposed to worker", retryAt: null },
		]);
	});

	it("jobRunner.ts contains zero 'entity_derive' literals and main.ts calls buildRegistry( exactly once", () => {
		const jobRunnerSource = readFileSync(resolve(HERE, "./jobRunner.ts"), "utf8");
		const mainSource = readFileSync(resolve(HERE, "../main.ts"), "utf8");
		expect(jobRunnerSource.match(/entity_derive/g) ?? []).toHaveLength(0);
		expect(mainSource.match(/buildRegistry\(/g) ?? []).toHaveLength(1);
	});

	it("enqueueActionJob inserts { type: 'entity_derive', status: 'pending', payload: input, user_id: userId }", async () => {
		const fake = createFakeSupabase(() => ({ data: [{ id: "job-99" }] }));
		const input = { limit: 5, force: true };
		const result = await enqueueActionJob(fake.client, { actionId: "entity_derive", input, userId: OWNER });
		expect(result).toEqual({ id: "job-99" });
		expect(fake.calls[0]).toMatchObject({
			table: "system_jobs",
			op: "insert",
			payload: { type: "entity_derive", status: "pending", payload: input, user_id: OWNER },
		});
	});
});
