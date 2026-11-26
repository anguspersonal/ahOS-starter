import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { DOMAIN_LEGACY_SCOPE, reconcileDomain, type Domain } from "../../domain/domains.js";
import {
	formatMessage,
	SEARCH_METADATA_HEADERS,
	type GmailAccount,
	type GmailPort,
	type ParsedMessage,
} from "../../ports/gmail.js";
import { defineAction } from "../defineAction.js";

export const gmailSearchInput = {
	query: z
		.string()
		.min(1)
		.describe(
			'Gmail search query, in Gmail\'s own syntax — e.g. `from:noreply@example.com subject:"Notes:" newer_than:7d`. Supports from:, to:, subject:, label:, has:, newer_than:, older_than:, is:unread, and OR / -negation.',
		),
	max_results: z
		.number()
		.int()
		.min(1)
		.max(50)
		.optional()
		.describe("Max messages to return (default 10)."),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe("Pagination cursor (next_cursor from a previous gmail_search response)."),
	account: z
		.enum(["personal", "work"])
		.optional()
		.describe(
			"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
		),
	domain: optionalDomainInput,
};

export const gmailSearchInputSchema = z.object(gmailSearchInput);
export const gmailSearchSchema = gmailSearchInputSchema;

export type GmailSearchInput = z.infer<typeof gmailSearchInputSchema>;

export interface GmailSearchReceipt {
	account: GmailAccount;
	message_ids: string[];
	thread_ids: string[];
	count: number;
	has_more: boolean;
}

export interface GmailSearchOutput {
	domain: Domain;
	account: GmailAccount;
	query: string;
	messages: ParsedMessage[];
	next_cursor: string | null;
	receipt: GmailSearchReceipt;
}

export function formatGmailSearchMcp(out: GmailSearchOutput): string {
	if (out.messages.length === 0) {
		return `No messages in the '${out.account}' mailbox for query: ${out.query}`;
	}
	const nextLine = out.next_cursor ? `\nNext cursor: ${out.next_cursor}` : "";
	return `${out.messages.length} message(s) in the '${out.account}' mailbox:\n${out.messages
		.map(formatMessage)
		.join("\n")}${nextLine}\n\nRead one in full with gmail_read (message_id or thread_id).`;
}

export function createGmailSearchAction(port: GmailPort) {
	return defineAction<typeof gmailSearchInputSchema, GmailSearchOutput>({
		id: "gmail_search",
		domain: "integrations",
		description:
			"Search a Gmail mailbox with Gmail's own query syntax (from:, subject:, newer_than:, label:, is:unread). Returns matching messages with ids, subjects, senders and read/archived state. Use domain='work' for the work.example.com mailbox.",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: gmailSearchInputSchema,
		formatMcp: formatGmailSearchMcp,
		async run(input) {
			const domain: Domain = reconcileDomain(input.domain, input.account, "account") ?? "angus";
			const account = DOMAIN_LEGACY_SCOPE[domain] as GmailAccount;
			const maxResults = input.max_results ?? 10;
			const page = port.searchMessagesPage
				? await port.searchMessagesPage({
						domain,
						query: input.query,
						maxResults,
						cursor: input.cursor,
						format: "metadata",
						metadataHeaders: SEARCH_METADATA_HEADERS,
					})
				: {
						messages: await port.searchMessages({
							domain,
							query: input.query,
							maxResults,
						}),
						nextCursor: null,
					};
			const messages = page.messages;
			const next_cursor = page.nextCursor;
			return {
				domain,
				account,
				query: input.query,
				messages,
				next_cursor,
				receipt: {
					account,
					message_ids: messages.map((m) => m.id),
					thread_ids: [...new Set(messages.map((m) => m.threadId))],
					count: messages.length,
					has_more: next_cursor !== null,
				},
			};
		},
	});
}
