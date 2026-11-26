import { describe, it, expect, vi } from "vitest";
import { processSystemJobs, createJobRunnerCadence, nextRetryAt, type JobRunnerPorts, type SystemJobRow } from "./jobRunner.js";
import { EngineRunner } from "../runner.js";
import { EngineLock, type SchedulerLockPort } from "../lock.js";
import { EngineRunLog, type SchedulerRunLogPort } from "../runLog.js";
import type { EntityDerivePorts } from "../../actions/domain/derivePorts.js";

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

function jobPorts(jobs: SystemJobRow[], stale: SystemJobRow[] = []): JobRunnerPorts & { claimed: string[] } {
	const claimed: string[] = [];
	return {
		claimed,
		fetchPendingJobs: vi.fn(async () => jobs),
		fetchStaleJobs: vi.fn(async () => stale),
		claimJob: vi.fn(async (id) => {
			claimed.push(id);
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
	payload: { artifact_id: "11111111-1111-4111-8111-111111111111", limit: 5 },
	max_retries: 3,
	current_attempt: 0,
	...over,
});

describe("processSystemJobs", { timeout: 30_000 }, () => {
	it("claims, runs entity_derive as the job owner and completes with the result", async () => {
		const ports = jobPorts([mkJob({ payload: {} })]);
		const dp = derivePorts();
		const result = await processSystemJobs(ports, dp);
		expect(result).toMatchObject({ processed: 1, completed: 1, failed: 0 });
		expect(ports.completeJob).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1" }), expect.objectContaining({ processed: 1 }));
		expect(dp.fetchCandidatePage).toHaveBeenCalledWith(expect.objectContaining({ userId: OWNER }));
	});

	it("skips a job whose claim was lost to another runner (no double processing)", async () => {
		const ports = jobPorts([mkJob()]);
		(ports.claimJob as any).mockResolvedValue(null);
		const dp = derivePorts();
		const result = await processSystemJobs(ports, dp);
		expect(result.processed).toBe(0);
		expect(dp.generate).not.toHaveBeenCalled();
		expect(ports.completeJob).not.toHaveBeenCalled();
	});

	it("marks unknown job types and missing owners failed with no retry", async () => {
		const ports = jobPorts([mkJob({ id: "a", type: "future" }), mkJob({ id: "b", user_id: null })]);
		const result = await processSystemJobs(ports, derivePorts());
		expect(result.failed).toBe(2);
		expect(ports.failJob).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "Unknown job type: future", null);
		expect(ports.failJob).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }), expect.stringContaining("no user_id"), null);
	});

	it("rejects an invalid payload (e.g. 21 artifact_ids) without calling the LLM", async () => {
		const ids = Array.from({ length: 21 }, () => "11111111-1111-4111-8111-111111111111");
		const ports = jobPorts([mkJob({ payload: { artifact_ids: ids } })]);
		const dp = derivePorts();
		const result = await processSystemJobs(ports, dp);
		expect(result.failed).toBe(1);
		expect(dp.generate).not.toHaveBeenCalled();
	});

	it("a thrown run is failed-for-retry while attempts remain, then terminal (not left processing)", async () => {
		const dp = derivePorts();
		(dp.fetchCandidatePage as any).mockRejectedValue(new Error("db down"));
		const now = Date.parse("2026-10-04T12:00:00Z");

		const first = jobPorts([mkJob({ payload: {}, current_attempt: 0 })]);
		const r1 = await processSystemJobs(first, dp, { now: () => now });
		expect(r1).toMatchObject({ retried: 1, failed: 0 });
		expect(first.failJob).toHaveBeenCalledWith(expect.anything(), "db down", new Date(now + 60_000).toISOString());

		const last = jobPorts([mkJob({ payload: {}, current_attempt: 2 })]);
		const r2 = await processSystemJobs(last, dp, { now: () => now });
		expect(r2).toMatchObject({ retried: 0, failed: 1 });
		expect(last.failJob).toHaveBeenCalledWith(expect.anything(), "db down", null);
	});

	it("recovers stale processing jobs (retry or fail by attempts)", async () => {
		const stale = [mkJob({ id: "s1", status: "processing", current_attempt: 1 }), mkJob({ id: "s2", status: "processing", current_attempt: 3 })];
		const ports = jobPorts([], stale);
		const result = await processSystemJobs(ports, derivePorts(), { now: () => 1_000_000 });
		expect(result.recovered).toBe(2);
		expect((ports.failJob as any).mock.calls[0][2]).not.toBeNull();
		expect((ports.failJob as any).mock.calls[1][2]).toBeNull();
	});

	it("nextRetryAt backs off linearly and stops at max_retries", () => {
		expect(nextRetryAt(mkJob({ current_attempt: 1 }), 0, 1000)).toBe(new Date(1000).toISOString());
		expect(nextRetryAt(mkJob({ current_attempt: 2 }), 0, 1000)).toBe(new Date(2000).toISOString());
		expect(nextRetryAt(mkJob({ current_attempt: 3 }), 0, 1000)).toBeNull();
	});
});

describe("jobs cadence registration (#1306 C3)", { timeout: 30_000 }, () => {
	it("is named 'jobs' without a type cast, and records only runs that did work", () => {
		const cadence = createJobRunnerCadence({ ports: jobPorts([]), derivePorts: derivePorts() });
		expect(cadence.name).toBe("jobs");
		expect(cadence.shouldRecord?.({ processed: 0, recovered: 0 })).toBe(false);
		expect(cadence.shouldRecord?.({ processed: 1, recovered: 0 })).toBe(true);
	});

	it("acquires its lock via the 'jobs' cadence key and skips run-log rows on idle ticks", async () => {
		const acquired: string[] = [];
		const lockPort: SchedulerLockPort = {
			tryAcquire: vi.fn(async (c) => {
				acquired.push(c);
				return true;
			}),
			release: vi.fn(async () => undefined),
		};
		const recorded: unknown[] = [];
		const logPort: SchedulerRunLogPort = { record: vi.fn(async (e) => void recorded.push(e)) };
		const runner = new EngineRunner(new EngineLock(lockPort), new EngineRunLog(logPort));
		runner.registerCadence(createJobRunnerCadence({ ports: jobPorts([]), derivePorts: derivePorts(), intervalMs: 10 }));

		vi.useFakeTimers();
		runner.start();
		await vi.advanceTimersByTimeAsync(6000);
		await runner.stop();
		vi.useRealTimers();

		expect(acquired).toContain("jobs");
		expect(recorded).toHaveLength(0);
	});
});
