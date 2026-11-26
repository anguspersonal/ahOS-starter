import { z } from "zod";
import { defineAction } from "../defineAction.js";
import { ARTIFACT_SURFACES, deriveTitleFromText, slugify } from "../../domain/artifacts.js";
import { whatsappConfigSchema, type WhatsappConfig } from "../../domain/integrations.js";
import type { CapturePort } from "../../ports/artifacts.js";
import type { ConfigRepository } from "../../ports/config.js";
import {
	normalizeWhatsappJid,
	type WhatsappMessage,
	type WhatsappPort,
} from "../../ports/whatsapp.js";

export const WHATSAPP_MESSAGE_CONTENT_SUBTYPE = "whatsapp_message";

export interface WhatsappChatDayBucket {
	chatJid: string;
	chatName: string;
	chatKind: WhatsappMessage["chatKind"];
	day: string;
	messages: WhatsappMessage[];
	fromMeCount: number;
	firstTimestamp: string;
	lastTimestamp: string;
}

export function whatsappDedupKey(chatJid: string, day: string): string {
	return `whatsapp:${chatJid}:${day}`;
}

export function describeWhatsappMessage(msg: WhatsappMessage): string {
	const who = msg.fromMe ? "Me" : msg.senderName || msg.senderJid || msg.chatName;
	const firstLine = msg.text.split("\n")[0]?.slice(0, 80) ?? "";
	return `${msg.timestamp.slice(0, 16).replace("T", " ")} [${msg.chatName}] ${who}: ${firstLine}`;
}

export function describeWhatsappDayBucket(bucket: WhatsappChatDayBucket): string {
	const leadMsg = bucket.messages.find((m) => m.fromMe) ?? bucket.messages[0];
	const firstLine = leadMsg ? (leadMsg.text.split("\n")[0]?.slice(0, 70) ?? "") : "";
	return `${bucket.day} [${bucket.chatName}] (${bucket.messages.length} msg${bucket.messages.length === 1 ? "" : "s"}, ${bucket.fromMeCount} from me): ${firstLine}`;
}

export function buildWhatsappDailyArtifactTitle(bucket: WhatsappChatDayBucket): string {
	const leadMsg = bucket.messages.find((m) => m.fromMe) ?? bucket.messages[0];
	const snippet = deriveTitleFromText(leadMsg?.text ?? "", 70) ?? "(conversation)";
	return `WhatsApp (${bucket.chatName} · ${bucket.day}): ${snippet}`;
}

export function buildWhatsappDailyArtifactBody(bucket: WhatsappChatDayBucket): string {
	const lines: string[] = [
		`WhatsApp daily transcript in ${bucket.chatName} (${bucket.chatKind}, ${bucket.chatJid})`,
		`Date: ${bucket.day}`,
		`Messages: ${bucket.messages.length} (${bucket.fromMeCount} sent by me, ${bucket.messages.length - bucket.fromMeCount} received)`,
		`Window: ${bucket.firstTimestamp} → ${bucket.lastTimestamp}`,
		"",
	];

	for (const msg of bucket.messages) {
		const timePart = msg.timestamp.slice(11, 19) || msg.timestamp;
		const who = msg.fromMe
			? "Me"
			: msg.senderName || msg.senderJid || bucket.chatName;
		if (msg.quotedText) {
			const quotedSingleLine = msg.quotedText.replace(/\s+/g, " ").trim().slice(0, 140);
			lines.push(`> Replying to: ${quotedSingleLine}`);
		}
		const mediaPrefix = msg.mediaType ? `[${msg.mediaType}] ` : "";
		lines.push(`[${timePart}] **${who}**: ${mediaPrefix}${msg.text.trim()}`);
	}

	return lines.join("\n");
}

export function groupWhatsappMessagesByChatDay(
	messages: WhatsappMessage[],
	options: {
		fromMeOnly: boolean;
		query?: string;
		since?: string;
		until?: string;
	},
): WhatsappChatDayBucket[] {
	const byChatDay = new Map<string, Map<string, WhatsappMessage>>();

	for (const msg of messages) {
		if (!msg.text.trim()) continue;
		const day = msg.timestamp.slice(0, 10);
		if (!day) continue;
		const key = `${msg.chatJid}\u0000${day}`;
		let msgMap = byChatDay.get(key);
		if (!msgMap) {
			msgMap = new Map<string, WhatsappMessage>();
			byChatDay.set(key, msgMap);
		}
		msgMap.set(msg.id, msg);
	}

	const qLower = options.query?.trim().toLowerCase();
	const sinceIso = options.since
		? options.since.length === 10
			? `${options.since}T00:00:00.000Z`
			: options.since
		: null;
	const untilIso = options.until
		? options.until.length === 10
			? `${options.until}T23:59:59.999Z`
			: options.until
		: null;

	const buckets: WhatsappChatDayBucket[] = [];

	for (const msgMap of byChatDay.values()) {
		const sorted = [...msgMap.values()].sort(
			(a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id),
		);
		if (sorted.length === 0) continue;

		// Ensure at least one message in the bucket falls within the requested [since, until] window
		const hasMsgInWindow = sorted.some((m) => {
			if (sinceIso && m.timestamp < sinceIso) return false;
			if (untilIso && m.timestamp > untilIso) return false;
			return true;
		});
		if (!hasMsgInWindow) continue;

		const fromMeCount = sorted.filter((m) => m.fromMe).length;
		// Participated-thread rule: when `fromMeOnly` is true, a (chat, day) bucket qualifies
		// iff the owner sent at least one message in that chat on that day. Once qualified,
		// the full day's exchange in that chat is preserved so questions and replies stay paired.
		if (options.fromMeOnly && fromMeCount === 0) continue;

		if (qLower) {
			const matchesQuery = sorted.some(
				(m) =>
					m.text.toLowerCase().includes(qLower) ||
					m.chatName.toLowerCase().includes(qLower) ||
					(m.senderName?.toLowerCase().includes(qLower) ?? false),
			);
			if (!matchesQuery) continue;
		}

		const first = sorted[0]!;
		const last = sorted[sorted.length - 1]!;
		buckets.push({
			chatJid: first.chatJid,
			chatName: first.chatName,
			chatKind: first.chatKind,
			day: first.timestamp.slice(0, 10),
			messages: sorted,
			fromMeCount,
			firstTimestamp: first.timestamp,
			lastTimestamp: last.timestamp,
		});
	}

	return buckets.sort(
		(a, b) =>
			b.day.localeCompare(a.day) ||
			b.lastTimestamp.localeCompare(a.lastTimestamp) ||
			a.chatJid.localeCompare(b.chatJid),
	);
}

export const whatsappIngestInput = {
	chat_jid: z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe(
			"Optional chat JID or chat name substring to ingest from. Omit to sweep across all allowed chats.",
		),
	query: z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe("Optional keyword filter so only matching daily chat transcripts are ingested."),
	since: z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe(
			"ISO date (YYYY-MM-DD) or ISO timestamp lower bound. Defaults to 7 days ago. Re-running an overlapping window is safe: daily transcripts deduplicate on `whatsapp:<chatJid>:<YYYY-MM-DD>` and update in-place when new messages arrive later that day.",
		),
	until: z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe("ISO date (YYYY-MM-DD) or ISO timestamp upper bound. Defaults to open-ended."),
	from_me_only: z
		.boolean()
		.optional()
		.describe(
			"When true, ingest only (chat, day) transcripts where the owner sent at least 1 message (`fromMe: true`), preserving the full day's replies in those participated chats. Defaults to `user_integrations.whatsapp.config.ingest_from_me_only` if configured, else false when `chat_jid` is specified or true on a whole-store sweep.",
		),
	max_results: z
		.number()
		.int()
		.min(1)
		.max(500)
		.optional()
		.describe("Maximum daily chat transcripts to ingest in this sweep (default 100, max 500)."),
	dry_run: z
		.boolean()
		.optional()
		.describe("List what WOULD be ingested without writing any artifacts."),
	sync: z
		.boolean()
		.optional()
		.describe("When true, run a short Baileys companion sync before sweeping messages."),
} as const;

export const whatsappIngestSchema = z.object(whatsappIngestInput);
export type WhatsappIngestInput = z.infer<typeof whatsappIngestSchema>;

export interface WhatsappIngestResult {
	since: string;
	until: string | null;
	dryRun: boolean;
	fromMeOnly: boolean;
	matchedCount: number;
	matchedMessageCount: number;
	ingestedCount: number;
	updatedCount: number;
	deduplicatedCount: number;
	dmCount: number;
	ingested: string[];
	failed: string[];
}

export interface WhatsappIngestDeps {
	whatsapp: WhatsappPort;
	capture: Pick<CapturePort, "capture">;
	config?: Pick<ConfigRepository, "loadConfig">;
}

export function formatWhatsappIngestMcp(result: WhatsappIngestResult): string {
	const header = `${result.matchedCount} WhatsApp daily chat transcript(s) (${result.matchedMessageCount} message(s)) matched since ${result.since}${
		result.until ? ` until ${result.until}` : ""
	} (${result.fromMeOnly ? "participated chats only" : "all active chats"}): ${result.ingestedCount} new, ${
		result.updatedCount
	} updated in-place, ${result.deduplicatedCount} unchanged.`;

	if (result.dryRun) {
		return [
			header,
			"",
			"DRY RUN, nothing written. Would ingest/update:",
			...(result.ingested.length ? result.ingested.map((line) => `  • ${line}`) : ["  (none)"]),
		].join("\n");
	}

	const surfaceNote =
		result.dmCount > 0
			? `${result.dmCount} transcript(s) were in 1:1 or self-chats and landed on surface '${ARTIFACT_SURFACES.whatsappDm}'; group transcripts landed on '${ARTIFACT_SURFACES.whatsapp}'.`
			: `Stamped surface '${ARTIFACT_SURFACES.whatsapp}'.`;

	return [
		header,
		"",
		`Ingested/updated ${result.ingested.length}:`,
		...(result.ingested.length ? result.ingested.map((line) => `  • ${line}`) : ["  (none)"]),
		...(result.failed.length
			? ["", `FAILED ${result.failed.length}, re-run to retry:`, ...result.failed.map((l) => `  - ${l}`)]
			: []),
		"",
		`${surfaceNote} Both surfaces floor at synthesis role 'evidence' (ADR-046 §3).`,
	].join("\n");
}

export function createWhatsappIngestAction(deps: WhatsappIngestDeps) {
	return defineAction({
		id: "whatsapp_ingest",
		domain: "integrations",
		description:
			"Ingest synced WhatsApp messages into ahKMS grouped into one daily transcript artifact per `(chatJid, YYYY-MM-DD)`. Deduplicates on `whatsapp:<chatJid>:<YYYY-MM-DD>`, updates existing daily transcripts in-place when late messages arrive, and splits 1:1/self-chats (`whatsapp_dm`) from group chats (`whatsapp`) so ADR-046 §3 role policies can govern them independently.",
		schema: whatsappIngestSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (input, ctx): Promise<WhatsappIngestResult> => {
			const since =
				input.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
			const maxResults = input.max_results ?? 100;

			let storedConfig: WhatsappConfig | null = null;
			if (deps.config) {
				try {
					storedConfig = await deps.config.loadConfig("whatsapp", whatsappConfigSchema);
				} catch {
					storedConfig = null;
				}
			}

			// Default privacy boundary: if the caller didn't specify `from_me_only`, check
			// `user_integrations.whatsapp.config.ingest_from_me_only`. If that's also unset,
			// default to `true` (participated chats where the owner spoke at least once that day)
			// on a broad sweep, or `false` (all active chats) when the caller explicitly targeted
			// a single `chat_jid`.
			const fromMeOnly =
				input.from_me_only ??
				storedConfig?.ingest_from_me_only ??
				(input.chat_jid ? false : true);

			// Fetch from the start of the `since` UTC day (`YYYY-MM-DD`) with `fromMe: undefined`
			// so that:
			//  1. Participated-thread filtering (`fromMeOnly: true`) can include the other party's
			//     replies on days where the owner spoke.
			//  2. If `since` is a mid-day timestamp (e.g. 23:00 on Day 1), any day bucket touched
			//     by new late-night messages still contains the full day's earlier messages when
			//     updating the daily transcript in-place.
			const fetchSinceDay = since.slice(0, 10);
			const rawMessages = await deps.whatsapp.listMessages({
				chatJid: input.chat_jid,
				since: fetchSinceDay,
				until: input.until,
				fromMe: undefined,
				limit: 0,
				sync: input.sync,
			});

			const allowedSet =
				storedConfig?.allowed_chat_jids && storedConfig.allowed_chat_jids.length > 0
					? new Set(
							storedConfig.allowed_chat_jids
								.map((jid) => normalizeWhatsappJid(jid))
								.filter(Boolean),
						)
					: null;
			const excludedSet =
				storedConfig?.excluded_chat_jids && storedConfig.excluded_chat_jids.length > 0
					? new Set(
							storedConfig.excluded_chat_jids
								.map((jid) => normalizeWhatsappJid(jid))
								.filter(Boolean),
						)
					: null;

			const allowedMessages = rawMessages.filter((m) => {
				if (!m.text.trim()) return false;
				const normChatJid = normalizeWhatsappJid(m.chatJid);
				if (excludedSet?.has(normChatJid)) return false;
				if (allowedSet && !allowedSet.has(normChatJid)) return false;
				return true;
			});

			const buckets = groupWhatsappMessagesByChatDay(allowedMessages, {
				fromMeOnly,
				query: input.query,
				since,
				until: input.until,
			}).slice(0, maxResults);

			const matchedMessageCount = buckets.reduce((acc, b) => acc + b.messages.length, 0);

			if (input.dry_run) {
				const previews = buckets.map(describeWhatsappDayBucket);
				const dmCount = buckets.filter((b) => b.chatKind === "dm" || b.chatKind === "self").length;
				return {
					since,
					until: input.until ?? null,
					dryRun: true,
					fromMeOnly,
					matchedCount: buckets.length,
					matchedMessageCount,
					ingestedCount: buckets.length,
					updatedCount: 0,
					deduplicatedCount: 0,
					dmCount,
					ingested: previews,
					failed: [],
				};
			}

			const ingested: string[] = [];
			const failed: string[] = [];
			let ingestedCount = 0;
			let updatedCount = 0;
			let deduplicatedCount = 0;
			let dmCount = 0;

			for (const bucket of buckets) {
				const isDm = bucket.chatKind === "dm" || bucket.chatKind === "self";
				const surface = isDm ? ARTIFACT_SURFACES.whatsappDm : ARTIFACT_SURFACES.whatsapp;
				const chatSlug = slugify(bucket.chatName);
				try {
					const res = await deps.capture.capture(
						{
							title: buildWhatsappDailyArtifactTitle(bucket),
							text: buildWhatsappDailyArtifactBody(bucket),
							surface,
							captured_by: "whatsapp_ingest",
							content_subtype: WHATSAPP_MESSAGE_CONTENT_SUBTYPE,
							dedup_key: whatsappDedupKey(bucket.chatJid, bucket.day),
							tags: [
								"whatsapp",
								`chat:${chatSlug}`,
								`kind:${bucket.chatKind}`,
								`sent:${bucket.day}`,
								bucket.fromMeCount > 0 ? "direction:participated" : "direction:inbound-only",
							],
							processing_metadata: {
								whatsapp_chat_jid: bucket.chatJid,
								whatsapp_chat_name: bucket.chatName,
								whatsapp_chat_kind: bucket.chatKind,
								whatsapp_day: bucket.day,
								whatsapp_message_count: bucket.messages.length,
								whatsapp_from_me_count: bucket.fromMeCount,
								whatsapp_first_timestamp: bucket.firstTimestamp,
								whatsapp_last_timestamp: bucket.lastTimestamp,
								whatsapp_message_ids: bucket.messages.map((m) => m.id),
							},
						},
						ctx.userId,
						{ updateOnDedupKey: true },
					);
					if (res.deduplicated) {
						deduplicatedCount++;
					} else if (res.updated) {
						updatedCount++;
						ingested.push(`(updated) ${describeWhatsappDayBucket(bucket)}`);
						if (isDm) dmCount++;
					} else {
						ingestedCount++;
						ingested.push(describeWhatsappDayBucket(bucket));
						if (isDm) dmCount++;
					}
				} catch (err) {
					failed.push(
						`${bucket.chatName} (${bucket.day}): ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}

			return {
				since,
				until: input.until ?? null,
				dryRun: false,
				fromMeOnly,
				matchedCount: buckets.length,
				matchedMessageCount,
				ingestedCount,
				updatedCount,
				deduplicatedCount,
				dmCount,
				ingested,
				failed,
			};
		},
		formatMcp: formatWhatsappIngestMcp,
	});
}
