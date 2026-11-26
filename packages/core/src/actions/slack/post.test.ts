import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SlackPostPort } from "../../ports/slack.js";
import { executeAction } from "../adapters/direct.js";
import { AdapterUnavailableError, buildRegistry } from "../buildRegistry.js";
import {
	ApprovalDeniedError,
	PendingApprovalError,
	setActionApprovalStore,
	type ActionApprovalStore,
	type ApprovalRequest,
} from "../gate.js";
import { inputSha256 } from "../inputHash.js";
import { SLACK_POST_DESCRIPTION, createSlackPostAction, formatSlackPostMcp } from "./post.js";

const EXPECTED_SLACK_POST_JSON_SCHEMA = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {
		channel: {
			type: "string",
			minLength: 1,
			description:
				"Slack channel to post to, e.g. '#all-work-ai' or a channel id (C0123...). No default \u2014 every call names its destination explicitly; the bot must already be a member of the channel.",
		},
		text: {
			type: "string",
			minLength: 1,
			description: "The message text. Slack mrkdwn is honoured.",
		},
		thread_ts: {
			type: "string",
			minLength: 1,
			description: "Optional parent message timestamp (ts, e.g. '1712000000.000100') to reply in a thread.",
		},
		reply_broadcast: {
			type: "boolean",
			description:
				"When replying in a thread (thread_ts), also broadcast the reply to the channel (default false).",
		},
		unfurl: {
			type: "boolean",
			description: "Enable link and media unfurling on the posted message (default false).",
		},
	},
	required: ["channel", "text"],
	additionalProperties: false,
};

const SAMPLE_RESULT = {
	channel_id: "C0123ABC",
	ts: "1712000000.000100",
	thread_ts: null,
	permalink: "https://work.slack.com/archives/C0123ABC/p1712000000000100",
};

function makePort(overrides: Partial<SlackPostPort> = {}): SlackPostPort {
	return {
		postMessage: vi.fn().mockResolvedValue(SAMPLE_RESULT),
		...overrides,
	};
}

describe("slack_post core action (#1527, #1657)", () => {
	afterEach(() => {
		setActionApprovalStore(undefined);
		vi.restoreAllMocks();
	});

	it("1. Contract parity: id, schema JSON Schema, description, annotations, and default exposure", () => {
		const action = createSlackPostAction(makePort());

		expect(action.id).toBe("slack_post");
		expect(action.domain).toBe("integrations");
		expect(action.needsApproval).toBe(true);
		expect(action.description).toBe(SLACK_POST_DESCRIPTION);
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
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
		expect(z.toJSONSchema(action.schema)).toEqual(EXPECTED_SLACK_POST_JSON_SCHEMA);
	});

	it("2. Caller mcp, worker, or ui_agent rejects with PendingApprovalError and never calls postMessage", async () => {
		const postMessage = vi.fn();
		const action = createSlackPostAction(makePort({ postMessage }));
		const parked: ApprovalRequest[] = [];
		const store: ActionApprovalStore = {
			park: vi.fn(async (req: ApprovalRequest) => {
				parked.push(req);
				return { decisionId: `dec-${parked.length}` };
			}),
		};
		setActionApprovalStore(store);

		for (const caller of ["mcp", "worker", "ui_agent"] as const) {
			await expect(
				executeAction(action, { channel: "#all-work-ai", text: "hello" }, { context: { caller, userId: "u-1" } }),
			).rejects.toThrow(PendingApprovalError);
		}

		expect(postMessage).not.toHaveBeenCalled();
		expect(parked.map((p) => p.caller)).toEqual(["mcp", "worker", "ui_agent"]);
	});

	it("3. Caller ui posts once and formatMcp returns id-only receipt with permalink or unavailability note", async () => {
		const postMessage = vi.fn().mockResolvedValue(SAMPLE_RESULT);
		const action = createSlackPostAction(makePort({ postMessage }));

		const out = await executeAction(
			action,
			{ channel: "#all-work-ai", text: "ship it" },
			{ context: { caller: "ui" } },
		);

		expect(postMessage).toHaveBeenCalledOnce();
		expect(postMessage).toHaveBeenCalledWith("#all-work-ai", "ship it");
		expect(out).toEqual(SAMPLE_RESULT);
		expect(action.formatMcp!(out)).toBe(
			`Posted to Slack channel C0123ABC (ts 1712000000.000100). Permalink: ${SAMPLE_RESULT.permalink}`,
		);
		expect(formatSlackPostMcp({ channel_id: "C0123ABC", ts: "", thread_ts: null, permalink: null })).toBe(
			"Posted to Slack channel C0123ABC. Permalink unavailable.",
		);
	});

	it("4. Call carrying an approval for slack_post with matching inputSha256 posts; mismatched hash is refused", async () => {
		const approvedResult = { channel_id: "C0123ABC", ts: "1712000000.000200", thread_ts: null, permalink: null };
		const postMessage = vi.fn().mockResolvedValue(approvedResult);
		const action = createSlackPostAction(makePort({ postMessage }));
		const input = { channel: "#all-work-ai", text: "approved text" };
		const validHash = await inputSha256(input);
		const otherHash = await inputSha256({ channel: "#all-work-ai", text: "tampered text" });

		await expect(
			executeAction(action, input, {
				context: { caller: "mcp", approval: { decisionId: "dec-bad", actionId: "slack_post", inputSha256: otherHash } },
			}),
		).rejects.toThrow(ApprovalDeniedError);
		expect(postMessage).not.toHaveBeenCalled();

		const res = await executeAction(action, input, {
			context: { caller: "mcp", approval: { decisionId: "dec-ok", actionId: "slack_post", inputSha256: validHash } },
		});
		expect(postMessage).toHaveBeenCalledOnce();
		expect(res).toEqual(approvedResult);
	});

	it("5. buildRegistry registers slack_post, throws AdapterUnavailableError when unwired, and reaches port when wired", async () => {
		const unwired = buildRegistry({});
		await expect(
			executeAction(unwired.get("slack_post")!, { channel: "#all-work-ai", text: "hello" }, { context: { caller: "ui" } }),
		).rejects.toThrowError(AdapterUnavailableError);

		const wiredResult = { channel_id: "C999", ts: "1712000000.000999", thread_ts: null, permalink: null };
		const postMessage = vi.fn().mockResolvedValue(wiredResult);
		const wired = buildRegistry({ slackPost: { postMessage } });
		const out = await executeAction(wired.get("slack_post")!, { channel: "C999", text: "wired call" }, { context: { caller: "ui" } });
		expect(postMessage).toHaveBeenCalledWith("C999", "wired call");
		expect(out).toEqual(wiredResult);
	});
});
