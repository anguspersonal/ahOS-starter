import { z } from "zod";

const recurrenceEnum = z.enum(["weekly", "biweekly", "monthly", "quarterly", "biannually", "yearly"]);

// --- dex_create_reminder ---

export const dexCreateReminderInput = {
	due_at_date: z.string().describe("Due date in YYYY-MM-DD format"),
	contact_id: z.string().uuid().optional().describe("Associated contact ID"),
	text: z
		.string()
		.optional()
		.describe("Reminder title/description — there is no separate title field"),
	recurrence: recurrenceEnum.optional().describe("Recurrence frequency"),
};

// --- dex_get_reminder ---

export const dexGetReminderInput = {
	reminder_id: z.string().uuid().describe("Reminder ID"),
};

// --- dex_list_reminders ---

export const dexListRemindersInput = {
	contact_id: z.string().uuid().optional().describe("Filter by contact ID"),
	cursor: z.string().optional().describe("Pagination cursor from previous response"),
	limit: z.number().optional().describe("Results per page (default 10)"),
};

// --- dex_update_reminder ---

export const dexUpdateReminderInput = {
	reminder_id: z.string().uuid().describe("Reminder ID"),
	due_at_date: z.string().optional().describe("New due date in YYYY-MM-DD format"),
	text: z.string().optional().describe("New reminder text"),
	recurrence: recurrenceEnum.optional().describe("New recurrence frequency"),
	is_complete: z.boolean().optional().describe("Mark complete or incomplete"),
};

// --- dex_delete_reminder ---

export const dexDeleteReminderInput = {
	reminder_id: z.string().uuid().describe("Reminder ID to delete. This action is irreversible."),
};
