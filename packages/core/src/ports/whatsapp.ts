/**
 * Port for reading WhatsApp chats and messages from a linked companion device (ADR-032, ADR-101).
 * Pure types only — no external SDKs, filesystem, or database dependencies.
 */

export const WHATSAPP_CHAT_KINDS = ["dm", "group", "self", "broadcast"] as const;
export type WhatsappChatKind = (typeof WHATSAPP_CHAT_KINDS)[number];

export type WhatsappStoreSource = "baileys" | "macos_sqlite" | "unlinked";

export interface WhatsappConnectionStatus {
	linked: boolean;
	storePresent: boolean;
	accountJid: string | null;
	accountName: string | null;
	authDir: string;
	storePath: string;
	chatCount: number;
	messageCount: number;
	lastSyncedAt: string | null;
	source: WhatsappStoreSource;
}

export interface WhatsappChatSummary {
	jid: string;
	name: string;
	kind: WhatsappChatKind;
	unreadCount: number;
	lastMessageAt: string | null;
	lastMessagePreview: string | null;
	messageCount: number;
}

export interface WhatsappMessage {
	id: string;
	chatJid: string;
	chatName: string;
	chatKind: WhatsappChatKind;
	senderJid: string | null;
	senderName: string | null;
	fromMe: boolean;
	timestamp: string;
	text: string;
	quotedMessageId?: string | null;
	quotedText?: string | null;
	mediaType?: string | null;
}

export interface ListWhatsappChatsInput {
	query?: string;
	kind?: WhatsappChatKind;
	limit?: number;
	sync?: boolean;
}

export interface ListWhatsappMessagesInput {
	chatJid?: string;
	query?: string;
	since?: string;
	until?: string;
	fromMe?: boolean;
	limit?: number;
	sync?: boolean;
}

export interface WhatsappPort {
	getStatus(options?: { sync?: boolean }): Promise<WhatsappConnectionStatus>;
	listChats(input?: ListWhatsappChatsInput): Promise<WhatsappChatSummary[]>;
	listMessages(input?: ListWhatsappMessagesInput): Promise<WhatsappMessage[]>;
}

/**
 * Normalize a WhatsApp JID or phone number into canonical `<user>@s.whatsapp.net` / `<group>@g.us` form:
 * - Strips multi-device suffixes (`447700900000:4@s.whatsapp.net` -> `447700900000@s.whatsapp.net`)
 * - Rewrites legacy `@c.us` domains to `@s.whatsapp.net`
 * - Converts bare phone numbers (`+44 7700 900000`, `447700900000`) to `<digits>@s.whatsapp.net`
 */
export function normalizeWhatsappJid(jid: string | null | undefined): string {
	if (!jid) return "";
	const trimmed = jid.trim();
	const atIdx = trimmed.indexOf("@");
	if (atIdx === -1) {
		if (/^\+?[\d\s()-]+$/.test(trimmed)) {
			const digits = trimmed.replace(/\D/g, "");
			if (digits.length >= 5) {
				return `${digits}@s.whatsapp.net`;
			}
		}
		return trimmed;
	}
	const rawUserPart = trimmed.slice(0, atIdx).split(":")[0] ?? "";
	const domainPart = trimmed.slice(atIdx + 1);
	const userPart =
		domainPart === "s.whatsapp.net" || domainPart === "c.us"
			? rawUserPart.replace(/^\+/, "")
			: rawUserPart;
	if (domainPart === "c.us") {
		return `${userPart}@s.whatsapp.net`;
	}
	return `${userPart}@${domainPart}`;
}

export function classifyWhatsappChatKind(
	chatJid: string,
	selfJid?: string | null,
): WhatsappChatKind {
	const normChat = normalizeWhatsappJid(chatJid);
	const normSelf = normalizeWhatsappJid(selfJid);
	if (normSelf && normChat === normSelf) {
		return "self";
	}
	if (normChat.endsWith("@g.us")) {
		return "group";
	}
	if (
		normChat === "status@broadcast" ||
		normChat.endsWith("@broadcast") ||
		normChat.endsWith("@newsletter")
	) {
		return "broadcast";
	}
	return "dm";
}
