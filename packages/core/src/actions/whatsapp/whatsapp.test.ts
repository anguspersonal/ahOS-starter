import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAction } from "../adapters/direct.js";
import {
	classifyWhatsappChatKind,
	createWhatsappAdapter,
	emptyWhatsappStore,
	mergeIntoWhatsappStore,
	normalizeWhatsappJid,
	writeWhatsappStore,
} from "../../adapters/whatsapp/index.js";
import {
	createWhatsappIngestAction,
	createWhatsappListChatsAction,
	createWhatsappReadMessagesAction,
	createWhatsappStatusAction,
	whatsappDedupKey,
} from "./index.js";

describe("WhatsApp adapter and read-only MVP actions", () => {
	let tmpDir: string;
	let storePath: string;
	let authDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ahkms-whatsapp-test-"));
		storePath = path.join(tmpDir, "store.json");
		authDir = path.join(tmpDir, "baileys-auth");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("normalizes JIDs and classifies self, dm, group, and broadcast chats", () => {
		expect(normalizeWhatsappJid("447700900111:14@s.whatsapp.net")).toBe(
			"447700900111@s.whatsapp.net",
		);
		expect(normalizeWhatsappJid("447700900111@c.us")).toBe("447700900111@s.whatsapp.net");
		expect(normalizeWhatsappJid("+44 7700 900111")).toBe("447700900111@s.whatsapp.net");
		expect(normalizeWhatsappJid("447700900111")).toBe("447700900111@s.whatsapp.net");
		expect(normalizeWhatsappJid("12036304@g.us")).toBe("12036304@g.us");
		expect(classifyWhatsappChatKind("447700900111@s.whatsapp.net", "447700900111:2@s.whatsapp.net")).toBe(
			"self",
		);
		expect(classifyWhatsappChatKind("447700900222@s.whatsapp.net", "447700900111@s.whatsapp.net")).toBe(
			"dm",
		);
		expect(classifyWhatsappChatKind("12036304@g.us", "447700900111@s.whatsapp.net")).toBe("group");
		expect(classifyWhatsappChatKind("status@broadcast", null)).toBe("broadcast");
	});

	it("reports unlinked status when neither creds nor store exist, and linked when populated", async () => {
		const adapter = createWhatsappAdapter({
			defaultStorePath: storePath,
			defaultAuthDir: authDir,
		});
		const statusAction = createWhatsappStatusAction(adapter);

		const unlinked = await executeAction(statusAction, {});
		expect(unlinked.linked).toBe(false);
		expect(unlinked.storePresent).toBe(false);
		expect(unlinked.source).toBe("unlinked");
		const unlinkedMcp = statusAction.formatMcp?.(unlinked) ?? "";
		expect(unlinkedMcp).toContain("NOT LINKED");
		expect(unlinkedMcp).toContain("--phone <phone-digits>");
		expect(unlinkedMcp).toContain("--import-macos-db");

		fs.mkdirSync(authDir, { recursive: true });
		fs.writeFileSync(
			path.join(authDir, "creds.json"),
			JSON.stringify({ me: { id: "447700900111:4@s.whatsapp.net", name: "Angus" }, registered: true }),
		);

		const seeded = mergeIntoWhatsappStore(emptyWhatsappStore("baileys"), {
			accountJid: "447700900111@s.whatsapp.net",
			accountName: "Angus",
			chats: [
				{
					jid: "447700900222@s.whatsapp.net",
					name: "Alice",
					kind: "dm",
					unreadCount: 1,
					lastMessageAt: "2026-10-28T10:00:00.000Z",
				},
			],
			messages: [
				{
					id: "MSG-1",
					chatJid: "447700900222@s.whatsapp.net",
					chatName: "Alice",
					chatKind: "dm",
					senderJid: "447700900222@s.whatsapp.net",
					senderName: "Alice",
					fromMe: false,
					timestamp: "2026-10-28T10:00:00.000Z",
					text: "Hey Angus, are we still on for 3pm?",
					quotedText: null,
					mediaType: null,
				},
			],
		});
		writeWhatsappStore(storePath, seeded);

		const linked = await executeAction(statusAction, {});
		expect(linked.linked).toBe(true);
		expect(linked.accountJid).toBe("447700900111@s.whatsapp.net");
		expect(linked.accountName).toBe("Angus");
		expect(linked.chatCount).toBe(1);
		expect(linked.messageCount).toBe(1);
		expect(statusAction.formatMcp?.(linked)).toContain("LINKED");
	});

	it("lists chats and reads messages with filtering by kind, query, date bounds, and from_me", async () => {
		const seeded = mergeIntoWhatsappStore(emptyWhatsappStore("baileys"), {
			accountJid: "447700900111@s.whatsapp.net",
			accountName: "Angus",
			chats: [
				{
					jid: "447700900222@s.whatsapp.net",
					name: "Alice Smith",
					kind: "dm",
					unreadCount: 0,
					lastMessageAt: "2026-10-27T12:00:00.000Z",
				},
				{
					jid: "12036304999@g.us",
					name: "Work Founders",
					kind: "group",
					unreadCount: 2,
					lastMessageAt: "2026-10-28T15:30:00.000Z",
				},
			],
			messages: [
				{
					id: "M1",
					chatJid: "447700900222@s.whatsapp.net",
					chatName: "Alice Smith",
					chatKind: "dm",
					senderJid: "447700900222@s.whatsapp.net",
					senderName: "Alice Smith",
					fromMe: false,
					timestamp: "2026-10-27T12:00:00.000Z",
					text: "Checking in on the Q4 roadmap.",
					quotedText: null,
					mediaType: null,
				},
				{
					id: "M2",
					chatJid: "12036304999@g.us",
					chatName: "Work Founders",
					chatKind: "group",
					senderJid: "447700900111@s.whatsapp.net",
					senderName: "Angus",
					fromMe: true,
					timestamp: "2026-10-28T15:30:00.000Z",
					text: "Shipped the WhatsApp read-only MVP!",
					quotedText: null,
					mediaType: null,
				},
			],
		});
		writeWhatsappStore(storePath, seeded);

		const syncHook = vi.fn(async () => {});
		const adapter = createWhatsappAdapter({
			defaultStorePath: storePath,
			defaultAuthDir: authDir,
			syncHook,
		});

		const listChatsAction = createWhatsappListChatsAction(adapter);
		const readMessagesAction = createWhatsappReadMessagesAction(adapter);

		const allChats = await executeAction(listChatsAction, { sync: true });
		expect(syncHook).toHaveBeenCalledTimes(1);
		expect(allChats.total).toBe(2);
		expect(allChats.chats[0]?.name).toBe("Work Founders");
		expect(listChatsAction.formatMcp?.(allChats)).toContain("Work Founders");

		const groupOnly = await executeAction(listChatsAction, { kind: "group" });
		expect(groupOnly.total).toBe(1);
		expect(groupOnly.chats[0]?.jid).toBe("12036304999@g.us");

		const byQuery = await executeAction(readMessagesAction, { query: "roadmap" });
		expect(byQuery.total).toBe(1);
		expect(byQuery.messages[0]?.id).toBe("M1");
		expect(readMessagesAction.formatMcp?.(byQuery)).toContain("Checking in on the Q4 roadmap.");

		const fromMeMsgs = await executeAction(readMessagesAction, {
			since: "2026-10-28",
			from_me: true,
		});
		expect(fromMeMsgs.total).toBe(1);
		expect(fromMeMsgs.messages[0]?.id).toBe("M2");
	});

	it("groups WhatsApp messages into daily (chat, day) transcripts, keeps participated-thread context, and updates in-place when late messages arrive", async () => {
		const seeded = mergeIntoWhatsappStore(emptyWhatsappStore("baileys"), {
			accountJid: "447700900111@s.whatsapp.net",
			accountName: "Angus",
			messages: [
				// Chat 1 (DM with Alice on 2026-10-28): Alice asks a question, Angus replies at 22:15
				{
					id: "DM-1",
					chatJid: "447700900222@s.whatsapp.net",
					chatName: "Alice Smith",
					chatKind: "dm",
					senderJid: "447700900222@s.whatsapp.net",
					senderName: "Alice Smith",
					fromMe: false,
					timestamp: "2026-10-28T21:00:00.000Z",
					text: "Hey Angus, can you send over the investor deck?",
					quotedText: null,
					mediaType: null,
				},
				{
					id: "DM-2",
					chatJid: "447700900222@s.whatsapp.net",
					chatName: "Alice Smith",
					chatKind: "dm",
					senderJid: "447700900111@s.whatsapp.net",
					senderName: "Angus",
					fromMe: true,
					timestamp: "2026-10-28T22:15:00.000Z",
					text: "Just sent it to your inbox!",
					quotedText: "Hey Angus, can you send over the investor deck?",
					mediaType: null,
				},
				// Chat 2 (Group on 2026-10-28): Angus spoke here too
				{
					id: "GRP-1",
					chatJid: "12036304999@g.us",
					chatName: "Work Founders",
					chatKind: "group",
					senderJid: "447700900111@s.whatsapp.net",
					senderName: "Angus",
					fromMe: true,
					timestamp: "2026-10-28T12:00:00.000Z",
					text: "Decision: we use Baileys linked device for zero third-party egress.",
					quotedText: null,
					mediaType: null,
				},
				// Chat 3 (Noisy group on 2026-10-28 where Angus did NOT speak — ignored under from_me_only: true)
				{
					id: "NOISY-1",
					chatJid: "12036304888@g.us",
					chatName: "Neighbourhood Watch",
					chatKind: "group",
					senderJid: "447700900999@s.whatsapp.net",
					senderName: "Bob",
					fromMe: false,
					timestamp: "2026-10-28T18:00:00.000Z",
					text: "Has anyone seen a parcel at number 42?",
					quotedText: null,
					mediaType: null,
				},
			],
		});
		writeWhatsappStore(storePath, seeded);

		const adapter = createWhatsappAdapter({
			defaultStorePath: storePath,
			defaultAuthDir: authDir,
		});

		const storedByDedupKey = new Map<
			string,
			{ id: string; text: string; msgIds: string[]; payload: Record<string, unknown> }
		>();
		const capturePort = {
			capture: vi.fn(
				async (
					input: Record<string, unknown>,
					_userId?: string,
					options?: { updateOnDedupKey?: boolean },
				) => {
					const key = String(input.dedup_key);
					const meta = (input.processing_metadata ?? {}) as Record<string, unknown>;
					const incomingIds = Array.isArray(meta.whatsapp_message_ids)
						? (meta.whatsapp_message_ids as string[])
						: [];
					const existing = storedByDedupKey.get(key);
					if (existing) {
						const allPresent =
							incomingIds.length <= existing.msgIds.length &&
							incomingIds.every((id) => existing.msgIds.includes(id));
						if (!allPresent && options?.updateOnDedupKey) {
							existing.text = String(input.text);
							existing.msgIds = Array.from(new Set([...existing.msgIds, ...incomingIds]));
							existing.payload = input;
							return {
								id: existing.id,
								title: String(input.title),
								deduplicated: false,
								updated: true,
							};
						}
						return { id: existing.id, title: String(input.title), deduplicated: true };
					}
					const id = `art-${storedByDedupKey.size + 1}`;
					storedByDedupKey.set(key, {
						id,
						text: String(input.text),
						msgIds: incomingIds,
						payload: input,
					});
					return { id, title: String(input.title), deduplicated: false };
				},
			),
		};

		const ingestAction = createWhatsappIngestAction({
			whatsapp: adapter,
			capture: capturePort as any,
		});

		// 1. Dry run with default from_me_only: true matches 2 participated (chat, day) buckets (3 messages total),
		// ignoring the noisy group where Angus didn't speak, while preserving Alice's inbound DM question.
		const dryRes = await executeAction(ingestAction, {
			since: "2026-10-27",
			dry_run: true,
		});
		expect(dryRes.dryRun).toBe(true);
		expect(dryRes.fromMeOnly).toBe(true);
		expect(dryRes.matchedCount).toBe(2);
		expect(dryRes.matchedMessageCount).toBe(3);
		expect(capturePort.capture).not.toHaveBeenCalled();

		// 2. Run 1 (at 23:00 on Day 1, 2026-10-28): ingests 2 daily artifacts
		const day1Run = await executeAction(ingestAction, {
			since: "2026-10-27",
		});
		expect(day1Run.ingestedCount).toBe(2);
		expect(day1Run.updatedCount).toBe(0);
		expect(day1Run.deduplicatedCount).toBe(0);
		expect(day1Run.dmCount).toBe(1);

		const aliceDay1Key = whatsappDedupKey("447700900222@s.whatsapp.net", "2026-10-28");
		const groupDay1Key = whatsappDedupKey("12036304999@g.us", "2026-10-28");
		expect(storedByDedupKey.has(aliceDay1Key)).toBe(true);
		expect(storedByDedupKey.has(groupDay1Key)).toBe(true);
		// Alice's daily transcript contains BOTH her inbound question and Angus's reply
		expect(storedByDedupKey.get(aliceDay1Key)?.text).toContain("can you send over the investor deck?");
		expect(storedByDedupKey.get(aliceDay1Key)?.text).toContain("Just sent it to your inbox!");
		expect(storedByDedupKey.get(aliceDay1Key)?.payload.surface).toBe("whatsapp_dm");
		expect(storedByDedupKey.get(groupDay1Key)?.payload.surface).toBe("whatsapp");

		// 3. Between 23:00 and midnight on Day 1 (23:40), Alice replies in the same DM,
		// and on Day 2 (2026-10-29), Angus sends a follow-up.
		const afterLateNight = mergeIntoWhatsappStore(seeded, {
			messages: [
				{
					id: "DM-3-LATE",
					chatJid: "447700900222@s.whatsapp.net",
					chatName: "Alice Smith",
					chatKind: "dm",
					senderJid: "447700900222@s.whatsapp.net",
					senderName: "Alice Smith",
					fromMe: false,
					timestamp: "2026-10-28T23:40:00.000Z",
					text: "Got it before midnight — slides look great!",
					quotedText: null,
					mediaType: null,
				},
				{
					id: "DM-4-DAY2",
					chatJid: "447700900222@s.whatsapp.net",
					chatName: "Alice Smith",
					chatKind: "dm",
					senderJid: "447700900111@s.whatsapp.net",
					senderName: "Angus",
					fromMe: true,
					timestamp: "2026-10-29T10:15:00.000Z",
					text: "Awesome, let's debrief at 2pm today.",
					quotedText: null,
					mediaType: null,
				},
			],
		});
		writeWhatsappStore(storePath, afterLateNight);

		// 4. Run 2 (at 23:00 on Day 2):
		// - Alice's 2026-10-28 artifact is updated in-place (`updatedCount: 1`) with the 23:40 message
		// - Alice's 2026-10-29 artifact is created as new (`ingestedCount: 1`)
		// - Work Founders 2026-10-28 artifact is unchanged (`deduplicatedCount: 1`)
		const day2Run = await executeAction(ingestAction, {
			since: "2026-10-27",
		});
		expect(day2Run.ingestedCount).toBe(1);
		expect(day2Run.updatedCount).toBe(1);
		expect(day2Run.deduplicatedCount).toBe(1);
		expect(storedByDedupKey.get(aliceDay1Key)?.msgIds).toEqual(["DM-1", "DM-2", "DM-3-LATE"]);
		expect(storedByDedupKey.get(aliceDay1Key)?.text).toContain(
			"Got it before midnight — slides look great!",
		);

		// 5. Re-running again with no new messages deduplicates all 3 daily transcripts
		const thirdRun = await executeAction(ingestAction, {
			since: "2026-10-27",
		});
		expect(thirdRun.ingestedCount).toBe(0);
		expect(thirdRun.updatedCount).toBe(0);
		expect(thirdRun.deduplicatedCount).toBe(3);
	});

	it("enforces normalized allowed_chat_jids and excluded_chat_jids across listChats, readMessages, and ingest", async () => {
		const seeded = mergeIntoWhatsappStore(emptyWhatsappStore("baileys"), {
			accountJid: "447700900111@s.whatsapp.net",
			accountName: "Angus",
			chats: [
				{
					jid: "447700900222@s.whatsapp.net",
					name: "Alice Smith",
					kind: "dm",
					unreadCount: 0,
					lastMessageAt: "2026-10-28T10:00:00.000Z",
				},
				{
					jid: "447700900333@s.whatsapp.net",
					name: "Bob Blocked",
					kind: "dm",
					unreadCount: 0,
					lastMessageAt: "2026-10-28T11:00:00.000Z",
				},
				{
					jid: "12036304999@g.us",
					name: "Work Founders",
					kind: "group",
					unreadCount: 0,
					lastMessageAt: "2026-10-28T12:00:00.000Z",
				},
			],
			messages: [
				{
					id: "A-1",
					chatJid: "447700900222@s.whatsapp.net",
					chatName: "Alice Smith",
					chatKind: "dm",
					senderJid: "447700900111@s.whatsapp.net",
					senderName: "Angus",
					fromMe: true,
					timestamp: "2026-10-28T10:00:00.000Z",
					text: "Allowed DM message with Alice.",
					quotedText: null,
					mediaType: null,
				},
				{
					id: "B-1",
					chatJid: "447700900333@s.whatsapp.net",
					chatName: "Bob Blocked",
					chatKind: "dm",
					senderJid: "447700900111@s.whatsapp.net",
					senderName: "Angus",
					fromMe: true,
					timestamp: "2026-10-28T11:00:00.000Z",
					text: "Excluded DM message with Bob.",
					quotedText: null,
					mediaType: null,
				},
				{
					id: "G-1",
					chatJid: "12036304999@g.us",
					chatName: "Work Founders",
					chatKind: "group",
					senderJid: "447700900111@s.whatsapp.net",
					senderName: "Angus",
					fromMe: true,
					timestamp: "2026-10-28T12:00:00.000Z",
					text: "Unlisted group message.",
					quotedText: null,
					mediaType: null,
				},
			],
		});
		writeWhatsappStore(storePath, seeded);

		// Configure non-normalized JIDs/phones in allowed_chat_jids and excluded_chat_jids
		const configRepo = {
			loadConfig: vi.fn(async () => ({
				allowed_chat_jids: ["+44 7700 900222", "447700900333:4@s.whatsapp.net"],
				excluded_chat_jids: ["447700900333@c.us"],
			})),
		};

		const adapter = createWhatsappAdapter({
			configRepo: configRepo as any,
			defaultStorePath: storePath,
			defaultAuthDir: authDir,
		});

		const listChatsAction = createWhatsappListChatsAction(adapter);
		const readMessagesAction = createWhatsappReadMessagesAction(adapter);
		const capturePort = {
			capture: vi.fn(async (input: Record<string, unknown>) => ({
				id: "art-1",
				title: String(input.title),
				deduplicated: false,
			})),
		};
		const ingestAction = createWhatsappIngestAction({
			whatsapp: adapter,
			capture: capturePort as any,
			config: configRepo as any,
		});

		// Only Alice should pass both allowlist and exclusion filters
		const chatsRes = await executeAction(listChatsAction, {});
		expect(chatsRes.chats.map((c) => c.jid)).toEqual(["447700900222@s.whatsapp.net"]);

		const msgsRes = await executeAction(readMessagesAction, {});
		expect(msgsRes.messages.map((m) => m.id)).toEqual(["A-1"]);

		// Querying an excluded chat directly returns empty
		const blockedRead = await executeAction(readMessagesAction, {
			chat_jid: "447700900333@s.whatsapp.net",
		});
		expect(blockedRead.messages).toEqual([]);

		const ingestRes = await executeAction(ingestAction, {
			since: "2026-10-27",
		});
		expect(ingestRes.matchedCount).toBe(1);
		expect(ingestRes.ingestedCount).toBe(1);
		expect(capturePort.capture).toHaveBeenCalledTimes(1);
	});

	it("does not truncate earlier days of participated chats when an unparticipated chat has >2500 messages", async () => {
		const noisyMessages = Array.from({ length: 2600 }, (_, i) => ({
			id: `NOISY-${i}`,
			chatJid: "12036304888@g.us",
			chatName: "Noisy Group",
			chatKind: "group" as const,
			senderJid: "447700900999@s.whatsapp.net",
			senderName: "Spammer",
			fromMe: false,
			timestamp: `2026-10-28T12:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
			text: `Noisy message #${i}`,
			quotedText: null,
			mediaType: null,
		}));

		const seeded = mergeIntoWhatsappStore(emptyWhatsappStore("baileys"), {
			accountJid: "447700900111@s.whatsapp.net",
			accountName: "Angus",
			messages: [
				{
					id: "EARLY-DM-1",
					chatJid: "447700900222@s.whatsapp.net",
					chatName: "Alice Smith",
					chatKind: "dm",
					senderJid: "447700900111@s.whatsapp.net",
					senderName: "Angus",
					fromMe: true,
					timestamp: "2026-10-25T09:00:00.000Z",
					text: "Earlier participated conversation on Oct 25.",
					quotedText: null,
					mediaType: null,
				},
				...noisyMessages,
			],
		});
		writeWhatsappStore(storePath, seeded);

		const adapter = createWhatsappAdapter({
			defaultStorePath: storePath,
			defaultAuthDir: authDir,
		});
		const capturePort = {
			capture: vi.fn(async (input: Record<string, unknown>) => ({
				id: "art-early",
				title: String(input.title),
				deduplicated: false,
			})),
		};
		const ingestAction = createWhatsappIngestAction({
			whatsapp: adapter,
			capture: capturePort as any,
		});

		const res = await executeAction(ingestAction, {
			since: "2026-10-24",
			dry_run: true,
		});
		expect(res.matchedCount).toBe(1);
		expect(res.matchedMessageCount).toBe(1);
		expect(res.ingested[0]).toContain("2026-10-25 [Alice Smith]");
	});
});
