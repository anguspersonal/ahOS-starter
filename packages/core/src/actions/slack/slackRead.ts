import { z } from "zod";
import { defineAction } from "../defineAction.js";
import {
	SLACK_SEARCH_SORT_DIRS,
	SLACK_SEARCH_SORTS,
	type SlackReadChannelOutput,
	type SlackReadPort,
	type SlackReadThreadOutput,
	type SlackSearchOutput,
} from "../../ports/slack.js";

export const slackReadChannelInput = {
	channel: z
		.string()
		.trim()
		.min(1)
		.describe(
			"Slack channel ID (e.g. 'C0123456789', 'G...', 'D...') or channel name (e.g. '#general' or 'general').",
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(200)
		.optional()
		.describe("Maximum number of messages to return (1-200, default 20)."),
	oldest: z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe(
			"Inclusive lower bound: Slack message ts (e.g. '1700000000.000000') or ISO-8601 date/timestamp.",
		),
	latest: z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe(
			"Inclusive upper bound: Slack message ts (e.g. '1700000000.000000') or ISO-8601 date/timestamp.",
		),
	cursor: z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe("Pagination cursor returned as nextCursor from a previous call."),
} as const;

export const slackReadChannelSchema = z.object(slackReadChannelInput);
export type SlackReadChannelActionInput = z.infer<typeof slackReadChannelSchema>;

export const slackReadThreadInput = {
	channel: z
		.string()
		.trim()
		.min(1)
		.describe(
			"Slack channel ID (e.g. 'C0123456789', 'G...', 'D...') or channel name (e.g. '#general' or 'general').",
		),
	thread_ts: z
		.string()
		.trim()
		.min(1)
		.describe("Parent message timestamp (ts) identifying the thread (e.g. '1700000000.000100')."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(200)
		.optional()
		.describe("Maximum number of thread messages to return (1-200, default 50)."),
	cursor: z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe("Pagination cursor returned as nextCursor from a previous call."),
} as const;

export const slackReadThreadSchema = z.object(slackReadThreadInput);
export type SlackReadThreadActionInput = z.infer<typeof slackReadThreadSchema>;

export const slackSearchInput = {
	query: z
		.string()
		.trim()
		.min(1)
		.describe(
			"Slack search query (supports operators such as in:#channel, from:@user, after:YYYY-MM-DD, before:YYYY-MM-DD).",
		),
	count: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("Maximum number of matches to return (1-100, default 20)."),
	sort: z
		.enum(SLACK_SEARCH_SORTS)
		.optional()
		.describe("Sort field: 'timestamp' (default) or 'score'."),
	sort_dir: z
		.enum(SLACK_SEARCH_SORT_DIRS)
		.optional()
		.describe("Sort direction: 'desc' (default) or 'asc'."),
} as const;

export const slackSearchSchema = z.object(slackSearchInput);
export type SlackSearchActionInput = z.infer<typeof slackSearchSchema>;

export function formatSlackReadChannelMcp(result: SlackReadChannelOutput): string {
	if (result.messages.length === 0) {
		return `No messages found in channel ${result.channelId}.`;
	}
	const lines = [
		`Channel ${result.channelId} — ${result.messages.length} message(s)${result.hasMore ? ` (more available, nextCursor: ${result.nextCursor})` : ""}:`,
		"",
		...result.messages.map((m) => {
			const who = m.username || m.user || "unknown";
			const ts = m.sentAt ? m.sentAt.slice(0, 19).replace("T", " ") : m.ts;
			const threadMeta =
				m.replyCount && m.replyCount > 0
					? ` [thread_ts=${m.threadTs ?? m.ts}, ${m.replyCount} repl${m.replyCount === 1 ? "y" : "ies"}]`
					: m.threadTs && m.threadTs !== m.ts
						? ` [in thread ${m.threadTs}]`
						: "";
			return `[${ts} · ts=${m.ts}] ${who}${threadMeta}: ${m.text}`;
		}),
	];
	return lines.join("\n");
}

export function formatSlackReadThreadMcp(result: SlackReadThreadOutput): string {
	if (result.messages.length === 0) {
		return `No messages found in thread ${result.threadTs} (channel ${result.channelId}).`;
	}
	const lines = [
		`Thread ${result.threadTs} in ${result.channelId} — ${result.messages.length} message(s)${result.hasMore ? ` (more available, nextCursor: ${result.nextCursor})` : ""}:`,
		"",
		...result.messages.map((m) => {
			const who = m.username || m.user || "unknown";
			const ts = m.sentAt ? m.sentAt.slice(0, 19).replace("T", " ") : m.ts;
			return `[${ts} · ts=${m.ts}] ${who}: ${m.text}`;
		}),
	];
	return lines.join("\n");
}

export function formatSlackSearchMcp(result: SlackSearchOutput): string {
	if (result.matches.length === 0) {
		return `No Slack messages matched query "${result.query}".`;
	}
	const lines = [
		`Slack search "${result.query}" — showing ${result.matches.length} of ${result.total} match(es):`,
		"",
		...result.matches.map((m) => {
			const who = m.username || "unknown";
			const ts = m.sentAt ? m.sentAt.slice(0, 19).replace("T", " ") : m.ts;
			const chan = m.isDm ? m.channelName : `#${m.channelName}`;
			return `[${ts} · ${chan} (${m.channelId}) · ts=${m.ts}] ${who}: ${m.text}\n  ${m.permalink}`;
		}),
	];
	return lines.join("\n");
}

export function createSlackReadChannelAction(port: SlackReadPort) {
	return defineAction({
		id: "slack_read_channel",
		domain: "integrations",
		description:
			"Read recent messages from a Slack channel or DM using the user OAuth token (SLACK_TOKEN_USER_OAUTH). Accepts a channel ID (C.../G.../D...) or #channel-name. Full notes: docs/guides/tools/slack_read_channel.md",
		schema: slackReadChannelSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		run: async (input): Promise<SlackReadChannelOutput> => {
			return port.readChannel({
				channel: input.channel,
				limit: input.limit ?? 20,
				oldest: input.oldest,
				latest: input.latest,
				cursor: input.cursor,
			});
		},
		formatMcp: formatSlackReadChannelMcp,
	});
}

export function createSlackReadThreadAction(port: SlackReadPort) {
	return defineAction({
		id: "slack_read_thread",
		domain: "integrations",
		description:
			"Read all replies in a Slack thread by channel and parent message timestamp (thread_ts) using the user OAuth token (SLACK_TOKEN_USER_OAUTH). Full notes: docs/guides/tools/slack_read_thread.md",
		schema: slackReadThreadSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		run: async (input): Promise<SlackReadThreadOutput> => {
			return port.readThread({
				channel: input.channel,
				threadTs: input.thread_ts,
				limit: input.limit ?? 50,
				cursor: input.cursor,
			});
		},
		formatMcp: formatSlackReadThreadMcp,
	});
}

export function createSlackSearchAction(port: SlackReadPort) {
	return defineAction({
		id: "slack_search",
		domain: "integrations",
		description:
			"Search Slack messages across channels and DMs visible to the user OAuth token (SLACK_TOKEN_USER_OAUTH). Note: after: and before: date operators are exclusive. Full notes: docs/guides/tools/slack_search.md",
		schema: slackSearchSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		run: async (input): Promise<SlackSearchOutput> => {
			return port.searchMessages({
				query: input.query,
				count: input.count ?? 20,
				sort: input.sort ?? "timestamp",
				sortDir: input.sort_dir ?? "desc",
			});
		},
		formatMcp: formatSlackSearchMcp,
	});
}
