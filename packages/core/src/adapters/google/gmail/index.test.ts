import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DRAFT_FIELDS, DRAFT_METADATA_FIELDS, formatMessage, GmailApiError, LIST_LABELS_FIELDS, LIST_MESSAGES_FIELDS, MESSAGE_FIELDS, parseMessage, PROFILE_FIELDS, THREAD_FIELDS } from "../../../ports/gmail.js";
import { createGoogleGmailAdapter } from "./index.js";

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64url");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function createStubFetch(apiResponder: (url: string, init?: RequestInit) => Response) {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url === "https://oauth2.googleapis.com/token") return json({ access_token: `access-${new URLSearchParams(String(init?.body ?? "")).get("refresh_token")}` });
		return apiResponder(url, init);
	});
}

const makeAdapter = (fetchFn: typeof fetch, tokens: Partial<Record<"angus" | "work", string>> = { angus: "rt-angus", work: "rt-work" }) =>
	createGoogleGmailAdapter({ clientId: "cid", clientSecret: "csec", refreshToken: async (d) => tokens[d] ?? null, fetchFn });

describe("createGoogleGmailAdapter", () => {
	it("searchMessages exchanges angus token, passes list and message fields masks, and returns ParsedMessage[]", async () => {
		const calls: { url: string; auth?: string }[] = [];
		const fetchFn = createStubFetch((url, init) => {
			calls.push({ url, auth: (init?.headers as Record<string, string>)?.Authorization });
			if (url.includes("/messages?q=")) return json({ messages: [{ id: "m1" }] });
			return json({ id: "m1", threadId: "t1", labelIds: ["INBOX", "UNREAD"], snippet: "Hello", payload: { headers: [{ name: "From", value: "alice@example.com" }, { name: "Subject", value: "Test" }], mimeType: "text/plain", body: { data: b64("Hello world") } } });
		});
		const res = await makeAdapter(fetchFn).searchMessages({ domain: "angus", query: "is:unread", maxResults: 5 });
		expect(calls).toEqual([
			{ url: `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is%3Aunread&maxResults=5&fields=${LIST_MESSAGES_FIELDS}`, auth: "Bearer access-rt-angus" },
			{ url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/m1?format=full&fields=${MESSAGE_FIELDS}`, auth: "Bearer access-rt-angus" },
		]);
		expect(res[0]).toMatchObject({ id: "m1", threadId: "t1", from: "alice@example.com", subject: "Test", body: "Hello world" });
		expect(formatMessage(parseMessage({ id: "m1", threadId: "t1", labelIds: ["UNREAD", "INBOX"], payload: { headers: [{ name: "Subject", value: "Hi" }], mimeType: "text/plain", body: { data: b64("Hi") } } }))).toBe("• [m1 | thread: t1] Hi —  (, unread, inbox)");
	});

	it("getThread uses the work token, passes THREAD_FIELDS, and returns ParsedMessage[] in thread order", async () => {
		let seen = { url: "", auth: "" };
		const fetchFn = createStubFetch((url, init) => {
			seen = { url, auth: (init?.headers as Record<string, string>)?.Authorization ?? "" };
			return json({ messages: [
				{ id: "m1", threadId: "t1", payload: { headers: [{ name: "Subject", value: "First" }], mimeType: "text/plain", body: { data: b64("One") } } },
				{ id: "m2", threadId: "t1", payload: { headers: [{ name: "Subject", value: "Re: First" }], mimeType: "text/plain", body: { data: b64("Two") } } },
			] });
		});
		const res = await makeAdapter(fetchFn).getThread({ domain: "work", threadId: "t1" });
		expect(seen).toEqual({ url: `https://gmail.googleapis.com/gmail/v1/users/me/threads/t1?format=full&fields=${THREAD_FIELDS}`, auth: "Bearer access-rt-work" });
		expect(res.map((m) => [m.id, m.body])).toEqual([["m1", "One"], ["m2", "Two"]]);
	});

	it("getProfile calls /profile with fields=emailAddress,messagesTotal and returns { emailAddress, messagesTotal }", async () => {
		let seenUrl = "";
		const fetchFn = createStubFetch((url) => ((seenUrl = url), json({ emailAddress: "owner@example.com", messagesTotal: 42 })));
		expect(await makeAdapter(fetchFn).getProfile({ domain: "angus" })).toEqual({ emailAddress: "owner@example.com", messagesTotal: 42 });
		expect(seenUrl).toBe(`https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=${PROFILE_FIELDS}`);
	});

	it("getReplyContext, createDraft, updateDraft, getDraft, and listLabels pass fields masks and body payloads", async () => {
		const calls: { url: string; method: string; body?: unknown }[] = [];
		const fetchFn = createStubFetch((url, init) => {
			const method = init?.method ?? "GET";
			calls.push({ url, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
			if (url.includes("/messages/m1")) {
				return json({ id: "m1", threadId: "t1", payload: { headers: [{ name: "Message-ID", value: "<orig@mail>" }, { name: "References", value: "<prev@mail>" }, { name: "Subject", value: "Budget" }, { name: "From", value: "her@example.com" }] } });
			}
			if (url.endsWith("/drafts") && method === "POST") return json({ id: "d1", message: { id: "m9", threadId: "t1" } });
			if (url.endsWith("/drafts/d1") && method === "PUT") return json({ id: "d1", message: { id: "m10", threadId: "t1" } });
			if (url.includes("/drafts/d1?format=full")) {
				return json({ id: "d1", message: { id: "m9", threadId: "t1", payload: { mimeType: "text/plain", headers: [{ name: "To", value: "her@example.com" }, { name: "Subject", value: "Re: Budget" }], body: { data: b64("sure") } } } });
			}
			return json({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }] });
		});
		const adapter = makeAdapter(fetchFn);
		expect(await adapter.getReplyContext({ domain: "work", messageId: "m1" })).toEqual({
			threadId: "t1", messageIdHeader: "<orig@mail>", references: "<prev@mail> <orig@mail>", replySubject: "Re: Budget", from: "her@example.com",
		});
		expect(await adapter.createDraft({ domain: "work", raw: "cmF3", threadId: "t1" })).toEqual({ draftId: "d1", messageId: "m9", threadId: "t1" });
		expect(await adapter.updateDraft({ domain: "work", draftId: "d1", raw: "cmF3Mg", threadId: "t1" })).toEqual({ draftId: "d1", messageId: "m10", threadId: "t1" });
		expect(await adapter.getDraft({ domain: "work", draftId: "d1" })).toMatchObject({ id: "m9", threadId: "t1", to: "her@example.com", subject: "Re: Budget", body: "sure" });
		expect(await adapter.listLabels({ domain: "angus" })).toEqual([{ id: "INBOX", name: "INBOX", type: "system" }]);
		expect(calls).toEqual([
			{ url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/m1?format=full&fields=${MESSAGE_FIELDS}`, method: "GET" },
			{ url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts", method: "POST", body: { message: { raw: "cmF3", threadId: "t1" } } },
			{ url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts/d1", method: "PUT", body: { id: "d1", message: { raw: "cmF3Mg", threadId: "t1" } } },
			{ url: `https://gmail.googleapis.com/gmail/v1/users/me/drafts/d1?format=full&fields=${DRAFT_FIELDS}`, method: "GET" },
			{ url: `https://gmail.googleapis.com/gmail/v1/users/me/labels?fields=${LIST_LABELS_FIELDS}`, method: "GET" },
		]);
	});

	it("listLabels passes LIST_LABELS_FIELDS and ensureLabel matches case-insensitively before creating", async () => {
		const calls: { url: string; method: string; body?: unknown }[] = [];
		const fetchFn = createStubFetch((url, init) => {
			const method = init?.method ?? "GET";
			calls.push({ url, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
			if (method === "POST") {
				return json({ id: "Label_10", name: "new_label", type: "user" });
			}
			return json({
				labels: [
					{ id: "INBOX", name: "INBOX", type: "system" },
					{ id: "Label_9", name: "Meeting_Note", type: "user" },
				],
			});
		});
		const adapter = makeAdapter(fetchFn);
		const listed = await adapter.listLabels({ domain: "angus" });
		expect(listed).toEqual([
			{ id: "INBOX", name: "INBOX", type: "system" },
			{ id: "Label_9", name: "Meeting_Note", type: "user" },
		]);
		expect(calls[0]).toEqual({
			url: `https://gmail.googleapis.com/gmail/v1/users/me/labels?fields=${LIST_LABELS_FIELDS}`,
			method: "GET",
		});

		const existing = await adapter.ensureLabel({ domain: "work", name: "meeting_note" });
		expect(existing).toEqual({
			label: { id: "Label_9", name: "Meeting_Note", type: "user" },
			created: false,
		});
		expect(calls).toHaveLength(2);

		const created = await adapter.ensureLabel({ domain: "work", name: "new_label" });
		expect(created).toEqual({
			label: { id: "Label_10", name: "new_label", type: "user" },
			created: true,
		});
		expect(calls[3]).toEqual({
			url: "https://gmail.googleapis.com/gmail/v1/users/me/labels",
			method: "POST",
			body: {
				name: "new_label",
				labelListVisibility: "labelShow",
				messageListVisibility: "show",
			},
		});
	});

	it("replaces the default mask on getMessage when caller supplies fields override", async () => {
		let seenUrl = "";
		const fetchFn = createStubFetch((url) => ((seenUrl = url), json({ id: "m9", threadId: "t9" })));
		expect(await makeAdapter(fetchFn).getMessage({ domain: "angus", messageId: "m9", fields: "id,threadId" })).toEqual({ id: "m9", threadId: "t9" });
		expect(seenUrl).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/m9?format=full&fields=id,threadId");
	});

	it("modifyLabels posts addLabelIds and removeLabelIds to message and thread modify endpoints", async () => {
		const calls: { url: string; method: string; body?: unknown }[] = [];
		const fetchFn = createStubFetch((url, init) => {
			calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
			if (url.endsWith("/threads/t1/modify")) return json({ id: "t1", messages: [{ id: "m1", threadId: "t1", labelIds: ["Label_2"] }] });
			return json({ id: "m1", labelIds: ["Label_1"] });
		});
		const adapter = makeAdapter(fetchFn);
		expect(await adapter.modifyLabels({ domain: "angus", target: { kind: "message", id: "m1" }, addLabelIds: ["Label_1"], removeLabelIds: ["UNREAD"] })).toEqual({ id: "m1", labelIds: ["Label_1"] });
		expect(await adapter.modifyLabels({ domain: "work", target: { kind: "thread", id: "t1" }, removeLabelIds: ["INBOX"] })).toEqual({ id: "t1", labelIds: ["Label_2"] });
		expect(calls).toEqual([
			{ url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/modify", method: "POST", body: { addLabelIds: ["Label_1"], removeLabelIds: ["UNREAD"] } },
			{ url: "https://gmail.googleapis.com/gmail/v1/users/me/threads/t1/modify", method: "POST", body: { addLabelIds: [], removeLabelIds: ["INBOX"] } },
		]);
	});

	it("rejects 404 and 429 with GmailApiError, status/reason, account label, and no leaked token", async () => {
		const fetch404 = createStubFetch(() => json({ error: { code: 404, message: "Not found", status: "NOT_FOUND", errors: [{ reason: "notFound" }] } }, 404));
		await expect(makeAdapter(fetch404).getMessage({ domain: "angus", messageId: "missing" })).rejects.toSatisfy((err: unknown) => {
			expect(err).toBeInstanceOf(GmailApiError);
			expect(err).toMatchObject({ name: "GmailApiError", status: 404, reason: "notFound", googleStatus: "NOT_FOUND" });
			expect((err as Error).message).toContain("account 'personal'");
			expect((err as Error).message).not.toMatch(/rt-angus|access-rt-angus/);
			return true;
		});
		const fetch429 = createStubFetch(() => json({ error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED", errors: [{ reason: "rateLimitExceeded" }] } }, 429));
		await expect(makeAdapter(fetch429).getProfile({ domain: "work" })).rejects.toSatisfy((err: unknown) => {
			expect(err).toBeInstanceOf(GmailApiError);
			expect(err).toMatchObject({ name: "GmailApiError", status: 429, reason: "rateLimitExceeded", googleStatus: "RESOURCE_EXHAUSTED" });
			expect((err as Error).message).toContain("account 'work'");
			expect((err as Error).message).not.toMatch(/rt-work|access-rt-work/);
			return true;
		});
	});

	it("throws the token source's descriptive error before making a Gmail call when refresh token is missing", async () => {
		const fetchFn = createStubFetch(() => json({}));
		await expect(makeAdapter(fetchFn, {}).getProfile({ domain: "angus" })).rejects.toSatisfy((err: unknown) => {
			expect((err as Error).message).toContain("Google refresh token for domain 'angus' is not configured");
			expect((err as Error).message).not.toMatch(/rt-angus|access-rt-angus/);
			return true;
		});
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("getDraft(format: 'metadata') passes DRAFT_METADATA_FIELDS and extracts To/Cc/Bcc, and sendDraft posts to /drafts/send", async () => {
		const calls: { url: string; method: string; body?: unknown }[] = [];
		const fetchFn = createStubFetch((url, init) => {
			const method = init?.method ?? "GET";
			calls.push({ url, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
			if (url.endsWith("/drafts/send")) return json({ id: "m10", threadId: "t1" });
			return json({
				id: "d1",
				message: {
					id: "m9",
					threadId: "t1",
					payload: {
						headers: [
							{ name: "To", value: "owner@example.com" },
							{ name: "To", value: "owner@work.example.com" },
							{ name: "CC", value: "cc@example.com" },
							{ name: "bCc", value: "bcc@example.com" },
						],
					},
				},
			});
		});
		const adapter = makeAdapter(fetchFn);
		const meta = await adapter.getDraft({ domain: "angus", draftId: "d1", format: "metadata" });
		expect(meta).toMatchObject({
			to: "owner@example.com, owner@work.example.com",
			cc: "cc@example.com",
			bcc: "bcc@example.com",
		});
		expect(await adapter.sendDraft({ domain: "work", draftId: "d1" })).toEqual({
			messageId: "m10",
			threadId: "t1",
		});
		expect(calls).toEqual([
			{
				url: `https://gmail.googleapis.com/gmail/v1/users/me/drafts/d1?format=metadata&fields=${DRAFT_METADATA_FIELDS}`,
				method: "GET",
			},
			{
				url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send",
				method: "POST",
				body: { id: "d1" },
			},
		]);
	});

	it("restricts /drafts/send to GmailPort.sendDraft and reaches it only from gmail_send_draft", () => {
		const coreSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
		const collectTs = (dir: string): string[] =>
			fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
				const p = path.join(dir, e.name);
				if (e.isDirectory()) return collectTs(p);
				return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
			});

		const endpointHits = collectTs(path.join(coreSrc, "adapters"))
			.filter((f) => fs.readFileSync(f, "utf-8").includes("/drafts/send"))
			.map((f) => path.relative(coreSrc, f).replace(/\\/g, "/"));
		expect(endpointHits).toEqual(["adapters/google/gmail/client.ts"]);
		const clientSrc = fs.readFileSync(path.join(coreSrc, "adapters/google/gmail/client.ts"), "utf-8");
		expect(clientSrc.match(/\/drafts\/send/g)).toHaveLength(1);

		const actionHits = collectTs(path.join(coreSrc, "actions"))
			.filter((f) => fs.readFileSync(f, "utf-8").includes(".sendDraft("))
			.map((f) => path.relative(coreSrc, f).replace(/\\/g, "/"));
		expect(actionHits).toEqual(["actions/gmail/sendDraft.ts"]);
	});
});
