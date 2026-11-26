import { describe, expect, it, vi } from "vitest";
import { createGmailDraftAction } from "./draft.js";
import {
	GmailApiError,
	type DraftSummary,
	type GmailPort,
	type ParsedMessage,
	type ReplyContext,
} from "../../ports/gmail.js";

const ctx = { caller: "test", requestId: "r1" };

const decodeRaw = (raw: string): string =>
	Buffer.from(raw, "base64url").toString("utf-8");

function storedMsg(over: Partial<ParsedMessage> = {}): ParsedMessage {
	return {
		id: "m9",
		threadId: "t1",
		from: "owner@example.com",
		to: "alice@example.com",
		subject: "Hello",
		date: "Mon, 7 Sep 2026 09:00:00 +0000",
		labelIds: ["DRAFT"],
		snippet: "Body text",
		body: "Body text",
		links: [],
		attachments: [],
		...over,
	};
}

function fakePort(overrides: {
	getReplyContext?: (params: any) => Promise<ReplyContext>;
	createDraft?: (params: any) => Promise<DraftSummary>;
	updateDraft?: (params: any) => Promise<DraftSummary>;
	getDraft?: (params: any) => Promise<ParsedMessage>;
}): GmailPort {
	return {
		getReplyContext: vi.fn(
			overrides.getReplyContext ??
				(async () => ({
					threadId: "t1",
					messageIdHeader: "<orig@mail>",
					references: "<older@mail> <orig@mail>",
					replySubject: "Re: Budget",
					from: "her@example.com",
				})),
		),
		createDraft: vi.fn(
			overrides.createDraft ??
				(async () => ({ draftId: "d1", messageId: "m9", threadId: "t1" })),
		),
		updateDraft: vi.fn(
			overrides.updateDraft ??
				(async ({ draftId }) => ({ draftId, messageId: "m9", threadId: "t1" })),
		),
		getDraft: vi.fn(overrides.getDraft ?? (async () => storedMsg())),
	} as unknown as GmailPort;
}

describe("gmail_draft", () => {
	it("creates a new draft with raw RFC 2822 body and renders dev's text byte-for-byte", async () => {
		let seenRaw = "";
		const port = fakePort({
			createDraft: async ({ raw }) => {
				seenRaw = raw;
				return { draftId: "d1", messageId: "m9", threadId: "t1" };
			},
			getDraft: async () =>
				storedMsg({ to: "alice@example.com", subject: "Hello", body: "Body text" }),
		});
		const action = createGmailDraftAction(port);
		const out = await action.run(
			{
				domain: "angus",
				to: ["alice@example.com"],
				cc: ["cc@example.com"],
				subject: "Hello",
				body: "Body text",
			},
			ctx,
		);

		const decoded = decodeRaw(seenRaw);
		expect(decoded).toContain("To: alice@example.com");
		expect(decoded).toContain("Cc: cc@example.com");
		expect(decoded).toContain("Subject: Hello");
		expect(decoded).not.toMatch(/^From:/m);
		expect(port.updateDraft).not.toHaveBeenCalled();
		expect(action.formatMcp!(out)).toBe(
			[
				"Created draft d1 in the 'personal' mailbox. Nothing has been sent.",
				"",
				"To: alice@example.com",
				"Cc: cc@example.com",
				"Subject: Hello",
				"Thread: new conversation",
				"",
				"Body text",
				"",
				"Send it with gmail_send_draft({ account: 'personal', draft_id: 'd1' }), or open it in Gmail and send it by hand.",
			].join("\n"),
		);
	});

	it("replies in-thread with In-Reply-To and References, defaults to and subject, and warns when Message-ID is absent", async () => {
		const raws: string[] = [];
		const port = fakePort({
			getReplyContext: vi
				.fn()
				.mockResolvedValueOnce({
					threadId: "t1",
					messageIdHeader: "<orig@mail>",
					references: "<older@mail> <orig@mail>",
					replySubject: "Re: Budget",
					from: "her@example.com",
				})
				.mockResolvedValueOnce({
					threadId: "t1",
					messageIdHeader: "",
					references: "",
					replySubject: "Re: Budget",
					from: "her@example.com",
				}),
			createDraft: async ({ raw, threadId }) => {
				raws.push(raw);
				return { draftId: "d1", messageId: "m9", threadId: threadId ?? "t1" };
			},
			getDraft: async () =>
				storedMsg({ to: "her@example.com", subject: "Re: Budget", body: "sure" }),
		});
		const action = createGmailDraftAction(port);

		const out1 = await action.run(
			{ account: "work", body: "sure", reply_to_message_id: "m1" },
			ctx,
		);
		const raw1 = decodeRaw(raws[0]!);
		expect(raw1).toContain("To: her@example.com");
		expect(raw1).toContain("Subject: Re: Budget");
		expect(raw1).toContain("In-Reply-To: <orig@mail>");
		expect(raw1).toContain("References: <older@mail> <orig@mail>");
		expect(action.formatMcp!(out1)).toContain("Thread: t1 (reply)");
		expect(action.formatMcp!(out1)).toContain(
			"Recipient defaulted to the original sender: her@example.com",
		);

		const out2 = await action.run(
			{ domain: "angus", body: "sure", reply_to_message_id: "m2" },
			ctx,
		);
		expect(action.formatMcp!(out2)).toMatch(/may appear as a new conversation/);
	});

	it("updates an existing draft by draft_id instead of creating a new one", async () => {
		const port = fakePort({
			getDraft: async () => storedMsg({ to: "a@example.com", subject: "hi", body: "x" }),
		});
		const action = createGmailDraftAction(port);
		const out = await action.run(
			{
				account: "personal",
				to: ["a@example.com"],
				subject: "hi",
				body: "x",
				draft_id: "d1",
			},
			ctx,
		);

		expect(port.updateDraft).toHaveBeenCalledWith({
			domain: "angus",
			draftId: "d1",
			raw: expect.any(String),
			threadId: undefined,
		});
		expect(port.createDraft).not.toHaveBeenCalled();
		expect(action.formatMcp!(out)).toContain(
			"Updated draft d1 in the 'personal' mailbox. Nothing has been sent.",
		);
	});

	it("refuses missing account/domain, missing to/subject, header injection, and propagates GmailApiError", async () => {
		const err404 = new GmailApiError(
			"Gmail API GET /messages/m404?format=full failed for account 'personal' (404): Not Found",
			404,
			"notFound",
			"NOT_FOUND",
		);
		const action = createGmailDraftAction(
			fakePort({
				getReplyContext: async () => {
					throw err404;
				},
			}),
		);

		await expect(
			action.run({ to: ["a@example.com"], subject: "hi", body: "x" }, ctx),
		).rejects.toThrow(
			"`domain` is required to send — 'work' (the work.example.com Workspace account) or 'angus' (the personal one). There is no default: sending as the wrong identity cannot be taken back.",
		);
		await expect(
			action.run(
				{ domain: "work", account: "personal", to: ["a@example.com"], subject: "hi", body: "x" },
				ctx,
			),
		).rejects.toThrow(/different domains/);
		await expect(
			action.run({ account: "personal", subject: "hi", body: "x" }, ctx),
		).rejects.toThrow(/`to` is required/);
		await expect(
			action.run({ account: "personal", to: ["a@example.com"], body: "x" }, ctx),
		).rejects.toThrow(/`subject` is required/);
		await expect(
			action.run(
				{
					account: "personal",
					to: ["a@example.com\r\nBcc: evil@example.com"],
					subject: "hi",
					body: "x",
				},
				ctx,
			),
		).rejects.toThrow(/inject a header/);
		await expect(
			action.run({ account: "personal", body: "x", reply_to_message_id: "m404" }, ctx),
		).rejects.toMatchObject({
			name: "GmailApiError",
			status: 404,
			reason: "notFound",
		});
	});
});
