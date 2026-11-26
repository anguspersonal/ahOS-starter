import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCalendarDeleteEventAction, type Domain } from "@ahkms/core";
import { createGoogleCalendarAdapter } from "@ahkms/core/adapters";
import { getCredential } from "../credentials.js";
import { DOMAIN_LEGACY_SCOPE } from "../domains.js";
import { GOOGLE_ACCOUNT_PROVIDER, type GoogleAccount } from "../google/accounts.js";

const calendarDeleteEventHandler = async (args: Record<string, unknown>) => {
	const action = createCalendarDeleteEventAction({
		calendar: createGoogleCalendarAdapter({
			clientId: "cid",
			clientSecret: "csec",
			refreshToken: (d: Domain) =>
				getCredential(GOOGLE_ACCOUNT_PROVIDER[DOMAIN_LEGACY_SCOPE[d] as GoogleAccount]),
		}),
	});
	const out = await action.run(args as any, { caller: "ui", requestId: "r1" });
	return { content: [{ type: "text" as const, text: action.formatMcp!(out) }] };
};

type FetchCall = { url: string; method: string; body: unknown };

/**
 * Record every request, and reply per (method, url). The body is parsed here rather
 * than in each test because what gets SENT is the whole point of this file: three of
 * these tests fail only by inspecting a request body.
 */
function stubFetch(
	responder: (
		url: string,
		method: string,
	) => { payload?: unknown; ok?: boolean; status?: number },
): FetchCall[] {
	const calls: FetchCall[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url === "https://oauth2.googleapis.com/token") {
				return new Response(JSON.stringify({ access_token: "fake_access_token" }), {
					status: 200,
				});
			}
			const method = init?.method ?? "GET";
			calls.push({
				url,
				method,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			const r = responder(url, method);
			return {
				ok: r.ok ?? true,
				status: r.status ?? 200,
				statusText: r.ok === false ? "Error" : "OK",
				json: async () => r.payload,
				text: async () => JSON.stringify(r.payload ?? ""),
			} as Response;
		}),
	);
	return calls;
}

function event(over: Record<string, unknown> = {}) {
	return {
		id: "e1",
		summary: "Standup",
		start: { dateTime: "2026-09-07T09:30:00Z" },
		end: { dateTime: "2026-09-07T09:45:00Z" },
		...over,
	};
}

const origPersonal = process.env.GOOGLE_REFRESH_TOKEN_PERSONAL;
const origWork = process.env.GOOGLE_REFRESH_TOKEN_WORK;

beforeEach(() => {
	process.env.GOOGLE_REFRESH_TOKEN_PERSONAL = "fake_personal";
	process.env.GOOGLE_REFRESH_TOKEN_WORK = "fake_work";
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (origPersonal === undefined) delete process.env.GOOGLE_REFRESH_TOKEN_PERSONAL;
	else process.env.GOOGLE_REFRESH_TOKEN_PERSONAL = origPersonal;
	if (origWork === undefined) delete process.env.GOOGLE_REFRESH_TOKEN_WORK;
	else process.env.GOOGLE_REFRESH_TOKEN_WORK = origWork;
});

describe("calendar_delete_event", () => {
	it("reads the event before deleting, so the reply names what was cancelled", async () => {
		const calls = stubFetch((_url, method) =>
			method === "GET" ? { payload: event({ summary: "Budget review" }) } : { status: 204 },
		);

		const res = await calendarDeleteEventHandler({
			account: "personal",
			event_id: "e1",
		});

		// GET strictly before DELETE: reading afterwards is impossible, and a wrong id
		// must fail before anything is destroyed rather than after.
		expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
		expect(res.content[0].text).toContain("Budget review");
	});

	it("does not delete when the read fails, so a wrong id destroys nothing", async () => {
		const calls = stubFetch((_url, method) =>
			method === "GET" ? { ok: false, status: 404, payload: "Not Found" } : { status: 204 },
		);

		await expect(
			calendarDeleteEventHandler({ account: "personal", event_id: "wrong" }),
		).rejects.toThrow(/404/);

		expect(calls.some((c) => c.method === "DELETE")).toBe(false);
	});

	it("reports an already-deleted event as done, not as an error", async () => {
		stubFetch((_url, method) =>
			method === "GET" ? { payload: event() } : { ok: false, status: 410 },
		);

		const res = await calendarDeleteEventHandler({
			account: "personal",
			event_id: "e1",
		});
		expect(res.content[0].text).toMatch(/already deleted/i);
	});

	it("names the series id needed to cancel the rest of a recurrence", async () => {
		stubFetch((_url, method) =>
			method === "GET"
				? { payload: event({ recurringEventId: "series_1" }) }
				: { status: 204 },
		);

		const res = await calendarDeleteEventHandler({
			account: "personal",
			event_id: "e1_20260907",
		});
		expect(res.content[0].text).toMatch(/delete 'series_1' to cancel all of it/);
	});
});
