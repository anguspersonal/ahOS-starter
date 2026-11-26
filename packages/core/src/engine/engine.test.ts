import { describe, it, expect, vi, beforeEach } from "vitest";
import { EngineLock, type SchedulerLockPort } from "./lock.js";
import { EngineRunLog, type SchedulerRunLogPort } from "./runLog.js";
import { EngineRunner, type CadenceDefinition } from "./runner.js";

describe("EngineLock", () => {
	let mockPort: SchedulerLockPort;
	let lock: EngineLock;

	beforeEach(() => {
		mockPort = {
			tryAcquire: vi.fn().mockResolvedValue(true),
			release: vi.fn().mockResolvedValue(undefined),
		};
		lock = new EngineLock(mockPort, 60000);
	});

	it("acquires and releases lock", async () => {
		const acquired = await lock.tryAcquire("dedup");
		expect(acquired).toBe(true);
		expect(mockPort.tryAcquire).toHaveBeenCalledTimes(1);

		await lock.release("dedup");
		expect(mockPort.release).toHaveBeenCalledWith("dedup");
	});

	it("withLock executes fn and releases lock on success", async () => {
		const fn = vi.fn().mockResolvedValue("success");
		const result = await lock.withLock("alerts", fn);

		expect(result).toBe("success");
		expect(mockPort.tryAcquire).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(mockPort.release).toHaveBeenCalledWith("alerts");
	});

	it("withLock skips execution when acquire fails", async () => {
		mockPort.tryAcquire = vi.fn().mockResolvedValue(false);
		const fn = vi.fn();

		const result = await lock.withLock("learning", fn);
		expect(result).toEqual({ skipped: true });
		expect(fn).not.toHaveBeenCalled();
		expect(mockPort.release).not.toHaveBeenCalled();
	});

	it("withLock releases lock even when fn throws", async () => {
		const fn = vi.fn().mockRejectedValue(new Error("cadence failed"));

		await expect(lock.withLock("dedup", fn)).rejects.toThrow("cadence failed");
		expect(mockPort.release).toHaveBeenCalledWith("dedup");
	});
});

describe("EngineRunLog", () => {
	let mockPort: SchedulerRunLogPort;
	let runLog: EngineRunLog;

	beforeEach(() => {
		mockPort = {
			record: vi.fn().mockResolvedValue(undefined),
		};
		runLog = new EngineRunLog(mockPort);
	});

	it("records run metrics to port", async () => {
		const entry = {
			cadence: "discover",
			startedAt: new Date(),
			counts: { items: 42 },
		};
		await runLog.recordRun(entry);
		expect(mockPort.record).toHaveBeenCalledWith(entry);
	});

	it("swallows port error and does not throw", async () => {
		mockPort.record = vi.fn().mockRejectedValue(new Error("DB connection died"));
		const entry = {
			cadence: "enrich",
			startedAt: new Date(),
			counts: { items: 0 },
		};

		// Should not throw
		await expect(runLog.recordRun(entry)).resolves.not.toThrow();
	});
});

describe("EngineRunner", () => {
	let mockLockPort: SchedulerLockPort;
	let mockRunLogPort: SchedulerRunLogPort;
	let lock: EngineLock;
	let runLog: EngineRunLog;
	let runner: EngineRunner;

	beforeEach(() => {
		mockLockPort = {
			tryAcquire: vi.fn().mockResolvedValue(true),
			release: vi.fn().mockResolvedValue(undefined),
		};
		mockRunLogPort = {
			record: vi.fn().mockResolvedValue(undefined),
		};
		lock = new EngineLock(mockLockPort);
		runLog = new EngineRunLog(mockRunLogPort);
		runner = new EngineRunner(lock, runLog);
	});

	it("registers and retrieves cadences", () => {
		const cadence: CadenceDefinition = {
			name: "dedup",
			intervalMs: 60000,
			run: vi.fn().mockResolvedValue({ processed: 10 }),
		};
		runner.registerCadence(cadence);

		const registered = runner.getCadences();
		expect(registered).toHaveLength(1);
		expect(registered[0].name).toBe("dedup");
	});

	it("starts and stops the runner", async () => {
		expect(runner.isRunning()).toBe(false);
		runner.start();
		expect(runner.isRunning()).toBe(true);

		await runner.stop();
		expect(runner.isRunning()).toBe(false);
	});
});
