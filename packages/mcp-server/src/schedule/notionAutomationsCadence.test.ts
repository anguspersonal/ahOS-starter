import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../automations/completedAtStamp.js", () => ({
	sweepCompletedAtDrift: vi.fn(),
}));
vi.mock("./runLog.js", () => ({ recordRun: vi.fn() }));

import { sweepCompletedAtDrift } from "../automations/completedAtStamp.js";
import { recordRun } from "./runLog.js";
import { runNotionAutomationsCadence } from "./notionAutomationsCadence.js";

afterEach(() => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

describe("runNotionAutomationsCadence", () => {
	it("records a notion_automations run with the sweep's counts", async () => {
		(sweepCompletedAtDrift as any).mockResolvedValue({
			scanned: 5,
			stamped: 2,
			cleared: 1,
			unchanged: 2,
			errors: 0,
		});

		await runNotionAutomationsCadence();

		expect(recordRun).toHaveBeenCalledWith(
			expect.objectContaining({
				cadence: "notion_automations",
				connector: "notion",
				counts: { scanned: 5, stamped: 2, cleared: 1, unchanged: 2, errors: 0 },
				error: undefined,
			}),
		);
	});

	it("records an error summary when per-page updates failed", async () => {
		(sweepCompletedAtDrift as any).mockResolvedValue({
			scanned: 2,
			stamped: 1,
			cleared: 0,
			unchanged: 0,
			errors: 1,
		});

		await runNotionAutomationsCadence();

		expect(recordRun).toHaveBeenCalledWith(
			expect.objectContaining({
				cadence: "notion_automations",
				error: expect.stringContaining("1 page update(s) failed"),
			}),
		);
	});

	it("skips recording entirely when the rule is unconfigured (sweep returns null)", async () => {
		(sweepCompletedAtDrift as any).mockResolvedValue(null);

		await runNotionAutomationsCadence();

		expect(recordRun).not.toHaveBeenCalled();
	});

	it("records an error run (and does not throw) when the sweep itself blows up", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		(sweepCompletedAtDrift as any).mockRejectedValue(new Error("query exploded"));

		await expect(runNotionAutomationsCadence()).resolves.toBeUndefined();

		expect(recordRun).toHaveBeenCalledWith(
			expect.objectContaining({
				cadence: "notion_automations",
				error: "query exploded",
			}),
		);
	});
});
