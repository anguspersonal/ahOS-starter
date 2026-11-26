import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { WhatsappMessage, WhatsappPort } from "../../ports/whatsapp.js";

export const whatsappReadMessagesInput = {
	chat_jid: z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe(
			"Chat JID (e.g. '447700900000@s.whatsapp.net' or '1203630...@g.us') or case-insensitive chat name substring. Omit to search across all synced chats.",
		),
	query: z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe("Case-insensitive substring search over message text, sender name, or chat name."),
	since: z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe("ISO date (YYYY-MM-DD) or ISO timestamp lower bound (inclusive)."),
	until: z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe("ISO date (YYYY-MM-DD) or ISO timestamp upper bound (inclusive)."),
	from_me: z
		.boolean()
		.optional()
		.describe("When true, return only messages sent by you; when false, only incoming messages; omit for both."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(500)
		.optional()
		.describe("Maximum number of messages to return, chronological within the matched window (default 50, max 500)."),
	sync: z
		.boolean()
		.optional()
		.describe("When true, run a short Baileys companion sync before reading messages."),
} as const;

export const whatsappReadMessagesSchema = z.object(whatsappReadMessagesInput);
export type WhatsappReadMessagesInput = z.infer<typeof whatsappReadMessagesSchema>;

export interface WhatsappReadMessagesResult {
	messages: WhatsappMessage[];
	total: number;
}

export function formatWhatsappReadMessagesMcp(result: WhatsappReadMessagesResult): string {
	if (result.messages.length === 0) {
		return "No WhatsApp messages matched the filter.";
	}
	const lines = [
		`Returned ${result.messages.length} WhatsApp message(s):`,
		"",
		...result.messages.map((m) => {
			const who = m.fromMe ? "Me" : m.senderName || m.senderJid || m.chatName;
			const ts = m.timestamp.slice(0, 16).replace("T", " ");
			const quote = m.quotedText ? ` [replying to: "${m.quotedText.replace(/\s+/g, " ").slice(0, 60)}"]` : "";
			return `[${ts}] (${m.chatName} · ${m.chatKind}) ${who}: ${m.text}${quote}`;
		}),
	];
	return lines.join("\n");
}

export function createWhatsappReadMessagesAction(port: WhatsappPort) {
	return defineAction({
		id: "whatsapp_read_messages",
		domain: "integrations",
		description:
			"Read or search synced WhatsApp messages across one chat or all chats, filtered by date window, sender direction, or keyword.",
		schema: whatsappReadMessagesSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		run: async (input): Promise<WhatsappReadMessagesResult> => {
			const messages = await port.listMessages({
				chatJid: input.chat_jid,
				query: input.query,
				since: input.since,
				until: input.until,
				fromMe: input.from_me,
				limit: input.limit ?? 50,
				sync: input.sync,
			});
			return {
				messages,
				total: messages.length,
			};
		},
		formatMcp: formatWhatsappReadMessagesMcp,
	});
}
