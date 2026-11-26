import { describe, expect, it, vi } from "vitest";
import { createCalendarGetEventAction } from "./getEvent.js";
import { CalendarApiError, type CalendarPort, type ParsedEvent } from "../../ports/calendar.js";

const ctx = { caller: "test", requestId: "r1" };

const baseFixture: ParsedEvent = {
	id: "e1",
	summary: "Standup",
	start: "2026-09-07T09:30:00Z",
	end: "2026-09-07T09:45:00Z",
	allDay: false,
	location: "Zoom",
	description: "Daily sync notes",
	organizer: "them@example.com",
	attendees: [
		{ email: "them@example.com", responseStatus: "accepted", self: false },
		{ email: "me@example.com", responseStatus: "tentative", self: true },
	],
	myResponse: "tentative",
	status: "confirmed",
	htmlLink: "https://calendar.google.com/event?eid=e1",
	recurringEventId: "series_1",
	account: "work",
};

function fakePort(impl: (params: any) => Promise<ParsedEvent>): CalendarPort {
	return { getEvent: vi.fn(impl) } as unknown as CalendarPort;
}

describe("calendar_get_event", () => {
	it("renders a fixture event byte-identically to dev and defaults calendar_id to primary", async () => {
		const port = fakePort(async () => baseFixture);
		const action = createCalendarGetEventAction(port);
		const out = await action.run({ domain: "work", event_id: "e1" }, ctx);

		expect(port.getEvent).toHaveBeenCalledWith({
			domain: "work",
			calendarId: "primary",
			eventId: "e1",
		});
		expect(action.formatMcp!(out)).toBe(
			[
				"Standup [work]",
				"When: 2026-09-07T09:30:00Z to 2026-09-07T09:45:00Z",
				"Where: Zoom",
				"Status: confirmed, your response: tentative",
				"Organiser: them@example.com",
				"Part of recurring series series_1",
				"Link: https://calendar.google.com/event?eid=e1",
				"Attendees:",
				"  - them@example.com: accepted",
				"  - me@example.com (you): tentative",
				"\nDaily sync notes",
			].join("\n"),
		);
	});

	it("prints the ETag verbatim on its own line after Link, so an MCP caller can pass it to a write tool (#2293)", async () => {
		const etag = '"3181161784712000"';
		const action = createCalendarGetEventAction(fakePort(async () => ({ ...baseFixture, etag })));
		const out = await action.run({ domain: "work", event_id: "e1" }, ctx);

		expect(action.formatMcp!(out)).toBe(
			[
				"Standup [work]",
				"When: 2026-09-07T09:30:00Z to 2026-09-07T09:45:00Z",
				"Where: Zoom",
				"Status: confirmed, your response: tentative",
				"Organiser: them@example.com",
				"Part of recurring series series_1",
				"Link: https://calendar.google.com/event?eid=e1",
				'ETag: "3181161784712000"',
				"Attendees:",
				"  - them@example.com: accepted",
				"  - me@example.com (you): tentative",
				"\nDaily sync notes",
			].join("\n"),
		);
	});

	it("renders all-day events with no attendees or optional fields and reconciles legacy account", async () => {
		const port = fakePort(async () => ({
			...baseFixture,
			start: "2026-09-07",
			end: "2026-09-08",
			allDay: true,
			location: "",
			description: "",
			organizer: "",
			attendees: [],
			myResponse: "",
			htmlLink: "",
			recurringEventId: "",
			account: "personal",
		}));
		const action = createCalendarGetEventAction(port);
		const out = await action.run({ account: "personal", calendar_id: "cal-2", event_id: "e2" }, ctx);

		expect(port.getEvent).toHaveBeenCalledWith({
			domain: "angus",
			calendarId: "cal-2",
			eventId: "e2",
		});
		expect(action.formatMcp!(out)).toBe(
			["Standup [personal]", "When: 2026-09-07 (all day)", "Status: confirmed", "Attendees:", "  (none)"].join("\n"),
		);
	});

	it("refuses a missing domain with dev's exact text and propagates 404 CalendarApiError naming the account", async () => {
		const err404 = new CalendarApiError(
			"Calendar GET /calendars/primary/events/missing failed for account 'personal' (404): Not Found",
			404,
			"notFound",
			"NOT_FOUND",
		);
		const action = createCalendarGetEventAction(fakePort(async () => { throw err404; }));

		await expect(action.run({ event_id: "e1" }, ctx)).rejects.toThrow(
			"`domain` is required to send — 'work' (the work.example.com Workspace account) or 'angus' (the personal one). There is no default: sending as the wrong identity cannot be taken back.",
		);
		await expect(
			action.run({ domain: "work", account: "personal", event_id: "e1" }, ctx),
		).rejects.toThrow(/different domains/);
		await expect(action.run({ domain: "angus", event_id: "missing" }, ctx)).rejects.toMatchObject({
			name: "CalendarApiError",
			status: 404,
			reason: "notFound",
			message: expect.stringContaining("account 'personal'"),
		});
	});
});
