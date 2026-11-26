import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "../fakeSupabase.testkit.js";
import { createSupabaseEmailMetricsStore, EMAIL_DECISION_FACT_COLUMNS } from "./emailMetricsStore.js";

describe("createSupabaseEmailMetricsStore", () => {
	it("reads decision facts as payload projections and counts extracted items", async () => {
		const fake = createFakeSupabase(() => ({
			data: [
				{
					created_at: "2026-11-08T09:00:00Z",
					status: "modified",
					route: "review",
					natural_route: "archive",
					rubric_version: "2026-11-08.3",
					sender: "Dana <dana@studio.example>",
					sender_kind: "human",
					gmail_category: "promotions",
					intent_category: "to_respond",
					priority: 5,
					applied: false,
					extracted_tasks: [{ title: "x" }, { title: "y" }],
					extracted_entities: null,
				},
			],
			error: null,
		}));
		const store = createSupabaseEmailMetricsStore(fake.client, () => "user-1");

		const rows = await store.listDecisionFacts("2026-11-01T00:00:00Z");
		const corrections = await store.listOwnerCorrections?.(3);

		expect(rows[0]).toMatchObject({
			route: "review",
			natural_route: "archive",
			rubric_version: "2026-11-08.3",
			sender_kind: "human",
			gmail_category: "promotions",
			applied: false,
			tasks_extracted: 2,
			entities_extracted: 0,
		});
		expect(corrections?.[0]).toMatchObject({
			sender_kind: "human",
			gmail_category: "promotions",
			system_1_verdict: "archive",
			owner_verdict: { category: "to_respond", priority: 5, route: "review" },
		});
		expect(fake.calls[0].table).toBe("system_decisions");
		expect(fake.calls[0].selected).toBe(EMAIL_DECISION_FACT_COLUMNS);
		expect(EMAIL_DECISION_FACT_COLUMNS).toContain("rubric_version");
		expect(EMAIL_DECISION_FACT_COLUMNS).not.toContain("draft_reply");
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([
			["decision_type", "gmail_priority_triage"],
			["user_id", "user-1"],
		]);
	});

	it("reads mailbox snapshots off the daily metrics artifacts and drops malformed counts", async () => {
		const fake = createFakeSupabase(() => ({
			data: [
				{
					updated_at: "2026-11-08T11:00:00Z",
					processing_metadata: {
						mailbox: {
							date: "2026-11-08",
							observed_at: "2026-11-08T11:00:00Z",
							accounts: { personal: { inbox: 40, unread: 20 }, work: { inbox: "x" } },
						},
					},
				},
				{ updated_at: "2026-11-07T11:00:00Z", processing_metadata: {} },
			],
			error: null,
		}));
		const store = createSupabaseEmailMetricsStore(fake.client);

		const snaps = await store.listMailboxSnapshots("2026-11-01T00:00:00Z");

		expect(snaps).toEqual([
			{ date: "2026-11-08", observed_at: "2026-11-08T11:00:00Z", accounts: { personal: { inbox: 40, unread: 20 } } },
		]);
		expect(fake.filtersOf(fake.calls[0], "eq")).toEqual([
			["content_subtype", "email_mailbox_daily"],
			["archived", false],
		]);
	});
});
