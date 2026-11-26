import { z } from "zod";

// --- dex_list_tags ---

export const dexListTagsInput = {
	cursor: z.string().optional().describe("Pagination cursor from previous response"),
	limit: z.number().optional().describe("Results per page (default 10)"),
};

// --- dex_get_tag ---

export const dexGetTagInput = {
	tag_id: z.string().uuid().describe("Tag ID"),
};

// --- dex_create_tag ---

export const dexCreateTagInput = {
	name: z.string().min(1).describe("Tag name"),
};

// --- dex_update_tag ---

export const dexUpdateTagInput = {
	tag_id: z.string().uuid().describe("Tag ID"),
	name: z.string().min(1).optional().describe("New tag name"),
};

// --- dex_delete_tag ---

export const dexDeleteTagInput = {
	tag_id: z.string().uuid().describe("Tag ID to delete. This action is irreversible."),
};

// --- dex_add_tags_to_contacts ---

export const dexAddTagsToContactsInput = {
	tag_ids: z.array(z.string().uuid()).min(1).describe("Tag IDs to add"),
	contact_ids: z.array(z.string().uuid()).min(1).describe("Contact IDs to tag"),
};

// --- dex_remove_tags_from_contacts ---

export const dexRemoveTagsFromContactsInput = {
	tag_ids: z.array(z.string().uuid()).min(1).describe("Tag IDs to remove"),
	contact_ids: z.array(z.string().uuid()).min(1).describe("Contact IDs to untag"),
};
