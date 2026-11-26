import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { reconcileDomain } from "../../domain/domains.js";
import {
	formatEvent,
	type CalendarEventTime,
	type CalendarPort,
	type CalendarReceipt,
	type NotifyAttendees,
	type ParsedEvent,
} from "../../ports/calendar.js";
import { defineAction } from "../defineAction.js";

const MISSING_DOMAIN_ERROR =
	"`domain` is required to send — 'work' (the work.example.com Workspace account) or 'angus' (the personal one). There is no default: sending as the wrong identity cannot be taken back.";

const NOTHING_TO_CHANGE_ERROR =
	"Calendar update: nothing to change. Pass at least one of summary, description, location, start or end.";

const NOTIFY_DEFAULT: NotifyAttendees = "all";

const UPDATABLE_FIELDS = ["summary", "description", "location", "start", "end"] as const;

export const calendarUpdateEventInput = {
	domain: optionalDomainInput,
	account: z
		.enum(["personal", "work"])
		.optional()
		.describe("Deprecated, use `domain`. Which account owns the event: personal | work."),
	calendar_id: z.string().optional().describe("Calendar id, default 'primary'."),
	event_id: z
		.string()
		.min(1)
		.describe(
			"Event id, from calendar_list_events. For a recurring series, that id is ONE OCCURRENCE (calendar_list_events expands series into instances), so updating it changes that occurrence alone and leaves the rest of the series untouched.",
		),
	etag: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Optional ETag from calendar_get_event or calendar_list_events; sends If-Match so concurrent edits fail with 412 instead of overwriting.",
		),
	summary: z.string().optional().describe("New title. Omit to leave unchanged."),
	description: z.string().optional().describe("New description. Omit to leave unchanged."),
	location: z.string().optional().describe("New location. Omit to leave unchanged."),
	start: z
		.string()
		.optional()
		.describe(
			"New start: a full ISO datetime for a timed event, or 'YYYY-MM-DD' for an all-day one. Pass `end` too when moving an event, or it keeps its old end and the duration changes.",
		),
	end: z.string().optional().describe("New end, same format as `start`."),
	notify_attendees: z
		.enum(["all", "externalOnly", "none"])
		.optional()
		.describe(
			"Who Google emails about the change. Default 'all', which is deliberate: an unwanted notification is noise, but moving or cancelling a meeting other people hold in their own calendars without telling them is a mess the owner has to clean up by hand. Use 'none' only for an event nobody else is on, or a correction made seconds after the original.",
		),
};

export const calendarUpdateEventInputSchema = z.object(calendarUpdateEventInput);

export type CalendarUpdateEventInput = z.infer<typeof calendarUpdateEventInputSchema>;

export interface CalendarUpdateEventOutput extends ParsedEvent {
	event: ParsedEvent;
	changed: string[];
	notify: NotifyAttendees;
	receipt: CalendarReceipt;
}

/** 'YYYY-MM-DD' is an all-day date; anything longer is a timed instant. */
export function toEventTime(value: string): CalendarEventTime {
	return /^\d{4}-\d{2}-\d{2}$/.test(value) ? { date: value } : { dateTime: value };
}

export function formatCalendarUpdateEventMcp(out: CalendarUpdateEventOutput): string {
	const updated = out.event ?? out;
	const notify = out.notify ?? NOTIFY_DEFAULT;
	return [
		`Updated ${out.changed.join(", ")} on '${updated.summary}' [${updated.account}].`,
		formatEvent(updated),
		updated.attendees.length > 1
			? `${updated.attendees.length} attendees, notified: ${notify}.`
			: null,
		updated.recurringEventId
			? `NOTE: this changed ONE occurrence of recurring series ${updated.recurringEventId}, not the whole series.`
			: null,
	]
		.filter((l): l is string => l !== null)
		.join("\n");
}

export function createCalendarUpdateEventAction(port: CalendarPort) {
	return defineAction<typeof calendarUpdateEventInputSchema, CalendarUpdateEventOutput>({
		id: "calendar_update_event",
		domain: "integrations",
		description:
			"Change a Google Calendar event's title, description, location, start or end. Only the fields you pass are touched. It CANNOT change who is invited: Calendar treats the attendee list as one whole value, so a partial write would silently uninvite everyone omitted. Full notes: docs/guides/tools/calendar_update_event.md",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: calendarUpdateEventInputSchema,
		formatMcp: formatCalendarUpdateEventMcp,
		async run(input) {
			const domain = reconcileDomain(input.domain, input.account, "account");
			if (!domain) {
				throw new Error(MISSING_DOMAIN_ERROR);
			}
			const changed = UPDATABLE_FIELDS.filter((f) => input[f] !== undefined);
			if (changed.length === 0) {
				throw new Error(NOTHING_TO_CHANGE_ERROR);
			}
			const notify: NotifyAttendees = input.notify_attendees ?? NOTIFY_DEFAULT;
			const updated = await port.updateEvent({
				domain,
				calendarId: input.calendar_id ?? "primary",
				eventId: input.event_id,
				summary: input.summary,
				description: input.description,
				location: input.location,
				start: input.start === undefined ? undefined : toEventTime(input.start),
				end: input.end === undefined ? undefined : toEventTime(input.end),
				notify,
				...(input.etag !== undefined ? { etag: input.etag } : {}),
			});
			return {
				...updated,
				event: updated,
				changed,
				notify,
				receipt: {
					account: updated.account,
					event_ids: [updated.id],
					count: 1,
					changed_count: changed.length,
				},
			};
		},
	});
}
