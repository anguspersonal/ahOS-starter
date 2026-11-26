import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../credentials.js", () => ({ getCredential: vi.fn() }));

import {
	readSlackChannel,
	readSlackThread,
	searchSlackMessages,
	toSlackTimestamp,
} from "../slack/client.js";
import { getCredential } from "../credentials.js";

const mockedGetCredential = getCredential as unknown as ReturnType<typeof vi.fn>;

function jsonRes(body: unknown, opts: { status?: number } = {}): Response {
	const status = opts.status ?? 200;
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: String(status),
		text: async () => JSON.stringify(body),
		json: async () => body,
	} as unknown as Response;
}

function stubFetch(response: Response) {
	const fetchMock = vi.fn(async () => response);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
	mockedGetCredential.mockReset();
});

describe("slack/client - interactive read and search (#2008, ADR-113)", () => {
	it("reads channel history directly when given a channel ID and converts ISO date bounds", async () => {
		mockedGetCredential.mockResolvedValue("test-slack-p-token");
		const fetchMock = stubFetch(
			jsonRes({
				ok: true,
				messages: [
					{
						ts: "1700000000.000100",
						user: "U123",
						text: "Hello channel",
						thread_ts: "1700000000.000100",
						reply_count: 3,
					},
				],
				has_more: true,
				response_metadata: { next_cursor: "cursor-next-1" },
			}),
		);

		const out = await readSlackChannel({
			channel: "C0123456789",
			limit: 10,
			oldest: "2026-10-01",
		});

		expect(mockedGetCredential).toHaveBeenCalledWith("slack");
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toContain("https://slack.com/api/conversations.history?");
		expect(url).toContain("channel=C0123456789");
		expect(url).toContain("limit=10");
		expect(url).toContain(`oldest=${encodeURIComponent(toSlackTimestamp("2026-10-01"))}`);
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer test-slack-p-token",
		);
		expect(out).toEqual({
			channelId: "C0123456789",
			messages: [
				{
					ts: "1700000000.000100",
					sentAt: "2023-11-14T22:13:20.000Z",
					user: "U123",
					text: "Hello channel",
					threadTs: "1700000000.000100",
					replyCount: 3,
				},
			],
			hasMore: true,
			nextCursor: "cursor-next-1",
		});
	});

	it("resolves #channel-name via conversations.list before calling conversations.history", async () => {
		mockedGetCredential.mockResolvedValue("test-slack-p-token");
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonRes({
					ok: true,
					channels: [
						{ id: "C1111111111", name: "random" },
						{ id: "C2222222222", name: "general" },
					],
				}),
			)
			.mockResolvedValueOnce(
				jsonRes({
					ok: true,
					messages: [{ ts: "1700000000.000100", user: "U1", text: "Hi general" }],
					has_more: false,
				}),
			);
		vi.stubGlobal("fetch", fetchMock);

		const out = await readSlackChannel({ channel: "#general" });

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain("conversations.list");
		expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toContain("channel=C2222222222");
		expect(out.channelId).toBe("C2222222222");
		expect(out.messages).toHaveLength(1);
	});

	it("reads thread replies via conversations.replies", async () => {
		mockedGetCredential.mockResolvedValue("test-slack-p-token");
		const fetchMock = stubFetch(
			jsonRes({
				ok: true,
				messages: [
					{ ts: "1700000000.000100", user: "U1", text: "Root" },
					{ ts: "1700000010.000200", user: "U2", text: "Reply" },
				],
				has_more: false,
			}),
		);

		const out = await readSlackThread({
			channel: "C0123456789",
			threadTs: "1700000000.000100",
			limit: 25,
		});

		const [url] = fetchMock.mock.calls[0] as unknown as [string];
		expect(url).toContain("conversations.replies");
		expect(url).toContain("channel=C0123456789");
		expect(url).toContain("ts=1700000000.000100");
		expect(url).toContain("limit=25");
		expect(out.messages).toHaveLength(2);
		expect(out.threadTs).toBe("1700000000.000100");
	});

	it("searches messages via search.messages and surfaces scope hints on missing_scope", async () => {
		mockedGetCredential.mockResolvedValue("test-slack-p-token");
		const fetchMock = stubFetch(
			jsonRes({
				ok: true,
				messages: {
					total: 1,
					matches: [
						{
							permalink: "https://work.slack.com/archives/C1/p1700000000000100",
							text: "Found it",
							ts: "1700000000.000100",
							username: "angus",
							channel: { id: "C1", name: "general", is_im: false, is_mpim: false },
						},
					],
				},
			}),
		);

		const out = await searchSlackMessages({
			query: "in:#general Found",
			count: 15,
			sort: "score",
			sortDir: "asc",
		});

		const [url] = fetchMock.mock.calls[0] as unknown as [string];
		expect(url).toContain("search.messages");
		expect(url).toContain("sort=score");
		expect(url).toContain("sort_dir=asc");
		expect(out.total).toBe(1);
		expect(out.matches[0]?.channelName).toBe("general");

		stubFetch(
			jsonRes({
				ok: false,
				error: "missing_scope",
				needed: "channels:history",
			}),
		);

		await expect(readSlackChannel({ channel: "C0123456789" })).rejects.toThrow(
			/missing_scope.*channels:history/,
		);
	});
});
