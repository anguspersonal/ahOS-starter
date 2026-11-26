import { ExternalItemCreatedButUnreadable } from "../../../actions/outwardWrite.js";
import {
	CalendarApiError, EVENT_FIELDS, LIST_EVENTS_FIELDS, formatEvent,
	type CalendarAccount as GoogleAccount, type CalendarEventTime, type CreateCalendarEventInput,
	type CreatedCalendarEvent, type ListEventsOptions, type ListEventsPage, type NotifyAttendees,
	type ParsedEvent, type RsvpResponse, type UpdateCalendarEventInput,
} from "../../../ports/calendar.js";

export {
	CalendarApiError, EVENT_FIELDS, LIST_EVENTS_FIELDS, formatEvent,
	type GoogleAccount as CalendarAccount, type CalendarEventTime, type CreateCalendarEventInput,
	type CreatedCalendarEvent, type ListEventsOptions, type ListEventsPage, type NotifyAttendees,
	type ParsedEvent, type RsvpResponse, type UpdateCalendarEventInput,
};

export const ETAG_CONFLICT_MESSAGE =
	"the event changed since you read it; re-read with calendar_get_event";

// Thin Google Calendar REST client (mirrors notion.ts's raw-fetch posture — no SDK
// dependency for the request itself, so tests can stub global fetch exactly like
// notion.test.ts). Mint an access token from the stored refresh token, then create
// events (#126) and read them back (the read half, which #126 never built).
//
// Reads matter more than their late arrival suggests. `prep`, `morning` and `dos` all
// need "what is on today", and until the read half existed here every one of them got
// it from whichever Calendar connector a given chat happened to be carrying. That is
// the same shape as the Notion failure #989 fixed: a read whose answer depends on the
// session's ambient wiring rather than on an argument, which fails by returning a
// confident answer about the wrong account.
//
// Scope note (issues #126, #338): this scope is one of the set in google/scopes.ts,
// which is minted in a single consent per account. A refresh token is scope-bound at
// mint time, so a token minted before a scope joined that list will be accepted by
// Google and then rejected by the Calendar API for lack of scope. The fix is always a
// re-consent (google-auth), never a code change. This file is fully unit-testable
// behind mocks regardless (see __tests__/calendar.test.ts).
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

function calendarError(message: string, status: number, detail: string): CalendarApiError {
	let reason: string | undefined;
	let googleStatus: string | undefined;
	try {
		const err = (JSON.parse(detail) as { error?: { reason?: string; status?: string; errors?: { reason?: string }[] } }).error;
		reason = err?.errors?.[0]?.reason ?? err?.reason;
		googleStatus = err?.status;
	} catch { /* non-JSON error body */ }
	return new CalendarApiError(message, status, reason, googleStatus);
}

/**
 * Create one event in `calendarId` via `POST /calendars/{calendarId}/events`. Callers
 * (createEvent.ts) resolve the caller-supplied ISO string(s) into the timed-vs-all-day
 * `start`/`end` shape before calling this — this function just maps to the Calendar
 * API's wire shape and posts it, mirroring createNotionTask's "build body, POST, throw
 * on !ok" shape in notion.ts.
 */
export async function createCalendarEvent(
	token: string,
	input: CreateCalendarEventInput,
	fetchFn: typeof fetch = fetch,
): Promise<CreatedCalendarEvent> {
	const body: Record<string, unknown> = {
		summary: input.summary,
		start: input.start,
		end: input.end,
	};
	if (input.description) body.description = input.description;
	if (input.location) body.location = input.location;
	if (input.attendees && input.attendees.length > 0) {
		body.attendees = input.attendees.map((email) => ({ email }));
	}

	const res = await fetchFn(
		`${CALENDAR_API}/calendars/${encodeURIComponent(input.calendarId)}/events`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		},
	);

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		const acct = input.account ? ` for account '${input.account}'` : "";
		throw calendarError(
			`Calendar create event failed${acct} (${res.status}): ${detail || res.statusText}`,
			res.status,
			detail,
		);
	}

	// Past this point Calendar has ACCEPTED the create — the event exists. An unreadable
	// body loses the event's id, not the event, and must not look like a failed write:
	// event_create releases its dedup claim on that signal, and releasing for an event that
	// DOES exist lets the retry create a second one (issue #653; see outwardWrite.ts).
	let json: { id: string; htmlLink?: string };
	try {
		json = (await res.json()) as { id: string; htmlLink?: string };
	} catch (cause) {
		throw new ExternalItemCreatedButUnreadable("A Calendar event", cause);
	}
	return { id: json.id, htmlLink: json.htmlLink ?? "" };
}

// ---- reading -----------------------------------------------------------------

type EventWire = {
	id?: string;
	etag?: string;
	summary?: string;
	description?: string;
	location?: string;
	status?: string;
	htmlLink?: string;
	recurringEventId?: string;
	start?: { dateTime?: string; date?: string };
	end?: { dateTime?: string; date?: string };
	organizer?: { email?: string };
	attendees?: { email?: string; responseStatus?: string; self?: boolean }[];
};

export function parseEvent(e: EventWire, account: GoogleAccount): ParsedEvent {
	const attendees = (e.attendees ?? []).map((a) => ({
		email: a.email ?? "",
		responseStatus: a.responseStatus ?? "needsAction",
		self: a.self === true,
	}));
	return {
		id: e.id ?? "",
		...(e.etag !== undefined ? { etag: e.etag } : {}),
		summary: e.summary ?? "(no title)",
		start: e.start?.dateTime ?? e.start?.date ?? "",
		end: e.end?.dateTime ?? e.end?.date ?? "",
		// `date` rather than `dateTime` is the API's own all-day marker.
		allDay: Boolean(e.start?.date),
		location: e.location ?? "",
		description: e.description ?? "",
		organizer: e.organizer?.email ?? "",
		attendees,
		myResponse: attendees.find((a) => a.self)?.responseStatus ?? "",
		status: e.status ?? "confirmed",
		htmlLink: e.htmlLink ?? "",
		recurringEventId: e.recurringEventId ?? "",
		account,
	};
}

const MAX_READ_RETRIES = 2;
const READ_RETRY_BASE_MS = 50;

function isRetryableReadError(err: CalendarApiError): boolean {
	if (err.status === 429) return true;
	if (err.status >= 500 && err.status < 600) return true;
	return err.status === 403 && err.reason === "rateLimitExceeded";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function calendarFetch<T>(
	token: string,
	account: GoogleAccount,
	path: string,
	fetchFn: typeof fetch = fetch,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		const res = await fetchFn(`${CALENDAR_API}${path}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (res.ok) return (await res.json()) as T;

		const detail = await res.text().catch(() => "");
		// The account is named because the commonest failure is a correct call against
		// the wrong calendar, which Google reports as a bare 404.
		const err = calendarError(
			`Calendar GET ${path} failed for account '${account}' (${res.status}): ${detail || res.statusText}`,
			res.status,
			detail,
		);
		if (attempt < MAX_READ_RETRIES && isRetryableReadError(err)) {
			await sleep(READ_RETRY_BASE_MS * 2 ** attempt);
			continue;
		}
		throw err;
	}
}

/**
 * Events in a window, with recurring series expanded into instances, plus `nextPageToken`
 * when Google truncated the page at `maxResults`.
 */
export async function listCalendarEventsPage(
	token: string,
	account: GoogleAccount,
	opts: ListEventsOptions,
	fetchFn: typeof fetch = fetch,
): Promise<ListEventsPage> {
	const params = new URLSearchParams({
		singleEvents: "true",
		orderBy: "startTime",
		maxResults: String(opts.maxResults),
		fields: LIST_EVENTS_FIELDS,
	});
	if (opts.timeMin) params.set("timeMin", opts.timeMin);
	if (opts.timeMax) params.set("timeMax", opts.timeMax);
	if (opts.query) params.set("q", opts.query);

	const res = await calendarFetch<{ items?: EventWire[]; nextPageToken?: string }>(
		token,
		account,
		`/calendars/${encodeURIComponent(opts.calendarId)}/events?${params}`,
		fetchFn,
	);
	return {
		events: (res.items ?? []).map((e) => parseEvent(e, account)),
		...(res.nextPageToken ? { nextPageToken: res.nextPageToken } : {}),
	};
}

/**
 * Events in a window, with recurring series expanded into instances.
 *
 * `singleEvents=true` is not optional for a day view: without it a weekly standup comes
 * back once, as the series definition with its original start date, and never appears on
 * the day it actually falls on. It is also what makes `orderBy=startTime` legal, so the
 * two travel together.
 */
export async function listCalendarEvents(
	token: string,
	account: GoogleAccount,
	opts: ListEventsOptions,
	fetchFn: typeof fetch = fetch,
): Promise<ParsedEvent[]> {
	return (await listCalendarEventsPage(token, account, opts, fetchFn)).events;
}

export async function getCalendarEvent(
	token: string,
	account: GoogleAccount,
	calendarId: string,
	eventId: string,
	fetchFn: typeof fetch = fetch,
): Promise<ParsedEvent> {
	const params = new URLSearchParams({ fields: EVENT_FIELDS });
	const res = await calendarFetch<EventWire>(
		token,
		account,
		`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?${params}`,
		fetchFn,
	);
	return parseEvent(res, account);
}

// ---- writing -----------------------------------------------------------------

/**
 * The outcome of a write. `gone` is kept separate from a null body because the two mean
 * different things to a caller and collapsing them loses the distinction that matters:
 * a DELETE answers 204 with no body when it removed something, and 410 with no body when
 * there was nothing left to remove. "I deleted it" and "it was already gone" are both
 * fine outcomes and only one of them is a deletion.
 */
type CalendarWriteResult<T> = { gone: boolean; body: T | null };

async function calendarWrite<T>(
	token: string,
	account: GoogleAccount,
	method: "PATCH" | "DELETE",
	path: string,
	body?: unknown,
	fetchFn: typeof fetch = fetch,
	etag?: string,
): Promise<CalendarWriteResult<T>> {
	const res = await fetchFn(`${CALENDAR_API}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
			...(etag === undefined ? {} : { "If-Match": etag }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

	// 410 Gone is Calendar's "this was already deleted". Not an error: for a DELETE it is
	// the state the caller asked for, so a retried delete must not read as a failure.
	if (res.status === 410) return { gone: true, body: null };

	if (res.status === 412) {
		throw new CalendarApiError(
			ETAG_CONFLICT_MESSAGE,
			412,
			"conditionNotMet",
			"FAILED_PRECONDITION",
		);
	}

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		// The account is named for the same reason the read path names it: the commonest
		// failure here is a correct call against the wrong calendar, which Google answers
		// with a bare 404 that reads like a deleted event.
		throw calendarError(
			`Calendar ${method} ${path} failed for account '${account}' (${res.status}): ${detail || res.statusText}`,
			res.status,
			detail,
		);
	}

	// DELETE answers 204 with no body; PATCH answers 200 with the updated event.
	if (res.status === 204) return { gone: false, body: null };
	return { gone: false, body: (await res.json()) as T };
}

/**
 * PATCH one event, sending only the fields the caller named.
 *
 * PATCH rather than PUT deliberately: PUT replaces the resource, so a caller changing
 * only the title would silently drop the description, the location and every attendee.
 *
 * `attendees` is deliberately NOT updatable here. The Calendar API treats the attendee
 * list as a single whole value, so patching it with anything short of the complete list
 * removes the people left out, which puts "change the time" one field away from
 * "uninvite everyone". Adding or removing attendees is a separate job that has to read
 * the current list first; respondToCalendarEvent below does exactly that read, for the
 * one attendee it is allowed to touch.
 */
export async function updateCalendarEvent(
	token: string,
	input: UpdateCalendarEventInput,
	fetchFn: typeof fetch = fetch,
): Promise<ParsedEvent> {
	const body: Record<string, unknown> = {};
	if (input.summary !== undefined) body.summary = input.summary;
	if (input.description !== undefined) body.description = input.description;
	if (input.location !== undefined) body.location = input.location;
	if (input.start !== undefined) body.start = input.start;
	if (input.end !== undefined) body.end = input.end;

	// An empty PATCH would succeed against Google and change nothing, so the caller
	// would be told the event was updated when it was not.
	if (Object.keys(body).length === 0) {
		throw new Error(
			"Calendar update: nothing to change. Pass at least one of summary, description, location, start or end.",
		);
	}

	const params = new URLSearchParams({ sendUpdates: input.notify });
	const { gone, body: updated } = await calendarWrite<EventWire>(
		token,
		input.account,
		"PATCH",
		`/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}?${params}`,
		body,
		fetchFn,
		input.etag,
	);
	if (gone || !updated) {
		throw new Error(
			`Calendar update: event '${input.eventId}' is already deleted, so there is nothing to update.`,
		);
	}
	return parseEvent(updated, input.account);
}

/**
 * DELETE one event. Returns false when it was already gone (410), true when this call
 * removed it, so the caller can say which happened rather than claiming a deletion it
 * did not perform.
 */
export async function deleteCalendarEvent(
	token: string,
	account: GoogleAccount,
	calendarId: string,
	eventId: string,
	notify: NotifyAttendees,
	fetchFn: typeof fetch = fetch,
	etag?: string,
): Promise<boolean> {
	const params = new URLSearchParams({ sendUpdates: notify });
	const { gone } = await calendarWrite(
		token,
		account,
		"DELETE",
		`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?${params}`,
		undefined,
		fetchFn,
		etag,
	);
	return !gone;
}

/**
 * RSVP to an event, by patching only the owner's own entry in the attendee list.
 *
 * This is the one place the attendee list has to be written, and it is a trap. Calendar
 * treats `attendees` as a whole value: PATCHing it with just the owner's entry removes
 * every other attendee from the event. So the current list is read first, the owner's
 * own entry is modified in place, and the COMPLETE list goes back. The read is not an
 * optimisation, it is the only correct way to do this at all.
 *
 * Not being on the attendee list is a real state with a real cause, usually that the
 * owner is the organiser, and it fails loudly rather than silently patching nothing:
 * an RSVP that reports success while changing nothing is worse than an error.
 */
export async function respondToCalendarEvent(
	token: string,
	account: GoogleAccount,
	calendarId: string,
	eventId: string,
	response: RsvpResponse,
	notify: NotifyAttendees,
	fetchFn: typeof fetch = fetch,
	etag?: string,
): Promise<ParsedEvent> {
	const readParams = new URLSearchParams({ fields: EVENT_FIELDS });
	const current = await calendarFetch<EventWire>(
		token,
		account,
		`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?${readParams}`,
		fetchFn,
	);

	const attendees = current.attendees ?? [];
	const me = attendees.find((a) => a.self === true);
	if (!me) {
		const who = current.organizer?.email;
		throw new Error(
			`Cannot RSVP to event '${eventId}' on the '${account}' calendar: you are not on its attendee list, so there is no response to set.${
				who ? ` It is organised by ${who}.` : ""
			} An event you created yourself has no RSVP; delete it to decline it.`,
		);
	}

	// The whole list goes back, with one entry changed. Sending only `me` would remove
	// everybody else from the event.
	const patched = attendees.map((a) =>
		a.self === true ? { ...a, responseStatus: response } : a,
	);

	const params = new URLSearchParams({ sendUpdates: notify });
	const { gone, body: updated } = await calendarWrite<EventWire>(
		token,
		account,
		"PATCH",
		`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?${params}`,
		{ attendees: patched },
		fetchFn,
		etag,
	);
	if (gone || !updated) {
		throw new Error(
			`Calendar RSVP: event '${eventId}' is already deleted, so there is nothing to respond to.`,
		);
	}
	return parseEvent(updated, account);
}
