import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "../supabase.js";
import { recordRun } from "./runLog.js";

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

describe("recordRun", () => {
	it("inserts a status 'ok' row with the given counts and no error", async () => {
		const insert = vi.fn(() => Promise.resolve({ error: null }));
		(supabase as any).from = vi.fn(() => ({ insert }));

		const startedAt = new Date("2026-07-13T00:00:00.000Z");
		await recordRun({
			cadence: "discover",
			connector: "gdrive",
			startedAt,
			counts: { scanned: 3, new: 1, changed: 0, unchanged: 2 },
		});

		expect(supabase.from).toHaveBeenCalledWith("scheduler_runs");
		expect(insert).toHaveBeenCalledWith(
			expect.objectContaining({
				cadence: "discover",
				connector: "gdrive",
				status: "ok",
				counts: { scanned: 3, new: 1, changed: 0, unchanged: 2 },
				error_message: null,
				started_at: "2026-07-13T00:00:00.000Z",
			}),
		);
	});

	it("defaults connector to null when omitted", async () => {
		const insert = vi.fn(() => Promise.resolve({ error: null }));
		(supabase as any).from = vi.fn(() => ({ insert }));

		await recordRun({ cadence: "enrich", startedAt: new Date(), counts: {} });

		expect(insert).toHaveBeenCalledWith(expect.objectContaining({ connector: null }));
	});

	it("inserts a status 'error' row with error_message set when an error is given", async () => {
		const insert = vi.fn(() => Promise.resolve({ error: null }));
		(supabase as any).from = vi.fn(() => ({ insert }));

		await recordRun({ cadence: "enrich", startedAt: new Date(), counts: {}, error: "boom" });

		expect(insert).toHaveBeenCalledWith(
			expect.objectContaining({ status: "error", error_message: "boom" }),
		);
	});

	it("logs to stderr but does not throw when the insert itself fails", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const insert = vi.fn(() => Promise.resolve({ error: { message: "insert failed" } }));
		(supabase as any).from = vi.fn(() => ({ insert }));

		await expect(
			recordRun({ cadence: "discover", startedAt: new Date(), counts: {} }),
		).resolves.toBeUndefined();

		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining("scheduler_runs insert failed (discover)"),
			"insert failed",
		);
	});

	it("sets finished_at to (approximately) now, independent of startedAt", async () => {
		const insert = vi.fn((_row: Record<string, unknown>) => Promise.resolve({ error: null }));
		(supabase as any).from = vi.fn(() => ({ insert }));

		const before = Date.now();
		await recordRun({ cadence: "discover", startedAt: new Date("2020-01-01T00:00:00.000Z"), counts: {} });
		const after = Date.now();

		const [row] = insert.mock.calls[0] ?? [];
		const finishedAtIso = row?.finished_at as string;
		const finishedAtMs = new Date(finishedAtIso).getTime();
		expect(finishedAtMs).toBeGreaterThanOrEqual(before);
		expect(finishedAtMs).toBeLessThanOrEqual(after);
	});
});
