import { z } from "zod";
import {
	dexSearchContactsInput,
	dexListContactsInput,
	dexGetContactInput,
	dexCreateContactInput,
	dexUpdateContactInput,
	dexDeleteContactsInput,
	dexMergeContactsInput,
} from "./contacts.js";
export { dexSearchContactsInput } from "./contacts.js";
import {
	dexListNoteTypesInput,
	dexCreateNoteInput,
	dexGetNoteInput,
	dexUpdateNoteInput,
	dexDeleteNoteInput,
	dexListNotesInput,
} from "./notes.js";
import {
	dexCreateReminderInput,
	dexGetReminderInput,
	dexListRemindersInput,
	dexUpdateReminderInput,
	dexDeleteReminderInput,
} from "./reminders.js";
import {
	dexListTagsInput,
	dexGetTagInput,
	dexCreateTagInput,
	dexUpdateTagInput,
	dexDeleteTagInput,
	dexAddTagsToContactsInput,
	dexRemoveTagsFromContactsInput,
} from "./tags.js";
import {
	dexListGroupsInput,
	dexGetGroupInput,
	dexCreateGroupInput,
	dexUpdateGroupInput,
	dexDeleteGroupInput,
	dexListGroupContactsInput,
	dexAddContactsToGroupInput,
	dexRemoveContactsFromGroupInput,
} from "./groups.js";
import {
	dexListCustomFieldsInput,
	dexCreateCustomFieldInput,
	dexUpdateCustomFieldInput,
	dexDeleteCustomFieldInput,
	dexSetCustomFieldValuesInput,
} from "./custom_fields.js";

/** The four MCP hints, carried per tool so the listing still says which ones destroy. */
export type DexAnnotations = {
	readOnlyHint: boolean;
	destructiveHint: boolean;
	idempotentHint: boolean;
	openWorldHint: boolean;
};

const READ: DexAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const CREATE: DexAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const UPDATE: DexAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const DESTROY: DexAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export type DexToolSpec = {
	name: string;
	description: string;
	/** The zod raw shape the tool was registered with; the single source of its schema. */
	input: z.ZodRawShape;
	annotations: DexAnnotations;
};

function dexTool(name: string, description: string, input: z.ZodRawShape, annotations: DexAnnotations): DexToolSpec {
	return { name, description, input, annotations };
}

/** Every Dex tool, in the order and with the descriptions server.ts registered them. */
export const DEX_TOOLS: readonly DexToolSpec[] = Object.freeze([
	// --- contacts ---
	dexTool(
		"dex_search_contacts",
		"Search Dex contacts by name, email, company, or any keyword. Empty query returns all contacts sorted by most-recent interaction.",
		dexSearchContactsInput,
		READ,
	),
	dexTool(
		"dex_list_contacts",
		"List all Dex contacts with cursor-based pagination. Returns lightweight summaries (id, name, company, job title). Use dex_get_contact for full details.",
		dexListContactsInput,
		READ,
	),
	dexTool(
		"dex_get_contact",
		"Get a single Dex contact by ID with full details: emails, phones, location, tags, groups, custom fields, and optionally recent notes.",
		dexGetContactInput,
		READ,
	),
	dexTool(
		"dex_create_contact",
		"Create one or more Dex contacts. Pass fields directly for a single contact; pass a contacts[] array (max 100) for batch creation.",
		dexCreateContactInput,
		CREATE,
	),
	dexTool(
		"dex_update_contact",
		"Update a Dex contact. Only provided fields are changed. Use add_emails/remove_emails and add_phones/remove_phones to mutate contact details non-destructively.",
		dexUpdateContactInput,
		UPDATE,
	),
	dexTool(
		"dex_delete_contacts",
		"Permanently delete one or more Dex contacts by ID. This action is irreversible.",
		dexDeleteContactsInput,
		DESTROY,
	),
	dexTool(
		"dex_merge_contacts",
		"Merge groups of duplicate Dex contacts. Each group is merged into one record; the first ID in each group becomes the primary.",
		dexMergeContactsInput,
		DESTROY,
	),

	// --- notes ---
	dexTool(
		"dex_list_note_types",
		"List available Dex note types (e.g. Meeting, Call, Coffee, Note). Call this before dex_create_note to pick the most appropriate type.",
		dexListNoteTypesInput,
		READ,
	),
	dexTool(
		"dex_create_note",
		"Create a Dex note and associate it with one or more contacts. Call dex_list_note_types first to get a note_type_id; omitting it defaults to the 'Note' type.",
		dexCreateNoteInput,
		CREATE,
	),
	dexTool("dex_get_note", "Get a single Dex note by ID.", dexGetNoteInput, READ),
	dexTool(
		"dex_update_note",
		"Update the content or event time of an existing Dex note.",
		dexUpdateNoteInput,
		UPDATE,
	),
	dexTool(
		"dex_delete_note",
		"Delete a Dex note by ID. This action is irreversible.",
		dexDeleteNoteInput,
		DESTROY,
	),
	dexTool(
		"dex_list_notes",
		"List Dex notes with optional contact filter and cursor-based pagination.",
		dexListNotesInput,
		READ,
	),

	// --- reminders ---
	dexTool(
		"dex_create_reminder",
		"Create a Dex reminder/task. Optionally associate it with a contact, set a recurrence, and provide a text description.",
		dexCreateReminderInput,
		CREATE,
	),
	dexTool("dex_get_reminder", "Get a single Dex reminder by ID.", dexGetReminderInput, READ),
	dexTool(
		"dex_list_reminders",
		"List Dex reminders with optional contact filter and cursor-based pagination.",
		dexListRemindersInput,
		READ,
	),
	dexTool(
		"dex_update_reminder",
		"Update a Dex reminder's due date, text, recurrence, or completion status.",
		dexUpdateReminderInput,
		UPDATE,
	),
	dexTool(
		"dex_delete_reminder",
		"Delete a Dex reminder by ID. This action is irreversible.",
		dexDeleteReminderInput,
		DESTROY,
	),

	// --- tags ---
	dexTool("dex_list_tags", "List all Dex tags with cursor-based pagination.", dexListTagsInput, READ),
	dexTool("dex_get_tag", "Get a single Dex tag by ID.", dexGetTagInput, READ),
	dexTool("dex_create_tag", "Create a new Dex tag.", dexCreateTagInput, CREATE),
	dexTool("dex_update_tag", "Rename an existing Dex tag.", dexUpdateTagInput, UPDATE),
	dexTool(
		"dex_delete_tag",
		"Delete a Dex tag by ID. This action is irreversible.",
		dexDeleteTagInput,
		DESTROY,
	),
	dexTool(
		"dex_add_tags_to_contacts",
		"Add one or more tags to one or more Dex contacts.",
		dexAddTagsToContactsInput,
		UPDATE,
	),
	dexTool(
		"dex_remove_tags_from_contacts",
		"Remove one or more tags from one or more Dex contacts.",
		dexRemoveTagsFromContactsInput,
		UPDATE,
	),

	// --- groups ---
	dexTool("dex_list_groups", "List all Dex contact groups.", dexListGroupsInput, READ),
	dexTool("dex_get_group", "Get a single Dex group by ID.", dexGetGroupInput, READ),
	dexTool(
		"dex_create_group",
		"Create a new Dex contact group with an optional emoji and description.",
		dexCreateGroupInput,
		CREATE,
	),
	dexTool(
		"dex_update_group",
		"Update a Dex group's name, emoji, or description.",
		dexUpdateGroupInput,
		UPDATE,
	),
	dexTool(
		"dex_delete_group",
		"Delete a Dex group by ID. This action is irreversible.",
		dexDeleteGroupInput,
		DESTROY,
	),
	dexTool(
		"dex_list_group_contacts",
		"List contacts in a Dex group with cursor-based pagination.",
		dexListGroupContactsInput,
		READ,
	),
	dexTool(
		"dex_add_contacts_to_group",
		"Add one or more contacts to a Dex group.",
		dexAddContactsToGroupInput,
		UPDATE,
	),
	dexTool(
		"dex_remove_contacts_from_group",
		"Remove one or more contacts from a Dex group.",
		dexRemoveContactsFromGroupInput,
		UPDATE,
	),

	// --- custom fields ---
	dexTool(
		"dex_list_custom_fields",
		"List all Dex custom field definitions.",
		dexListCustomFieldsInput,
		READ,
	),
	dexTool(
		"dex_create_custom_field",
		"Create a new Dex custom field definition. Types: input (free-text), autocomplete (dropdown), datepicker (date).",
		dexCreateCustomFieldInput,
		CREATE,
	),
	dexTool(
		"dex_update_custom_field",
		"Update a Dex custom field's name, type, or autocomplete options.",
		dexUpdateCustomFieldInput,
		UPDATE,
	),
	dexTool(
		"dex_delete_custom_field",
		"Delete a Dex custom field definition by ID. This action is irreversible.",
		dexDeleteCustomFieldInput,
		DESTROY,
	),
	dexTool(
		"dex_set_custom_field_values",
		"Batch-update custom field values on Dex contacts. Each update targets one contact + one field, with text_value, date_value, or array_value depending on the field type.",
		dexSetCustomFieldValuesInput,
		UPDATE,
	),
]);
