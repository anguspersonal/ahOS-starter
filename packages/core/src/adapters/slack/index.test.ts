import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createSlackAdapter,
	dayAfter,
	dayBefore,
	parseMatch,
	toSlackTimestamp,
} from "./index.js";

function match(over: Record<string, unknown> = {}) {
	return {
		permalink: "https://work.slack.com/archives/C1/p1757000000000000",
		text: "shipping the calendar reads today",
		ts: "1757000000.000000",
		username: "angus",
		channel: { id: "C1", name: "general" },
		...over,
	};
}

describe("slack date operators (#1535)", () => {
	it("widens the window, because after:/before: are exclusive", () => {
		expect(dayBefore("2026-09-01")).toBe("2026-08-31");
		expect(dayAfter("2026-09-05")).toBe("2026-09-06");
	});

	it("crosses a month boundary correctly", () => {
		expect(dayBefore("2026-09-01")).toBe("2026-08-31");
		expect(dayAfter("2026-08-31")).toBe("2026-09-01");
	});

	it("converts ISO dates and Slack timestamps via toSlackTimestamp", () => {
		expect(toSlackTimestamp("1700000000.000100")).toBe("1700000000.000100");
		expect(toSlackTimestamp("2026-10-01")).toBe("1790812800.000000");
	});
});

describe("createSlackAdapter (#1535)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("viewer() calls auth.test and returns login and teamName", async () => {
		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			expect(String(input)).toContain("https://slack.com/api/auth.test");
			expect((init?.headers as Record<string, string>)?.Authorization).toBe(
				"Bearer test-slack-p-token",
			);
			return new Response(JSON.stringify({ ok: true, user: "angus", team: "Work" }), {
				status: 200,
			});
		});

		const adapter = createSlackAdapter(async () => "test-slack-p-token", {
			fetch: fetchMock as unknown as typeof globalThis.fetch,
		});

		await expect(adapter.viewer()).resolves.toEqual({
			login: "angus",
			teamName: "Work",
		});
	});

	it("searchMyMessages searches only for the owner's own messages with widened date bounds", async () => {
		const urls: string[] = [];
		const fetchMock = vi.fn(async (input: unknown) => {
			urls.push(String(input));
			return new Response(
				JSON.stringify({
					ok: true,
					messages: {
						matches: [
							match(),
							match({ permalink: "" }),
						],
					},
				}),
				{ status: 200 },
			);
		});

		const adapter = createSlackAdapter(async () => "test-slack-p-token", {
			fetch: fetchMock as unknown as typeof globalThis.fetch,
		});

		const out = await adapter.searchMyMessages({
			login: "angus",
			since: "2026-09-01",
			until: "2026-09-05",
			channel: "general",
			count: 50,
		});

		expect(urls).toHaveLength(1);
		const decoded = decodeURIComponent(urls[0]!);
		expect(decoded).toContain("from:@angus");
		expect(decoded).toContain("after:2026-08-31");
		expect(decoded).toContain("before:2026-09-06");
		expect(decoded).toContain("in:#general");
		expect(out).toHaveLength(1);
		expect(out[0]?.permalink).toBe(
			"https://work.slack.com/archives/C1/p1757000000000000",
		);
	});

	it("flags a DM from is_im or is_mpim and labels channelName as dm:<id> when name is empty", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					ok: true,
					messages: {
						matches: [match({ channel: { id: "D9", is_im: true } })],
					},
				}),
				{ status: 200 },
			);
		});

		const adapter = createSlackAdapter(async () => "test-slack-p-token", {
			fetch: fetchMock as unknown as typeof globalThis.fetch,
		});

		const [m] = await adapter.searchMyMessages({
			login: "angus",
			since: "2026-09-01",
			count: 50,
		});

		expect(m?.isDm).toBe(true);
		expect(m?.channelName).toBe("dm:D9");
		expect(parseMatch({ channel: { id: "G7", is_mpim: true } }).isDm).toBe(true);
	});

	it("throws a token-shaped hint when Slack refuses a bot token and never leaks the token in errors", async () => {
		const secretToken = "test-slack-p-token";
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({ ok: false, error: `not_allowed_token_type` }),
				{ status: 200, statusText: "OK" },
			);
		});

		const adapter = createSlackAdapter(async () => secretToken, {
			fetch: fetchMock as unknown as typeof globalThis.fetch,
		});

		let caught: Error | undefined;
		try {
			await adapter.searchMyMessages({
				login: "angus",
				since: "2026-09-01",
				count: 50,
			});
		} catch (err) {
			caught = err as Error;
		}

		expect(caught).toBeDefined();
		expect(caught?.message).toMatch(/USER token/);
		expect(caught?.message).not.toContain(secretToken);
	});

	it("redacts the token on HTTP error and network throw", async () => {
		const secretToken = "test-slack-p-token";
		const httpErrAdapter = createSlackAdapter(async () => secretToken, {
			fetch: (async () =>
				new Response("Forbidden", {
					status: 403,
					statusText: `Forbidden for ${secretToken}`,
				})) as unknown as typeof globalThis.fetch,
		});

		await expect(httpErrAdapter.viewer()).rejects.toThrow(
			"Slack auth.test failed with HTTP 403: Forbidden for [REDACTED]",
		);

		const netErrAdapter = createSlackAdapter(async () => secretToken, {
			fetch: (async () => {
				throw new Error(`Socket error with Bearer ${secretToken}`);
			}) as unknown as typeof globalThis.fetch,
		});

		await expect(netErrAdapter.viewer()).rejects.toThrow(
			"Socket error with Bearer [REDACTED]",
		);
	});
});
