import {
	CALENDAR_SCOPE, CalendarApiError, EVENT_FIELDS, LIST_EVENTS_FIELDS,
	deleteCalendarEvent as coreDeleteCalendarEvent,
	formatEvent,
	getCalendarEvent as coreGetCalendarEvent,
	listCalendarEvents as coreListCalendarEvents,
	parseEvent,
	respondToCalendarEvent as coreRespondToCalendarEvent,
	updateCalendarEvent as coreUpdateCalendarEvent,
	type CalendarEventTime, type CreateCalendarEventInput, type CreatedCalendarEvent,
	type ListEventsOptions, type NotifyAttendees, type ParsedEvent,
	type RsvpResponse, type UpdateCalendarEventInput,
} from "@ahkms/core/adapters";
import { DEFAULT_GOOGLE_ACCOUNT, type GoogleAccount } from "./accounts.js";
import { getGoogleAccessToken } from "./oauth.js";

export {
	CALENDAR_SCOPE, CalendarApiError, EVENT_FIELDS, LIST_EVENTS_FIELDS, formatEvent, parseEvent,
	type CalendarEventTime, type CreateCalendarEventInput, type CreatedCalendarEvent,
	type ListEventsOptions, type NotifyAttendees, type ParsedEvent,
	type RsvpResponse, type UpdateCalendarEventInput,
};

export async function getCalendarAccessToken(
	account: GoogleAccount = DEFAULT_GOOGLE_ACCOUNT,
): Promise<string> {
	return getGoogleAccessToken(account);
}

export async function listCalendarEvents(
	account: GoogleAccount,
	opts: ListEventsOptions,
): Promise<ParsedEvent[]> {
	return coreListCalendarEvents(await getCalendarAccessToken(account), account, opts);
}

export async function getCalendarEvent(
	account: GoogleAccount,
	calendarId: string,
	eventId: string,
): Promise<ParsedEvent> {
	return coreGetCalendarEvent(await getCalendarAccessToken(account), account, calendarId, eventId);
}

export async function updateCalendarEvent(
	input: UpdateCalendarEventInput,
): Promise<ParsedEvent> {
	return coreUpdateCalendarEvent(await getCalendarAccessToken(input.account), input);
}

export async function deleteCalendarEvent(
	account: GoogleAccount,
	calendarId: string,
	eventId: string,
	notify: NotifyAttendees,
): Promise<boolean> {
	return coreDeleteCalendarEvent(await getCalendarAccessToken(account), account, calendarId, eventId, notify);
}

export async function respondToCalendarEvent(
	account: GoogleAccount,
	calendarId: string,
	eventId: string,
	response: RsvpResponse,
	notify: NotifyAttendees,
): Promise<ParsedEvent> {
	return coreRespondToCalendarEvent(await getCalendarAccessToken(account), account, calendarId, eventId, response, notify);
}
