import { describe, expect, it } from "vitest";
import { extractEmailSignals } from "./emailSignals.js";
import { assessEmailSystem1, renderEmailRubricForPrompt, EMAIL_RUBRIC_VERSION } from "./emailRubric.js";
import {
	applyAttentionBudget,
	applyHitlPolicy,
	buildEmailDailyDigest,
	DEFAULT_EMAIL_HITL_POLICY,
	EMAIL_DAILY_DIGEST_SUBTYPE,
	EMAIL_TASK_THINKING_MODES,
	emailDailyDigestDedupKey,
	formatEmailDailyDigestMarkdown,
	routeEmail,
	selectThinkingMode,
	type EmailAssessment,
} from "./emailRouting.js";
import { computeEmailPipelineMetrics, flattenEmailPipelineMetrics } from "./emailMetrics.js";

const owner = { ownerAddresses: ["owner@example.com", "owner@work.example.com"] };

function s1(from: string, subject: string, extra: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) {
	const signals = extractEmailSignals({ from, subject, to: "owner@example.com", ...extra }, { ...owner, ...opts });
	return { signals, system1: assessEmailSystem1(signals) };
}

const asAssessment = (a: ReturnType<typeof assessEmailSystem1>, over: Partial<EmailAssessment> = {}): EmailAssessment => ({
	...a,
	thinkingMode: "system_1",
	...over,
});

describe("System 1 rubric", () => {
	it("files bulk promotions at P1 with high confidence", () => {
		const { system1 } = s1("Levi's <info@example.com>", "Up to 22% off sitewide", { listUnsubscribe: "<x>" });
		expect(system1).toMatchObject({ category: "marketing", priority: 1 });
		expect(system1.confidence).toBeGreaterThanOrEqual(0.9);
	});

	it("does not trust the Promotions tab alone to the auto-apply band", () => {
		const { system1 } = s1("Brand <noreply@brand.example>", "Hello there", { labelIds: ["CATEGORY_PROMOTIONS"] });
		expect(system1.category).toBe("marketing");
		expect(system1.confidence).toBeLessThan(0.9);
	});

	it("lifts a key relationship with a direct ask", () => {
		const { system1 } = s1("Briana <briana@work.example.com>", "Can you review the deck?", {}, { knownContact: true, relationship: "co-founder" });
		expect(system1).toMatchObject({ category: "to_respond", priority: 6 });
	});

	it("renders one rubric for the prompt, carrying its version", () => {
		const text = renderEmailRubricForPrompt();
		expect(text).toContain(EMAIL_RUBRIC_VERSION);
		expect(text).toContain("to_respond");
		expect(text).toContain("7 Critical");
	});
});

describe("thinking modes", () => {
	it("keeps confident machine mail in System 1 and escalates people", () => {
		const promo = s1("Levi's <info@example.com>", "Up to 22% off sitewide", { listUnsubscribe: "<x>" });
		expect(selectThinkingMode(promo.signals, promo.system1).mode).toBe("system_1");
		const human = s1("Jim <contact8@example.com>", "Call This Week", { snippet: "Are you free?" });
		expect(selectThinkingMode(human.signals, human.system1).mode).toBe("system_2");
	});

	it("declares a mode for every pipeline task", () => {
		expect(EMAIL_TASK_THINKING_MODES.reply_draft).toBe("system_2");
		expect(EMAIL_TASK_THINKING_MODES.noise_filter).toBe("system_1");
		expect(EMAIL_TASK_THINKING_MODES.categorise).toBe("escalate");
	});
});

describe("routing and HITL", () => {
	it("routes a P5+ ask to attention, and a drafted one to draft_reply", () => {
		const { signals, system1 } = s1("Jim <contact8@example.com>", "Call This Week", { snippet: "Are you free?" });
		const base = asAssessment(system1, { category: "to_respond", priority: 5, confidence: 0.95 });
		expect(routeEmail(base, signals)).toBe("attention");
		expect(routeEmail({ ...base, thinkingMode: "system_2", hasDraft: true }, signals)).toBe("draft_reply");
	});

	it("holds known contacts, sensitive mail and mid-confidence archives for review", () => {
		const contact = s1("Paul <paul@example.com>", "Photos", {}, { knownContact: true, relationship: "father" });
		const hitl = applyHitlPolicy("archive", asAssessment(contact.system1, { confidence: 0.95 }), contact.signals);
		expect(hitl.route).toBe("review");
		expect(hitl.hitlReasons).toContain("known_contact_protected");

		const sensitive = s1("Bank <alerts@bank.example>", "Payment failed on your account");
		expect(applyHitlPolicy("archive", asAssessment(sensitive.system1, { confidence: 0.95 }), sensitive.signals).hitlReasons).toContain(
			"sensitive_unverified",
		);

		const human = s1("Sam <sam@example.com>", "Catching up", { snippet: "Lovely to meet you." });
		expect(applyHitlPolicy("digest", asAssessment(human.system1, { confidence: 0.8 }), human.signals).hitlReasons).toContain(
			"mid_confidence_high_stakes",
		);
	});

	it("weights HITL by stakes: a mid-confidence promotion is filed without the owner", () => {
		const promo = s1("Levi's <info@example.com>", "Sale", { listUnsubscribe: "<x>" });
		expect(applyHitlPolicy("archive", asAssessment(promo.system1, { confidence: 0.7 }), promo.signals)).toMatchObject({
			route: "archive",
			requiresHuman: false,
		});
	});

	it("takes no Gmail action below the act floor", () => {
		const promo = s1("x <x@y.example>", "hm");
		const hitl = applyHitlPolicy("archive", asAssessment(promo.system1, { confidence: 0.3 }), promo.signals);
		expect(hitl).toMatchObject({ route: "review", autoApply: false, keepInInbox: true });
	});

	it("clears confident machine mail to leave the inbox", () => {
		const promo = s1("Levi's <info@example.com>", "Sale", { listUnsubscribe: "<x>" });
		expect(applyHitlPolicy("archive", asAssessment(promo.system1), promo.signals)).toMatchObject({
			route: "archive",
			requiresHuman: false,
			keepInInbox: false,
		});
	});

	it("budgets attention best-first and never cuts P7", () => {
		const items = [
			{ priority: 5, route: "attention" as const, received_at: "2026-11-01" },
			{ priority: 7, route: "review" as const, received_at: "2026-11-01" },
			{ priority: 6, route: "draft_reply" as const, received_at: "2026-11-01" },
			{ priority: 3, route: "archive" as const, received_at: "2026-11-01" },
		];
		const r = applyAttentionBudget(items, 1);
		expect(r.attention.map((i) => i.priority)).toEqual([7]);
		expect(r.overflow.map((i) => i.priority)).toEqual([6, 5]);
		expect(r.overBudget).toBe(true);
		expect(applyAttentionBudget(items, DEFAULT_EMAIL_HITL_POLICY.dailyAttentionBudget).overBudget).toBe(false);
	});
});

describe("metrics", () => {
	it("counts attention against the budget and flattens for scheduler_runs", () => {
		const m = computeEmailPipelineMetrics(
			[
				{ account: "personal", route: "attention", intent_category: "to_respond", priority: 6, thinking_mode: "system_2", requires_human: true },
				{ account: "personal", route: "archive", intent_category: "marketing", priority: 1, thinking_mode: "system_1", requires_human: false, applied: true },
				{ account: "work", route: "review", intent_category: "fyi", priority: 3, thinking_mode: "system_1", requires_human: true, gmail_category_contradiction: true },
			],
			{ mailboxBefore: { personal: { inbox: 50, unread: 40 }, work: { inbox: 30, unread: 10 } }, attentionBudget: 15 },
		);
		expect(m).toMatchObject({ processed: 3, needs_attention: 2, review: 1, leaves_inbox: 1, auto_applied: 1, system_2: 1, within_budget: true });
		expect(m.mailbox_before.total).toEqual({ inbox: 80, unread: 50 });
		const flat = flattenEmailPipelineMetrics(m);
		expect(flat).toMatchObject({ inbox_before: 80, unread_before: 50, needs_attention: 2, route_archive: 1 });
	});
});

// Golden examples: real threads the owner judged, kept as regression cases.
describe("golden examples", () => {
	function judge(env: Record<string, unknown>, opts: Record<string, unknown>) {
		const signals = extractEmailSignals({ from: "", ...env }, { ...owner, ...opts });
		const system1 = assessEmailSystem1(signals);
		const mode = selectThinkingMode(signals, system1).mode;
		const asmt = asAssessment(system1, {
			confidence: mode === "system_2" ? Math.min(system1.confidence, 0.89) : system1.confidence,
		});
		return { signals, system1, mode, gate: applyHitlPolicy(routeEmail(asmt, signals), asmt, signals) };
	}

	// 1. Owner: "archive it, cold sales from someone I've never replied to" (2026-11-08).
	const spendbase = {
		from: "Alex Rivera <mike.Rivera@vendor.example.com>",
		to: "owner@work.example.com",
		subject: 'Angus, not another "great connecting at VDS"',
		body: "Hi Angus, that 8% is just the starting point. Depending on your service mix, the real discount can run up to 35%. Out of curiosity where your AWS spend leans - compute, storage, CDN? Alex Rivera, Partnership Manager, Spendbase. Don't need this? A one-word reply is enough.",
		labelIds: ["UNREAD", "IMPORTANT", "CATEGORY_PERSONAL", "INBOX"],
	};

	it("1. archives cold sales from a stranger the owner never wrote to, in System 1", () => {
		const r = judge(spendbase, { ownerHasWritten: false });
		expect(r.signals.isColdOutreach).toBe(true);
		expect(r.system1).toMatchObject({ category: "marketing", priority: 1 });
		expect(r.mode).toBe("system_1");
		expect(r.gate).toMatchObject({ route: "archive", keepInInbox: false, requiresHuman: false });
	});

	it("1. holds the same pitch for review when the sent-mail history is unknown", () => {
		const r = judge(spendbase, {});
		expect(r.signals.isColdOutreach).toBe(false);
		expect(r.gate.keepInInbox).toBe(true);
	});

	it("1. never treats a pitch as cold once the owner has written to the sender", () => {
		expect(judge(spendbase, { ownerHasWritten: true }).signals.isColdOutreach).toBe(false);
	});

	it("1. never treats a sensitive pitch as cold", () => {
		const r = judge({ ...spendbase, body: `${spendbase.body} Your invoice is overdue.` }, { ownerHasWritten: false });
		expect(r.signals.isColdOutreach).toBe(false);
	});
});

describe("daily digest", () => {
	it("computes the canonical dedup_key per local calendar date", () => {
		expect(EMAIL_DAILY_DIGEST_SUBTYPE).toBe("email_digest_daily");
		expect(emailDailyDigestDedupKey("2026-11-08")).toBe("email_digest_daily:2026-11-08");
	});

	it("aggregates digest-routed items, deduplicates by account:thread_id, and formats one line per thread with sender, subject, account, and thread link", () => {
		const digest = buildEmailDailyDigest({
			date: "2026-11-08",
			generated_at: "2026-11-08T19:00:00.000Z",
			existingItems: [
				{
					thread_id: "th-1",
					account: "personal",
					sender: "Digest Bot <bot@example.com>",
					subject: "Earlier Subject",
					priority: 3,
					received_at: "2026-11-08T08:00:00Z",
				},
			],
			items: [
				{
					thread_id: "th-1",
					account: "personal",
					sender: "Digest Bot <bot@example.com>",
					subject: "Updated Morning Digest",
					priority: 3,
					received_at: "2026-11-08T08:00:00Z",
					route: "digest",
				},
				{
					thread_id: "th-2",
					account: "work",
					sender: "Team Updates <updates@work.example.com>",
					subject: "Weekly KPI Summary",
					priority: 4,
					received_at: "2026-11-08T09:00:00Z",
					route: "digest",
				},
				{
					thread_id: "th-ignored",
					account: "personal",
					sender: "Promo <promo@example.com>",
					subject: "Flash Sale",
					priority: 1,
					route: "archive",
				},
			],
		});

		expect(digest.date).toBe("2026-11-08");
		expect(digest.items).toHaveLength(2);
		expect(digest.items.map((i) => i.thread_id)).toEqual(["th-2", "th-1"]);
		expect(digest.items[0]?.source_url).toBe("https://mail.google.com/mail/u/1/#inbox/th-2");
		expect(digest.items[1]?.source_url).toBe("https://mail.google.com/mail/u/0/#inbox/th-1");

		const markdown = formatEmailDailyDigestMarkdown(digest);
		const summaryLines = markdown.split("\n").filter((line) => line.startsWith("- "));
		expect(summaryLines).toHaveLength(2);
		expect(summaryLines[0]).toContain("[work]");
		expect(summaryLines[0]).toContain("Team Updates <updates@work.example.com>");
		expect(summaryLines[0]).toContain("Weekly KPI Summary");
		expect(summaryLines[0]).toContain("https://mail.google.com/mail/u/1/#inbox/th-2");
		expect(summaryLines[1]).toContain("[personal]");
		expect(summaryLines[1]).toContain("Updated Morning Digest");
		expect(summaryLines[1]).toContain("https://mail.google.com/mail/u/0/#inbox/th-1");
	});
});

