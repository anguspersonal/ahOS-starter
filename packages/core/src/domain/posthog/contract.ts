import { z } from "zod";
import type { ConfigRepository } from "../../ports/config.js";

// The per-connection semantics contract (ADR-060, #742) and the guard that enforces it.
//
// Pure by design: no Supabase import, so the smoke script and the tools can both apply
// the identical rule without a database. (The same split as meetingNoteEmails.ts vs
// meetingNoteConfig.ts, for the same reason — a rules module that needs a database is a
// rules module you cannot run at setup time.)
//
// Test-Account Filter Contract (#742, grill resolution 2026-09-25 with Angus):
// One authoritative written definition of what constitutes an internal/test account
// in Work metrics across both PostHog and RevenueCat. Enforced server-side in the
// metrics proxy on every read. #970 stands as the one declared exception, and it is
// implemented as a SEPARATE TOOL (posthog_query_debug, see tools/posthog.ts) rather
// than a flag this guard recognises — assertFilterApplied below has no bypass path.

/**
 * Written definition of test-account exclusions (#742).
 * Documentation / audit-trail record of what counts as an internal/test account in
 * PostHog metrics, kept here for humans reading this file. It is NOT an enforcement
 * input: assertFilterApplied (below) never reads from this constant — it only checks
 * that a query carries the {filters} placeholder / filterTestAccounts:true and lets
 * PostHog's own project-level test-account filter (see posthog_project_filter, which
 * reads it live from PostHog on every call) do the actual filtering. Treat the list
 * below as a copy that can drift from PostHog's live config; posthog_project_filter is
 * the current source of truth, not this file.
 *
 * 1. Excluded Event Properties (HOUSE_FILTER_EVENT_HOGQL):
 *    - `is_test = 'true'`
 *    - `$is_emulator = 'true'`
 *    - `build_profile = 'development'`
 *    - `$host` matching `^(localhost|127[.]0[.]0[.]1)($|:)`
 *
 * 2. Excluded Person Cohorts (TEST_COHORTS):
 *    - 168929: manual internal/F&F roster (docs/analytics/internal-accounts.json)
 *    - 168904: behavioral is_test cohort
 *    - 222860: non-organic install traffic (device farm, #849/#901)
 *    - 225061: dynamic non-organic traffic ($locale = zh-Hans from US IP)
 *
 * 3. Known Internal Email Domains & Patterns:
 *    - `@work.example.com`
 *    - `@test.com`
 *    - `@yopmail.com`
 *    - `@cloudtestlabaccounts.com` (Firebase Test Lab)
 *    - Team personal: `owner@example.com`, `member1@example.com`, `member2@example.com`
 *    - Probes: `probe@work.example.com` (lina-lab deployment probes per ADR10/ADR11)
 */
export const POSTHOG_TEST_ACCOUNT_CONTRACT = {
	eventProperties: [
		{ property: "is_test", value: "true", operator: "is_not" },
		{ property: "$is_emulator", value: "true", operator: "is_not" },
		{ property: "build_profile", value: "development", operator: "is_not" },
		{ property: "$host", pattern: "^(localhost|127[.]0[.]0[.]1)($|:)", operator: "not_matches" },
	],
	cohorts: [
		{ id: 168929, name: "Internal and F&F roster (manual)" },
		{ id: 168904, name: "Behavioral is_test" },
		{ id: 222860, name: "Non-organic install traffic (device farm)" },
		{ id: 225061, name: "Dynamic non-organic traffic ($locale = zh-Hans from US IP)" },
	],
	internalEmailDomains: [
		"@work.example.com",
		"@test.com",
		"@yopmail.com",
		"@cloudtestlabaccounts.com",
	],
	teamPersonalEmails: [
		"owner@example.com",
		"member1@example.com",
		"member2@example.com",
	],
	probeEmails: [
		"probe@work.example.com",
	],
} as const;

/**
 * Three states, and the third one is the point.
 *
 *   required        — this project has a test-account filter and every read must apply it.
 *   not_applicable  — this project has no test-account machinery, and says so on purpose.
 *   undeclared      — nobody has decided yet. NOT the same as not_applicable.
 *
 * A portfolio site with no internal traffic is `not_applicable`. A freshly added
 * Work-shaped project nobody has written a policy for is `undeclared`, and rendering
 * its numbers as though they were clean is exactly the #742 failure. Undeclared refuses.
 */
export const FILTER_POLICIES = ["required", "not_applicable"] as const;
export type FilterPolicy = (typeof FILTER_POLICIES)[number];

/**
 * Whether this connection may be mutated. Same three-state shape as the filter policy,
 * and for the same reason: absent is UNDECLARED, which refuses, rather than a
 * permissive default nobody chose.
 */
export const WRITE_POLICIES = ["allowed", "forbidden"] as const;
export type WritePolicy = (typeof WRITE_POLICIES)[number];

export const postHogConnectionConfigSchema = z.object({
	/**
	 * Region key (`us` / `eu`) or a self-hosted origin. Required, never defaulted: a
	 * guessed region fails as 401, which reads as a bad credential and sends you to
	 * re-mint a key that was fine.
	 */
	host: z.string().min(1),
	project_id: z.number().int().positive(),
	/** Absent means UNDECLARED. Absent is a real state, not a missing value to default. */
	filter_policy: z.enum(FILTER_POLICIES).optional(),
	/**
	 * Whether this connection may be written to at all. Absent means UNDECLARED, and
	 * undeclared refuses, exactly as filter_policy does — the same reasoning: a
	 * connection nobody has thought about is not a connection that is safe to mutate.
	 *
	 * Opting in is deliberately per-connection rather than global. A key that can write
	 * to the Work product project should not thereby be able to write to a side
	 * project sharing the same organisation.
	 */
	write_policy: z.enum(WRITE_POLICIES).optional(),
	/**
	 * Scoping this project needs that PostHog itself does not know about. For 110015
	 * that is `$lib`, because one project carries the mobile app and every web surface
	 * and device-type filters get it wrong.
	 */
	platform_scoping: z.record(z.string(), z.string()).optional(),
	notes: z.string().optional(),
});

export type PostHogConnectionConfig = z.infer<typeof postHogConnectionConfigSchema>;

export type PostHogConnection = {
	/** `work` */
	slug: string;
	/** `posthog:work` — also the credential ref. */
	ref: `posthog:${string}`;
	projectId: number;
	host: string;
	/** null means undeclared. */
	filterPolicy: FilterPolicy | null;
	/** null means undeclared, which refuses writes. */
	writePolicy: WritePolicy | null;
	platformScoping: Record<string, string> | null;
};

export const POSTHOG_FAMILY = "posthog";

/**
 * Parse a `user_integrations` row (`provider`, `config`) into a typed `PostHogConnection`.
 */
export function toPostHogConnection(provider: string, config: unknown): PostHogConnection | null {
	const parsed = postHogConnectionConfigSchema.safeParse(config);
	if (!parsed.success) return null;
	const slug = provider.slice(POSTHOG_FAMILY.length + 1);
	if (!slug) return null;
	return {
		slug,
		ref: `${POSTHOG_FAMILY}:${slug}`,
		projectId: parsed.data.project_id,
		host: parsed.data.host,
		// `?? null` is load-bearing: an absent filter_policy becomes an explicit
		// UNDECLARED that the guard refuses on, never a quietly permissive default.
		filterPolicy: parsed.data.filter_policy ?? null,
		// Same `?? null` for the same reason: an absent write_policy is an explicit
		// UNDECLARED that assertWriteAllowed refuses on, never a permissive default.
		writePolicy: parsed.data.write_policy ?? null,
		platformScoping: parsed.data.platform_scoping ?? null,
	};
}

/**
 * Every configured PostHog connection from a `ConfigRepository`, in provider order.
 */
export async function listPostHogConnectionsFromRepo(
	repo: Pick<ConfigRepository, "listByFamily">,
): Promise<PostHogConnection[]> {
	const rows = await repo.listByFamily(POSTHOG_FAMILY);
	return rows
		.map((r) => toPostHogConnection(r.provider, r.config))
		.filter((c): c is PostHogConnection => c !== null);
}

/**
 * One PostHog connection by slug from a `ConfigRepository`.
 */
export async function getPostHogConnectionFromRepo(
	repo: Pick<ConfigRepository, "loadIntegration" | "listByFamily">,
	slug: string,
): Promise<PostHogConnection> {
	const provider = `${POSTHOG_FAMILY}:${slug}`;
	const row = await repo.loadIntegration(provider);
	const conn = row && row.enabled !== false ? toPostHogConnection(provider, row.config) : null;
	if (conn) return conn;

	const known = (await listPostHogConnectionsFromRepo(repo)).map((c) => c.slug);
	throw new Error(
		`No usable PostHog connection '${slug}'. ${
			known.length
				? `Configured connections: ${known.join(", ")}.`
				: "No PostHog connections are configured yet."
		} A connection is one user_integrations row with provider '${provider}' and a config carrying host and project_id (ADR-060).`,
	);
}

/**
 * Stamped onto every result. The Gmail lesson made mechanical: `getProfile` printing
 * `owner@work.example.com` is the one line that proved the account was right, and a
 * number with no provenance is a number you cannot audit after it has been pasted into
 * a slide.
 */
export type ResultStamp = {
	connection: string;
	project_id: number;
	region: string;
	filter_policy: FilterPolicy | "undeclared";
	pulled_at: string;
};

export function stampFor(conn: PostHogConnection, now: Date = new Date()): ResultStamp {
	return {
		connection: conn.ref,
		project_id: conn.projectId,
		region: conn.host,
		filter_policy: conn.filterPolicy ?? "undeclared",
		pulled_at: now.toISOString(),
	};
}

/** The placeholder PostHog expands into the project's own test-account filter. */
export const FILTERS_PLACEHOLDER = "{filters}";

/** HogQL property-access syntax hint (#1944). */
export const HOGQL_PROPERTY_ACCESS_HINT =
	"In HogQL, event properties are read as `properties.<name>` (including `$`-prefixed properties like `properties.$lib` and `properties.$os`, never bare `$lib`), and person properties as `person.properties.<name>`.";

const HOGQL_UNRESOLVED_FIELD_RE = /unable to resolve field|unknown identifier|hogql_query/i;

export function withHogqlPropertyHint(err: unknown): Error {
	const base = err instanceof Error ? err : new Error(String(err));
	if (!HOGQL_UNRESOLVED_FIELD_RE.test(base.message) || base.message.includes(HOGQL_PROPERTY_ACCESS_HINT)) {
		return base;
	}
	return new Error(`${base.message} ${HOGQL_PROPERTY_ACCESS_HINT}`, { cause: err });
}

/**
 * Refuse a read against a connection whose policy nobody has declared.
 *
 * Refuse rather than warn. A warning attached to a number survives exactly as long as
 * it takes someone to quote the number: #491 carried its data caveats in writing and
 * install-to-paid still got reported as 7%.
 */
export function assertPolicyDeclared(conn: PostHogConnection): void {
	if (conn.filterPolicy === null) {
		throw new Error(
			`Connection '${conn.ref}' (project ${conn.projectId}) has no filter_policy declared, so its numbers cannot be trusted or labelled. Set filter_policy to 'required' (the project has a test-account filter that every read must apply) or 'not_applicable' (it genuinely has none). Undeclared is not the same as clean.`,
		);
	}
}

/**
 * Check one query object against the connection's policy.
 *
 * For `required`, a raw HogQLQuery must carry BOTH the `{filters}` placeholder in its
 * SQL and `filters.filterTestAccounts === true`. Measured on project 110015, a query
 * missing them returns 10891 events over 7 days where the filtered figure is 8930: an
 * 18% overstatement, returned silently and looking entirely normal.
 *
 * It refuses rather than injecting the placeholder. Rewriting somebody's SQL to change
 * the number it returns is its own version of this bug, and a caller who did not ask
 * for the filter probably has a reason worth hearing.
 *
 * This guard has NO bypass path. The #970 debugging exception is intentionally not a
 * `purpose` flag here — it is `posthog_query_debug`, a wholly separate tool (see
 * tools/posthog.ts) that a client permissions independently, and that never emits an
 * unfiltered number without its filtered counterpart alongside it. A flag on this
 * function would hand the bypass decision back to the model on the same tool call
 * every other read goes through, which is exactly the failure mode #742 exists to close.
 */
export function assertFilterApplied(conn: PostHogConnection, query: Record<string, unknown>): void {
	assertPolicyDeclared(conn);
	if (conn.filterPolicy !== "required") return;

	const kind = typeof query.kind === "string" ? query.kind : "(no kind)";

	if (kind === "HogQLQuery") {
		const sql = typeof query.query === "string" ? query.query : "";
		const filters = query.filters as { filterTestAccounts?: unknown } | undefined;
		const missing: string[] = [];
		if (!sql.includes(FILTERS_PLACEHOLDER)) {
			missing.push(`the ${FILTERS_PLACEHOLDER} placeholder in the SQL (e.g. \`... and ${FILTERS_PLACEHOLDER}\`)`);
		}
		if (filters?.filterTestAccounts !== true) {
			missing.push("`filters: { filterTestAccounts: true }` alongside the query");
		}
		if (missing.length) {
			throw new Error(
				`Connection '${conn.ref}' declares filter_policy 'required', but this HogQL query is missing ${missing.join(" and ")}. Without them PostHog returns unfiltered numbers that look correct. Add them, or use a structured query kind.`,
			);
		}
		return;
	}

	// Structured insight queries carry the flag directly rather than through SQL.
	if (query.filterTestAccounts !== true) {
		throw new Error(
			`Connection '${conn.ref}' declares filter_policy 'required', but this ${kind} does not set filterTestAccounts: true.`,
		);
	}
}

/**
 * Refuse a write against a connection that has not explicitly opted in.
 *
 * The read surface earns its safety from the token: the read key is scoped
 * `project:read`, so a bug in the guards above still cannot mutate anything. A general
 * write passthrough gives that up by construction, so the guard has to be real here
 * rather than advisory, and undeclared has to refuse rather than default open.
 */
export function assertWriteAllowed(conn: PostHogConnection): void {
	if (conn.writePolicy === null) {
		throw new Error(
			`Connection '${conn.ref}' (project ${conn.projectId}) has no write_policy declared, so it cannot be written to. Set write_policy to 'allowed' on the user_integrations row to opt this connection in, or 'forbidden' to say so explicitly. Undeclared is not the same as permitted.`,
		);
	}
	if (conn.writePolicy === "forbidden") {
		throw new Error(
			`Connection '${conn.ref}' (project ${conn.projectId}) declares write_policy 'forbidden'. Writes to it are refused.`,
		);
	}
}

/** `/api/projects/<id>/...` — the project a PostHog path addresses, when it names one. */
const PROJECT_PATH = /^\/api\/projects\/(\d+)(?:\/|$)/;

/**
 * Refuse a write whose path addresses a different project than the connection declares.
 *
 * ADR-060 makes the connection the unit of semantics, and a passthrough that accepts an
 * arbitrary path can quietly leave it: `posthog_write` on the `work` connection
 * writing to `/api/projects/999/` would carry work's stamp onto a change made
 * somewhere else entirely. The stamp is the thing this whole surface is built on, so a
 * path that would falsify it is refused rather than relabelled.
 */
export function assertPathInProject(conn: PostHogConnection, path: string): void {
	if (!path.startsWith("/api/")) {
		throw new Error(
			`PostHog write path must start with '/api/' (got '${path}').`,
		);
	}
	const match = PROJECT_PATH.exec(path);
	if (!match) return;
	const addressed = Number(match[1]);
	if (addressed !== conn.projectId) {
		throw new Error(
			`Path '${path}' addresses project ${addressed}, but connection '${conn.ref}' is project ${conn.projectId}. Use the connection that owns that project; a result stamped with one connection must not describe a change made to another.`,
		);
	}
}

/**
 * Paths whose edits restate history rather than only changing what happens next.
 *
 * Cohort membership and the project's own test-account filter are both applied at QUERY
 * time to all history, so saving one silently rewrites every past number. Measured on
 * 2026-09-09: one cohort edit moved 3 September's recorded auth failures from 11 to 1,
 * and an over-broad arm on the same cohort had been deleting the entire United States
 * install base from every house-filtered metric for weeks before anyone noticed.
 */
const RETROACTIVE_PATHS = [/\/cohorts/, /^\/api\/projects\/\d+\/?$/];

export function isRetroactiveWrite(path: string): boolean {
	return RETROACTIVE_PATHS.some((re) => re.test(path));
}
