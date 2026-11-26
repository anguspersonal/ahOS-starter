import { describe, expect, it, vi } from "vitest";
import { createGmailSearchAction } from "./search.js";
import {
	GmailApiError,
	LABEL_INBOX,
	LABEL_UNREAD,
	type GmailPort,
	type ParsedMessage,
} from "../../ports/gmail.js";

const ctx = { caller: "test", requestId: "r1" };

const twoHitFixture: ParsedMessage[] = [
	{
		id: "m1",
		threadId: "t1",
		from: "Alice <alice@example.com>",
		to: "owner@example.com",
		subject: "Notes: Q3 Review",
		date: "Mon, 7 Sep 2026 09:00:00 +0000",
		labelIds: [LABEL_UNREAD, LABEL_INBOX],
		snippet: "Action items",
		body: "Full body 1",
		links: [],
		attachments: [],
	},
	{
		id: "m2",
		threadId: "t2",
		from: "Bob <bob@example.com>",
		to: "owner@example.com",
		subject: "",
		date: "Sun, 6 Sep 2026 18:30:00 +0000",
		labelIds: [],
		snippet: "Follow-up",
		body: "Full body 2",
		links: [],
		attachments: [],
	},
];

function fakePort(impl: (params: any) => Promise<ParsedMessage[]>): GmailPort {
	return { searchMessages: vi.fn(impl) } as unknown as GmailPort;
}

describe("gmail_search", () => {
	it("defaults to personal (angus) when neither account nor domain is passed and renders two hits byte-identically to dev", async () => {
		const port = fakePort(async () => twoHitFixture);
		const action = createGmailSearchAction(port);
		const out = await action.run({ query: "newer_than:7d" }, ctx);

		expect(port.searchMessages).toHaveBeenCalledWith({
			domain: "angus",
			query: "newer_than:7d",
			maxResults: 10,
		});
		expect(out.account).toBe("personal");
		expect(action.formatMcp!(out)).toBe(
			[
				"2 message(s) in the 'personal' mailbox:",
				"• [m1 | thread: t1] Notes: Q3 Review — Alice <alice@example.com> (Mon, 7 Sep 2026 09:00:00 +0000, unread, inbox)",
				"• [m2 | thread: t2] (no subject) — Bob <bob@example.com> (Sun, 6 Sep 2026 18:30:00 +0000, read, archived)",
				"",
				"Read one in full with gmail_read (message_id or thread_id).",
			].join("\n"),
		);
	});

	it("reads the work mailbox when domain='work' or account='work' and returns dev's no-match text when empty", async () => {
		const port = fakePort(async () => []);
		const action = createGmailSearchAction(port);

		const outDomain = await action.run(
			{ domain: "work", query: "from:nobody@example.com", max_results: 25 },
			ctx,
		);
		expect(port.searchMessages).toHaveBeenCalledWith({
			domain: "work",
			query: "from:nobody@example.com",
			maxResults: 25,
		});
		expect(action.formatMcp!(outDomain)).toBe(
			"No messages in the 'work' mailbox for query: from:nobody@example.com",
		);

		const outAccount = await action.run(
			{ account: "work", query: "from:nobody@example.com" },
			ctx,
		);
		expect(action.formatMcp!(outAccount)).toBe(
			"No messages in the 'work' mailbox for query: from:nobody@example.com",
		);
	});

	it("refuses conflicting domain and account and propagates 404 GmailApiError naming the account", async () => {
		const err404 = new GmailApiError(
			"Gmail API GET /messages?q=missing&maxResults=10 failed for account 'personal' (404): Not Found",
			404,
			"notFound",
			"NOT_FOUND",
		);
		const action = createGmailSearchAction(
			fakePort(async () => {
				throw err404;
			}),
		);

		await expect(
			action.run({ domain: "work", account: "personal", query: "test" }, ctx),
		).rejects.toThrow(/different domains/);

		await expect(action.run({ query: "missing" }, ctx)).rejects.toMatchObject({
			name: "GmailApiError",
			status: 404,
			reason: "notFound",
			message: expect.stringContaining("account 'personal'"),
		});
	});
});
