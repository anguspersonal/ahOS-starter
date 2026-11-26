import { z } from "zod";

// --- dex_list_groups ---

export const dexListGroupsInput = {};

// --- dex_get_group ---

export const dexGetGroupInput = {
	group_id: z.string().uuid().describe("Group ID"),
};

// --- dex_create_group ---

export const dexCreateGroupInput = {
	name: z.string().min(1).max(100).describe("Group name"),
	emoji: z.string().optional().describe("Emoji icon for the group"),
	description: z.string().optional().describe("Group description"),
};

// --- dex_update_group ---

export const dexUpdateGroupInput = {
	group_id: z.string().uuid().describe("Group ID"),
	name: z.string().min(1).max(100).optional().describe("New group name"),
	emoji: z.string().optional().describe("New emoji icon"),
	description: z.string().optional().describe("New description"),
};

// --- dex_delete_group ---

export const dexDeleteGroupInput = {
	group_id: z.string().uuid().describe("Group ID to delete. This action is irreversible."),
};

// --- dex_list_group_contacts ---

export const dexListGroupContactsInput = {
	group_id: z.string().uuid().describe("Group ID"),
	cursor: z.string().optional().describe("Pagination cursor from previous response"),
	limit: z.number().optional().describe("Results per page (default 10)"),
};

// --- dex_add_contacts_to_group ---

export const dexAddContactsToGroupInput = {
	group_id: z.string().uuid().describe("Group ID"),
	contact_ids: z.array(z.string().uuid()).min(1).describe("Contact IDs to add"),
};

// --- dex_remove_contacts_from_group ---

export const dexRemoveContactsFromGroupInput = {
	group_id: z.string().uuid().describe("Group ID"),
	contact_ids: z.array(z.string().uuid()).min(1).describe("Contact IDs to remove"),
};
