import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackPostAdapter } from "../../adapters/slack/post.js";
import { executeAction } from "../adapters/direct.js";
import { createSlackPostAction, type SlackPostInput } from "./post.js";

const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const runPost = (input: SlackPostInput, fetchFn: typeof fetch, sleep: (ms: number) => Promise<void> = async () => {}) => {
	const action = createSlackPostAction(createSlackPostAdapter(async () => "test-slack-b-token", { fetch: fetchFn, sleep }));
	return executeAction(action, input, { context: { caller: "ui" } }).then((out) => ({
		out,
		receipt: action.formatMcp!(out),
	}));
};

describe("slack_post ops alignment (#1657)", () => {
	afterEach(() => vi.restoreAllMocks());

	it("1. sends thread_ts when provided and sends reply_broadcast only when true", async () => {
		const fetchSpy = vi.fn<typeof fetch>().mockImplementation(async (url) =>
			String(url).includes("chat.postMessage")
				? json({ ok: true, channel: "C01", ts: "1712000000.000200" })
				: json({ ok: true, permalink: "https://slack.example/p1" }),
		);

		const { out } = await runPost({ channel: "C01", text: "reply", thread_ts: "123.456" }, fetchSpy);
		expect(out.thread_ts).toBe("123.456");
		const first = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
		expect(first.thread_ts).toBe("123.456");
		expect("reply_broadcast" in first).toBe(false);

		await runPost({ channel: "C01", text: "quiet", thread_ts: "123.456", reply_broadcast: false }, fetchSpy);
		expect("reply_broadcast" in JSON.parse(fetchSpy.mock.calls[2]?.[1]?.body as string)).toBe(false);

		await runPost({ channel: "C01", text: "loud", thread_ts: "123.456", reply_broadcast: true }, fetchSpy);
		expect(JSON.parse(fetchSpy.mock.calls[4]?.[1]?.body as string)).toMatchObject({
			thread_ts: "123.456",
			reply_broadcast: true,
		});
	});

	it("2. resolves permalink via chat.getPermalink and leaves permalink null if lookup fails", async () => {
		const okFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({ ok: true, channel: "C01", ts: "1712000000.000100" }))
			.mockResolvedValueOnce(json({ ok: true, permalink: "https://work.slack.com/archives/C01/p100" }));
		const okRes = await runPost({ channel: "C01", text: "hello" }, okFetch);
		expect(okRes.out.permalink).toBe("https://work.slack.com/archives/C01/p100");
		expect(okRes.receipt).toContain("https://work.slack.com/archives/C01/p100");

		const failFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({ ok: true, channel: "C01", ts: "1712000000.000101" }))
			.mockResolvedValueOnce(json({ ok: false, error: "channel_not_found" }));
		const degraded = await runPost({ channel: "C01", text: "hello" }, failFetch);
		expect(degraded.out).toEqual({ channel_id: "C01", ts: "1712000000.000101", thread_ts: null, permalink: null });
		expect(degraded.receipt).toContain("Permalink unavailable.");
	});

	it("3. omits the posted text from both the structured output and the MCP receipt", async () => {
		const secretBody = "sentinel-never-echo-this-body-778899";
		const fetchSpy = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(json({ ok: true, channel: "C01", ts: "1712000000.000300" }))
			.mockResolvedValueOnce(json({ ok: true, permalink: "https://slack.example/p300" }));
		const { out, receipt } = await runPost({ channel: "C01", text: secretBody }, fetchSpy);

		expect(Object.keys(out).sort()).toEqual(["channel_id", "permalink", "thread_ts", "ts"]);
		expect("text" in out).toBe(false);
		expect(JSON.stringify(out)).not.toContain(secretBody);
		expect(receipt).not.toContain(secretBody);
	});

	it("4. retries HTTP 429 once after Retry-After (capped at 30 s) and never retries HTTP 500", async () => {
		const sleeps: number[] = [];
		const fetch429 = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "Retry-After": "1" } }))
			.mockResolvedValueOnce(json({ ok: true, channel: "C01", ts: "1712000000.000400" }))
			.mockResolvedValueOnce(json({ ok: true, permalink: "https://slack.example/p400" }));
		const { out } = await runPost({ channel: "C01", text: "once" }, fetch429, async (ms) => void sleeps.push(ms));
		expect(out.ts).toBe("1712000000.000400");
		expect(sleeps).toEqual([1_000]);
		expect(fetch429.mock.calls.filter(([u]) => String(u).includes("chat.postMessage"))).toHaveLength(2);

		const capSleeps: number[] = [];
		const fetchCap = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "Retry-After": "120" } }))
			.mockResolvedValueOnce(json({ ok: true, channel: "C01", ts: "1712000000.000401" }))
			.mockResolvedValueOnce(json({ ok: true, permalink: "https://slack.example/p401" }));
		await runPost({ channel: "C01", text: "capped" }, fetchCap, async (ms) => void capSleeps.push(ms));
		expect(capSleeps).toEqual([30_000]);

		const fetch500 = vi.fn<typeof fetch>().mockResolvedValue(new Response("boom", { status: 500 }));
		await expect(runPost({ channel: "C01", text: "no retry" }, fetch500)).rejects.toThrow(/HTTP 500/);
		expect(fetch500).toHaveBeenCalledOnce();
	});

	it("5. sends unfurl_links: false and unfurl_media: false by default, and true when unfurl: true", async () => {
		const fetchSpy = vi.fn<typeof fetch>().mockImplementation(async (url) =>
			String(url).includes("chat.postMessage")
				? json({ ok: true, channel: "C01", ts: "1712000000.000500" })
				: json({ ok: true, permalink: "https://slack.example/p500" }),
		);
		await runPost({ channel: "C01", text: "https://example.com" }, fetchSpy);
		expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string)).toMatchObject({
			unfurl_links: false,
			unfurl_media: false,
		});

		await runPost({ channel: "C01", text: "https://example.com", unfurl: true }, fetchSpy);
		expect(JSON.parse(fetchSpy.mock.calls[2]?.[1]?.body as string)).toMatchObject({
			unfurl_links: true,
			unfurl_media: true,
		});
	});

	it("6. maps not_in_channel and channel_not_found to actionable bot-invite hints", async () => {
		await expect(
			runPost({ channel: "#private", text: "hi" }, vi.fn<typeof fetch>().mockResolvedValue(json({ ok: false, error: "not_in_channel" }))),
		).rejects.toThrow(/invite the ahOS bot to the channel/);
		await expect(
			runPost({ channel: "C999999", text: "hi" }, vi.fn<typeof fetch>().mockResolvedValue(json({ ok: false, error: "channel_not_found" }))),
		).rejects.toThrow(/channel_not_found.*invite the ahOS bot/i);
	});
});
