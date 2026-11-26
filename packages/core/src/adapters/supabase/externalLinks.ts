import type { SupabaseClient } from "@supabase/supabase-js";
import type { Domain } from "../../domain/domains.js";
import {
	DAILY_LOG_CONTENT_SUBTYPE,
	DAILY_LOG_LINK_KIND,
	EVIDENCE_AGGREGATED,
	EVIDENCE_AGGREGATED_UNATTENDED,
	EVIDENCE_CLOSING_KINDS,
	SCAFFOLD_CONTENT_SUBTYPE,
	STATE_DOC_LINK_KIND,
	SYNTHESIZED,
	SYNTHESIZED_UNATTENDED,
	SYNTHESIS_MARKER_KINDS,
	UNENRICHED_ARTIFACT_STAGES,
} from "../../domain/vocab.js";
import {
	isUncoveredDay,
	type ClaimResult,
	type DailyLogMarkers,
	type DailyLogQueueEntry,
	type DedupSlotState,
	type DosEvidenceAggregateDay,
	type DosEvidenceAggregateGroup,
	type DosEvidenceAggregateItem,
	type DosEvidenceAggregateLateArrival,
	type DosEvidenceAggregateParams,
	type DosEvidenceAggregateRow,
	type ExternalLink,
	type ExternalLinkRepository,
	type SynthesisCoverageDay,
	type SynthesisStreak,
} from "../../ports/externalLinks.js";

export {
	isUncoveredDay,
	type ClaimResult,
	type DailyLogMarkers,
	type DailyLogQueueEntry,
	type DedupSlotState,
	type DosEvidenceAggregateDay,
	type DosEvidenceAggregateGroup,
	type DosEvidenceAggregateItem,
	type DosEvidenceAggregateLateArrival,
	type DosEvidenceAggregateParams,
	type DosEvidenceAggregateRow,
	type ExternalLink,
	type ExternalLinkRepository,
	type SynthesisCoverageDay,
	type SynthesisStreak,
};

export type ExternalLinksSupabaseClient = Pick<SupabaseClient, "from"> & {
	rpc?: SupabaseClient["rpc"];
};

export interface ExternalLinkAdapterDeps {
	client: ExternalLinksSupabaseClient;
	ownerId: () => string;
	externalItemWasCreated?: (error: unknown) => boolean;
	domainProvider?: Record<Domain, string>;
}

const DEFAULT_DOMAIN_PROVIDER: Record<Domain, string> = {
	work: "notion_work",
	angus: "notion_personal",
};

function defaultExternalItemWasCreated(error: unknown): boolean {
	return error instanceof Error && error.name === "ExternalItemCreatedButUnreadable";
}

// Cross-store lineage links (ADR-013 §5/§7): artifact -> external derived items
// (Notion task/state_doc) and the synthesis marker. See migration 047, and
// ADR-050 §6 for the marker vocabulary.

// Postgres SQLSTATE for a unique-violation, surfaced verbatim on `PostgrestError.code`
// (https://postgrest.org/en/stable/references/errors.html — DB errors pass the raw
// SQLSTATE through). Used to detect a real conflict on migration 064's partial unique
// index (see `claimDedupSlot` below) rather than a generic write failure.
const PG_UNIQUE_VIOLATION = "23505";

// Sentinel `dedup_key` for the `single_task` (1:1) guard, so it can claim a slot on the
// SAME partial unique index (migration 064: `(artifact_id, provider, kind, dedup_key)
// WHERE dedup_key IS NOT NULL`) that backs the `dedup_key` (1:N) guard. `single_task`
// has no natural per-item key — it means "any task for this artifact" — so this fixed
// key stands in for "the one task" slot. Never exposed to callers; internal only.
const SINGLE_TASK_SENTINEL_KEY = "__single_task__";

// Same sentinel pattern, for the `single_event` (1:1) guard on kind='event' rows
// (issue #126, mirrors task_create's single_task). `claimDedupSlot` below picks between
// this and SINGLE_TASK_SENTINEL_KEY by `kind` so the two guards' sentinel slots never
// collide with each other under migration 064's partial unique index.
const SINGLE_EVENT_SENTINEL_KEY = "__single_event__";

// Same sentinel pattern, for the `single_communication` (1:1) guard on kind='communication' rows
// (#422, mirrors task_create's single_task).
const SINGLE_COMMUNICATION_SENTINEL_KEY = "__single_communication__";

/**
 * Placeholder `external_id` for a claimed-but-not-yet-created row (see `claimDedupSlot`).
 * Real rows always get a real provider id in `finalizeExternalLink`; a row read back
 * still bearing this value is an **unfinished claim, never a duplicate** — no external
 * item was ever recorded under it (issue #653).
 *
 * Exported so the one operator remedy for a stuck claim (`interruptedClaimMessage`) and
 * any future reader spell the sentinel from here rather than re-typing the literal.
 */
export const PENDING_EXTERNAL_ID = "__pending__";

/**
 * Record that `artifactId` produced an external item. Idempotent via the table's
 * unique constraint, so re-running enrichment doesn't create duplicates. Best-effort
 * by design: a missing table (migration 047 not applied) must not fail the action that
 * created the external item — the link is metadata, not the deliverable.
 */
export async function recordExternalLink(
	artifactId: string,
	link: ExternalLink,
	deps: ExternalLinkAdapterDeps,
): Promise<{ ok: boolean; error?: string }> {
	const { client: supabase, ownerId: getCurrentUserId } = deps;
	const { error } = await supabase
		.from("artifact_external_links")
		.upsert(
			{
				user_id: getCurrentUserId(),
				artifact_id: artifactId,
				provider: link.provider,
				kind: link.kind,
				external_id: link.external_id,
				external_url: link.external_url ?? null,
				dedup_key: link.dedup_key ?? null,
			},
			{ onConflict: "artifact_id,provider,kind,external_id" },
		);

	return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * Read an artifact's `content_subtype` for the `external_link_create` kind-fit guard
 * (#666, #1539). Returns `{ data, error }` without degrading on read failure so the
 * guard can distinguish "could not check" (`error` set) from "artifact not found"
 * (`data === null`) and "checked" (`data.content_subtype`).
 */
export async function getArtifactContentSubtype(
	artifactId: string,
	deps: ExternalLinkAdapterDeps,
): Promise<{ data: { content_subtype: string | null } | null; error?: string }> {
	const { client: supabase, ownerId: getCurrentUserId } = deps;
	const { data, error } = await supabase
		.from("artifacts")
		.select("content_subtype")
		.eq("id", artifactId)
		.eq("user_id", getCurrentUserId())
		.maybeSingle();

	if (error) return { data: null, error: error.message };
	return {
		data: (data as { content_subtype: string | null } | null) ?? null,
	};
}

/**
 * Fetch the external items linked to an artifact, for "what came out of this?". Returns
 * [] on any error (e.g. table not yet created) so read paths stay resilient.
 */
export async function getExternalLinks(
	artifactId: string,
	deps: ExternalLinkAdapterDeps,
): Promise<ExternalLink[]> {
	const { client: supabase, ownerId: getCurrentUserId } = deps;
	const { data, error } = await supabase
		.from("artifact_external_links")
		.select("provider, kind, external_id, external_url, dedup_key")
		.eq("user_id", getCurrentUserId())
		.eq("artifact_id", artifactId);

	if (error || !data) return [];
	return data as ExternalLink[];
}

/**
 * Inspect the dedup slot for an artifact — the check the Act step (task_create /
 * event_create) runs before creating an external item (issue #141: eager Act at capture
 * and a later EOD Act pass must not double-create from the same atom).
 *
 * - No `dedupKey` → the 1:1 "declared task" case: considers ANY `kind` link for this
 *   artifact (createTask's `single_task` guard).
 * - `dedupKey` given → the 1:N "spawned tasks" case: considers only links with that
 *   EXACT dedup_key, so sibling tasks from the same atom don't shadow each other.
 *
 * A real link anywhere in the matched set wins over a pending one: an artifact holding
 * both a finalized task link and a leftover claim genuinely already has its task, and
 * the leftover claim must not downgrade that to a retryable state.
 *
 * Scoped by `provider` so the dedup namespace is per-workspace: the same artifact can
 * legitimately spawn a task in `notion_work` AND one in `notion_personal` without the
 * first shadowing the second. This matches migration 064's unique index, whose key
 * includes `provider` — the pre-check and the claim must scope by the same columns or a
 * cross-workspace task would be spuriously skipped here (a false "already linked").
 *
 * Degrades to `free` on any read error so a missing/older schema doesn't block task
 * creation — this pre-check is a best-effort cheap path, not the race-closer
 * (`claimDedupSlot` is).
 */
export async function inspectDedupSlot(
	artifactId: string,
	provider: string,
	kind: string,
	dedupKey: string | null | undefined,
	deps: ExternalLinkAdapterDeps,
): Promise<DedupSlotState> {
	const { client: supabase, ownerId: getCurrentUserId } = deps;
	let query = supabase
		.from("artifact_external_links")
		.select("external_id")
		.eq("user_id", getCurrentUserId())
		.eq("artifact_id", artifactId)
		.eq("provider", provider)
		.eq("kind", kind);

	query = dedupKey ? query.eq("dedup_key", dedupKey) : query;

	const { data, error } = await query;
	if (error || !data) return "free";

	const rows = data as Array<{ external_id: string | null }>;
	if (rows.some((r) => r.external_id && r.external_id !== PENDING_EXTERNAL_ID)) {
		return "linked";
	}
	return rows.length > 0 ? "pending" : "free";
}

/**
 * Atomically claim a dedup slot for `kind` on `artifactId` BEFORE creating anything in
 * the external system (Notion) — the fix for the concurrency gap in issue #141's
 * follow-up review: `hasExistingLink` (a plain SELECT) then create-then-best-effort-link
 * has a check-then-act race where two concurrent callers can both pass the check and
 * both create a real Notion page.
 *
 * Scoped by `provider` (the target workspace, e.g. `notion_work` / `notion_personal`):
 * the claim row carries it and it is part of migration 064's unique-index key, so the
 * same artifact + dedup_key can claim independent slots in two different workspaces
 * without a spurious cross-workspace conflict. Pass the same provider the caller will
 * record the finalized link under.
 *
 * Mechanism: a plain `INSERT` (not upsert) of a placeholder row using the caller's
 * `dedupKey` (or, when no `dedupKey` is given, a `kind`-specific sentinel —
 * `SINGLE_EVENT_SENTINEL_KEY` for `kind === "event"`, `SINGLE_TASK_SENTINEL_KEY`
 * otherwise — see those constants' comments; this is what lets `single_task` and
 * `single_event` claim independent slots without colliding). Migration 064's partial
 * unique index
 * `(artifact_id, provider, kind, dedup_key) WHERE dedup_key IS NOT NULL` still enforces
 * uniqueness on a raw INSERT with no ON CONFLICT clause at all — enforcement only needs
 * the index to exist, not a matching onConflict target. That sidesteps a real gap in
 * supabase-js/PostgREST: `.upsert()`'s `onConflict` is a plain comma-separated column
 * list with NO way to add the index's `WHERE dedup_key IS NOT NULL` predicate, and
 * Postgres will not infer a PARTIAL unique index as an `ON CONFLICT (columns)` target
 * unless the matching predicate is repeated in the conflict clause — something
 * PostgREST's query-param-driven `on_conflict` has no mechanism to express. A plain
 * INSERT has no such restriction: it just hits the index and Postgres raises `23505`
 * (unique_violation) if another row already occupies that slot.
 *
 * Whichever caller's INSERT lands first wins the claim (Postgres serializes on the
 * index) and proceeds to create the Notion page, then calls `finalizeExternalLink` to
 * fill in the real `external_id`. The loser's INSERT fails with `23505` and returns
 * `{ claimed: false, reason: "conflict" }` — the caller should report the item as an
 * already-existing duplicate and skip creation, WITHOUT ever calling Notion.
 *
 * Every claim MUST reach one of two terminal states, and the caller owns getting there:
 * `finalizeExternalLink` once the external item exists, or `releaseClaimForFailedWrite`
 * if the outward write threw. A claim left in neither state is the issue #653 bug — it
 * blocks every later claim for that exact key with a message that reads like a
 * legitimate duplicate.
 *
 * Residual gap (documented honestly, not hidden): a hard crash between the claim and
 * either terminal state runs no catch block, so the row is left at
 * `PENDING_EXTERNAL_ID`. There is deliberately no TTL/auto-reclaim: a pending row can
 * also mean "the external item WAS created and the finalize never landed", and
 * reclaiming that row would double-create. Such a row is instead reported as an
 * unfinished claim rather than a duplicate (`inspectDedupSlot` → `pending`,
 * `interruptedClaimMessage`), which makes it loud and clears the operator's path. The
 * authoritative resolution is the ADR-040 erratum's: check the system of record.
 *
 * Only used when a dedup guard is active (`single_task` or `dedup_key`); the no-guard
 * path keeps using `recordExternalLink`'s upsert unchanged (matches today's behaviour,
 * no artifact_id → no lineage to protect).
 */
export async function claimDedupSlot(
	artifactId: string,
	provider: string,
	kind: string,
	dedupKey: string | null,
	deps: ExternalLinkAdapterDeps,
): Promise<ClaimResult> {
	const { client: supabase, ownerId: getCurrentUserId } = deps;
	const key =
		dedupKey ??
		(kind === "event"
			? SINGLE_EVENT_SENTINEL_KEY
			: kind === "communication"
			? SINGLE_COMMUNICATION_SENTINEL_KEY
			: SINGLE_TASK_SENTINEL_KEY);
	const { data, error } = await supabase
		.from("artifact_external_links")
		.insert({
			user_id: getCurrentUserId(),
			artifact_id: artifactId,
			provider,
			kind,
			external_id: PENDING_EXTERNAL_ID,
			dedup_key: key,
		})
		.select("id")
		.single();

	if (error) {
		if (error.code === PG_UNIQUE_VIOLATION) {
			return { claimed: false, reason: "conflict" };
		}
		// Any other error (e.g. migration 064 not applied, table missing) degrades to
		// "could not claim" — the caller falls back to the pre-existing best-effort path
		// rather than blocking task creation on infra that isn't there yet.
		return { claimed: false, reason: "error", error: error.message };
	}

	return { claimed: true, linkId: (data as { id: string }).id };
}

/**
 * Fill in the real external item's id/url on a row previously claimed via
 * `claimDedupSlot`. Matched by primary key (not upsert), so this can never touch a
 * different row than the one this call claimed.
 */
export async function finalizeExternalLink(
	linkId: string,
	externalId: string,
	externalUrl: string | null,
	deps: ExternalLinkAdapterDeps,
): Promise<{ ok: boolean; error?: string }> {
	const { client: supabase } = deps;
	const { error } = await supabase
		.from("artifact_external_links")
		.update({ external_id: externalId, external_url: externalUrl })
		.eq("id", linkId);

	return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * Drop a claim row whose outward write never landed (issue #653).
 *
 * Two predicates, both load-bearing:
 * - `id` — the row THIS call claimed, so a release can never touch a sibling claim.
 * - `external_id = PENDING_EXTERNAL_ID` — the row is still unfinished. If anything
 *   finalized it in the meantime, the DELETE matches nothing and a valid link survives.
 *   Unreachable today (the claimer owns the id), and kept precisely so it stays that way:
 *   the one thing this function must never do is strip a link that points at a real item.
 */
async function deletePendingClaim(
	linkId: string,
	deps: ExternalLinkAdapterDeps,
): Promise<{ ok: boolean; error?: string }> {
	const { client: supabase } = deps;
	const { error } = await supabase
		.from("artifact_external_links")
		.delete()
		.eq("id", linkId)
		.eq("external_id", PENDING_EXTERNAL_ID);

	return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * Release a dedup claim because the outward write (Notion / Calendar) threw, and return
 * the error the caller should throw — the failure-path half of the claim lifecycle
 * (issue #653).
 *
 * **Only call this when the external item demonstrably does not exist**, i.e. from a
 * catch around the outward write itself. Once that write returns, the window is closed:
 * releasing after it would strip the slot for an item that IS out there, and the next
 * retry would create a second one. Everything downstream of the write (provenance
 * capture, finalize) is best-effort and must NOT release — a failure there leaves a
 * pending row, which is the safe direction.
 *
 * One throw from *inside* the outward write breaks that rule, and this function refuses
 * it rather than leaving the call sites to remember: `ExternalItemCreatedButUnreadable`
 * means the provider accepted the create and only the response body was lost, so the item
 * exists. Releasing on it is the double-create the guard exists to prevent, so the claim
 * is kept and the caller is told why. Ambiguous failures (no response at all) are NOT
 * that error and stay on the release path — resolving those needs a read of the system of
 * record (issue #734), not a client-side guess.
 *
 * Returns the original error untouched when the release succeeded. When the release
 * itself failed it returns a wrapped error that carries both facts, because the operator
 * is about to hit a blocked retry and the reason has to travel with the failure that
 * caused it — reporting only the original error would put them back in #653 with no
 * explanation. `cause` preserves the original for anything inspecting the chain.
 *
 * A `null` claim id (no guard active, or the claim itself failed) is a no-op.
 */
export async function releaseClaimForFailedWrite(
	claimedLinkId: string | null,
	error: unknown,
	deps: ExternalLinkAdapterDeps,
): Promise<unknown> {
	if (!claimedLinkId) return error;
	const externalItemWasCreated =
		deps.externalItemWasCreated ?? defaultExternalItemWasCreated;

	if (externalItemWasCreated(error)) {
		const original = error instanceof Error ? error.message : String(error);
		return new Error(
			`${original}\n\n(the dedup claim is deliberately NOT released: the item exists, so ` +
				`freeing the slot would let a retry create a second one. Row '${claimedLinkId}' ` +
				`stays at external_id='${PENDING_EXTERNAL_ID}' and the next create for this ` +
				`artifact will report as blocked — resolve it against the system of record, which ` +
				`is also where the item's id can be found)`,
			{ cause: error },
		);
	}

	const released = await deletePendingClaim(claimedLinkId, deps);
	if (released.ok) return error;

	const original = error instanceof Error ? error.message : String(error);
	return new Error(
		`${original}\n\n(the dedup claim this attempt left behind could not be released: ` +
			`${released.error} — artifact_external_links row '${claimedLinkId}' still reads ` +
			`external_id='${PENDING_EXTERNAL_ID}', so the next create for this artifact will ` +
			`report as blocked until that row is deleted)`,
		{ cause: error },
	);
}

/**
 * The response text for a create blocked by an unfinished claim (issue #653).
 *
 * Deliberately NOT phrased as a duplicate skip. The bug this replaces was silent because
 * a leftover claim produced the same "already linked" sentence a genuine duplicate does,
 * so the operator had no way to tell "your task exists" from "your task never got
 * created and never will". This says which one it is, and hands over the exact remedy.
 *
 * The verdict it points at is the ADR-040 erratum's (#413): the lineage ledger is not the
 * duplicate guard — the Tasks DB is. A pending row is evidence about the *ledger*, not
 * about whether the item exists, so the resolution has to be a look at the system of
 * record.
 *
 * The remedy's scope is held equal to the scope `inspectDedupSlot` just read, because
 * those are the rows that are actually blocking. With a `dedupKey` the inspection matched
 * that one key, so the DELETE carries it too — otherwise the operator's fix for one task
 * would also clear sibling claims, including ones an in-flight call still owns. Without a
 * `dedupKey` the inspection matched every claim for this artifact+provider+kind, so the
 * DELETE has to as well, and says so rather than letting its breadth go unnoticed.
 */
export function interruptedClaimMessage(opts: {
	artifactId: string;
	provider: string;
	kind: string;
	dedupKey?: string | null;
}): string {
	const scope = opts.dedupKey
		? `provider='${opts.provider}', kind='${opts.kind}', dedup_key='${opts.dedupKey}'`
		: `provider='${opts.provider}', kind='${opts.kind}'`;
	// `dedupKey` is the only caller-supplied value in the statement (artifact_id is a
	// validated uuid; provider/kind are internal constants), so it is the only one that can
	// carry a quote and hand the operator something unpasteable.
	const dedupPredicate = opts.dedupKey
		? ` AND dedup_key = '${opts.dedupKey.replace(/'/g, "''")}'`
		: "";
	const breadthNote = opts.dedupKey
		? ""
		: `\n  (no dedup_key was in play, so this clears EVERY unfinished claim for that ` +
			`artifact and kind — check the system of record for each before running it.)`;
	return (
		`Blocked: an earlier create for artifact ${opts.artifactId} (${scope}) claimed the ` +
		`dedup slot but never recorded a result — the lineage row still reads ` +
		`'${PENDING_EXTERNAL_ID}'.\n\n` +
		`This is NOT a duplicate skip: nothing was created just now, and that earlier ` +
		`attempt recorded no external item. Either another create for this artifact is in ` +
		`flight right now (retry in a moment), or one was interrupted mid-write.\n\n` +
		`The lineage ledger is not the duplicate guard (ADR-040 erratum, #413) — check the ` +
		`system of record for whether the item actually exists. If it does not, clear the ` +
		`stale claim and retry:\n` +
		`  DELETE FROM public.artifact_external_links WHERE artifact_id = ` +
		`'${opts.artifactId}' AND provider = '${opts.provider}' AND kind = '${opts.kind}' ` +
		`AND external_id = '${PENDING_EXTERNAL_ID}'${dedupPredicate};${breadthNote}`
	);
}

// ---------------------------------------------------------------------------
// Reading the marker ledger (#677)
// ---------------------------------------------------------------------------

/**
 * Narrow a marker-ledger read to the one domain that wrote the markers, or leave it
 * unscoped. The single place any consumption read resolves a domain to a `provider`
 * (#677) — three reads used to key on marker `kind` alone, which made consumption a
 * global fact: an atom folded into the `angus` Daily Log read as already-consumed to
 * `work`, and a day closed in one domain read as covered for both. `provider` is part
 * of the ledger's unique key (migration 047), so the reads have to use it or the
 * per-domain ledger the writers maintain is thrown away on the way out.
 *
 * Two properties this function exists to hold, both of which are the bug if lost:
 *
 * 1. **The provider is resolved through `DOMAIN_PROVIDER`, never written as a literal.**
 *    ADR-054 §3 renames `notion_personal` → `notion_angus` (#681); a literal here would
 *    be a predicate that silently stops matching the day that lands. `domains.ts` is the
 *    one file that moves.
 * 2. **No domain means NO predicate — not a default domain.** Every caller that predates
 *    the domain axis keeps seeing exactly the rows it always saw. A default would narrow
 *    those callers silently, which is a worse failure than the one being fixed: atoms
 *    would start reappearing as unconsumed with nothing in the call to explain why.
 */
export function scopeToDomain<Q>(
	query: Q,
	domain?: Domain,
	domainProvider: Record<Domain, string> = DEFAULT_DOMAIN_PROVIDER,
): Q {
	if (!domain) return query;
	// The cast is contained here on purpose. Expressing "any builder whose .eq returns
	// itself" as a generic CONSTRAINT makes tsc chase supabase-js's `this`-returning
	// PostgrestFilterBuilder until it gives up (TS2589, "type instantiation is
	// excessively deep"). Narrowing to the one method used, in one place, keeps every
	// call site fully typed: `Q` in, `Q` out.
	type ProviderFilterable = { eq(column: string, value: string): unknown };
	return (query as ProviderFilterable).eq("provider", domainProvider[domain]) as Q;
}

/**
 * Artifact ids already through the Synthesize step (ADR-013 §7). We store only this
 * positive fact; "pending" is derived as (in scope) AND (not in this set). Returns an
 * empty set on any error so callers degrade to "treat everything as pending".
 *
 * Matches every kind in the ADR-050 §6 vocabulary rather than the single kind this
 * ritual writes, so an atom swept unattended (#561) stays consumed.
 *
 * `domain` scopes the read to the markers that domain's ritual wrote; omitted, it matches
 * every provider, which is what every pre-#677 caller got. See `scopeToDomain`.
 */
export async function getSynthesizedArtifactIds(
	domain: Domain | undefined,
	deps: ExternalLinkAdapterDeps,
): Promise<Set<string>> {
	const { client: supabase, ownerId: getCurrentUserId, domainProvider } = deps;
	// `.in("kind", …)` stays the terminal call so the chain shape is identical whether or
	// not a domain was given — the scope is an extra `.eq`, never a different query.
	const { data, error } = await scopeToDomain(
		supabase
			.from("artifact_external_links")
			.select("artifact_id")
			.eq("user_id", getCurrentUserId()),
		domain,
		domainProvider,
	).in("kind", SYNTHESIS_MARKER_KINDS as unknown as string[]);

	if (error || !data) return new Set();
	return new Set((data as Array<{ artifact_id: string }>).map((r) => r.artifact_id));
}

// ---------------------------------------------------------------------------
// Synthesis coverage (#561)
// ---------------------------------------------------------------------------

/**
 * Derives the ritual streak live from hop-1 coverage days (ADR-052 §1, §8, #493, #664, ADR-109 §2).
 *
 * Rules:
 * - `synthesized > 0 || evidence_aggregated > 0`: extends the streak (current++)
 * - `synthesized_unattended > 0 || evidence_aggregated_unattended > 0`: pauses the streak (current unchanged)
 * - `no_material` (0 atoms captured and no closing markers): pauses the streak (current unchanged, #664)
 * - `isUncoveredDay(day)` (atoms existed, no closing marker of either family): breaks the streak (current = 0)
 * - today in-progress: if today has not been closed yet, it does not break the streak
 * - `best`: tracks the max streak achieved
 */
export function computeStreak(
	days: SynthesisCoverageDay[],
	options?: { asOfToday?: string },
): SynthesisStreak {
	let current = 0;
	let best = 0;
	const today = options?.asOfToday ?? new Date().toISOString().slice(0, 10);

	for (const day of days) {
		if (day.synthesized > 0 || day.evidence_aggregated > 0) {
			current += 1;
			if (current > best) best = current;
		} else if (!isUncoveredDay(day)) {
			// Pauses: unattended marker (narrative or evidence) or no_material (ADR-052 §8, #664, ADR-109 §2)
		} else if (day.date === today) {
			// Today is in-progress: if not closed yet, it does not break streak
		} else {
			// Uncovered day with material: breaks streak
			current = 0;
		}
	}

	return {
		current,
		best,
		formatted: current > 3 ? `day ${current} 🔥 · best ${best}` : `day ${current} · best ${best}`,
	};
}

/** Rows-per-request cap on the `.in("id", …)` artifact lookup, so a long marker list
 *  becomes several bounded requests rather than one PostgREST URL over the limit. */
const COVERAGE_ID_CHUNK = 300;

/** Page size for the windowed `artifacts` scan in `getSynthesisCoverage`, matching
 *  PostgREST's `max_rows` (`supabase/config.toml`). A window whose total captured-atom
 *  count exceeds a single page would otherwise have the excess rows silently dropped by
 *  PostgREST's own cap — no error, no ordering guarantee on which rows survive (#664
 *  round-1 QA finding). Paginating with `.order("id").range()` makes an active-capture
 *  92-day window (bulk Drive/GitHub/Slack ingests, WhatsApp blasts, …) complete by
 *  construction instead of truncated by accident. Exported so the coverage test can
 *  drive a fixture with more than one page's worth of artifacts without hardcoding
 *  the number. */
export const COVERAGE_ARTIFACT_PAGE_SIZE = 1000;

/** Maximum atoms counted for a single calendar day before advancing to the next day.
 *  Prevents multi-day window scans from executing dozens of redundant queries on bulk
 *  historical ingest days (e.g. 150k discovered Drive pointers) where material presence
 *  is already definitively established. (#1221) */
export const COVERAGE_MAX_ATOMS_PER_DAY = 2000;

/** `YYYY-MM-DD` → the inclusive UTC instant bounds of that calendar day. */
function dayBounds(fromDate: string, toDate: string): { fromTs: string; toTs: string } {
	return { fromTs: `${fromDate}T00:00:00.000Z`, toTs: `${toDate}T23:59:59.999Z` };
}

/**
 * Whether an artifact row counts as routable synthesis material for `captured_atoms`
 * and `no_material` derivation (#567, #664, #994, ADR-051 §9).
 *
 * Excludes:
 * - `daily_log` twins and `scaffold` rows (a ritual's own output, ADR-051 §9)
 * - `discovered` and `failed` pointer rows (unenriched pointers with no body, #567)
 *
 * **Parity oracle.** `public.get_dos_coverage_days` (migration 158) applies this same
 * filter in SQL, and `packages/mcp-server/src/dosCoverageParity.ts` checks the function
 * against this one on production rows. Change one and the other must change with it
 * (ADR-119, #2264).
 */
export function isSynthesizableMaterial(row: {
	content_subtype?: string | null;
	lifecycle_stage?: string | null;
}): boolean {
	if (
		row.content_subtype === DAILY_LOG_CONTENT_SUBTYPE ||
		row.content_subtype === SCAFFOLD_CONTENT_SUBTYPE
	) {
		return false;
	}
	if (row.lifecycle_stage != null && UNENRICHED_ARTIFACT_STAGES.has(row.lifecycle_stage)) {
		return false;
	}
	return true;
}

/**
 * Maximum ingestion lag (in calendar days) for attributing an artifact to its
 * `effective_at` (`COALESCE(originated_at, captured_at)`) rather than `captured_at`.
 * Matches the 7-day unattended sweep horizon (`[today-7, today-2]`): a meeting held
 * on day D whose Gemini transcript syncs from Google Drive on D+1 (or a `/close`
 * session summary written after midnight) attributes to day D so `getSynthesisCoverage`
 * and `knowledge_search` agree on which day owns the atom. Historic archive backfills
 * (`lagDays > 7`, such as a 2016 contract ingested in 2026) continue to fall back to
 * `captured_at` so they never open uncovered days years in the past (ADR-088 §3 as
 * amended by ADR-119).
 *
 * **Parity oracle.** The same number is written into `public.get_dos_coverage_days`
 * (migration 158). The two must change together (ADR-119, #2264).
 */
export const COVERAGE_MAX_EFFECTIVE_LAG_DAYS = 7;

/**
 * The UTC calendar day coverage attributes an artifact, and any marker on it, to
 * (ADR-119): the `effective_at` date when it is 0 to 7 calendar days before the
 * `captured_at` date, the `captured_at` date otherwise. When one timestamp is null the
 * other decides; when both are null the row has no day.
 *
 * **Parity oracle.** `public.get_dos_coverage_days` (migration 158) computes this same
 * day in SQL, and `packages/mcp-server/src/dosCoverageParity.ts` checks the function
 * against this one on production rows. Change one and the other must change with it
 * (#2264).
 */
export function coverageDateForArtifact(row: {
	captured_at: string | null;
	effective_at?: string | null;
}): string | null {
	const capDate = row.captured_at ? row.captured_at.slice(0, 10) : null;
	const effDate = row.effective_at ? row.effective_at.slice(0, 10) : null;
	if (!capDate && !effDate) return null;
	if (!effDate) return capDate;
	if (!capDate) return effDate;
	if (effDate === capDate) return capDate;
	const lagDays =
		(Date.parse(`${capDate}T00:00:00.000Z`) - Date.parse(`${effDate}T00:00:00.000Z`)) /
		86_400_000;
	if (lagDays >= 0 && lagDays <= COVERAGE_MAX_EFFECTIVE_LAG_DAYS) {
		return effDate;
	}
	return capDate;
}

type CoverageArtifactRow = {
	id: string;
	captured_at: string | null;
	effective_at?: string | null;
	content_subtype?: string | null;
	lifecycle_stage?: string | null;
};

/** The one filter both coverage reads apply: pointer rows are not synthesis material
 *  (#567). Kept as a constant because migration 153's partial index is written against
 *  exactly this predicate; change one and the other must follow. */
const COVERAGE_MATERIAL_FILTER = "lifecycle_stage.is.null,lifecycle_stage.not.in.(discovered,failed)";

/**
 * Every non-pointer artifact captured in `[fromTs, toTs]`, read in `(captured_at, id)`
 * order by KEYSET paging (#2257).
 *
 * This used to page with `.range(offset, …)`. An OFFSET makes Postgres walk and discard
 * every earlier row on each page, and on the pre-153 indexes that walk included a heap
 * fetch for every `discovered` pointer in the range, so one page past a bulk Drive
 * discover day read the whole table and hit the 8s statement timeout. The streak read,
 * which spans all history, failed on every call.
 *
 * Each page now starts from a bookmark: `captured_at >= lastTs` moves the index lower
 * bound, and `(captured_at > lastTs OR id > lastId)` skips the rows already read at that
 * exact timestamp. It is written as two predicates and not as one
 * `captured_at.gt.T,and(captured_at.eq.T,id.gt.I)` because Postgres treats that OR as a
 * filter, not an index bound, and would scan from the start of the window every page
 * (measured: 41k buffers a page against 14).
 *
 * A calendar day that has already yielded COVERAGE_MAX_ATOMS_PER_DAY material rows is
 * skipped past: its material presence is established and the remainder adds nothing.
 */
async function readWindowArtifacts(
	supabase: ExternalLinkAdapterDeps["client"],
	userId: string,
	fromTs: string,
	toTs: string,
	failure: string,
): Promise<CoverageArtifactRow[]> {
	const rows: CoverageArtifactRow[] = [];
	const countByDate = new Map<string, number>();
	let lowerBound = fromTs;
	let after: { ts: string; id: string } | null = null;

	for (;;) {
		let q = supabase
			.from("artifacts")
			.select("id, captured_at, effective_at, content_subtype, lifecycle_stage")
			.eq("user_id", userId)
			.or(COVERAGE_MATERIAL_FILTER)
			.gte("captured_at", lowerBound)
			.lte("captured_at", toTs);
		if (after) {
			q = q.or(`captured_at.gt."${after.ts}",id.gt.${after.id}`);
		}
		const { data, error } = await q
			.order("captured_at", { ascending: true })
			.order("id")
			.limit(COVERAGE_ARTIFACT_PAGE_SIZE);

		if (error) {
			throw new Error(`${failure}: ${error.message}.`);
		}

		const page = (data ?? []) as CoverageArtifactRow[];
		rows.push(...page);
		if (page.length < COVERAGE_ARTIFACT_PAGE_SIZE) break;

		for (const row of page) {
			const d = coverageDateForArtifact(row);
			if (d && isSynthesizableMaterial(row)) {
				countByDate.set(d, (countByDate.get(d) ?? 0) + 1);
			}
		}

		const last = page[page.length - 1];
		// `gte("captured_at", …)` excludes null, so a full page always ends on a dated row.
		if (!last.captured_at) break;
		const lastDate = last.captured_at.slice(0, 10);
		if ((countByDate.get(lastDate) ?? 0) >= COVERAGE_MAX_ATOMS_PER_DAY) {
			const nextDate = new Date(Date.parse(`${lastDate}T00:00:00.000Z`) + 86_400_000)
				.toISOString()
				.slice(0, 10);
			lowerBound = `${nextDate}T00:00:00.000Z`;
			after = null;
			if (lowerBound > toTs) break;
		} else {
			lowerBound = last.captured_at;
			after = { ts: last.captured_at, id: last.id };
		}
	}
	return rows;
}

/** Every `YYYY-MM-DD` from `fromDate` to `toDate` inclusive, in order. */
export function enumerateDays(fromDate: string, toDate: string): string[] {
	const days: string[] = [];
	const end = Date.parse(`${toDate}T00:00:00.000Z`);
	for (
		let t = Date.parse(`${fromDate}T00:00:00.000Z`);
		t <= end;
		t += 24 * 60 * 60 * 1000
	) {
		days.push(new Date(t).toISOString().slice(0, 10));
	}
	return days;
}

/**
 * Per-day synthesis-marker coverage over `[fromDate, toDate]` — the ledger read #561's
 * fallback sweep runs to decide which days are still uncovered, and the shape #493/#495
 * derive adherence from (ADR-052 §6).
 *
 * **A day is the swept atom's attributed day (`coverageDateForArtifact`), NEVER the
 * marker row's `artifact_external_links.created_at`.** The sweep is lazy — it runs at the
 * start of the next attended session — so every marker it backfills carries the *sweep*
 * date. Keyed on `created_at`, a five-day catch-up would collapse into a single day and
 * every promoted day would show both kinds sharing one timestamp. Keyed on the atom's own
 * day, a marker written days late still attributes to the day being closed.
 *
 * **The attributed day is the `effective_at` date when that is 0 to 7 calendar days
 * before the `captured_at` date, and the `captured_at` date otherwise (ADR-119, amending
 * ADR-088 §3).** A meeting held on day D whose transcript syncs on D+1 belongs to D, the
 * day `knowledge_search`'s `effective_at` window also gives it. Beyond 7 days the atom
 * stays on its `captured_at` day: a 2016 contract ingested today is counted today, so a
 * synthesized backfill never opens a coverage obligation on 2016-03-12, a day that would
 * read as forever incomplete and corrupt the adherence metrics (#493/#495). That ceiling
 * is what remains of ADR-088 §3's "coverage reads transaction time"; inside it, coverage
 * and the day window agree on purpose. `public.get_dos_coverage_days` (migration 158)
 * holds the same rule in SQL.
 *
 * **Counts by kind, never a collapsed scalar state — and objects by kind too.** A day
 * that carries markers from both families (or both unattended and attended) keeps every
 * kind separate; a shape that resolved that to one word here would be lossy from birth
 * for every consumer downstream (ADR-052 §6, §8). Promoting an unattended Daily Log writes
 * only `consumed_by_state` on the twin (ADR-109 §2, ADR-110 §3) rather than inserting a
 * second `synthesized` marker. The same argument reaches the objects those markers point
 * at: a kind-agnostic union of page ids cannot answer "is THIS log still unconfirmed",
 * which is #562's per-log predicate.
 *
 * Two queries, mirroring the `not_consumed` pattern in `tools/search.ts`: marker rows
 * first (served by `idx_artifact_external_links_kind (user_id, kind)`), then the
 * `captured_at` of the artifacts they hang off, windowed to the range. The window read
 * is `readWindowArtifacts`: keyset-paged and served index-only by migration 153 (#2257).
 *
 * Archived artifacts are deliberately NOT excluded: the marker records that a day was
 * closed, and soft-deleting one of that day's atoms afterwards must not retroactively
 * re-open the day and make it a sweep candidate again.
 *
 * Unlike the other readers in this file this one **throws** rather than degrading to an
 * empty result. An empty coverage read is indistinguishable from "every day is
 * uncovered", and the caller acts on that by writing drafts — silently re-synthesising
 * days the owner already closed. A read this one is wrong about is worse than no read.
 *
 * **Coverage is per domain when `domain` is given (#677).** One log per domain (ADR-051
 * §11), so a day closed in `angus` and never in `work` is a closed day for one of them
 * and an open day for the other. Unscoped, the read pools every provider — which is what
 * every caller got before the second domain gained a Daily Log to write to, and is still
 * the right answer for "was this day closed by anyone at all". See `scopeToDomain`.
 */
export async function getSynthesisCoverage(
	fromDate: string,
	toDate: string,
	domain: Domain | undefined,
	deps: ExternalLinkAdapterDeps,
): Promise<SynthesisCoverageDay[]> {
	const { client: supabase, ownerId: getCurrentUserId } = deps;
	const userId = getCurrentUserId();
	const days = enumerateDays(fromDate, toDate);
	const byDay = new Map<string, SynthesisCoverageDay>(
		days.map((date) => [
			date,
			{
				date,
				synthesized: 0,
				synthesized_unattended: 0,
				synthesized_external_ids: [],
				synthesized_unattended_external_ids: [],
				evidence_aggregated: 0,
				evidence_aggregated_unattended: 0,
				evidence_aggregated_external_ids: [],
				evidence_aggregated_unattended_external_ids: [],
				captured_atoms: 0,
				no_material: false,
			},
		]),
	);

	const markers: Array<{
		id: string;
		artifact_id: string | null;
		kind: string;
		external_id: string | null;
	}> = [];
	const coverageKinds = [...SYNTHESIS_MARKER_KINDS, ...EVIDENCE_CLOSING_KINDS];
	for (let last: string | null = null; ; ) {
		let q = scopeToDomain(
			supabase
				.from("artifact_external_links")
				.select("id, artifact_id, kind, external_id")
				.eq("user_id", userId),
			domain,
			deps.domainProvider,
		).in("kind", coverageKinds);
		if (last !== null) q = q.gt("id", last);
		const { data: markerRows, error: markerErr } = await q
			.order("id")
			.limit(COVERAGE_ARTIFACT_PAGE_SIZE);

		if (markerErr) {
			throw new Error(
				`Synthesis-marker lookup failed: ${markerErr.message}. If this mentions an undefined relation, apply migration 047.`,
			);
		}

		const page = (markerRows ?? []) as typeof markers;
		markers.push(...page);
		if (page.length < COVERAGE_ARTIFACT_PAGE_SIZE) break;
		last = page[page.length - 1].id;
	}
	const byArtifact = new Map<string, Array<{ kind: string; external_id: string | null }>>();
	for (const m of markers) {
		if (!m.artifact_id) continue;
		const list = byArtifact.get(m.artifact_id);
		if (list) list.push({ kind: m.kind, external_id: m.external_id });
		else byArtifact.set(m.artifact_id, [{ kind: m.kind, external_id: m.external_id }]);
	}

	// Second query: the artifacts captured in the window, to derive both marker day-attribution
	// and whether zero atoms were captured on a day (`no_material`, #664, ADR-052 §8).
	// The scan is bounded on captured_at, but each row's day is its attributed day:
	// effective_at when it is 0 to 7 days before captured_at, captured_at otherwise
	// (coverageDateForArtifact, ADR-119). An unmarked atom captured after `toDate` and
	// dated inside the window is therefore missed by this read; get_dos_coverage_days
	// scans 7 days further to catch it (#2264, #2312).
	const { fromTs, toTs } = dayBounds(fromDate, toDate);
	const idsByDay = new Map<
		string,
		{
			synthesized: Set<string>;
			unattended: Set<string>;
			evidenceAggregated: Set<string>;
			evidenceUnattended: Set<string>;
		}
	>(
		days.map((d) => [
			d,
			{
				synthesized: new Set(),
				unattended: new Set(),
				evidenceAggregated: new Set(),
				evidenceUnattended: new Set(),
			},
		]),
	);

	const artifactRows = await readWindowArtifacts(
		supabase,
		userId,
		fromTs,
		toTs,
		"Coverage artifact lookup failed",
	);

	// Guarantee marker attribution even if a marker artifact fell on a saturated day
	// that was skipped past after COVERAGE_MAX_ATOMS_PER_DAY.
	const markerArtifactIds = [
		...new Set(markers.map((m) => m.artifact_id).filter((id): id is string => Boolean(id))),
	];
	const windowArtifactIds = new Set(artifactRows.map((r) => r.id));
	const missingMarkerIds = markerArtifactIds.filter(
		(id) => !windowArtifactIds.has(id),
	);
	for (let i = 0; i < missingMarkerIds.length; i += COVERAGE_ID_CHUNK) {
		const chunk = missingMarkerIds.slice(i, i + COVERAGE_ID_CHUNK);
		const { data: chunkArtifacts, error: artErr } = await supabase
			.from("artifacts")
			.select("id, captured_at, effective_at, content_subtype, lifecycle_stage")
			.eq("user_id", userId)
			.in("id", chunk);
		if (!artErr && chunkArtifacts) {
			artifactRows.push(...(chunkArtifacts as CoverageArtifactRow[]));
		}
	}

	for (const row of artifactRows) {
		// A row with no usable date cannot be attributed to a day at all; skipping it is
		// the honest read (it leaves the day uncovered rather than claiming a false close).
		const date = coverageDateForArtifact(row);
		if (!date) continue;
		const bucket = byDay.get(date);
		if (!bucket) continue;
		const dayIds = idsByDay.get(date)!;

		if (isSynthesizableMaterial(row)) {
			bucket.captured_atoms += 1;
		}

		for (const marker of byArtifact.get(row.id) ?? []) {
			if (marker.kind === SYNTHESIZED_UNATTENDED) {
				bucket.synthesized_unattended += 1;
				if (marker.external_id) dayIds.unattended.add(marker.external_id);
			} else if (marker.kind === SYNTHESIZED) {
				bucket.synthesized += 1;
				if (marker.external_id) dayIds.synthesized.add(marker.external_id);
			} else if (marker.kind === EVIDENCE_AGGREGATED) {
				bucket.evidence_aggregated += 1;
				if (marker.external_id) dayIds.evidenceAggregated.add(marker.external_id);
			} else if (marker.kind === EVIDENCE_AGGREGATED_UNATTENDED) {
				bucket.evidence_aggregated_unattended += 1;
				if (marker.external_id) dayIds.evidenceUnattended.add(marker.external_id);
			}
		}
	}

	for (const date of days) {
		const dayIds = idsByDay.get(date)!;
		const bucket = byDay.get(date)!;
		bucket.synthesized_external_ids = [...dayIds.synthesized].sort();
		bucket.synthesized_unattended_external_ids = [...dayIds.unattended].sort();
		bucket.evidence_aggregated_external_ids = [...dayIds.evidenceAggregated].sort();
		bucket.evidence_aggregated_unattended_external_ids = [...dayIds.evidenceUnattended].sort();
		bucket.no_material =
			bucket.captured_atoms === 0 &&
			bucket.synthesized === 0 &&
			bucket.synthesized_unattended === 0 &&
			bucket.evidence_aggregated === 0 &&
			bucket.evidence_aggregated_unattended === 0;
	}
	return days.map((d) => byDay.get(d)!);
}

/**
 * Derives the ritual streak live across all history for the given domain
 * (ADR-052 §1, §8, #493, #664).
 */
export async function getStreak(
	domain: Domain | undefined,
	asOfDate: string | undefined,
	deps: ExternalLinkAdapterDeps,
): Promise<SynthesisStreak> {
	const { client: supabase, ownerId: getCurrentUserId } = deps;
	const userId = getCurrentUserId();
	const today = new Date().toISOString().slice(0, 10);
	const targetDate = asOfDate ?? today;

	const markers: Array<{
		id: string;
		artifact_id: string | null;
		kind: string;
	}> = [];
	const streakKinds = [...SYNTHESIS_MARKER_KINDS, ...EVIDENCE_CLOSING_KINDS];
	for (let last: string | null = null; ; ) {
		let q = scopeToDomain(
			supabase
				.from("artifact_external_links")
				.select("id, artifact_id, kind")
				.eq("user_id", userId),
			domain,
			deps.domainProvider,
		).in("kind", streakKinds);
		if (last !== null) q = q.gt("id", last);
		const { data: markerRows, error: markerErr } = await q
			.order("id")
			.limit(COVERAGE_ARTIFACT_PAGE_SIZE);

		if (markerErr) {
			throw new Error(`Streak marker lookup failed: ${markerErr.message}.`);
		}

		const page = (markerRows ?? []) as typeof markers;
		markers.push(...page);
		if (page.length < COVERAGE_ARTIFACT_PAGE_SIZE) break;
		last = page[page.length - 1].id;
	}
	if (markers.length === 0) {
		return { current: 0, best: 0, formatted: "day 0 · best 0" };
	}

	const markerArtifactIds = [...new Set(markers.map((m) => m.artifact_id).filter(Boolean))] as string[];

	// Chunked like the sibling `.in("artifact_id", …)` lookup in getDailyLogQueue above: one
	// marker per attended day keeps this well under COVERAGE_ID_CHUNK today, but a years-long
	// streak history is exactly the case this function exists for, so it must not silently
	// hit PostgREST's URL-length ceiling the day it finally gets long.
	const markedArtifacts: Array<{ id: string; captured_at: string | null; effective_at?: string | null }> = [];
	for (let i = 0; i < markerArtifactIds.length; i += COVERAGE_ID_CHUNK) {
		const chunk = markerArtifactIds.slice(i, i + COVERAGE_ID_CHUNK);
		const { data: chunkArtifacts, error: artErr } = await supabase
			.from("artifacts")
			.select("id, captured_at, effective_at")
			.eq("user_id", userId)
			.in("id", chunk);

		if (artErr) {
			throw new Error(`Streak artifact lookup failed: ${artErr.message}.`);
		}
		markedArtifacts.push(
			...((chunkArtifacts ?? []) as Array<{
				id: string;
				captured_at: string | null;
				effective_at?: string | null;
			}>),
		);
	}

	const datesWithSynthesized = new Set<string>();
	const datesWithUnattended = new Set<string>();
	const datesWithEvidenceAggregated = new Set<string>();
	const datesWithEvidenceUnattended = new Set<string>();
	const markerKindsByArtifact = new Map<string, Set<string>>();
	for (const m of markers) {
		if (!m.artifact_id) continue;
		let set = markerKindsByArtifact.get(m.artifact_id);
		if (!set) {
			set = new Set();
			markerKindsByArtifact.set(m.artifact_id, set);
		}
		set.add(m.kind);
	}

	let earliestDate: string | null = null;
	for (const row of markedArtifacts) {
		const date = coverageDateForArtifact(row);
		if (!date) continue;
		if (date > targetDate) continue;
		if (!earliestDate || date < earliestDate) earliestDate = date;

		const kinds = markerKindsByArtifact.get(row.id);
		if (kinds?.has(SYNTHESIZED)) datesWithSynthesized.add(date);
		if (kinds?.has(SYNTHESIZED_UNATTENDED)) datesWithUnattended.add(date);
		if (kinds?.has(EVIDENCE_AGGREGATED)) datesWithEvidenceAggregated.add(date);
		if (kinds?.has(EVIDENCE_AGGREGATED_UNATTENDED)) datesWithEvidenceUnattended.add(date);
	}

	if (!earliestDate) {
		return { current: 0, best: 0, formatted: "day 0 · best 0" };
	}

	// Same derivation as getSynthesisCoverage (#664, ADR-052 §8, ADR-109 §2): count captured
	// atoms per day (Daily Log twins excluded) over a paginated read, so a long history is
	// never silently truncated at PostgREST's max_rows cap, and no_material is true exactly
	// when a day has zero captured atoms and no closing marker of either family.
	const atomsByDay = new Map<string, number>();
	const materialRows = await readWindowArtifacts(
		supabase,
		userId,
		`${earliestDate}T00:00:00.000Z`,
		`${targetDate}T23:59:59.999Z`,
		"Streak material lookup failed",
	);
	for (const row of materialRows) {
		const date = coverageDateForArtifact(row);
		if (!date) continue;
		if (!isSynthesizableMaterial(row)) continue;
		atomsByDay.set(date, (atomsByDay.get(date) ?? 0) + 1);
	}

	const allDays = enumerateDays(earliestDate, targetDate);
	const coverageDays: SynthesisCoverageDay[] = allDays.map((date) => {
		const synthesized = datesWithSynthesized.has(date) ? 1 : 0;
		const synthesized_unattended = datesWithUnattended.has(date) ? 1 : 0;
		const evidence_aggregated = datesWithEvidenceAggregated.has(date) ? 1 : 0;
		const evidence_aggregated_unattended = datesWithEvidenceUnattended.has(date) ? 1 : 0;
		const captured_atoms = atomsByDay.get(date) ?? 0;
		return {
			date,
			synthesized,
			synthesized_unattended,
			synthesized_external_ids: [],
			synthesized_unattended_external_ids: [],
			evidence_aggregated,
			evidence_aggregated_unattended,
			evidence_aggregated_external_ids: [],
			evidence_aggregated_unattended_external_ids: [],
			captured_atoms,
			no_material:
				captured_atoms === 0 &&
				synthesized === 0 &&
				synthesized_unattended === 0 &&
				evidence_aggregated === 0 &&
				evidence_aggregated_unattended === 0,
		};
	});

	return computeStreak(coverageDays, { asOfToday: today });
}

// ---------------------------------------------------------------------------
// Daily-log queue (#666, ADR-051 §10 / Amendment 2)
// ---------------------------------------------------------------------------

type TwinRow = { id: string; title: string | null; captured_at: string | null };
type PointerRow = {
	artifact_id: string | null;
	provider: string;
	kind: string;
	external_id: string | null;
	external_url: string | null;
};

/** `provider` → the domain that writes it. The inverse of domainProvider. */
function buildProviderDomainMap(
	domainProvider: Record<Domain, string> = DEFAULT_DOMAIN_PROVIDER,
): Record<string, Domain> {
	return Object.fromEntries(
		(Object.entries(domainProvider) as Array<[Domain, string]>).map(([d, p]) => [p, d]),
	);
}

/**
 * Pick the pointer a twin is read through. A twin is meant to carry exactly one
 * `daily_log` pointer; the table's unique key is `(artifact_id, provider, kind,
 * external_id)`, so more than one is representable, and PostgREST's row order is
 * unspecified, so picking among them would be non-deterministic. Scoped, the candidates
 * are the pointers under that domain's provider (none → the twin is not this domain's).
 * Unscoped, every pointer is a candidate. Exactly one candidate is the pointer; more than
 * one is a conflict, reported with each pointer's provider, never resolved by luck.
 */
function choosePointer(
	pointers: PointerRow[],
	domain: Domain | undefined,
	providerDomain: Record<string, Domain>,
): { pointer: PointerRow | null; conflict: string[]; skip: boolean } {
	const candidates = [...pointers]
		.filter((p) => !domain || providerDomain[p.provider] === domain)
		.sort((a, b) => `${a.provider}/${a.external_id}`.localeCompare(`${b.provider}/${b.external_id}`));
	if (domain && candidates.length === 0) return { pointer: null, conflict: [], skip: true };
	if (candidates.length > 1) {
		return { pointer: null, conflict: candidates.map((p) => p.provider), skip: false };
	}
	return { pointer: candidates[0] ?? null, conflict: [], skip: false };
}

/**
 * Every Daily Log twin the State Doc has not yet absorbed: "all unconsumed daily logs",
 * the second half of the attended `dos` session's standing read (ADR-051 Amendment 2:
 * *fetch today's atoms **and all unconsumed daily logs**; handle everything; mark
 * everything*).
 *
 * Three reads, all over rows the ritual already writes (ADR-050 §8, no second store):
 *
 * 1. the twins: `artifacts` with `content_subtype = 'daily_log'`, not archived;
 * 2. their links: the `daily_log` pointer (which page, which provider) and any
 *    `consumed_by_state` row (hop 2, which makes the twin leave the queue);
 * 3. the synthesis markers pointing at the selected twins' pages, so each entry can say
 *    whether it is a swept draft, an entry the owner closed, or a log whose atoms were
 *    never marked at all.
 *
 * **`domain` filters on the pointer's provider, in memory, never as a query predicate.**
 * A twin whose pointer write failed has no provider to match, and a provider predicate
 * on the link query would make it indistinguishable from the other domain's twins. So:
 * scoped, the queue holds exactly the twins carrying a pointer under that domain's
 * provider; unscoped, it also lists pointerless twins and twins whose pointers name two
 * domains, because that is the only read that can.
 *
 * Oldest first (the database orders on `captured_at`), because that is the order the
 * owner reviews them in (ADR-051 §10: "miss a week and the review is five logs"). No
 * window and no limit: the queue is over logs, not atoms, so it is bounded by days, and
 * hiding any of it would be the silence ADR-067 §4 forbids.
 */
export async function getDailyLogQueue(
	domain: Domain | undefined,
	includeConsumed = false,
	deps: ExternalLinkAdapterDeps,
): Promise<DailyLogQueueEntry[]> {
	const { client: supabase, ownerId: getCurrentUserId, domainProvider } = deps;
	const userId = getCurrentUserId();
	const providerDomain = buildProviderDomainMap(domainProvider);

	const { data: twinRows, error: twinErr } = await supabase
		.from("artifacts")
		.select("id, title, captured_at")
		.eq("user_id", userId)
		.eq("content_subtype", DAILY_LOG_CONTENT_SUBTYPE)
		.is("archived_at", null)
		.order("captured_at", { ascending: true });
	if (twinErr) {
		throw new Error(`Daily-log twin lookup failed: ${twinErr.message}.`);
	}
	const twins = (twinRows ?? []) as TwinRow[];
	if (twins.length === 0) return [];

	const pointers = new Map<string, PointerRow[]>();
	const consumed = new Map<string, string>();
	const ids = twins.map((t) => t.id);
	for (let i = 0; i < ids.length; i += COVERAGE_ID_CHUNK) {
		const chunk = ids.slice(i, i + COVERAGE_ID_CHUNK);
		const { data, error } = await supabase
			.from("artifact_external_links")
			.select("artifact_id, provider, kind, external_id, external_url")
			.eq("user_id", userId)
			.in("artifact_id", chunk)
			.in("kind", [DAILY_LOG_LINK_KIND, STATE_DOC_LINK_KIND]);
		if (error) {
			throw new Error(
				`Daily-log link lookup failed: ${error.message}. If this mentions an undefined relation, apply migration 047.`,
			);
		}
		for (const row of (data ?? []) as PointerRow[]) {
			if (!row.artifact_id) continue;
			if (row.kind === DAILY_LOG_LINK_KIND) {
				const list = pointers.get(row.artifact_id);
				if (list) list.push(row);
				else pointers.set(row.artifact_id, [row]);
			} else if (row.kind === STATE_DOC_LINK_KIND && row.external_id) {
				consumed.set(row.artifact_id, row.external_id);
			}
		}
	}

	// Attribute and filter BEFORE the marker read, so a scoped call only asks about its
	// own domain's pages (the sibling reader, getSynthesisCoverage, scopes the same way).
	const selected: Array<{ twin: TwinRow; pointer: PointerRow | null; conflict: string[] }> = [];
	for (const twin of twins) {
		const { pointer, conflict, skip } = choosePointer(
			pointers.get(twin.id) ?? [],
			domain,
			providerDomain,
		);
		if (skip) continue;
		if (consumed.has(twin.id) && !includeConsumed) continue;
		selected.push({ twin, pointer, conflict });
	}

	// Which pages carry which marker kinds, so a queued log can say whether anyone
	// confirmed it. Same derivation as dos_synthesis_coverage, per page rather than per day.
	const pageIds = [
		...new Set(selected.map((s) => s.pointer?.external_id).filter((id): id is string => Boolean(id))),
	];
	const attended = new Set<string>();
	const unattended = new Set<string>();
	for (let i = 0; i < pageIds.length; i += COVERAGE_ID_CHUNK) {
		const chunk = pageIds.slice(i, i + COVERAGE_ID_CHUNK);
		for (let last: string | null = null; ; ) {
			let q = supabase
				.from("artifact_external_links")
				.select("id, kind, external_id")
				.eq("user_id", userId)
				.in("external_id", chunk)
				.in("kind", [...SYNTHESIS_MARKER_KINDS, ...EVIDENCE_CLOSING_KINDS]);
			if (last !== null) q = q.gt("id", last);
			const { data, error } = await q
				.order("id")
				.limit(COVERAGE_ARTIFACT_PAGE_SIZE);
			if (error) {
				throw new Error(
					`Daily-log marker lookup failed: ${error.message}. If this mentions an undefined relation, apply migration 047.`,
				);
			}
			const page = (data ?? []) as Array<{
				id: string;
				kind: string;
				external_id: string | null;
			}>;
			for (const row of page) {
				if (!row.external_id) continue;
				if (row.kind === SYNTHESIZED || row.kind === EVIDENCE_AGGREGATED) {
					attended.add(row.external_id);
				} else if (row.kind === SYNTHESIZED_UNATTENDED || row.kind === EVIDENCE_AGGREGATED_UNATTENDED) {
					unattended.add(row.external_id);
				}
			}
			if (page.length < COVERAGE_ARTIFACT_PAGE_SIZE) break;
			last = page[page.length - 1].id;
		}
	}

	return selected.map(({ twin, pointer, conflict }) => {
		const pageId = pointer?.external_id ?? null;
		const markers: DailyLogMarkers =
			pageId && attended.has(pageId) ? "attended" : pageId && unattended.has(pageId) ? "unattended" : "none";
		return {
			artifact_id: twin.id,
			date: twin.captured_at ? twin.captured_at.slice(0, 10) : null,
			title: twin.title,
			domain: pointer ? (providerDomain[pointer.provider] ?? null) : null,
			provider: pointer?.provider ?? null,
			page_id: pageId,
			page_url: pointer?.external_url ?? null,
			markers,
			conflicting_providers: conflict,
			consumed_by_state: consumed.get(twin.id) ?? null,
		};
	});
}

export async function getDosEvidenceAggregate(
	params: DosEvidenceAggregateParams,
	deps: ExternalLinkAdapterDeps,
): Promise<DosEvidenceAggregateRow> {
	const { client: supabase, ownerId: getCurrentUserId } = deps;
	if (!supabase.rpc) {
		throw new Error(
			"get_dos_evidence_aggregate requires a Supabase client with rpc() wired.",
		);
	}
	const { data, error } = await supabase.rpc("get_dos_evidence_aggregate", {
		p_user_id: getCurrentUserId(),
		p_domain: params.domain,
		p_days: params.days ?? 14,
		p_since: params.since ?? null,
		p_until: params.until ?? null,
		p_timezone: params.timezone ?? "Europe/London",
		p_top_n: params.topN ?? 5,
		p_surface_role_map: params.surfaceRoleMap ?? null,
		p_default_role: params.defaultRole ?? "narrative",
	});
	if (error) {
		throw new Error(
			`get_dos_evidence_aggregate failed: ${error.message}. If this mentions an undefined function, apply migration 156.`,
		);
	}
	const raw = (data ?? {}) as Partial<DosEvidenceAggregateRow>;
	return {
		domain: raw.domain ?? params.domain,
		timezone: raw.timezone ?? params.timezone ?? "Europe/London",
		since: raw.since ?? params.since ?? "",
		until: raw.until ?? params.until ?? "",
		days: Array.isArray(raw.days) ? raw.days : [],
		late_arrivals: Array.isArray(raw.late_arrivals) ? raw.late_arrivals : [],
	};
}

export function createSupabaseExternalLinkRepository(
	deps: ExternalLinkAdapterDeps,
): ExternalLinkRepository {
	return {
		recordExternalLink: (artifactId, link) =>
			recordExternalLink(artifactId, link, deps),
		getArtifactContentSubtype: (artifactId) =>
			getArtifactContentSubtype(artifactId, deps),
		getExternalLinks: (artifactId) => getExternalLinks(artifactId, deps),
		inspectDedupSlot: (artifactId, provider, kind, dedupKey) =>
			inspectDedupSlot(artifactId, provider, kind, dedupKey, deps),
		claimDedupSlot: (artifactId, provider, kind, dedupKey) =>
			claimDedupSlot(artifactId, provider, kind, dedupKey, deps),
		finalizeExternalLink: (linkId, externalId, externalUrl) =>
			finalizeExternalLink(linkId, externalId, externalUrl, deps),
		releaseClaimForFailedWrite: (claimedLinkId, error) =>
			releaseClaimForFailedWrite(claimedLinkId, error, deps),
		interruptedClaimMessage,
		scopeToDomain: <Q>(query: Q, domain?: Domain) =>
			scopeToDomain(query, domain, deps.domainProvider),
		getSynthesizedArtifactIds: (domain) =>
			getSynthesizedArtifactIds(domain, deps),
		computeStreak,
		enumerateDays,
		getSynthesisCoverage: (fromDate, toDate, domain) =>
			getSynthesisCoverage(fromDate, toDate, domain, deps),
		getStreak: (domain, asOfDate) => getStreak(domain, asOfDate, deps),
		getDailyLogQueue: (domain, includeConsumed) =>
			getDailyLogQueue(domain, includeConsumed, deps),
		getDosEvidenceAggregate: (params) =>
			getDosEvidenceAggregate(params, deps),
	};
}
