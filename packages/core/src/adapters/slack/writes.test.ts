import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackWriteAdapter } from "./writes.js";

const jsonRes = (body: unknown, status = 200, headers?: Record<string, string>) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

describe("createSlackWriteAdapter (#1526)", () => {
	afterEach(() => vi.restoreAllMocks());

	it("sends chat.update, chat.delete, and reactions.add payloads with stripped colons", async () => {
		const fetchSpy = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonRes({ ok: true, channel: "C0123ABC", ts: "1712000000.000100" }))
			.mockResolvedValueOnce(jsonRes({ ok: true }))
			.mockResolvedValueOnce(jsonRes({ ok: true }));
		const adapter = createSlackWriteAdapter(
			{ userToken: async () => "test-slack-p-token", botToken: async () => "test-slack-b-token" },
			{ fetch: fetchSpy },
		);

		expect(await adapter.updateMessage({ channel: "C0123ABC", ts: "1712000000.000100", text: "fixed" })).toEqual({
			channel_id: "C0123ABC",
			ts: "1712000000.000100",
		});
		expect(await adapter.deleteMessage({ channel: "C0123ABC", ts: "1712000000.000100" })).toEqual({ deleted: true });
		expect(await adapter.addReaction({ channel: "C0123ABC", ts: "1712000000.000100", name: ":thumbsup:" })).toEqual({
			added: true,
		});
		expect(JSON.parse(fetchSpy.mock.calls[2]?.[1]?.body as string)).toEqual({
			channel: "C0123ABC",
			timestamp: "1712000000.000100",
			name: "thumbsup",
		});
	});

	it("retries once on HTTP 429 respecting Retry-After and surfaces scope/token hints without leaking tokens", async () => {
		const sleeps: number[] = [];
		const fetchSpy = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonRes({ ok: false }, 429, { "Retry-After": "2" }))
			.mockResolvedValueOnce(jsonRes({ ok: true }))
			.mockResolvedValueOnce(jsonRes({ ok: false, error: "missing_scope", needed: "reactions:write" }))
			.mockResolvedValueOnce(jsonRes({ ok: false, error: "not_allowed_token_type" }));
		const adapter = createSlackWriteAdapter(
			{ userToken: async () => "test-slack-p-token", botToken: async () => "test-slack-b-token" },
			{ fetch: fetchSpy, sleep: async (ms) => void sleeps.push(ms) },
		);

		expect(await adapter.addReaction({ channel: "C1", ts: "1.1", name: "eyes" })).toEqual({ added: true });
		expect(sleeps).toEqual([2_000]);
		await expect(adapter.addReaction({ channel: "C1", ts: "1.1", name: "eyes" })).rejects.toThrow(
			"the token needs the `reactions:write` scope",
		);
		await expect(adapter.addReaction({ channel: "C1", ts: "1.1", name: "eyes" })).rejects.toThrow(
			"this needs a USER token, xoxp-, not a bot token",
		);
	});
});
