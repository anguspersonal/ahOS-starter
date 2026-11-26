import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackPostAdapter } from "./post.js";

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

describe("createSlackPostAdapter (#1527, #1657)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("propagates the setup error when getToken rejects without calling fetch", async () => {
		const fetchSpy = vi.fn<typeof fetch>();
		const adapter = createSlackPostAdapter(
			async () => {
				throw new Error("Missing Slack bot token (SLACK_TOKEN_BOT_OAUTH).");
			},
			{ fetch: fetchSpy },
		);

		await expect(adapter.postMessage("#all-work-ai", "hello")).rejects.toThrow(
			/SLACK_TOKEN_BOT_OAUTH/,
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("sends POST chat.postMessage with Bearer token, unfurls off by default, and resolves permalink", async () => {
		const fetchSpy = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				jsonResponse({ ok: true, channel: "C0123ABC", ts: "1712000000.000100" }),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					ok: true,
					permalink: "https://work.slack.com/archives/C0123ABC/p1712000000000100",
				}),
			);
		const adapter = createSlackPostAdapter(async () => "test-slack-b-token", { fetch: fetchSpy });

		const result = await adapter.postMessage("#all-work-ai", "ship it");

		expect(result).toEqual({
			channel_id: "C0123ABC",
			ts: "1712000000.000100",
			thread_ts: null,
			permalink: "https://work.slack.com/archives/C0123ABC/p1712000000000100",
		});
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const [url, init] = fetchSpy.mock.calls[0]!;
		expect(url).toBe("https://slack.com/api/chat.postMessage");
		expect(init?.method).toBe("POST");
		expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-slack-b-token");
		expect(JSON.parse(init?.body as string)).toEqual({
			channel: "#all-work-ai",
			text: "ship it",
			unfurl_links: false,
			unfurl_media: false,
		});
		expect(fetchSpy.mock.calls[1]?.[0]).toBe(
			"https://slack.com/api/chat.getPermalink?channel=C0123ABC&message_ts=1712000000.000100",
		);
	});

	it("surfaces Slack's ok:false error with invite hint (Slack returns HTTP 200 on failure) and never leaks the token", async () => {
		const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
			jsonResponse({ ok: false, error: "not_in_channel" }, 200),
		);
		const adapter = createSlackPostAdapter(async () => "test-slack-b-token", { fetch: fetchSpy });

		await expect(adapter.postMessage("#private", "hi")).rejects.toThrow(
			"Slack chat.postMessage failed: not_in_channel (invite the ahOS bot to the channel first)",
		);
	});

	it("surfaces non-JSON body text on HTTP 200 and HTTP 4xx/5xx while redacting the token", async () => {
		const fetch200 = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("<html>gateway proxy html test-slack-b-token</html>", { status: 200 }));
		const adapter200 = createSlackPostAdapter(async () => "test-slack-b-token", { fetch: fetch200 });

		let caught200: Error | undefined;
		try {
			await adapter200.postMessage("#all-work-ai", "hi");
		} catch (err) {
			caught200 = err as Error;
		}
		expect(caught200?.message).toContain("<html>gateway proxy html");
		expect(caught200?.message).not.toContain("test-slack-b-token");

		const fetch429 = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => new Response("rate limited for test-slack-b-token", { status: 429 }));
		const adapter429 = createSlackPostAdapter(async () => "test-slack-b-token", {
			fetch: fetch429,
			sleep: async () => {},
		});

		let caught429: Error | undefined;
		try {
			await adapter429.postMessage("#all-work-ai", "hi");
		} catch (err) {
			caught429 = err as Error;
		}
		expect(fetch429).toHaveBeenCalledTimes(2);
		expect(caught429?.message).toMatch(/Slack chat\.postMessage failed \(HTTP 429\): rate limited/);
		expect(caught429?.message).not.toContain("test-slack-b-token");
	});
});
