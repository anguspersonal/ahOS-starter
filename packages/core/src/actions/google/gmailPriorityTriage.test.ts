import { describe, expect, it, vi } from "vitest";
import { executeAction } from "../adapters/direct.js";
import type { ActionContext } from "../types.js";
import type { EmailReasonerAssessment, EmailReasonerPort } from "../../ports/emailReasoner.js";
import {
	createGmailPriorityTriageAction,
	type GmailPriorityTriagePort,
	type GmailTriageThreadCandidate,
	inferEmailIntentCategory,
} from "./gmailPriorityTriage.js";

const ctx: ActionContext = {
	caller: "mcp",
	requestId: "req-test-adr118",
	userId: "user-angus",
};

function makePort(overrides: Partial<GmailPriorityTriagePort> = {}): GmailPriorityTriagePort {
	return {
		listInboxThreads: vi.fn().mockResolvedValue([]),
		recordTriageDecisions: vi.fn().mockImplementation(async (decisions) => decisions),
		promoteThreadToArtifact: vi
			.fn()
			.mockImplementation(async (candidate) => ({ artifact_id: `art-for-${candidate.thread_id}` })),
		sweepThread: vi.fn().mockResolvedValue(undefined),
		applyLabels: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

async function run(port: GmailPriorityTriagePort, input: Record<string, unknown>) {
	const action = createGmailPriorityTriageAction(port);
	return executeAction(action, input as never, { context: ctx, auditSink: () => {} });
}

// Fixtures drawn from the 2026-11-08 live dry run, where the first-cut triage put a
// Calvin Klein sale at P6 and would have swept a partner's "Call This Week" and the
// co-founder's shared folder out of the Work inbox.
const calvinKlein: GmailTriageThreadCandidate = {
	thread_id: "th-ck",
	account: "personal",
	sender: "Calvin Klein <news@example.com>",
	to: "owner@example.com",
	subject: "Singles Day 30% Off",
	snippet: "Shop now, limited time",
	label_ids: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
	list_unsubscribe: "<mailto:unsub@example.com>",
	received_at: "2026-11-07T09:55:31Z",
};

const attioCall: GmailTriageThreadCandidate = {
	thread_id: "th-attio",
	account: "work",
	sender: "Jim Rice <contact8@example.com>",
	to: "owner@work.example.com",
	subject: "Call This Week",
	snippet: "Hi Angus, are you free for a call on Thursday to talk through the pilot?",
	label_ids: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
	received_at: "2026-11-06T10:00:00Z",
};

const brianaFolder: GmailTriageThreadCandidate = {
	thread_id: "th-briana",
	account: "work",
	sender: '"Briana Longe (via Google Drive)" <drive-shares-dm-noreply@example.com>',
	to: "owner@work.example.com",
	subject: 'Folder shared with you: "UpLyft Source Docs - Work"',
	snippet: "Briana Longe shared a folder with you",
	label_ids: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
	received_at: "2026-11-05T10:00:00Z",
};

const invite: GmailTriageThreadCandidate = {
	thread_id: "th-invite",
	account: "work",
	sender: "Elnur Gajiev <hello@clinic.example.com>",
	to: "owner@work.example.com",
	subject: "Invitation: Angus & El @ Mon Nov 9, 2026 9:30am - 10am (GMT)",
	snippet: "You have been invited",
	label_ids: ["INBOX", "UNREAD"],
	received_at: "2026-11-06T11:00:00Z",
};

const morningBriefing: GmailTriageThreadCandidate = {
	thread_id: "th-brief",
	account: "personal",
	sender: "owner@example.com",
	to: "owner@example.com",
	subject: "Morning Briefing — Sunday 8 November 2026",
	snippet: "Your briefing",
	label_ids: ["INBOX", "UNREAD"],
	received_at: "2026-11-08T03:15:20Z",
};

const tiktok: GmailTriageThreadCandidate = {
	thread_id: "th-tiktok",
	account: "personal",
	sender: "TikTok <notification@example.com>",
	to: "owner@example.com",
	subject: "James and others started following you",
	label_ids: ["INBOX", "UNREAD", "CATEGORY_SOCIAL"],
	list_unsubscribe: "<https://tiktok.com/unsub>",
	received_at: "2026-11-07T17:01:10Z",
};

const byId = (decisions: Array<{ thread_id: string }>, id: string) =>
	decisions.find((d) => d.thread_id === id) as Record<string, unknown> | undefined;

describe("gmail_priority_triage (ADR-118 pipeline)", () => {
	it("defaults to shadow mode: judges and logs every thread but never touches Gmail", async () => {
		const port = makePort({
			listInboxThreads: vi.fn(async (account) =>
				account === "personal" ? [calvinKlein, morningBriefing, tiktok] : [attioCall, invite],
			),
		});

		const result = await run(port, {});

		expect(result.mode).toBe("shadow");
		expect(result.evaluated_count).toBe(5);
		expect(result.logged_decision_count).toBe(5);
		expect(port.sweepThread).not.toHaveBeenCalled();
		expect(port.applyLabels).not.toHaveBeenCalled();

		expect(byId(result.decisions, "th-ck")).toMatchObject({
			intent_category: "marketing",
			priority: 1,
			route: "unsubscribe_candidate",
		});
		expect(byId(result.decisions, "th-tiktok")).toMatchObject({ intent_category: "notification", route: "archive" });
		expect(byId(result.decisions, "th-brief")).toMatchObject({ route: "digest", sender_kind: "self" });
		expect(byId(result.decisions, "th-invite")).toMatchObject({ intent_category: "meeting_update" });
	});

	it("never files a human's direct ask away on System 1 alone, whatever Gmail's tab says", async () => {
		const port = makePort({ listInboxThreads: vi.fn(async (a) => (a === "work" ? [attioCall] : [])) });

		const result = await run(port, { mode: "act" });
		const attio = byId(result.decisions, "th-attio");

		expect(attio?.gmail_action).toBe("keep_inbox");
		expect(["attention", "review"]).toContain(attio?.route);
		expect(attio?.gmail_category_contradiction).toBe(true);
		expect(port.sweepThread).not.toHaveBeenCalled();
		expect(result.metrics.gmail_category_contradictions).toBe(1);
	});

	it("protects a graph-known contact from archive even when the mail itself looks automated", async () => {
		const port = makePort({
			listInboxThreads: vi.fn(async (a) => (a === "work" ? [brianaFolder] : [])),
			resolveGraphContext: vi.fn(async () => ({
				isKeyPerson: true,
				relationship: "co-founder",
				matchedHotEntities: ["ent-briana"],
			})),
		});

		const result = await run(port, { mode: "act" });
		const briana = byId(result.decisions, "th-briana");

		expect(briana?.gmail_action).toBe("keep_inbox");
		expect(briana?.sender_kind).toBe("known_contact");
		expect(briana?.linked_entity_ids).toEqual(["ent-briana"]);
		expect(port.sweepThread).not.toHaveBeenCalled();
	});

	it("golden 1: asks Sent mail about a pitching stranger and archives cold outreach in act mode", async () => {
		const spendbase: GmailTriageThreadCandidate = {
			thread_id: "th-spendbase",
			account: "work",
			sender: "Alex Rivera <mike.Rivera@vendor.example.com>",
			to: "owner@work.example.com",
			subject: 'Angus, not another "great connecting at VDS"',
			snippet: "the real discount can run up to 35%. Partnership Manager, Spendbase. A one-word reply is enough.",
			label_ids: ["INBOX", "UNREAD", "IMPORTANT", "CATEGORY_PERSONAL"],
		};
		const hasOwnerWrittenTo = vi.fn().mockResolvedValue(false);
		const port = makePort({
			listInboxThreads: vi.fn(async (a) => (a === "work" ? [spendbase, attioCall] : [])),
			hasOwnerWrittenTo,
		});

		const result = await run(port, { mode: "act" });

		// Only the pitch is looked up; the Attio ask never reads as a pitch.
		expect(hasOwnerWrittenTo).toHaveBeenCalledTimes(1);
		expect(hasOwnerWrittenTo).toHaveBeenCalledWith("mike.Rivera@vendor.example.com", "user-angus");
		expect(byId(result.decisions, "th-spendbase")?.route).toBe("archive");
		const archived = vi.mocked(port.sweepThread!).mock.calls.map(([t]) => t.thread_id);
		expect(archived).toEqual(["th-spendbase"]);
	});

	it("golden 1: keeps the pitch in the inbox when the Sent-mail lookup cannot answer", async () => {
		const port = makePort({
			listInboxThreads: vi.fn(async (a) =>
				a === "work"
					? [{
						thread_id: "th-pitch",
						account: "work" as const,
						sender: "Alex Rivera <mike.Rivera@vendor.example.com>",
						to: "owner@work.example.com",
						subject: "Quick one",
						snippet: "Partnership Manager. Worth seeing what that looks like for you?",
					}]
					: [],
			),
			hasOwnerWrittenTo: vi.fn().mockResolvedValue(null),
		});

		const result = await run(port, { mode: "act" });
		expect(byId(result.decisions, "th-pitch")?.gmail_action).toBe("keep_inbox");
		expect(port.sweepThread).not.toHaveBeenCalled();
	});

	it("act mode labels everything it judged and archives only what the HITL gate cleared", async () => {
		const port = makePort({
			listInboxThreads: vi.fn(async (a) => (a === "personal" ? [calvinKlein, tiktok, morningBriefing] : [attioCall])),
		});

		const result = await run(port, { mode: "act" });

		const archived = vi.mocked(port.sweepThread!).mock.calls.map(([t]) => t.thread_id).sort();
		expect(archived).toEqual(["th-brief", "th-ck", "th-tiktok"]);
		expect(port.applyLabels).toHaveBeenCalledWith(
			expect.objectContaining({ thread_id: "th-ck" }),
			{ add: ["ahOS/Triaged", "ahOS/Unsubscribe"], remove: [] },
		);
		expect(result.metrics.leaves_inbox).toBe(3);
		expect(result.metrics.needs_attention).toBe(1);
	});

	it("label mode applies ahOS labels and archives nothing", async () => {
		const port = makePort({ listInboxThreads: vi.fn(async (a) => (a === "personal" ? [calvinKlein] : [])) });

		await run(port, { mode: "label" });

		expect(port.applyLabels).toHaveBeenCalledTimes(1);
		expect(port.sweepThread).not.toHaveBeenCalled();
	});

	it("performs zero writes when dry_run is true, in any mode", async () => {
		const port = makePort({ listInboxThreads: vi.fn(async () => [calvinKlein]) });

		const result = await run(port, { mode: "act", dry_run: true, account: "personal" });

		expect(result.logged_decision_count).toBe(0);
		expect(port.recordTriageDecisions).not.toHaveBeenCalled();
		expect(port.promoteThreadToArtifact).not.toHaveBeenCalled();
		expect(port.applyLabels).not.toHaveBeenCalled();
		expect(port.sweepThread).not.toHaveBeenCalled();
	});

	it("never records a mailbox snapshot on a dry run", async () => {
		const recordMailboxSnapshot = vi.fn(async () => undefined);
		const port = makePort({
			listInboxThreads: vi.fn(async () => []),
			countMailbox: vi.fn(async () => ({ inbox: 1, unread: 1 })),
			recordMailboxSnapshot,
		});
		await run(port, { dry_run: true });
		expect(recordMailboxSnapshot).not.toHaveBeenCalled();
	});

	it("skips threads an earlier run decided unless reprocess is set", async () => {
		const port = makePort({
			listInboxThreads: vi.fn(async (a) => (a === "personal" ? [calvinKlein, tiktok] : [])),
			listDecidedThreadIds: vi.fn(async () => new Set(["th-ck"])),
		});

		const first = await run(port, {});
		expect(first.evaluated_count).toBe(1);
		expect(first.skipped_already_decided).toBe(1);

		const again = await run(port, { reprocess: true });
		expect(again.evaluated_count).toBe(2);
	});

	describe("System 2", () => {
		const assessment = (over: Partial<EmailReasonerAssessment> = {}): EmailReasonerAssessment => ({
			category: "to_respond",
			priority: 6,
			confidence: 0.93,
			rationale: "Partner asks for a call about the pilot this week.",
			needs_reply: true,
			suggested_route: null,
			draft_reply: "Hi Jim, Thursday works. How about 2pm? Angus",
			tasks: [
				{ title: "Book pilot call with Jim (Attio)", due: "2026-11-12", confidence: 0.95 },
				{ title: "Maybe send deck", due: null, confidence: 0.4 },
			],
			entities: [{ name: "Attio", type: "organization", email: null, role: null }],
			...over,
		});

		it("escalates human mail, reads the context port, drafts the reply and creates only confident tasks", async () => {
			const reasoner: EmailReasonerPort = {
				assess: vi.fn(async (req) =>
					req.thread_id === "th-attio"
						? assessment()
						: assessment({ category: "meeting_update", priority: 4, confidence: 0.92, draft_reply: null, tasks: [], entities: [] }),
				),
			};
			const port = makePort({
				listInboxThreads: vi.fn(async (a) => (a === "work" ? [attioCall, invite] : [calvinKlein])),
				reasoner,
				loadReasonerContext: vi.fn(async () => ({ state_doc_excerpt: "Priority: close Attio pilot" })),
				createReplyDraft: vi.fn(async () => ({ draft_id: "draft-1" })),
				createTasks: vi.fn(async (_c, tasks) => tasks.length),
			});

			const result = await run(port, { mode: "act" });
			const attio = byId(result.decisions, "th-attio");

			// Confident machine mail never reaches the model.
			const assessedIds = vi.mocked(reasoner.assess).mock.calls.map(([r]) => r.thread_id);
			expect(assessedIds).toContain("th-attio");
			expect(assessedIds).not.toContain("th-ck");
			expect(vi.mocked(reasoner.assess).mock.calls.find(([r]) => r.thread_id === "th-attio")?.[0].context)
				.toEqual({ state_doc_excerpt: "Priority: close Attio pilot" });

			expect(attio).toMatchObject({ route: "draft_reply", thinking_mode: "system_2", draft_id: "draft-1", created_task_count: 1 });
			expect(vi.mocked(port.createTasks!).mock.calls[0][1]).toHaveLength(1);
			expect(attio?.storage_tier).toBe("tier_3_full_artifact");
			expect(result.metrics.system_2).toBeGreaterThanOrEqual(1);
			expect(result.metrics.drafts_created).toBe(1);
			expect(result.metrics.tasks_extracted).toBe(2);
		});

		it("holds a thread for review when the model fails", async () => {
			const port = makePort({
				listInboxThreads: vi.fn(async (a) => (a === "work" ? [attioCall] : [])),
				reasoner: { assess: vi.fn(async () => null) },
			});

			const result = await run(port, { mode: "act" });
			const attio = byId(result.decisions, "th-attio");

			expect(attio?.thinking_mode).toBe("system_1");
			expect(attio?.reasons).toContain("system_2_failed");
			expect(attio?.gmail_action).toBe("keep_inbox");
		});

		it("does not let a mid-confidence model read archive a known contact", async () => {
			const port = makePort({
				listInboxThreads: vi.fn(async (a) => (a === "work" ? [brianaFolder] : [])),
				resolveGraphContext: vi.fn(async () => ({ isKeyPerson: true, relationship: "co-founder" })),
				reasoner: {
					assess: vi.fn(async () =>
						assessment({ category: "fyi", priority: 3, confidence: 0.7, suggested_route: "archive", draft_reply: null }),
					),
				},
			});

			const result = await run(port, { mode: "act" });

			expect(byId(result.decisions, "th-briana")).toMatchObject({ route: "review", requires_human: true });
			expect(port.sweepThread).not.toHaveBeenCalled();
		});
	});

	it("caps what reaches the owner at the daily budget, minus what earlier runs surfaced, and never cuts P7", async () => {
		const asks: GmailTriageThreadCandidate[] = Array.from({ length: 12 }, (_, i) => ({
			thread_id: `th-ask-${i}`,
			account: "personal",
			sender: `Person ${i} <p${i}@example.org>`,
			to: "owner@example.com",
			subject: `Question ${i}`,
			snippet: "Can you send me the numbers?",
			intent_category: "to_respond",
			base_priority: i === 0 ? 7 : 5,
			confidence: 0.95,
			received_at: `2026-11-07T${String(10 + i).padStart(2, "0")}:00:00Z`,
		}));
		const port = makePort({
			listInboxThreads: vi.fn(async (a) => (a === "personal" ? asks : [])),
			countSurfacedSince: vi.fn(async () => 10),
			countMailbox: vi.fn(async () => ({ inbox: 40, unread: 30 })),
			recordMailboxSnapshot: vi.fn(async () => undefined),
		});

		const result = await run(port, { attention_budget: 15 });

		expect(result.curated_count).toBe(12);
		expect(result.curated[0]?.priority).toBe(7);
		const over = result.curated.filter((d) => d.over_budget);
		// 15 - 10 surfaced earlier = 5 slots: the P7 takes one, four P5s the rest, seven overflow.
		expect(over).toHaveLength(7);
		expect(over.every((d) => d.priority === 5)).toBe(true);
		expect(result.metrics.attention_over_budget).toBe(7);
		expect(result.metrics.mailbox_before.total).toEqual({ inbox: 80, unread: 60 });
		expect(port.recordMailboxSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ accounts: { personal: { inbox: 40, unread: 30 }, work: { inbox: 40, unread: 30 } } }),
			"user-angus",
		);
	});

	it("reads owner addresses from the port so the Work mailbox sees direct mail as direct", async () => {
		const human: GmailTriageThreadCandidate = {
			thread_id: "th-direct",
			account: "work",
			sender: "Sam <sam@example.com>",
			to: "owner@newdomain.example",
			subject: "Intro",
			snippet: "Lovely to meet you at VDS.",
		};
		const port = makePort({
			listInboxThreads: vi.fn(async (a) => (a === "work" ? [human] : [])),
			getOwnerAddresses: vi.fn(async () => ["owner@newdomain.example"]),
		});

		const result = await run(port, {});

		expect(byId(result.decisions, "th-direct")?.reasons).toContain("direct_recipient");
	});

	it("inferEmailIntentCategory (legacy) still classifies common cues", () => {
		expect(
			inferEmailIntentCategory({ thread_id: "t1", account: "personal", sender: "cal@example.com", subject: "Invitation: Product Sync @ Mon Oct 26" }),
		).toBe("meeting_update");
		expect(
			inferEmailIntentCategory({ thread_id: "t2", account: "personal", sender: "news@example.com", subject: "Weekly digest - unsubscribe" }),
		).toBe("marketing");
		expect(
			inferEmailIntentCategory({ thread_id: "t3", account: "work", sender: "docs@example.com", subject: "Alice commented on Q4 Plan" }),
		).toBe("comment");
	});

	it("wires Stage 1 -> Hop 1 -> Hop 2 via decisionJudge: skips cold pitch, backfills email, creates contact, persists facts, and routes", async () => {
		const nick: GmailTriageThreadCandidate = {
			thread_id: "th-nick",
			account: "personal",
			sender: "Nick Carmont <contact2@example.com>",
			to: "owner@example.com",
			subject: "Re: Debate coaching",
			body: "Hi Angus, thanks for rearranging. Friday 13 November at 8am UK works for me.",
			owner_has_written: true,
		};
		const gina: GmailTriageThreadCandidate = {
			thread_id: "th-gina",
			account: "personal",
			sender: "Gina Williams <contact3@example.com>",
			to: "owner@example.com",
			subject: "Re: Wedding script draft",
			body: "Does that sound like you imagined? Just let me know how you would like it done.",
			owner_has_written: true,
		};
		const mustafa: GmailTriageThreadCandidate = {
			thread_id: "th-mustafa",
			account: "work",
			sender: "Mustafa Spahr <contact5@example.com>",
			to: "owner@work.example.com",
			subject: "Onboarding",
			body: "We built Onnboard to take the repetitive admin out of onboarding.",
			owner_has_written: false,
		};

		const makeRes = (id: string, yes: number) => ({
			id,
			kind: "noul" as const,
			choice: yes >= 0.5 ? "yes" : "no",
			confidence: Math.max(yes, 1 - yes),
			distribution: { yes, no: 1 - yes },
			model: "jev-latest",
			latency_ms: 10,
		});

		const backfillContactEmail = vi.fn().mockResolvedValue(undefined);
		const createContact = vi.fn().mockResolvedValue({ contact_id: "person-gina" });
		const fetchProbeEvidence = vi.fn().mockResolvedValue({
			calendarEvents: ["Debate Training - Nick | Fri 13 Nov 2026 08:00-09:00"],
			openTasks: [],
		});

		const port = makePort({
			listInboxThreads: vi.fn(async (a) => (a === "personal" ? [nick, gina] : [mustafa])),
			resolveGraphContext: vi.fn(async (c) =>
				c.thread_id === "th-nick"
					? {
							isKeyPerson: true,
							contactId: "person-nick",
							contactMissingEmail: true,
							relationship: "Coaching Client",
							matchedHotEntities: ["person-nick"],
						}
					: undefined,
			),
			backfillContactEmail,
			createContact,
			fetchProbeEvidence,
			decisionJudge: {
				evaluate: vi.fn(async (q) => {
					const state = q.state ?? q.prompt ?? "";
					if (q.id === "worth_analysis") {
						return makeRes("worth_analysis", state.includes("contact5@example.com") ? 0.1 : 0.95);
					}
					return makeRes(q.id, 0.1);
				}),
				evaluateBatch: vi.fn(async (questions) => {
					const state = questions[0]?.state ?? "";
					const isNick = state.includes("contact2@example.com");
					const out: Record<string, ReturnType<typeof makeRes>> = {};
					for (const q of questions) {
						if (q.id === "needs_reply") out[q.id] = makeRes(q.id, isNick ? 0.14 : 0.92);
						else if (q.id === "has_owner_commitment") out[q.id] = makeRes(q.id, 0.9);
						else if (q.id === "has_fact_to_persist") out[q.id] = makeRes(q.id, isNick ? 0.91 : 0.15);
						else if (q.id === "probe_calendar") out[q.id] = makeRes(q.id, isNick ? 0.95 : 0.05);
						else if (q.id === "probe_tasks") out[q.id] = makeRes(q.id, isNick ? 0.1 : 0.85);
						else if (q.id === "commitment_already_satisfied") out[q.id] = makeRes(q.id, isNick ? 0.85 : 0.07);
						else if (q.id === "adds_info_to_existing_item") out[q.id] = makeRes(q.id, 0.06);
						else if (q.id === "needs_owner_escalation") out[q.id] = makeRes(q.id, isNick ? 0.18 : 0.82);
						else out[q.id] = makeRes(q.id, 0.05);
					}
					return out;
				}),
			},
		});

		const result = await run(port, { mode: "act" });

		// 1. Mustafa cold pitch skipped at Stage 1 and archived.
		expect(byId(result.decisions, "th-mustafa")).toMatchObject({
			route: "archive",
			thinking_mode: "system_1",
			gmail_action: "sweep_archive",
		});

		// 2. Nick coaching: email backfilled, fact persisted (tier_3), commitment satisfied -> archived.
		expect(backfillContactEmail).toHaveBeenCalledWith("person-nick", "contact2@example.com", "user-angus");
		expect(byId(result.decisions, "th-nick")).toMatchObject({
			route: "archive",
			thinking_mode: "system_2",
			storage_tier: "tier_3_full_artifact",
			gmail_action: "sweep_archive",
		});

		// 3. Gina wedding script: new contact created, escalated to attention.
		expect(createContact).toHaveBeenCalledTimes(1);
		expect(byId(result.decisions, "th-gina")).toMatchObject({
			route: "attention",
			thinking_mode: "system_2",
			gmail_action: "keep_inbox",
			linked_entity_ids: ["person-gina"],
		});
	});

	it("returns daily_flow metrics per inbox (personal, work) and combined (all)", async () => {
		const port = makePort({
			listInboxThreads: vi.fn(async (account) =>
				account === "personal"
					? [
							{
								thread_id: "p-1",
								account: "personal",
								sender: "founder@example.com",
								subject: "Urgent: sign term sheet",
								is_direct_recipient: true,
								has_urgency_cue: true,
								received_at: "2026-11-07T09:00:00Z",
							},
						]
					: [
							{
								thread_id: "h-1",
								account: "work",
								sender: "digest@example.com",
								subject: "Weekly newsletter",
								is_noise: true,
								received_at: "2026-11-07T08:00:00Z",
							},
						],
			),
		});

		const action = createGmailPriorityTriageAction(port);
		const result = await executeAction(
			action,
			{
				account: "all",
				cut_line_priority: 5,
				dry_run: false,
				max_threads: 10,
			},
			{ context: ctx, auditSink: () => {} },
		);

		expect(result.daily_flow.date_key).toBe("2026-11-07");
		expect(result.daily_flow.personal).toMatchObject({
			account: "personal",
			starting: 0,
			new_today: 1,
			processed_today: 0,
			end: 1,
		});
		expect(result.daily_flow.work).toMatchObject({
			account: "work",
			starting: 0,
			new_today: 1,
			processed_today: 1,
			end: 0,
		});
		expect(result.daily_flow.combined).toMatchObject({
			account: "all",
			starting: 0,
			new_today: 2,
			processed_today: 1,
			end: 1,
		});
	});

	it("computes activeDateKey from the maximum valid received_at timestamp across decisions even when a higher-priority thread is older", async () => {
		const port = makePort({
			listInboxThreads: vi.fn(async (account) =>
				account === "personal"
					? [
							{
								thread_id: "older-p7",
								account: "personal",
								sender: "founder@example.com",
								subject: "Urgent: sign term sheet",
								base_priority: 7,
								intent_category: "to_respond",
								confidence: 0.96,
								is_direct_recipient: true,
								has_urgency_cue: true,
								received_at: "2026-11-05T09:00:00Z",
							},
							{
								thread_id: "newer-p2",
								account: "personal",
								sender: "digest@example.com",
								subject: "Weekly newsletter",
								is_noise: true,
								received_at: "2026-11-08T11:30:00Z",
							},
						]
					: [],
			),
		});

		const result = await run(port, { account: "personal" });

		// Even though `older-p7` sorts first in `curated`, `activeDateKey` uses the newest timestamp (`2026-11-08`).
		expect(result.curated[0]?.thread_id).toBe("older-p7");
		expect(result.daily_flow.date_key).toBe("2026-11-08");
		expect(result.daily_flow.personal).toMatchObject({
			account: "personal",
			starting: 1,
			new_today: 1,
			processed_today: 1,
			swept_today: 1,
			end: 1,
		});
	});

	it("emits one daily digest artifact via port.recordDailyDigest when digest-routed threads exist and dry_run is false", async () => {
		const recordDailyDigest = vi.fn().mockResolvedValue({ artifact_id: "art-digest-2026-11-08" });
		const port = makePort({
			listInboxThreads: vi.fn(async (a) => (a === "personal" ? [morningBriefing, calvinKlein] : [])),
			recordDailyDigest,
		});

		const action = createGmailPriorityTriageAction(port, {
			now: () => new Date("2026-11-08T12:00:00Z"),
		});
		const result = await executeAction(action, {}, { context: ctx, auditSink: () => {} });

		expect(recordDailyDigest).toHaveBeenCalledTimes(1);
		expect(recordDailyDigest).toHaveBeenCalledWith(
			expect.objectContaining({
				date: "2026-11-08",
				items: [
					expect.objectContaining({
						thread_id: "th-brief",
						account: "personal",
						sender: "owner@example.com",
						subject: "Morning Briefing — Sunday 8 November 2026",
						source_url: "https://mail.google.com/mail/u/0/#inbox/th-brief",
					}),
				],
			}),
			"user-angus",
		);
		expect(result.digest_artifact_id).toBe("art-digest-2026-11-08");
	});

	it("does not invoke port.recordDailyDigest when dry_run is true or no digest-routed threads exist", async () => {
		const recordDailyDigest = vi.fn().mockResolvedValue({ artifact_id: "art-digest-should-not-run" });
		const portWithDigest = makePort({
			listInboxThreads: vi.fn(async (a) => (a === "personal" ? [morningBriefing] : [])),
			recordDailyDigest,
		});

		const dryRunResult = await run(portWithDigest, { dry_run: true });
		expect(recordDailyDigest).not.toHaveBeenCalled();
		expect(dryRunResult.digest_artifact_id).toBeNull();

		const portNoDigest = makePort({
			listInboxThreads: vi.fn(async (a) => (a === "personal" ? [calvinKlein] : [])),
			recordDailyDigest,
		});
		const noDigestResult = await run(portNoDigest, { dry_run: false });
		expect(recordDailyDigest).not.toHaveBeenCalled();
		expect(noDigestResult.digest_artifact_id).toBeNull();
	});

	it("evaluates intent_category, base_priority, has_urgency_cue, and is_noise via port.judge and retains low-confidence (< 0.80) threads in inbox (#2121)", async () => {
		const judgeEvaluate = vi.fn().mockImplementation(async (question) => {
			if (question.id === "intent_category") {
				if (String(question.prompt ?? "").includes("ambiguous-promo")) {
					return {
						id: "intent_category",
						kind: "choice" as const,
						choice: "marketing",
						confidence: 0.65,
						distribution: { marketing: 0.65, fyi: 0.35 },
						model: "gemini-2.5-flash-lite",
						latency_ms: 12,
					};
				}
				return {
					id: "intent_category",
					kind: "choice" as const,
					choice: "marketing",
					confidence: 0.94,
					distribution: { marketing: 0.94, fyi: 0.06 },
					model: "gemini-2.5-flash-lite",
					latency_ms: 12,
				};
			}
			if (question.id === "base_priority") {
				return {
					id: "base_priority",
					kind: "score" as const,
					choice: "2",
					confidence: 0.94,
					distribution: { "1": 0.06, "2": 0.94 },
					score: 2,
					expected_score: 1.94,
					model: "gemini-2.5-flash-lite",
					latency_ms: 12,
				};
			}
			if (question.id === "has_urgency_cue") {
				return {
					id: "has_urgency_cue",
					kind: "noul" as const,
					choice: "no",
					confidence: 0.95,
					distribution: { yes: 0.05, no: 0.95 },
					model: "gemini-2.5-flash-lite",
					latency_ms: 12,
				};
			}
			return {
				id: "is_noise",
				kind: "noul" as const,
				choice: "yes",
				confidence: 0.92,
				distribution: { yes: 0.92, no: 0.08 },
				model: "gemini-2.5-flash-lite",
				latency_ms: 12,
			};
		});

		const port = makePort({
			listInboxThreads: vi.fn(async (a) =>
				a === "personal"
					? [
							{
								thread_id: "confident-promo",
								account: "personal",
								sender: "deals@example.com",
								subject: "Flash Sale 40% Off",
								snippet: "confident-promo snippet",
							},
							{
								thread_id: "ambiguous-promo",
								account: "personal",
								sender: "partner@example.com",
								subject: "Special offer or partnership follow-up",
								snippet: "ambiguous-promo snippet",
							},
						]
					: [],
			),
			judge: {
				evaluate: judgeEvaluate,
			},
		});

		const result = await run(port, {
			account: "personal",
			cut_line_priority: 5,
			dry_run: false,
			mode: "act",
		});

		expect(judgeEvaluate).toHaveBeenCalled();
		const confidentDecision = result.decisions.find((d) => d.thread_id === "confident-promo");
		const ambiguousDecision = result.decisions.find((d) => d.thread_id === "ambiguous-promo");

		expect(confidentDecision).toMatchObject({
			intent_category: "marketing",
			confidence: 0.94,
			gmail_action: "sweep_archive",
		});
		expect(ambiguousDecision).toMatchObject({
			intent_category: "marketing",
			confidence: 0.65,
			gmail_action: "keep_inbox",
			route: "review",
		});
		expect(port.sweepThread).toHaveBeenCalledTimes(1);
		expect(port.sweepThread).toHaveBeenCalledWith(expect.objectContaining({ thread_id: "confident-promo" }), "user-angus");
	});
});

