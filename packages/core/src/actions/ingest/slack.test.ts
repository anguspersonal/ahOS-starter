import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeAction } from "../adapters/direct.js";
import { createCaptureAction } from "../artifacts/capture.js";
import type { CaptureInput } from "../domain/capture.js";
import type { ActionContext } from "../types.js";
import type { CapturePort, CaptureResult } from "../../ports/artifacts.js";
import type { SlackMessage, SlackPort } from "../../ports/slack.js";
import {
	createIngestSlackAction,
	INGEST_SLACK_DESCRIPTION,
	messageBody,
	messageTitle,
	SLACK_MESSAGE_CONTENT_SUBTYPE,
	slackIngestInput,
} from "./slack.js";

/** 1757000000 is 2025-09-04T15:33:20.000Z. */
const MATCH_DAY = "2025-09-04";

function message(over: Partial<SlackMessage> = {}): SlackMessage {
	return {
		permalink: "https://work.slack.com/archives/C1/p1757000000000000",
		text: "shipping the calendar reads today",
		channelId: "C1",
		channelName: "general",
		isDm: false,
		ts: "1757000000.000000",
		sentAt: "2025-09-04T15:33:20.000Z",
		username: "angus",
		...over,
	};
}

function fakeCaptureResult(input: CaptureInput): CaptureResult {
	return {
		id: "art-1",
		title: input.title ?? "Untitled",
		tags: input.tags ?? [],
		source_channel: "mcp",
		storage_bucket: "user-uploads",
		storage_path: "slack/art-1.md",
		captured_at: "2025-09-04T15:33:20.000Z",
		captured_at_declared: false,
		deduplicated: false,
	};
}

const DEV_SLACK_INGEST_JSON_SCHEMA = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {
		since: {
			type: "string",
			description:
				"ISO date (YYYY-MM-DD), inclusive. Defaults to 7 days ago. Re-running an overlapping window is safe: already-ingested messages are skipped by permalink.",
		},
		until: {
			type: "string",
			description: "ISO date (YYYY-MM-DD), inclusive. Open-ended if omitted.",
		},
		channel: {
			type: "string",
			description:
				"Restrict to one channel name, without the leading #. Omitted, every conversation the token can reach, INCLUDING DIRECT MESSAGES.",
		},
		include_dms: {
			type: "boolean",
			description:
				"Whether to ingest direct messages (default true). Set false to take channels only, without changing the token. DMs are captured on their own surface either way, so they stay separable afterwards.",
		},
		max_results: {
			type: "integer",
			minimum: 1,
			maximum: 100,
			description: "Max messages to fetch (default 50).",
		},
		dry_run: {
			type: "boolean",
			description:
				"List what WOULD be ingested and write nothing. Worth running first: this covers DMs by default, and it is better to see the list than to discover it in search results.",
		},
	},
	additionalProperties: false,
};

describe("messageTitle and messageBody (#1535)", () => {
	it("formats channel and DM titles and bodies with truncation at 80 chars", () => {
		const m = message();
		expect(messageTitle(m)).toBe("Slack #general: shipping the calendar reads today");
		expect(messageBody(m)).toBe(
			[
				"Slack message in #general",
				"Sent: 2025-09-04T15:33:20.000Z",
				"Link: https://work.slack.com/archives/C1/p1757000000000000",
				"",
				"shipping the calendar reads today",
			].join("\n"),
		);

		const dm = message({
			isDm: true,
			channelId: "D9",
			channelName: "dm:D9",
			text: `${"a".repeat(90)}\nsecond line`,
		});
		expect(messageTitle(dm)).toBe(`Slack DM: ${"a".repeat(77)}...`);
		expect(messageBody(dm)).toContain("Slack message in a direct message");
	});
});

describe("createIngestSlackAction (#1535)", () => {
	it("preserves exact contract parity for id, schema, description, annotations, and default exposure", () => {
		const slack: SlackPort = {
			viewer: vi.fn(async () => ({ login: "angus", teamName: "Work" })),
			searchMyMessages: vi.fn(async () => []),
		};
		const artifacts = {
			findExistingSources: vi.fn(async () => new Set<string>()),
		};
		const capture: CapturePort = {
			capture: vi.fn(async (input) => fakeCaptureResult(input)),
		};

		const action = createIngestSlackAction({ slack, artifacts, capture });

		expect(action.id).toBe("ingest_slack");
		expect(z.toJSONSchema(action.schema)).toEqual(DEV_SLACK_INGEST_JSON_SCHEMA);
		expect(z.toJSONSchema(action.schema)).toEqual(z.toJSONSchema(z.object(slackIngestInput)));
		expect(action.description).toBe(INGEST_SLACK_DESCRIPTION);
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		expect(action.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
	});

	it("dry_run: true writes nothing and says how many DMs it is about to capture", async () => {
		const dmMsg = message({
			permalink: "https://work.slack.com/archives/D9/p1757000001000000",
			channelId: "D9",
			channelName: "dm:D9",
			isDm: true,
		});
		const slack: SlackPort = {
			viewer: vi.fn(async () => ({ login: "angus", teamName: "Work" })),
			searchMyMessages: vi.fn(async () => [dmMsg]),
		};
		const artifacts = {
			findExistingSources: vi.fn(async () => new Set<string>()),
		};
		const captureFn = vi.fn(async (input: CaptureInput) => fakeCaptureResult(input));

		const action = createIngestSlackAction({
			slack,
			artifacts,
			capture: { capture: captureFn },
		});

		const result = await executeAction(
			action,
			{ since: MATCH_DAY, dry_run: true },
			{ context: { caller: "test", userId: "user-1" } },
		);

		expect(captureFn).not.toHaveBeenCalled();
		expect(result.dryRun).toBe(true);
		expect(result.dmCount).toBe(1);

		const text = action.formatMcp?.(result) ?? "";
		expect(text).toContain("DRY RUN, nothing written. Would ingest:");
		expect(text).toContain("direct messages");
		expect(text).toContain("[DM]");
	});

	it("captures each fresh message via nested executeAction on capture with caller 'internal', stamping DMs on slack_dm and channel messages on slack", async () => {
		const chanMsg = message();
		const dmMsg = message({
			permalink: "https://work.slack.com/archives/D9/p1757000001000000",
			channelId: "D9",
			channelName: "dm:D9",
			isDm: true,
		});
		const slack: SlackPort = {
			viewer: vi.fn(async () => ({ login: "angus", teamName: "Work" })),
			searchMyMessages: vi.fn(async () => [chanMsg, dmMsg]),
		};
		const artifacts = {
			findExistingSources: vi.fn(async () => new Set<string>()),
		};

		const capturedCalls: Array<{ input: CaptureInput; ctx: ActionContext }> = [];
		const baseCaptureAction = createCaptureAction({
			capture: vi.fn(async (input) => fakeCaptureResult(input)),
		});
		const runSpy = vi.spyOn(baseCaptureAction, "run").mockImplementation(async (input, ctx) => {
			capturedCalls.push({ input, ctx });
			return fakeCaptureResult(input);
		});

		const action = createIngestSlackAction({
			slack,
			artifacts,
			capture: baseCaptureAction,
		});

		const result = await executeAction(
			action,
			{ since: MATCH_DAY },
			{ context: { caller: "mcp", userId: "user-1" } },
		);

		expect(runSpy).toHaveBeenCalledTimes(2);
		expect(capturedCalls[0]?.ctx.caller).toBe("internal");
		expect(capturedCalls[0]?.ctx.userId).toBe("user-1");
		expect(capturedCalls[0]?.input).toEqual({
			title: messageTitle(chanMsg),
			text: messageBody(chanMsg),
			source_url: chanMsg.permalink,
			surface: "slack",
			captured_by: "ingest_slack",
			content_subtype: SLACK_MESSAGE_CONTENT_SUBTYPE,
			tags: ["slack", "slack:channel:general", `sent:${MATCH_DAY}`],
		});

		expect(capturedCalls[1]?.ctx.caller).toBe("internal");
		expect(capturedCalls[1]?.ctx.userId).toBe("user-1");
		expect(capturedCalls[1]?.input).toEqual({
			title: messageTitle(dmMsg),
			text: messageBody(dmMsg),
			source_url: dmMsg.permalink,
			surface: "slack_dm",
			captured_by: "ingest_slack",
			content_subtype: SLACK_MESSAGE_CONTENT_SUBTYPE,
			tags: ["slack", "slack:dm", `sent:${MATCH_DAY}`],
		});

		const text = action.formatMcp?.(result) ?? "";
		expect(text).toContain("Ingested 2:");
	});

	it("skips DMs when include_dms is false", async () => {
		const dmMsg = message({
			permalink: "https://work.slack.com/archives/D9/p1757000001000000",
			channelId: "D9",
			channelName: "dm:D9",
			isDm: true,
		});
		const slack: SlackPort = {
			viewer: vi.fn(async () => ({ login: "angus", teamName: "Work" })),
			searchMyMessages: vi.fn(async () => [dmMsg]),
		};
		const artifacts = {
			findExistingSources: vi.fn(async () => new Set<string>()),
		};
		const captureFn = vi.fn(async (input: CaptureInput) => fakeCaptureResult(input));

		const action = createIngestSlackAction({
			slack,
			artifacts,
			capture: { capture: captureFn },
		});

		await executeAction(action, { since: MATCH_DAY, include_dms: false });
		expect(captureFn).not.toHaveBeenCalled();
	});

	it("trims messages outside the requested window", async () => {
		const slack: SlackPort = {
			viewer: vi.fn(async () => ({ login: "angus", teamName: "Work" })),
			searchMyMessages: vi.fn(async () => [message()]),
		};
		const artifacts = {
			findExistingSources: vi.fn(async () => new Set<string>()),
		};
		const captureFn = vi.fn(async (input: CaptureInput) => fakeCaptureResult(input));

		const action = createIngestSlackAction({
			slack,
			artifacts,
			capture: { capture: captureFn },
		});

		const result = await executeAction(action, { since: "2025-09-05" });
		const text = action.formatMcp?.(result) ?? "";
		expect(captureFn).not.toHaveBeenCalled();
		expect(text).toContain("0 message(s)");
	});

	it("skips messages whose permalink is already stored as an artifact source", async () => {
		const m = message();
		const slack: SlackPort = {
			viewer: vi.fn(async () => ({ login: "angus", teamName: "Work" })),
			searchMyMessages: vi.fn(async () => [m]),
		};
		const artifacts = {
			findExistingSources: vi.fn(async () => new Set<string>([m.permalink])),
		};
		const captureFn = vi.fn(async (input: CaptureInput) => fakeCaptureResult(input));

		const action = createIngestSlackAction({
			slack,
			artifacts,
			capture: { capture: captureFn },
		});

		const result = await executeAction(action, { since: MATCH_DAY });
		const text = action.formatMcp?.(result) ?? "";
		expect(captureFn).not.toHaveBeenCalled();
		expect(text).toContain("1 already ingested");
	});
});
