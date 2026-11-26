import { afterEach, describe, expect, it, vi } from "vitest";
import { createRevenueCatAdapter, getRevenueCatMetrics } from "./index.js";

const mockedGetCredential = vi.fn<() => Promise<string>>();

function jsonRes(body: unknown, opts: { status?: number } = {}): Response {
	const status = opts.status ?? 200;
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: String(status),
		text: async () => JSON.stringify(body),
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

describe("getRevenueCatMetrics — setup", () => {
	it("propagates a clear setup error when REVENUECAT_API_KEY is unset", async () => {
		mockedGetCredential.mockRejectedValue(
			new Error(
				"REVENUECAT_API_KEY is not set — required for the RevenueCat metrics tool (revenuecat_get_metrics, #647). See packages/mcp-server/.env.example",
			),
		);

		const adapter = createRevenueCatAdapter(mockedGetCredential);
		await expect(adapter.getMetrics("proj_123")).rejects.toThrow(
			/REVENUECAT_API_KEY is not set/,
		);
	});
});

describe("getRevenueCatMetrics — configured", () => {
	it("GETs the v2 project metrics endpoint with a bearer token and no write method", async () => {
		mockedGetCredential.mockResolvedValue("sk_test_token");
		const fetchMock = stubFetch(
			jsonRes({
				object: "overview_metrics",
				metrics: [
					{ id: "active_subscriptions", name: "Active Subscriptions", value: 1234 },
					{ id: "active_trials", name: "Active Trials", value: 56 },
					{ id: "mrr", name: "MRR", value: 7890.5 },
					{ id: "churn", name: "Churn", value: 0.02 },
				],
			}),
		);

		const out = await getRevenueCatMetrics("proj_123", mockedGetCredential);

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://api.revenuecat.com/v2/projects/proj_123/metrics/overview");
		expect(init.method).toBe("GET");
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer sk_test_token",
		);
		expect(out.activeSubscriptions).toEqual({
			id: "active_subscriptions",
			name: "Active Subscriptions",
			value: 1234,
		});
		expect(out.activeTrials?.value).toBe(56);
		expect(out.mrr?.value).toBe(7890.5);
	});

	it("URL-encodes the project id", async () => {
		mockedGetCredential.mockResolvedValue("sk_test_token");
		const fetchMock = stubFetch(jsonRes({ metrics: [] }));

		await getRevenueCatMetrics("proj/with space", mockedGetCredential);

		const [url] = fetchMock.mock.calls[0] as unknown as [string];
		expect(url).toBe(
			`https://api.revenuecat.com/v2/projects/${encodeURIComponent("proj/with space")}/metrics/overview`,
		);
	});

	it("reports a metric RevenueCat did not return as null rather than throwing", async () => {
		mockedGetCredential.mockResolvedValue("sk_test_token");
		stubFetch(jsonRes({ metrics: [{ id: "active_subscriptions", name: "Active Subscriptions", value: 10 }] }));

		const out = await getRevenueCatMetrics("proj_123", mockedGetCredential);

		expect(out.activeSubscriptions?.value).toBe(10);
		expect(out.activeTrials).toBeNull();
		expect(out.mrr).toBeNull();
	});
});

describe("getRevenueCatMetrics — upstream error surfacing", () => {
	it("surfaces a 4xx without the key", async () => {
		mockedGetCredential.mockResolvedValue("sk_super_secret");
		stubFetch(jsonRes({ message: "Invalid API key." }, { status: 401 }));

		const err = await getRevenueCatMetrics("proj_123", mockedGetCredential).catch((e: Error) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toMatch(/RevenueCat API error 401/);
		expect((err as Error).message).toMatch(/Invalid API key\./);
		expect((err as Error).message).not.toContain("sk_super_secret");
	});
});
