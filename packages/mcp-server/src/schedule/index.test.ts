import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ahkms/core", () => ({ executeAction: vi.fn() }));
vi.mock("../actions/serverRegistry.js", () => ({ serverRegistry: vi.fn() }));
vi.mock("../identity.js", () => ({ getCurrentUserId: vi.fn(() => "11111111-1111-4111-8111-111111111111") }));
vi.mock("./lock.js", () => ({ withLock: vi.fn() }));
vi.mock("./runLog.js", () => ({ recordRun: vi.fn() }));
vi.mock("./discoverCadence.js", () => ({ runDiscoverCadence: vi.fn() }));
vi.mock("./enrichCadence.js", () => ({ runEnrichCadence: vi.fn() }));
vi.mock("./gmailCadence.js", () => ({ runGmailAutomationsCadence: vi.fn() }));
vi.mock("./env.js", () => ({
	env: {
		enabled: true,
		discoverIntervalMinutes: 60,
		enrichIntervalMinutes: 30,
		enrichBatchLimit: 25,
		gmailAutomationsEnabled: false,
		gmailAutomationsIntervalMinutes: 60,
		gmailTriageEnabled: false,
		gmailTriageMode: "shadow",
		gmailTriageIntervalMinutes: 60,
		gmailTriageMaxThreads: 50,
		gmailTriageAttentionBudget: 15,
		jobHuntGmailEnabled: false,
		jobHuntGmailMode: "shadow",
		jobHuntGmailMaxMessages: 50,
		driveHygieneEnabled: false,
		driveHygieneIntervalMinutes: 360,
		driveHygieneMaxActions: 100,
	},
}));

import { executeAction } from "@ahkms/core";
import { serverRegistry } from "../actions/serverRegistry.js";
import { withLock } from "./lock.js";
import { recordRun } from "./runLog.js";
import { runDiscoverCadence } from "./discoverCadence.js";
import { runEnrichCadence } from "./enrichCadence.js";
import { runGmailAutomationsCadence } from "./gmailCadence.js";
import { env } from "./env.js";
import { runDriveHygieneCadence, runJobHuntGmailCadence, startScheduler } from "./index.js";

beforeEach(() => {
	vi.useFakeTimers();
	(withLock as any).mockResolvedValue(undefined);
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
	(env as any).enabled = true;
	(env as any).discoverIntervalMinutes = 60;
	(env as any).enrichIntervalMinutes = 30;
	(env as any).gmailAutomationsEnabled = false;
	(env as any).gmailAutomationsIntervalMinutes = 60;
	(env as any).gmailTriageEnabled = false;
	(env as any).gmailTriageIntervalMinutes = 60;
	(env as any).jobHuntGmailEnabled = false;
	(env as any).jobHuntGmailMode = "shadow";
	(env as any).jobHuntGmailMaxMessages = 50;
	(env as any).driveHygieneEnabled = false;
});

describe("startScheduler", () => {
	it("does nothing when KMS_SCHEDULER_ENABLED is disabled", () => {
		(env as any).enabled = false;

		startScheduler();
		vi.advanceTimersByTime(24 * 60 * 60 * 1000);

		expect(withLock).not.toHaveBeenCalled();
	});

	it("runs both cadences immediately on start, each under its own lock", () => {
		startScheduler();

		expect(withLock).toHaveBeenCalledTimes(2);
		expect(withLock).toHaveBeenCalledWith("discover", runDiscoverCadence);
		expect(withLock).toHaveBeenCalledWith("enrich", runEnrichCadence);
	});

	it("re-runs discover on its configured interval", () => {
		startScheduler();
		(withLock as any).mockClear();

		vi.advanceTimersByTime(60 * 60 * 1000 - 1);
		expect(withLock).not.toHaveBeenCalledWith("discover", expect.anything());

		vi.advanceTimersByTime(1);
		expect(withLock).toHaveBeenCalledWith("discover", runDiscoverCadence);
	});

	it("re-runs enrich on its own, independently configured interval", () => {
		startScheduler();
		(withLock as any).mockClear();

		vi.advanceTimersByTime(30 * 60 * 1000);
		expect(withLock).toHaveBeenCalledWith("enrich", runEnrichCadence);
		expect(withLock).not.toHaveBeenCalledWith("discover", expect.anything());
	});

	it("keeps ticking on its own interval indefinitely (not just once)", () => {
		startScheduler();
		(withLock as any).mockClear();

		vi.advanceTimersByTime(30 * 60 * 1000 * 3);

		const enrichCalls = (withLock as any).mock.calls.filter((c: unknown[]) => c[0] === "enrich");
		expect(enrichCalls).toHaveLength(3);
	});

	it("logs but does not crash the process when a tick's withLock promise rejects", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		(withLock as any).mockRejectedValue(new Error("tick failed"));

		startScheduler();
		// Let the rejected immediate-tick promises settle.
		await vi.advanceTimersByTimeAsync(0);

		expect(consoleError).toHaveBeenCalledWith("discover cadence tick failed:", expect.any(Error));
		expect(consoleError).toHaveBeenCalledWith("enrich cadence tick failed:", expect.any(Error));
	});

	/**
	 * #1210: the Gmail attachment connector is one more connector INSIDE the discover
	 * cadence, not a cadence of its own. Enabling it must take no new lock: a new lock
	 * key needs a seeded scheduler_locks row, i.e. a migration this change does not have.
	 */
	it("enabling gmail attachment discover takes no lock of its own", () => {
		const mutableEnv = env as unknown as Record<string, unknown>;
		const saved = { ...mutableEnv };
		Object.assign(mutableEnv, {
			gmailAutomationsEnabled: false,
			gmailAttachmentDiscoverEnabled: true,
			gmailAttachmentDiscoverMaxMessages: 1000,
			driveHygieneEnabled: false,
		});
		try {
			startScheduler();

			expect(vi.mocked(withLock).mock.calls.map((c) => c[0])).toEqual(["discover", "enrich"]);
			expect(withLock).toHaveBeenCalledWith("discover", runDiscoverCadence);
		} finally {
			Object.assign(mutableEnv, saved);
		}
	});

	it("runs gmail automations cadence on startup and interval when enabled", () => {
		(env as any).gmailAutomationsEnabled = true;
		(env as any).gmailAutomationsIntervalMinutes = 15;

		startScheduler();

		expect(withLock).toHaveBeenCalledWith("gmail_automations", runGmailAutomationsCadence);

		(withLock as any).mockClear();
		vi.advanceTimersByTime(15 * 60 * 1000);
		expect(withLock).toHaveBeenCalledWith("gmail_automations", runGmailAutomationsCadence);
	});

	it("runs drive hygiene cadence under dedup lock on startup and interval when enabled", () => {
		(env as any).driveHygieneEnabled = true;
		(env as any).driveHygieneIntervalMinutes = 360;

		startScheduler();

		expect(withLock).toHaveBeenCalledWith("dedup", runDriveHygieneCadence);

		(withLock as any).mockClear();
		vi.advanceTimersByTime(360 * 60 * 1000);
		expect(withLock).toHaveBeenCalledWith("dedup", runDriveHygieneCadence);
	});

	it("runDriveHygieneCadence executes drive_hygiene_heal and weekly_kpi_snapshot and logs to recordRun", async () => {
		vi.mocked(serverRegistry).mockReturnValue({
			get: vi.fn((id: string) => ({ id })),
		} as any);
		vi.mocked(executeAction)
			.mockResolvedValueOnce({
				summary: {
					candidates_found: 5,
					planned_within_cap: 5,
					executed_count: 5,
					failed_count: 0,
					skipped_cap_count: 0,
					reclaimed_bytes: 2048,
					by_lever: {},
				},
			})
			.mockResolvedValueOnce({
				week_key: "2026-W45",
				composite_kpis: [{ id: "cloud_storage_hygiene_pct", value: 78.2 }],
				recorded_artifact: { recorded: true, artifact_id: "art-w45" },
			});

		await runDriveHygieneCadence();

		expect(executeAction).toHaveBeenCalledTimes(2);
		expect(recordRun).toHaveBeenCalledWith(
			expect.objectContaining({
				cadence: "dedup",
				connector: "drive_hygiene",
				counts: expect.objectContaining({
					executed_count: 5,
					reclaimed_bytes: 2048,
					week_key: "2026-W45",
					cloud_storage_hygiene_pct: 78.2,
					snapshot_artifact_id: "art-w45",
				}),
				error: undefined,
			}),
		);
	});

	it("runJobHuntGmailCadence records valid counts with error: undefined under gmail_automations / job_hunt_gmail", async () => {
		const runSpy = vi.fn(async (input: any) => ({
			domain: "angus" as const,
			mode: input.mode,
			dry_run: input.dry_run,
			scanned_messages: 4,
			skipped_watermarked: 1,
			skipped_seeded_provenance: 0,
			ignored_non_job: 1,
			classified_updates: 2,
			classified_tasks: 0,
			classified_evidence: 0,
			shadow_logged: 2,
			parked_approvals: 0,
			auto_applied: 0,
			tasks_created: 0,
			evidence_linked: 0,
			labels_added: 0,
			needs_review_count: 0,
			errors: [],
			items: [],
		}));
		const fakeAction = {
			id: "job_hunt_gmail_ingest",
			domain: "kg",
			description: "test",
			schema: {
				parse: (v: unknown) => v,
				safeParse: (v: unknown) => ({ success: true, data: v }),
			},
			run: runSpy,
		};
		vi.mocked(serverRegistry).mockReturnValue({
			get: vi.fn((id: string) => (id === "job_hunt_gmail_ingest" ? fakeAction : undefined)),
		} as any);

		await runJobHuntGmailCadence();

		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(recordRun).toHaveBeenCalledWith(
			expect.objectContaining({
				cadence: "gmail_automations",
				connector: "job_hunt_gmail",
				error: undefined,
				counts: expect.objectContaining({
					mode: "shadow",
					dry_run: false,
					scanned_messages: 4,
					skipped_watermarked: 1,
					classified_updates: 2,
					shadow_logged: 2,
					errors: 0,
				}),
			}),
		);
	});

	it("startScheduler runs gmail_triage and job_hunt_gmail sequentially inside a single gmail_automations lock without starving either", async () => {
		(env as any).gmailTriageEnabled = true;
		(env as any).jobHuntGmailEnabled = true;
		(env as any).gmailTriageIntervalMinutes = 60;

		const runOrder: string[] = [];
		const makeFakeAction = (id: string, output: Record<string, unknown>) => ({
			id,
			domain: "kg",
			description: "test",
			schema: {
				parse: (v: unknown) => v,
				safeParse: (v: unknown) => ({ success: true, data: v }),
			},
			run: vi.fn(async () => {
				runOrder.push(id);
				return output;
			}),
		});
		const triageAction = makeFakeAction("gmail_priority_triage", {
			mode: "shadow",
			rubric_version: "v1",
			skipped_already_decided: 0,
			promoted_artifact_count: 0,
			metrics: {
				mailbox_before: { total: { inbox: 10, unread: 3 } },
				processed: 2,
				new: 2,
				needs_attention: 1,
				attention_budget: 15,
				attention_over_budget: 0,
				within_budget: true,
				review: 0,
				drafts_created: 0,
				tasks_extracted: 0,
				entities_extracted: 0,
				auto_applied: 0,
				leaves_inbox: 0,
				system_1: 2,
				system_2: 0,
				gmail_category_contradictions: 0,
				override_rate: null,
				by_route: {},
			},
			errors: [],
		});
		const jobHuntAction = makeFakeAction("job_hunt_gmail_ingest", {
			domain: "angus",
			mode: "shadow",
			dry_run: false,
			scanned_messages: 3,
			skipped_watermarked: 0,
			skipped_seeded_provenance: 0,
			ignored_non_job: 0,
			classified_updates: 3,
			classified_tasks: 0,
			classified_evidence: 0,
			shadow_logged: 3,
			parked_approvals: 0,
			auto_applied: 0,
			tasks_created: 0,
			evidence_linked: 0,
			labels_added: 0,
			needs_review_count: 0,
			errors: [],
			items: [],
		});
		vi.mocked(serverRegistry).mockReturnValue({
			get: vi.fn((id: string) =>
				id === "gmail_priority_triage"
					? triageAction
					: id === "job_hunt_gmail_ingest"
						? jobHuntAction
						: undefined,
			),
		} as any);

		const callbacks: Array<() => Promise<unknown>> = [];
		vi.mocked(withLock).mockImplementation(async (cadence, fn) => {
			if (cadence === "gmail_automations") {
				callbacks.push(fn);
			}
			return undefined;
		});

		startScheduler();

		// Must acquire gmail_automations ONCE per tick (not twice back-to-back)
		const gmailLockCalls = vi.mocked(withLock).mock.calls.filter((c) => c[0] === "gmail_automations");
		expect(gmailLockCalls).toHaveLength(1);
		expect(callbacks).toHaveLength(1);

		await callbacks[0]();

		// Both connectors ran sequentially inside the single lock callback
		expect(runOrder).toEqual(["gmail_priority_triage", "job_hunt_gmail_ingest"]);
		expect(recordRun).toHaveBeenCalledWith(
			expect.objectContaining({
				cadence: "gmail_automations",
				connector: "gmail_triage",
				error: undefined,
			}),
		);
		expect(recordRun).toHaveBeenCalledWith(
			expect.objectContaining({
				cadence: "gmail_automations",
				connector: "job_hunt_gmail",
				error: undefined,
				counts: expect.objectContaining({ scanned_messages: 3, shadow_logged: 3 }),
			}),
		);

		// Verify isolation: if recordRun throws for gmail_triage, job_hunt_gmail STILL executes
		runOrder.length = 0;
		vi.mocked(recordRun).mockRejectedValueOnce(new Error("triage runLog failure"));
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		await callbacks[0]();
		expect(runOrder).toEqual(["gmail_priority_triage", "job_hunt_gmail_ingest"]);
		expect(consoleError).toHaveBeenCalledWith("gmail triage cadence failed:", expect.any(Error));
	});
});
