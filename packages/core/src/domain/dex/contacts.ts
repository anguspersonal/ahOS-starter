import { z } from "zod";

const emailSchema = z.object({
	email: z.string().describe("Email address"),
	label: z.string().optional().describe("Label e.g. Work, Personal"),
});

const phoneSchema = z.object({
	phone_number: z.string().describe("Phone number"),
	country_code: z
		.string()
		.optional()
		.describe("Dial code without + prefix e.g. 1, 44"),
	label: z.string().optional().describe("Label e.g. Mobile, Work"),
});

// --- dex_search_contacts ---

export const dexSearchContactsInput = {
	query: z
		.string()
		.describe("Name, email, company, or keyword. Empty string = list all by most-recent interaction."),
	limit: z.number().optional().describe("Max results (default 50, max 200)"),
};

// --- dex_list_contacts ---

export const dexListContactsInput = {
	cursor: z.string().optional().describe("Pagination cursor from previous response"),
	limit: z.number().optional().describe("Results per page (default 100, max 500)"),
};

// --- dex_get_contact ---

export const dexGetContactInput = {
	id: z.string().describe("Contact ID"),
	include_notes: z
		.boolean()
		.optional()
		.describe("Include recent notes/timeline items (default false)"),
};

// --- dex_create_contact ---

export const dexCreateContactInput = {
	first_name: z.string().optional().describe("First name"),
	last_name: z.string().optional().describe("Last name"),
	email: z.string().optional().describe("Primary email (shorthand for a single email)"),
	phone: z.string().optional().describe("Primary phone (shorthand for a single phone)"),
	company: z.string().optional().describe("Company name"),
	job_title: z.string().optional().describe("Job title"),
	description: z.string().optional().describe("Notes about the contact"),
	birthday: z.string().optional().describe("Birthday (YYYY-MM-DD)"),
	linkedin: z.string().optional().describe("LinkedIn profile URL"),
	twitter: z.string().optional().describe("Twitter/X handle"),
	website: z.string().optional().describe("Website URL"),
	emails: z.array(emailSchema).optional().describe("Multiple email addresses"),
	phones: z.array(phoneSchema).optional().describe("Multiple phone numbers"),
	contacts: z
		.array(
			z.object({
				first_name: z.string().optional(),
				last_name: z.string().optional(),
				email: z.string().optional(),
				phone: z.string().optional(),
				company: z.string().optional(),
				job_title: z.string().optional(),
				description: z.string().optional(),
				birthday: z.string().optional(),
				linkedin: z.string().optional(),
				twitter: z.string().optional(),
				website: z.string().optional(),
				emails: z.array(emailSchema).optional(),
				phones: z.array(phoneSchema).optional(),
			}),
		)
		.max(100)
		.optional()
		.describe("Batch create up to 100 contacts. When provided, top-level fields are ignored."),
};

// --- dex_update_contact ---

export const dexUpdateContactInput = {
	id: z.string().describe("Contact ID to update"),
	first_name: z.string().optional(),
	last_name: z.string().optional(),
	company: z.string().optional(),
	job_title: z.string().optional(),
	description: z.string().optional(),
	birthday: z.string().optional().describe("YYYY-MM-DD"),
	linkedin: z.string().optional(),
	twitter: z.string().optional(),
	website: z.string().optional(),
	email: z.string().optional().describe("Add a single email (shorthand for add_emails)"),
	phone: z.string().optional().describe("Add a single phone (shorthand for add_phones)"),
	add_emails: z.array(emailSchema).optional().describe("Email addresses to add"),
	remove_emails: z.array(z.string()).optional().describe("Email addresses to remove"),
	add_phones: z.array(phoneSchema).optional().describe("Phone numbers to add"),
	remove_phones: z.array(z.string()).optional().describe("Phone numbers to remove"),
	is_archived: z.boolean().optional().describe("Archive or unarchive the contact"),
	starred: z.boolean().optional().describe("Star or unstar the contact"),
};

// --- dex_delete_contacts ---

export const dexDeleteContactsInput = {
	contact_ids: z
		.array(z.string())
		.min(1)
		.describe("Contact IDs to delete. This action is irreversible."),
};

// --- dex_merge_contacts ---

export const dexMergeContactsInput = {
	contact_id_groups: z
		.array(z.array(z.string()).min(2))
		.min(1)
		.describe(
			"Groups of contact IDs to merge. Each group is merged into one; the first ID in each group becomes the primary.",
		),
};
