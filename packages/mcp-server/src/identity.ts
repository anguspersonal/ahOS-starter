import { env } from "./env.js";

/**
 * The single read point for the owner's identity (ADR-045, #503).
 *
 * ahOS is single-user today, but must not seal off multi-tenancy. Every direct
 * `env.userId` read is a hard-coded "the one owner" assumption scattered through
 * the codebase; routing them all through this accessor turns the later
 * single-user -> per-request identity swap into an implementation change here
 * rather than a codebase-wide rewrite. The remote serving surface already
 * identifies the caller via JWT (ownerOAuthProvider), so a request-scoped
 * version of this function needs no schema change.
 *
 * Rules:
 * - Do NOT read `env.userId` directly anywhere else — a CI guard
 *   (scripts/check-user-id-reads.js, wired into ci-dev.yml) fails the build on
 *   new direct reads outside this file and tests.
 * - `KMS_USER_ID` remains a required boot var: single-owner is still true
 *   today; ADR-045 does not change that.
 */
export function getCurrentUserId(): string {
	return env.userId;
}
