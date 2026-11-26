import { describe, expect, it, vi } from "vitest";
import { startEngine } from "./start.js";
import type { SchedulerLockPort } from "./lock.js";
import type { SchedulerRunLogPort } from "./runLog.js";

describe("startEngine", () => {
	it("starts the runner with fake ports, and stop() stops it", async () => {
		const fakeLockPort: SchedulerLockPort = {
			tryAcquire: vi.fn().mockResolvedValue(true),
			release: vi.fn().mockResolvedValue(undefined),
		};

		const fakeRunLogPort: SchedulerRunLogPort = {
			record: vi.fn().mockResolvedValue(undefined),
		};

		const handle = startEngine({
			lockPort: fakeLockPort,
			runLogPort: fakeRunLogPort,
		});

		expect(handle).toBeDefined();
		expect(typeof handle.stop).toBe("function");
		expect(handle.runner.isRunning()).toBe(true);

		await handle.stop();
		expect(handle.runner.isRunning()).toBe(false);
	});

	it("registers cadences passed in options", async () => {
		const fakeLockPort: SchedulerLockPort = {
			tryAcquire: vi.fn().mockResolvedValue(true),
			release: vi.fn().mockResolvedValue(undefined),
		};

		const fakeRunLogPort: SchedulerRunLogPort = {
			record: vi.fn().mockResolvedValue(undefined),
		};

		const cadenceRun = vi.fn().mockResolvedValue({ processed: 1 });
		const handle = startEngine({
			lockPort: fakeLockPort,
			runLogPort: fakeRunLogPort,
			cadences: [
				{
					name: "hourly_sync",
					intervalMs: 60000,
					run: cadenceRun,
				},
			],
		});

		const registered = handle.runner.getCadences();
		expect(registered).toHaveLength(1);
		expect(registered[0].name).toBe("hourly_sync");

		await handle.stop();
	});
});
