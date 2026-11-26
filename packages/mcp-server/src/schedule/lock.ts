import { supabase } from "../supabase.js";

// Single-flight guard for the scheduled cadences (ADR-016 Slice 3, #53).
//
// mcp-server talks to Postgres only via the Supabase REST client (no held
// connection), so a session-scoped pg_advisory_lock isn't reachable here. This
// row-based lock gives the same guarantee — one atomic UPDATE picks a single
// winner even across process/deploy boundaries — without a new DB connection.
//
// A stale lock (holder crashed without releasing) expires after STALE_MS so a
// wedged lock can't block the cadence forever.
const STALE_MS = 30 * 60 * 1000; // 30 minutes

// These are DB values, not tool names, and #1061's rename deliberately left them
// alone. "discover" is the key of a seeded `scheduler_locks` row and the `cadence`
// column of every `scheduler_runs` row ever written; the Drive cadence reads those
// rows back to find where it got to. Renaming it to match `ingest_discover` would
// take a lock nobody seeded and resume from a history it could no longer see — a
// silent full re-scan on the next run. Rename these with a migration or not at all.
export type Cadence =
	| "discover"
	| "enrich"
	| "dedup"
	| "notion_automations"
	| "gmail_automations";

export async function tryAcquireLock(cadence: Cadence): Promise<boolean> {
	const staleCutoff = new Date(Date.now() - STALE_MS).toISOString();
	// Acquisition MUST be judged by the affected-row COUNT, never by a returned
	// representation (#516). PostgREST applies an `or=` filter on an UPDATE twice:
	// once in the UPDATE's WHERE (pre-update values — so mutual exclusion is
	// sound), and AGAIN against the returned representation (post-update values)
	// when `select=` is present. A successful acquire sets locked_at=now, which
	// always fails the null-or-stale re-check, so with `.select()` this returned
	// zero rows on success — and if the selected columns didn't include
	// locked_at, PostgREST 42703'd outright ("column scheduler_locks.locked_at
	// does not exist" — the column missing from the RETURNING projection, not the
	// table). Empirically verified 2026-08-04 against prod PostgREST; do not
	// reintroduce `.select()` here.
	const { count, error } = await supabase
		.from("scheduler_locks")
		.update({ locked_at: new Date().toISOString() }, { count: "exact" })
		.eq("cadence", cadence)
		.or(`locked_at.is.null,locked_at.lt.${staleCutoff}`);

	if (error) throw new Error(`scheduler lock acquire failed (${cadence}): ${error.message}`);
	return (count ?? 0) > 0;
}

export async function releaseLock(cadence: Cadence): Promise<void> {
	const { error } = await supabase
		.from("scheduler_locks")
		.update({ locked_at: null })
		.eq("cadence", cadence);
	if (error) throw new Error(`scheduler lock release failed (${cadence}): ${error.message}`);
}

export async function withLock<T>(
	cadence: Cadence,
	fn: () => Promise<T>,
): Promise<T | { skipped: true }> {
	const acquired = await tryAcquireLock(cadence);
	if (!acquired) return { skipped: true };
	try {
		return await fn();
	} finally {
		await releaseLock(cadence);
	}
}
