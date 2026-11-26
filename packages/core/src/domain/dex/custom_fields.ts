import { z } from "zod";

const fieldTypeEnum = z.enum(["input", "autocomplete", "datepicker"]);

// --- dex_list_custom_fields ---

export const dexListCustomFieldsInput = {};

// --- dex_create_custom_field ---

export const dexCreateCustomFieldInput = {
	name: z.string().min(1).max(100).describe("Field name"),
	field_type: fieldTypeEnum.describe(
		"Field type: input (free-text), autocomplete (dropdown with suggestions), datepicker (date picker)",
	),
	categories: z
		.array(z.string().min(1).max(100))
		.optional()
		.describe("Autocomplete options — only for autocomplete type"),
};

// --- dex_update_custom_field ---

export const dexUpdateCustomFieldInput = {
	custom_field_id: z.string().uuid().describe("Custom field ID"),
	name: z.string().min(1).max(100).optional().describe("New field name"),
	field_type: fieldTypeEnum.optional().describe("New field type"),
	categories: z.array(z.string().min(1).max(100)).optional().describe("New autocomplete options"),
};

// --- dex_delete_custom_field ---

export const dexDeleteCustomFieldInput = {
	custom_field_id: z
		.string()
		.uuid()
		.describe("Custom field ID to delete. This action is irreversible."),
};

// --- dex_set_custom_field_values ---

export const dexSetCustomFieldValuesInput = {
	updates: z
		.array(
			z.object({
				contact_id: z.string().uuid().describe("Contact ID"),
				custom_field_id: z.string().uuid().describe("Custom field ID"),
				text_value: z.string().optional().describe("Value for text/autocomplete fields"),
				date_value: z.string().optional().describe("Value for date fields (YYYY-MM-DD)"),
				array_value: z.array(z.string()).optional().describe("Value for multi-select fields"),
			}),
		)
		.min(1)
		.describe("Batch custom field updates across contacts"),
};
