/**
 * Port for reading Slack channels, threads, and message search via user OAuth token (ADR-101, ADR-113).
 * Pure types only — no external SDKs, filesystem, or database dependencies.
 */

export const SLACK_SEARCH_SORTS = ["score", "timestamp"] as const;
export type SlackSearchSort = (typeof SLACK_SEARCH_SORTS)[number];

export const SLACK_SEARCH_SORT_DIRS = ["asc", "desc"] as const;
export type SlackSearchSortDir = (typeof SLACK_SEARCH_SORT_DIRS)[number];

export interface SlackChannelMessage {
	/** Slack message timestamp (`ts`, unix epoch seconds with microseconds). */
	ts: string;
	/** ISO-8601 instant derived from `ts`. */
	sentAt: string;
	/** Slack user ID or bot ID of the sender. */
	user: string;
	/** Optional display/username when present on the wire message. */
	username?: string;
	/** Message text body. */
	text: string;
	/** Parent thread timestamp when the message belongs to a thread. */
	threadTs?: string;
	/** Number of replies when the message is a thread parent. */
	replyCount?: number;
}

export interface SlackReadChannelInput {
	/** Slack channel ID (`C...`, `G...`, `D...`) or channel name (`#general` or `general`). */
	channel: string;
	/** Maximum number of messages to return (1-200, default 20). */
	limit?: number;
	/** Only messages after this Slack `ts` or ISO-8601 timestamp/date (inclusive). */
	oldest?: string;
	/** Only messages before this Slack `ts` or ISO-8601 timestamp/date (inclusive). */
	latest?: string;
	/** Pagination cursor returned by a previous call. */
	cursor?: string;
}

export interface SlackReadChannelOutput {
	channelId: string;
	messages: SlackChannelMessage[];
	hasMore: boolean;
	nextCursor: string | null;
}

export interface SlackReadThreadInput {
	/** Slack channel ID (`C...`, `G...`, `D...`) or channel name (`#general` or `general`). */
	channel: string;
	/** Parent message `ts` identifying the thread (e.g. `"1700000000.000100"`). */
	threadTs: string;
	/** Maximum number of thread messages to return (1-200, default 50). */
	limit?: number;
	/** Pagination cursor returned by a previous call. */
	cursor?: string;
}

export interface SlackReadThreadOutput {
	channelId: string;
	threadTs: string;
	messages: SlackChannelMessage[];
	hasMore: boolean;
	nextCursor: string | null;
}

export interface SlackSearchMatch {
	/** Stable permalink to the message. */
	permalink: string;
	/** Message text body. */
	text: string;
	/** Slack channel ID where the message was posted. */
	channelId: string;
	/** Human-readable channel name (or `dm:<id>` for direct messages). */
	channelName: string;
	/** True when the message is in a DM or group DM. */
	isDm: boolean;
	/** Slack message `ts`. */
	ts: string;
	/** ISO-8601 instant derived from `ts`. */
	sentAt: string;
	/** Sender username returned by Slack search. */
	username: string;
}

export interface SlackSearchInput {
	/** Slack search query string (supports `in:#channel`, `from:@user`, `after:YYYY-MM-DD`, `before:YYYY-MM-DD`). */
	query: string;
	/** Maximum number of matches to return (1-100, default 20). */
	count?: number;
	/** Sort field (`timestamp` or `score`, default `timestamp`). */
	sort?: SlackSearchSort;
	/** Sort direction (`desc` or `asc`, default `desc`). */
	sortDir?: SlackSearchSortDir;
}

export interface SlackSearchOutput {
	query: string;
	matches: SlackSearchMatch[];
	total: number;
}

export interface SlackReadPort {
	readChannel(input: SlackReadChannelInput): Promise<SlackReadChannelOutput>;
	readThread(input: SlackReadThreadInput): Promise<SlackReadThreadOutput>;
	searchMessages(input: SlackSearchInput): Promise<SlackSearchOutput>;
}

export interface SlackMessage {
	/** The permalink, stable and the dedup key downstream. */
	permalink: string;
	text: string;
	channelId: string;
	channelName: string;
	/** True for a DM or group DM, which get their own surface. */
	isDm: boolean;
	/** Slack's `ts`, a unix epoch with microseconds, as sent. */
	ts: string;
	/** `ts` resolved to an ISO instant, for the artifact body. */
	sentAt: string;
	username: string;
}

export interface SlackViewer {
	login: string;
	teamName: string;
}

export interface SlackSearchOptions {
	/** Slack handle without the @, as `from:` expects it. */
	login: string;
	/** YYYY-MM-DD, inclusive. */
	since: string;
	until?: string;
	/** Restrict to one channel name, without the leading #. */
	channel?: string;
	count: number;
}

export interface SlackPostMessageOptions {
	threadTs?: string;
	replyBroadcast?: boolean;
	unfurl?: boolean;
}

export interface SlackPostMessageResult {
	channel_id: string;
	ts: string;
	thread_ts: string | null;
	permalink: string | null;
}

export interface SlackPostPort {
	postMessage(
		channel: string,
		text: string,
		options?: SlackPostMessageOptions,
	): Promise<SlackPostMessageResult>;
}

export interface SlackPort {
	viewer(): Promise<SlackViewer>;
	searchMyMessages(options: SlackSearchOptions): Promise<SlackMessage[]>;
	postMessage?(
		channel: string,
		text: string,
		options?: SlackPostMessageOptions,
	): Promise<SlackPostMessageResult>;
}

export const SLACK_WRITE_IDENTITIES = ["owner", "ahos_bot"] as const;
export type SlackWriteIdentity = (typeof SLACK_WRITE_IDENTITIES)[number];

export interface SlackMessageUpdateInput { channel: string; ts: string; text: string; as?: SlackWriteIdentity }
export interface SlackMessageUpdateOutput { channel_id: string; ts: string }
export interface SlackMessageDeleteInput { channel: string; ts: string; as?: SlackWriteIdentity }
export interface SlackMessageDeleteOutput { deleted: boolean }
export interface SlackReactionAddInput { channel: string; ts: string; name: string }
export interface SlackReactionAddOutput { added: boolean }

export interface SlackWritePort {
	updateMessage(input: SlackMessageUpdateInput): Promise<SlackMessageUpdateOutput>;
	deleteMessage(input: SlackMessageDeleteInput): Promise<SlackMessageDeleteOutput>;
	addReaction(input: SlackReactionAddInput): Promise<SlackReactionAddOutput>;
}


