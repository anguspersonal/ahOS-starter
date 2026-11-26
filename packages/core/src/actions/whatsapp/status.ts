import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { WhatsappConnectionStatus, WhatsappPort } from "../../ports/whatsapp.js";

export const whatsappStatusInput = {
	sync: z
		.boolean()
		.optional()
		.describe(
			"When true and a linked Baileys auth session is present, perform a short live sync against WhatsApp Web before returning status.",
		),
} as const;

export const whatsappStatusSchema = z.object(whatsappStatusInput);
export type WhatsappStatusInput = z.infer<typeof whatsappStatusSchema>;

export function formatWhatsappStatusMcp(status: WhatsappConnectionStatus): string {
	const stateLine = status.linked
		? `WhatsApp status: LINKED (${status.source})`
		: "WhatsApp status: NOT LINKED";

	const lines = [
		stateLine,
		`Account JID: ${status.accountJid ?? "(not available)"}`,
		`Account Name: ${status.accountName ?? "(not available)"}`,
		`Chats in store: ${status.chatCount}`,
		`Messages in store: ${status.messageCount}`,
		`Last synced: ${status.lastSyncedAt ?? "(never)"}`,
		`Store path: ${status.storePath}`,
		`Auth directory: ${status.authDir}`,
	];

	if (!status.linked) {
		lines.push(
			"",
			"To link your personal WhatsApp as a companion device (or seed from local WhatsApp Desktop):",
			"  npm run whatsapp-link -w @ahkms/mcp-server",
			"  npm run whatsapp-link -w @ahkms/mcp-server -- --phone <phone-digits>",
			"  npm run whatsapp-link -w @ahkms/mcp-server -- --import-macos-db",
		);
	}

	return lines.join("\n");
}

export function createWhatsappStatusAction(port: WhatsappPort) {
	return defineAction({
		id: "whatsapp_status",
		domain: "integrations",
		description:
			"Inspect the linked WhatsApp companion device status, local store path, synced chat/message counts, and last sync timestamp.",
		schema: whatsappStatusSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		run: async (input): Promise<WhatsappConnectionStatus> => {
			return port.getStatus({ sync: input.sync });
		},
		formatMcp: formatWhatsappStatusMcp,
	});
}
