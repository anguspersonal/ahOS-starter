import type {
	SlackMessageDeleteInput,
	SlackMessageDeleteOutput,
	SlackMessageUpdateInput,
	SlackMessageUpdateOutput,
	SlackReactionAddInput,
	SlackReactionAddOutput,
	SlackWriteIdentity,
	SlackWritePort,
} from "../../ports/slack.js";
import type { SlackAdapterOptions, SlackTokenFn } from "./index.js";

const DEFAULT_SLACK_API = "https://slack.com/api";
const DEFAULT_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 30_000;

export interface SlackWriteTokens {
	userToken: SlackTokenFn;
	botToken: SlackTokenFn;
}

export interface SlackWriteAdapterOptions extends SlackAdapterOptions {
	sleep?: (ms: number) => Promise<void>;
}

interface SlackWriteWireResponse {
	ok: boolean;
	error?: string;
	needed?: string;
	channel?: string;
	ts?: string;
}

const redactToken = (text: string, token: string): string =>
	token ? text.split(token).join("[REDACTED]") : text;

function parseRetryAfterMs(header: string | null): number {
	const seconds = Number(header?.trim() || Number.NaN);
	return Number.isFinite(seconds) && seconds >= 0
		? Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS)
		: DEFAULT_RETRY_AFTER_MS;
}

function writeErrorHint(method: string, identity: SlackWriteIdentity, error?: string, needed?: string): string {
	if (error === "cant_update_message" || error === "cant_delete_message") {
		const other: SlackWriteIdentity = identity === "owner" ? "ahos_bot" : "owner";
		return ` (this message was not posted by ${identity}; pass as='${other}')`;
	}
	if (error === "not_allowed_token_type") return " (this needs a USER token, xoxp-, not a bot token)";
	if (error === "missing_scope") {
		return ` (the token needs the \`${needed || (method === "reactions.add" ? "reactions:write" : "chat:write")}\` scope)`;
	}
	if (error === "not_in_channel") {
		return identity === "ahos_bot" ? " (invite the ahOS bot to the channel first)" : " (join the channel first)";
	}
	if (error === "channel_not_found") return " (pass a Slack channel ID such as C0123456789)";
	return "";
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createSlackWriteAdapter(
	tokens: SlackWriteTokens,
	options: SlackWriteAdapterOptions = {},
): SlackWritePort {
	const baseUrl = (options.baseUrl ?? DEFAULT_SLACK_API).replace(/\/+$/, "");

	async function postJson(
		method: string,
		identity: SlackWriteIdentity,
		payload: Record<string, unknown>,
		benignError?: string,
	): Promise<{ benign: boolean; body: SlackWriteWireResponse }> {
		const rawToken = await (identity === "ahos_bot" ? tokens.botToken : tokens.userToken)();
		const token = typeof rawToken === "string" ? rawToken.trim() : "";
		if (!token) {
			throw new Error(
				identity === "ahos_bot"
					? "Missing Slack bot token (SLACK_TOKEN_BOT_OAUTH)."
					: "Missing Slack user OAuth credential (SLACK_TOKEN_USER_OAUTH).",
			);
		}
		const fetchFn = options.fetch ?? globalThis.fetch;
		const init: RequestInit = {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
			body: JSON.stringify(payload),
		};

		let res: Response;
		try {
			res = await fetchFn(`${baseUrl}/${method}`, init);
			if (res.status === 429) {
				await (options.sleep ?? defaultSleep)(parseRetryAfterMs(res.headers.get("retry-after")));
				res = await fetchFn(`${baseUrl}/${method}`, init);
			}
		} catch (err) {
			throw new Error(redactToken(err instanceof Error ? err.message : String(err), token));
		}

		const bodyText = await res.text().catch(() => "");
		let parsed: SlackWriteWireResponse = { ok: false };
		try {
			if (bodyText) parsed = JSON.parse(bodyText) as SlackWriteWireResponse;
		} catch {
			// Non-JSON body surfaces safely below.
		}

		if (res.ok && !parsed.ok && benignError && parsed.error === benignError) {
			return { benign: true, body: parsed };
		}
		if (!res.ok || !parsed.ok) {
			const detail = parsed.error || bodyText.slice(0, 600) || res.statusText || "unknown_error";
			throw new Error(
				redactToken(
					`Slack ${method} failed${res.ok ? "" : ` (HTTP ${res.status})`}: ${detail}${writeErrorHint(method, identity, parsed.error, parsed.needed)}`,
					token,
				),
			);
		}
		return { benign: false, body: parsed };
	}

	return {
		async updateMessage(input: SlackMessageUpdateInput): Promise<SlackMessageUpdateOutput> {
			const { body } = await postJson("chat.update", input.as ?? "owner", {
				channel: input.channel,
				ts: input.ts,
				text: input.text,
			});
			return { channel_id: body.channel ?? input.channel, ts: body.ts ?? input.ts };
		},
		async deleteMessage(input: SlackMessageDeleteInput): Promise<SlackMessageDeleteOutput> {
			const { benign } = await postJson(
				"chat.delete",
				input.as ?? "owner",
				{ channel: input.channel, ts: input.ts },
				"message_not_found",
			);
			return { deleted: !benign };
		},
		async addReaction(input: SlackReactionAddInput): Promise<SlackReactionAddOutput> {
			const cleanName = input.name.trim().replace(/^:+|:+$/g, "");
			if (!cleanName) throw new Error("Slack reaction name must not be empty.");
			const { benign } = await postJson(
				"reactions.add",
				"owner",
				{ channel: input.channel, timestamp: input.ts, name: cleanName },
				"already_reacted",
			);
			return { added: !benign };
		},
	};
}
