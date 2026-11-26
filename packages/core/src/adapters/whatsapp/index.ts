import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { whatsappConfigSchema, type WhatsappConfig } from "../../domain/integrations.js";
import type { ConfigRepository } from "../../ports/config.js";
import {
	classifyWhatsappChatKind,
	normalizeWhatsappJid,
	type ListWhatsappChatsInput,
	type ListWhatsappMessagesInput,
	type WhatsappChatKind,
	type WhatsappChatSummary,
	type WhatsappConnectionStatus,
	type WhatsappMessage,
	type WhatsappPort,
	type WhatsappStoreSource,
} from "../../ports/whatsapp.js";

export { classifyWhatsappChatKind, normalizeWhatsappJid };

export interface StoredWhatsappChat {
	jid: string;
	name: string;
	kind?: WhatsappChatKind;
	unreadCount?: number;
	lastMessageAt?: string | null;
}

export interface StoredWhatsappContact {
	jid: string;
	name?: string | null;
	notify?: string | null;
}

export interface WhatsappStoreData {
	version: 1;
	source?: Exclude<WhatsappStoreSource, "unlinked">;
	accountJid: string | null;
	accountName: string | null;
	lastSyncedAt: string | null;
	contacts: Record<string, StoredWhatsappContact>;
	chats: Record<string, StoredWhatsappChat>;
	messages: WhatsappMessage[];
}

export interface WhatsappAdapterOptions {
	configRepo?: Pick<ConfigRepository, "loadConfig">;
	defaultStorePath?: string;
	defaultAuthDir?: string;
	syncHook?: (paths: { authDir: string; storePath: string }) => Promise<void>;
}

export function defaultWhatsappBaseDir(): string {
	return path.join(os.homedir(), ".ahkms", "whatsapp");
}

export function resolveWhatsappPaths(
	config?: WhatsappConfig | null,
	overrides?: { defaultStorePath?: string; defaultAuthDir?: string },
): { storePath: string; authDir: string } {
	const base = defaultWhatsappBaseDir();
	const storePath =
		config?.store_path ||
		process.env.WHATSAPP_STORE_PATH ||
		overrides?.defaultStorePath ||
		path.join(base, "store.json");
	const authDir =
		config?.auth_dir ||
		process.env.WHATSAPP_AUTH_DIR ||
		overrides?.defaultAuthDir ||
		path.join(base, "auth");
	return { storePath, authDir };
}

export function emptyWhatsappStore(
	source: Exclude<WhatsappStoreSource, "unlinked"> = "baileys",
): WhatsappStoreData {
	return {
		version: 1,
		source,
		accountJid: null,
		accountName: null,
		lastSyncedAt: null,
		contacts: {},
		chats: {},
		messages: [],
	};
}

export function readWhatsappStore(storePath: string): WhatsappStoreData | null {
	try {
		if (!fs.existsSync(storePath)) return null;
		const raw = fs.readFileSync(storePath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<WhatsappStoreData>;
		return {
			version: 1,
			source: parsed.source ?? "baileys",
			accountJid: parsed.accountJid ? normalizeWhatsappJid(parsed.accountJid) : null,
			accountName: parsed.accountName ?? null,
			lastSyncedAt: parsed.lastSyncedAt ?? null,
			contacts: parsed.contacts ?? {},
			chats: parsed.chats ?? {},
			messages: Array.isArray(parsed.messages) ? parsed.messages : [],
		};
	} catch {
		return null;
	}
}

export function writeWhatsappStore(storePath: string, data: WhatsappStoreData): void {
	const dir = path.dirname(storePath);
	fs.mkdirSync(dir, { recursive: true });
	const tmpPath = `${storePath}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
	fs.renameSync(tmpPath, storePath);
}

export function readBaileysAuthCreds(authDir: string): {
	linked: boolean;
	accountJid: string | null;
	accountName: string | null;
} {
	try {
		const credsPath = path.join(authDir, "creds.json");
		if (!fs.existsSync(credsPath)) {
			return { linked: false, accountJid: null, accountName: null };
		}
		const raw = JSON.parse(fs.readFileSync(credsPath, "utf-8")) as {
			me?: { id?: string; name?: string };
			registered?: boolean;
		};
		const id = raw.me?.id ? normalizeWhatsappJid(raw.me.id) : null;
		const name = raw.me?.name ?? null;
		return {
			linked: Boolean(id || raw.registered),
			accountJid: id,
			accountName: name,
		};
	} catch {
		return { linked: false, accountJid: null, accountName: null };
	}
}

/**
 * Merge contacts, chats, and messages into an existing `WhatsappStoreData` object
 * idempotently (deduplicating messages on `chatJid + id` and keeping chronological order).
 */
export function mergeIntoWhatsappStore(
	existing: WhatsappStoreData,
	patch: {
		source?: Exclude<WhatsappStoreSource, "unlinked">;
		accountJid?: string | null;
		accountName?: string | null;
		syncedAt?: string;
		contacts?: StoredWhatsappContact[];
		chats?: StoredWhatsappChat[];
		messages?: WhatsappMessage[];
	},
): WhatsappStoreData {
	const accountJid = patch.accountJid
		? normalizeWhatsappJid(patch.accountJid)
		: existing.accountJid;
	const accountName = patch.accountName ?? existing.accountName;

	const contacts: Record<string, StoredWhatsappContact> = { ...existing.contacts };
	for (const c of patch.contacts ?? []) {
		const jid = normalizeWhatsappJid(c.jid);
		if (!jid) continue;
		const prev = contacts[jid];
		contacts[jid] = {
			jid,
			name: c.name ?? prev?.name ?? null,
			notify: c.notify ?? prev?.notify ?? null,
		};
	}

	const chats: Record<string, StoredWhatsappChat> = { ...existing.chats };
	for (const ch of patch.chats ?? []) {
		const jid = normalizeWhatsappJid(ch.jid);
		if (!jid) continue;
		const prev = chats[jid];
		const contactName = contacts[jid]?.name || contacts[jid]?.notify;
		chats[jid] = {
			jid,
			name: ch.name || prev?.name || contactName || jid,
			kind: ch.kind ?? prev?.kind ?? classifyWhatsappChatKind(jid, accountJid),
			unreadCount: ch.unreadCount ?? prev?.unreadCount ?? 0,
			lastMessageAt: ch.lastMessageAt ?? prev?.lastMessageAt ?? null,
		};
	}

	const byKey = new Map<string, WhatsappMessage>();
	for (const m of existing.messages) {
		const normChat = normalizeWhatsappJid(m.chatJid);
		byKey.set(`${normChat}:${m.id}`, { ...m, chatJid: normChat });
	}
	for (const m of patch.messages ?? []) {
		const normChat = normalizeWhatsappJid(m.chatJid);
		if (!normChat || !m.id) continue;
		const chatEntry = chats[normChat];
		const contactEntry = contacts[normChat];
		const resolvedChatName =
			m.chatName && m.chatName !== normChat
				? m.chatName
				: chatEntry?.name || contactEntry?.name || contactEntry?.notify || normChat;
		const resolvedKind = classifyWhatsappChatKind(normChat, accountJid);
		const normalizedMsg: WhatsappMessage = {
			...m,
			chatJid: normChat,
			chatName: resolvedChatName,
			chatKind: resolvedKind,
			senderJid: m.senderJid ? normalizeWhatsappJid(m.senderJid) : null,
		};
		byKey.set(`${normChat}:${m.id}`, normalizedMsg);

		const prevChat = chats[normChat];
		const nextLastMessageAt =
			!prevChat?.lastMessageAt || normalizedMsg.timestamp > prevChat.lastMessageAt
				? normalizedMsg.timestamp
				: prevChat.lastMessageAt;
		chats[normChat] = {
			jid: normChat,
			name: resolvedChatName,
			kind: resolvedKind,
			unreadCount: prevChat?.unreadCount ?? 0,
			lastMessageAt: nextLastMessageAt,
		};
	}

	const messages = [...byKey.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

	return {
		version: 1,
		source: patch.source ?? existing.source ?? "baileys",
		accountJid,
		accountName,
		lastSyncedAt: patch.syncedAt ?? new Date().toISOString(),
		contacts,
		chats,
		messages,
	};
}

function parseDateBound(bound: string | undefined, mode: "start" | "end"): number | null {
	if (!bound) return null;
	const trimmed = bound.trim();
	if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
		const iso = mode === "start" ? `${trimmed}T00:00:00.000Z` : `${trimmed}T23:59:59.999Z`;
		const ms = Date.parse(iso);
		return Number.isNaN(ms) ? null : ms;
	}
	const ms = Date.parse(trimmed);
	return Number.isNaN(ms) ? null : ms;
}

function buildChatFilterSets(cfg: WhatsappConfig | null | undefined): {
	allowedSet: Set<string> | null;
	excludedSet: Set<string> | null;
} {
	const allowed = (cfg?.allowed_chat_jids ?? [])
		.map((jid) => normalizeWhatsappJid(jid))
		.filter(Boolean);
	const excluded = (cfg?.excluded_chat_jids ?? [])
		.map((jid) => normalizeWhatsappJid(jid))
		.filter(Boolean);
	return {
		allowedSet: allowed.length > 0 ? new Set(allowed) : null,
		excludedSet: excluded.length > 0 ? new Set(excluded) : null,
	};
}

function isChatPermitted(
	chatJid: string,
	filters: { allowedSet: Set<string> | null; excludedSet: Set<string> | null },
): boolean {
	const norm = normalizeWhatsappJid(chatJid);
	if (!norm) return false;
	if (filters.excludedSet?.has(norm)) return false;
	if (filters.allowedSet && !filters.allowedSet.has(norm)) return false;
	return true;
}

export function createWhatsappAdapter(options: WhatsappAdapterOptions = {}): WhatsappPort {
	async function resolveConfigAndPaths() {
		let cfg: WhatsappConfig | null = null;
		if (options.configRepo) {
			try {
				cfg = await options.configRepo.loadConfig("whatsapp", whatsappConfigSchema);
			} catch {
				cfg = null;
			}
		}
		const { storePath, authDir } = resolveWhatsappPaths(cfg, {
			defaultStorePath: options.defaultStorePath,
			defaultAuthDir: options.defaultAuthDir,
		});
		return { cfg, storePath, authDir };
	}

	async function maybeSync(sync: boolean | undefined, authDir: string, storePath: string) {
		if (sync && options.syncHook) {
			await options.syncHook({ authDir, storePath });
		}
	}

	return {
		async getStatus(statusOpts) {
			const { cfg, storePath, authDir } = await resolveConfigAndPaths();
			await maybeSync(statusOpts?.sync, authDir, storePath);

			const creds = readBaileysAuthCreds(authDir);
			const store = readWhatsappStore(storePath);
			const storePresent = store !== null;
			const accountJid =
				creds.accountJid ||
				store?.accountJid ||
				(cfg?.self_chat_jid ? normalizeWhatsappJid(cfg.self_chat_jid) : null);
			const accountName = creds.accountName || store?.accountName || null;

			const chatJids = new Set<string>();
			if (store) {
				for (const jid of Object.keys(store.chats)) chatJids.add(jid);
				for (const m of store.messages) chatJids.add(m.chatJid);
			}

			const linked = creds.linked || (storePresent && (chatJids.size > 0 || (store?.messages.length ?? 0) > 0));
			const source: WhatsappStoreSource = !linked
				? "unlinked"
				: creds.linked
					? "baileys"
					: store?.source ?? "baileys";

			return {
				linked,
				storePresent,
				accountJid,
				accountName,
				authDir,
				storePath,
				chatCount: chatJids.size,
				messageCount: store?.messages.length ?? 0,
				lastSyncedAt: store?.lastSyncedAt ?? null,
				source,
			};
		},

		async listChats(input: ListWhatsappChatsInput = {}) {
			const { cfg, storePath, authDir } = await resolveConfigAndPaths();
			await maybeSync(input.sync, authDir, storePath);

			const store = readWhatsappStore(storePath);
			if (!store) return [];

			const selfJid =
				store.accountJid ||
				(cfg?.self_chat_jid ? normalizeWhatsappJid(cfg.self_chat_jid) : null);
			const chatFilters = buildChatFilterSets(cfg);

			const statsByChat = new Map<
				string,
				{ count: number; lastAt: string | null; lastPreview: string | null; latestName: string | null }
			>();

			for (const msg of store.messages) {
				const jid = normalizeWhatsappJid(msg.chatJid);
				if (!isChatPermitted(jid, chatFilters)) continue;
				const prev = statsByChat.get(jid) ?? {
					count: 0,
					lastAt: null,
					lastPreview: null,
					latestName: null,
				};
				prev.count += 1;
				if (!prev.lastAt || msg.timestamp >= prev.lastAt) {
					prev.lastAt = msg.timestamp;
					prev.lastPreview = msg.text;
				}
				if (msg.chatName && msg.chatName !== jid) {
					prev.latestName = msg.chatName;
				}
				statsByChat.set(jid, prev);
			}

			const allJids = new Set<string>([
				...Object.keys(store.chats).map(normalizeWhatsappJid),
				...statsByChat.keys(),
			]);

			const summaries: WhatsappChatSummary[] = [];
			for (const jid of allJids) {
				if (!jid || !isChatPermitted(jid, chatFilters)) continue;
				const storedChat = store.chats[jid];
				const contact = store.contacts[jid];
				const stats = statsByChat.get(jid);
				const name =
					storedChat?.name ||
					stats?.latestName ||
					contact?.name ||
					contact?.notify ||
					jid;
				const kind = storedChat?.kind ?? classifyWhatsappChatKind(jid, selfJid);
				const lastMessageAt = stats?.lastAt ?? storedChat?.lastMessageAt ?? null;
				summaries.push({
					jid,
					name,
					kind,
					unreadCount: storedChat?.unreadCount ?? 0,
					lastMessageAt,
					lastMessagePreview: stats?.lastPreview ?? null,
					messageCount: stats?.count ?? 0,
				});
			}

			const q = input.query?.trim().toLowerCase();
			const filtered = summaries.filter((c) => {
				if (input.kind && c.kind !== input.kind) return false;
				if (q) {
					const hay = `${c.name} ${c.jid}`.toLowerCase();
					if (!hay.includes(q)) return false;
				}
				return true;
			});

			filtered.sort((a, b) => {
				const aTs = a.lastMessageAt ?? "";
				const bTs = b.lastMessageAt ?? "";
				if (aTs !== bTs) return bTs.localeCompare(aTs);
				return a.name.localeCompare(b.name);
			});

			const limit = input.limit ?? 50;
			return filtered.slice(0, limit);
		},

		async listMessages(input: ListWhatsappMessagesInput = {}) {
			const { cfg, storePath, authDir } = await resolveConfigAndPaths();
			await maybeSync(input.sync, authDir, storePath);

			const store = readWhatsappStore(storePath);
			if (!store) return [];

			const selfJid =
				store.accountJid ||
				(cfg?.self_chat_jid ? normalizeWhatsappJid(cfg.self_chat_jid) : null);
			const chatFilters = buildChatFilterSets(cfg);

			const chatFilter = input.chatJid?.trim().toLowerCase();
			const normalizedChatFilter = input.chatJid ? normalizeWhatsappJid(input.chatJid).toLowerCase() : null;
			const queryFilter = input.query?.trim().toLowerCase();
			const sinceMs = parseDateBound(input.since, "start");
			const untilMs = parseDateBound(input.until, "end");

			const matched = store.messages
				.map((m): WhatsappMessage => {
					const normChat = normalizeWhatsappJid(m.chatJid);
					const storedChat = store.chats[normChat];
					const contact = store.contacts[normChat];
					const chatName =
						m.chatName && m.chatName !== normChat
							? m.chatName
							: storedChat?.name || contact?.name || contact?.notify || normChat;
					return {
						...m,
						chatJid: normChat,
						chatName,
						chatKind: classifyWhatsappChatKind(normChat, selfJid),
					};
				})
				.filter((m) => {
					if (!isChatPermitted(m.chatJid, chatFilters)) {
						return false;
					}
					if (chatFilter) {
						const jidLower = m.chatJid.toLowerCase();
						const nameLower = m.chatName.toLowerCase();
						if (
							jidLower !== normalizedChatFilter &&
							!jidLower.includes(chatFilter) &&
							!nameLower.includes(chatFilter)
						) {
							return false;
						}
					}
					if (input.fromMe !== undefined && m.fromMe !== input.fromMe) {
						return false;
					}
					if (sinceMs !== null || untilMs !== null) {
						const msgMs = Date.parse(m.timestamp);
						if (Number.isNaN(msgMs)) return false;
						if (sinceMs !== null && msgMs < sinceMs) return false;
						if (untilMs !== null && msgMs > untilMs) return false;
					}
					if (queryFilter) {
						const hay = `${m.text} ${m.chatName} ${m.senderName ?? ""} ${m.quotedText ?? ""}`.toLowerCase();
						if (!hay.includes(queryFilter)) return false;
					}
					return true;
				});

			matched.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

			const limit = input.limit === undefined ? 50 : input.limit;
			if (limit <= 0 || matched.length <= limit) return matched;
			// Return the most recent `limit` messages within the window in chronological order.
			return matched.slice(matched.length - limit);
		},
	};
}
