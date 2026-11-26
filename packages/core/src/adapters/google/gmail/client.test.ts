import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ensureLabel,
	formatMessage,
	getMessage,
	getMessageAttachment,
	getThread,
	listAttachmentParts,
	listMessageIds,
	messageHeader,
	modifyLabels,
	parseAddress,
	parseMessage,
	searchMessages,
	type GmailAuth,
	type GmailMessage,
} from "./client.js";

type FetchCall = { url: string; init: RequestInit & { body?: string } };

/** Install a fake fetch that records requests and replies from a queue of payloads. */
function stubFetchQueue(
	responses: { payload: unknown; ok?: boolean; status?: number }[],
): FetchCall[] {
	const calls: FetchCall[] = [];
	let i = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			calls.push({ url, init: init as FetchCall["init"] });
			const r = responses[Math.min(i, responses.length - 1)];
			i += 1;
			return {
				ok: r.ok ?? true,
				status: r.status ?? 200,
				statusText: r.ok === false ? "Error" : "OK",
				json: async () => r.payload,
				text: async () => JSON.stringify(r.payload),
			} as Response;
		}),
	);
	return calls;
}

/** Gmail bodies are base64url, so tests must encode the way Gmail does. */
function b64url(s: string): string {
	return Buffer.from(s, "utf-8")
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
}

function message(payload: GmailMessage["payload"], over: Partial<GmailMessage> = {}): GmailMessage {
	return { id: "m1", threadId: "t1", labelIds: ["INBOX", "UNREAD"], payload, ...over };
}

const auth = (label = "work", token = "fake_access_token"): GmailAuth => ({
	label,
	accessToken: async () => token,
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("parseMessage", () => {
	it("decodes a base64url plain-text body and lifts the headers", () => {
		const m = parseMessage(
			message({
				mimeType: "text/plain",
				headers: [
					{ name: "From", value: "notes@example.com" },
					{ name: "Subject", value: 'Notes: "Work Team Weekly"' },
					{ name: "Date", value: "Mon, 24 Aug 2026 09:00:00 +0000" },
				],
				body: { data: b64url("Summary is attached.\nSee the doc.") },
			}),
		);

		expect(m.subject).toBe('Notes: "Work Team Weekly"');
		expect(m.from).toBe("notes@example.com");
		expect(m.body).toBe("Summary is attached.\nSee the doc.");
	});

	it("matches headers case-insensitively, because senders vary the casing", () => {
		const m = parseMessage(
			message({ headers: [{ name: "SUBJECT", value: "shouty" }] }),
		);
		expect(m.subject).toBe("shouty");
	});

	it("prefers the text/plain part over the text/html twin in multipart/alternative", () => {
		const m = parseMessage(
			message({
				mimeType: "multipart/alternative",
				parts: [
					{ mimeType: "text/plain", body: { data: b64url("plain wins") } },
					{ mimeType: "text/html", body: { data: b64url("<p>html loses</p>") } },
				],
			}),
		);
		expect(m.body).toBe("plain wins");
	});

	it("keeps the href when falling back to HTML, because the doc URL lives there", () => {
		// The whole meeting-note pipeline turns on reaching this URL: Gemini's mail
		// renders it as an anchor labelled "Open in Docs", so dropping hrefs and keeping
		// only anchor text would throw away the one field that matters.
		const m = parseMessage(
			message({
				mimeType: "text/html",
				body: {
					data: b64url(
						'<div><a href="https://docs.google.com/document/d/ABC123/">Open in Docs</a></div>',
					),
				},
			}),
		);
		expect(m.body).toContain("https://docs.google.com/document/d/ABC123/");
	});

	it("treats a textual part with a filename as an attachment, not as body", () => {
		const m = parseMessage(
			message({
				mimeType: "multipart/mixed",
				parts: [
					{ mimeType: "text/plain", body: { data: b64url("real body") } },
					{
						mimeType: "text/csv",
						filename: "actions.csv",
						body: { size: 42, data: b64url("a,b,c") },
					},
				],
			}),
		);

		expect(m.body).toBe("real body");
		expect(m.attachments).toEqual([
			{ filename: "actions.csv", mimeType: "text/csv", size: 42 },
		]);
	});

	it("includes attachmentId on parsed attachments when present on part body", () => {
		const m = parseMessage(
			message({
				mimeType: "multipart/mixed",
				parts: [
					{ mimeType: "text/plain", body: { data: b64url("real body") } },
					{
						mimeType: "application/pdf",
						filename: "invoice.pdf",
						body: { size: 1024, attachmentId: "ANGjdJ8_test_id" },
					},
				],
			}),
		);

		expect(m.attachments).toEqual([
			{
				filename: "invoice.pdf",
				mimeType: "application/pdf",
				size: 1024,
				attachmentId: "ANGjdJ8_test_id",
			},
		]);
	});

	it("walks nested multiparts to find the body", () => {
		const m = parseMessage(
			message({
				mimeType: "multipart/mixed",
				parts: [
					{
						mimeType: "multipart/alternative",
						parts: [{ mimeType: "text/plain", body: { data: b64url("nested") } }],
					},
				],
			}),
		);
		expect(m.body).toBe("nested");
	});
});

describe("searchMessages", () => {
	it("URL-encodes the query and fetches each hit in full with Bearer auth", async () => {
		const calls = stubFetchQueue([
			{ payload: { messages: [{ id: "m1" }] } },
			{
				payload: message({
					mimeType: "text/plain",
					headers: [{ name: "Subject", value: "hit" }],
					body: { data: b64url("body") },
				}),
			},
		]);

		const out = await searchMessages(auth("work"), 'subject:"Notes:" newer_than:7d', 5);

		expect(calls[0].url).toContain("q=subject%3A%22Notes%3A%22%20newer_than%3A7d");
		expect(calls[0].url).toContain("maxResults=5");
		expect(calls[1].url).toContain("/messages/m1?format=full");
		expect(
			(calls[0].init.headers as Record<string, string>).Authorization,
		).toBe("Bearer fake_access_token");
		expect(out).toHaveLength(1);
		expect(out[0].subject).toBe("hit");
	});

	it("returns an empty list rather than throwing when nothing matches", async () => {
		stubFetchQueue([{ payload: {} }]);
		expect(await searchMessages(auth("personal"), "nope", 5)).toEqual([]);
	});

	it("names the account in the error, since a wrong-mailbox call 404s identically", async () => {
		stubFetchQueue([{ payload: { error: "not found" }, ok: false, status: 404 }]);

		await expect(searchMessages(auth("work"), "x", 1)).rejects.toThrow(
			/failed for account 'work' \(404\)/,
		);
	});
});

describe("getThread", () => {
	it("returns every message in the thread", async () => {
		stubFetchQueue([
			{
				payload: {
					messages: [
						message({ headers: [{ name: "Subject", value: "one" }] }, { id: "a" }),
						message({ headers: [{ name: "Subject", value: "two" }] }, { id: "b" }),
					],
				},
			},
		]);

		const out = await getThread(auth("work"), "t1");
		expect(out.map((m) => m.subject)).toEqual(["one", "two"]);
	});
});

describe("discovery reads (#1210)", () => {
	it("lists one page of bare ids with the query encoded and the cursor passed through", async () => {
		const calls = stubFetchQueue([
			{ payload: { messages: [{ id: "m2" }, { id: "m1" }], nextPageToken: "next/page" } },
		]);

		const page = await listMessageIds(auth("personal"), "has:attachment before:1700000000", {
			pageToken: "this/page",
			maxResults: 500,
		});

		expect(page).toEqual({ ids: ["m2", "m1"], nextPageToken: "next/page" });
		expect(calls).toHaveLength(1); // ids only: nothing is fetched per hit
		expect(calls[0].url).toContain("q=has%3Aattachment%20before%3A1700000000");
		expect(calls[0].url).toContain("maxResults=500");
		expect(calls[0].url).toContain("pageToken=this%2Fpage");
	});

	it("reports the last page with a null cursor and an empty page as no ids", async () => {
		stubFetchQueue([{ payload: {} }]);
		expect(await listMessageIds(auth("personal"), "x")).toEqual({ ids: [], nextPageToken: null });
	});

	it("uses a passed access token instead of minting one per request", async () => {
		const handle = { label: "personal", accessToken: vi.fn(async () => "fake_access_token") };
		const calls = stubFetchQueue([{ payload: message({ mimeType: "text/plain" }) }]);

		await getMessage(handle, "m1", { accessToken: "sweep-token" });

		expect(handle.accessToken).not.toHaveBeenCalled();
		expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sweep-token");
	});

	it("puts the HTTP status on a failed call's error, with the message unchanged", async () => {
		stubFetchQueue([{ payload: { error: "gone" }, ok: false, status: 404 }]);

		const err = await getMessage(auth("work"), "m1").catch((e: unknown) => e);

		expect(err).toBeInstanceOf(Error);
		expect((err as { status?: number }).status).toBe(404);
		expect((err as Error).message).toMatch(/failed for account 'work' \(404\)/);
	});

	it("lists every file-bearing part with its part id, attachment handle, disposition and Content-ID", () => {
		const parts = listAttachmentParts(
			message({
				partId: "",
				mimeType: "multipart/mixed",
				parts: [
					{
						partId: "0",
						mimeType: "multipart/alternative",
						parts: [{ partId: "0.0", mimeType: "text/plain", body: { data: b64url("body") } }],
					},
					{
						partId: "1",
						mimeType: "application/pdf",
						filename: "cv.pdf",
						headers: [{ name: "Content-Disposition", value: 'attachment; filename="cv.pdf"' }],
						body: { size: 81234, attachmentId: "handle-1" },
					},
					{
						partId: "2",
						mimeType: "image/png",
						filename: "logo.png",
						headers: [
							{ name: "content-disposition", value: "INLINE" },
							{ name: "Content-ID", value: "<logo@example>" },
						],
						body: { size: 900, attachmentId: "handle-2" },
					},
					// A part that declares no disposition at all.
					{ partId: "3", mimeType: "text/csv", filename: "data.csv", body: { size: 12 } },
				],
			}),
		);

		expect(parts).toEqual([
			{
				partId: "1",
				filename: "cv.pdf",
				mimeType: "application/pdf",
				size: 81234,
				attachmentId: "handle-1",
				disposition: "attachment",
				hasContentId: false,
			},
			{
				partId: "2",
				filename: "logo.png",
				mimeType: "image/png",
				size: 900,
				attachmentId: "handle-2",
				disposition: "inline",
				hasContentId: true,
			},
			{
				partId: "3",
				filename: "data.csv",
				mimeType: "text/csv",
				size: 12,
				attachmentId: null,
				disposition: null,
				hasContentId: false,
			},
		]);
	});

	it("reads one top-level header without decoding the body", () => {
		const msg = message({
			mimeType: "text/plain",
			headers: [{ name: "Subject", value: "Hello" }],
			body: { data: b64url("body") },
		});
		expect(messageHeader(msg, "subject")).toBe("Hello");
		expect(messageHeader(msg, "X-Absent")).toBe("");
	});
});

describe("parseAddress", () => {
	it.each([
		["Angus Hally <owner@example.com>", { name: "Angus Hally", address: "owner@example.com" }],
		['"Hally, Angus" <owner@example.com>', { name: "Hally, Angus", address: "owner@example.com" }],
		['"Say \\"Hi\\"" <hi@example.com>', { name: 'Say "Hi"', address: "hi@example.com" }],
		["<owner@example.com>", { name: null, address: "owner@example.com" }],
		["  owner@example.com  ", { name: null, address: "owner@example.com" }],
		["owner@example.com (Angus Hally)", { name: "Angus Hally", address: "owner@example.com" }],
		["Angus Hally", { name: "Angus Hally", address: null }],
		["undisclosed-recipients:;", { name: "undisclosed-recipients:;", address: null }],
		["Nobody <>", { name: "Nobody", address: null }],
		["", { name: null, address: null }],
	])("splits %j", (value, expected) => {
		expect(parseAddress(value)).toEqual(expected);
	});

	it("keeps the address as written rather than case-folding it", () => {
		expect(parseAddress("Angus <Owner.User@Example.com>").address).toBe("Owner.User@Example.com");
	});
});

describe("ensureLabel", () => {
	it("returns the existing label without creating, matching case-insensitively", async () => {
		// Gmail rejects a name that differs only by case, so a case-sensitive lookup
		// would find nothing and then fail on create — the label setup step is expected
		// to be re-run, so it has to be idempotent in practice, not just in intent.
		const calls = stubFetchQueue([
			{ payload: { labels: [{ id: "Label_9", name: "Meeting_Note" }] } },
		]);

		const { label, created } = await ensureLabel(auth("work"), "meeting_note");

		expect(created).toBe(false);
		expect(label.id).toBe("Label_9");
		expect(calls).toHaveLength(1); // no POST
	});

	it("creates the label when it is genuinely absent", async () => {
		const calls = stubFetchQueue([
			{ payload: { labels: [{ id: "INBOX", name: "INBOX" }] } },
			{ payload: { id: "Label_10", name: "meeting_note" } },
		]);

		const { label, created } = await ensureLabel(auth("work"), "meeting_note");

		expect(created).toBe(true);
		expect(label.id).toBe("Label_10");
		expect(calls[1].init.method).toBe("POST");
		expect(JSON.parse(calls[1].init.body as string).name).toBe("meeting_note");
	});
});

describe("modifyLabels", () => {
	it("POSTs add/remove lists to the message modify endpoint", async () => {
		const calls = stubFetchQueue([{ payload: { id: "m1", labelIds: ["Label_9"] } }]);

		const res = await modifyLabels(
			auth("work"),
			{ kind: "message", id: "m1" },
			{ addLabelIds: ["Label_9"], removeLabelIds: ["UNREAD", "INBOX"] },
		);

		expect(calls[0].url).toContain("/messages/m1/modify");
		expect(JSON.parse(calls[0].init.body as string)).toEqual({
			addLabelIds: ["Label_9"],
			removeLabelIds: ["UNREAD", "INBOX"],
		});
		expect(res.labelIds).toEqual(["Label_9"]);
	});

	it("reads labels off the first message for a thread, which has no top-level labelIds", async () => {
		stubFetchQueue([
			{ payload: { id: "t1", messages: [{ id: "m1", threadId: "t1", labelIds: ["X"] }] } },
		]);

		const res = await modifyLabels(
			auth("work"),
			{ kind: "thread", id: "t1" },
			{ addLabelIds: ["X"] },
		);

		expect(res.labelIds).toEqual(["X"]);
	});
});

describe("formatMessage", () => {
	it("surfaces read and archived state, which is what the modify tools change", () => {
		const line = formatMessage(
			parseMessage(
				message({ headers: [{ name: "Subject", value: "s" }] }, { labelIds: [] }),
			),
		);
		expect(line).toContain("read, archived");
	});

	it("includes both message id and threadId so reply message ids are never mistaken for thread ids", () => {
		const line = formatMessage(
			parseMessage(
				message(
					{
						headers: [
							{ name: "Subject", value: "Re: Proposal" },
							{ name: "From", value: "mitesh@example.com" },
							{ name: "Date", value: "Mon, 26 Oct 2026" },
						],
					},
					{ id: "msg-reply-2", threadId: "thread-root-1", labelIds: ["INBOX"] },
				),
			),
		);
		expect(line).toBe(
			"• [msg-reply-2 | thread: thread-root-1] Re: Proposal — mitesh@example.com (Mon, 26 Oct 2026, read, inbox)",
		);
	});
});

describe("getMessageAttachment", () => {
	it("fetches attachment bytes by attachmentId and decodes base64url into a Buffer", async () => {
		const rawBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0xfe]);
		const b64urlBytes = rawBytes
			.toString("base64")
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");

		const calls = stubFetchQueue([
			{
				payload: message(
					{
						mimeType: "multipart/mixed",
						parts: [
							{
								mimeType: "application/pdf",
								filename: "statement.pdf",
								body: { size: rawBytes.length, attachmentId: "att-123" },
							},
						],
					},
					{ id: "msg-1" },
				),
			},
			{
				payload: {
					size: rawBytes.length,
					data: b64urlBytes,
				},
			},
		]);

		const res = await getMessageAttachment(auth("work"), "msg-1", {
			attachmentId: "att-123",
		});

		expect(calls).toHaveLength(2);
		expect(calls[0].url).toContain("/messages/msg-1?format=full");
		expect(calls[1].url).toContain("/messages/msg-1/attachments/att-123");
		expect(res.attachmentId).toBe("att-123");
		expect(res.filename).toBe("statement.pdf");
		expect(res.mimeType).toBe("application/pdf");
		expect(res.size).toBe(rawBytes.length);
		expect(Buffer.isBuffer(res.data)).toBe(true);
		expect(res.data.equals(rawBytes)).toBe(true);
	});

	it("resolves attachment by exact filename and fetches bytes via its part attachmentId", async () => {
		const rawBytes = Buffer.from("hello pdf attachment", "utf-8");
		const calls = stubFetchQueue([
			{
				payload: message(
					{
						mimeType: "multipart/mixed",
						parts: [
							{
								mimeType: "application/pdf",
								filename: "receipt.pdf",
								body: { size: rawBytes.length, attachmentId: "att-by-name" },
							},
						],
					},
					{ id: "msg-2" },
				),
			},
			{
				payload: {
					size: rawBytes.length,
					data: rawBytes.toString("base64url"),
				},
			},
		]);

		const res = await getMessageAttachment(auth("work"), "msg-2", {
			filename: "receipt.pdf",
		});

		expect(calls).toHaveLength(2);
		expect(calls[1].url).toContain("/messages/msg-2/attachments/att-by-name");
		expect(res.attachmentId).toBe("att-by-name");
		expect(res.filename).toBe("receipt.pdf");
		expect(res.data.toString("utf-8")).toBe("hello pdf attachment");
	});

	it("decodes inline body.data directly when attachment part has inline data without attachmentId", async () => {
		const calls = stubFetchQueue([
			{
				payload: message(
					{
						mimeType: "multipart/mixed",
						parts: [
							{
								mimeType: "text/csv",
								filename: "inline.csv",
								body: { size: 5, data: b64url("a,b,c") },
							},
						],
					},
					{ id: "msg-inline" },
				),
			},
		]);

		const res = await getMessageAttachment(auth("work"), "msg-inline", {
			filename: "inline.csv",
		});

		expect(calls).toHaveLength(1);
		expect(res.attachmentId).toBeNull();
		expect(res.filename).toBe("inline.csv");
		expect(res.mimeType).toBe("text/csv");
		expect(res.data.toString("utf-8")).toBe("a,b,c");
	});

	it("throws when no matching attachment exists on the message", async () => {
		stubFetchQueue([
			{
				payload: message(
					{
						mimeType: "text/plain",
						body: { data: b64url("no attachments") },
					},
					{ id: "msg-empty" },
				),
			},
		]);

		await expect(
			getMessageAttachment(auth("work"), "msg-empty", {
				filename: "missing.pdf",
			}),
		).rejects.toThrow(/Attachment not found on message msg-empty/);
	});
});
