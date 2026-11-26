import { describe, expect, it, vi } from "vitest";
import { ExternalItemCreatedButUnreadable } from "../../../actions/outwardWrite.js";
import type { CalendarApiError } from "../../../ports/calendar.js";
import {
	createGoogleCalendarAdapter, EVENT_FIELDS, formatEvent, LIST_EVENTS_FIELDS,
} from "./index.js";

function makeAdapter(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
	return createGoogleCalendarAdapter({
		clientId: "cid", clientSecret: "csecret",
		refreshToken: async (d) => (d === "work" ? "rt-work" : "rt-angus"),
		fetchFn: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.href === "https://oauth2.googleapis.com/token") {
				const token = String(init?.body ?? "").includes("rt-work") ? "at-work" : "at-angus";
				return new Response(JSON.stringify({ access_token: token }), { status: 200 });
			}
			return handler(url, init);
		}),
	});
}

describe("createGoogleCalendarAdapter (#1580)", () => {
	it("listEvents exchanges domain tokens separately, sends query params, and stamps account", async () => {
		const calls: Array<{ url: URL; auth: string | null }> = [];
		const adapter = makeAdapter((url, init) => {
			calls.push({ url, auth: new Headers(init?.headers).get("Authorization") });
			return new Response(JSON.stringify({
				items: [{ id: "e1", summary: "Standup", start: { dateTime: "2026-07-10T09:00:00Z" }, end: { dateTime: "2026-07-10T09:30:00Z" } }],
			}), { status: 200 });
		});

		const workEvents = await adapter.listEvents({
			domain: "work", calendarId: "primary", timeMin: "2026-07-10T00:00:00Z",
			timeMax: "2026-07-11T00:00:00Z", query: "Standup", maxResults: 10,
		});
		const angusEvents = await adapter.listEvents({ domain: "angus" });

		expect([workEvents[0].account, angusEvents[0].account]).toEqual(["work", "personal"]);
		expect([calls[0].auth, calls[1].auth]).toEqual(["Bearer at-work", "Bearer at-angus"]);
		const sp = calls[0].url.searchParams;
		expect([
			calls[0].url.pathname, sp.get("singleEvents"), sp.get("orderBy"), sp.get("timeMin"),
			sp.get("timeMax"), sp.get("q"), sp.get("maxResults"), sp.get("fields"),
		]).toEqual([
			"/calendar/v3/calendars/primary/events", "true", "startTime", "2026-07-10T00:00:00Z",
			"2026-07-11T00:00:00Z", "Standup", "10", LIST_EVENTS_FIELDS,
		]);
		expect(formatEvent(workEvents[0])).toBe("• [e1] 2026-07-10T09:00:00Z to 2026-07-10T09:30:00Z — Standup [work]");
	});

	it("getEvent fetches with EVENT_FIELDS and rejects 404 with CalendarApiError naming the account", async () => {
		let u: URL | undefined;
		const ev = await makeAdapter((url) => {
			u = url;
			return new Response(JSON.stringify({ id: "ev-1", summary: "Review", start: { date: "2026-07-10" }, end: { date: "2026-07-11" } }), { status: 200 });
		}).getEvent({ domain: "angus", eventId: "ev-1" });
		expect([ev.id, ev.allDay, ev.account, u?.pathname, u?.searchParams.get("fields")]).toEqual([
			"ev-1", true, "personal", "/calendar/v3/calendars/primary/events/ev-1", EVENT_FIELDS,
		]);

		const failing = makeAdapter(() => new Response(JSON.stringify({
			error: { code: 404, message: "Not Found", status: "NOT_FOUND", errors: [{ reason: "notFound" }] },
		}), { status: 404 }));
		await expect(failing.getEvent({ domain: "angus", eventId: "missing" })).rejects.toMatchObject({
			name: "CalendarApiError", status: 404, reason: "notFound", googleStatus: "NOT_FOUND",
			message: expect.stringContaining("account 'personal'"),
		} satisfies Partial<CalendarApiError>);
	});

	it("createEvent POSTs mapped body, URL-encodes calendarId, and throws ExternalItemCreatedButUnreadable on bad 200 JSON", async () => {
		let call: { url: URL; init?: RequestInit } | undefined;
		const created = await makeAdapter((url, init) => {
			call = { url, init };
			return new Response(JSON.stringify({ id: "evt_1", htmlLink: "https://cal/evt_1" }), { status: 200 });
		}).createEvent({
			domain: "work", calendarId: "team@work.example.com", summary: "Dentist", description: "Checkup",
			location: "Main St", start: { dateTime: "2026-07-10T14:00:00Z" }, end: { dateTime: "2026-07-10T15:00:00Z" },
			attendees: ["a@example.com"],
		});
		expect(created).toEqual({ id: "evt_1", htmlLink: "https://cal/evt_1" });
		expect([call?.url.pathname, call?.init?.method, JSON.parse(String(call?.init?.body))]).toEqual([
			`/calendar/v3/calendars/${encodeURIComponent("team@work.example.com")}/events`, "POST",
			{
				summary: "Dentist", description: "Checkup", location: "Main St",
				start: { dateTime: "2026-07-10T14:00:00Z" }, end: { dateTime: "2026-07-10T15:00:00Z" },
				attendees: [{ email: "a@example.com" }],
			},
		]);

		const unreadable = makeAdapter(() => new Response("not-json", { status: 200 }));
		await expect(unreadable.createEvent({
			domain: "angus", summary: "Sync", start: { date: "2026-07-10" }, end: { date: "2026-07-11" },
		})).rejects.toBeInstanceOf(ExternalItemCreatedButUnreadable);
	});

	it("updateEvent PATCHes partial fields with sendUpdates and rejects empty updates without fetching", async () => {
		const calls: Array<{ url: URL; body: unknown }> = [];
		const adapter = makeAdapter((url, init) => {
			calls.push({ url, body: JSON.parse(String(init?.body)) });
			return new Response(JSON.stringify({ id: "e1", summary: "Moved" }), { status: 200 });
		});
		await expect(adapter.updateEvent({ domain: "angus", eventId: "e1" })).rejects.toThrow(/nothing to change/);
		expect(calls).toHaveLength(0);

		const updated = await adapter.updateEvent({ domain: "angus", eventId: "e1", summary: "Moved", notify: "externalOnly" });
		expect([updated.summary, updated.account, calls[0].url.searchParams.get("sendUpdates"), calls[0].body]).toEqual([
			"Moved", "personal", "externalOnly", { summary: "Moved" },
		]);
	});

	it("deleteEvent returns true on 204 and false on 410, rejects errors with status/reason, and respondToEvent preserves all attendees on PATCH", async () => {
		let status = 204;
		let body: string | null = null;
		let delUrl: URL | undefined;
		const delAdapter = makeAdapter((url) => {
			delUrl = url;
			return new Response(body, { status });
		});
		expect(await delAdapter.deleteEvent({ domain: "work", eventId: "e1", notify: "none" })).toBe(true);
		expect(delUrl?.searchParams.get("sendUpdates")).toBe("none");
		status = 410;
		expect(await delAdapter.deleteEvent({ domain: "work", eventId: "e1" })).toBe(false);
		expect(delUrl?.searchParams.get("sendUpdates")).toBe("all");
		status = 403;
		body = JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "forbidden" }] } });
		await expect(delAdapter.deleteEvent({ domain: "work", eventId: "e1" })).rejects.toMatchObject({
			name: "CalendarApiError", status: 403, reason: "forbidden", googleStatus: "PERMISSION_DENIED",
		} satisfies Partial<CalendarApiError>);

		const rsvpCalls: Array<{ method: string; url: URL; body?: unknown }> = [];
		const rsvpAdapter = makeAdapter((url, init) => {
			const method = init?.method ?? "GET";
			rsvpCalls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
			return new Response(JSON.stringify({
				id: "e1", summary: "Sync", organizer: { email: "org@example.com" },
				attendees: [
					{ email: "other@example.com", responseStatus: "accepted", self: false },
					{ email: "me@example.com", responseStatus: method === "PATCH" ? "declined" : "needsAction", self: true },
				],
			}), { status: 200 });
		});
		const after = await rsvpAdapter.respondToEvent({ domain: "work", eventId: "e1", response: "declined" });
		expect([after.myResponse, rsvpCalls[0].method, rsvpCalls[0].url.searchParams.get("fields"), rsvpCalls[1].method, rsvpCalls[1].body]).toEqual([
			"declined", "GET", EVENT_FIELDS, "PATCH", {
				attendees: [
					{ email: "other@example.com", responseStatus: "accepted", self: false },
					{ email: "me@example.com", responseStatus: "declined", self: true },
				],
			},
		]);
	});
});
