import { z } from "zod";

// --- dex_list_note_types ---

export const dexListNoteTypesInput = {};

// --- dex_create_note ---

export const dexCreateNoteInput = {
	content: z.string().describe("Note content/body"),
	contact_id: z.string().uuid().optional().describe("Associate note to a single contact"),
	contact_ids: z
		.array(z.string().uuid())
		.optional()
		.describe("Associate note to multiple contacts. Can be combined with contact_id."),
	note_type_id: z
		.string()
		.uuid()
		.optional()
		.describe("Note type ID from dex_list_note_types. Falls back to 'Note' type if omitted."),
	event_time: z
		.string()
		.optional()
		.describe("ISO 8601 datetime for when the event occurred. Defaults to now if omitted."),
};

// --- dex_get_note ---

export const dexGetNoteInput = {
	note_id: z.string().uuid().describe("Note ID"),
};

// --- dex_update_note ---

export const dexUpdateNoteInput = {
	note_id: z.string().uuid().describe("Note ID"),
	content: z.string().optional().describe("New note content"),
	event_time: z.string().optional().describe("New ISO 8601 datetime for when the event occurred"),
};

// --- dex_delete_note ---

export const dexDeleteNoteInput = {
	note_id: z.string().uuid().describe("Note ID to delete. This action is irreversible."),
};

// --- dex_list_notes ---

export const dexListNotesInput = {
	contact_id: z.string().uuid().optional().describe("Filter by contact ID"),
	cursor: z.string().optional().describe("Pagination cursor from previous response"),
	limit: z.number().optional().describe("Results per page (default 10)"),
};
