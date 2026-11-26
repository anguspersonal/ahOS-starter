import { describe, expect, it } from "vitest";
import {
	applyProcessedDeltaToInboxFlow,
	applyProcessedDeltaToSnapshot,
	buildDailyEmailFlowCapturePayload,
	buildDailyEmailFlowSnapshot,
	chainDailyEmailFlowSeries,
	clampEmailPriority,
	classifyEmailTriageTier,
	computeCombinedDailyEmailFlow,
	computeDailyEmailFlowDedupKey,
	computeDailyInboxFlowMetrics,
	DAILY_EMAIL_FLOW_FORMULA,
	DAILY_EMAIL_FLOW_UNREAD_QUERY,
	DEFAULT_PRIORITY_CUT_LINE,
	EMAIL_INTENT_CATEGORIES,
	EMAIL_STORAGE_TIERS,
	evaluateEmailPriority,
	GMAIL_SWEEP_ACTIONS,
	parseStoredDailyEmailFlowArtifact,
	partitionCuratedInbox,
	renderDailyEmailFlowMarkdown,
	scoreEmailPriority,
} from "./emailTriage.js";

describe("emailTriage domain model", () => {
	describe("canonical constants and schemas", () => {
		it("exports the 8 orthogonal semantic intent categories", () => {
			expect(EMAIL_INTENT_CATEGORIES).toEqual([
				"to_respond",
				"fyi",
				"comment",
				"notification",
				"meeting_update",
				"awaiting_reply",
				"actioned",
				"marketing",
			]);
		});

		it("exports the 3 storage tiers and Gmail sweep actions", () => {
			expect(EMAIL_STORAGE_TIERS).toEqual([
				"tier_1_gmail_only",
				"tier_2_decision_log",
				"tier_3_full_artifact",
			]);
			expect(GMAIL_SWEEP_ACTIONS).toEqual(["keep_inbox", "sweep_archive"]);
			expect(DEFAULT_PRIORITY_CUT_LINE).toBe(5);
		});
	});

	describe("scoreEmailPriority and evaluateEmailPriority", () => {
		it("clamps priority scores strictly to the 1..7 integer scale", () => {
			expect(clampEmailPriority(-10)).toBe(1);
			expect(clampEmailPriority(0)).toBe(1);
			expect(clampEmailPriority(1)).toBe(1);
			expect(clampEmailPriority(4.6)).toBe(5);
			expect(clampEmailPriority(7)).toBe(7);
			expect(clampEmailPriority(99)).toBe(7);
			expect(clampEmailPriority(Number.NaN)).toBe(1);

			expect(
				scoreEmailPriority({
					basePriority: 10,
					isDirectRecipient: true,
					hasUrgencyCue: true,
					matchedHotEntities: ["Work", "Series A"],
					keyPeople: ["founder@example.com"],
				}),
			).toBe(7);

			expect(
				scoreEmailPriority({
					basePriority: 0,
					intentCategory: "marketing",
					isAutomatedSender: true,
					isNoise: true,
				}),
			).toBe(1);
		});

		it("boosts priority using knowledge graph context (hot entities, key people, active tasks)", () => {
			const baselineFyi = scoreEmailPriority({
				intentCategory: "fyi",
			});
			expect(baselineFyi).toBe(3);

			const graphEnriched = evaluateEmailPriority({
				intentCategory: "fyi",
				graphContext: {
					matchedHotEntities: ["Work", "Q4 Launch"],
					keyPeople: ["partner@example.com"],
					activeTasks: ["task-123"],
				},
			});

			expect(graphEnriched.baseScore).toBe(3);
			expect(graphEnriched.graphBoost).toBe(4);
			expect(graphEnriched.priority).toBe(7);
			expect(graphEnriched.reasons).toEqual(
				expect.arrayContaining([
					"intent:fyi",
					"matched_hot_entities:2",
					"key_person",
					"active_tasks:1",
				]),
			);
		});

		it("supports top-level graph context fields and message urgency/automated cues", () => {
			const urgentFromVip = evaluateEmailPriority({
				intentCategory: "meeting_update",
				subject: "URGENT: Board sync reschedule",
				isDirectRecipient: true,
				matchedHotEntities: ["Board"],
				isKeyPerson: true,
			});
			expect(urgentFromVip.priority).toBe(7);
			expect(urgentFromVip.reasons).toContain("direct_recipient");
			expect(urgentFromVip.reasons).toContain("urgency_cue");
			expect(urgentFromVip.reasons).toContain("key_person");

			const automatedNotification = evaluateEmailPriority({
				intentCategory: "notification",
				sender: "no-reply@notifications.example.com",
				isDirectRecipient: false,
			});
			expect(automatedNotification.priority).toBe(1);
			expect(automatedNotification.reasons).toContain("automated_sender");
			expect(automatedNotification.reasons).toContain("indirect_recipient");
		});
	});

	describe("classifyEmailTriageTier", () => {
		it("assigns tier_3_full_artifact and keep_inbox at or above the default cut-line (5)", () => {
			const p5 = classifyEmailTriageTier(5);
			expect(p5).toEqual({
				priority: 5,
				cutLine: 5,
				confidence: 1,
				storageTier: "tier_3_full_artifact",
				gmailAction: "keep_inbox",
				promoteToArtifact: true,
			});

			const p7 = classifyEmailTriageTier(7, 5, 0.92);
			expect(p7.storageTier).toBe("tier_3_full_artifact");
			expect(p7.gmailAction).toBe("keep_inbox");
			expect(p7.promoteToArtifact).toBe(true);
			expect(p7.confidence).toBe(0.92);
		});

		it("assigns tier_2_decision_log and sweep_archive below the cut-line when high-priority items exist", () => {
			const p4 = classifyEmailTriageTier(4, 5, 0.85);
			expect(p4).toEqual({
				priority: 4,
				cutLine: 5,
				confidence: 0.85,
				storageTier: "tier_2_decision_log",
				gmailAction: "sweep_archive",
				promoteToArtifact: false,
			});
		});

		it("supports custom cut-lines, keeping inbox when no high-priority items exist, and tier_1_gmail_only opt-out", () => {
			const customCutLine = classifyEmailTriageTier(4, 4);
			expect(customCutLine.storageTier).toBe("tier_3_full_artifact");
			expect(customCutLine.gmailAction).toBe("keep_inbox");
			expect(customCutLine.promoteToArtifact).toBe(true);

			const noHighPriorityBatch = classifyEmailTriageTier(3, 5, {
				confidence: 0.75,
				hasHighPriorityItems: false,
			});
			expect(noHighPriorityBatch.storageTier).toBe("tier_2_decision_log");
			expect(noHighPriorityBatch.gmailAction).toBe("keep_inbox");

			const unloggedNoise = classifyEmailTriageTier(1, 5, {
				skipDecisionLog: true,
			});
			expect(unloggedNoise.storageTier).toBe("tier_1_gmail_only");
			expect(unloggedNoise.gmailAction).toBe("sweep_archive");
			expect(unloggedNoise.promoteToArtifact).toBe(false);
		});
	});

	describe("partitionCuratedInbox", () => {
		it("orders curated threads descending by priority then newest-first, and sweeps low-priority threads", () => {
			const decisions = [
				{ id: "p5-older", priority: 5, receivedAt: "2026-10-26T08:00:00Z" },
				{ id: "p3-newer", priority: 3, receivedAt: "2026-10-26T11:00:00Z" },
				{ id: "p7-older", priority: 7, receivedAt: "2026-10-26T09:00:00Z" },
				{ id: "p5-newer", priority: 5, receivedAt: "2026-10-26T10:30:00Z" },
				{ id: "p7-newer", priority: 7, receivedAt: "2026-10-26T12:00:00Z" },
				{ id: "p1-oldest", priority: 1, receivedAt: "2026-10-26T07:00:00Z" },
				{ id: "p6-mid", priority: 6, receivedAt: "2026-10-26T10:00:00Z" },
			];

			const result = partitionCuratedInbox(decisions, 5);

			expect(result.shouldSweepLowPriority).toBe(true);
			expect(result.curated.map((d) => d.id)).toEqual([
				"p7-newer",
				"p7-older",
				"p6-mid",
				"p5-newer",
				"p5-older",
			]);
			expect(result.swept.map((d) => d.id)).toEqual(["p3-newer", "p1-oldest"]);
		});

		it("returns uncapped high-priority threads even when more than 100 qualify", () => {
			const manyHighPriority = Array.from({ length: 125 }, (_, index) => ({
				id: `thread-${index}`,
				priority: index % 2 === 0 ? 7 : 5,
				received_at: new Date(Date.UTC(2026, 9, 26, 0, 0, index)).toISOString(),
			}));

			const result = partitionCuratedInbox(manyHighPriority, 5);
			expect(result.curated).toHaveLength(125);
			expect(result.swept).toHaveLength(0);
			expect(result.shouldSweepLowPriority).toBe(true);
			expect(result.curated[0]?.id).toBe("thread-124");
		});

		it("sets shouldSweepLowPriority to false when no threads meet the priority cut-line", () => {
			const lowOnly = [
				{ id: "low-1", priority: 2, receivedAt: "2026-10-26T08:00:00Z" },
				{ id: "low-2", priority: 4, receivedAt: "2026-10-26T09:00:00Z" },
			];

			const result = partitionCuratedInbox(lowOnly, 5);
			expect(result.curated).toEqual([]);
			expect(result.swept.map((d) => d.id)).toEqual(["low-2", "low-1"]);
			expect(result.shouldSweepLowPriority).toBe(false);
		});
	});

	describe("Daily Email Flow Waterfall Metrics (Unread & Processed per Inbox + Combined)", () => {
		it("enforces End = Starting + New Today - Processed Today for each inbox and combined", () => {
			const snapshot = buildDailyEmailFlowSnapshot({
				date_key: "2026-11-07",
				generated_at: "2026-11-07T09:00:00.000Z",
				personal: {
					starting: 130,
					new_today: 24,
					processed_today: 0,
				},
				work: {
					starting: 80,
					new_today: 16,
					processed_today: 0,
				},
			});

			expect(snapshot.unread_query).toBe(DAILY_EMAIL_FLOW_UNREAD_QUERY);
			expect(snapshot.formula).toBe(DAILY_EMAIL_FLOW_FORMULA);

			expect(snapshot.personal).toEqual({
				account: "personal",
				starting: 130,
				new_today: 24,
				processed_today: 0,
				end: 154,
				net_delta: 24,
				swept_today: 0,
				manual_or_reconciled_today: 0,
				clearance_rate_pct: 0,
			});

			expect(snapshot.work).toEqual({
				account: "work",
				starting: 80,
				new_today: 16,
				processed_today: 0,
				end: 96,
				net_delta: 16,
				swept_today: 0,
				manual_or_reconciled_today: 0,
				clearance_rate_pct: 0,
			});

			expect(snapshot.combined).toEqual({
				account: "all",
				starting: 210,
				new_today: 40,
				processed_today: 0,
				end: 250,
				net_delta: 40,
				swept_today: 0,
				manual_or_reconciled_today: 0,
				clearance_rate_pct: 0,
			});
		});

		it("derives processed_today from starting + new_today - end when live end is measured", () => {
			const personal = computeDailyInboxFlowMetrics({
				account: "personal",
				starting: 150,
				new_today: 25,
				end: 120,
				swept_today: 20,
			});

			// 150 + 25 - 120 = 55 processed today (20 swept + 35 manual/reconciled)
			expect(personal.processed_today).toBe(55);
			expect(personal.swept_today).toBe(20);
			expect(personal.manual_or_reconciled_today).toBe(35);
			expect(personal.end).toBe(120);
			expect(personal.net_delta).toBe(-30);
			expect(personal.clearance_rate_pct).toBe(220);
		});

		it("reconciles new_today when starting + new_today - processed_today < end in the hasStarting && hasEnd && !hasProcessed branch", () => {
			const reconciled = computeDailyInboxFlowMetrics({
				account: "personal",
				starting: 100,
				new_today: 5,
				end: 102,
				swept_today: 6,
			});

			// processed_today = max(6, 100 + 5 - 102) = 6; since 100 + 5 - 6 < 102,
			// new_today reconciles to 102 + 6 - 100 = 8 so End = Starting + New Today - Processed Today holds.
			expect(reconciled.starting).toBe(100);
			expect(reconciled.processed_today).toBe(6);
			expect(reconciled.swept_today).toBe(6);
			expect(reconciled.end).toBe(102);
			expect(reconciled.new_today).toBe(8);
			expect(
				reconciled.starting + reconciled.new_today - reconciled.processed_today,
			).toBe(reconciled.end);
		});

		it("supports Day-1 mid-day baseline pinning (Starting 250, New Today 40, Processed 0, End 250) and tracks Processed going up and End going down", () => {
			const day1Pinned = computeDailyInboxFlowMetrics({
				account: "all",
				starting: 250,
				new_today: 40,
				processed_today: 0,
				end: 250,
				preserve_explicit_baseline: true,
			});

			expect(day1Pinned.starting).toBe(250);
			expect(day1Pinned.new_today).toBe(40);
			expect(day1Pinned.processed_today).toBe(0);
			expect(day1Pinned.end).toBe(250);

			const afterProcessing15 = applyProcessedDeltaToInboxFlow(
				day1Pinned,
				15,
				{ isSwept: true },
			);
			expect(afterProcessing15.processed_today).toBe(15);
			expect(afterProcessing15.end).toBe(235);
			expect(afterProcessing15.net_delta).toBe(-15);
		});

		it("updates per-inbox and combined flow as threads are processed so processed_today goes up and end goes down", () => {
			let snapshot = buildDailyEmailFlowSnapshot({
				date_key: "2026-11-07",
				personal: { starting: 130, new_today: 24, processed_today: 0 },
				work: { starting: 80, new_today: 16, processed_today: 0 },
			});

			expect(snapshot.combined.processed_today).toBe(0);
			expect(snapshot.combined.end).toBe(250);

			// Process 10 personal threads and 8 work threads
			snapshot = applyProcessedDeltaToSnapshot(snapshot, "personal", 10, {
				isSwept: true,
			});
			snapshot = applyProcessedDeltaToSnapshot(snapshot, "work", 8, {
				isSwept: false,
			});

			expect(snapshot.personal.processed_today).toBe(10);
			expect(snapshot.personal.end).toBe(144);
			expect(snapshot.work.processed_today).toBe(8);
			expect(snapshot.work.end).toBe(88);

			expect(snapshot.combined.processed_today).toBe(18);
			expect(snapshot.combined.end).toBe(232);
			expect(snapshot.combined.swept_today).toBe(10);
			expect(snapshot.combined.manual_or_reconciled_today).toBe(8);
		});

		it("chains multi-day email flow series where Day[t].starting equals Day[t-1].end", () => {
			const series = chainDailyEmailFlowSeries([
				{
					date_key: "2026-11-05",
					personal: { starting: 150, new_today: 20, processed_today: 30 }, // end = 140
					work: { starting: 100, new_today: 20, processed_today: 10 }, // end = 110
				},
				{
					date_key: "2026-11-06",
					personal: { new_today: 15, processed_today: 25 }, // starting = 140, end = 130
					work: { new_today: 10, processed_today: 30 }, // starting = 110, end = 90
				},
				{
					date_key: "2026-11-07",
					personal: { new_today: 10, processed_today: 20 }, // starting = 130, end = 120
					work: { new_today: 5, processed_today: 15 }, // starting = 90, end = 80
				},
			]);

			expect(series).toHaveLength(3);
			expect(series[0]?.combined).toMatchObject({
				starting: 250,
				new_today: 40,
				processed_today: 40,
				end: 250,
			});
			expect(series[1]?.combined).toMatchObject({
				starting: 250,
				new_today: 25,
				processed_today: 55,
				end: 220,
			});
			expect(series[2]?.combined).toMatchObject({
				starting: 220,
				new_today: 15,
				processed_today: 35,
				end: 200,
			});
		});

		it("builds and parses stored daily email flow scorecard artifacts (kpi_email_daily:<YYYY-MM-DD>)", () => {
			const snapshot = buildDailyEmailFlowSnapshot({
				date_key: "2026-11-08",
				generated_at: "2026-11-08T12:00:00.000Z",
				personal: { starting: 130, new_today: 24, processed_today: 14 },
				work: { starting: 80, new_today: 16, processed_today: 6 },
			});

			expect(computeDailyEmailFlowDedupKey("2026-11-08")).toBe(
				"kpi_email_daily:2026-11-08",
			);

			const md = renderDailyEmailFlowMarkdown(snapshot);
			expect(md).toContain("# Daily Email Flow Scorecard — 2026-11-08");
			expect(md).toContain("| Personal (angus) | 130 | +24 | 14 | 140 |");
			expect(md).toContain("| Work (work) | 80 | +16 | 6 | 90 |");
			expect(md).toContain(
				"| **Combined (All)** | **210** | **+40** | **20** | **230** |",
			);

			const payload = buildDailyEmailFlowCapturePayload(snapshot);
			expect(payload.dedup_key).toBe("kpi_email_daily:2026-11-08");
			expect(payload.surface).toBe("kpi_snapshot");
			expect(payload.content_subtype).toBe("daily_email_flow_scorecard");
			expect(payload.processing_metadata.derivation).toEqual({
				status: "skipped",
				reason: "role_metrics",
			});

			const roundTripped = parseStoredDailyEmailFlowArtifact({
				id: "art-email-flow-1",
				dedup_key: payload.dedup_key,
				surface: payload.surface,
				content_subtype: payload.content_subtype,
				processing_metadata: payload.processing_metadata,
			});

			expect(roundTripped).toEqual(snapshot);

			// Also parses partial stored metadata by recomputing combined waterfall
			const partialParsed = parseStoredDailyEmailFlowArtifact({
				dedup_key: "kpi_email_daily:2026-11-07",
				processing_metadata: {
					daily_email_flow: {
						personal: { starting: 150, new_today: 20, processed_today: 30 },
						work: { starting: 100, new_today: 20, processed_today: 10 },
					},
				},
			});
			expect(partialParsed?.date_key).toBe("2026-11-07");
			expect(partialParsed?.combined.starting).toBe(250);
			expect(partialParsed?.combined.end).toBe(250);
			expect(parseStoredDailyEmailFlowArtifact(null)).toBeNull();
		});
	});
});
