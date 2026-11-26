import { describe, expect, it } from "vitest";
import { parseEvent } from "../google/calendar.js";

function event(over: Record<string, unknown> = {}) {
	return {
		id: "e1",
		summary: "Standup",
		start: { dateTime: "2026-09-07T09:30:00Z" },
		end: { dateTime: "2026-09-07T09:45:00Z" },
		...over,
	};
}

describe("parseEvent", () => {
	it("reads the owner's own response out of the attendee list", () => {
		const e = parseEvent(
			event({
				attendees: [
					{ email: "them@example.com", responseStatus: "accepted" },
					{ email: "me@example.com", responseStatus: "needsAction", self: true },
				],
			}),
			"personal",
		);
		expect(e.myResponse).toBe("needsAction");
	});

	it("marks an all-day event from `date` rather than `dateTime`", () => {
		const e = parseEvent(
			{ id: "e", start: { date: "2026-09-07" }, end: { date: "2026-09-08" } },
			"personal",
		);
		expect(e.allDay).toBe(true);
		expect(e.start).toBe("2026-09-07");
	});

	it("leaves myResponse empty when the owner is not an attendee", () => {
		// An event you created with no guests has no attendee list at all. Reporting
		// "needsAction" there would show a nag for something needing no response.
		expect(parseEvent(event(), "personal").myResponse).toBe("");
	});
});

