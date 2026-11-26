import { describe, expect, it, vi } from "vitest";
import {
	createSlackReadChannelAction,
	createSlackReadThreadAction,
	createSlackSearchAction,
	formatSlackReadChannelMcp,
	formatSlackReadThreadMcp,
	formatSlackSearchMcp,
} from "./slackRead.js";
import { buildRegistry, AdapterUnavailableError } from "../buildRegistry.js";
import { executeAction } from "../adapters/direct.js";
import type { SlackReadPort } from "../../ports/slack.js";

function makeFakeSlackPort(overrides: Partial<SlackReadPort> = {}): SlackReadPort {
	return {
		readChannel: vi.fn(async (input) => ({
			channelId: input.channel.startsWith("#") ? "C0123456789" : input.channel,
			messages: [
				{
					ts: "1700000000.000100",
					sentAt: "2023-11-14T22:13:20.000Z",
					user: "U123",
					username: "angus",
					text: "Shipped the release",
					threadTs: "1700000000.000100",
					replyCount: 2,
				},
			],
			hasMore: false,
			nextCursor: null,
		})),
		readThread: vi.fn(async (input) => ({
			channelId: input.channel,
			threadTs: input.threadTs,
			messages: [
				{
					ts: input.threadTs,
					sentAt: "2023-11-14T22:13:20.000Z",
					user: "U123",
					username: "angus",
					text: "Parent message",
					threadTs: input.threadTs,
					replyCount: 1,
				},
				{
					ts: "1700000060.000200",
					sentAt: "2023-11-14T22:14:20.000Z",
					user: "U456",
					username: "teammate",
					text: "Thread reply",
					threadTs: input.threadTs,
				},
			],
			hasMore: false,
			nextCursor: null,
		})),
		searchMessages: vi.fn(async (input) => ({
			query: input.query,
			total: 1,
			matches: [
				{
					permalink: "https://work.slack.com/archives/C0123456789/p1700000000000100",
					text: "Shipped the release",
					channelId: "C0123456789",
					channelName: "general",
					isDm: false,
					ts: "1700000000.000100",
					sentAt: "2023-11-14T22:13:20.000Z",
					username: "angus",
				},
			],
		})),
		...overrides,
	};
}

describe("Slack read actions (#2008, ADR-113)", () => {
	describe("slack_read_channel", () => {
		it("calls port.readChannel with default limit=20 and formats output", async () => {
			const port = makeFakeSlackPort();
			const action = createSlackReadChannelAction(port);

			expect(action.id).toBe("slack_read_channel");
			expect(action.annotations).toEqual({
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			});

			const res = await executeAction(action, {
				channel: "#general",
				oldest: "2026-10-01",
			});

			expect(port.readChannel).toHaveBeenCalledWith({
				channel: "#general",
				limit: 20,
				oldest: "2026-10-01",
				latest: undefined,
				cursor: undefined,
			});
			expect(res.channelId).toBe("C0123456789");
			expect(res.messages).toHaveLength(1);

			const formatted = formatSlackReadChannelMcp(res);
			expect(formatted).toContain("Channel C0123456789 — 1 message(s):");
			expect(formatted).toContain("[2023-11-14 22:13:20 · ts=1700000000.000100] angus [thread_ts=1700000000.000100, 2 replies]: Shipped the release");
		});

		it("formats empty channel and pagination cursor cleanly", () => {
			expect(
				formatSlackReadChannelMcp({
					channelId: "C999",
					messages: [],
					hasMore: false,
					nextCursor: null,
				}),
			).toBe("No messages found in channel C999.");

			const paged = formatSlackReadChannelMcp({
				channelId: "C999",
				messages: [
					{
						ts: "1700000000.000100",
						sentAt: "2023-11-14T22:13:20.000Z",
						user: "U123",
						text: "Hello",
					},
				],
				hasMore: true,
				nextCursor: "dXNlcjpVMDYxTkZUVDI=",
			});
			expect(paged).toContain("more available, nextCursor: dXNlcjpVMDYxTkZUVDI=");
		});
	});

	describe("slack_read_thread", () => {
		it("calls port.readThread with default limit=50 and formats output", async () => {
			const port = makeFakeSlackPort();
			const action = createSlackReadThreadAction(port);

			expect(action.id).toBe("slack_read_thread");
			expect(action.annotations).toEqual({
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			});

			const res = await executeAction(action, {
				channel: "C0123456789",
				thread_ts: "1700000000.000100",
			});

			expect(port.readThread).toHaveBeenCalledWith({
				channel: "C0123456789",
				threadTs: "1700000000.000100",
				limit: 50,
				cursor: undefined,
			});
			expect(res.messages).toHaveLength(2);

			const formatted = formatSlackReadThreadMcp(res);
			expect(formatted).toContain("Thread 1700000000.000100 in C0123456789 — 2 message(s):");
			expect(formatted).toContain("angus: Parent message");
			expect(formatted).toContain("teammate: Thread reply");
		});

		it("formats empty thread cleanly", () => {
			expect(
				formatSlackReadThreadMcp({
					channelId: "C0123456789",
					threadTs: "1700000000.000100",
					messages: [],
					hasMore: false,
					nextCursor: null,
				}),
			).toBe("No messages found in thread 1700000000.000100 (channel C0123456789).");
		});
	});

	describe("slack_search", () => {
		it("calls port.searchMessages with defaults (count=20, sort=timestamp, sortDir=desc) and formats output", async () => {
			const port = makeFakeSlackPort();
			const action = createSlackSearchAction(port);

			expect(action.id).toBe("slack_search");
			expect(action.annotations).toEqual({
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			});

			const res = await executeAction(action, {
				query: "in:#general release",
			});

			expect(port.searchMessages).toHaveBeenCalledWith({
				query: "in:#general release",
				count: 20,
				sort: "timestamp",
				sortDir: "desc",
			});
			expect(res.total).toBe(1);

			const formatted = formatSlackSearchMcp(res);
			expect(formatted).toContain('Slack search "in:#general release" — showing 1 of 1 match(es):');
			expect(formatted).toContain("#general (C0123456789)");
			expect(formatted).toContain("https://work.slack.com/archives/C0123456789/p1700000000000100");
		});

		it("formats empty search and DM matches cleanly", () => {
			expect(
				formatSlackSearchMcp({
					query: "nonexistent",
					matches: [],
					total: 0,
				}),
			).toBe('No Slack messages matched query "nonexistent".');

			const dmFormatted = formatSlackSearchMcp({
				query: "secret",
				total: 1,
				matches: [
					{
						permalink: "https://work.slack.com/archives/D123/p1",
						text: "DM body",
						channelId: "D123",
						channelName: "dm:D123",
						isDm: true,
						ts: "1700000000.000100",
						sentAt: "2023-11-14T22:13:20.000Z",
						username: "angus",
					},
				],
			});
			expect(dmFormatted).toContain("dm:D123 (D123)");
			expect(dmFormatted).not.toContain("#dm:D123");
		});
	});

	describe("buildRegistry wiring", () => {
		it("registers slack_read_channel, slack_read_thread, and slack_search and throws AdapterUnavailableError when unwired", async () => {
			const unwired = buildRegistry({});
			for (const id of ["slack_read_channel", "slack_read_thread", "slack_search"] as const) {
				expect(unwired.has(id)).toBe(true);
			}

			await expect(
				executeAction(unwired.get("slack_read_channel")!, { channel: "C123" }),
			).rejects.toThrowError(AdapterUnavailableError);

			const wired = buildRegistry({ slack: makeFakeSlackPort() });
			const out = await executeAction(wired.get("slack_read_channel")!, { channel: "C123" });
			expect(out.channelId).toBe("C123");
		});
	});
});
