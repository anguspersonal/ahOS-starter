import { describe, expect, it, vi } from "vitest";
import { createCalendarRespondToEventAction } from "./respondToEvent.js";
import {
	CalendarApiError,
	type CalendarPort,
	type ParsedEvent,
	type RsvpResponse,
} from "../../ports/calendar.js";

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
		{ email: "me@example.com", responseStatus: "accepted", self: true },
		{ email: "a@example.com", responseStatus: "accepted", self: false },
		{ email: "b@example.com", responseStatus: "declined", self: false },
	],
	myResponse: "accepted",
	status: "confirmed",
	htmlLink: "https://calendar.google.com/event?eid=e1",
	recurringEventId: "",
	account: "work",
};

function fakePort(impl: (params: any) => Promise<ParsedEvent>): CalendarPort {
	return { respondToEvent: vi.fn(impl) } as unknown as CalendarPort;
}

describe("calendar_respond_to_event", () => {
	it.each(["accepted", "declined", "tentative"] as const)(
		"renders %s RSVP byte-identically to dev and defaults calendar_id and notify_attendees",
		async (response: RsvpResponse) => {
			const port = fakePort(async () => ({
				...baseFixture,
				attendees: baseFixture.attendees.map((a) =>
					a.self ? { ...a, responseStatus: response } : a,
				),
				myResponse: response,
			}));
			const action = createCalendarRespondToEventAction(port);
			const out = await action.run(
				{ domain: "work", event_id: "e1", response },
				ctx,
			);

			expect(port.respondToEvent).toHaveBeenCalledWith({
				domain: "work",
				calendarId: "primary",
				eventId: "e1",
				response,
				notify: "all",
			});
			const extraBits =
				response === "accepted"
					? "at Zoom, 3 attendees"
					: `at Zoom, ${response}, 3 attendees`;
			expect(action.formatMcp!(out)).toBe(
				[
					`RSVP set to '${response}' on 'Standup' [work].`,
					`• [e1] 2026-09-07T09:30:00Z to 2026-09-07T09:45:00Z — Standup [work] (${extraBits})`,
					"Organiser: them@example.com",
					"3 attendee(s) on the event, still all present.",
				].join("\n"),
			);
		},
	);

	it("reconciles legacy account, forwards custom calendar_id and notify_attendees, and omits empty organiser", async () => {
		const port = fakePort(async () => ({
			...baseFixture,
			location: "",
			organizer: "",
			attendees: [{ email: "me@example.com", responseStatus: "declined", self: true }],
			myResponse: "declined",
			account: "personal",
		}));
		const action = createCalendarRespondToEventAction(port);
		const out = await action.run(
			{
				account: "personal",
				calendar_id: "cal-2",
				event_id: "e2",
				response: "declined",
				notify_attendees: "none",
			},
			ctx,
		);

		expect(port.respondToEvent).toHaveBeenCalledWith({
			domain: "angus",
			calendarId: "cal-2",
			eventId: "e2",
			response: "declined",
			notify: "none",
		});
		expect(action.formatMcp!(out)).toBe(
			[
				"RSVP set to 'declined' on 'Standup' [personal].",
				"• [e1] 2026-09-07T09:30:00Z to 2026-09-07T09:45:00Z — Standup [personal] (declined)",
				"1 attendee(s) on the event, still all present.",
			].join("\n"),
		);
	});

	it("refuses a missing domain, conflicting domain/account, not-an-attendee error, and 404 CalendarApiError", async () => {
		const notAttendeeErr = new Error(
			"Cannot RSVP to event 'e1' on the 'personal' calendar: you are not on its attendee list, so there is no response to set. It is organised by me@x.com. An event you created yourself has no RSVP; delete it to decline it.",
		);
		const err404 = new CalendarApiError(
			"Calendar GET /calendars/primary/events/missing failed for account 'personal' (404): Not Found",
			404,
			"notFound",
			"NOT_FOUND",
		);
		const action = createCalendarRespondToEventAction(
			fakePort(async ({ eventId }) => {
				if (eventId === "missing") throw err404;
				throw notAttendeeErr;
			}),
		);

		await expect(
			action.run({ event_id: "e1", response: "accepted" }, ctx),
		).rejects.toThrow(
			"`domain` is required to send — 'work' (the work.example.com Workspace account) or 'angus' (the personal one). There is no default: sending as the wrong identity cannot be taken back.",
		);
		await expect(
			action.run(
				{
					domain: "work",
					account: "personal",
					event_id: "e1",
					response: "accepted",
				},
				ctx,
			),
		).rejects.toThrow(/different domains/);
		await expect(
			action.run({ domain: "angus", event_id: "e1", response: "declined" }, ctx),
		).rejects.toThrow(/not on its attendee list/i);
		await expect(
			action.run(
				{ domain: "angus", event_id: "missing", response: "accepted" },
				ctx,
			),
		).rejects.toMatchObject({
			name: "CalendarApiError",
			status: 404,
			reason: "notFound",
			message: expect.stringContaining("account 'personal'"),
		});
	});
});
