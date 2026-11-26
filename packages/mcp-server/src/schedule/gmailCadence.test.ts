import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@ahkms/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ahkms/core")>();
	return { ...actual, executeAction: vi.fn() };
});
vi.mock("../actions/serverRegistry.js", () => ({ serverRegistry: vi.fn() }));
vi.mock("../identity.js", () => ({
	getCurrentUserId: vi.fn(() => "11111111-1111-4111-8111-111111111111"),
}));
vi.mock("./runLog.js", () => ({ recordRun: vi.fn() }));

import { executeAction } from "@ahkms/core";
import { serverRegistry } from "../actions/serverRegistry.js";
import { recordRun } from "./runLog.js";
import { runGmailAutomationsCadence } from "./gmailCadence.js";

afterEach(() => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

describe("runGmailAutomationsCadence", () => {
	it("executes gmail_reconcile with dry_run: false, caller worker, and current user id, and records a gmail_automations run", async () => {
		const fakeAction = { id: "gmail_reconcile" };
		vi.mocked(serverRegistry).mockReturnValue({
			get: vi.fn((id: string) => (id === "gmail_reconcile" ? fakeAction : undefined)),
		} as any);
		vi.mocked(executeAction).mockResolvedValue({
			scanned: 10,
			updated: 4,
			archived: 2,
			pendingAction: 1,
			awaitingReply: 1,
			capturedOnly: 0,
			unchanged: 6,
			errors: 0,
			dryRun: false,
			details: [],
		});

		await runGmailAutomationsCadence();

		expect(executeAction).toHaveBeenCalledWith(
			fakeAction,
			{ dry_run: false },
			expect.objectContaining({
				context: expect.objectContaining({
					caller: "worker",
					userId: "11111111-1111-4111-8111-111111111111",
				}),
			}),
		);
		expect(recordRun).toHaveBeenCalledWith(
			expect.objectContaining({
				cadence: "gmail_automations",
				connector: "gmail",
				counts: {
					scanned: 10,
					updated: 4,
					archived: 2,
					pendingAction: 1,
					awaitingReply: 1,
					capturedOnly: 0,
					unchanged: 6,
					errors: 0,
				},
				error: undefined,
			}),
		);
	});

	it("records an error summary when thread errors occurred (errors: 3)", async () => {
		const fakeAction = { id: "gmail_reconcile" };
		vi.mocked(serverRegistry).mockReturnValue({
			get: vi.fn((id: string) => (id === "gmail_reconcile" ? fakeAction : undefined)),
		} as any);
		vi.mocked(executeAction).mockResolvedValue({
			scanned: 5,
			updated: 1,
			archived: 1,
			pendingAction: 0,
			awaitingReply: 0,
			capturedOnly: 0,
			unchanged: 0,
			errors: 3,
			dryRun: false,
			details: [],
		});

		await runGmailAutomationsCadence();

		expect(recordRun).toHaveBeenCalledWith(
			expect.objectContaining({
				cadence: "gmail_automations",
				error: "3 thread(s) encountered errors during reconciliation",
			}),
		);
	});

	it("records run failure with empty counts when executeAction throws", async () => {
		const fakeAction = { id: "gmail_reconcile" };
		vi.mocked(serverRegistry).mockReturnValue({
			get: vi.fn((id: string) => (id === "gmail_reconcile" ? fakeAction : undefined)),
		} as any);
		vi.mocked(executeAction).mockRejectedValue(new Error("network failure"));

		await expect(runGmailAutomationsCadence()).resolves.toBeUndefined();

		expect(recordRun).toHaveBeenCalledWith(
			expect.objectContaining({
				cadence: "gmail_automations",
				counts: {},
				error: "network failure",
			}),
		);
	});
});
