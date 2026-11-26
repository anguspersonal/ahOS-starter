import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { reconcileDomain } from "../../domain/domains.js";
import {
	formatEvent,
	type CalendarPort,
	type CalendarReceipt,
	type ParsedEvent,
} from "../../ports/calendar.js";
import { defineAction } from "../defineAction.js";

const MISSING_DOMAIN_ERROR =
	"`domain` is required to send — 'work' (the work.example.com Workspace account) or 'angus' (the personal one). There is no default: sending as the wrong identity cannot be taken back.";

const NOTIFY_DEFAULT = "all" as const;

export const calendarRespondToEventInput = {
	domain: optionalDomainInput,
	account: z
		.enum(["personal", "work"])
		.optional()
		.describe(
			"Deprecated, use `domain`. Which account owns the event: personal | work.",
		),
	calendar_id: z.string().optional().describe("Calendar id, default 'primary'."),
	event_id: z.string().min(1).describe("Event id, from calendar_list_events."),
	etag: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Optional ETag from calendar_get_event or calendar_list_events; sends If-Match so concurrent edits fail with 412 instead of overwriting.",
		),
	response: z
		.enum(["accepted", "declined", "tentative"])
		.describe("Your RSVP. Replaces whatever your current response is."),
	notify_attendees: z
		.enum(["all", "externalOnly", "none"])
		.optional()
		.describe(
			"Who Google emails about the change. Default 'all', which is deliberate: an unwanted notification is noise, but moving or cancelling a meeting other people hold in their own calendars without telling them is a mess the owner has to clean up by hand. Use 'none' only for an event nobody else is on, or a correction made seconds after the original.",
		),
};

export const calendarRespondToEventInputSchema = z.object(
	calendarRespondToEventInput,
);

export type CalendarRespondToEventInput = z.infer<
	typeof calendarRespondToEventInputSchema
>;
export interface CalendarRespondToEventOutput extends ParsedEvent {
	receipt: CalendarReceipt;
}

export function formatCalendarRespondToEventMcp(updated: ParsedEvent): string {
	return [
		`RSVP set to '${updated.myResponse}' on '${updated.summary}' [${updated.account}].`,
		formatEvent(updated),
		updated.organizer ? `Organiser: ${updated.organizer}` : null,
		`${updated.attendees.length} attendee(s) on the event, still all present.`,
	]
		.filter((l): l is string => l !== null)
		.join("\n");
}

export function createCalendarRespondToEventAction(port: CalendarPort) {
	return defineAction<
		typeof calendarRespondToEventInputSchema,
		CalendarRespondToEventOutput
	>({
		id: "calendar_respond_to_event",
		domain: "integrations",
		description:
			"RSVP accepted, declined or tentative. `account` is required. Reads the attendee list and writes " +
			"it back with only your own entry changed, because Calendar treats that list as one value and a " +
			"partial write would remove everyone else. Fails loudly if you are not an attendee. Full notes: " +
			"docs/guides/tools/calendar_respond_to_event.md",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: calendarRespondToEventInputSchema,
		formatMcp: formatCalendarRespondToEventMcp,
		async run(input) {
			const domain = reconcileDomain(input.domain, input.account, "account");
			if (!domain) {
				throw new Error(MISSING_DOMAIN_ERROR);
			}
			const updated = await port.respondToEvent({
				domain,
				calendarId: input.calendar_id ?? "primary",
				eventId: input.event_id,
				response: input.response,
				notify: input.notify_attendees ?? NOTIFY_DEFAULT,
				...(input.etag !== undefined ? { etag: input.etag } : {}),
			});
			return {
				...updated,
				receipt: {
					account: updated.account,
					event_ids: [updated.id],
					count: 1,
					response: updated.myResponse,
				},
			};
		},
	});
}
