import { describe, expect, it, vi, beforeEach } from "vitest";
import {
	computeDailyEmailFlowDedupKey,
	computeUtcDateKey,
	DAILY_EMAIL_FLOW_CONTENT_SUBTYPE,
} from "@ahkms/core";
import { createGmailPriorityTriagePort } from "../automations/gmailWorkflow.js";

// Mock google/gmail.js
vi.mock("../google/gmail.js", () => ({
	getThread: vi.fn(),
	modifyLabels: vi.fn(),
	listLabels: vi.fn(),
	ensureLabel: vi.fn(),
	getLabelCounts: vi.fn(),
	listMessageIds: vi.fn(),
	searchMessages: vi.fn(),
	getReplyContext: vi.fn(),
	createDraft: vi.fn(),
	LABEL_INBOX: "INBOX",
	LABEL_UNREAD: "UNREAD",
}));

// Mock tools/capture.js
vi.mock("../tools/capture.js", () => ({
	captureCore: vi.fn().mockResolvedValue({ id: "art-email-flow-scorecard" }),
}));

// Mock credentials.js
vi.mock("../credentials.js", () => ({
	getCredential: vi.fn().mockResolvedValue("mock-token"),
}));

// Mock notion.js
vi.mock("../notion.js", () => ({
	retrieveNotionPage: vi.fn(),
	listNotionBlockChildren: vi.fn().mockResolvedValue([]),
}));

import { getLabelCounts, listMessageIds } from "../google/gmail.js";
import { captureCore } from "../tools/capture.js";

describe("createGmailPriorityTriagePort.getDailyEmailFlow", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const makeArtifactsClient = (
		rows: Array<{
			dedup_key?: string | null;
			processing_metadata?: Record<string, unknown> | null;
		}>,
	) => {
		const limitMock = vi.fn().mockResolvedValue({ data: rows, error: null });
		const orderMock = vi.fn(() => ({ limit: limitMock }));
		const eqSubtypeMock = vi.fn(() => ({ order: orderMock }));
		const eqUserMock = vi.fn(() => ({ eq: eqSubtypeMock }));
		const selectMock = vi.fn(() => ({ eq: eqUserMock }));
		return {
			client: {
				from: vi.fn(() => ({ select: selectMock })),
			} as any,
			eqSubtypeMock,
		};
	};

	it("chains prior-day end -> starting, uses thread-level getLabelCounts('INBOX').threadsUnread, queries newToday without in:inbox, and persists scorecard via captureCore", async () => {
		(getLabelCounts as any).mockImplementation(
			async (account: "personal" | "work") => ({
				threadsTotal: account === "personal" ? 160 : 95,
				threadsUnread: account === "personal" ? 118 : 74,
				messagesTotal: account === "personal" ? 210 : 120,
				messagesUnread: account === "personal" ? 145 : 88,
			}),
		);
		(listMessageIds as any).mockImplementation(
			async (account: "personal" | "work", query: string) => {
				expect(query).toMatch(/^after:\d{4}\/\d{2}\/\d{2} -from:me$/);
				expect(query).not.toContain("in:inbox");
				return {
					ids: Array.from(
						{ length: account === "personal" ? 12 : 8 },
						(_, idx) => `${account}-msg-${idx}`,
					),
					nextPageToken: null,
				};
			},
		);

		const { client, eqSubtypeMock } = makeArtifactsClient([
			{
				dedup_key: "kpi_email_daily:2026-11-06",
				processing_metadata: {
					daily_email_flow: {
						personal: { end: 125 },
						work: { end: 76 },
					},
				},
			},
		]);

		const port = createGmailPriorityTriagePort({
			client,
			getUserId: () => "user-angus",
			reasoner: null,
		});

		const snapshot = await port.getDailyEmailFlow!(
			{
				accountFilter: "all",
				dryRun: false,
				evaluatedByAccount: { personal: 25, work: 20 },
				curatedByAccount: { personal: 15, work: 10 },
				sweptByAccount: { personal: 10, work: 10 },
				newTodayByAccount: { personal: 12, work: 8 },
			},
			"user-angus",
		);

		expect(eqSubtypeMock).toHaveBeenCalledWith(
			"content_subtype",
			DAILY_EMAIL_FLOW_CONTENT_SUBTYPE,
		);
		expect(getLabelCounts).toHaveBeenCalledWith("personal", "INBOX");
		expect(getLabelCounts).toHaveBeenCalledWith("work", "INBOX");

		// Personal: starting 125 (from prior end) + new 12 - end 118 = 19 processed (10 swept, 9 manual)
		expect(snapshot?.personal).toMatchObject({
			account: "personal",
			starting: 125,
			new_today: 12,
			processed_today: 19,
			swept_today: 10,
			manual_or_reconciled_today: 9,
			end: 118,
		});
		// Work: starting 76 (from prior end) + new 8 - end 74 = 10 processed (10 swept, 0 manual)
		expect(snapshot?.work).toMatchObject({
			account: "work",
			starting: 76,
			new_today: 8,
			processed_today: 10,
			swept_today: 10,
			manual_or_reconciled_today: 0,
			end: 74,
		});
		expect(snapshot?.combined).toMatchObject({
			account: "all",
			starting: 201,
			new_today: 20,
			processed_today: 29,
			swept_today: 20,
			end: 192,
		});

		expect(captureCore).toHaveBeenCalledTimes(1);
		expect(captureCore).toHaveBeenCalledWith(
			expect.objectContaining({
				content_subtype: DAILY_EMAIL_FLOW_CONTENT_SUBTYPE,
				surface: "kpi_snapshot",
			}),
			"user-angus",
			{ updateOnDedupKey: true },
		);
	});

	it("accumulates swept_today across same-day re-runs while preserving today's starting count", async () => {
		const todayKey = computeUtcDateKey(new Date());
		const todayDedupKey = computeDailyEmailFlowDedupKey(todayKey);

		(getLabelCounts as any).mockImplementation(
			async (account: "personal" | "work") => ({
				threadsTotal: 150,
				threadsUnread: account === "personal" ? 122 : 74,
				messagesTotal: 180,
				messagesUnread: 130,
			}),
		);
		(listMessageIds as any).mockImplementation(
			async (account: "personal" | "work") => ({
				ids: Array.from(
					{ length: account === "personal" ? 12 : 8 },
					(_, idx) => `${account}-msg-${idx}`,
				),
				nextPageToken: null,
			}),
		);

		const { client } = makeArtifactsClient([
			{
				dedup_key: todayDedupKey,
				processing_metadata: {
					daily_email_flow: {
						personal: { starting: 125, swept_today: 10, end: 127 },
						work: { starting: 76, swept_today: 6, end: 78 },
					},
				},
			},
			{
				dedup_key: "kpi_email_daily:2026-11-01",
				processing_metadata: {
					daily_email_flow: {
						personal: { end: 999 },
						work: { end: 999 },
					},
				},
			},
		]);

		const port = createGmailPriorityTriagePort({
			client,
			getUserId: () => "user-angus",
			reasoner: null,
		});

		const snapshot = await port.getDailyEmailFlow!(
			{
				accountFilter: "all",
				dryRun: false,
				evaluatedByAccount: { personal: 15, work: 10 },
				curatedByAccount: { personal: 10, work: 6 },
				sweptByAccount: { personal: 5, work: 4 },
				newTodayByAccount: { personal: 12, work: 8 },
			},
			"user-angus",
		);

		// Preserves today's starting (125 / 76) and accumulates swept_today (10 + 5 = 15, 6 + 4 = 10)
		expect(snapshot?.personal.starting).toBe(125);
		expect(snapshot?.personal.swept_today).toBe(15);
		expect(snapshot?.personal.processed_today).toBe(15);
		expect(snapshot?.personal.end).toBe(122);

		expect(snapshot?.work.starting).toBe(76);
		expect(snapshot?.work.swept_today).toBe(10);
		expect(snapshot?.work.processed_today).toBe(10);
		expect(snapshot?.work.end).toBe(74);

		expect(snapshot?.combined.swept_today).toBe(25);
	});

	it("falls back to context curated/newToday counts on Gmail error and skips captureCore when dryRun is true", async () => {
		(getLabelCounts as any).mockRejectedValue(
			new Error("Gmail API quota exceeded"),
		);
		(listMessageIds as any).mockRejectedValue(
			new Error("Gmail API quota exceeded"),
		);

		const { client } = makeArtifactsClient([]);
		const port = createGmailPriorityTriagePort({
			client,
			getUserId: () => "user-angus",
			reasoner: null,
		});

		const snapshot = await port.getDailyEmailFlow!(
			{
				accountFilter: "all",
				dryRun: true,
				evaluatedByAccount: { personal: 14, work: 9 },
				curatedByAccount: { personal: 8, work: 5 },
				sweptByAccount: { personal: 6, work: 4 },
				newTodayByAccount: { personal: 7, work: 3 },
			},
			"user-angus",
		);

		expect(snapshot?.personal).toMatchObject({
			account: "personal",
			new_today: 7,
			processed_today: 6,
			swept_today: 6,
			end: 8,
			starting: 7,
		});
		expect(snapshot?.work).toMatchObject({
			account: "work",
			new_today: 3,
			processed_today: 4,
			swept_today: 4,
			end: 5,
			starting: 6,
		});
		expect(captureCore).not.toHaveBeenCalled();
	});
});

describe("createGmailPriorityTriagePort.backfillContactEmail", () => {
	it("guards with .is('email', null), scopes by user_id, and throws when Supabase returns an error", async () => {
		const eqUserMock = vi.fn().mockResolvedValue({ error: null });
		const isEmailNullMock = vi.fn(() => ({ eq: eqUserMock }));
		const eqIdMock = vi.fn(() => ({ is: isEmailNullMock }));
		const updateMock = vi.fn(() => ({ eq: eqIdMock }));
		const client = {
			from: vi.fn(() => ({ update: updateMock })),
		} as any;

		const port = createGmailPriorityTriagePort({
			client,
			getUserId: () => "user-default",
			reasoner: null,
		});

		await port.backfillContactEmail!("person-nick", "  contact2@example.com ", "user-angus");

		expect(client.from).toHaveBeenCalledWith("people");
		expect(updateMock).toHaveBeenCalledWith(
			expect.objectContaining({ email: "contact2@example.com" }),
		);
		expect(eqIdMock).toHaveBeenCalledWith("id", "person-nick");
		expect(isEmailNullMock).toHaveBeenCalledWith("email", null);
		expect(eqUserMock).toHaveBeenCalledWith("user_id", "user-angus");

		eqUserMock.mockResolvedValueOnce({ error: { message: "unique constraint violation" } });
		await expect(
			port.backfillContactEmail!("person-nick", "contact2@example.com", "user-angus"),
		).rejects.toThrow("unique constraint violation");
	});
});
