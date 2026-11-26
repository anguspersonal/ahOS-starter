import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "../supabase.js";
import { tryAcquireLock, releaseLock, withLock } from "./lock.js";

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

// The acquire path judges success by the affected-row COUNT (never a returned
// representation — see the #516 comment in lock.ts), so the builder is a
// thenable resolving to { count, error } rather than exposing .select().
function updateBuilder(result: { count: number | null; error: unknown }) {
	const calls: { eq: unknown[]; or: unknown[] } = { eq: [], or: [] };
	const b: any = {
		eq: (...args: unknown[]) => {
			calls.eq.push(args);
			return b;
		},
		or: (...args: unknown[]) => {
			calls.or.push(args);
			return b;
		},
		then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
	};
	return { builder: b, calls };
}

describe("tryAcquireLock", () => {
	it("returns true when the update matches a row (lock was free/stale)", async () => {
		const { builder } = updateBuilder({ count: 1, error: null });
		const update = vi.fn(() => builder);
		(supabase as any).from = vi.fn(() => ({ update }));

		await expect(tryAcquireLock("discover")).resolves.toBe(true);
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({ locked_at: expect.any(String) }),
			{ count: "exact" },
		);
	});

	it("returns false when no row matches (already held)", async () => {
		const { builder } = updateBuilder({ count: 0, error: null });
		(supabase as any).from = vi.fn(() => ({ update: () => builder }));

		await expect(tryAcquireLock("enrich")).resolves.toBe(false);
	});

	it("throws on a Supabase error", async () => {
		const { builder } = updateBuilder({ count: null, error: { message: "boom" } });
		(supabase as any).from = vi.fn(() => ({ update: () => builder }));

		await expect(tryAcquireLock("discover")).rejects.toThrow(/boom/);
	});
});

describe("releaseLock", () => {
	it("clears locked_at", async () => {
		const eqCalls: unknown[][] = [];
		const b: any = {
			eq: (...args: unknown[]) => {
				eqCalls.push(args);
				return Promise.resolve({ error: null });
			},
		};
		const update = vi.fn(() => b);
		(supabase as any).from = vi.fn(() => ({ update }));

		await releaseLock("enrich");
		expect(update).toHaveBeenCalledWith({ locked_at: null });
		expect(eqCalls).toEqual([["cadence", "enrich"]]);
	});
});

describe("withLock", () => {
	it("runs fn and releases the lock when acquired", async () => {
		const { builder: acquireBuilder } = updateBuilder({ count: 1, error: null });
		const releaseEq = vi.fn(() => Promise.resolve({ error: null }));
		let call = 0;
		(supabase as any).from = vi.fn(() => ({
			update: () => {
				call += 1;
				return call === 1 ? acquireBuilder : { eq: releaseEq };
			},
		}));

		const fn = vi.fn(async () => "done");
		await expect(withLock("discover", fn)).resolves.toBe("done");
		expect(fn).toHaveBeenCalledTimes(1);
		expect(releaseEq).toHaveBeenCalledWith("cadence", "discover");
	});

	it("skips fn and returns {skipped: true} when the lock is already held", async () => {
		const { builder } = updateBuilder({ count: 0, error: null });
		(supabase as any).from = vi.fn(() => ({ update: () => builder }));

		const fn = vi.fn(async () => "done");
		await expect(withLock("enrich", fn)).resolves.toEqual({ skipped: true });
		expect(fn).not.toHaveBeenCalled();
	});

	it("still releases the lock if fn throws", async () => {
		const { builder: acquireBuilder } = updateBuilder({ count: 1, error: null });
		const releaseEq = vi.fn(() => Promise.resolve({ error: null }));
		let call = 0;
		(supabase as any).from = vi.fn(() => ({
			update: () => {
				call += 1;
				return call === 1 ? acquireBuilder : { eq: releaseEq };
			},
		}));

		const fn = vi.fn(async () => {
			throw new Error("boom");
		});
		await expect(withLock("discover", fn)).rejects.toThrow("boom");
		expect(releaseEq).toHaveBeenCalledWith("cadence", "discover");
	});
});
