import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleGmailAdapter } from "../../adapters/google/gmail/index.js";
import type { CapturePort } from "../../ports/artifacts.js";
import { GmailApiError } from "../../ports/gmail.js";
import { createGmailDraftAction } from "./draft.js";
import { createGmailLabelsAction } from "./labels.js";
import { createGmailModifyAction } from "./modify.js";
import { createGmailReadAction } from "./read.js";
import { createGmailSearchAction } from "./search.js";
import { createGmailSendDraftAction } from "./sendDraft.js";

const ctx = { caller: "test", requestId: "req-1651" };

const FORBIDDEN_RECEIPT_KEYS = ["subject", "body", "from", "to", "snippet"] as const;

function assertIdOnlyReceipt(receipt: unknown, expectedAccount: string): void {
	expect(receipt).toBeDefined();
	expect(typeof receipt).toBe("object");
	const obj = receipt as Record<string, unknown>;
	expect(obj.account).toBe(expectedAccount);
	for (const key of FORBIDDEN_RECEIPT_KEYS) {
		expect(obj).not.toHaveProperty(key);
	}
}

function makeAdapter(fetchFn: typeof fetch) {
	return createGoogleGmailAdapter({
		clientId: "cid",
		clientSecret: "csec",
		refreshToken: (domain) => (domain === "work" ? "rt-work" : "rt-personal"),
		fetchFn,
	});
}

function b64url(s: string): string {
	return Buffer.from(s, "utf8").toString("base64url");
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Gmail alignment (#1651)", () => {
	it("1. pages gmail_search with next_cursor and sends pageToken when cursor is passed", async () => {
		const seenUrls: URL[] = [];
		const fetchFn = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(String(input));
			if (url.href === "https://oauth2.googleapis.com/token") {
				return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
			}
			seenUrls.push(url);
			if (url.pathname.endsWith("/messages")) {
				const pageToken = url.searchParams.get("pageToken");
				if (!pageToken) {
					return new Response(
						JSON.stringify({ messages: [{ id: "m1" }], nextPageToken: "p2" }),
						{ status: 200 },
					);
				}
				return new Response(JSON.stringify({ messages: [{ id: "m2" }] }), { status: 200 });
			}
			const id = url.pathname.split("/").pop()!;
			return new Response(
				JSON.stringify({
					id,
					threadId: `t-${id}`,
					labelIds: ["INBOX"],
					payload: {
						headers: [
							{ name: "From", value: "Alice <alice@example.com>" },
							{ name: "To", value: "owner@example.com" },
							{ name: "Subject", value: `Subject ${id}` },
							{ name: "Date", value: "Mon, 7 Sep 2026 09:00:00 +0000" },
						],
					},
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;

		const action = createGmailSearchAction(makeAdapter(fetchFn));

		const page1 = await action.run({ query: "is:unread" }, ctx);
		expect(page1.next_cursor).toBe("p2");
		expect(page1.receipt.has_more).toBe(true);
		expect(seenUrls[0].searchParams.get("pageToken")).toBeNull();

		const page2 = await action.run({ query: "is:unread", cursor: "p2" }, ctx);
		expect(page2.next_cursor).toBeNull();
		expect(page2.receipt.has_more).toBe(false);
		const listCall2 = seenUrls.find(
			(u, i) => i >= 2 && u.pathname.endsWith("/messages"),
		);
		expect(listCall2?.searchParams.get("pageToken")).toBe("p2");
	});

	it("2. gmail_search sends format=metadata with From, To, Subject, Date headers and never format=full", async () => {
		const seenUrls: URL[] = [];
		const fetchFn = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(String(input));
			if (url.href === "https://oauth2.googleapis.com/token") {
				return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
			}
			seenUrls.push(url);
			if (url.pathname.endsWith("/messages")) {
				return new Response(JSON.stringify({ messages: [{ id: "m1" }, { id: "m2" }] }), {
					status: 200,
				});
			}
			return new Response(
				JSON.stringify({
					id: url.pathname.split("/").pop(),
					threadId: "t1",
					labelIds: [],
					payload: { headers: [] },
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;

		const action = createGmailSearchAction(makeAdapter(fetchFn));
		await action.run({ query: "newer_than:1d" }, ctx);

		const getCalls = seenUrls.filter((u) => /\/messages\/m\d+$/.test(u.pathname));
		expect(getCalls).toHaveLength(2);
		for (const u of getCalls) {
			expect(u.searchParams.get("format")).toBe("metadata");
			expect(u.searchParams.get("format")).not.toBe("full");
			expect(u.searchParams.getAll("metadataHeaders")).toEqual([
				"From",
				"To",
				"Subject",
				"Date",
			]);
		}
	});

	it("3. gmail_read on a 40-message thread with max_messages: 25 returns 25 newest messages and states '25 of 40'", async () => {
		const messages = Array.from({ length: 40 }, (_, i) => ({
			id: `m${i + 1}`,
			threadId: "t-big",
			labelIds: ["INBOX"],
			payload: {
				mimeType: "text/plain",
				headers: [
					{ name: "From", value: "sender@example.com" },
					{ name: "To", value: "owner@example.com" },
					{ name: "Date", value: "Mon, 7 Sep 2026 09:00:00 +0000" },
					{ name: "Subject", value: `Msg ${i + 1}` },
				],
				body: { data: b64url(`Body ${i + 1}`) },
			},
		}));

		const fetchFn = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(String(input));
			if (url.href === "https://oauth2.googleapis.com/token") {
				return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
			}
			return new Response(JSON.stringify({ messages }), { status: 200 });
		}) as unknown as typeof fetch;

		const action = createGmailReadAction(makeAdapter(fetchFn));
		const out = await action.run({ thread_id: "t-big", max_messages: 25 }, ctx);

		expect(out.messages).toHaveLength(25);
		expect(out.messages[0].id).toBe("m16");
		expect(out.messages[24].id).toBe("m40");
		expect(out.receipt.count).toBe(25);
		expect(out.receipt.total_count).toBe(40);
		expect(action.formatMcp!(out)).toContain("25 of 40");
	});

	it("4. every Gmail action output receipt contains account, touched ids, and counts, with no subject, body, from, to, or snippet", async () => {
		const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.href === "https://oauth2.googleapis.com/token") {
				return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
			}
			if (url.pathname.endsWith("/messages") && (init?.method ?? "GET") === "GET") {
				return new Response(JSON.stringify({ messages: [{ id: "m1" }] }), { status: 200 });
			}
			if (url.pathname.endsWith("/messages/m1")) {
				return new Response(
					JSON.stringify({
						id: "m1",
						threadId: "t1",
						labelIds: ["INBOX"],
						payload: {
							mimeType: "text/plain",
							headers: [
								{ name: "From", value: "alice@example.com" },
								{ name: "To", value: "owner@example.com" },
								{ name: "Subject", value: "Hello" },
								{ name: "Date", value: "Mon, 7 Sep 2026 09:00:00 +0000" },
							],
							body: { data: b64url("Secret body") },
						},
					}),
					{ status: 200 },
				);
			}
			if (url.pathname.endsWith("/labels")) {
				return new Response(
					JSON.stringify({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }] }),
					{ status: 200 },
				);
			}
			if (url.pathname.endsWith("/modify")) {
				return new Response(JSON.stringify({ id: "m1", labelIds: [] }), { status: 200 });
			}
			if (url.pathname.endsWith("/drafts") && init?.method === "POST") {
				return new Response(
					JSON.stringify({ id: "d1", message: { id: "dm1", threadId: "t1" } }),
					{ status: 200 },
				);
			}
			if (url.pathname.endsWith("/drafts/d1")) {
				return new Response(
					JSON.stringify({
						id: "d1",
						message: {
							id: "dm1",
							threadId: "t1",
							payload: {
								mimeType: "text/plain",
								headers: [
									{ name: "To", value: "bob@example.com" },
									{ name: "Subject", value: "Draft subj" },
								],
								body: { data: b64url("Draft body") },
							},
						},
					}),
					{ status: 200 },
				);
			}
			if (url.pathname.endsWith("/drafts/send")) {
				return new Response(JSON.stringify({ id: "sm1", threadId: "t1" }), { status: 200 });
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;

		const adapter = makeAdapter(fetchFn);
		const capture: CapturePort = {
			capture: vi.fn(async () => ({ id: "art-1", title: "Email sent", deduplicated: false })),
		};

		const searchOut = await createGmailSearchAction(adapter).run({ query: "is:unread" }, ctx);
		assertIdOnlyReceipt(searchOut.receipt, "personal");
		expect(searchOut.receipt.message_ids).toEqual(["m1"]);
		expect(searchOut.receipt.count).toBe(1);

		const readOut = await createGmailReadAction(adapter).run({ message_id: "m1" }, ctx);
		assertIdOnlyReceipt(readOut.receipt, "personal");
		expect(readOut.receipt.message_ids).toEqual(["m1"]);
		expect(readOut.receipt.count).toBe(1);

		const labelsOut = await createGmailLabelsAction(adapter).run({ action: "list" }, ctx);
		assertIdOnlyReceipt(labelsOut.receipt, "personal");
		expect(labelsOut.receipt.label_ids).toEqual(["INBOX"]);
		expect(labelsOut.receipt.count).toBe(1);

		const modifyOut = await createGmailModifyAction(adapter).run(
			{ message_id: "m1", mark_read: true },
			ctx,
		);
		assertIdOnlyReceipt(modifyOut.receipt, "personal");
		expect(modifyOut.receipt.ids).toEqual(["m1"]);
		expect(modifyOut.receipt.modified_count).toBe(1);

		const draftOut = await createGmailDraftAction(adapter).run(
			{ domain: "angus", to: ["bob@example.com"], subject: "Draft subj", body: "Draft body" },
			ctx,
		);
		assertIdOnlyReceipt(draftOut.receipt, "personal");
		expect(draftOut.receipt.draft_id).toBe("d1");
		expect(draftOut.receipt.message_id).toBe("dm1");
		expect(draftOut.receipt.recipient_count).toBe(1);

		const sendOut = await createGmailSendDraftAction({ gmail: adapter, capture }).run(
			{ domain: "angus", draft_id: "d1" },
			ctx,
		);
		assertIdOnlyReceipt(sendOut.receipt, "personal");
		expect(sendOut.receipt.draft_id).toBe("d1");
		expect(sendOut.receipt.message_id).toBe("sm1");
		expect(sendOut.receipt.sent_count).toBe(1);
	});

	it("5. retries 429 with Retry-After: 1 on gmail_search (read) and fails without retrying on gmail_send_draft (write)", async () => {
		let searchCalls = 0;
		const searchFetch = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(String(input));
			if (url.href === "https://oauth2.googleapis.com/token") {
				return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
			}
			searchCalls += 1;
			if (searchCalls === 1) {
				return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
					status: 429,
					headers: { "Retry-After": "1" },
				});
			}
			return new Response(JSON.stringify({ messages: [] }), { status: 200 });
		}) as unknown as typeof fetch;

		const searchOut = await createGmailSearchAction(makeAdapter(searchFetch)).run(
			{ query: "is:unread" },
			ctx,
		);
		expect(searchOut.messages).toEqual([]);
		expect(searchCalls).toBe(2);

		let sendPostCalls = 0;
		const sendFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.href === "https://oauth2.googleapis.com/token") {
				return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
			}
			if (url.pathname.endsWith("/drafts/d1")) {
				return new Response(
					JSON.stringify({
						id: "d1",
						message: {
							id: "dm1",
							threadId: "t1",
							payload: {
								mimeType: "text/plain",
								headers: [
									{ name: "To", value: "bob@example.com" },
									{ name: "Subject", value: "Subj" },
								],
								body: { data: b64url("Body") },
							},
						},
					}),
					{ status: 200 },
				);
			}
			if (url.pathname.endsWith("/drafts/send") && init?.method === "POST") {
				sendPostCalls += 1;
				return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
					status: 429,
					headers: { "Retry-After": "1" },
				});
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;

		const capture: CapturePort = { capture: vi.fn() };
		await expect(
			createGmailSendDraftAction({ gmail: makeAdapter(sendFetch), capture }).run(
				{ domain: "angus", draft_id: "d1" },
				ctx,
			),
		).rejects.toBeInstanceOf(GmailApiError);
		expect(sendPostCalls).toBe(1);
	});
});
