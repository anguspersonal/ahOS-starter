import { z } from "zod";
import { ARTIFACT_SURFACES } from "../../domain/artifacts.js";
import type {
	ArtifactRepository,
	CapturePort,
	CaptureResult,
} from "../../ports/artifacts.js";
import type { SlackMessage, SlackPort } from "../../ports/slack.js";
import { executeAction } from "../adapters/direct.js";
import { createCaptureAction } from "../artifacts/capture.js";
import { defineAction } from "../defineAction.js";
import type { captureSchema } from "../domain/capture.js";
import type { ActionDefinition } from "../types.js";

// ingest_slack (#1011, #1535): pull the owner's OWN Slack messages into the knowledge store.
//
// Scope is deliberately "things I said", never "things I saw". A channel's full history
// is other people's writing, in volume, and capturing it would make the knowledge store
// a partial mirror of Slack rather than a record of the owner's own thinking. `from:@me`
// is the whole filter, and it is also what keeps DMs defensible: the owner's half of a
// DM is their own words, the other half is not ingested.
//
// DMs land on a DIFFERENT SURFACE from channel messages (`slack_dm` vs `slack`). ADR-046
// §3 stores one role per surface, so this is what makes "channel chatter is evidence,
// DMs never surface at all" expressible later without re-ingesting (#584).

export const SLACK_MESSAGE_CONTENT_SUBTYPE = "slack_message" as const;

function daysAgo(n: number): string {
	return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

export function messageBody(m: SlackMessage): string {
	return [
		`Slack message in ${m.isDm ? "a direct message" : `#${m.channelName}`}`,
		`Sent: ${m.sentAt || m.ts}`,
		`Link: ${m.permalink}`,
		"",
		m.text.trim() || "(no text)",
	].join("\n");
}

/** First line, trimmed, so a wall of text still gets a scannable title. */
export function messageTitle(m: SlackMessage): string {
	const first = m.text.trim().split("\n")[0] ?? "";
	const snippet = first.length > 80 ? `${first.slice(0, 77)}...` : first;
	const where = m.isDm ? "DM" : `#${m.channelName}`;
	return `Slack ${where}: ${snippet || "(no text)"}`;
}

export const slackIngestInput = {
	since: z
		.string()
		.optional()
		.describe(
			"ISO date (YYYY-MM-DD), inclusive. Defaults to 7 days ago. Re-running an overlapping window is safe: already-ingested messages are skipped by permalink.",
		),
	until: z.string().optional().describe("ISO date (YYYY-MM-DD), inclusive. Open-ended if omitted."),
	channel: z
		.string()
		.optional()
		.describe(
			"Restrict to one channel name, without the leading #. Omitted, every conversation the token can reach, INCLUDING DIRECT MESSAGES.",
		),
	include_dms: z
		.boolean()
		.optional()
		.describe(
			"Whether to ingest direct messages (default true). Set false to take channels only, without changing the token. DMs are captured on their own surface either way, so they stay separable afterwards.",
		),
	max_results: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("Max messages to fetch (default 50)."),
	dry_run: z
		.boolean()
		.optional()
		.describe(
			"List what WOULD be ingested and write nothing. Worth running first: this covers DMs by default, and it is better to see the list than to discover it in search results.",
		),
};

export const slackIngestSchema = z.object(slackIngestInput);
export type SlackIngestInput = z.infer<typeof slackIngestSchema>;

export const INGEST_SLACK_DESCRIPTION =
	"Pull the owner's OWN Slack messages into the store as artifacts. Scope is 'things I said', never " +
	"'things I saw': the filter is from:@me, so a channel's history of other people's writing is " +
	"never captured. Covers public channels, private ones and DMs the token can see. Full notes: " +
	"docs/guides/tools/ingest_slack.md";

export interface IngestSlackResult {
	login: string;
	teamName: string;
	since: string;
	until?: string;
	channel?: string;
	dryRun: boolean;
	matched: number;
	fresh: number;
	skipped: number;
	dmCount: number;
	ingested: string[];
	failed: string[];
}

export interface IngestSlackDeps {
	slack: SlackPort;
	artifacts: Pick<ArtifactRepository, "findExistingSources">;
	capture: CapturePort | ActionDefinition<typeof captureSchema, CaptureResult>;
}

export function formatIngestSlackMcp(result: IngestSlackResult): string {
	const header = [
		`${result.matched} message(s) from @${result.login}${
			result.teamName ? ` in ${result.teamName}` : ""
		} since ${result.since}${result.until ? ` until ${result.until}` : ""}${
			result.channel ? ` in #${result.channel}` : ""
		}: ${result.fresh} new, ${result.skipped} already ingested.`,
		result.dmCount > 0
			? `${result.dmCount} of them are direct messages, captured on surface 'slack_dm' so they can be demoted or excluded separately from channel messages.`
			: null,
	]
		.filter((l): l is string => l !== null)
		.join("\n");

	if (result.dryRun) {
		return [
			header,
			"",
			"DRY RUN, nothing written. Would ingest:",
			...(result.ingested.length
				? result.ingested.map((l) => `  • ${l}`)
				: ["  (none)"]),
		].join("\n");
	}

	return [
		header,
		"",
		`Ingested ${result.ingested.length}:`,
		...(result.ingested.length
			? result.ingested.map((l) => `  • ${l}`)
			: ["  (none)"]),
		...(result.failed.length
			? [
					"",
					`FAILED ${result.failed.length}, re-run to retry:`,
					...result.failed.map((l) => `  - ${l}`),
				]
			: []),
	].join("\n");
}

export function createIngestSlackAction(deps: IngestSlackDeps) {
	const captureAction: ActionDefinition<typeof captureSchema, CaptureResult> =
		typeof (deps.capture as ActionDefinition<typeof captureSchema, CaptureResult>).id === "string"
			? (deps.capture as ActionDefinition<typeof captureSchema, CaptureResult>)
			: createCaptureAction(deps.capture as CapturePort);

	return defineAction({
		id: "ingest_slack",
		domain: "integrations",
		description: INGEST_SLACK_DESCRIPTION,
		schema: slackIngestSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		run: async (args, ctx): Promise<IngestSlackResult> => {
			const since = args.since ?? daysAgo(7);
			const includeDms = args.include_dms ?? true;

			const viewer = await deps.slack.viewer();
			const found = await deps.slack.searchMyMessages({
				login: viewer.login,
				since,
				until: args.until,
				channel: args.channel,
				count: args.max_results ?? 50,
			});

			// Slack's date operators are day-granular and exclusive, so the client widened the
			// window by a day at each end. Trim back to what was actually asked for.
			const inWindow = found.filter((m) => {
				const day = m.sentAt.slice(0, 10);
				if (!day) return true;
				if (day < since) return false;
				return !(args.until && day > args.until);
			});

			const messages = includeDms ? inWindow : inWindow.filter((m) => !m.isDm);
			const dmCount = messages.filter((m) => m.isDm).length;

			const already = await deps.artifacts.findExistingSources(
				messages.map((m) => m.permalink),
			);
			const fresh = messages.filter((m) => !already.has(m.permalink));
			const skipped = messages.length - fresh.length;

			if (args.dry_run) {
				return {
					login: viewer.login,
					teamName: viewer.teamName,
					since,
					until: args.until,
					channel: args.channel,
					dryRun: true,
					matched: messages.length,
					fresh: fresh.length,
					skipped,
					dmCount,
					ingested: fresh.map(
						(m) =>
							`${m.sentAt} ${m.isDm ? "[DM]" : `#${m.channelName}`} ${m.text.slice(0, 90)}`,
					),
					failed: [],
				};
			}

			const ingested: string[] = [];
			const failed: string[] = [];
			for (const m of fresh) {
				try {
					await executeAction(
						captureAction,
						{
							title: messageTitle(m),
							text: messageBody(m),
							source_url: m.permalink,
							surface: m.isDm ? ARTIFACT_SURFACES.slackDm : ARTIFACT_SURFACES.slack,
							captured_by: "ingest_slack",
							content_subtype: SLACK_MESSAGE_CONTENT_SUBTYPE,
							tags: [
								"slack",
								m.isDm ? "slack:dm" : `slack:channel:${m.channelName}`,
								`sent:${m.sentAt.slice(0, 10)}`,
							],
						},
						{ context: { caller: "internal", userId: ctx.userId } },
					);
					ingested.push(`${m.sentAt} ${m.isDm ? "[DM]" : `#${m.channelName}`}`);
				} catch (err) {
					failed.push(
						`${m.permalink}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}

			return {
				login: viewer.login,
				teamName: viewer.teamName,
				since,
				until: args.until,
				channel: args.channel,
				dryRun: false,
				matched: messages.length,
				fresh: fresh.length,
				skipped,
				dmCount,
				ingested,
				failed,
			};
		},
		formatMcp: formatIngestSlackMcp,
	});
}
