import { describe, expect, it, vi } from "vitest";
import { createMetaAdsPassthroughAdapter } from "./metaAds.js";

function jsonRes(body: unknown, opts: { status?: number } = {}): Response {
	const status = opts.status ?? 200;
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: String(status),
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}

function makeAdapter(opts: {
	accessToken?: () => Promise<string> | string;
	loadConfig?: ReturnType<typeof vi.fn>;
	apiVersion?: string | (() => string | undefined);
	response?: Response;
} = {}) {
	const fetchMock = vi.fn(async () => opts.response ?? jsonRes({ data: [] }));
	const loadConfig = opts.loadConfig ?? vi.fn(async () => null);
	const accessToken = opts.accessToken ?? (() => "test-token");
	const adapter = createMetaAdsPassthroughAdapter({
		accessToken,
		config: { loadConfig },
		apiVersion: opts.apiVersion,
		fetchFn: fetchMock as unknown as typeof fetch,
	});
	return { adapter, fetchMock, loadConfig };
}

describe("createMetaAdsPassthroughAdapter — setup and dispatch", () => {
	it("propagates a clear setup error when accessToken throws", async () => {
		const { adapter } = makeAdapter({
			accessToken: async () => {
				throw new Error(
					"META_ADS_ACCESS_TOKEN is not set — required for the Meta Ads tools. See packages/mcp-server/.env.example",
				);
			},
		});

		await expect(adapter.callTool("list_ad_accounts", {})).rejects.toThrow(
			/META_ADS_ACCESS_TOKEN is not set/,
		);
	});

	it("throws for an unknown tool name, naming the real ones, and makes no request", async () => {
		const accessToken = vi.fn(() => "test-token");
		const { adapter, fetchMock } = makeAdapter({ accessToken });

		await expect(adapter.callTool("delete_campaign", {})).rejects.toThrow(
			/Unknown Meta Ads tool 'delete_campaign'/,
		);
		await expect(adapter.callTool("delete_campaign", {})).rejects.toThrow(/list_campaigns/);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(accessToken).not.toHaveBeenCalled();
	});

	it("uses the configured apiVersion and falls back to v21.0 when empty", async () => {
		const { adapter: v22, fetchMock: fetch22 } = makeAdapter({
			apiVersion: () => "v22.0",
			response: jsonRes({ data: [] }),
		});
		await v22.callTool("list_ad_accounts", {});
		expect((fetch22.mock.calls[0] as unknown as [string])[0]).toContain(
			"https://graph.facebook.com/v22.0/me/adaccounts",
		);

		const { adapter: fallback, fetchMock: fetchFallback } = makeAdapter({
			apiVersion: () => "",
			response: jsonRes({ data: [] }),
		});
		await fallback.callTool("list_ad_accounts", {});
		expect((fetchFallback.mock.calls[0] as unknown as [string])[0]).toContain(
			"https://graph.facebook.com/v21.0/me/adaccounts",
		);
	});
});

describe("createMetaAdsPassthroughAdapter — listTools", () => {
	it("returns the static catalog without making any network call", async () => {
		const { adapter, fetchMock } = makeAdapter();

		const tools = await adapter.listTools();

		expect(tools.map((t) => t.name)).toEqual([
			"list_ad_accounts",
			"list_campaigns",
			"list_adsets",
			"list_ads",
			"get_insights",
			"list_transactions",
		]);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("createMetaAdsPassthroughAdapter — list_ad_accounts", () => {
	it("GETs me/adaccounts with a bearer token and no write method or body", async () => {
		const { adapter, fetchMock } = makeAdapter({
			response: jsonRes({ data: [{ id: "act_1", name: "Work" }] }),
		});

		const out = await adapter.callTool("list_ad_accounts", {});

		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toContain("https://graph.facebook.com/v21.0/me/adaccounts");
		expect(url).toContain("fields=id%2Cname%2Caccount_status%2Ccurrency%2Ctimezone_name");
		expect(init.method).toBe("GET");
		expect(init.body).toBeUndefined();
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
		expect(out.content[0].text).toContain("act_1");
	});
});

describe("createMetaAdsPassthroughAdapter — ad_account_id resolution", () => {
	it("uses the explicit ad_account_id, normalising a missing 'act_' prefix", async () => {
		const { adapter, fetchMock } = makeAdapter();

		await adapter.callTool("list_campaigns", { ad_account_id: "123456789" });

		const [url] = fetchMock.mock.calls[0] as unknown as [string];
		expect(url).toContain("/act_123456789/campaigns");
	});

	it("leaves an already-prefixed ad_account_id untouched", async () => {
		const { adapter, fetchMock } = makeAdapter();

		await adapter.callTool("list_campaigns", { ad_account_id: "act_555" });

		const [url] = fetchMock.mock.calls[0] as unknown as [string];
		expect(url).toContain("/act_555/campaigns");
	});

	it("rejects an ad_account_id that would redirect the URL path, without making a request", async () => {
		const { adapter, fetchMock } = makeAdapter();

		await expect(
			adapter.callTool("list_campaigns", { ad_account_id: "1/../../me/adaccounts" }),
		).rejects.toThrow(/not a valid Meta object id/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("falls back to the configured default_ad_account_id when omitted", async () => {
		const loadConfig = vi.fn(async () => ({ default_ad_account_id: "act_999" }));
		const { adapter, fetchMock } = makeAdapter({ loadConfig });

		await adapter.callTool("list_campaigns", {});

		expect(loadConfig).toHaveBeenCalledWith("meta_ads", expect.anything());
		const [url] = fetchMock.mock.calls[0] as unknown as [string];
		expect(url).toContain("/act_999/campaigns");
	});

	it("throws a clear, actionable error when neither is available", async () => {
		const { adapter } = makeAdapter();

		await expect(adapter.callTool("list_campaigns", {})).rejects.toThrow(
			/No ad_account_id given and no default_ad_account_id configured/,
		);
	});
});

describe("createMetaAdsPassthroughAdapter — list_adsets / list_ads scoping", () => {
	it("scopes list_adsets to campaign_id over ad_account_id", async () => {
		const { adapter, fetchMock } = makeAdapter();

		await adapter.callTool("list_adsets", { campaign_id: "cmp_1", ad_account_id: "act_1" });

		const [url] = fetchMock.mock.calls[0] as unknown as [string];
		expect(url).toContain("/cmp_1/adsets");
		expect(url).not.toContain("act_1");
	});

	it("scopes list_ads to adset_id over campaign_id and ad_account_id", async () => {
		const { adapter, fetchMock } = makeAdapter();

		await adapter.callTool("list_ads", {
			adset_id: "as_1",
			campaign_id: "cmp_1",
			ad_account_id: "act_1",
		});

		const [url] = fetchMock.mock.calls[0] as unknown as [string];
		expect(url).toContain("/as_1/ads");
	});

	it("rejects a campaign_id or adset_id that would redirect the URL path", async () => {
		const { adapter, fetchMock } = makeAdapter();

		await expect(
			adapter.callTool("list_adsets", { campaign_id: "cmp_1/../../me" }),
		).rejects.toThrow(/not a valid Meta object id/);
		await expect(
			adapter.callTool("list_ads", { adset_id: "as_1?extra=1" }),
		).rejects.toThrow(/not a valid Meta object id/);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("createMetaAdsPassthroughAdapter — get_insights", () => {
	it("requires object_id", async () => {
		const { adapter } = makeAdapter();
		await expect(adapter.callTool("get_insights", {})).rejects.toThrow(
			/Missing required argument 'object_id'/,
		);
	});

	it("requires time_range or date_preset", async () => {
		const { adapter } = makeAdapter();
		await expect(adapter.callTool("get_insights", { object_id: "ad_1" })).rejects.toThrow(
			/requires either time_range/,
		);
	});

	it("rejects an object_id that would redirect the URL path to a non-catalogue node", async () => {
		const { adapter, fetchMock } = makeAdapter();

		await expect(
			adapter.callTool("get_insights", {
				object_id: "ad_1/../../me/adaccounts",
				date_preset: "last_7d",
			}),
		).rejects.toThrow(/not a valid Meta object id/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("defaults to daily (time_increment=1) with an explicit time_range", async () => {
		const { adapter, fetchMock } = makeAdapter();

		await adapter.callTool("get_insights", {
			object_id: "ad_1",
			time_range: { since: "2026-09-01", until: "2026-09-02" },
		});

		const [url] = fetchMock.mock.calls[0] as unknown as [string];
		expect(url).toContain("https://graph.facebook.com/v21.0/ad_1/insights");
		expect(url).toContain("time_increment=1");
		expect(url).not.toContain("breakdowns=");
		expect(url).toContain("time_range=" + encodeURIComponent('{"since":"2026-09-01","until":"2026-09-02"}'));
	});

	it("switches to the hourly breakdown and drops time_increment when granularity='hourly'", async () => {
		const { adapter, fetchMock } = makeAdapter();

		await adapter.callTool("get_insights", {
			object_id: "ad_1",
			level: "ad",
			granularity: "hourly",
			time_range: { since: "2026-09-10", until: "2026-09-12" },
		});

		const [url] = fetchMock.mock.calls[0] as unknown as [string];
		expect(url).toContain("breakdowns=hourly_stats_aggregated_by_advertiser_time_zone");
		expect(url).not.toContain("time_increment=");
		expect(url).toContain("level=ad");
	});

	it("accepts date_preset instead of time_range", async () => {
		const { adapter, fetchMock } = makeAdapter();

		await adapter.callTool("get_insights", { object_id: "act_1", date_preset: "last_7d" });

		const [url] = fetchMock.mock.calls[0] as unknown as [string];
		expect(url).toContain("date_preset=last_7d");
	});

	it("rejects an unknown granularity", async () => {
		const { adapter } = makeAdapter();
		await expect(
			adapter.callTool("get_insights", {
				object_id: "ad_1",
				granularity: "weekly",
				date_preset: "last_7d",
			}),
		).rejects.toThrow(/Unknown granularity 'weekly'/);
	});
});

describe("createMetaAdsPassthroughAdapter — list_transactions", () => {
	it("GETs /{ad_account_id}/transactions with default transaction fields and resolves default_ad_account_id", async () => {
		const loadConfig = vi.fn(async () => ({ default_ad_account_id: "act_777" }));
		const { adapter, fetchMock } = makeAdapter({
			loadConfig,
			response: jsonRes({
				data: [{ id: "tx_1", invoice_id: "INV-123", amount: "4500", status: "COMPLETED" }],
			}),
		});

		const out = await adapter.callTool("list_transactions", {});

		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toContain("https://graph.facebook.com/v21.0/act_777/transactions");
		expect(url).toContain(
			"fields=" +
				encodeURIComponent(
					"id,time,status,charge_type,billing_event_type,payment_option,provider_amount,amount,app_amount,tracking_id,invoice_id,billing_start_time,billing_end_time,billing_reason",
				),
		);
		expect(init.method).toBe("GET");
		expect(out.content[0].text).toContain("INV-123");
	});

	it("normalises explicit ad_account_id and passes fields, limit, time_start, and time_stop query params", async () => {
		const { adapter, fetchMock } = makeAdapter();

		await adapter.callTool("list_transactions", {
			ad_account_id: "888999",
			fields: ["id", "invoice_id", "amount"],
			limit: 25,
			time_start: 1700000000,
			time_stop: 1700086400,
		});

		const [url] = fetchMock.mock.calls[0] as unknown as [string];
		expect(url).toContain("https://graph.facebook.com/v21.0/act_888999/transactions");
		expect(url).toContain("fields=id%2Cinvoice_id%2Camount");
		expect(url).toContain("limit=25");
		expect(url).toContain("time_start=1700000000");
		expect(url).toContain("time_stop=1700086400");
	});

	it("rejects an ad_account_id that would redirect the URL path, without making a request", async () => {
		const { adapter, fetchMock } = makeAdapter();

		await expect(
			adapter.callTool("list_transactions", { ad_account_id: "123/../../me/adaccounts" }),
		).rejects.toThrow(/not a valid Meta object id/);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("createMetaAdsPassthroughAdapter — read-only GET invariant", () => {
	it("issues GET only with no body for every catalog entry", async () => {
		const { adapter, fetchMock } = makeAdapter({
			loadConfig: vi.fn(async () => ({ default_ad_account_id: "act_1" })),
		});
		const tools = await adapter.listTools();
		const sampleArgs: Record<string, Record<string, unknown>> = {
			list_ad_accounts: {},
			list_campaigns: {},
			list_adsets: {},
			list_ads: {},
			get_insights: { object_id: "act_1", date_preset: "last_7d" },
			list_transactions: {},
		};

		for (const tool of tools) {
			await adapter.callTool(tool.name, sampleArgs[tool.name] ?? {});
		}

		expect(fetchMock).toHaveBeenCalledTimes(tools.length);
		for (const call of fetchMock.mock.calls) {
			const [, init] = call as unknown as [string, RequestInit];
			expect(init.method).toBe("GET");
			expect(init.body).toBeUndefined();
		}
	});
});

describe("createMetaAdsPassthroughAdapter — Graph API error surfacing", () => {
	it("includes Meta's own error type/code/message, not a bare status line", async () => {
		const { adapter } = makeAdapter({
			response: jsonRes(
				{ error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } },
				{ status: 400 },
			),
		});

		await expect(adapter.callTool("list_ad_accounts", {})).rejects.toThrow(
			/Meta Marketing API error 400 \(OAuthException 190\): Invalid OAuth access token\./,
		);
	});
});
