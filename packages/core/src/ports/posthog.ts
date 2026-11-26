import type { PostHogConnection } from "../domain/posthog/contract.js";

export * from "../domain/posthog/contract.js";

/**
 * PostHog is regional and the region is part of the CONNECTION, never a global. A key
 * minted in the EU cloud simply 401s against the US host, and the failure reads as
 * "bad credential" rather than "wrong region", which is a bad half-hour.
 * Self-hosted instances pass their own origin.
 */
export const POSTHOG_REGIONS = {
	us: "https://us.posthog.com",
	eu: "https://eu.posthog.com",
} as const;

export type PostHogRegion = keyof typeof POSTHOG_REGIONS;

/** `<family>:<slug>`, e.g. `posthog:work`. */
export type PostHogConnectionRef = `${string}:${string}`;

/** Where a call is going and who it is going as. One object so nothing gets defaulted. */
export type PostHogTarget = {
	/** Credential ref, e.g. `posthog:work`. */
	ref: PostHogConnectionRef;
	/** A region key, or a full origin for self-hosted. */
	host: PostHogRegion | string;
};

export function resolveHost(host: PostHogRegion | string): string {
	return host in POSTHOG_REGIONS
		? POSTHOG_REGIONS[host as PostHogRegion]
		: host.replace(/\/+$/, "");
}

export type PostHogIdentity = {
	email: string;
	organizationName: string | null;
	organizationId: string | null;
};

export type PostHogProject = { id: number; name: string };

export type PostHogProjectDetail = {
	id: number;
	name: string;
	/**
	 * The project's OWN "filter out internal and test users" setting, verbatim.
	 */
	testAccountFilters: unknown[];
	testAccountFiltersDefaultChecked: boolean | null;
};

export type PostHogQueryResult = {
	results?: unknown[][];
	columns?: string[];
	[k: string]: unknown;
};

/** What a write returned, plus enough context to see what it did. */
export type PostHogWriteResult = {
	status: "ok";
	method: string;
	path: string;
	/** The parsed response body, whatever the endpoint returned. */
	body: unknown;
};

export type PostHogCredentialResolver = (
	ref: PostHogConnectionRef,
	opts: { write: boolean },
) => Promise<string> | string;

/**
 * Abstract port for PostHog REST API operations (ADR-060, ADR-101 §1, #1628).
 */
export interface PostHogPort {
	getIdentity(target: PostHogTarget): Promise<PostHogIdentity>;
	listProjects(target: PostHogTarget): Promise<PostHogProject[]>;
	getProject(target: PostHogTarget, projectId: number): Promise<PostHogProjectDetail>;
	runQuery(
		target: PostHogTarget,
		projectId: number,
		query: Record<string, unknown>,
	): Promise<PostHogQueryResult>;
	writeCall(
		target: PostHogTarget,
		path: string,
		method: string,
		body: unknown,
	): Promise<PostHogWriteResult>;
	getRaw(target: PostHogTarget, path: string): Promise<unknown>;
	listConnections?(): Promise<PostHogConnection[]>;
	getConnection?(slug: string): Promise<PostHogConnection>;
}
