import { afterEach, describe, expect, it, vi } from "vitest";
import { createCalendarListEventsAction } from "./listEvents.js";
import {
	CalendarApiError,
	type CalendarListEventsParams,
	type CalendarPort,
	type ParsedEvent,
} from "../../ports/calendar.js";

const ctx = { caller: "test", requestId: "r1" };

function makeEvent(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
	return {
		id: "e1",
		summary: "Standup",
		start: "2026-09-07T09:30:00Z",
		end: "2026-09-07T09:45:00Z",
		allDay: false,
		location: "",
		description: "",
		organizer: "",
		attendees: [],
		myResponse: "",
		status: "confirmed",
		htmlLink: "",
		recurringEventId: "",
		account: "personal",
		...overrides,
	};
}

function fakePort(
	impl: (params: CalendarListEventsParams) => Promise<ParsedEvent[]>,
): CalendarPort {
	return { listEvents: vi.fn(impl) } as unknown as CalendarPort;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("calendar_list_events", () => {
	it("reads both angus (personal) and work when account/domain is omitted, resorts chronologically, and labels each event", async () => {
		const port = fakePort(async ({ domain }) =>
			domain === "angus"
				? [
						makeEvent({
							id: "late",
							summary: "Late",
							start: "2026-09-07T17:00:00Z",
							end: "2026-09-07T18:00:00Z",
							account: "personal",
						}),
					]
				: [
						makeEvent({
							id: "early",
							summary: "Early",
							start: "2026-09-07T08:00:00Z",
							end: "2026-09-07T09:00:00Z",
							account: "work",
						}),
					],
		);
		const action = createCalendarListEventsAction(port);
		const out = await action.run(
			{
				time_min: "2026-09-07T00:00:00.000Z",
				time_max: "2026-09-14T00:00:00.000Z",
			},
			ctx,
		);

		expect(port.listEvents).toHaveBeenCalledTimes(2);
		expect(port.listEvents).toHaveBeenNthCalledWith(1, {
			domain: "angus",
			calendarId: "primary",
			timeMin: "2026-09-07T00:00:00.000Z",
			timeMax: "2026-09-14T00:00:00.000Z",
			query: undefined,
			maxResults: 25,
		});
		expect(port.listEvents).toHaveBeenNthCalledWith(2, {
			domain: "work",
			calendarId: "primary",
			timeMin: "2026-09-07T00:00:00.000Z",
			timeMax: "2026-09-14T00:00:00.000Z",
			query: undefined,
			maxResults: 25,
		});
		expect(action.formatMcp!(out)).toBe(
			[
				"2 event(s) in both calendars ('primary') from 2026-09-07T00:00:00.000Z to 2026-09-14T00:00:00.000Z:",
				"",
				"• [early] 2026-09-07T08:00:00Z to 2026-09-07T09:00:00Z — Early [work]",
				"• [late] 2026-09-07T17:00:00Z to 2026-09-07T18:00:00Z — Late [personal]",
				"",
				"Both calendars read. Each event names its account in brackets.",
			].join("\n"),
		);
	});

	it("prints each event's own ETag on its line, and leaves a line without one unchanged (#2293)", async () => {
		const port = fakePort(async () => [
			makeEvent({ id: "a", summary: "A", etag: '"111"', location: "Room 1" }),
			makeEvent({
				id: "b",
				summary: "B",
				start: "2026-09-07T10:00:00Z",
				end: "2026-09-07T11:00:00Z",
				etag: '"222"',
			}),
			makeEvent({
				id: "c",
				summary: "C",
				start: "2026-09-07T12:00:00Z",
				end: "2026-09-07T13:00:00Z",
			}),
		]);
		const action = createCalendarListEventsAction(port);
		const out = await action.run(
			{
				account: "personal",
				time_min: "2026-09-07T00:00:00.000Z",
				time_max: "2026-09-14T00:00:00.000Z",
			},
			ctx,
		);

		expect(action.formatMcp!(out)).toBe(
			[
				"3 event(s) in the 'personal' calendar ('primary') from 2026-09-07T00:00:00.000Z to 2026-09-14T00:00:00.000Z:",
				"",
				'• [a] 2026-09-07T09:30:00Z to 2026-09-07T09:45:00Z — A [personal] (at Room 1) etag="111"',
				'• [b] 2026-09-07T10:00:00Z to 2026-09-07T11:00:00Z — B [personal] etag="222"',
				"• [c] 2026-09-07T12:00:00Z to 2026-09-07T13:00:00Z — C [personal]",
			].join("\n"),
		);
	});

	it("returns the working calendar's events when one calendar rejects, marked INCOMPLETE with dev's exact text", async () => {
		const port = fakePort(async ({ domain }) => {
			if (domain === "work") {
				throw new CalendarApiError(
					"GOOGLE_REFRESH_TOKEN_WORK is not set",
					401,
					"authError",
					"UNAUTHENTICATED",
				);
			}
			return [makeEvent({ account: "personal" })];
		});
		const action = createCalendarListEventsAction(port);
		const out = await action.run(
			{
				time_min: "2026-09-07T00:00:00.000Z",
				time_max: "2026-09-14T00:00:00.000Z",
			},
			ctx,
		);

		expect(action.formatMcp!(out)).toBe(
			[
				"1 event(s) in both calendars ('primary') from 2026-09-07T00:00:00.000Z to 2026-09-14T00:00:00.000Z:",
				"",
				"• [e1] 2026-09-07T09:30:00Z to 2026-09-07T09:45:00Z — Standup [personal]",
				"",
				"COULD NOT READ 1 of 2 calendar(s), so this list is INCOMPLETE:",
				"  - work: GOOGLE_REFRESH_TOKEN_WORK is not set",
			].join("\n"),
		);
	});

	it("defaults time_min to now, time_max to +7d, max_results to 25, and scopes to one calendar when account or domain is passed", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-07T12:00:00.000Z"));

		const port = fakePort(async () => []);
		const action = createCalendarListEventsAction(port);
		const out = await action.run({ account: "work", query: "investor" }, ctx);

		expect(port.listEvents).toHaveBeenCalledTimes(1);
		expect(port.listEvents).toHaveBeenCalledWith({
			domain: "work",
			calendarId: "primary",
			timeMin: "2026-09-07T12:00:00.000Z",
			timeMax: "2026-09-14T12:00:00.000Z",
			query: "investor",
			maxResults: 25,
		});
		expect(action.formatMcp!(out)).toBe(
			[
				"0 event(s) in the 'work' calendar ('primary') from 2026-09-07T12:00:00.000Z to 2026-09-14T12:00:00.000Z matching 'investor':",
				"",
				"(nothing scheduled)",
			].join("\n"),
		);

		await expect(
			action.run({ domain: "angus", account: "work" }, ctx),
		).rejects.toThrow(/different domains/);
	});
});
