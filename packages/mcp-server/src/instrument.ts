/**
 * Sentry instrumentation for the MCP server.
 *
 * Import this FIRST, before anything else, in every entry point (`index.ts`,
 * `http.ts`). Sentry's auto-instrumentation works by patching `http`, `express`
 * and friends as they are required, so `Sentry.init()` has to run before those
 * modules are loaded — importing it half-way down a module's import block (as
 * the first cut of this file did, from `server.ts`) means the patches attach to
 * nothing and every span silently goes missing. Same trap #767 fixed in the
 * worker's `requestLogger`.
 *
 * Two rules specific to this service:
 *
 *  1. **Never write to stdout.** `index.ts` speaks MCP JSON-RPC over stdio, so
 *     anything printed on stdout corrupts the protocol stream and the client
 *     drops the connection. Every diagnostic here goes to stderr, and `debug`
 *     is deliberately never enabled.
 *  2. **Never let monitoring break the server.** Initialisation is wrapped so a
 *     bad DSN, a missing native profiling binary, or any SDK failure degrades to
 *     a stderr warning instead of a boot crash. Observability is not worth an
 *     outage.
 *
 * Configuration (all optional — with no `SENTRY_DSN` this module is a no-op):
 *  - `SENTRY_DSN`                   enable reporting (absent ⇒ disabled)
 *  - `SENTRY_ENVIRONMENT`           default `development`
 *  - `SENTRY_TRACES_SAMPLE_RATE`    default 0.1 in production, 1.0 otherwise
 *  - `SENTRY_PROFILES_SAMPLE_RATE`  default 0 (profiling off unless asked for)
 *
 * Sampling defaults are deliberately not 1.0 in production: tracing every
 * transaction burns the Sentry quota, and this service is chatty.
 */

import * as Sentry from "@sentry/node";

export { Sentry };

/** stderr, never stdout — see rule 1 above. */
function warn(message: string): void {
	console.error(`[Sentry] ${message}`);
}

/** Clean surrounding quotes/whitespace from a DSN string. */
export function sanitizeDsn(raw: string | undefined): string {
	if (!raw || typeof raw !== "string") return "";
	return raw.trim().replace(/^["']|["']$/g, "").trim();
}

/**
 * Validate a Sentry DSN.
 * Accepts standard Sentry DSN shapes: https://<key>@<host>/<project_id>
 * as well as keys with uppercase/alphanumeric characters, optional secret keys,
 * ports, and path prefixes.
 */
export function isValidDsn(dsn: string): boolean {
	const cleaned = sanitizeDsn(dsn);
	if (!cleaned) return false;
	try {
		const parsed = new URL(cleaned);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
		if (!parsed.username) return false;
		const pathSegments = parsed.pathname.split("/").filter(Boolean);
		if (pathSegments.length === 0) return false;
		return true;
	} catch {
		return false;
	}
}

function rate(envVar: string, fallback: number): number {
	const raw = process.env[envVar];
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number.parseFloat(raw);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
		warn(`${envVar}="${raw}" is not a number in [0,1]; using ${fallback}`);
		return fallback;
	}
	return parsed;
}

/** Returns the profiling integration, or undefined if it cannot be loaded. */
async function loadProfilingIntegration() {
	try {
		const { nodeProfilingIntegration } = await import("@sentry/profiling-node");
		return nodeProfilingIntegration();
	} catch (error) {
		warn(`profiling unavailable, continuing without it: ${String(error)}`);
		return undefined;
	}
}

let initialised = false;

/**
 * Initialise Sentry if it is configured. Safe to call more than once (later
 * calls are no-ops) and safe to call when nothing is configured.
 */
export async function initSentry(): Promise<void> {
	if (initialised) return;
	initialised = true;

	const rawDsn = process.env.SENTRY_DSN;
	if (!rawDsn) {
		// Not an error: local dev and CI run without a DSN by design.
		return;
	}
	const dsn = sanitizeDsn(rawDsn);
	if (!isValidDsn(dsn)) {
		warn("SENTRY_DSN is set but malformed; reporting disabled");
		return;
	}

	const environment = process.env.SENTRY_ENVIRONMENT ?? "development";
	const isProduction = environment === "production";
	const profilesSampleRate = rate("SENTRY_PROFILES_SAMPLE_RATE", 0);

	// Profiling ships a native binary. Load it dynamically so an architecture
	// mismatch in the container degrades to "no profiling" rather than a boot
	// crash, and skip it entirely when the sample rate is 0. The integration's
	// type is inferred from the import — `Integration` itself lives in
	// @sentry/core, which this package does not declare as a dependency and so
	// must not import from (#438).
	const profilingIntegration =
		profilesSampleRate > 0 ? await loadProfilingIntegration() : undefined;

	try {
		Sentry.init({
			dsn,
			environment,
			integrations: profilingIntegration ? [profilingIntegration as any] : [],
			tracesSampleRate: rate("SENTRY_TRACES_SAMPLE_RATE", isProduction ? 0.1 : 1.0),
			profileSessionSampleRate: profilesSampleRate,
			// This service handles a personal knowledge store: notes, messages and
			// document bodies flow through it. Do not ship request bodies or user
			// identifiers to a third party by default.
			sendDefaultPii: false,
		});
	} catch (error) {
		warn(`initialisation failed, continuing without reporting: ${String(error)}`);
	}
}

// Run on import so a bare `import "./instrument.js"` at the top of an entry
// point is enough. Errors are already swallowed inside initSentry(); this catch
// only guards against an unexpected rejection escaping the floating promise.
await initSentry().catch((error: unknown) => {
	warn(`initialisation threw: ${String(error)}`);
});
