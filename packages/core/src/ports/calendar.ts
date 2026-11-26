import type { Domain } from "../domain/domains.js";

export type CalendarAccount = "personal" | "work";

export const EVENT_FIELDS =
	"id,etag,summary,description,location,status,htmlLink,recurringEventId,start,end,organizer(email),attendees(email,responseStatus,self)";
export const LIST_EVENTS_FIELDS = `nextPageToken,items(${EVENT_FIELDS})`;

export class CalendarApiError extends Error {
	readonly status: number;
	readonly reason?: string;
	readonly googleStatus?: string;
	constructor(message: string, status: number, reason?: string, googleStatus?: string) {
		super(message);
		this.name = "CalendarApiError";
		this.status = status;
		this.reason = reason;
		this.googleStatus = googleStatus;
	}
}

export type CalendarEventTime = { dateTime: string } | { date: string };
export type CreateCalendarEventInput = {
	calendarId: string; summary: string; description?: string; location?: string;
	start: CalendarEventTime; end: CalendarEventTime; attendees?: string[]; account?: CalendarAccount;
};
export type CreatedCalendarEvent = { id: string; htmlLink: string };
export type ParsedEvent = {
	id: string; etag?: string; summary: string; start: string; end: string; allDay: boolean;
	location: string; description: string; organizer: string;
	attendees: { email: string; responseStatus: string; self: boolean }[];
	myResponse: string; status: string; htmlLink: string; recurringEventId: string; account: CalendarAccount;
};
export type ListEventsOptions = {
	calendarId: string; timeMin?: string; timeMax?: string; query?: string; maxResults: number;
};
export type ListEventsPage = { events: ParsedEvent[]; nextPageToken?: string };
export type CalendarReceipt = {
	account: CalendarAccount | "both";
	event_ids: string[];
	count: number;
	truncated_accounts?: CalendarAccount[];
	changed_count?: number;
	deleted?: boolean;
	response?: string;
};
export type NotifyAttendees = "all" | "externalOnly" | "none";
export type UpdateCalendarEventInput = {
	account: CalendarAccount; calendarId: string; eventId: string;
	summary?: string; description?: string; location?: string;
	start?: CalendarEventTime; end?: CalendarEventTime; notify: NotifyAttendees; etag?: string;
};
export type RsvpResponse = "accepted" | "declined" | "tentative";

export interface CalendarListEventsParams {
	domain: Domain; calendarId?: string; timeMin?: string; timeMax?: string; query?: string; maxResults?: number;
}
export interface CalendarGetEventParams { domain: Domain; calendarId?: string; eventId: string }
export interface CalendarCreateEventParams {
	domain: Domain; calendarId?: string; summary: string; description?: string; location?: string;
	start: CalendarEventTime; end: CalendarEventTime; attendees?: string[];
}
export interface CalendarUpdateEventParams {
	domain: Domain; calendarId?: string; eventId: string; summary?: string; description?: string;
	location?: string; start?: CalendarEventTime; end?: CalendarEventTime; notify?: NotifyAttendees; etag?: string;
}
export interface CalendarDeleteEventParams {
	domain: Domain; calendarId?: string; eventId: string; notify?: NotifyAttendees; etag?: string;
}
export interface CalendarRespondToEventParams {
	domain: Domain; calendarId?: string; eventId: string; response: RsvpResponse; notify?: NotifyAttendees; etag?: string;
}

export interface CalendarPort {
	listEvents(params: CalendarListEventsParams): Promise<ParsedEvent[]>;
	listEventsPage?(params: CalendarListEventsParams): Promise<ListEventsPage>;
	getEvent(params: CalendarGetEventParams): Promise<ParsedEvent>;
	createEvent(params: CalendarCreateEventParams): Promise<CreatedCalendarEvent>;
	updateEvent(params: CalendarUpdateEventParams): Promise<ParsedEvent>;
	deleteEvent(params: CalendarDeleteEventParams): Promise<boolean>;
	respondToEvent(params: CalendarRespondToEventParams): Promise<ParsedEvent>;
}

/**
 * `opts.etag` appends the event's ETag, which is how a text-only caller gets a value to
 * pass back as `etag` on a write (#2293). Off by default so write replies stay as they were.
 */
export function formatEvent(e: ParsedEvent, opts?: { etag?: boolean }): string {
	const when = e.allDay ? `${e.start} (all day)` : `${e.start} to ${e.end}`;
	const bits = [
		e.location ? `at ${e.location}` : null,
		e.myResponse && e.myResponse !== "accepted" ? e.myResponse : null,
		e.status === "cancelled" ? "CANCELLED" : null,
		e.attendees.length > 1 ? `${e.attendees.length} attendees` : null,
	].filter(Boolean);
	const etag = opts?.etag && e.etag !== undefined ? ` etag=${e.etag}` : "";
	return `• [${e.id}] ${when} — ${e.summary} [${e.account}]${bits.length ? ` (${bits.join(", ")})` : ""}${etag}`;
}
