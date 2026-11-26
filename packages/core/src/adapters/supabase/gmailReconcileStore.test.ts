import { describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "../fakeSupabase.testkit.js";
import {
	createSupabaseGmailReconcileStore,
	GMAIL_CANDIDATE_ARTIFACTS_OR_FILTER,
	GMAIL_CANDIDATE_LINKS_OR_FILTER,
	GMAIL_TRIAGE_DECISION_TYPE,
	GMAIL_TRIAGE_STAGE,
} from "./gmailReconcileStore.js";

describe("createSupabaseGmailReconcileStore", () => {
	it("Case 1: listCandidateGmailArtifacts(userId) queries artifacts scoped to user_id with the Gmail OR filter", async () => {
		const sampleArtifacts = [
			{
				id: "art-1",
				user_id: "user-123",
				source_channel: "gmail",
				source_url: "https://mail.google.com/mail/u/0/#inbox/18f123456789abcd",
				processing_metadata: { thread_id: "18f123456789abcd" },
				tags: ["account:personal"],
				text: "Hello",
				created_at: "2026-10-15T10:00:00Z",
			},
		];
		const fake = createFakeSupabase(() => ({ data: sampleArtifacts, error: null }));
		const store = createSupabaseGmailReconcileStore(fake.client, () => "fallback-user");

		const rows = await store.listCandidateGmailArtifacts("user-123");

		expect(rows).toEqual(sampleArtifacts);
		expect(fake.calls).toHaveLength(1);
		const call = fake.calls[0];
		expect(call.table).toBe("artifacts");
		expect(call.op).toBe("select");
		expect(call.selected).toBe(
			"id, user_id, source_channel, source_url, processing_metadata, tags, text, created_at",
		);
		expect(fake.filtersOf(call, "eq")).toEqual([["user_id", "user-123"]]);
		expect(fake.filtersOf(call, "or")).toEqual([[GMAIL_CANDIDATE_ARTIFACTS_OR_FILTER]]);
	});

	it("listCandidateGmailArtifacts falls back to getUserId() when userId is omitted and skips user_id filter when neither is set", async () => {
		const fakeWithDefault = createFakeSupabase(() => ({ data: [], error: null }));
		const storeWithDefault = createSupabaseGmailReconcileStore(
			fakeWithDefault.client,
			() => "default-user-id",
		);
		await storeWithDefault.listCandidateGmailArtifacts();
		expect(fakeWithDefault.filtersOf(fakeWithDefault.calls[0], "eq")).toEqual([
			["user_id", "default-user-id"],
		]);

		const fakeWithoutUser = createFakeSupabase(() => ({ data: [], error: null }));
		const storeWithoutUser = createSupabaseGmailReconcileStore(fakeWithoutUser.client);
		await storeWithoutUser.listCandidateGmailArtifacts();
		expect(fakeWithoutUser.filtersOf(fakeWithoutUser.calls[0], "eq")).toEqual([]);
		expect(fakeWithoutUser.filtersOf(fakeWithoutUser.calls[0], "or")).toEqual([
			[GMAIL_CANDIDATE_ARTIFACTS_OR_FILTER],
		]);
	});

	it("Case 2: listCandidateGmailExternalLinks(userId) queries artifact_external_links scoped to user_id with the Gmail links OR filter", async () => {
		const sampleLinks = [
			{
				artifact_id: "art-1",
				provider: "gmail",
				kind: "gmail_thread",
				external_id: "18f123456789abcd",
				external_url: "https://mail.google.com/mail/u/0/#inbox/18f123456789abcd",
			},
		];
		const fake = createFakeSupabase(() => ({ data: sampleLinks, error: null }));
		const store = createSupabaseGmailReconcileStore(fake.client, () => "fallback-user");

		const rows = await store.listCandidateGmailExternalLinks("user-456");

		expect(rows).toEqual(sampleLinks);
		expect(fake.calls).toHaveLength(1);
		const call = fake.calls[0];
		expect(call.table).toBe("artifact_external_links");
		expect(call.op).toBe("select");
		expect(call.selected).toBe("artifact_id, provider, kind, external_id, external_url");
		expect(fake.filtersOf(call, "eq")).toEqual([["user_id", "user-456"]]);
		expect(fake.filtersOf(call, "or")).toEqual([[GMAIL_CANDIDATE_LINKS_OR_FILTER]]);
	});

	it("Case 3: hasEntityLinksForArtifacts and listTaskExternalLinksForArtifacts return entity-link boolean and kind='task' external links", async () => {
		const taskLinks = [
			{
				external_id: "notion-page-1",
				provider: "notion_work",
				kind: "task",
			},
		];
		const fake = createFakeSupabase((call) => {
			if (call.table === "artifact_entity_links") {
				return { data: null, count: 2, error: null };
			}
			if (call.table === "artifact_external_links") {
				return { data: taskLinks, error: null };
			}
			return { data: [], error: null };
		});
		const store = createSupabaseGmailReconcileStore(fake.client);

		const hasLinks = await store.hasEntityLinksForArtifacts(["art-1", "art-2"]);
		expect(hasLinks).toBe(true);

		const tasks = await store.listTaskExternalLinksForArtifacts(["art-1", "art-2"]);
		expect(tasks).toEqual(taskLinks);

		expect(fake.calls).toHaveLength(2);

		const entityCall = fake.calls[0];
		expect(entityCall.table).toBe("artifact_entity_links");
		expect(entityCall.selected).toBe("artifact_id");
		expect(entityCall.options).toEqual({ count: "exact", head: true });
		expect(fake.filtersOf(entityCall, "in")).toEqual([["artifact_id", ["art-1", "art-2"]]]);

		const taskCall = fake.calls[1];
		expect(taskCall.table).toBe("artifact_external_links");
		expect(taskCall.selected).toBe("external_id, provider, kind");
		expect(fake.filtersOf(taskCall, "in")).toEqual([["artifact_id", ["art-1", "art-2"]]]);
		expect(fake.filtersOf(taskCall, "eq")).toEqual([["kind", "task"]]);
	});

	it("returns false / empty arrays when count is 0, artifactIds is empty, or Supabase returns an error", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			const zeroFake = createFakeSupabase(() => ({ data: null, count: 0, error: null }));
			const zeroStore = createSupabaseGmailReconcileStore(zeroFake.client);
			expect(await zeroStore.hasEntityLinksForArtifacts(["art-1"])).toBe(false);
			expect(await zeroStore.hasEntityLinksForArtifacts([])).toBe(false);
			expect(await zeroStore.listTaskExternalLinksForArtifacts([])).toEqual([]);
			expect(zeroFake.calls).toHaveLength(1);

			const errFake = createFakeSupabase(() => ({
				data: null,
				count: null,
				error: { message: "db failure" },
			}));
			const errStore = createSupabaseGmailReconcileStore(errFake.client);
			expect(await errStore.listCandidateGmailArtifacts("u1")).toEqual([]);
			expect(await errStore.listCandidateGmailExternalLinks("u1")).toEqual([]);
			expect(await errStore.hasEntityLinksForArtifacts(["art-1"])).toBe(false);
			expect(await errStore.listTaskExternalLinksForArtifacts(["art-1"])).toEqual([]);
		} finally {
			errorSpy.mockRestore();
			warnSpy.mockRestore();
		}
	});

	it("Case 4: recordTriageDecisions and recordTriageDecision persist Tier-2 rows into system_decisions", async () => {
		const fake = createFakeSupabase((call) => {
			if (call.table === "system_decisions" && call.op === "insert") {
				const rows = call.payload as Array<Record<string, unknown>>;
				return {
					data: rows.map((row, i) => ({
						id: `dec-${i + 1}`,
						user_id: row.user_id,
						artifact_id: row.artifact_id,
						decision_type: row.decision_type,
						confidence_score: row.confidence_score,
						decision_payload: row.decision_payload,
						created_at: "2026-10-26T16:00:00Z",
					})),
					error: null,
				};
			}
			return { data: [], error: null };
		});

		const store = createSupabaseGmailReconcileStore(fake.client, () => "user-789");

		const recorded = await store.recordTriageDecision({
			thread_id: "th-101",
			message_id: "msg-101",
			account: "work",
			sender: "partner@example.com",
			subject: "Urgent contract review",
			snippet: "Please review by EOD",
			intent_category: "to_respond",
			priority: 6,
			confidence: 0.92,
			storage_tier: "tier_3_full_artifact",
			gmail_action: "keep_inbox",
			artifact_id: "art-promoted-1",
			linked_entity_ids: ["ent-1"],
			reasons: ["intent:to_respond", "urgency_cue"],
			received_at: "2026-10-26T15:30:00Z",
		});

		expect(recorded).toMatchObject({
			id: "dec-1",
			thread_id: "th-101",
			message_id: "msg-101",
			account: "work",
			sender: "partner@example.com",
			subject: "Urgent contract review",
			intent_category: "to_respond",
			priority: 6,
			confidence: 0.92,
			storage_tier: "tier_3_full_artifact",
			gmail_action: "keep_inbox",
			artifact_id: "art-promoted-1",
			linked_entity_ids: ["ent-1"],
			reasons: ["intent:to_respond", "urgency_cue"],
			created_at: "2026-10-26T16:00:00Z",
		});

		expect(fake.calls).toHaveLength(1);
		const call = fake.calls[0];
		expect(call.table).toBe("system_decisions");
		expect(call.op).toBe("insert");
		const insertedPayload = (call.payload as Array<Record<string, unknown>>)[0];
		expect(insertedPayload.user_id).toBe("user-789");
		expect(insertedPayload.artifact_id).toBe("art-promoted-1");
		expect(insertedPayload.decision_type).toBe(GMAIL_TRIAGE_DECISION_TYPE);
		expect(insertedPayload.stage).toBe(GMAIL_TRIAGE_STAGE);
		expect(insertedPayload.status).toBe("auto_applied");
		expect(insertedPayload.review_type).toBe("suggestion");
		expect(insertedPayload.decision_payload).toMatchObject({
			workflow_name: "gmail_priority_triage",
			thread_id: "th-101",
			message_id: "msg-101",
			account: "work",
			priority: 6,
			intent_category: "to_respond",
			storage_tier: "tier_3_full_artifact",
			gmail_action: "keep_inbox",
			artifact_id: "art-promoted-1",
			promoted_artifact_id: "art-promoted-1",
		});
	});

	it("Case 5: listTriageDecisions and overrideTriageDecision query and update system_decisions", async () => {
		const storedRows = [
			{
				id: "dec-high",
				user_id: "user-789",
				artifact_id: "art-1",
				decision_type: GMAIL_TRIAGE_DECISION_TYPE,
				confidence_score: 0.95,
				decision_payload: {
					workflow_name: "gmail_priority_triage",
					thread_id: "th-high",
					message_id: "msg-high",
					account: "work",
					sender: "ceo@example.com",
					subject: "Series A term sheet",
					snippet: "Attached term sheet",
					intent_category: "to_respond",
					priority: 7,
					confidence: 0.95,
					storage_tier: "tier_3_full_artifact",
					gmail_action: "keep_inbox",
					artifact_id: "art-1",
					linked_entity_ids: ["ent-partner"],
					reasons: ["intent:to_respond", "key_person"],
					received_at: "2026-10-26T15:00:00Z",
				},
				created_at: "2026-10-26T15:01:00Z",
			},
			{
				id: "dec-low",
				user_id: "user-789",
				artifact_id: null,
				decision_type: GMAIL_TRIAGE_DECISION_TYPE,
				confidence_score: 0.88,
				decision_payload: {
					workflow_name: "gmail_priority_triage",
					thread_id: "th-low",
					message_id: "msg-low",
					account: "personal",
					sender: "newsletter@example.com",
					subject: "Weekly digest",
					snippet: "Top stories",
					intent_category: "marketing",
					priority: 1,
					confidence: 0.88,
					storage_tier: "tier_2_decision_log",
					gmail_action: "sweep_archive",
					artifact_id: null,
					linked_entity_ids: [],
					reasons: ["intent:marketing", "automated_sender"],
					received_at: "2026-10-26T14:00:00Z",
				},
				created_at: "2026-10-26T14:01:00Z",
			},
		];

		const fake = createFakeSupabase((call) => {
			if (call.table === "system_decisions" && call.op === "select") {
				return { data: storedRows, error: null };
			}
			if (call.table === "system_decisions" && call.op === "update") {
				const patch = call.payload as Record<string, unknown>;
				return {
					data: [
						{
							...storedRows[1],
							decision_payload: patch.decision_payload,
							resolved_at: patch.resolved_at,
						},
					],
					error: null,
				};
			}
			return { data: [], error: null };
		});

		const store = createSupabaseGmailReconcileStore(fake.client, () => "user-789");

		const highOnly = await store.listTriageDecisions({
			account: "work",
			minPriority: 5,
		});
		expect(highOnly).toHaveLength(1);
		expect(highOnly[0]?.thread_id).toBe("th-high");

		const overridden = await store.overrideTriageDecision({
			thread_id: "th-low",
			account: "personal",
			priority: 5,
			intent_category: "fyi",
			gmail_action: "keep_inbox",
			reason: "Important industry newsletter",
		});

		expect(overridden).not.toBeNull();
		expect(overridden?.priority).toBe(5);
		expect(overridden?.intent_category).toBe("fyi");
		expect(overridden?.gmail_action).toBe("keep_inbox");
		expect(overridden?.reasons).toContain("override:Important industry newsletter");
		expect(overridden?.overridden_at).toBeTruthy();

		const updateCall = fake.calls.find((c) => c.op === "update");
		expect(updateCall).toBeDefined();
		expect(updateCall?.table).toBe("system_decisions");
		expect(fake.filtersOf(updateCall!, "eq")).toEqual([
			["id", "dec-low"],
			["user_id", "user-789"],
		]);
	});

	it("ADR-118: a review decision is stored as a pending clarification and keeps its pipeline fields", async () => {
		const fake = createFakeSupabase(() => ({ data: [], error: null }));
		const store = createSupabaseGmailReconcileStore(fake.client, () => "user-1");

		const recorded = await store.recordTriageDecisions([
			{
				thread_id: "th-review",
				message_id: "m-1",
				account: "work",
				sender: "Jim <contact8@example.com>",
				subject: "Call This Week",
				intent_category: "to_respond",
				priority: 5,
				confidence: 0.7,
				gmail_action: "keep_inbox",
				route: "review",
				thinking_mode: "system_1",
				requires_human: true,
				hitl_reasons: ["mid_confidence_high_stakes"],
				rubric_version: "v1",
			},
			{
				thread_id: "th-archive",
				message_id: "m-2",
				account: "personal",
				sender: "Levi's <info@example.com>",
				subject: "Sale",
				intent_category: "marketing",
				priority: 1,
				confidence: 0.96,
				gmail_action: "sweep_archive",
				route: "archive",
			},
		]);

		const rows = fake.calls[0].payload as Array<Record<string, unknown>>;
		expect(rows[0]).toMatchObject({ status: "pending", requires_user_action: true, review_type: "clarification" });
		expect(rows[0].decision_payload).toMatchObject({ route: "review", hitl_reasons: ["mid_confidence_high_stakes"], rubric_version: "v1" });
		expect(rows[1]).toMatchObject({ status: "auto_applied", requires_user_action: false });
		expect(recorded[0]).toMatchObject({ route: "review", requires_human: true, thinking_mode: "system_1" });
	});

	it("ADR-118: listDecidedThreadIds reads the thread watermark off system_decisions payloads", async () => {
		const fake = createFakeSupabase(() => ({
			data: [{ decision_payload: { thread_id: "th-1" } }, { decision_payload: { thread_id: "th-1" } }],
			error: null,
		}));
		const store = createSupabaseGmailReconcileStore(fake.client, () => "user-1");

		const decided = await store.listDecidedThreadIds(["th-1", "th-2"]);

		expect([...decided]).toEqual(["th-1"]);
		expect(fake.filtersOf(fake.calls[0], "in")).toEqual([["decision_payload->>thread_id", ["th-1", "th-2"]]]);
		expect(await store.listDecidedThreadIds([])).toEqual(new Set());
	});
});
