import { DOMAIN_LEGACY_SCOPE, type Domain } from "../../../domain/domains.js";
import type {
	CalendarAccount, CalendarCreateEventParams, CalendarDeleteEventParams, CalendarGetEventParams,
	CalendarListEventsParams, CalendarPort, CalendarRespondToEventParams, CalendarUpdateEventParams,
} from "../../../ports/calendar.js";
import { createGoogleTokenSource, type GoogleTokenSourceConfig } from "../tokenSource.js";
import {
	createCalendarEvent, deleteCalendarEvent, getCalendarEvent,
	listCalendarEvents, listCalendarEventsPage, respondToCalendarEvent, updateCalendarEvent,
} from "./client.js";

export * from "./client.js";

export type GoogleCalendarAdapterConfig = GoogleTokenSourceConfig;

const toAccount = (domain: Domain): CalendarAccount =>
	DOMAIN_LEGACY_SCOPE[domain] as CalendarAccount;

export function createGoogleCalendarAdapter(config: GoogleCalendarAdapterConfig): CalendarPort {
	const tokenSource = createGoogleTokenSource(config);
	const fetchFn = config.fetchFn;

	return {
		listEvents: async ({ domain, calendarId = "primary", timeMin, timeMax, query, maxResults = 25 }: CalendarListEventsParams) =>
			listCalendarEvents(await tokenSource.accessToken(domain), toAccount(domain), { calendarId, timeMin, timeMax, query, maxResults }, fetchFn),
		listEventsPage: async ({ domain, calendarId = "primary", timeMin, timeMax, query, maxResults = 25 }: CalendarListEventsParams) =>
			listCalendarEventsPage(await tokenSource.accessToken(domain), toAccount(domain), { calendarId, timeMin, timeMax, query, maxResults }, fetchFn),
		getEvent: async ({ domain, calendarId = "primary", eventId }: CalendarGetEventParams) =>
			getCalendarEvent(await tokenSource.accessToken(domain), toAccount(domain), calendarId, eventId, fetchFn),
		createEvent: async ({ domain, calendarId = "primary", ...rest }: CalendarCreateEventParams) =>
			createCalendarEvent(await tokenSource.accessToken(domain), { ...rest, calendarId, account: toAccount(domain) }, fetchFn),
		updateEvent: async ({ domain, calendarId = "primary", notify = "all", ...rest }: CalendarUpdateEventParams) =>
			updateCalendarEvent(await tokenSource.accessToken(domain), { ...rest, account: toAccount(domain), calendarId, notify }, fetchFn),
		deleteEvent: async ({ domain, calendarId = "primary", eventId, notify = "all", etag }: CalendarDeleteEventParams) =>
			deleteCalendarEvent(await tokenSource.accessToken(domain), toAccount(domain), calendarId, eventId, notify, fetchFn, etag),
		respondToEvent: async ({ domain, calendarId = "primary", eventId, response, notify = "all", etag }: CalendarRespondToEventParams) =>
			respondToCalendarEvent(await tokenSource.accessToken(domain), toAccount(domain), calendarId, eventId, response, notify, fetchFn, etag),
	};
}
