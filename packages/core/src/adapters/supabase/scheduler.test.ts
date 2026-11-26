import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
	createSupabaseSchedulerLockPort,
	createSupabaseSchedulerRunLogPort,
	type GenericSupabaseClient,
	type SchedulerSupabaseClient,
} from "./scheduler.js";

describe("createSupabaseSchedulerLockPort", () => {
	it("acquires lock using count: exact without select projection (#516)", async () => {
		const mockUpdate = vi.fn().mockReturnValue({
			eq: vi.fn().mockReturnValue({
				or: vi.fn().mockResolvedValue({ count: 1, error: null }),
			}),
		});
		const mockClient: GenericSupabaseClient = {
			from: vi.fn().mockReturnValue({ update: mockUpdate, insert: vi.fn() }),
		};

		const port = createSupabaseSchedulerLockPort(mockClient);
		const acquired = await port.tryAcquire("dedup", "2026-10-01T00:00:00Z", "2026-10-01T00:30:00Z");

		expect(acquired).toBe(true);
		expect(mockClient.from).toHaveBeenCalledWith("scheduler_locks");
		expect(mockUpdate).toHaveBeenCalledWith(
			{ locked_at: "2026-10-01T00:30:00Z" },
			{ count: "exact" },
		);
	});

	it("acquires lock when passed a SupabaseClient-typed instance", async () => {
		const mockUpdate = vi.fn().mockReturnValue({
			eq: vi.fn().mockReturnValue({
				or: vi.fn().mockResolvedValue({ count: 1, error: null }),
			}),
		});
		const mockClient = {
			from: vi.fn().mockReturnValue({ update: mockUpdate, insert: vi.fn() }),
		} as unknown as SupabaseClient;

		const port = createSupabaseSchedulerLockPort(mockClient);
		const acquired = await port.tryAcquire("dedup", "2026-10-01T00:00:00Z", "2026-10-01T00:30:00Z");
		expect(acquired).toBe(true);
	});

	it("returns false when affected row count is 0", async () => {
		const mockUpdate = vi.fn().mockReturnValue({
			eq: vi.fn().mockReturnValue({
				or: vi.fn().mockResolvedValue({ count: 0, error: null }),
			}),
		});
		const mockClient: GenericSupabaseClient = {
			from: vi.fn().mockReturnValue({ update: mockUpdate, insert: vi.fn() }),
		};

		const port = createSupabaseSchedulerLockPort(mockClient);
		const acquired = await port.tryAcquire("dedup", "2026-10-01T00:00:00Z", "2026-10-01T00:30:00Z");

		expect(acquired).toBe(false);
	});

	it("throws error when Supabase update fails", async () => {
		const mockUpdate = vi.fn().mockReturnValue({
			eq: vi.fn().mockReturnValue({
				or: vi.fn().mockResolvedValue({ count: null, error: { message: "Network timeout" } }),
			}),
		});
		const mockClient: GenericSupabaseClient = {
			from: vi.fn().mockReturnValue({ update: mockUpdate, insert: vi.fn() }),
		};

		const port = createSupabaseSchedulerLockPort(mockClient);
		await expect(port.tryAcquire("alerts", "cutoff", "now")).rejects.toThrow("scheduler lock acquire failed");
	});

	it("releases lock by setting locked_at to null", async () => {
		const mockEq = vi.fn().mockResolvedValue({ error: null });
		const mockUpdate = vi.fn().mockReturnValue({ eq: mockEq });
		const mockClient: GenericSupabaseClient = {
			from: vi.fn().mockReturnValue({ update: mockUpdate, insert: vi.fn() }),
		};

		const port = createSupabaseSchedulerLockPort(mockClient);
		await port.release("alerts");

		expect(mockUpdate).toHaveBeenCalledWith({ locked_at: null });
		expect(mockEq).toHaveBeenCalledWith("cadence", "alerts");
	});
});

describe("createSupabaseSchedulerRunLogPort", () => {
	it("inserts run entry into scheduler_runs", async () => {
		const mockInsert = vi.fn().mockResolvedValue({ error: null });
		const mockClient: GenericSupabaseClient = {
			from: vi.fn().mockReturnValue({ update: vi.fn(), insert: mockInsert }),
		};

		const port = createSupabaseSchedulerRunLogPort(mockClient);
		await port.record({
			cadence: "dedup",
			startedAt: new Date("2026-10-01T12:00:00Z"),
			counts: { total: 5 },
		});

		expect(mockClient.from).toHaveBeenCalledWith("scheduler_runs");
		expect(mockInsert).toHaveBeenCalledWith(
			expect.objectContaining({
				cadence: "dedup",
				status: "ok",
				counts: { total: 5 },
			}),
		);
	});
});
