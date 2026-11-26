import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../tools/enrichNext.js", () => ({ enrichNextCore: vi.fn() }));
vi.mock("./runLog.js", () => ({ recordRun: vi.fn() }));
vi.mock("./env.js", () => ({ env: { enrichBatchLimit: 25 } }));

import { enrichNextCore } from "../tools/enrichNext.js";
import { recordRun } from "./runLog.js";
import { env as schedulerEnv } from "./env.js";
import { runEnrichCadence } from "./enrichCadence.js";

afterEach(() => {
	vi.clearAllMocks();
	(schedulerEnv as any).enrichBatchLimit = 25;
});

describe("runEnrichCadence", () => {
	it("drains the backlog with the configured batch limit and records the counts", async () => {
		(enrichNextCore as any).mockResolvedValue({
			enriched: 5,
			failed: 1,
			remaining_discovered: 12,
			notes: ["some note"],
		});

		await runEnrichCadence();

		expect(enrichNextCore).toHaveBeenCalledWith({ limit: 25 });
		expect(recordRun).toHaveBeenCalledWith(
			expect.objectContaining({
				cadence: "enrich",
				counts: { enriched: 5, failed: 1, remaining_discovered: 12 },
			}),
		);
		// enrich cadence has no connector concept — must not be set on the run row.
		expect((recordRun as any).mock.calls[0][0].connector).toBeUndefined();
	});

	it("respects a reconfigured batch limit", async () => {
		(schedulerEnv as any).enrichBatchLimit = 5;
		(enrichNextCore as any).mockResolvedValue({
			enriched: 0,
			failed: 0,
			remaining_discovered: 0,
			notes: [],
		});

		await runEnrichCadence();

		expect(enrichNextCore).toHaveBeenCalledWith({ limit: 5 });
	});

	/**
	 * #1209. The backlog count timed out on every run, was swallowed into a 0, and
	 * the cadence wrote `status='ok', remaining_discovered=0` while ~150k pointers
	 * sat queued. A count failure must reach the run row as an error, with the
	 * backlog null — never as an ok run claiming an empty backlog.
	 */
	it("records a failed backlog count as an error run with remaining_discovered null, never ok with 0", async () => {
		(enrichNextCore as any).mockResolvedValue({
			enriched: 25,
			failed: 0,
			remaining_discovered: null,
			count_error: "canceling statement due to statement timeout",
			notes: [],
		});

		await runEnrichCadence();

		expect(recordRun).toHaveBeenCalledTimes(1);
		const row = (recordRun as any).mock.calls[0][0];
		expect(row.error).toContain("remaining_discovered count failed");
		expect(row.error).toContain("statement timeout");
		// The work that did happen is still counted; only the backlog is unknown.
		expect(row.counts).toEqual({ enriched: 25, failed: 0, remaining_discovered: null });
		expect(row.counts.remaining_discovered).not.toBe(0);
	});

	it("records an error run and does not throw when enrichNextCore fails", async () => {
		(enrichNextCore as any).mockRejectedValue(new Error("enrich exploded"));

		await expect(runEnrichCadence()).resolves.toBeUndefined();

		expect(recordRun).toHaveBeenCalledWith(
			expect.objectContaining({ cadence: "enrich", counts: {}, error: "enrich exploded" }),
		);
	});

	it("stringifies non-Error throws before recording", async () => {
		(enrichNextCore as any).mockRejectedValue("plain string failure");

		await runEnrichCadence();

		expect(recordRun).toHaveBeenCalledWith(
			expect.objectContaining({ cadence: "enrich", error: "plain string failure" }),
		);
	});
});
