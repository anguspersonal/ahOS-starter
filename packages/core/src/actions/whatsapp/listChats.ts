import { z } from "zod";
import { defineAction } from "../defineAction.js";
import {
	WHATSAPP_CHAT_KINDS,
	type WhatsappChatSummary,
	type WhatsappPort,
} from "../../ports/whatsapp.js";

export const whatsappListChatsInput = {
	query: z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe("Case-insensitive substring filter on chat name or JID."),
	kind: z
		.enum(WHATSAPP_CHAT_KINDS)
		.optional()
		.describe("Filter by chat kind: 'dm' (1:1), 'group', 'self' (Message Yourself), or 'broadcast'."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(200)
		.optional()
		.describe("Max chats to return, ordered by most recent message first (default 50, max 200)."),
	sync: z
		.boolean()
		.optional()
		.describe("When true, run a short Baileys companion sync before reading the chat list."),
} as const;

export const whatsappListChatsSchema = z.object(whatsappListChatsInput);
export type WhatsappListChatsInput = z.infer<typeof whatsappListChatsSchema>;

export interface WhatsappListChatsResult {
	chats: WhatsappChatSummary[];
	total: number;
}

export function formatWhatsappListChatsMcp(result: WhatsappListChatsResult): string {
	if (result.chats.length === 0) {
		return "No WhatsApp chats matched. If you have not synced yet, run `npm run whatsapp-link -w @ahkms/mcp-server`.";
	}
	const lines = [
		`Found ${result.chats.length} WhatsApp chat(s):`,
		"",
		...result.chats.map((c) => {
			const ts = c.lastMessageAt ? c.lastMessageAt.slice(0, 16).replace("T", " ") : "no messages";
			const preview = c.lastMessagePreview ? ` — ${c.lastMessagePreview.replace(/\s+/g, " ").slice(0, 80)}` : "";
			return `• [${c.kind}] ${c.name} (${c.jid}) · ${c.messageCount} msg(s) · last: ${ts}${preview}`;
		}),
	];
	return lines.join("\n");
}

export function createWhatsappListChatsAction(port: WhatsappPort) {
	return defineAction({
		id: "whatsapp_list_chats",
		domain: "integrations",
		description:
			"List synced WhatsApp chats (1:1 DMs, group chats, and self-chat) ordered by most recent message, with optional name/JID and kind filters.",
		schema: whatsappListChatsSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		run: async (input): Promise<WhatsappListChatsResult> => {
			const chats = await port.listChats({
				query: input.query,
				kind: input.kind,
				limit: input.limit ?? 50,
				sync: input.sync,
			});
			return {
				chats,
				total: chats.length,
			};
		},
		formatMcp: formatWhatsappListChatsMcp,
	});
}
