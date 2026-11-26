import type { CalendarPort } from "@ahkms/core";
import { createGoogleCalendarAdapter } from "@ahkms/core/adapters";
import { googleAuthConfig } from "./googleAuth.js";

/** Shared CalendarPort composition for calendar_* tools (ADR-101 §1, ADR-045, #1580). */
export const calendarPort: CalendarPort = createGoogleCalendarAdapter(googleAuthConfig);
