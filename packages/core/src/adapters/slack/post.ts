import type { SlackPostMessageOptions, SlackPostMessageResult, SlackPostPort } from "../../ports/slack.js";
import type { SlackAdapterOptions, SlackTokenFn } from "./index.js";

export type { SlackPostMessageOptions, SlackPostMessageResult, SlackPostPort };

// Thin Slack Web API client for posting messages (#647, #1527, #1657). Uses a BOT
// token (xoxb-, SLACK_TOKEN_BOT_OAUTH) with chat:write scope.

const DEFAULT_SLACK_API = "https://slack.com/api";
const DEFAULT_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 30_000;

export interface SlackPostAdapterOptions extends SlackAdapterOptions {
	sleep?: (ms: number) => Promise<void>;
}

interface SlackChatPostMessageResponse {
	ok: boolean;
	error?: string;
	channel?: string;
	ts?: string;
	thread_ts?: string;
	message?: { thread_ts?: string };
}

function redactToken(text: string, token: string): string {
	if (!token) return text;
	return text.split(token).join("[REDACTED]");
}

function parseRetryAfterMs(header: string | null): number {
	const seconds = Number(header?.trim() || Number.NaN);
	return Number.isFinite(seconds) && seconds >= 0
		? Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS)
		: DEFAULT_RETRY_AFTER_MS;
}

function postErrorHint(error?: string): string {
	if (error === "not_in_channel") return " (invite the ahOS bot to the channel first)";
	if (error === "channel_not_found") {
		return " (check the channel ID or name, and invite the ahOS bot if the channel is private)";
	}
	return "";
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createSlackPostAdapter(
	getToken: SlackTokenFn,
	options: SlackPostAdapterOptions = {},
): SlackPostPort {
	const baseUrl = (options.baseUrl ?? DEFAULT_SLACK_API).replace(/\/+$/, "");

	return {
		async postMessage(
			channel: string,
			text: string,
			postOptions: SlackPostMessageOptions = {},
		): Promise<SlackPostMessageResult> {
			const rawToken = await getToken();
			const token = typeof rawToken === "string" ? rawToken.trim() : "";
			if (!token) {
				throw new Error("Missing Slack bot token (SLACK_TOKEN_BOT_OAUTH).");
			}
			const fetchFn = options.fetch ?? globalThis.fetch;
			const unfurl = Boolean(postOptions.unfurl);
			const payload: Record<string, unknown> = {
				channel,
				text,
				unfurl_links: unfurl,
				unfurl_media: unfurl,
				...(postOptions.threadTs ? { thread_ts: postOptions.threadTs } : {}),
				...(postOptions.replyBroadcast === true ? { reply_broadcast: true } : {}),
			};
			const init: RequestInit = {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json; charset=utf-8",
				},
				body: JSON.stringify(payload),
			};

			let res: Response;
			try {
				res = await fetchFn(`${baseUrl}/chat.postMessage`, init);
				if (res.status === 429) {
					await (options.sleep ?? defaultSleep)(parseRetryAfterMs(res.headers.get("retry-after")));
					res = await fetchFn(`${baseUrl}/chat.postMessage`, init);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(redactToken(msg, token));
			}

			const bodyText = await res.text().catch(() => "");
			let parsed: SlackChatPostMessageResponse = { ok: false };
			try {
				parsed = bodyText
					? (JSON.parse(bodyText) as SlackChatPostMessageResponse)
					: { ok: false };
			} catch {
				// Non-JSON body: fall through and surface the raw text below.
			}

			if (!res.ok || !parsed.ok) {
				const detail = parsed.error || bodyText.slice(0, 600) || res.statusText || "unknown_error";
				throw new Error(
					redactToken(
						`Slack chat.postMessage failed${res.ok ? "" : ` (HTTP ${res.status})`}: ${detail}${postErrorHint(parsed.error)}`,
						token,
					),
				);
			}

			const channelId = parsed.channel ?? channel;
			const ts = parsed.ts ?? "";
			const threadTs = parsed.message?.thread_ts ?? parsed.thread_ts ?? postOptions.threadTs ?? null;
			let permalink: string | null = null;
			if (channelId && ts) {
				try {
					const query = new URLSearchParams({ channel: channelId, message_ts: ts }).toString();
					const permRes = await fetchFn(`${baseUrl}/chat.getPermalink?${query}`, {
						headers: { Authorization: `Bearer ${token}` },
					});
					if (permRes.ok) {
						const permBody = (await permRes.json()) as { ok?: boolean; permalink?: string };
						if (permBody.ok && permBody.permalink) permalink = permBody.permalink;
					}
				} catch {
					// Permalink lookup is best-effort; never fail a completed post.
				}
			}

			return { channel_id: channelId, ts, thread_ts: threadTs, permalink };
		},
	};
}
