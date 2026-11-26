import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same posture as gmail.test.ts: stub the token mint but keep the real credential
// resolution inside it, so the account-boundary assertions stay honest.
vi.mock("../google/oauth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../google/oauth.js")>();
	const { getCredential } = await import("../credentials.js");
	const { GOOGLE_ACCOUNT_PROVIDER, DEFAULT_GOOGLE_ACCOUNT } = await import(
		"../google/accounts.js"
	);
	return {
		...actual,
		getGoogleAccessToken: vi.fn(
			async (account: "personal" | "work" = DEFAULT_GOOGLE_ACCOUNT) => {
				await getCredential(GOOGLE_ACCOUNT_PROVIDER[account]);
				return "fake_access_token";
			},
		),
	};
});

type CaptureArgs = { text: string; content_subtype: string; tags?: string[] };
const captureSpy = vi.hoisted(() =>
	vi.fn(async (_args: { text: string; content_subtype: string; tags?: string[] }) => ({
		id: "artifact-123",
	})),
);
import { z } from "zod";
import { createGmailModifyAction, createGmailSendDraftAction, gmailModifyInput } from "@ahkms/core";
import { buildRawMessage, getReplyContext } from "../google/gmail.js";
import { buildGmailPort } from "../google/gmailPort.js";

const gmailSendDraftHandler = async (args: Record<string, unknown>) => {
	const action = createGmailSendDraftAction({
		gmail: buildGmailPort({ clientId: "cid", clientSecret: "csec" }),
		capture: {
			id: "capture",
			schema: { parse: (x: any) => x },
			run: async (input: any) => captureSpy(input),
		} as any,
	});
	const out = await action.run(args as any, { caller: "test", requestId: "r1" });
	return { content: [{ type: "text" as const, text: action.formatMcp!(out) }] };
};

const gmailModifyHandler = async (args: Record<string, unknown>) => {
	const action = createGmailModifyAction(buildGmailPort({ clientId: "cid", clientSecret: "csec" }));
	const out = await action.run(args as any, { caller: "test", requestId: "r1" });
	return { content: [{ type: "text" as const, text: action.formatMcp!(out) }] };
};

type FetchCall = { url: string; init: RequestInit & { body?: string } };

function stubFetchQueue(responses: unknown[]): FetchCall[] {
	const calls: FetchCall[] = [];
	let i = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			if (url === "https://oauth2.googleapis.com/token") {
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => ({ access_token: "fake_access_token" }),
					text: async () => JSON.stringify({ access_token: "fake_access_token" }),
				} as Response;
			}
			calls.push({ url, init: init as FetchCall["init"] });
			const entry = responses[Math.min(i, responses.length - 1)];
			i += 1;
			if (
				entry &&
				typeof entry === "object" &&
				"__status" in entry &&
				typeof (entry as { __status: unknown }).__status === "number"
			) {
				const override = entry as { __status: number; ok?: boolean; payload?: unknown };
				const ok = override.ok ?? (override.__status >= 200 && override.__status < 300);
				return {
					ok,
					status: override.__status,
					statusText: ok ? "OK" : "Error",
					json: async () => override.payload,
					text: async () => JSON.stringify(override.payload ?? {}),
				} as Response;
			}
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => entry,
				text: async () => JSON.stringify(entry),
			} as Response;
		}),
	);
	return calls;
}

function b64url(s: string): string {
	return Buffer.from(s, "utf-8").toString("base64url");
}

/** Undo buildRawMessage, so assertions read the actual RFC 2822 text. */
function decodeRaw(raw: string): string {
	return Buffer.from(raw, "base64url").toString("utf-8");
}

/** A minimal message with the headers the reply path reads. */
function messageWithHeaders(headers: Record<string, string>, threadId = "t1") {
	return {
		id: "m1",
		threadId,
		labelIds: ["INBOX"],
		payload: {
			mimeType: "text/plain",
			headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
			body: { data: b64url("original body") },
		},
	};
}

/** A drafts.get response wrapping a stored draft. */
function draftResponse(subject: string, to: string, body: string) {
	return {
		id: "d1",
		message: {
			id: "m9",
			threadId: "t1",
			labelIds: ["DRAFT"],
			payload: {
				mimeType: "text/plain",
				headers: [
					{ name: "To", value: to },
					{ name: "Subject", value: subject },
				],
				body: { data: b64url(body) },
			},
		},
	};
}

const origRefresh = process.env.GOOGLE_REFRESH_TOKEN;
const origPersonal = process.env.GOOGLE_REFRESH_TOKEN_PERSONAL;
const origWork = process.env.GOOGLE_REFRESH_TOKEN_WORK;

beforeEach(() => {
	captureSpy.mockClear();
	process.env.GOOGLE_REFRESH_TOKEN_PERSONAL = "fake_refresh_token";
	process.env.GOOGLE_REFRESH_TOKEN_WORK = "fake_work_refresh_token";
});

afterEach(() => {
	vi.unstubAllGlobals();
	for (const [k, v] of [
		["GOOGLE_REFRESH_TOKEN", origRefresh],
		["GOOGLE_REFRESH_TOKEN_PERSONAL", origPersonal],
		["GOOGLE_REFRESH_TOKEN_WORK", origWork],
	] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("buildRawMessage", () => {
	it("refuses a line break in a recipient, which would inject a header", () => {
		// The concrete attack: a newline ends the To header and starts a Bcc the caller
		// never saw. The tool layer builds these values from model output.
		expect(() =>
			buildRawMessage({
				to: ["a@example.com\r\nBcc: everyone@example.com"],
				subject: "hi",
				body: "x",
			}),
		).toThrow(/inject a header/);
	});

	it("refuses a line break in the subject", () => {
		expect(() =>
			buildRawMessage({ to: ["a@example.com"], subject: "hi\nBcc: x@y.z", body: "x" }),
		).toThrow(/inject a header/);
	});

	it("refuses a non-ASCII address rather than mis-encoding it", () => {
		expect(() =>
			buildRawMessage({ to: ["späm@example.com"], subject: "hi", body: "x" }),
		).toThrow(/non-ASCII/);
	});

	it("refuses to build a message with no recipient", () => {
		expect(() => buildRawMessage({ to: [], subject: "hi", body: "x" })).toThrow(
			/no recipient/,
		);
	});

	it("encodes a non-ASCII subject as an RFC 2047 encoded word", () => {
		const raw = decodeRaw(
			buildRawMessage({ to: ["a@example.com"], subject: "Café ☕", body: "x" }),
		);
		expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from("Café ☕", "utf8").toString("base64")}?=`);
	});

	it("sets no From header, so a draft cannot claim to be from someone else", () => {
		// Gmail fills From from the authenticated account. Accepting a From here would
		// make the required `account` argument decorative.
		const raw = decodeRaw(
			buildRawMessage({ to: ["a@example.com"], subject: "hi", body: "x" }),
		);
		expect(raw).not.toMatch(/^From:/m);
	});

	it("sends the body as base64 UTF-8 rather than raw 8-bit", () => {
		const raw = decodeRaw(
			buildRawMessage({ to: ["a@example.com"], subject: "hi", body: "héllo" }),
		);
		expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
		expect(raw).toContain("Content-Transfer-Encoding: base64");
		expect(raw).toContain(Buffer.from("héllo", "utf8").toString("base64"));
	});

	it("carries In-Reply-To and References when replying", () => {
		const raw = decodeRaw(
			buildRawMessage({
				to: ["a@example.com"],
				subject: "Re: hi",
				body: "x",
				inReplyTo: "<orig@mail>",
				references: "<older@mail> <orig@mail>",
			}),
		);
		expect(raw).toContain("In-Reply-To: <orig@mail>");
		expect(raw).toContain("References: <older@mail> <orig@mail>");
	});
});

describe("getReplyContext", () => {
	it("builds the References chain as prior references then the original Message-ID", async () => {
		stubFetchQueue([
			messageWithHeaders({
				"Message-ID": "<orig@mail>",
				References: "<older@mail>",
				Subject: "Budget",
				From: "her@example.com",
			}),
		]);

		const ctx = await getReplyContext("personal", "m1");

		expect(ctx.references).toBe("<older@mail> <orig@mail>");
		expect(ctx.replySubject).toBe("Re: Budget");
		expect(ctx.from).toBe("her@example.com");
	});

	it("does not double-prefix a subject that is already a reply", async () => {
		stubFetchQueue([
			messageWithHeaders({ "Message-ID": "<o@m>", Subject: "Re: Budget", From: "a@b.c" }),
		]);

		expect((await getReplyContext("personal", "m1")).replySubject).toBe("Re: Budget");
	});
});

describe("gmail_send_draft", () => {
	it("sends the draft and captures what actually went out", async () => {
		stubFetchQueue([
			draftResponse("Budget", "her@example.com", "sure"),
			{ id: "m10", threadId: "t1" },
		]);

		const res = await gmailSendDraftHandler({ account: "work", draft_id: "d1" });

		expect(captureSpy).toHaveBeenCalledOnce();
		const captured: CaptureArgs = captureSpy.mock.calls[0][0];
		expect(captured.content_subtype).toBe("email_sent");
		// The draft is read BEFORE sending, so the artifact records the mailbox's copy
		// rather than whatever an earlier compose call intended.
		expect(captured.text).toContain("her@example.com");
		expect(captured.text).toContain("sure");
		expect(res.content[0].text).toContain("m10");
		expect(res.content[0].text).toContain("cannot be undone");
	});

	it("still reports the send when the capture fails", async () => {
		// The mail has gone. Failing the call because the knowledge store was
		// unreachable would tell the caller the send failed when it did not.
		captureSpy.mockRejectedValueOnce(new Error("supabase down"));
		stubFetchQueue([
			draftResponse("Budget", "her@example.com", "sure"),
			{ id: "m10", threadId: "t1" },
		]);

		const res = await gmailSendDraftHandler({ account: "personal", draft_id: "d1" });

		expect(res.content[0].text).toContain("Sent draft d1");
		expect(res.content[0].text).toMatch(/capture failed/);
	});

	it("tags robot-authored emails with robot_authored tag (#1222)", async () => {
		stubFetchQueue([
			draftResponse("[auto-task] Draft PR #1389", "dev@example.com", "Scheduled routine completed"),
			{ id: "m11", threadId: "t2" },
		]);

		await gmailSendDraftHandler({ account: "work", draft_id: "d2" });

		expect(captureSpy).toHaveBeenCalledOnce();
		const captured: CaptureArgs = captureSpy.mock.calls[0][0];
		expect(captured.tags).toContain("robot_authored");
	});
});

describe("gmail_modify", () => {
	it("preserves single-target output and error behaviour when message_id or thread_id is supplied", async () => {
		const calls = stubFetchQueue([
			{ id: "m1", labelIds: ["Label_1"] },
		]);

		const res = await gmailModifyHandler({
			account: "work",
			message_id: "m1",
			add_labels: ["Label_1"],
			archive: true,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toContain("/messages/m1/modify");
		expect(res.content[0].text).toContain("Modified message m1 in the 'work' mailbox.");
		expect(res.content[0].text).toContain("Added: Label_1");
		expect(res.content[0].text).toContain("Removed: INBOX");
		expect(res.content[0].text).toContain("Labels now: Label_1");
	});

	it("modifies each unique thread in thread_ids and returns a batch summary", async () => {
		const calls = stubFetchQueue([
			{ id: "t1", messages: [{ id: "m1", threadId: "t1", labelIds: ["Label_1"] }] },
			{ id: "t2", messages: [{ id: "m2", threadId: "t2", labelIds: ["Label_1"] }] },
			{ id: "t3", messages: [{ id: "m3", threadId: "t3", labelIds: ["Label_1"] }] },
		]);

		const res = await gmailModifyHandler({
			thread_ids: ["t1", "t2", "t3"],
			add_labels: ["Label_1"],
			archive: true,
			account: "work",
		});

		expect(calls).toHaveLength(3);
		expect(calls.map((c) => c.url)).toEqual([
			expect.stringContaining("/threads/t1/modify"),
			expect.stringContaining("/threads/t2/modify"),
			expect.stringContaining("/threads/t3/modify"),
		]);
		expect(res.content[0].text).toContain("Modified 3/3 thread(s) in the 'work' mailbox: t1, t2, t3");
		expect(res.content[0].text).toContain("Added: Label_1");
		expect(res.content[0].text).toContain("Removed: INBOX");
	});

	it("deduplicates batch message_ids before calling modifyLabels", async () => {
		const calls = stubFetchQueue([
			{ id: "m1", labelIds: ["Label_1"] },
			{ id: "m2", labelIds: ["Label_1"] },
		]);

		const res = await gmailModifyHandler({
			message_ids: ["m1", "m2", "m1"],
			add_labels: ["Label_1"],
			mark_read: true,
			account: "personal",
		});

		expect(calls).toHaveLength(2);
		expect(res.content[0].text).toContain("Modified 2/2 message(s) in the 'personal' mailbox: m1, m2");
	});

	it("completes remaining targets and reports both modified IDs and failed IDs when one target in a batch 404s", async () => {
		const calls = stubFetchQueue([
			{ id: "t1", messages: [{ id: "m1", threadId: "t1", labelIds: ["Label_1"] }] },
			{ __status: 404, ok: false, payload: { error: { message: "Requested entity was not found." } } },
			{ id: "t3", messages: [{ id: "m3", threadId: "t3", labelIds: ["Label_1"] }] },
		]);

		const res = await gmailModifyHandler({
			thread_ids: ["t1", "t2-missing", "t3"],
			add_labels: ["Label_1"],
			archive: true,
			account: "work",
		});

		expect(calls).toHaveLength(3);
		expect(res.content[0].text).toContain("Modified 2/3 thread(s) in the 'work' mailbox: t1, t3");
		expect(res.content[0].text).toContain("Failed (1): t2-missing");
		expect(res.content[0].text).toContain("404");
	});

	it("rejects calls with no targets or with mixed message and thread targets", async () => {
		await expect(
			gmailModifyHandler({ account: "work", archive: true }),
		).rejects.toThrow(/at least one target/i);

		await expect(
			gmailModifyHandler({
				account: "work",
				message_id: "m1",
				thread_id: "t1",
				archive: true,
			}),
		).rejects.toThrow(/mix message targets/i);

		await expect(
			gmailModifyHandler({
				account: "work",
				message_ids: ["m1"],
				thread_ids: ["t1"],
				archive: true,
			}),
		).rejects.toThrow(/mix message targets/i);

		const schema = z.object(gmailModifyInput);
		expect(schema.safeParse({ message_ids: [] }).success).toBe(false);
		expect(
			schema.safeParse({
				thread_ids: Array.from({ length: 51 }, (_, i) => `t${i}`),
			}).success,
		).toBe(false);
	});
});
