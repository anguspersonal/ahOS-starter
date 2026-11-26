import { z } from "zod";
import {
	SLACK_WRITE_IDENTITIES,
	type SlackMessageDeleteOutput,
	type SlackMessageUpdateOutput,
	type SlackReactionAddOutput,
	type SlackWritePort,
} from "../../ports/slack.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

export const SLACK_MESSAGE_UPDATE_DESCRIPTION =
	"Edit an existing Slack message in place via chat.update. Pass channel ID, ts, replacement text (1-40,000 chars), and as ('owner' user token by default, or 'ahos_bot' bot token; Slack only lets each identity edit its own messages). Parks for the owner's approval on every agent call. Full notes: docs/guides/tools/slack_message_update.md";

export const SLACK_MESSAGE_DELETE_DESCRIPTION =
	"Delete a Slack message via chat.delete. Irreversible. Pass channel ID, ts, and as ('owner' user token by default, or 'ahos_bot' bot token; each identity can only delete its own messages). Returns { deleted: false } when already gone. Parks for the owner's approval on every agent call.";

export const SLACK_REACTION_ADD_DESCRIPTION =
	"Add an emoji reaction to a Slack message via reactions.add as the owner (SLACK_TOKEN_USER_OAUTH). Pass channel ID, message ts, and emoji name without colons (e.g. 'thumbsup'). Idempotent: returns { added: false } if already reacted. Parks for the owner's approval on every agent call.";

const channelIdField = z.string().trim().min(1).describe("Slack channel ID (e.g. 'C0123456789', 'G...', 'D...') containing the target message.");
const messageTsField = z.string().trim().min(1).describe("Slack message timestamp (ts, e.g. '1712000000.000100').");
const identityField = z
	.enum(SLACK_WRITE_IDENTITIES)
	.default("owner")
	.describe("Identity whose token executes the call: 'owner' (default, user token SLACK_TOKEN_USER_OAUTH) or 'ahos_bot' (bot token SLACK_TOKEN_BOT_OAUTH).");

export const slackMessageUpdateSchema = z.object({
	channel: channelIdField,
	ts: messageTsField,
	text: z.string().min(1).max(40_000).describe("Replacement message text (1-40,000 characters; Slack mrkdwn supported)."),
	as: identityField,
});
export type SlackMessageUpdateActionInput = z.infer<typeof slackMessageUpdateSchema>;
export const slackMessageUpdateOutputSchema = z.object({ channel_id: z.string(), ts: z.string() });

export const slackMessageDeleteSchema = z.object({
	channel: channelIdField,
	ts: messageTsField,
	as: identityField,
});
export type SlackMessageDeleteActionInput = z.infer<typeof slackMessageDeleteSchema>;
export const slackMessageDeleteOutputSchema = z.object({ deleted: z.boolean() });

export const slackReactionAddSchema = z.object({
	channel: channelIdField,
	ts: messageTsField,
	name: z
		.string()
		.trim()
		.min(1)
		.regex(/^[^:\s]+(?:::[^:\s]+)?$/, "Pass reaction name without colons (e.g. 'thumbsup')")
		.describe("Emoji reaction name without colons (e.g. 'thumbsup' or 'white_check_mark')."),
});
export type SlackReactionAddActionInput = z.infer<typeof slackReactionAddSchema>;
export const slackReactionAddOutputSchema = z.object({ added: z.boolean() });

export function createSlackMessageUpdateAction(
	port: SlackWritePort,
): ActionDefinition<typeof slackMessageUpdateSchema, SlackMessageUpdateOutput> {
	return defineAction({
		id: "slack_message_update",
		domain: "integrations",
		needsApproval: true,
		description: SLACK_MESSAGE_UPDATE_DESCRIPTION,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		schema: slackMessageUpdateSchema,
		outputSchema: slackMessageUpdateOutputSchema,
		run: async (input: SlackMessageUpdateActionInput) =>
			port.updateMessage({ channel: input.channel, ts: input.ts, text: input.text, as: input.as }),
	});
}

export function createSlackMessageDeleteAction(
	port: SlackWritePort,
): ActionDefinition<typeof slackMessageDeleteSchema, SlackMessageDeleteOutput> {
	return defineAction({
		id: "slack_message_delete",
		domain: "integrations",
		needsApproval: true,
		description: SLACK_MESSAGE_DELETE_DESCRIPTION,
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		schema: slackMessageDeleteSchema,
		outputSchema: slackMessageDeleteOutputSchema,
		run: async (input: SlackMessageDeleteActionInput) =>
			port.deleteMessage({ channel: input.channel, ts: input.ts, as: input.as }),
	});
}

export function createSlackReactionAddAction(
	port: SlackWritePort,
): ActionDefinition<typeof slackReactionAddSchema, SlackReactionAddOutput> {
	return defineAction({
		id: "slack_reaction_add",
		domain: "integrations",
		needsApproval: true,
		description: SLACK_REACTION_ADD_DESCRIPTION,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		schema: slackReactionAddSchema,
		outputSchema: slackReactionAddOutputSchema,
		run: async (input: SlackReactionAddActionInput) =>
			port.addReaction({ channel: input.channel, ts: input.ts, name: input.name }),
	});
}
