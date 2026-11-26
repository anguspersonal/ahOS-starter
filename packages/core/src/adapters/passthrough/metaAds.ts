import { metaAdsConfigSchema } from "../../domain/integrations.js";
import type { ConfigRepository } from "../../ports/config.js";
import type {
	McpPassthroughCallResult,
	McpPassthroughPort,
	McpPassthroughToolSummary,
} from "../../ports/mcpPassthrough.js";

// Meta Marketing API, read-only, direct REST (#646). This is deliberately NOT a
// passthrough to an upstream MCP server the way Brevo is (ADR-055): Meta's own
// provider-hosted MCP (mcp.facebook.com/ads) is the INTERACTIVE surface (per-surface
// OAuth), which is exactly the thing this ticket exists to complement for headless/
// scheduled sessions, not proxy. There is no session-aware upstream to hand a
// tools/list or tools/call to.
//
// The two-tool meta_ads_list_tools / meta_ads_call_tool SHAPE still mirrors Brevo's
// for calling-convention consistency across the gateway's proxy-style integrations,
// but the catalog below is a small, hand-maintained, entirely GET-based set of
// Marketing API calls we own outright — never a live discovery of someone else's tool list.
//
// Read-only by construction, not just by scope: every entry in TOOLS issues a GET.
// There is no POST/DELETE helper anywhere in this file, so "no write operations,
// ever" (the #646 non-goal) holds even if a caller's arguments are malicious —
// there is no code path here that could pause, edit or create an ad.

export interface MetaAdsPassthroughAdapterOptions {
	accessToken: () => Promise<string> | string;
	config: Pick<ConfigRepository, "loadConfig">;
	apiVersion?: string | (() => string | undefined);
	fetchFn?: typeof fetch;
}

type GraphErrorBody = {
	message?: string;
	type?: string;
	code?: number;
	error_subcode?: number;
	fbtrace_id?: string;
};

type AdapterContext = {
	graphGet: <T = unknown>(
		path: string,
		params?: Record<string, string | number | undefined>,
	) => Promise<T>;
	resolveAdAccountId: (argAccountId: unknown) => Promise<string>;
};

function createAdapterContext(options: MetaAdsPassthroughAdapterOptions): AdapterContext {
	const metaAdsApiVersion = (): string => {
		const raw = typeof options.apiVersion === "function" ? options.apiVersion() : options.apiVersion;
		return raw || "v21.0";
	};

	const graphBaseUrl = (): string => `https://graph.facebook.com/${metaAdsApiVersion()}`;

	/**
	 * One authenticated GET against the Marketing API. There is no method parameter —
	 * intentionally: adding one would be the one-line change that turns this read-only
	 * client into a writer, so it simply isn't there to change.
	 */
	const graphGet = async <T = unknown>(
		path: string,
		params: Record<string, string | number | undefined> = {},
	): Promise<T> => {
		const token = await options.accessToken();

		const qs = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) qs.set(key, String(value));
		}
		const query = qs.toString();
		const url = `${graphBaseUrl()}/${path.replace(/^\/+/, "")}${query ? `?${query}` : ""}`;

		const res = await (options.fetchFn ?? fetch)(url, {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
		});

		const body = await res.text().catch(() => "");
		let parsed: { error?: GraphErrorBody } & Record<string, unknown> = {};
		try {
			parsed = body ? (JSON.parse(body) as typeof parsed) : {};
		} catch {
			// Non-JSON body — fall through and surface the raw text below.
		}

		if (!res.ok || parsed.error) {
			const err = parsed.error;
			// Meta's error object is where the actionable detail lives (a bad token, a
			// missing permission, an unknown field) — a bare "400 Bad Request" would send
			// an agent looking at the wrong thing, same reasoning as posthog/client.ts.
			throw new Error(
				`Meta Marketing API error ${res.status}${
					err ? ` (${err.type ?? "?"} ${err.code ?? "?"}${err.error_subcode ? `/${err.error_subcode}` : ""})` : ""
				}: ${err?.message ?? body.slice(0, 600) ?? res.statusText}`,
			);
		}

		return parsed as T;
	};

	/**
	 * Resolve which ad account a call targets: an explicit `ad_account_id` argument wins,
	 * otherwise fall back to the `meta_ads` integration row's `default_ad_account_id`
	 * (set via integration_set) — the same "explicit argument, else configured
	 * default" shape as event_create's `calendar_id`. Accepts the id with or without the
	 * `act_` prefix Meta's API requires, since that prefix is exactly the kind of detail
	 * worth not making every caller remember.
	 */
	const resolveAdAccountId = async (argAccountId: unknown): Promise<string> => {
		const raw =
			typeof argAccountId === "string" && argAccountId.length > 0
				? argAccountId
				: (await options.config.loadConfig("meta_ads", metaAdsConfigSchema))?.default_ad_account_id;

		if (!raw) {
			throw new Error(
				"No ad_account_id given and no default_ad_account_id configured for provider 'meta_ads'. " +
					"Pass ad_account_id explicitly, or set a default with integration_set({ provider: 'meta_ads', config: { default_ad_account_id: 'act_XXXXXXXXXX' } }). " +
					"Use meta_ads_call_tool with name 'list_ad_accounts' to find the id.",
			);
		}
		const withPrefix = raw.startsWith("act_") ? raw : `act_${raw}`;
		return assertValidGraphId(withPrefix, "ad_account_id");
	};

	return { graphGet, resolveAdAccountId };
}

function requireString(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Missing required argument '${key}'.`);
	}
	return value;
}

// Every one of these ids is interpolated directly into the URL PATH (not the query
// string, which URLSearchParams already encodes safely) — resolveAdAccountId's
// result, campaign_id, adset_id and get_insights' object_id all end up as
// `graphGet(`${id}/edge`, …)`. A caller-supplied id containing '/', '?', '#' or
// similar could otherwise redirect that path to a Graph node/edge outside this
// catalog's intended scope (still same-origin, still GET, still under the
// ads_read-scoped token — this is not an SSRF or credential leak — but it is a
// coercion of the request shape this tool is supposed to fix in place). Real Meta
// node ids are always digits, optionally 'act_'-prefixed; enforcing that closes the
// gap for near-zero cost rather than relying on "the token scope limits the blast
// radius" as the only backstop.
const GRAPH_ID_RE = /^[A-Za-z0-9_]+$/;

function assertValidGraphId(value: string, argName: string): string {
	if (!GRAPH_ID_RE.test(value)) {
		throw new Error(
			`Argument '${argName}' ('${value}') is not a valid Meta object id — only letters, digits and underscores are allowed.`,
		);
	}
	return value;
}

function optionalStringList(args: Record<string, unknown>, key: string): string[] | undefined {
	const value = args[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
		throw new Error(`Argument '${key}' must be an array of strings.`);
	}
	return value as string[];
}

const DEFAULT_CAMPAIGN_FIELDS =
	"id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time";
const DEFAULT_ADSET_FIELDS =
	"id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,start_time,end_time,targeting";
const DEFAULT_AD_FIELDS =
	"id,name,status,effective_status,adset_id,campaign_id,creative{id,name,thumbnail_url}";
const DEFAULT_INSIGHTS_FIELDS = "spend,impressions,clicks,ctr,cpc,cpm,reach,frequency";
const DEFAULT_AD_ACCOUNT_FIELDS = "id,name,account_status,currency,timezone_name";
const DEFAULT_TRANSACTION_FIELDS =
	"id,time,status,charge_type,billing_event_type,payment_option,provider_amount,amount,app_amount,tracking_id,invoice_id,billing_start_time,billing_end_time,billing_reason";

type ToolDef = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	run: (args: Record<string, unknown>, ctx: AdapterContext) => Promise<unknown>;
};

const TOOLS: ToolDef[] = [
	{
		name: "list_ad_accounts",
		description:
			"List the ad accounts this system-user token can see (id, name, status, currency). Use this to find an ad_account_id — there is no other way to discover one from inside ahkms.",
		inputSchema: {
			type: "object",
			properties: {
				limit: { type: "number", description: "Max accounts per page (Meta default applies if omitted)." },
			},
		},
		run: async (args, ctx) =>
			ctx.graphGet("me/adaccounts", {
				fields: DEFAULT_AD_ACCOUNT_FIELDS,
				limit: args.limit as number | undefined,
			}),
	},
	{
		name: "list_campaigns",
		description:
			"List campaigns in an ad account, with status, effective delivery status, objective and budget.",
		inputSchema: {
			type: "object",
			properties: {
				ad_account_id: {
					type: "string",
					description: "Meta ad account id, e.g. 'act_123456789'. Falls back to the configured default_ad_account_id.",
				},
				fields: { type: "array", items: { type: "string" }, description: `Override the default field list (${DEFAULT_CAMPAIGN_FIELDS}).` },
				limit: { type: "number", description: "Max campaigns per page." },
			},
		},
		run: async (args, ctx) => {
			const accountId = await ctx.resolveAdAccountId(args.ad_account_id);
			const fields = optionalStringList(args, "fields")?.join(",") ?? DEFAULT_CAMPAIGN_FIELDS;
			return ctx.graphGet(`${accountId}/campaigns`, { fields, limit: args.limit as number | undefined });
		},
	},
	{
		name: "list_adsets",
		description:
			"List ad sets, either every ad set in an account or scoped to one campaign_id, with status and budget.",
		inputSchema: {
			type: "object",
			properties: {
				campaign_id: { type: "string", description: "Scope to this campaign's ad sets. Takes priority over ad_account_id." },
				ad_account_id: { type: "string", description: "Meta ad account id. Used only when campaign_id is omitted; falls back to the configured default." },
				fields: { type: "array", items: { type: "string" }, description: `Override the default field list (${DEFAULT_ADSET_FIELDS}).` },
				limit: { type: "number", description: "Max ad sets per page." },
			},
		},
		run: async (args, ctx) => {
			const fields = optionalStringList(args, "fields")?.join(",") ?? DEFAULT_ADSET_FIELDS;
			const campaignId =
				typeof args.campaign_id === "string" && args.campaign_id
					? assertValidGraphId(args.campaign_id, "campaign_id")
					: undefined;
			const scope = campaignId ? `${campaignId}/adsets` : `${await ctx.resolveAdAccountId(args.ad_account_id)}/adsets`;
			return ctx.graphGet(scope, { fields, limit: args.limit as number | undefined });
		},
	},
	{
		name: "list_ads",
		description:
			"List ads, scoped to one adset_id, one campaign_id, or a whole ad account, with status and delivery.",
		inputSchema: {
			type: "object",
			properties: {
				adset_id: { type: "string", description: "Scope to this ad set's ads. Takes priority over campaign_id and ad_account_id." },
				campaign_id: { type: "string", description: "Scope to this campaign's ads. Used only when adset_id is omitted." },
				ad_account_id: { type: "string", description: "Meta ad account id. Used only when adset_id and campaign_id are both omitted; falls back to the configured default." },
				fields: { type: "array", items: { type: "string" }, description: `Override the default field list (${DEFAULT_AD_FIELDS}).` },
				limit: { type: "number", description: "Max ads per page." },
			},
		},
		run: async (args, ctx) => {
			const fields = optionalStringList(args, "fields")?.join(",") ?? DEFAULT_AD_FIELDS;
			const adsetId =
				typeof args.adset_id === "string" && args.adset_id
					? assertValidGraphId(args.adset_id, "adset_id")
					: undefined;
			const campaignId =
				typeof args.campaign_id === "string" && args.campaign_id
					? assertValidGraphId(args.campaign_id, "campaign_id")
					: undefined;
			const scope = adsetId
				? `${adsetId}/ads`
				: campaignId
					? `${campaignId}/ads`
					: `${await ctx.resolveAdAccountId(args.ad_account_id)}/ads`;
			return ctx.graphGet(scope, { fields, limit: args.limit as number | undefined });
		},
	},
	{
		name: "get_insights",
		description:
			"Spend, impressions, clicks and related metrics for one campaign/ad set/ad/account, daily or hourly. This is the tool behind 'spend and impressions per ad for campaign X, hourly, last 48h': pass object_id=<ad id> (or a campaign/adset id with the matching level), granularity='hourly', time_range={since,until}.",
		inputSchema: {
			type: "object",
			properties: {
				object_id: { type: "string", description: "Campaign, ad set, ad, or ad account (act_...) id to report on. Required." },
				level: { type: "string", enum: ["account", "campaign", "adset", "ad"], description: "Aggregation level. Omit to let Meta infer it from object_id's type." },
				granularity: { type: "string", enum: ["daily", "hourly"], description: "Defaults to 'daily' (time_increment=1). 'hourly' breaks down by hourly_stats_aggregated_by_advertiser_time_zone." },
				time_range: {
					type: "object",
					properties: { since: { type: "string", description: "YYYY-MM-DD" }, until: { type: "string", description: "YYYY-MM-DD" } },
					description: "Explicit date window. Provide this OR date_preset, not both.",
				},
				date_preset: {
					type: "string",
					description: "A Meta date preset, e.g. 'last_7d', 'yesterday', 'last_30d'. Provide this OR time_range.",
				},
				fields: { type: "array", items: { type: "string" }, description: `Override the default field list (${DEFAULT_INSIGHTS_FIELDS}).` },
				limit: { type: "number", description: "Max rows per page." },
			},
			required: ["object_id"],
		},
		run: async (args, ctx) => {
			const objectId = assertValidGraphId(requireString(args, "object_id"), "object_id");
			const fields = optionalStringList(args, "fields")?.join(",") ?? DEFAULT_INSIGHTS_FIELDS;
			const params: Record<string, string | number | undefined> = {
				fields,
				limit: args.limit as number | undefined,
			};

			if (typeof args.level === "string" && args.level) params.level = args.level;

			const granularity = typeof args.granularity === "string" ? args.granularity : "daily";
			if (granularity === "hourly") {
				params.breakdowns = "hourly_stats_aggregated_by_advertiser_time_zone";
			} else if (granularity === "daily") {
				params.time_increment = 1;
			} else {
				throw new Error(`Unknown granularity '${granularity}'. Use 'daily' or 'hourly'.`);
			}

			if (args.time_range && typeof args.time_range === "object") {
				const tr = args.time_range as { since?: unknown; until?: unknown };
				if (typeof tr.since !== "string" || typeof tr.until !== "string" || !tr.since || !tr.until) {
					throw new Error("time_range requires both 'since' and 'until' as YYYY-MM-DD strings.");
				}
				params.time_range = JSON.stringify({ since: tr.since, until: tr.until });
			} else if (typeof args.date_preset === "string" && args.date_preset) {
				params.date_preset = args.date_preset;
			} else {
				throw new Error("get_insights requires either time_range ({ since, until }) or date_preset.");
			}

			return ctx.graphGet(`${objectId}/insights`, params);
		},
	},
	{
		name: "list_transactions",
		description:
			"List billing transactions for an ad account, including amounts billed, billing periods, payment option, status, and invoice IDs.",
		inputSchema: {
			type: "object",
			properties: {
				ad_account_id: {
					type: "string",
					description: "Meta ad account id, e.g. 'act_123456789'. Falls back to the configured default_ad_account_id.",
				},
				fields: { type: "array", items: { type: "string" }, description: `Override the default field list (${DEFAULT_TRANSACTION_FIELDS}).` },
				limit: { type: "number", description: "Max transactions per page." },
				time_start: { type: "number", description: "Unix timestamp (seconds) lower bound for transaction time." },
				time_stop: { type: "number", description: "Unix timestamp (seconds) upper bound for transaction time." },
			},
		},
		run: async (args, ctx) => {
			const accountId = await ctx.resolveAdAccountId(args.ad_account_id);
			const fields = optionalStringList(args, "fields")?.join(",") ?? DEFAULT_TRANSACTION_FIELDS;
			return ctx.graphGet(`${accountId}/transactions`, {
				fields,
				limit: args.limit as number | undefined,
				time_start: args.time_start as number | undefined,
				time_stop: args.time_stop as number | undefined,
			});
		},
	},
];

export function createMetaAdsPassthroughAdapter(
	options: MetaAdsPassthroughAdapterOptions,
): McpPassthroughPort {
	const ctx = createAdapterContext(options);

	return {
		/** The static catalog — nothing here is discovered live, unlike Brevo's tools/list. */
		async listTools(): Promise<McpPassthroughToolSummary[]> {
			return TOOLS.map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: t.inputSchema,
			}));
		},
		async callTool(name: string, args: Record<string, unknown>): Promise<McpPassthroughCallResult> {
			const tool = TOOLS.find((t) => t.name === name);
			if (!tool) {
				throw new Error(
					`Unknown Meta Ads tool '${name}'. Call meta_ads_list_tools to see the available tools: ${TOOLS.map((t) => t.name).join(", ")}.`,
				);
			}

			const result = await tool.run(args, ctx);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
		},
	};
}
