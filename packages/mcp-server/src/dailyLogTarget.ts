import {
	createDailyLogTargetResolver,
	DailyLogUnwiredError,
	dailyLogTargetIds as coreDailyLogTargetIds,
	getDailyLogTargetIds as coreGetDailyLogTargetIds,
	isDailyLogUnwired,
	isNotionNotFound,
	loadDailyLogConfig,
	peekDailyLogTarget as corePeekDailyLogTarget,
	reachabilityError,
	resolveDailyLogPortTarget as coreResolveDailyLogPortTarget,
	resolveDailyLogTarget as coreResolveDailyLogTarget,
	type DailyLogConfigSource,
	type DailyLogPointer,
	type DailyLogProvider,
	type DailyLogTarget,
	type DailyLogTargetDeps,
	type DailyLogTokenResolverFn,
	type DailyLogTokenSource,
	type LoadIntegrationConfigDetailedFn,
} from "@ahkms/core";
import { NotionClientAdapter } from "@ahkms/core/adapters";
import { getCredential } from "./credentials.js";
import { DOMAIN_PROVIDER, type Domain } from "./domains.js";
import { loadIntegrationConfigDetailed } from "./integrations.js";

const defaultNotion = new NotionClientAdapter((workspace) =>
	getCredential(DOMAIN_PROVIDER[workspace as Domain]),
);

const defaultDeps: DailyLogTargetDeps = {
	config: loadIntegrationConfigDetailed,
	notion: defaultNotion,
};

export async function peekDailyLogTarget(
	domain: Domain,
	config: DailyLogConfigSource | DailyLogTargetDeps = defaultDeps,
): Promise<DailyLogPointer | null> {
	return corePeekDailyLogTarget(domain, config);
}

export async function dailyLogTargetIds(
	domain: Domain,
	config: DailyLogConfigSource | DailyLogTargetDeps = defaultDeps,
): Promise<string[]> {
	return coreDailyLogTargetIds(domain, config);
}

export const getDailyLogTargetIds = dailyLogTargetIds;

export async function resolveDailyLogPortTarget(
	domain: Domain,
	config: DailyLogConfigSource | DailyLogTargetDeps = defaultDeps,
	attempted = "so nothing was written.",
) {
	return coreResolveDailyLogPortTarget(domain, config, attempted);
}

export async function resolveDailyLogTarget(
	domain: Domain,
	attemptedOrDeps: string | DailyLogTargetDeps = "so nothing was written.",
	maybeDeps: DailyLogTargetDeps = defaultDeps,
): Promise<DailyLogTarget> {
	if (typeof attemptedOrDeps === "string") {
		return coreResolveDailyLogTarget(domain, attemptedOrDeps, maybeDeps);
	}
	return coreResolveDailyLogTarget(domain, attemptedOrDeps);
}

export {
	createDailyLogTargetResolver,
	DailyLogUnwiredError,
	isDailyLogUnwired,
	isNotionNotFound,
	loadDailyLogConfig,
	reachabilityError,
	type DailyLogConfigSource,
	type DailyLogPointer,
	type DailyLogProvider,
	type DailyLogTarget,
	type DailyLogTargetDeps,
	type DailyLogTokenResolverFn,
	type DailyLogTokenSource,
	type LoadIntegrationConfigDetailedFn,
};

