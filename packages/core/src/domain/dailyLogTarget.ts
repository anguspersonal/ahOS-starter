import type { z } from "zod";
import { DOMAIN_PROVIDER, type Domain } from "./domains.js";
import {
	notionConfigSchema,
	notionPersonalConfigSchema,
	type IntegrationConfigResult,
	type NotionConfig,
	type NotionPersonalConfig,
} from "./integrations.js";
import type { ConfigRepository } from "../ports/config.js";
import type { NotionPort, NotionResolvedDailyLogTarget } from "../ports/notion.js";

// Where a domain's Daily Log lives, and what happens when it cannot be seen (#1487).
//
// This module exists for the same reason `domains.ts` does. `resolveDailyLogTarget`
// and `reachabilityError` were private to tools/createDailyLogEntry.ts until a SECOND
// caller arrived — #656's Step 0 config/Notion reconciliation check, which must open
// exactly the destination the writer will later open, or it verifies the wrong
// database and reports a clean bill of health for a write that then fails. A copied
// resolver is the thing that drifts; one shared resolver cannot.
//
// Nothing here writes. Resolving a target is two reads (integration config, then the
// credential via NotionPort.resolveToken), and the caller decides what to do with it.

export type DailyLogProvider = (typeof DOMAIN_PROVIDER)[Domain];

/** The destination and the token for one domain. Both per-domain: two logs, two workspaces. */
export type DailyLogTarget = {
	databaseId: string;
	dataSourceId?: string;
	token: string;
	provider: DailyLogProvider;
};

/** Where a domain's Daily Log is, without the credential half. See {@link peekDailyLogTarget}. */
export type DailyLogPointer = {
	databaseId: string;
	dataSourceId?: string;
};

export type LoadIntegrationConfigDetailedFn = <T>(
	provider: string,
	schema: z.ZodType<T>,
) => Promise<IntegrationConfigResult<T>>;

export type DailyLogTokenResolverFn = (
	workspace: Domain,
	provider: DailyLogProvider,
) => Promise<string> | string;

export type DailyLogConfigSource =
	| LoadIntegrationConfigDetailedFn
	| Pick<ConfigRepository, "loadConfigDetailed">
	| { loadIntegrationConfigDetailed: LoadIntegrationConfigDetailedFn };

export type DailyLogTokenSource =
	| DailyLogTokenResolverFn
	| Pick<NotionPort, "resolveToken">;

export interface DailyLogTargetDeps {
	config?: DailyLogConfigSource;
	loadConfigDetailed?: LoadIntegrationConfigDetailedFn;
	loadIntegrationConfigDetailed?: LoadIntegrationConfigDetailedFn;
	resolveToken?: DailyLogTokenSource;
	notion?: Pick<NotionPort, "resolveToken">;
}

function toConfigLoader(
	source: DailyLogConfigSource | DailyLogTargetDeps,
): LoadIntegrationConfigDetailedFn {
	if (typeof source === "function") return source;
	if ("config" in source && source.config) return toConfigLoader(source.config);
	if ("loadConfigDetailed" in source && typeof source.loadConfigDetailed === "function") {
		return (provider, schema) => source.loadConfigDetailed!(provider, schema);
	}
	if (
		"loadIntegrationConfigDetailed" in source &&
		typeof source.loadIntegrationConfigDetailed === "function"
	) {
		return (provider, schema) => source.loadIntegrationConfigDetailed!(provider, schema);
	}
	throw new Error("Daily Log target resolution requires a config loader (`loadConfigDetailed`).");
}

function toTokenResolver(
	deps: DailyLogTargetDeps | DailyLogTokenSource,
): (domain: Domain, provider: DailyLogProvider) => Promise<string> {
	if (typeof deps === "function") {
		return async (domain, provider) => deps(domain, provider);
	}
	if ("notion" in deps && deps.notion && typeof deps.notion.resolveToken === "function") {
		return (domain) => deps.notion!.resolveToken(domain);
	}
	if ("resolveToken" in deps && deps.resolveToken) {
		if (typeof deps.resolveToken === "function") {
			const fn = deps.resolveToken as DailyLogTokenResolverFn;
			return async (domain, provider) => fn(domain, provider);
		}
		if (
			typeof deps.resolveToken === "object" &&
			typeof deps.resolveToken.resolveToken === "function"
		) {
			const port = deps.resolveToken as Pick<NotionPort, "resolveToken">;
			return (domain) => port.resolveToken(domain);
		}
	}
	throw new Error(
		"Daily Log target resolution requires a token resolver (`NotionPort.resolveToken` or `resolveToken`).",
	);
}

/**
 * Thrown when a domain's Daily Log is not configured or disabled in user_integrations.
 * Distinguished from transient DB or network read errors.
 */
export class DailyLogUnwiredError extends Error {
	readonly domain: Domain;
	constructor(domain: Domain, provider: string, attempted = "so nothing was written.") {
		super(
			[
				"No daily_log_database_id for domain '" +
					domain +
					`' — that Daily Log is unwired, ${attempted}`,
				"Wire it in two steps:",
				"1. integration_set({ provider: '" +
					provider +
					"', config: { daily_log_database_id: '<database id of that domain's Daily Log DB>', daily_log_data_source_id: '<its data source id>' } })",
				"2. In Notion, open that database → ⋯ → Connections → ahKMS, and do the same for its parent page. Notion exposes no page-sharing API, so without this step every configured pointer 404s (#355, #655).",
				"The data source id is not needed for the write itself, but without it the duplicate guard cannot run (#673).",
			].join("\n"),
		);
		this.name = "DailyLogUnwiredError";
		this.domain = domain;
	}
}

/** True when a thrown error is the unwired Daily Log error. */
export function isDailyLogUnwired(err: unknown): err is DailyLogUnwiredError {
	return (
		err instanceof DailyLogUnwiredError ||
		(err instanceof Error && err.message.includes("— that Daily Log is unwired,"))
	);
}

/** The one config read shared by {@link resolveDailyLogTarget}, {@link peekDailyLogTarget}, and the NotionPort target compositions. */
export async function loadDailyLogConfig(
	domain: Domain,
	config: DailyLogConfigSource | DailyLogTargetDeps,
): Promise<{
	provider: DailyLogProvider;
	result: IntegrationConfigResult<NotionConfig | NotionPersonalConfig>;
}> {
	const provider = DOMAIN_PROVIDER[domain];
	const load = toConfigLoader(config);
	const result =
		domain === "work"
			? await load(provider, notionConfigSchema)
			: await load(provider, notionPersonalConfigSchema);
	return { provider, result };
}

/**
 * The domain's Daily Log pointer(s) — database id and, when wired, data source id — with
 * no credential fetch and no throw on an unwired domain: `null` instead.
 */
export async function peekDailyLogTarget(
	domain: Domain,
	config: DailyLogConfigSource | DailyLogTargetDeps,
): Promise<DailyLogPointer | null> {
	const { result } = await loadDailyLogConfig(domain, config);
	if (result.status !== "ok" || !result.data.daily_log_database_id) return null;
	return {
		databaseId: result.data.daily_log_database_id,
		dataSourceId: result.data.daily_log_data_source_id,
	};
}

/**
 * The domain's Daily Log pointer IDs (database id and, when wired, data source id)
 * built from {@link peekDailyLogTarget} for `NotionPort.getDailyLogTargetIds` (#1572, #1487).
 */
export async function dailyLogTargetIds(
	domain: Domain,
	config: DailyLogConfigSource | DailyLogTargetDeps,
): Promise<string[]> {
	const pointer = await peekDailyLogTarget(domain, config);
	if (!pointer) return [];
	return [pointer.databaseId, pointer.dataSourceId].filter((v): v is string => Boolean(v));
}

export const getDailyLogTargetIds = dailyLogTargetIds;

/**
 * Resolve a domain's Daily Log pointer for `NotionPort.resolveDailyLogTarget` (#1576, #1487).
 * Shares `loadDailyLogConfig` so there is one Daily Log target lookup.
 */
export async function resolveDailyLogPortTarget(
	domain: Domain,
	config: DailyLogConfigSource | DailyLogTargetDeps,
	attempted = "so nothing was written.",
): Promise<NotionResolvedDailyLogTarget & { provider: DailyLogProvider }> {
	const { provider, result } = await loadDailyLogConfig(domain, config);

	if (result.status === "error") {
		const message =
			result.error instanceof Error ? result.error.message : String(result.error);
		throw new Error(
			`Failed to read integration config for provider '${provider}': ${message}`,
			{ cause: result.error },
		);
	}

	if (result.status !== "ok" || !result.data.daily_log_database_id) {
		throw new DailyLogUnwiredError(domain, provider, attempted);
	}

	return {
		databaseId: result.data.daily_log_database_id,
		dataSourceId: result.data.daily_log_data_source_id,
		workspace: domain,
		provider,
	};
}

/**
 * Resolve a domain to its Daily Log database, its data source (when wired) and its own
 * Notion credential from the injected `NotionPort.resolveToken` resolver.
 */
export async function resolveDailyLogTarget(
	domain: Domain,
	attemptedOrDeps: string | DailyLogTargetDeps,
	maybeDeps?: DailyLogTargetDeps,
): Promise<DailyLogTarget> {
	const attempted =
		typeof attemptedOrDeps === "string" ? attemptedOrDeps : "so nothing was written.";
	const deps = typeof attemptedOrDeps === "string" ? maybeDeps : attemptedOrDeps;
	if (!deps) {
		throw new Error("resolveDailyLogTarget requires DailyLogTargetDeps (`config` and `resolveToken`).");
	}

	const resolved = await resolveDailyLogPortTarget(domain, deps, attempted);
	const resolveToken = toTokenResolver(deps);
	const token = await resolveToken(domain, resolved.provider);

	return {
		databaseId: resolved.databaseId,
		dataSourceId: resolved.dataSourceId,
		token,
		provider: resolved.provider,
	};
}

/**
 * Bind `config` and `resolveToken` into the full suite of Daily Log target helpers (#1487).
 */
export function createDailyLogTargetResolver(deps: DailyLogTargetDeps) {
	return {
		peekDailyLogTarget: (domain: Domain) => peekDailyLogTarget(domain, deps),
		dailyLogTargetIds: (domain: Domain) => dailyLogTargetIds(domain, deps),
		getDailyLogTargetIds: (workspace: string) =>
			dailyLogTargetIds(workspace as Domain, deps),
		resolveDailyLogPortTarget: (
			domain: Domain,
			attempted = "so nothing was written.",
		): Promise<NotionResolvedDailyLogTarget> =>
			resolveDailyLogPortTarget(domain, deps, attempted).then(
				({ databaseId, dataSourceId, workspace }) => ({
					databaseId,
					dataSourceId,
					workspace,
				}),
			),
		resolveDailyLogTarget: (
			domain: Domain,
			attempted = "so nothing was written.",
		): Promise<DailyLogTarget> => resolveDailyLogTarget(domain, attempted, deps),
	};
}

/**
 * True when a thrown Notion error is the "your integration cannot see this" 404.
 * Branches on the error's `status` property (#1569), falling back to `(404)` message matching
 * for legacy errors without `status`.
 */
export function isNotionNotFound(err: unknown): boolean {
	if (err && typeof err === "object" && "status" in err) {
		return (err as { status?: unknown }).status === 404;
	}
	return (err instanceof Error ? err.message : String(err)).includes("(404)");
}

/**
 * Turn Notion's 404 into the one instruction that fixes it.
 */
export function reachabilityError(
	domain: Domain,
	notionId: string,
	err: unknown,
	attempted = "Nothing was written.",
): Error {
	const message = err instanceof Error ? err.message : String(err);
	if (!isNotionNotFound(err)) {
		return err instanceof Error ? err : new Error(message);
	}
	return new Error(
		[
			"The Daily Log for domain '" +
				domain +
				"' IS configured — pointer " +
				notionId +
				" — but the ahKMS Notion integration cannot see it (Notion returned 404). " +
				attempted,
			"This is a sharing problem, not a wiring one. Open that database in Notion → ⋯ → Connections → ahKMS, and do the same for its parent page.",
			"Notion exposes no page-sharing API, so no tool here can do it for you (#655).",
			"Notion said: " + message,
		].join("\n"),
	);
}
