/**
 * @ahkms/core/ports - externalLinks.ts
 *
 * Port interface and domain types for the cross-store lineage and synthesis-marker
 * ledger (`artifact_external_links`, ADR-013 §5/§7, ADR-050 §6, ADR-101, Issue #1604).
 */

import type { Domain } from "../domain/domains.js";

export type ExternalLink = {
	provider: string;
	kind: string;
	external_id: string;
	external_url?: string | null;
	// Pre-creation idempotency key for the 1->many Act case (e.g. one task among several
	// spawned from a transcript). NULL/undefined for links with no per-item key. See
	// migration 064 and createTask.ts's single_task/dedup_key dedup guard (issue #141).
	dedup_key?: string | null;
};

/**
 * What is occupying an artifact's dedup slot, as three distinct states:
 *
 * - `free` — nothing in the way; the caller may claim and create.
 * - `linked` — a **real** external item is recorded here. This is the duplicate the
 *   guard exists to catch (issue #141).
 * - `pending` — only an unfinished claim (`PENDING_EXTERNAL_ID`) sits here. No external
 *   item was ever recorded. NOT a duplicate.
 */
export type DedupSlotState = "free" | "linked" | "pending";

export type ClaimResult =
	| { claimed: true; linkId: string }
	| { claimed: false; reason: "conflict" | "error"; error?: string };

/**
 * One calendar day's synthesis-marker tally. Counts by kind, never a collapsed state —
 * and, since #562, objects by kind for the same reason.
 */
export type SynthesisCoverageDay = {
	/** `YYYY-MM-DD`, UTC. */
	date: string;
	/** Marker rows of kind `synthesized` attributed to this day. */
	synthesized: number;
	/** Marker rows of kind `synthesized_unattended` attributed to this day. */
	synthesized_unattended: number;
	/** Distinct objects this day's `synthesized` markers point at (Daily Log page ids), sorted. */
	synthesized_external_ids: string[];
	/** Distinct objects this day's `synthesized_unattended` markers point at, sorted. */
	synthesized_unattended_external_ids: string[];
	/** Marker rows of kind `evidence_aggregated` attributed to this day (on Daily Log twins). */
	evidence_aggregated: number;
	/** Marker rows of kind `evidence_aggregated_unattended` attributed to this day (on Daily Log twins). */
	evidence_aggregated_unattended: number;
	/** Distinct objects this day's `evidence_aggregated` markers point at (Daily Log page ids), sorted. */
	evidence_aggregated_external_ids: string[];
	/** Distinct objects this day's `evidence_aggregated_unattended` markers point at, sorted. */
	evidence_aggregated_unattended_external_ids: string[];
	/**
	 * Synthesis-material atoms attributed to this day (Daily Log twins, scaffolds and
	 * unenriched pointers excluded). The day is the atom's `effective_at` date (UTC) when
	 * that is 0 to 7 calendar days before its `captured_at` date, and its `captured_at`
	 * date otherwise (ADR-119).
	 */
	captured_atoms: number;
	/**
	 * True when zero atoms were captured and no synthesis or evidence-closing markers
	 * exist on this date (ADR-052 §8 amendment, #664, ADR-109 §2).
	 * Pauses streak arithmetic rather than breaking it.
	 */
	no_material: boolean;
};

/**
 * Shared predicate for whether a day has captured material and no closing marker of
 * either family (`synthesized`, `synthesized_unattended`, `evidence_aggregated`, or
 * `evidence_aggregated_unattended`). Used by coverage formatting, `computeStreak`,
 * and `dosSweepOutcomeCheck` (ADR-109 §2, #1781, #2226).
 */
export function isUncoveredDay(
	day: Pick<
		SynthesisCoverageDay,
		| "no_material"
		| "synthesized"
		| "synthesized_unattended"
		| "evidence_aggregated"
		| "evidence_aggregated_unattended"
	>,
): boolean {
	return (
		!day.no_material &&
		day.synthesized === 0 &&
		day.synthesized_unattended === 0 &&
		day.evidence_aggregated === 0 &&
		day.evidence_aggregated_unattended === 0
	);
}

export type SynthesisStreak = {
	/** Current streak length in days. */
	current: number;
	/** Longest streak length in days across the evaluated period. */
	best: number;
	/** Standard human-readable badge string, e.g. "day 5 🔥 · best 12". */
	formatted: string;
};

/**
 * What the synthesis markers pointing at a log's Notion page say about it.
 */
export type DailyLogMarkers = "attended" | "unattended" | "none";

/**
 * One Daily Log twin as the attended `dos` session's review queue sees it.
 */
export type DailyLogQueueEntry = {
	artifact_id: string;
	/** `YYYY-MM-DD` the log NARRATES (the twin's `captured_at`, fixed to the entry's day by #562); null when the row has none. */
	date: string | null;
	title: string | null;
	/** The domain whose ritual wrote it, read back from its pointer's provider; null when there is no pointer, or when pointers disagree. */
	domain: Domain | null;
	provider: string | null;
	/** The Notion page the twin points at; null when the twin has no usable `daily_log` pointer (Step 8's link write failed, or pointers disagree). */
	page_id: string | null;
	page_url: string | null;
	/** Derived from the synthesis and evidence-closing markers pointing at `page_id`: an attended run stamped `synthesized` or `evidence_aggregated`, only the #561 / evidence sweep stamped `synthesized_unattended` or `evidence_aggregated_unattended`, or nothing has been stamped at all. */
	markers: DailyLogMarkers;
	/** Non-empty when the twin carries more than one candidate `daily_log` pointer (under two domains' providers in an unscoped read, or two pages under one provider). */
	conflicting_providers: string[];
	/** The State Doc page a `consumed_by_state` row points at; null while the log is still queued. */
	consumed_by_state: string | null;
};

export interface DosEvidenceAggregateParams {
	domain: Domain;
	days?: number;
	since?: string;
	until?: string;
	timezone?: string;
	topN?: number;
	surfaceRoleMap?: Record<string, string>;
	defaultRole?: string;
}

export interface DosEvidenceAggregateItem {
	id: string;
	title: string | null;
	surface: string | null;
	source_channel: string | null;
	content_subtype: string | null;
	connection: string;
	captured_at: string;
	effective_at: string;
	event_date: string;
}

export interface DosEvidenceAggregateGroup {
	surface: string | null;
	source_channel: string | null;
	content_subtype: string | null;
	connection: string;
	count: number;
	evidence_count: number;
	excluded_or_robot_count: number;
	top_n: DosEvidenceAggregateItem[];
}

export interface DosEvidenceAggregateDay {
	date: string;
	closed_at: string | null;
	material_total: number;
	evidence_total: number;
	excluded_or_robot_total: number;
	dated_earlier_count: number;
	dated_earlier_note: string | null;
	groups: DosEvidenceAggregateGroup[];
	items: DosEvidenceAggregateItem[];
	dated_earlier_items: DosEvidenceAggregateItem[];
}

export interface DosEvidenceAggregateLateArrival {
	id: string;
	title: string | null;
	surface: string | null;
	source_channel: string | null;
	content_subtype: string | null;
	connection: string;
	captured_at: string;
	effective_at: string;
	captured_date: string;
	closed_at: string;
}

export interface DosEvidenceAggregateRow {
	domain: Domain;
	timezone: string;
	since: string;
	until: string;
	days: DosEvidenceAggregateDay[];
	late_arrivals: DosEvidenceAggregateLateArrival[];
}

export interface ExternalLinkRepository {
	recordExternalLink(
		artifactId: string,
		link: ExternalLink,
	): Promise<{ ok: boolean; error?: string }>;
	getArtifactContentSubtype(
		artifactId: string,
	): Promise<{ data: { content_subtype: string | null } | null; error?: string }>;
	getExternalLinks(artifactId: string): Promise<ExternalLink[]>;
	inspectDedupSlot(
		artifactId: string,
		provider: string,
		kind: string,
		dedupKey?: string | null,
	): Promise<DedupSlotState>;
	claimDedupSlot(
		artifactId: string,
		provider: string,
		kind: string,
		dedupKey: string | null,
	): Promise<ClaimResult>;
	finalizeExternalLink(
		linkId: string,
		externalId: string,
		externalUrl: string | null,
	): Promise<{ ok: boolean; error?: string }>;
	releaseClaimForFailedWrite(
		claimedLinkId: string | null,
		error: unknown,
	): Promise<unknown>;
	interruptedClaimMessage(opts: {
		artifactId: string;
		provider: string;
		kind: string;
		dedupKey?: string | null;
	}): string;
	scopeToDomain<Q>(query: Q, domain?: Domain): Q;
	getSynthesizedArtifactIds(domain?: Domain): Promise<Set<string>>;
	computeStreak(
		days: SynthesisCoverageDay[],
		options?: { asOfToday?: string },
	): SynthesisStreak;
	enumerateDays(fromDate: string, toDate: string): string[];
	getSynthesisCoverage(
		fromDate: string,
		toDate: string,
		domain?: Domain,
	): Promise<SynthesisCoverageDay[]>;
	getStreak(domain?: Domain, asOfDate?: string): Promise<SynthesisStreak>;
	getDailyLogQueue(
		domain?: Domain,
		includeConsumed?: boolean,
	): Promise<DailyLogQueueEntry[]>;
	getDosEvidenceAggregate(
		params: DosEvidenceAggregateParams,
	): Promise<DosEvidenceAggregateRow>;
}
