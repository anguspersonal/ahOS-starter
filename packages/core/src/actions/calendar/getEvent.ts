import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { reconcileDomain } from "../../domain/domains.js";
import type { CalendarPort, CalendarReceipt, ParsedEvent } from "../../ports/calendar.js";
import { defineAction } from "../defineAction.js";

const MISSING_DOMAIN_ERROR =
  "`domain` is required to send — 'work' (the work.example.com Workspace account) or 'angus' (the personal one). There is no default: sending as the wrong identity cannot be taken back.";

export const calendarGetEventInput = {
  domain: optionalDomainInput,
  account: z
    .enum(["personal", "work"])
    .optional()
    .describe("Deprecated, use `domain`. Which account owns the event: personal | work."),
  calendar_id: z.string().optional().describe("Calendar id, default 'primary'."),
  event_id: z.string().min(1).describe("Event id, from calendar_list_events."),
};

export const calendarGetEventInputSchema = z.object(calendarGetEventInput);

export type CalendarGetEventInput = z.infer<typeof calendarGetEventInputSchema>;
export interface CalendarGetEventOutput extends ParsedEvent {
  receipt: CalendarReceipt;
}

export function formatCalendarGetEventMcp(e: ParsedEvent): string {
  const attendeeLines = e.attendees.length
    ? e.attendees.map((a) => `  - ${a.email}${a.self ? " (you)" : ""}: ${a.responseStatus}`)
    : ["  (none)"];
  return [
    `${e.summary} [${e.account}]`,
    e.allDay ? `When: ${e.start} (all day)` : `When: ${e.start} to ${e.end}`,
    e.location ? `Where: ${e.location}` : null,
    `Status: ${e.status}${e.myResponse ? `, your response: ${e.myResponse}` : ""}`,
    e.organizer ? `Organiser: ${e.organizer}` : null,
    e.recurringEventId ? `Part of recurring series ${e.recurringEventId}` : null,
    e.htmlLink ? `Link: ${e.htmlLink}` : null,
    // Printed verbatim: this text is all an MCP caller sees, and a write tool's `etag` takes it as is (#2293).
    e.etag !== undefined ? `ETag: ${e.etag}` : null,
    "Attendees:",
    ...attendeeLines,
    e.description ? `\n${e.description}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

export function createCalendarGetEventAction(port: CalendarPort) {
  return defineAction<typeof calendarGetEventInputSchema, CalendarGetEventOutput>({
    id: "calendar_get_event",
    domain: "integrations",
    description:
      "Read one Google Calendar event in full: attendees and their individual response statuses, your own response, organiser, location, description, recurrence and link. `domain` is required here (unlike calendar_list_events) because an event id belongs to exactly one calendar, and asking the wrong domain returns a 404 that reads like a deleted event.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    schema: calendarGetEventInputSchema,
    formatMcp: formatCalendarGetEventMcp,
    async run(input) {
      const domain = reconcileDomain(input.domain, input.account, "account");
      if (!domain) {
        throw new Error(MISSING_DOMAIN_ERROR);
      }
      const event = await port.getEvent({
        domain,
        calendarId: input.calendar_id ?? "primary",
        eventId: input.event_id,
      });
      return {
        ...event,
        receipt: {
          account: event.account,
          event_ids: [event.id],
          count: 1,
        },
      };
    },
  });
}
