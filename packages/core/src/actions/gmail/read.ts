import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { DOMAIN_LEGACY_SCOPE, reconcileDomain, type Domain } from "../../domain/domains.js";
import {
	parseMessage,
	type GmailAccount,
	type GmailPort,
	type ParsedMessage,
} from "../../ports/gmail.js";
import { defineAction } from "../defineAction.js";

export const gmailReadInput = {
	message_id: z
		.string()
		.optional()
		.describe("Message id to read in full. Exactly one of message_id / thread_id."),
	thread_id: z
		.string()
		.optional()
		.describe(
			"Thread id to read in full — returns every message in the thread, oldest first.",
		),
	max_chars: z
		.number()
		.int()
		.min(100)
		.max(200_000)
		.optional()
		.describe("Truncate each message body to this many characters (default 20000)."),
	max_messages: z
		.number()
		.int()
		.min(1)
		.max(200)
		.optional()
		.describe("Max messages to return when reading a thread (newest N, default 25)."),
	account: z
		.enum(["personal", "work"])
		.optional()
		.describe(
			"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
		),
	domain: optionalDomainInput,
};

export const gmailReadInputSchema = z.object(gmailReadInput);
export const gmailReadSchema = gmailReadInputSchema;

export type GmailReadInput = z.infer<typeof gmailReadInputSchema>;

export interface GmailReadReceipt {
	account: GmailAccount;
	message_ids: string[];
	thread_ids: string[];
	count: number;
	total_count: number;
}

export interface GmailReadOutput {
	domain: Domain;
	account: GmailAccount;
	maxChars: number;
	totalMessages?: number;
	messages: ParsedMessage[];
	receipt: GmailReadReceipt;
}

export function renderGmailMessage(m: ParsedMessage, limit: number): string {
	const body =
		m.body.length > limit
			? `${m.body.slice(0, limit)}\n… [truncated at ${limit} chars of ${m.body.length}]`
			: m.body;
	const lines = [
		`id: ${m.id}  thread: ${m.threadId}`,
		`From: ${m.from}`,
		`To: ${m.to}`,
		`Date: ${m.date}`,
		`Subject: ${m.subject}`,
		`Labels: ${m.labelIds.join(", ") || "(none)"}`,
		m.attachments.length
			? `Attachments: ${m.attachments
					.map(
						(a) =>
							`${a.filename} (${a.mimeType}, ${a.size}B${a.attachmentId ? `, id: ${a.attachmentId}` : ""})`,
					)
					.join(", ")}`
			: null,
		"",
		body || "(no readable body)",
	].filter((l): l is string => l !== null);
	return lines.join("\n");
}

export function formatGmailReadMcp(out: GmailReadOutput): string {
	const body = out.messages.map((m) => renderGmailMessage(m, out.maxChars)).join("\n\n---\n\n");
	if (out.totalMessages !== undefined && out.totalMessages > out.messages.length) {
		return `Showing newest ${out.messages.length} of ${out.totalMessages} messages in thread.\n\n${body}`;
	}
	return body;
}

export function createGmailReadAction(port: GmailPort) {
	return defineAction<typeof gmailReadInputSchema, GmailReadOutput>({
		id: "gmail_read",
		domain: "integrations",
		description:
			"Read one Gmail message, or a whole thread, in full — headers, decoded body text and attachment list. Prefers the plain-text part and keeps link hrefs, so document URLs in transactional mail survive.",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: gmailReadInputSchema,
		formatMcp: formatGmailReadMcp,
		async run(input) {
			if (!input.message_id === !input.thread_id) {
				throw new Error("Pass exactly one of message_id or thread_id.");
			}
			const domain: Domain = reconcileDomain(input.domain, input.account, "account") ?? "angus";
			const account = DOMAIN_LEGACY_SCOPE[domain] as GmailAccount;
			const maxChars = input.max_chars ?? 20_000;
			let messages: ParsedMessage[];
			let totalMessages: number;
			if (input.thread_id) {
				const allMessages = await port.getThread({ domain, threadId: input.thread_id });
				totalMessages = allMessages.length;
				const maxMessages = input.max_messages ?? 25;
				messages = totalMessages > maxMessages ? allMessages.slice(-maxMessages) : allMessages;
			} else {
				messages = [parseMessage(await port.getMessage({ domain, messageId: input.message_id as string }))];
				totalMessages = messages.length;
			}
			return {
				domain,
				account,
				maxChars,
				...(input.thread_id ? { totalMessages } : {}),
				messages,
				receipt: {
					account,
					message_ids: messages.map((m) => m.id),
					thread_ids: [...new Set(messages.map((m) => m.threadId))],
					count: messages.length,
					total_count: totalMessages,
				},
			};
		},
	});
}
