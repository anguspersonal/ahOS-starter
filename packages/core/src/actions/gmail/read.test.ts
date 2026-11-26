import { describe, expect, it, vi } from "vitest";
import { createGmailReadAction } from "./read.js";
import {
	GmailApiError,
	LABEL_INBOX,
	LABEL_UNREAD,
	type GmailMessage,
	type GmailPort,
	type ParsedMessage,
} from "../../ports/gmail.js";

const ctx = { caller: "test", requestId: "r1" };

const toB64Url = (s: string): string =>
	btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function makePort(overrides: Partial<GmailPort>): GmailPort {
	return {
		searchMessages: vi.fn(),
		getMessage: vi.fn(),
		getThread: vi.fn(),
		getProfile: vi.fn(),
		...overrides,
	};
}

describe("gmail_read", () => {
	it("reads a single message, prefers plain-text over HTML, rescues HTML links when HTML-only, lists attachments, and renders byte-identically to dev", async () => {
		const rawMessage: GmailMessage = {
			id: "m1",
			threadId: "t1",
			labelIds: [LABEL_UNREAD, LABEL_INBOX],
			payload: {
				mimeType: "multipart/mixed",
				headers: [
					{ name: "From", value: "Alice <alice@example.com>" },
					{ name: "To", value: "owner@example.com" },
					{ name: "Date", value: "Mon, 7 Sep 2026 09:00:00 +0000" },
					{ name: "Subject", value: "Notes: Q3 Review" },
				],
				parts: [
					{
						mimeType: "multipart/alternative",
						parts: [
							{
								mimeType: "text/plain",
								body: { data: toB64Url("Plain text body preferred") },
							},
							{
								mimeType: "text/html",
								body: {
									data: toB64Url(
										'<p>HTML fallback <a href="https://docs.google.com/document/d/doc-1">Open in Docs</a></p>',
									),
								},
							},
						],
					},
					{
						filename: "agenda.pdf",
						mimeType: "application/pdf",
						body: { size: 4096, attachmentId: "att-1" },
					},
				],
			},
		};

		const port = makePort({
			getMessage: vi.fn(async () => rawMessage),
		});
		const action = createGmailReadAction(port);
		const out = await action.run({ message_id: "m1" }, ctx);

		expect(port.getMessage).toHaveBeenCalledWith({
			domain: "angus",
			messageId: "m1",
		});
		expect(out.account).toBe("personal");
		expect(out.messages[0]?.links).toEqual(["https://docs.google.com/document/d/doc-1"]);
		expect(action.formatMcp!(out)).toBe(
			[
				"id: m1  thread: t1",
				"From: Alice <alice@example.com>",
				"To: owner@example.com",
				"Date: Mon, 7 Sep 2026 09:00:00 +0000",
				"Subject: Notes: Q3 Review",
				"Labels: UNREAD, INBOX",
				"Attachments: agenda.pdf (application/pdf, 4096B, id: att-1)",
				"",
				"Plain text body preferred",
			].join("\n"),
		);

		const htmlOnlyMsg: GmailMessage = {
			id: "m2",
			threadId: "t2",
			labelIds: [],
			payload: {
				mimeType: "text/html",
				headers: [
					{ name: "From", value: "gemini-notes@example.com" },
					{ name: "To", value: "owner@example.com" },
					{ name: "Date", value: "Tue, 8 Sep 2026 10:00:00 +0000" },
					{ name: "Subject", value: "Meeting notes" },
				],
				body: {
					data: toB64Url(
						'<div>Read <a href="https://docs.google.com/document/d/abc">Open in Docs</a></div>',
					),
				},
			},
		};
		const htmlPort = makePort({
			getMessage: vi.fn(async () => htmlOnlyMsg),
		});
		const htmlOut = await createGmailReadAction(htmlPort).run(
			{ message_id: "m2", domain: "work" },
			ctx,
		);
		expect(action.formatMcp!(htmlOut)).toBe(
			[
				"id: m2  thread: t2",
				"From: gemini-notes@example.com",
				"To: owner@example.com",
				"Date: Tue, 8 Sep 2026 10:00:00 +0000",
				"Subject: Meeting notes",
				"Labels: (none)",
				"",
				"Read Open in Docs (https://docs.google.com/document/d/abc)",
			].join("\n"),
		);
	});

	it("reads a whole thread in order and truncates bodies exceeding max_chars exactly as dev does", async () => {
		const longBody = "a".repeat(150);
		const threadMessages: ParsedMessage[] = [
			{
				id: "m1",
				threadId: "t1",
				from: "Alice <alice@example.com>",
				to: "work@example.com",
				subject: "Thread start",
				date: "Mon, 7 Sep 2026 09:00:00 +0000",
				labelIds: ["INBOX"],
				snippet: "First",
				body: longBody,
				links: [],
				attachments: [],
			},
			{
				id: "m2",
				threadId: "t1",
				from: "Bob <bob@example.com>",
				to: "Alice <alice@example.com>",
				subject: "Re: Thread start",
				date: "Mon, 7 Sep 2026 09:30:00 +0000",
				labelIds: [],
				snippet: "Second",
				body: "",
				links: [],
				attachments: [],
			},
		];
		const port = makePort({
			getThread: vi.fn(async () => threadMessages),
		});
		const action = createGmailReadAction(port);
		const out = await action.run(
			{ thread_id: "t1", account: "work", max_chars: 100 },
			ctx,
		);

		expect(port.getThread).toHaveBeenCalledWith({
			domain: "work",
			threadId: "t1",
		});
		expect(out.account).toBe("work");
		expect(action.formatMcp!(out)).toBe(
			[
				"id: m1  thread: t1",
				"From: Alice <alice@example.com>",
				"To: work@example.com",
				"Date: Mon, 7 Sep 2026 09:00:00 +0000",
				"Subject: Thread start",
				"Labels: INBOX",
				"",
				`${"a".repeat(100)}\n… [truncated at 100 chars of 150]`,
				"",
				"---",
				"",
				"id: m2  thread: t1",
				"From: Bob <bob@example.com>",
				"To: Alice <alice@example.com>",
				"Date: Mon, 7 Sep 2026 09:30:00 +0000",
				"Subject: Re: Thread start",
				"Labels: (none)",
				"",
				"(no readable body)",
			].join("\n"),
		);
	});

	it("requires exactly one of message_id or thread_id, rejects conflicting domain/account, and propagates GmailApiError", async () => {
		const err404 = new GmailApiError(
			"Gmail API GET /messages/missing?format=full failed for account 'personal' (404): Not Found",
			404,
			"notFound",
			"NOT_FOUND",
		);
		const action = createGmailReadAction(
			makePort({
				getMessage: vi.fn(async () => {
					throw err404;
				}),
			}),
		);

		await expect(action.run({}, ctx)).rejects.toThrow(
			"Pass exactly one of message_id or thread_id.",
		);
		await expect(
			action.run({ message_id: "m1", thread_id: "t1" }, ctx),
		).rejects.toThrow("Pass exactly one of message_id or thread_id.");
		await expect(
			action.run({ message_id: "m1", domain: "work", account: "personal" }, ctx),
		).rejects.toThrow(/different domains/);

		await expect(action.run({ message_id: "missing" }, ctx)).rejects.toMatchObject({
			name: "GmailApiError",
			status: 404,
			reason: "notFound",
			message: expect.stringContaining("account 'personal'"),
		});
	});
});
