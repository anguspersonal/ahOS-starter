import { z } from "zod";
import type { SlackPostMessageResult, SlackPostPort } from "../../ports/slack.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

export const SLACK_POST_DESCRIPTION =
	"Post a message or thread reply to a named Slack channel via chat.postMessage, using SLACK_TOKEN_BOT_OAUTH server-side (never returned to the caller). Irreversible: there is no unsend. No default channel: every call names its destination. Parks for the owner's approval on every agent call. Full notes: docs/guides/tools/slack_post.md";

export const slackPostInput = {
	channel: z
		.string()
		.min(1)
		.describe(
			"Slack channel to post to, e.g. '#all-work-ai' or a channel id (C0123...). No default \u2014 every call names its destination explicitly; the bot must already be a member of the channel.",
		),
	text: z
		.string()
		.min(1)
		.describe("The message text. Slack mrkdwn is honoured."),
	thread_ts: z
		.string()
		.min(1)
		.optional()
		.describe("Optional parent message timestamp (ts, e.g. '1712000000.000100') to reply in a thread."),
	reply_broadcast: z
		.boolean()
		.optional()
		.describe("When replying in a thread (thread_ts), also broadcast the reply to the channel (default false)."),
	unfurl: z
		.boolean()
		.optional()
		.describe("Enable link and media unfurling on the posted message (default false)."),
};

export const slackPostSchema = z.object(slackPostInput);
export type SlackPostInput = z.infer<typeof slackPostSchema>;

export const slackPostOutputSchema = z.object({
	channel_id: z.string(),
	ts: z.string(),
	thread_ts: z.string().nullable(),
	permalink: z.string().nullable(),
});
export type SlackPostOutput = SlackPostMessageResult;

export function formatSlackPostMcp(result: SlackPostOutput): string {
	const meta = [
		result.ts ? `ts ${result.ts}` : "",
		result.thread_ts ? `thread_ts ${result.thread_ts}` : "",
	]
		.filter(Boolean)
		.join(", ");
	const permNote = result.permalink
		? ` Permalink: ${result.permalink}`
		: " Permalink unavailable.";
	return `Posted to Slack channel ${result.channel_id}${meta ? ` (${meta})` : ""}.${permNote}`;
}

export function createSlackPostAction(
	port: SlackPostPort,
): ActionDefinition<typeof slackPostSchema, SlackPostOutput> {
	return defineAction({
		id: "slack_post",
		domain: "integrations",
		needsApproval: true,
		description: SLACK_POST_DESCRIPTION,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
		schema: slackPostSchema,
		outputSchema: slackPostOutputSchema,
		async run(args: SlackPostInput): Promise<SlackPostOutput> {
			const hasOptions =
				args.thread_ts !== undefined ||
				args.reply_broadcast !== undefined ||
				args.unfurl !== undefined;
			return hasOptions
				? port.postMessage(args.channel, args.text, {
						threadTs: args.thread_ts,
						replyBroadcast: args.reply_broadcast,
						unfurl: args.unfurl,
					})
				: port.postMessage(args.channel, args.text);
		},
		formatMcp: formatSlackPostMcp,
	});
}
