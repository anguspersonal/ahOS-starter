import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EngineLock, type SchedulerLockPort } from "./lock.js";
import { EngineRunLog, type SchedulerRunLogPort } from "./runLog.js";
import { EngineRunner, type CadenceDefinition } from "./runner.js";

describe("EngineRunner tick failure handling", () => {
	let mockLockPort: SchedulerLockPort;
	let mockRunLogPort: SchedulerRunLogPort;
	let lock: EngineLock;
	let runLog: EngineRunLog;
	let runner: EngineRunner;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0);
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

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

	afterEach(async () => {
		await runner.stop();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("catches and logs lock acquire rejection, and keeps running (cadence 'jobs')", async () => {
		const lockError = new Error(
			"scheduler lock acquire failed (jobs): TypeError: fetch failed",
		);
		mockLockPort.tryAcquire = vi.fn().mockRejectedValue(lockError);
		const runFn = vi.fn().mockResolvedValue({ processed: 1 });

		const def: CadenceDefinition = {
			name: "jobs",
			intervalMs: 1000,
			run: runFn,
		};
		runner.registerCadence(def);
		runner.start();

		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(1000);

		expect(mockLockPort.tryAcquire).toHaveBeenCalledTimes(2);
		expect(runFn).not.toHaveBeenCalled();
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			'[EngineRunner] Cadence "jobs" tick failed:',
			lockError,
		);
		expect(runner.isRunning()).toBe(true);
	});

	it("catches and logs enabled() throw, and keeps running (cadence 'derive')", async () => {
		const gateError = new Error("bad gate");
		const enabledFn = vi.fn(() => {
			throw gateError;
		});
		const runFn = vi.fn().mockResolvedValue({ processed: 1 });

		const def: CadenceDefinition = {
			name: "derive",
			intervalMs: 1000,
			enabled: enabledFn,
			run: runFn,
		};
		runner.registerCadence(def);
		runner.start();

		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(1000);

		expect(enabledFn).toHaveBeenCalledTimes(2);
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			'[EngineRunner] Cadence "derive" tick failed:',
			gateError,
		);
		expect(runner.isRunning()).toBe(true);
	});
});
