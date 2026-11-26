import { describe, it, expect, vi } from "vitest";
import { processSystemJobs, createJobRunnerCadence, type JobRunnerPorts, type SystemJobRow } from "./jobRunner.js";
import type { EntityDerivePorts } from "../../actions/domain/derivePorts.js";
import type { ActionAuditRecord, ActionAuditSink } from "../../actions/types.js";

const OWNER = "11111111-1111-4111-8111-111111111111";

function derivePorts(): EntityDerivePorts {
	return {
		fetchCandidatePage: vi.fn(async () => [
			{ id: "art-10", plain_text: "Valid content string longer than 50 characters for the test run." },
		]),
		fetchArtifactsByIds: vi.fn(async () => []),
		countUnderived: vi.fn(async () => 0),
		generate: vi.fn(async () => ({
			text: JSON.stringify({ entities: [{ entity_type: "concept", title: "Testing", confidence: 0.9 }] }),
			provider: "gemini" as const,
			model: "m",
		})),
		findEntity: vi.fn(async () => null),
		createEntity: vi.fn(async () => "e-10"),
		linkArtifactEntity: vi.fn(async () => undefined),
		createRelationship: vi.fn(async () => undefined),
		saveDerivation: vi.fn(async () => undefined),
		recordDecision: vi.fn(async () => undefined),
	};
}

function jobPorts(jobs: SystemJobRow[], stale: SystemJobRow[] = []): JobRunnerPorts {
	return {
		fetchPendingJobs: vi.fn(async () => jobs),
		fetchStaleJobs: vi.fn(async () => stale),
		claimJob: vi.fn(async (id) => {
			const j = jobs.find((x) => x.id === id);
			return j ? { ...j, status: "processing", current_attempt: (j.current_attempt ?? 0) + 1 } : null;
		}),
		completeJob: vi.fn(async () => undefined),
		failJob: vi.fn(async () => undefined),
	};
}

const mkJob = (over: Partial<SystemJobRow> = {}): SystemJobRow => ({
	id: "job-1",
	user_id: OWNER,
	type: "entity_derive",
	status: "pending",
	payload: {},
	max_retries: 3,
	current_attempt: 0,
	...over,
});

function capturingSink(): { records: ActionAuditRecord[]; auditSink: ActionAuditSink } {
	const records: ActionAuditRecord[] = [];
	const auditSink: ActionAuditSink = (record) => {
		records.push(record);
	};
	return { records, auditSink };
}

describe("processSystemJobs ledger recording (#1415)", () => {
	it("1. records one success ledger entry with caller worker and completes the job", async () => {
		const { records, auditSink } = capturingSink();
		const ports = jobPorts([mkJob({ payload: {} })]);
		const dp = derivePorts();

		const result = await processSystemJobs(ports, dp, { auditSink });

		expect(result).toMatchObject({ processed: 1, completed: 1, failed: 0, retried: 0 });
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			actionId: "entity_derive",
			caller: "worker",
			seam: "action",
			outcome: "success",
			userId: OWNER,
		});
		expect(ports.completeJob).toHaveBeenCalledWith(
			expect.objectContaining({ id: "job-1" }),
			expect.objectContaining({ processed: 1 }),
		);
	});

	it("2. records one error entry when fetchCandidatePage rejects and schedules retry", async () => {
		const { records, auditSink } = capturingSink();
		const dp = derivePorts();
		(dp.fetchCandidatePage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
		const now = Date.parse("2026-10-04T12:00:00Z");
		const ports = jobPorts([mkJob({ payload: {}, current_attempt: 0 })]);

		const result = await processSystemJobs(ports, dp, { now: () => now, auditSink });

		expect(result).toMatchObject({ processed: 1, retried: 1, failed: 0 });
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			actionId: "entity_derive",
			caller: "worker",
			seam: "action",
			outcome: "error",
			userId: OWNER,
		});
		expect(ports.failJob).toHaveBeenCalledWith(
			expect.objectContaining({ id: "job-1" }),
			"db down",
			new Date(now + 60_000).toISOString(),
		);
	});

	it("3. records one validation_error entry on 21 artifact_ids and fails with no retry", async () => {
		const { records, auditSink } = capturingSink();
		const ids = Array.from({ length: 21 }, () => "11111111-1111-4111-8111-111111111111");
		const ports = jobPorts([mkJob({ payload: { artifact_ids: ids } })]);
		const dp = derivePorts();

		const result = await processSystemJobs(ports, dp, { auditSink });

		expect(result).toMatchObject({ processed: 1, failed: 1, retried: 0 });
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			actionId: "entity_derive",
			caller: "worker",
			seam: "action",
			outcome: "validation_error",
			userId: OWNER,
		});
		expect(ports.failJob).toHaveBeenCalledWith(
			expect.objectContaining({ id: "job-1" }),
			expect.stringMatching(/^Invalid entity_derive payload: /),
			null,
		);
		expect(dp.generate).not.toHaveBeenCalled();
	});

	it("4. records no entries for an unknown job type or a job with no user_id", async () => {
		const { records, auditSink } = capturingSink();
		const ports = jobPorts([
			mkJob({ id: "a", type: "future" }),
			mkJob({ id: "b", user_id: null }),
		]);

		const result = await processSystemJobs(ports, derivePorts(), { auditSink });

		expect(result).toMatchObject({ processed: 2, failed: 2 });
		expect(records).toHaveLength(0);
	});

	it("5. createJobRunnerCadence passes runnerOptions.auditSink and records one entry", async () => {
		const { records, auditSink } = capturingSink();
		const cadence = createJobRunnerCadence({
			ports: jobPorts([mkJob({ payload: {} })]),
			derivePorts: derivePorts(),
			runnerOptions: { auditSink },
		});

		await cadence.run();

		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			actionId: "entity_derive",
			caller: "worker",
			seam: "action",
			outcome: "success",
			userId: OWNER,
		});
	});
});
