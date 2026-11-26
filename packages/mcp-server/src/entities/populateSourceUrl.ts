import { supabase } from "../supabase.js";
import { getCurrentUserId } from "../identity.js";
import { DOMAINS, type Domain } from "../domains.js";
import { domainToken } from "../notionDomain.js";
import { searchNotion, notionResultTitle } from "../notion.js";

// Populate entities.source_url for `people` entities (#445, the deliberate pass
// #426 deferred). Read entities.source_url's own migration comment
// (20260725120000_077_add_entities_source_url.sql) before touching this file —
// NULL is a documented positive state ("native to the graph"), not "not yet
// backfilled", and the partial unique index entities_user_source_url_unique
// means two entities must never claim the same external record.
//
// person_match (tools/people.ts) does NOT reach Notion at all — it only matches
// within the entities/people table — so it cannot supply a "home row" URL.
// notion_search (notion.ts) is the actual candidate source here: it returns a
// `url` per Notion page, searched across whichever workspace(s) (work/angus,
// ADR-054) have a configured token.
//
// The issue's own worked example ("Sam") is the reason this stays deliberately
// narrow: a name-only search over a whole Notion workspace WILL surface several
// people sharing a first name, and a wrong attribution is "far harder to unpick
// than a missing link" (migration 077's comment). So this only ever WRITES a
// source_url when exactly one live page across every searched workspace has a
// name that normalizes to an exact match — the same normalizeName-based
// comparison the worker's identityResolution.ts (#174/#310 merge-dedup) already
// uses for the analogous "is this the same name" question, reimplemented here
// (not imported) because mcp-server and worker are peer packages with no direct
// dependency on each other's src/, and this is a small, self-contained pure
// function pair. Anything short of a single exact match — no candidate,
// multiple exact matches, or only a subset/fuzzy resemblance — is left NULL and
// reported instead, mirroring identityResolution.ts's own "never auto-decide on
// ambiguity, surface it for a human" governance rather than inventing a new one.
//
// Scoped to entity_type='people' only: every example and acceptance criterion in
// #445 is about people, and Notion "home pages" for other entity types (project,
// organization, ...) raise their own, not-yet-considered ambiguity questions —
// better left to a future, deliberately scoped follow-up than folded in here.

/** Normalize a name for comparison: lowercase, strip diacritics/punctuation, collapse whitespace. */
function normalizeName(name: string | null | undefined): string {
	if (!name) return "";
	return name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "") // combining diacritics
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ") // punctuation -> space
		.replace(/\s+/g, " ")
		.trim();
}

/** True when `a` and `b` normalize to the same non-empty name. */
function isExactNameMatch(a: string | null | undefined, b: string | null | undefined): boolean {
	const na = normalizeName(a);
	const nb = normalizeName(b);
	return na.length > 0 && na === nb;
}

const DEFAULT_BATCH_SIZE = 25;
// Each row can fire up to one notion_search call per configured workspace, so this
// stays well below the embedding backfill's 200ms — Notion's own withBackoff (notion.ts)
// already retries 429s, this just paces the happy path.
const INTER_BATCH_DELAY_MS = 300;

type PersonEntityRow = {
	id: string;
	title: string | null;
};

export type SourceUrlCandidate = {
	domain: Domain;
	title: string;
	url: string;
};

export type SourceUrlReviewItem = {
	entityId: string;
	entityName: string;
	/**
	 * "no-candidate": nothing in any searched workspace resembled the name at all.
	 * "ambiguous": more than one live page normalizes to an exact match — cannot
	 *   tell which (if any) is the entity's real home row.
	 * "low-confidence": candidates exist but none is an exact name match.
	 */
	reason: "no-candidate" | "ambiguous" | "low-confidence";
	candidates: SourceUrlCandidate[];
};

export type PopulateSourceUrlOptions = {
	/** Rows fetched and processed per round trip. Default 25. */
	batchSize?: number;
	/** Cap on the number of batches this call processes. Omit to drain the full backlog. */
	maxBatches?: number;
	/** Score candidates and report the outcome, but never write. */
	dryRun?: boolean;
	/** Workspaces to search. Defaults to every domain with a configured Notion token. */
	domains?: Domain[];
};

export type PopulateSourceUrlResult = {
	/** Rows fetched and considered. */
	scanned: number;
	/** Rows that got a source_url written (or would have, in a dry run). */
	populated: number;
	/** No candidate resembled the name in any searched workspace. */
	skippedNoCandidate: number;
	/** More than one live page was an exact name match — left NULL. */
	skippedAmbiguous: number;
	/** Candidates existed but none was an exact name match — left NULL. */
	skippedLowConfidence: number;
	/**
	 * The single exact match's URL was already claimed by a different entity in
	 * this user's graph (entities_user_source_url_unique) — left NULL rather than
	 * violate the invariant that two entities never share one external record.
	 */
	skippedConflict: number;
	/** Rows whose notion_search call(s) threw — logged and counted, run continues. */
	failed: number;
	/** people rows still `source_url IS NULL` after this call. */
	remaining: number;
	/**
	 * Everything left NULL that wasn't a clean "native to the graph" non-candidate,
	 * for a human to work through via person_update — the "reviewable" half of the
	 * issue's acceptance criteria. Bounded by how many rows this call scanned, not
	 * capped independently.
	 */
	review: SourceUrlReviewItem[];
};

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Keyset pagination, same reasoning as embeddings/backfill.ts: a row that can't be
// resolved stays `source_url IS NULL` forever, so re-querying "WHERE source_url IS
// NULL" without paging past seen ids would loop on it forever within one run.
async function fetchBatch(batchSize: number, afterId: string | null): Promise<PersonEntityRow[]> {
	let query = supabase
		.from("entities")
		.select("id, title")
		.eq("user_id", getCurrentUserId())
		.eq("entity_type", "people")
		.eq("archived", false)
		.is("source_url", null)
		.order("id", { ascending: true })
		.limit(batchSize);
	if (afterId) query = query.gt("id", afterId);

	const { data, error } = await query;
	if (error) throw new Error(`populate-source-url selection failed: ${error.message}`);
	return (data ?? []) as PersonEntityRow[];
}

async function countRemaining(): Promise<number> {
	const { count, error } = await supabase
		.from("entities")
		.select("id", { count: "exact", head: true })
		.eq("user_id", getCurrentUserId())
		.eq("entity_type", "people")
		.eq("archived", false)
		.is("source_url", null);
	if (error) throw new Error(`populate-source-url remaining-count failed: ${error.message}`);
	return count ?? 0;
}

/** Resolve which domains have a usable token, without throwing on the ones that don't. */
async function availableDomains(requested: Domain[]): Promise<{ domain: Domain; token: string }[]> {
	const resolved = await Promise.all(
		requested.map(async (domain) => {
			try {
				return { domain, token: await domainToken(domain) };
			} catch {
				return null;
			}
		}),
	);
	return resolved.filter((r): r is { domain: Domain; token: string } => r !== null);
}

async function findCandidates(
	name: string,
	tokens: { domain: Domain; token: string }[],
): Promise<SourceUrlCandidate[]> {
	const perDomain = await Promise.all(
		tokens.map(async ({ domain, token }) => {
			const { results } = await searchNotion(token, {
				query: name,
				objectType: "page",
				pageSize: 20,
			});
			return results
				.filter((r) => !r.archived && r.url)
				.map((r) => ({ domain, title: notionResultTitle(r), url: r.url as string }));
		}),
	);
	return perDomain.flat();
}

/**
 * Resolve one person's source_url: throws on a notion_search failure (caller
 * counts it as "failed"), otherwise always returns an outcome — "populated" only
 * on a single, unambiguous exact-name match.
 */
async function resolveRow(
	row: PersonEntityRow,
	tokens: { domain: Domain; token: string }[],
	dryRun: boolean,
): Promise<
	| { outcome: "populated" | "conflict"; candidate: SourceUrlCandidate }
	| { outcome: "no-candidate" | "ambiguous" | "low-confidence"; candidates: SourceUrlCandidate[] }
> {
	if (!row.title?.trim()) return { outcome: "no-candidate", candidates: [] };

	const candidates = await findCandidates(row.title, tokens);
	const exact = candidates.filter((c) => isExactNameMatch(c.title, row.title));

	if (exact.length === 0) {
		return candidates.length === 0
			? { outcome: "no-candidate", candidates: [] }
			: { outcome: "low-confidence", candidates };
	}

	// Two exact matches for the same normalized name, even across workspaces, is
	// exactly the ambiguity #445's "Sam" example warns about — leave it for a human.
	const uniqueUrls = new Set(exact.map((c) => c.url));
	if (uniqueUrls.size > 1) {
		return { outcome: "ambiguous", candidates: exact };
	}

	const winner = exact[0];
	if (dryRun) return { outcome: "populated", candidate: winner };

	const { error } = await supabase
		.from("entities")
		.update({ source_url: winner.url })
		.eq("id", row.id);
	if (error) {
		// 23505 = unique_violation: entities_user_source_url_unique already claims this
		// URL for a different entity in this user's graph — never guess which one is right.
		if ((error as { code?: string }).code === "23505") return { outcome: "conflict", candidate: winner };
		throw new Error(`populate-source-url write failed for ${row.id}: ${error.message}`);
	}
	return { outcome: "populated", candidate: winner };
}

/**
 * Populate entities.source_url for `people` rows where it's NULL, batched and
 * resumable (#445). Safe to call repeatedly: only ever touches
 * `source_url IS NULL` rows, and a row left NULL because it was ambiguous or
 * low-confidence is re-scanned on every future call (there is no separate
 * "seen and skipped" marker) — this is deliberate, since a new Notion page
 * could later resolve today's ambiguity.
 */
export async function runPopulateSourceUrl(
	options: PopulateSourceUrlOptions = {},
): Promise<PopulateSourceUrlResult> {
	const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
	const maxBatches = options.maxBatches;
	const dryRun = options.dryRun ?? false;
	const requestedDomains = options.domains ?? [...DOMAINS];

	const tokens = await availableDomains(requestedDomains);
	if (tokens.length === 0) {
		return {
			scanned: 0,
			populated: 0,
			skippedNoCandidate: 0,
			skippedAmbiguous: 0,
			skippedLowConfidence: 0,
			skippedConflict: 0,
			failed: 0,
			remaining: await countRemaining(),
			review: [],
		};
	}

	let scanned = 0;
	let populated = 0;
	let skippedNoCandidate = 0;
	let skippedAmbiguous = 0;
	let skippedLowConfidence = 0;
	let skippedConflict = 0;
	let failed = 0;
	const review: SourceUrlReviewItem[] = [];
	let cursor: string | null = null;
	let batches = 0;

	while (maxBatches === undefined || batches < maxBatches) {
		const rows = await fetchBatch(batchSize, cursor);
		if (rows.length === 0) break;
		batches += 1;

		for (const row of rows) {
			scanned += 1;
			try {
				const result = await resolveRow(row, tokens, dryRun);
				switch (result.outcome) {
					case "populated":
						populated += 1;
						break;
					case "conflict":
						skippedConflict += 1;
						review.push({
							entityId: row.id,
							entityName: row.title ?? "(unnamed)",
							reason: "ambiguous",
							candidates: [result.candidate],
						});
						break;
					case "no-candidate":
						skippedNoCandidate += 1;
						break;
					case "ambiguous":
						skippedAmbiguous += 1;
						review.push({
							entityId: row.id,
							entityName: row.title ?? "(unnamed)",
							reason: "ambiguous",
							candidates: result.candidates,
						});
						break;
					case "low-confidence":
						skippedLowConfidence += 1;
						review.push({
							entityId: row.id,
							entityName: row.title ?? "(unnamed)",
							reason: "low-confidence",
							candidates: result.candidates,
						});
						break;
				}
			} catch (err) {
				failed += 1;
				console.error(`[populate-source-url] ${row.id}: ${errMessage(err)}`);
			}
		}

		cursor = rows[rows.length - 1].id;
		const wasLastBatch = rows.length < batchSize;
		if (wasLastBatch) break;
		if (maxBatches !== undefined && batches >= maxBatches) break;
		if (!dryRun) await sleep(INTER_BATCH_DELAY_MS);
	}

	const remaining = await countRemaining();
	return {
		scanned,
		populated,
		skippedNoCandidate,
		skippedAmbiguous,
		skippedLowConfidence,
		skippedConflict,
		failed,
		remaining,
		review,
	};
}
