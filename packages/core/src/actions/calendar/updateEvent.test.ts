import { describe, expect, it, vi } from "vitest";
import { createCalendarUpdateEventAction, toEventTime } from "./updateEvent.js";
import { createGoogleCalendarAdapter } from "../../adapters/google/calendar/index.js";
import { CalendarApiError, type CalendarPort, type ParsedEvent } from "../../ports/calendar.js";

const ctx = { caller: "test" as const, requestId: "r1" };

const baseFixture: ParsedEvent = {
	id: "e1",
	summary: "Renamed",
	start: "2026-09-07T09:30:00Z",
	end: "2026-09-07T09:45:00Z",
	allDay: false,
	location: "Room 2",
	description: "kept",
	organizer: "them@example.com",
	attendees: [
		{ email: "me@example.com", responseStatus: "accepted", self: true },
		{ email: "them@example.com", responseStatus: "needsAction", self: false },
	],
	myResponse: "accepted",
	status: "confirmed",
	htmlLink: "https://calendar.google.com/event?eid=e1",
	recurringEventId: "series_1",
	account: "personal",
};

function makeAdapter(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>): CalendarPort {
	return createGoogleCalendarAdapter({
		clientId: "cid",
		clientSecret: "csecret",
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

describe("calendar_update_event", () => {
	it("sends only the passed fields, never sends attendees, and renders byte-identically to dev", async () => {
		const calls: Array<{ url: URL; method: string; body: Record<string, unknown> }> = [];
		const port = makeAdapter((url, init) => {
			calls.push({
				url,
				method: init?.method ?? "GET",
				body: JSON.parse(String(init?.body ?? "{}")),
			});
			return new Response(
				JSON.stringify({
					id: "e1",
					summary: "Renamed",
					description: "kept",
					location: "Room 2",
					start: { dateTime: "2026-09-07T09:30:00Z" },
					end: { dateTime: "2026-09-07T09:45:00Z" },
					recurringEventId: "series_1",
					attendees: [
						{ email: "me@example.com", self: true, responseStatus: "accepted" },
						{ email: "them@example.com", responseStatus: "needsAction" },
					],
				}),
				{ status: 200 },
			);
		});

		const action = createCalendarUpdateEventAction(port);
		const out = await action.run(
			{
				account: "personal",
				event_id: "e1",
				summary: "Renamed",
			},
			ctx,
		);

		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("PATCH");
		expect(calls[0].url.searchParams.get("sendUpdates")).toBe("all");
		expect(calls[0].body).toEqual({ summary: "Renamed" });
		expect(calls[0].body).not.toHaveProperty("description");
		expect(calls[0].body).not.toHaveProperty("location");
		expect(calls[0].body).not.toHaveProperty("attendees");

		expect(action.formatMcp!(out)).toBe(
			[
				"Updated summary on 'Renamed' [personal].",
				"• [e1] 2026-09-07T09:30:00Z to 2026-09-07T09:45:00Z — Renamed [personal] (at Room 2, 2 attendees)",
				"2 attendees, notified: all.",
				"NOTE: this changed ONE occurrence of recurring series series_1, not the whole series.",
			].join("\n"),
		);
	});

	it("maps YYYY-MM-DD to { date } and ISO timestamps to { dateTime }, and maps notify_attendees to sendUpdates", async () => {
		expect(toEventTime("2026-09-09")).toEqual({ date: "2026-09-09" });
		expect(toEventTime("2026-09-09T14:00:00Z")).toEqual({ dateTime: "2026-09-09T14:00:00Z" });

		const calls: Array<{ url: URL; body: Record<string, unknown> }> = [];
		const port = makeAdapter((url, init) => {
			calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
			return new Response(
				JSON.stringify({
					id: "e1",
					summary: "All Day",
					start: { date: "2026-09-09" },
					end: { date: "2026-09-10" },
				}),
				{ status: 200 },
			);
		});

		const action = createCalendarUpdateEventAction(port);
		const out1 = await action.run(
			{
				domain: "work",
				calendar_id: "cal-2",
				event_id: "e1",
				start: "2026-09-09",
				end: "2026-09-10",
				notify_attendees: "none",
			},
			ctx,
		);

		expect(calls[0].url.pathname).toBe("/calendar/v3/calendars/cal-2/events/e1");
		expect(calls[0].url.searchParams.get("sendUpdates")).toBe("none");
		expect(calls[0].body).toEqual({
			start: { date: "2026-09-09" },
			end: { date: "2026-09-10" },
		});
		expect(action.formatMcp!(out1)).toBe(
			[
				"Updated start, end on 'All Day' [work].",
				"• [e1] 2026-09-09 (all day) — All Day [work]",
			].join("\n"),
		);

		await action.run(
			{
				domain: "work",
				event_id: "e1",
				start: "2026-09-09T14:00:00Z",
				notify_attendees: "externalOnly",
			},
			ctx,
		);
		expect(calls[1].url.searchParams.get("sendUpdates")).toBe("externalOnly");
		expect(calls[1].body).toEqual({
			start: { dateTime: "2026-09-09T14:00:00Z" },
		});
	});

	it("refuses missing domain, conflicting domain/account, and empty updates, and propagates CalendarApiError with status/reason", async () => {
		const err404 = new CalendarApiError(
			"Calendar PATCH /calendars/primary/events/missing?sendUpdates=all failed for account 'personal' (404): Not Found",
			404,
			"notFound",
			"NOT_FOUND",
		);
		const port = {
			updateEvent: vi.fn(async () => {
				throw err404;
			}),
		} as unknown as CalendarPort;
		const action = createCalendarUpdateEventAction(port);

		await expect(action.run({ event_id: "e1", summary: "X" }, ctx)).rejects.toThrow(
			"`domain` is required to send — 'work' (the work.example.com Workspace account) or 'angus' (the personal one). There is no default: sending as the wrong identity cannot be taken back.",
		);
		await expect(
			action.run({ domain: "work", account: "personal", event_id: "e1", summary: "X" }, ctx),
		).rejects.toThrow(/different domains/);
		await expect(action.run({ account: "personal", event_id: "e1" }, ctx)).rejects.toThrow(
			/nothing to change/i,
		);
		expect(port.updateEvent).not.toHaveBeenCalled();

		await expect(
			action.run({ domain: "angus", event_id: "missing", summary: "X" }, ctx),
		).rejects.toMatchObject({
			name: "CalendarApiError",
			status: 404,
			reason: "notFound",
			message: expect.stringContaining("account 'personal'"),
		});
		expect(baseFixture.account).toBe("personal");
	});
});
