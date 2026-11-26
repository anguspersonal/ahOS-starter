import type {
	SlackChannelMessage,
	SlackMessage,
	SlackPort,
	SlackReadChannelInput,
	SlackReadChannelOutput,
	SlackReadPort,
	SlackReadThreadInput,
	SlackReadThreadOutput,
	SlackSearchInput,
	SlackSearchOptions,
	SlackSearchOutput,
	SlackViewer,
} from "../../ports/slack.js";

export type {
	SlackChannelMessage,
	SlackMessage,
	SlackPort,
	SlackReadChannelInput,
	SlackReadChannelOutput,
	SlackReadPort,
	SlackReadThreadInput,
	SlackReadThreadOutput,
	SlackSearchInput,
	SlackSearchOptions,
	SlackSearchOutput,
	SlackViewer,
};

// Thin Slack Web API client for the ingest path (#1011, #1535) and interactive read/search
// actions (#2008, ADR-113). Raw fetch, stubbable, same posture as github/activity.ts and
// google/gmail.ts.
//
// READ ONLY, and a USER token rather than a bot token. Two independent reasons, both
// hard constraints rather than preferences:
//   1. `search.messages` is not available to bot tokens at all.
//   2. Only a user token can see the owner's DMs, which is what this was asked to cover.
//
// Slack answers 200 with `{ok: false, error: "..."}` for application errors, so an
// HTTP-status-only check would read `not_authed` as success and ingest nothing while
// reporting fine.

const DEFAULT_SLACK_API = "https://slack.com/api";

export type SlackTokenFn = () => Promise<string>;

export interface SlackAdapterOptions {
	fetch?: typeof globalThis.fetch;
	baseUrl?: string;
}

function redactToken(text: string, token: string): string {
	if (!token) return text;
	return text.split(token).join("[REDACTED]");
}

function missingScopeHint(method: string, needed?: string): string {
	if (needed) {
		return ` (the token needs the \`${needed}\` scope)`;
	}
	if (method === "search.messages") {
		return " (the token needs the `search:read` scope)";
	}
	return " (the token needs `channels:history`, `groups:history`, `im:history`, `mpim:history`, `channels:read`, `groups:read` scopes)";
}

export type SearchMatchWire = {
	permalink?: string;
	text?: string;
	ts?: string;
	username?: string;
	channel?: { id?: string; name?: string; is_im?: boolean; is_mpim?: boolean };
};

export type ChannelMessageWire = {
	ts?: string;
	user?: string;
	bot_id?: string;
	username?: string;
	text?: string;
	thread_ts?: string;
	reply_count?: number;
};

/**
 * A channel name Slack does not supply for DMs.
 *
 * `search.messages` returns an empty `name` for an IM, so a DM would otherwise be
 * captured as being in a channel called "". The id is the only honest label available
 * without a second lookup per message.
 */
function channelLabel(c: SearchMatchWire["channel"], isDm: boolean): string {
	if (c?.name) return c.name;
	return isDm ? `dm:${c?.id ?? "unknown"}` : (c?.id ?? "unknown");
}

export function parseMatch(m: SearchMatchWire): SlackMessage {
	const isDm = Boolean(m.channel?.is_im || m.channel?.is_mpim);
	const tsSeconds = Number.parseFloat(m.ts ?? "0");
	return {
		permalink: m.permalink ?? "",
		text: m.text ?? "",
		channelId: m.channel?.id ?? "",
		channelName: channelLabel(m.channel, isDm),
		isDm,
		ts: m.ts ?? "",
		sentAt:
			Number.isFinite(tsSeconds) && tsSeconds > 0
				? new Date(tsSeconds * 1000).toISOString()
				: "",
		username: m.username ?? "",
	};
}

export function parseChannelMessage(m: ChannelMessageWire): SlackChannelMessage {
	const tsSeconds = Number.parseFloat(m.ts ?? "0");
	const out: SlackChannelMessage = {
		ts: m.ts ?? "",
		sentAt:
			Number.isFinite(tsSeconds) && tsSeconds > 0
				? new Date(tsSeconds * 1000).toISOString()
				: "",
		user: m.user ?? m.bot_id ?? "",
		text: m.text ?? "",
	};
	if (m.username) out.username = m.username;
	if (m.thread_ts) out.threadTs = m.thread_ts;
	if (typeof m.reply_count === "number") out.replyCount = m.reply_count;
	return out;
}

/**
 * Converts a Slack timestamp (`1700000000.000100`) or ISO-8601 date/timestamp
 * (`2026-10-01` or `2026-10-01T12:00:00Z`) into a Slack epoch-seconds string.
 */
export function toSlackTimestamp(value: string, opts: { endOfDay?: boolean } = {}): string {
	const trimmed = value.trim();
	if (/^\d+(\.\d+)?$/.test(trimmed)) {
		return trimmed;
	}
	const isoString = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
		? `${trimmed}T${opts.endOfDay ? "23:59:59.999Z" : "00:00:00.000Z"}`
		: trimmed;
	const ms = Date.parse(isoString);
	if (Number.isNaN(ms)) {
		throw new Error(`Invalid Slack timestamp or ISO-8601 date: "${value}"`);
	}
	return (ms / 1000).toFixed(6);
}

/** Slack's after: is exclusive, so step back a day to make `since` inclusive. */
export function dayBefore(isoDate: string): string {
	const d = new Date(`${isoDate}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - 1);
	return d.toISOString().slice(0, 10);
}

/** Slack's before: is exclusive, so step forward a day to make `until` inclusive. */
export function dayAfter(isoDate: string): string {
	const d = new Date(`${isoDate}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + 1);
	return d.toISOString().slice(0, 10);
}

export interface SlackAdapter extends SlackPort, SlackReadPort {
	resolveSlackChannelId(channel: string): Promise<string>;
}

export function createSlackAdapter(
	getToken: SlackTokenFn,
	options: SlackAdapterOptions = {},
): SlackAdapter {
	const baseUrl = (options.baseUrl ?? DEFAULT_SLACK_API).replace(/\/+$/, "");

	async function slackGet<T>(method: string, params: Record<string, string>): Promise<T> {
		const rawToken = await getToken();
		const token = typeof rawToken === "string" ? rawToken.trim() : "";
		if (!token) {
			throw new Error("Missing Slack user OAuth credential.");
		}
		const fetchFn = options.fetch ?? globalThis.fetch;
		const query = new URLSearchParams(params).toString();
		const url = query ? `${baseUrl}/${method}?${query}` : `${baseUrl}/${method}`;

		let res: Response;
		try {
			res = await fetchFn(url, {
				headers: { Authorization: `Bearer ${token}` },
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(redactToken(msg, token));
		}

		if (!res.ok) {
			throw new Error(
				redactToken(
					`Slack ${method} failed with HTTP ${res.status}: ${res.statusText}`,
					token,
				),
			);
		}

		const body = (await res.json()) as { ok?: boolean; error?: string; needed?: string };
		if (!body.ok) {
			// `not_allowed_token_type` is the signature of a bot token where a user token is
			// required, and is worth naming because the fix is a different token, not a scope.
			const hint =
				body.error === "not_allowed_token_type"
					? " (this needs a USER token, xoxp-, not a bot token)"
					: body.error === "missing_scope"
						? missingScopeHint(method, body.needed)
						: "";
			throw new Error(
				redactToken(
					`Slack ${method} returned not-ok: ${body.error ?? "unknown"}${hint}`,
					token,
				),
			);
		}
		return body as T;
	}

	async function resolveSlackChannelId(channel: string): Promise<string> {
		const trimmed = channel.trim();
		if (/^[CGDW][A-Z0-9]{6,}$/.test(trimmed)) {
			return trimmed;
		}
		const targetName = trimmed.replace(/^#/, "").toLowerCase();
		let cursor: string | undefined;
		for (let page = 0; page < 5; page += 1) {
			const params: Record<string, string> = {
				types: "public_channel,private_channel",
				exclude_archived: "false",
				limit: "1000",
			};
			if (cursor) params.cursor = cursor;
			const res = await slackGet<{
				channels?: Array<{ id?: string; name?: string }>;
				response_metadata?: { next_cursor?: string };
			}>("conversations.list", params);
			const found = (res.channels ?? []).find(
				(c) => c.name?.toLowerCase() === targetName && Boolean(c.id),
			);
			if (found?.id) {
				return found.id;
			}
			const next = res.response_metadata?.next_cursor?.trim();
			if (!next) break;
			cursor = next;
		}
		throw new Error(
			`Slack channel "${channel}" could not be resolved via conversations.list; pass the channel ID (e.g. C0123456789) directly.`,
		);
	}

	return {
		resolveSlackChannelId,

		async viewer(): Promise<SlackViewer> {
			const res = await slackGet<{ user?: string; team?: string }>("auth.test", {});
			if (!res.user) throw new Error("Slack auth.test returned no user for this token.");
			return { login: res.user, teamName: res.team ?? "" };
		},

		async searchMyMessages(opts: SlackSearchOptions): Promise<SlackMessage[]> {
			const terms = [`from:@${opts.login}`, `after:${dayBefore(opts.since)}`];
			if (opts.until) terms.push(`before:${dayAfter(opts.until)}`);
			if (opts.channel) terms.push(`in:#${opts.channel}`);

			const res = await slackGet<{ messages?: { matches?: SearchMatchWire[] } }>(
				"search.messages",
				{ query: terms.join(" "), count: String(opts.count), sort: "timestamp" },
			);

			return (res.messages?.matches ?? [])
				.map(parseMatch)
				.filter((m) => m.permalink !== "");
		},

		async readChannel(input: SlackReadChannelInput): Promise<SlackReadChannelOutput> {
			const channelId = await resolveSlackChannelId(input.channel);
			const params: Record<string, string> = {
				channel: channelId,
				limit: String(input.limit ?? 20),
				inclusive: "true",
			};
			if (input.oldest) {
				params.oldest = toSlackTimestamp(input.oldest, { endOfDay: false });
			}
			if (input.latest) {
				params.latest = toSlackTimestamp(input.latest, { endOfDay: true });
			}
			if (input.cursor) {
				params.cursor = input.cursor;
			}

			const res = await slackGet<{
				messages?: ChannelMessageWire[];
				has_more?: boolean;
				response_metadata?: { next_cursor?: string };
			}>("conversations.history", params);

			const nextCursor = res.response_metadata?.next_cursor?.trim() || null;
			return {
				channelId,
				messages: (res.messages ?? []).map(parseChannelMessage),
				hasMore: Boolean(res.has_more),
				nextCursor,
			};
		},

		async readThread(input: SlackReadThreadInput): Promise<SlackReadThreadOutput> {
			const channelId = await resolveSlackChannelId(input.channel);
			const params: Record<string, string> = {
				channel: channelId,
				ts: input.threadTs,
				limit: String(input.limit ?? 50),
				inclusive: "true",
			};
			if (input.cursor) {
				params.cursor = input.cursor;
			}

			const res = await slackGet<{
				messages?: ChannelMessageWire[];
				has_more?: boolean;
				response_metadata?: { next_cursor?: string };
			}>("conversations.replies", params);

			const nextCursor = res.response_metadata?.next_cursor?.trim() || null;
			return {
				channelId,
				threadTs: input.threadTs,
				messages: (res.messages ?? []).map(parseChannelMessage),
				hasMore: Boolean(res.has_more),
				nextCursor,
			};
		},

		async searchMessages(input: SlackSearchInput): Promise<SlackSearchOutput> {
			const res = await slackGet<{
				messages?: { total?: number; matches?: SearchMatchWire[] };
			}>("search.messages", {
				query: input.query,
				count: String(input.count ?? 20),
				sort: input.sort ?? "timestamp",
				sort_dir: input.sortDir ?? "desc",
			});

			const matches = (res.messages?.matches ?? [])
				.map(parseMatch)
				.filter((m) => m.permalink !== "");

			return {
				query: input.query,
				matches,
				total: res.messages?.total ?? matches.length,
			};
		},
	};
}
