import { describe, expect, it, vi } from "vitest";
import { buildEmailMetricsSeries, localDateKey, windowDateKeys, type EmailDecisionFact } from "./emailMetricsSeries.js";
import { createGmailTriageMetricsAction } from "../actions/google/gmailTriageMetrics.js";
import { executeAction } from "../actions/adapters/direct.js";

const now = new Date("2026-11-08T12:00:00Z");

const fact = (over: Partial<EmailDecisionFact>): EmailDecisionFact => ({
	created_at: "2026-11-08T09:00:00Z",
	status: "auto_applied",
	thread_id: "t",
	account: "personal",
	route: "archive",
	thinking_mode: "system_1",
	...over,
});

describe("email metrics series", () => {
	it("cuts days at local midnight and returns the window oldest first", () => {
		expect(localDateKey("2026-07-01T23:30:00Z", "Europe/London")).toBe("2026-07-02");
		expect(localDateKey("2026-07-01T23:30:00Z", "UTC")).toBe("2026-07-01");
		expect(windowDateKeys(now, 3)).toEqual(["2026-11-06", "2026-11-07", "2026-11-08"]);
	});

	it("derives flows from decisions, takes the latest snapshot per day, and skips pre-ADR-118 rows", () => {
		const decisions: EmailDecisionFact[] = [
			fact({ thread_id: "a", route: "attention", thinking_mode: "system_2", draft_id: null, rubric_version: "2026-11-08.2" }),
			fact({ thread_id: "b", route: "review", status: "pending", gmail_category_contradiction: true, rubric_version: "2026-11-08.2" }),
			fact({ thread_id: "c", route: "review", status: "modified", rubric_version: "2026-11-08.2" }),
			fact({ thread_id: "d", route: "draft_reply", draft_id: "dr-1", tasks_extracted: 2, created_task_count: 1, rubric_version: "2026-11-08.3" }),
			fact({ thread_id: "e", applied: true, rubric_version: "2026-11-08.3" }),
			fact({ thread_id: "e", applied: true, created_at: "2026-11-08T10:00:00Z", status: "rejected", rubric_version: "2026-11-08.3" }),
			fact({ thread_id: "z", route: null }),
			fact({ thread_id: "old", created_at: "2026-11-07T08:00:00Z", account: "work", route: "attention", rubric_version: "2026-11-08.2" }),
		];
		const series = buildEmailMetricsSeries(
			decisions,
			[
				{ date: "2026-11-08", observed_at: "2026-11-08T08:00:00Z", accounts: { personal: { inbox: 90, unread: 60 } } },
				{
					date: "2026-11-08",
					observed_at: "2026-11-08T11:00:00Z",
					accounts: { personal: { inbox: 40, unread: 20 }, work: { inbox: 10, unread: 5 } },
				},
			],
			{ now, days: 2, attentionBudget: 3 },
		);

		const [yesterday, today] = series.days;
		expect(yesterday).toMatchObject({ date: "2026-11-07", processed: 1, needs_attention: 1, inbox: null });
		expect(today).toMatchObject({
			date: "2026-11-08",
			processed: 6,
			new: 5,
			needs_attention: 4,
			within_budget: false,
			review: 2,
			review_resolved: 1,
			overrides: 2,
			drafts_created: 1,
			tasks_extracted: 2,
			tasks_created: 1,
			auto_applied: 2,
			leaves_inbox: 2,
			system_2: 1,
			gmail_category_contradictions: 1,
			inbox: 50,
			unread: 25,
		});
		expect(today.by_account.work).toMatchObject({ inbox: 10, unread: 5 });
		expect(series.totals).toMatchObject({
			processed: 7,
			days_observed: 2,
			days_within_budget: 1,
			avg_needs_attention: 2.5,
			override_rate: 0.286,
			override_rate_by_route: {
				review: 0.5,
				archive: 0.5,
				attention: 0,
				draft_reply: 0,
				calendar: null,
			},
			override_rate_by_rubric_version: {
				"2026-11-08.2": 0.25,
				"2026-11-08.3": 0.333,
			},
		});
		expect(series.latest_mailbox).toMatchObject({ inbox: 50, unread: 25 });
	});

	it("the gmail_triage_metrics action reads both ports over the window and rejects a bad time zone", async () => {
		const port = {
			listDecisionFacts: vi.fn(async () => [fact({ route: "attention" })]),
			listMailboxSnapshots: vi.fn(async () => []),
		};
		const action = createGmailTriageMetricsAction(port, { now: () => now });
		const ctx = { context: { caller: "ui" as const, requestId: "r", userId: "u" }, auditSink: () => {} };

		const out = await executeAction(action, { days: 7 }, ctx);
		expect(out.days).toHaveLength(7);
		expect(out.totals.needs_attention).toBe(1);
		expect(port.listDecisionFacts).toHaveBeenCalledWith("2026-10-31T12:00:00.000Z", "u");

		await expect(executeAction(action, { time_zone: "Mars/Olympus" }, ctx)).rejects.toThrow("IANA");
	});
});
