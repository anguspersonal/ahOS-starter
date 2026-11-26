import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { DOMAIN_LEGACY_SCOPE, reconcileDomain, type Domain } from "../../domain/domains.js";
import type {
	CalendarAccount,
	CalendarPort,
	CalendarReceipt,
	NotifyAttendees,
	ParsedEvent,
} from "../../ports/calendar.js";
import { defineAction } from "../defineAction.js";

const MISSING_DOMAIN_ERROR =
	"`domain` is required to send \u2014 'work' (the work.example.com Workspace account) or 'angus' (the personal one). There is no default: sending as the wrong identity cannot be taken back.";

const NOTIFY_DEFAULT: NotifyAttendees = "all";

export const CALENDAR_DELETE_EVENT_DESCRIPTION =
	"Cancel a Google Calendar event. Irreversible. `account` is required. Reads the event first so " +
	"bad ids fail safely and the reply names what was cancelled; attendees are emailed by default. " +
	"Parks for the owner's approval when the event has guests other than the owner. Full notes: " +
	"docs/guides/tools/calendar_delete_event.md";

export const calendarDeleteEventInput = {
	domain: optionalDomainInput,
	account: z
		.enum(["personal", "work"])
		.optional()
		.describe(
			"Deprecated, use `domain`. Which account owns the event: personal | work.",
		),
	calendar_id: z.string().optional().describe("Calendar id, default 'primary'."),
	event_id: z
		.string()
		.min(1)
		.describe(
			"Event id, from calendar_list_events. For a recurring series this is ONE OCCURRENCE and only that occurrence is deleted; to cancel a whole series, delete the id shown as its recurring series id.",
		),
	etag: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Optional ETag from calendar_get_event or calendar_list_events; sends If-Match so concurrent edits fail with 412 instead of deleting a changed event.",
		),
	notify_attendees: z
		.enum(["all", "externalOnly", "none"])
		.optional()
		.describe(
			"Who Google emails about the change. Default 'all', which is deliberate: an unwanted notification is noise, but moving or cancelling a meeting other people hold in their own calendars without telling them is a mess the owner has to clean up by hand. Use 'none' only for an event nobody else is on, or a correction made seconds after the original.",
		),
};

export const calendarDeleteEventInputSchema = z.object(calendarDeleteEventInput);
export const calendarDeleteEventSchema = calendarDeleteEventInputSchema;

export type CalendarDeleteEventInput = z.infer<typeof calendarDeleteEventInputSchema>;

export interface CalendarDeleteEventOutput {
	deleted: boolean;
	event: ParsedEvent;
	notify: NotifyAttendees;
	receipt: CalendarReceipt;
}

export interface CalendarDeleteEventPorts {
	calendar: CalendarPort;
	ownerAddresses?: () => Promise<ReadonlySet<string>>;
}

function resolvePorts(ports: CalendarDeleteEventPorts | CalendarPort): CalendarDeleteEventPorts {
	return "calendar" in ports ? ports : { calendar: ports };
}

function requireDeleteDomain(input: {
	domain?: Domain;
	account?: CalendarAccount;
}): Domain {
	const domain = reconcileDomain(input.domain, input.account, "account");
	if (!domain) {
		throw new Error(MISSING_DOMAIN_ERROR);
	}
	return domain;
}

export function formatCalendarDeleteEventMcp(out: CalendarDeleteEventOutput): string {
	const before = out.event;
	const notify = out.notify ?? NOTIFY_DEFAULT;
	return [
		out.deleted
			? `Deleted '${before.summary}' [${before.account}], which was ${
					before.allDay ? `on ${before.start}` : `${before.start} to ${before.end}`
				}.`
			: `'${before.summary}' was already deleted; nothing to do.`,
		out.deleted && before.attendees.length > 1
			? `${before.attendees.length} attendees, notified: ${notify}.`
			: null,
		out.deleted && before.recurringEventId
			? `NOTE: this deleted ONE occurrence of recurring series ${before.recurringEventId}. The rest of the series still exists; delete '${before.recurringEventId}' to cancel all of it.`
			: null,
	]
		.filter((l): l is string => l !== null)
		.join("\n");
}

export function createCalendarDeleteEventAction(ports: CalendarDeleteEventPorts | CalendarPort) {
	const { calendar, ownerAddresses } = resolvePorts(ports);

	return defineAction<typeof calendarDeleteEventInputSchema, CalendarDeleteEventOutput>({
		id: "calendar_delete_event",
		domain: "integrations",
		description: CALENDAR_DELETE_EVENT_DESCRIPTION,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
		schema: calendarDeleteEventInputSchema,
		formatMcp: formatCalendarDeleteEventMcp,
		async needsApproval(input) {
			const domain = requireDeleteDomain(input);
			if (!input.event_id) return true;
			const event = await calendar.getEvent({
				domain,
				calendarId: input.calendar_id ?? "primary",
				eventId: input.event_id,
			});
			const guests = event.attendees.filter((a) => !a.self);
			if (guests.length === 0) return false;
			if (!ownerAddresses) return true;
			const owners = await ownerAddresses();
			return !guests.every((a) => Boolean(a.email) && owners.has(a.email.toLowerCase()));
		},
		async run(input) {
			const domain = requireDeleteDomain(input);
			const calendarId = input.calendar_id ?? "primary";
			const notify: NotifyAttendees = input.notify_attendees ?? NOTIFY_DEFAULT;
			const before = await calendar.getEvent({
				domain,
				calendarId,
				eventId: input.event_id,
			});
			const deleted = await calendar.deleteEvent({
				domain,
				calendarId,
				eventId: input.event_id,
				notify,
				...(input.etag !== undefined ? { etag: input.etag } : {}),
			});
			return {
				deleted,
				event: before,
				notify,
				receipt: {
					account: before?.account ?? (DOMAIN_LEGACY_SCOPE[domain] as CalendarAccount),
					event_ids: [before?.id ?? input.event_id],
					count: deleted ? 1 : 0,
					deleted,
				},
			};
		},
	});
}
