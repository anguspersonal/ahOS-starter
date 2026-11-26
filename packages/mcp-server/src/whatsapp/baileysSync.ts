import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	Browsers,
	DisconnectReason,
	fetchLatestBaileysVersion,
	makeWASocket,
	useMultiFileAuthState,
	type proto,
	type WAMessage,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import type { WhatsappMessage } from "@ahkms/core";
import {
	classifyWhatsappChatKind,
	emptyWhatsappStore,
	mergeIntoWhatsappStore,
	normalizeWhatsappJid,
	readBaileysAuthCreds,
	readWhatsappStore,
	writeWhatsappStore,
	type StoredWhatsappChat,
	type StoredWhatsappContact,
} from "@ahkms/core/adapters";

/** Apple CoreData epoch offset (seconds between 1970-01-01T00:00:00Z and 2001-01-01T00:00:00Z). */
export const COREDATA_EPOCH_OFFSET_SECONDS = 978307200;

export const DEFAULT_MACOS_WHATSAPP_DB_PATH = path.join(
	os.homedir(),
	"Library",
	"Group Containers",
	"group.net.whatsapp.WhatsApp.shared",
	"ChatStorage.sqlite",
);

export interface BaileysSyncSummary {
	source: "baileys" | "macos_sqlite";
	accountJid: string | null;
	accountName: string | null;
	storePath: string;
	syncedContacts: number;
	syncedChats: number;
	syncedMessages: number;
	totalChats: number;
	totalMessages: number;
}

export interface BaileysSyncOptions {
	authDir: string;
	storePath: string;
	/** Whether to allow interactive QR / pairing-code linking when not yet registered. */
	interactive?: boolean;
	/** Optional phone number (digits only, e.g. "447700900123") for 8-char pairing code instead of QR. */
	pairingPhone?: string;
	/** Print QR codes to terminal when linking interactively (default true when interactive). */
	printQr?: boolean;
	/** Maximum milliseconds to keep the sync session open (default 15_000 non-interactive, 120_000 interactive). */
	timeoutMs?: number;
	/** Quiet window after the last received event once open before closing (default 2_500ms). */
	idleMs?: number;
	/** Optional progress callback for CLI output. */
	onLog?: (msg: string) => void;
}

export interface MacosWhatsappImportOptions {
	dbPath?: string;
	storePath: string;
	/** Max recent messages to import from ChatStorage.sqlite (default 2000). */
	limit?: number;
	accountJid?: string | null;
	accountName?: string | null;
}

function unwrapMessageContent(
	content: proto.IMessage | null | undefined,
): proto.IMessage | null | undefined {
	if (!content) return null;
	if (content.ephemeralMessage?.message) {
		return unwrapMessageContent(content.ephemeralMessage.message);
	}
	if (content.viewOnceMessage?.message) {
		return unwrapMessageContent(content.viewOnceMessage.message);
	}
	if (content.viewOnceMessageV2?.message) {
		return unwrapMessageContent(content.viewOnceMessageV2.message);
	}
	if (content.viewOnceMessageV2Extension?.message) {
		return unwrapMessageContent(content.viewOnceMessageV2Extension.message);
	}
	if (content.documentWithCaptionMessage?.message) {
		return unwrapMessageContent(content.documentWithCaptionMessage.message);
	}
	if (content.editedMessage?.message?.protocolMessage?.editedMessage) {
		return unwrapMessageContent(content.editedMessage.message.protocolMessage.editedMessage);
	}
	return content;
}

export function extractBaileysMessageFields(rawContent: proto.IMessage | null | undefined): {
	text: string;
	mediaType: string | null;
	quotedText: string | null;
} {
	const content = unwrapMessageContent(rawContent);
	if (!content) {
		return { text: "", mediaType: null, quotedText: null };
	}

	let text = "";
	let mediaType: string | null = null;
	let contextInfo: proto.IContextInfo | null | undefined = null;

	if (typeof content.conversation === "string" && content.conversation) {
		text = content.conversation;
	} else if (content.extendedTextMessage) {
		text = content.extendedTextMessage.text ?? "";
		contextInfo = content.extendedTextMessage.contextInfo;
	} else if (content.imageMessage) {
		text = content.imageMessage.caption ?? "[Image]";
		mediaType = "image";
		contextInfo = content.imageMessage.contextInfo;
	} else if (content.videoMessage) {
		text = content.videoMessage.caption ?? "[Video]";
		mediaType = "video";
		contextInfo = content.videoMessage.contextInfo;
	} else if (content.documentMessage) {
		text =
			content.documentMessage.caption ||
			content.documentMessage.fileName ||
			content.documentMessage.title ||
			"[Document]";
		mediaType = "document";
		contextInfo = content.documentMessage.contextInfo;
	} else if (content.audioMessage) {
		text = content.audioMessage.ptt ? "[Voice note]" : "[Audio]";
		mediaType = content.audioMessage.ptt ? "voice_note" : "audio";
		contextInfo = content.audioMessage.contextInfo;
	} else if (content.locationMessage) {
		const loc = content.locationMessage;
		text = loc.name || loc.address || `[Location ${loc.degreesLatitude ?? ""}, ${loc.degreesLongitude ?? ""}]`;
		mediaType = "location";
		contextInfo = loc.contextInfo;
	} else if (content.contactMessage) {
		text = content.contactMessage.displayName ? `[Contact: ${content.contactMessage.displayName}]` : "[Contact]";
		mediaType = "contact";
		contextInfo = content.contactMessage.contextInfo;
	}

	let quotedText: string | null = null;
	if (contextInfo?.quotedMessage) {
		const q = extractBaileysMessageFields(contextInfo.quotedMessage);
		if (q.text) quotedText = q.text;
	}

	return { text: text.trim(), mediaType, quotedText };
}

function toTimestampIso(rawTs: unknown): string {
	if (typeof rawTs === "number" && Number.isFinite(rawTs)) {
		const ms = rawTs > 1e12 ? rawTs : rawTs * 1000;
		return new Date(ms).toISOString();
	}
	if (rawTs && typeof rawTs === "object" && "toNumber" in rawTs && typeof (rawTs as { toNumber: () => number }).toNumber === "function") {
		const sec = (rawTs as { toNumber: () => number }).toNumber();
		return new Date(sec * 1000).toISOString();
	}
	if (typeof rawTs === "string" && /^\d+$/.test(rawTs)) {
		const num = Number(rawTs);
		const ms = num > 1e12 ? num : num * 1000;
		return new Date(ms).toISOString();
	}
	return new Date().toISOString();
}

export function convertBaileysMessage(
	msg: WAMessage,
	accountJid: string | null,
): WhatsappMessage | null {
	const rawChatJid = msg.key?.remoteJid;
	const id = msg.key?.id;
	if (!rawChatJid || !id || rawChatJid === "status@broadcast") return null;

	const chatJid = normalizeWhatsappJid(rawChatJid);
	const { text, mediaType, quotedText } = extractBaileysMessageFields(msg.message);
	if (!text) return null;

	const fromMe = Boolean(msg.key?.fromMe);
	const participant = msg.key?.participant || msg.participant || (fromMe ? accountJid : chatJid);
	const senderJid = participant ? normalizeWhatsappJid(participant) : null;

	return {
		id,
		chatJid,
		chatName: chatJid,
		chatKind: classifyWhatsappChatKind(chatJid, accountJid),
		senderJid,
		senderName: msg.pushName ?? null,
		fromMe,
		timestamp: toTimestampIso(msg.messageTimestamp),
		text,
		quotedText,
		mediaType,
	};
}

const silentPinoLogger = {
	level: "silent",
	trace: () => {},
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	fatal: () => {},
	child: () => silentPinoLogger,
} as any;

/**
 * Connect to WhatsApp Web multi-device via `@whiskeysockets/baileys`, receive history
 * and recent message batches, and merge them into the local read-only store.
 */
export async function syncWhatsappViaBaileys(
	options: BaileysSyncOptions,
): Promise<BaileysSyncSummary> {
	fs.mkdirSync(options.authDir, { recursive: true });
	const { state, saveCreds } = await useMultiFileAuthState(options.authDir);
	const existing = readWhatsappStore(options.storePath) ?? emptyWhatsappStore("baileys");

	const credsInfo = readBaileysAuthCreds(options.authDir);
	if (!credsInfo.linked && !state.creds.registered && !options.interactive) {
		return {
			source: "baileys",
			accountJid: existing.accountJid,
			accountName: existing.accountName,
			storePath: options.storePath,
			syncedContacts: 0,
			syncedChats: 0,
			syncedMessages: 0,
			totalChats: Object.keys(existing.chats).length,
			totalMessages: existing.messages.length,
		};
	}

	let version: [number, number, number] | undefined;
	try {
		const latest = await fetchLatestBaileysVersion();
		version = latest.version;
	} catch {
		// Fall back to Baileys bundled version if version check fails offline
	}

	const collectedContacts: StoredWhatsappContact[] = [];
	const collectedChats: StoredWhatsappChat[] = [];
	const collectedMessages: WhatsappMessage[] = [];
	let accountJid =
		(state.creds.me?.id ? normalizeWhatsappJid(state.creds.me.id) : null) ??
		existing.accountJid;
	let accountName = state.creds.me?.name ?? existing.accountName;

	const timeoutMs = options.timeoutMs ?? (options.interactive ? 120_000 : 15_000);
	const idleMs = options.idleMs ?? 2_500;
	const printQr = options.printQr ?? Boolean(options.interactive && !options.pairingPhone);

	await new Promise<void>((resolve, reject) => {
		let settled = false;
		let idleTimer: NodeJS.Timeout | null = null;
		let pairingRequested = false;

		const sock = makeWASocket({
			auth: state,
			...(version ? { version } : {}),
			logger: silentPinoLogger,
			browser: Browsers.macOS("ahOS"),
			syncFullHistory: true,
			markOnlineOnConnect: false,
		});

		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			if (idleTimer) clearTimeout(idleTimer);
			clearTimeout(overallTimer);
			try {
				sock.end(undefined);
			} catch {
				// ignore socket close errors
			}
			if (err) reject(err);
			else resolve();
		};

		const bumpIdleTimer = () => {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => finish(), idleMs);
		};

		const overallTimer = setTimeout(() => finish(), timeoutMs);

		sock.ev.on("creds.update", async () => {
			await saveCreds();
			if (state.creds.me?.id) {
				accountJid = normalizeWhatsappJid(state.creds.me.id);
			}
			if (state.creds.me?.name) {
				accountName = state.creds.me.name;
			}
		});

		sock.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
			for (const c of contacts ?? []) {
				if (!c.id) continue;
				collectedContacts.push({
					jid: normalizeWhatsappJid(c.id),
					name: c.name ?? null,
					notify: c.notify ?? null,
				});
			}
			for (const ch of chats ?? []) {
				if (!ch.id || ch.id === "status@broadcast") continue;
				const jid = normalizeWhatsappJid(ch.id);
				collectedChats.push({
					jid,
					name: ch.name || ch.id,
					kind: classifyWhatsappChatKind(jid, accountJid),
					unreadCount: typeof ch.unreadCount === "number" ? ch.unreadCount : 0,
					lastMessageAt: ch.conversationTimestamp
						? toTimestampIso(ch.conversationTimestamp)
						: null,
				});
			}
			for (const m of messages ?? []) {
				const converted = convertBaileysMessage(m, accountJid);
				if (converted) collectedMessages.push(converted);
			}
			options.onLog?.(
				`[baileys] history batch: +${contacts?.length ?? 0} contacts, +${chats?.length ?? 0} chats, +${messages?.length ?? 0} messages`,
			);
			bumpIdleTimer();
		});

		sock.ev.on("contacts.upsert", (contacts) => {
			for (const c of contacts) {
				if (!c.id) continue;
				collectedContacts.push({
					jid: normalizeWhatsappJid(c.id),
					name: c.name ?? null,
					notify: c.notify ?? null,
				});
			}
			bumpIdleTimer();
		});

		sock.ev.on("chats.upsert", (chats) => {
			for (const ch of chats) {
				if (!ch.id || ch.id === "status@broadcast") continue;
				const jid = normalizeWhatsappJid(ch.id);
				collectedChats.push({
					jid,
					name: ch.name || ch.id,
					kind: classifyWhatsappChatKind(jid, accountJid),
					unreadCount: typeof ch.unreadCount === "number" ? ch.unreadCount : 0,
					lastMessageAt: ch.conversationTimestamp
						? toTimestampIso(ch.conversationTimestamp)
						: null,
				});
			}
			bumpIdleTimer();
		});

		sock.ev.on("messages.upsert", ({ messages }) => {
			for (const m of messages) {
				const converted = convertBaileysMessage(m, accountJid);
				if (converted) collectedMessages.push(converted);
			}
			bumpIdleTimer();
		});

		sock.ev.on("connection.update", async (update) => {
			const { connection, lastDisconnect, qr } = update;

			if (qr) {
				if (options.pairingPhone && !pairingRequested && !state.creds.registered) {
					pairingRequested = true;
					try {
						const digits = options.pairingPhone.replace(/\D/g, "");
						const code = await sock.requestPairingCode(digits);
						options.onLog?.(
							`\nWhatsApp Pairing Code for +${digits}: ${code}\n(On your phone: WhatsApp -> Settings -> Linked Devices -> Link a Device -> Link with phone number instead)\n`,
						);
					} catch (err) {
						options.onLog?.(
							`Failed to request pairing code: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				} else if (printQr) {
					options.onLog?.(
						"\nScan this QR code in WhatsApp (Settings -> Linked Devices -> Link a Device):\n",
					);
					qrcode.generate(qr, { small: true });
				}
			}

			if (connection === "open") {
				if (state.creds.me?.id) {
					accountJid = normalizeWhatsappJid(state.creds.me.id);
				}
				if (state.creds.me?.name) {
					accountName = state.creds.me.name;
				}
				options.onLog?.(
					`[baileys] connected as ${accountName ? `${accountName} (${accountJid})` : accountJid ?? "linked device"}. Syncing messages...`,
				);
				bumpIdleTimer();
			}

			if (connection === "close") {
				const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
					?.output?.statusCode;
				if (statusCode === DisconnectReason.loggedOut) {
					finish(new Error("WhatsApp session logged out. Re-run `npm run whatsapp-link -w @ahkms/mcp-server` to re-link."));
					return;
				}
				// During interactive pairing, WhatsApp restarts the stream once right after QR scan (515 restartRequired).
				if (options.interactive && statusCode === DisconnectReason.restartRequired) {
					options.onLog?.("[baileys] pairing succeeded; reconnecting to complete initial sync...");
					finish();
					return;
				}
				finish();
			}
		});
	});

	const merged = mergeIntoWhatsappStore(existing, {
		source: "baileys",
		accountJid,
		accountName,
		contacts: collectedContacts,
		chats: collectedChats,
		messages: collectedMessages,
	});
	writeWhatsappStore(options.storePath, merged);

	return {
		source: "baileys",
		accountJid: merged.accountJid,
		accountName: merged.accountName,
		storePath: options.storePath,
		syncedContacts: collectedContacts.length,
		syncedChats: collectedChats.length,
		syncedMessages: collectedMessages.length,
		totalChats: Object.keys(merged.chats).length,
		totalMessages: merged.messages.length,
	};
}

interface SqliteChatRow {
	jid: string;
	name: string | null;
	unread_count: number | null;
	last_msg_unix: number | null;
}

interface SqliteMessageRow {
	id: string;
	chat_jid: string;
	chat_name: string | null;
	from_me: number;
	msg_unix: number;
	from_jid: string | null;
	to_jid: string | null;
	push_name: string | null;
	member_jid: string | null;
	member_name: string | null;
	text: string;
}

/**
 * Import chats and messages from the local macOS WhatsApp Desktop SQLite database
 * (`~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite`)
 * into the ahOS read-only WhatsApp store.
 */
export function importFromMacosWhatsappDb(
	options: MacosWhatsappImportOptions,
): BaileysSyncSummary {
	const dbPath = options.dbPath ?? DEFAULT_MACOS_WHATSAPP_DB_PATH;
	if (!fs.existsSync(dbPath)) {
		throw new Error(`macOS WhatsApp Desktop database not found at ${dbPath}`);
	}

	const limit = Math.max(1, Math.min(options.limit ?? 2000, 20_000));

	const chatsSql = `
		SELECT
			ZCONTACTJID AS jid,
			ZPARTNERNAME AS name,
			COALESCE(ZUNREADCOUNT, 0) AS unread_count,
			CAST(ZLASTMESSAGEDATE + ${COREDATA_EPOCH_OFFSET_SECONDS} AS INTEGER) AS last_msg_unix
		FROM ZWACHATSESSION
		WHERE ZCONTACTJID IS NOT NULL
		  AND COALESCE(ZREMOVED, 0) = 0
		ORDER BY ZLASTMESSAGEDATE DESC;
	`;

	const messagesSql = `
		SELECT
			COALESCE(m.ZSTANZAID, CAST(m.Z_PK AS TEXT)) AS id,
			s.ZCONTACTJID AS chat_jid,
			s.ZPARTNERNAME AS chat_name,
			COALESCE(m.ZISFROMME, 0) AS from_me,
			CAST(m.ZMESSAGEDATE + ${COREDATA_EPOCH_OFFSET_SECONDS} AS INTEGER) AS msg_unix,
			m.ZFROMJID AS from_jid,
			m.ZTOJID AS to_jid,
			pp.ZPUSHNAME AS push_name,
			gm.ZMEMBERJID AS member_jid,
			COALESCE(
				NULLIF(TRIM(gm.ZCONTACTNAME), ''),
				NULLIF(TRIM(gm.ZFIRSTNAME), ''),
				NULLIF(TRIM(ms.ZPARTNERNAME), '')
			) AS member_name,
			m.ZTEXT AS text
		FROM ZWAMESSAGE m
		JOIN ZWACHATSESSION s ON m.ZCHATSESSION = s.Z_PK
		LEFT JOIN ZWAGROUPMEMBER gm ON m.ZGROUPMEMBER = gm.Z_PK
		LEFT JOIN ZWACHATSESSION ms ON ms.ZCONTACTJID = gm.ZMEMBERJID
		LEFT JOIN ZWAPROFILEPUSHNAME pp ON pp.ZJID = COALESCE(
			NULLIF(TRIM(gm.ZMEMBERJID), ''),
			NULLIF(TRIM(m.ZFROMJID), ''),
			s.ZCONTACTJID
		)
		WHERE m.ZTEXT IS NOT NULL
		  AND TRIM(m.ZTEXT) != ''
		  AND s.ZCONTACTJID IS NOT NULL
		ORDER BY m.ZMESSAGEDATE DESC
		LIMIT ${limit};
	`;

	const rawChatsOut = execFileSync("sqlite3", ["-readonly", "-json", dbPath, chatsSql], {
		encoding: "utf-8",
		maxBuffer: 32 * 1024 * 1024,
	}).trim();
	const rawMessagesOut = execFileSync("sqlite3", ["-readonly", "-json", dbPath, messagesSql], {
		encoding: "utf-8",
		maxBuffer: 64 * 1024 * 1024,
	}).trim();

	const chatRows: SqliteChatRow[] = rawChatsOut ? (JSON.parse(rawChatsOut) as SqliteChatRow[]) : [];
	const messageRows: SqliteMessageRow[] = rawMessagesOut
		? (JSON.parse(rawMessagesOut) as SqliteMessageRow[])
		: [];

	const existing = readWhatsappStore(options.storePath) ?? emptyWhatsappStore("macos_sqlite");
	const accountJid = options.accountJid
		? normalizeWhatsappJid(options.accountJid)
		: existing.accountJid;
	const accountName = options.accountName ?? existing.accountName;

	const contacts: StoredWhatsappContact[] = [];
	const chats: StoredWhatsappChat[] = [];
	for (const row of chatRows) {
		if (!row.jid || row.jid === "status@broadcast" || row.jid.endsWith("@status")) continue;
		const jid = normalizeWhatsappJid(row.jid);
		const name = row.name?.trim() || jid;
		chats.push({
			jid,
			name,
			kind: classifyWhatsappChatKind(jid, accountJid),
			unreadCount: row.unread_count ?? 0,
			lastMessageAt:
				row.last_msg_unix &&
				row.last_msg_unix > COREDATA_EPOCH_OFFSET_SECONDS &&
				row.last_msg_unix < 4_102_444_800 // ignore CoreData distantFuture (year 4001)
					? new Date(row.last_msg_unix * 1000).toISOString()
					: null,
		});
		if (!jid.endsWith("@g.us") && row.name?.trim()) {
			contacts.push({
				jid,
				name: row.name.trim(),
				notify: null,
			});
		}
	}

	const messages: WhatsappMessage[] = [];
	for (const row of messageRows) {
		if (!row.chat_jid || row.chat_jid === "status@broadcast" || row.chat_jid.endsWith("@status")) continue;
		const chatJid = normalizeWhatsappJid(row.chat_jid);
		const fromMe = Boolean(row.from_me);
		const rawSenderJid = fromMe
			? accountJid
			: row.member_jid || row.from_jid || (chatJid.endsWith("@g.us") ? null : chatJid);
		const senderJid = rawSenderJid ? normalizeWhatsappJid(rawSenderJid) : null;
		const senderName = fromMe
			? accountName
			: row.member_name?.trim() ||
				row.push_name?.trim() ||
				(!chatJid.endsWith("@g.us") ? row.chat_name?.trim() : null) ||
				null;
		const tsIso =
			row.msg_unix && row.msg_unix > 0
				? new Date(row.msg_unix * 1000).toISOString()
				: new Date().toISOString();

		messages.push({
			id: String(row.id),
			chatJid,
			chatName: row.chat_name?.trim() || chatJid,
			chatKind: classifyWhatsappChatKind(chatJid, accountJid),
			senderJid,
			senderName,
			fromMe,
			timestamp: tsIso,
			text: row.text.trim(),
			quotedText: null,
			mediaType: null,
		});
	}

	const merged = mergeIntoWhatsappStore(existing, {
		source: "macos_sqlite",
		accountJid,
		accountName,
		contacts,
		chats,
		messages,
	});
	writeWhatsappStore(options.storePath, merged);

	return {
		source: "macos_sqlite",
		accountJid: merged.accountJid,
		accountName: merged.accountName,
		storePath: options.storePath,
		syncedContacts: contacts.length,
		syncedChats: chats.length,
		syncedMessages: messages.length,
		totalChats: Object.keys(merged.chats).length,
		totalMessages: merged.messages.length,
	};
}

/**
 * Default non-interactive sync hook wired into `createWhatsappAdapter` in `@ahkms/mcp-server`:
 * - If a Baileys companion session is linked in `authDir`, syncs new messages via Baileys.
 * - Additionally, if macOS WhatsApp Desktop's `ChatStorage.sqlite` exists on disk, merges recent
 *   messages from it so local desktop chats are immediately available even before QR pairing.
 */
export async function defaultWhatsappSyncHook(paths: {
	authDir: string;
	storePath: string;
}): Promise<void> {
	const creds = readBaileysAuthCreds(paths.authDir);
	if (creds.linked) {
		await syncWhatsappViaBaileys({
			authDir: paths.authDir,
			storePath: paths.storePath,
			interactive: false,
		});
	}
	if (fs.existsSync(DEFAULT_MACOS_WHATSAPP_DB_PATH)) {
		try {
			importFromMacosWhatsappDb({
				dbPath: DEFAULT_MACOS_WHATSAPP_DB_PATH,
				storePath: paths.storePath,
				accountJid: creds.accountJid,
				accountName: creds.accountName,
			});
		} catch {
			// Ignore if sqlite3 or container read fails
		}
	}
}
