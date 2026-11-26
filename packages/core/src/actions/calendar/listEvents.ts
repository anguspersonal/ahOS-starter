import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { DOMAIN_LEGACY_SCOPE, reconcileDomain, type Domain } from "../../domain/domains.js";
import {
	formatEvent,
	type CalendarAccount,
	type CalendarPort,
	type CalendarReceipt,
	type ListEventsPage,
	type ParsedEvent,
} from "../../ports/calendar.js";
import { defineAction } from "../defineAction.js";

/** Seven days, the window a day-planning read wants when it does not say. */
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const CALENDAR_ACCOUNTS = ["personal", "work"] as const satisfies readonly CalendarAccount[];
const DEFAULT_CALENDAR_DOMAINS = ["angus", "work"] as const satisfies readonly Domain[];

export const calendarListEventsInput = {
	account: z
		.enum(CALENDAR_ACCOUNTS)
		.optional()
		.describe(
			`Deprecated, use \`domain\`. Which calendar to read: ${CALENDAR_ACCOUNTS.join(" | ")}. OMIT BOTH to read both, which is the default and usually what you want: "what is on today" spans both calendars, and the commonest bug in this area is answering it from one. Every returned event names the account it came from.`,
		),
	domain: optionalDomainInput,
	calendar_id: z
		.string()
		.optional()
		.describe(
			"Calendar id, default 'primary'. 'primary' resolves per-account to that account's own default calendar, so it means different calendars for personal and work, which is the intended behaviour.",
		),
	time_min: z
		.string()
		.optional()
		.describe("RFC3339 lower bound, e.g. '2026-09-06T00:00:00Z'. Defaults to now."),
	time_max: z
		.string()
		.optional()
		.describe("RFC3339 upper bound. Defaults to seven days after time_min."),
	query: z
		.string()
		.optional()
		.describe("Free-text search over summary, description, location and attendees."),
	max_results: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("Max events PER ACCOUNT (default 25)."),
};

export const calendarListEventsInputSchema = z.object(calendarListEventsInput);

export type CalendarListEventsInput = z.infer<typeof calendarListEventsInputSchema>;

export interface CalendarListEventsOutput {
	events: ParsedEvent[];
	failures: string[];
	truncated_accounts: CalendarAccount[];
	receipt: CalendarReceipt;
	account?: CalendarAccount;
	accountCount: number;
	calendarId: string;
	timeMin: string;
	timeMax: string;
	query?: string;
}

export function formatCalendarListEventsMcp(out: CalendarListEventsOutput): string {
	const scope = out.account ? `the '${out.account}' calendar` : "both calendars";
	const lines = [
		`${out.events.length} event(s) in ${scope} ('${out.calendarId}') from ${out.timeMin} to ${out.timeMax}${
			out.query ? ` matching '${out.query}'` : ""
		}:`,
		"",
		...(out.events.length ? out.events.map((e) => formatEvent(e, { etag: true })) : ["(nothing scheduled)"]),
	];

	if (out.truncated_accounts?.length) {
		lines.push("");
		for (const acct of out.truncated_accounts) {
			const acctEvents = out.events.filter((e) => e.account === acct);
			const lastStart = acctEvents[acctEvents.length - 1]?.start ?? out.timeMax;
			lines.push(`more events in ${acct} after ${lastStart}; narrow the window or raise max_results`);
		}
	}

	if (out.failures.length) {
		lines.push(
			"",
			`COULD NOT READ ${out.failures.length} of ${out.accountCount} calendar(s), so this list is INCOMPLETE:`,
			...out.failures.map((f) => `  - ${f}`),
		);
	}
	if (!out.account && !out.failures.length) {
		lines.push("", "Both calendars read. Each event names its account in brackets.");
	}

	return lines.join("\n");
}

export function createCalendarListEventsAction(port: CalendarPort) {
	return defineAction<typeof calendarListEventsInputSchema, CalendarListEventsOutput>({
		id: "calendar_list_events",
		domain: "integrations",
		description:
			"Read Google Calendar events in a time window, recurring series expanded into instances. Omit " +
			"`account` to read the personal and work calendars together, which is what 'what is on today' " +
			"usually wants; each event names its calendar. If one calendar fails the other still returns, " +
			"marked incomplete. Full notes: docs/guides/tools/calendar_list_events.md",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: calendarListEventsInputSchema,
		formatMcp: formatCalendarListEventsMcp,
		async run(input) {
			const calendarId = input.calendar_id ?? "primary";
			const maxResults = input.max_results ?? 25;
			const timeMin = input.time_min ?? new Date().toISOString();
			const timeMax =
				input.time_max ?? new Date(Date.parse(timeMin) + DEFAULT_WINDOW_MS).toISOString();

			const domain = reconcileDomain(input.domain, input.account, "account");
			const account =
				domain === undefined ? undefined : (DOMAIN_LEGACY_SCOPE[domain] as CalendarAccount);
			const domains: readonly Domain[] = domain ? [domain] : DEFAULT_CALENDAR_DOMAINS;

			const results = await Promise.allSettled(
				domains.map(async (d): Promise<ListEventsPage> => {
					const params = {
						domain: d,
						calendarId,
						timeMin,
						timeMax,
						query: input.query,
						maxResults,
					};
					return port.listEventsPage
						? port.listEventsPage(params)
						: { events: await port.listEvents(params) };
				}),
			);

			const events: ParsedEvent[] = [];
			const failures: string[] = [];
			const truncated_accounts: CalendarAccount[] = [];
			results.forEach((r, i) => {
				const label = DOMAIN_LEGACY_SCOPE[domains[i]] as CalendarAccount;
				if (r.status === "fulfilled") {
					events.push(...r.value.events);
					if (r.value.nextPageToken) {
						truncated_accounts.push(label);
					}
				} else if (
					r.reason instanceof Error &&
					r.reason.name === "AdapterUnavailableError"
				) {
					throw r.reason;
				} else {
					failures.push(
						`${label}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
					);
				}
			});

			events.sort((a, b) => a.start.localeCompare(b.start));

			return {
				events,
				failures,
				truncated_accounts,
				receipt: {
					account: account ?? "both",
					event_ids: events.map((e) => e.id),
					count: events.length,
					truncated_accounts,
				},
				account,
				accountCount: domains.length,
				calendarId,
				timeMin,
				timeMax,
				query: input.query,
			};
		},
	});
}
