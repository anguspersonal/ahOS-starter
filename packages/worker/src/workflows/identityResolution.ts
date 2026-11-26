/**
 * Entity identity resolution — duplicate detection (issue #174).
 *
 * The producer half of the `merge_suggested` decision family. Mirrors the
 * `relationship_suggested` producer in `steps/organizeEntities.ts`
 * (`routeProposedRelationships`): candidate pairs of duplicate entities are
 * surfaced as `system_decisions` for user-confirmed merge, NOT auto-applied
 * (Angus, 2026-07-07). On approve, `handleMergeSuggestedFeedback` in `resume.ts`
 * repoints edges/links loser->winner and tombstones the loser.
 *
 * Detection is a pure, in-memory pass over a user's same-type entities. It uses
 * a purpose-built name similarity (token-subset + per-token fuzzy match) rather
 * than `helpers.calculateStringSimilarity` (longest-common-substring ratio):
 * LCS scores "Angus" vs "Angus Hally" at ~0.45 and "Briana" vs "Brianna" at
 * ~0.71 — both real duplicates the issue calls out but which LCS misses. The
 * token model catches a short name that is a subset/typo of a longer one.
 */

import supabase from '../utils/supabase';
import { logger } from '../utils/logger';

/** Minimal entity shape needed for duplicate detection. */
export interface MergeCandidateEntity {
  id: string;
  title: string | null;
  entity_type: string;
  created_at?: string | null;
  properties?: Record<string, unknown> | null;
  aliases?: string[] | null;
}

/** A detected duplicate pair, oriented winner (canonical) <- loser. */
export interface MergeCandidate {
  winnerId: string;
  loserId: string;
  winnerName: string;
  loserName: string;
  entityType: string;
  /** 0..1 similarity of the best-matching name/alias pair. */
  score: number;
  /** Why the pair matched: exact-name | name-subset | fuzzy-name. */
  reason: 'exact-name' | 'name-subset' | 'fuzzy-name';
}

export interface DetectMergeCandidatesOptions {
  /** Minimum similarity to surface a candidate (default 0.85). */
  threshold?: number;
}

const DEFAULT_THRESHOLD = 0.85;
/** Per-token fuzzy-match floor for the token-subset heuristic. */
const TOKEN_MATCH_THRESHOLD = 0.85;

/**
 * Entity types the dedup detection scans by default (#310). Extended beyond the
 * original `people`-only set to `project` and `organization`: the issue's motivating
 * bug was a duplicate *project* (`Work` / `Work AI`), which a people-only sweep
 * never surfaces. Detection is same-type-only (a person and a project are never paired),
 * so widening the set only adds within-type comparisons. Single-sourced here and consumed
 * by both `emitMergeSuggestions` and the scheduled `dedupSweep` so the two can't drift.
 * Other types (area/resource/event/concept/place/...) are deliberately left out: their
 * short, generic titles ("Business", "Health") would generate noisier false-positive
 * name-subset matches — add them only with evidence they're worth it.
 */
export const DEFAULT_DEDUP_ENTITY_TYPES = ['people', 'project', 'organization'] as const;

/**
 * Normalize a name for comparison: lowercase, strip diacritics and punctuation,
 * collapse whitespace. Returns '' for null/blank input.
 */
export function normalizeName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // punctuation -> space
    .replace(/\s+/g, ' ')
    .trim();
}

/** Classic Levenshtein edit distance. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Levenshtein-based similarity ratio in [0,1]. */
function ratio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Similarity between two names, already normalized.
 * - exact match -> 1.0
 * - every token of the shorter name fuzzy-matches a token of the longer
 *   (each >= TOKEN_MATCH_THRESHOLD) -> 0.9 (handles "Angus" ⊆ "Angus Hally"
 *   and "Brianna" ~⊆ "Briana Longe")
 * - otherwise the whole-string Levenshtein ratio
 */
export function nameSimilarity(a: string, b: string): { score: number; reason: MergeCandidate['reason'] } {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return { score: 0, reason: 'fuzzy-name' };
  if (na === nb) return { score: 1, reason: 'exact-name' };

  const ta = na.split(' ').filter(Boolean);
  const tb = nb.split(' ').filter(Boolean);
  const [shortTokens, longTokens] = ta.length <= tb.length ? [ta, tb] : [tb, ta];

  const everyTokenMatches = shortTokens.every((st) =>
    longTokens.some((lt) => st === lt || ratio(st, lt) >= TOKEN_MATCH_THRESHOLD),
  );
  if (everyTokenMatches) {
    return { score: 0.9, reason: 'name-subset' };
  }

  return { score: ratio(na, nb), reason: 'fuzzy-name' };
}

/** Collect a comparison entity's names: its title plus any aliases (column or properties.aliases). */
function namesOf(entity: MergeCandidateEntity): string[] {
  const names: string[] = [];
  if (entity.title) names.push(entity.title);
  const aliasSet = new Set<string>();
  if (Array.isArray(entity.aliases)) {
    for (const a of entity.aliases) if (typeof a === 'string' && a.trim()) aliasSet.add(a.trim());
  }
  const legacyAliases = entity.properties?.aliases;
  if (Array.isArray(legacyAliases)) {
    for (const a of legacyAliases) if (typeof a === 'string' && a.trim()) aliasSet.add(a.trim());
  }
  for (const a of aliasSet) {
    if (!names.includes(a)) {
      names.push(a);
    }
  }
  return names;
}

/** Token count of an entity's primary (normalized) title — used to pick the winner. */
function tokenCount(entity: MergeCandidateEntity): number {
  return normalizeName(entity.title).split(' ').filter(Boolean).length;
}

/**
 * Orient a matched pair: the "winner" is the more complete/canonical entity —
 * more name tokens, then longer name, then earlier `created_at`, then smaller
 * id (fully deterministic so re-runs surface the same orientation).
 */
function orient(a: MergeCandidateEntity, b: MergeCandidateEntity): { winner: MergeCandidateEntity; loser: MergeCandidateEntity } {
  const ta = tokenCount(a);
  const tb = tokenCount(b);
  if (ta !== tb) return ta > tb ? { winner: a, loser: b } : { winner: b, loser: a };

  const la = (a.title || '').length;
  const lb = (b.title || '').length;
  if (la !== lb) return la > lb ? { winner: a, loser: b } : { winner: b, loser: a };

  const ca = a.created_at || '';
  const cb = b.created_at || '';
  if (ca !== cb) return ca < cb ? { winner: a, loser: b } : { winner: b, loser: a };

  return a.id < b.id ? { winner: a, loser: b } : { winner: b, loser: a };
}

/**
 * Detect duplicate-entity candidates among a user's entities. Compares every
 * pair of the SAME `entity_type` (a person and a project are never merged),
 * scoring the best-matching name/alias combination. Pure and side-effect free.
 */
export function detectMergeCandidates(
  entities: MergeCandidateEntity[],
  options: DetectMergeCandidatesOptions = {},
): MergeCandidate[] {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const candidates: MergeCandidate[] = [];

  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i];
      const b = entities[j];
      if (a.id === b.id) continue;
      if (a.entity_type !== b.entity_type) continue;

      let best: { score: number; reason: MergeCandidate['reason'] } = { score: 0, reason: 'fuzzy-name' };
      for (const an of namesOf(a)) {
        for (const bn of namesOf(b)) {
          const sim = nameSimilarity(an, bn);
          if (sim.score > best.score) best = sim;
        }
      }

      if (best.score >= threshold) {
        const { winner, loser } = orient(a, b);
        candidates.push({
          winnerId: winner.id,
          loserId: loser.id,
          winnerName: winner.title || '',
          loserName: loser.title || '',
          entityType: a.entity_type,
          score: best.score,
          reason: best.reason,
        });
      }
    }
  }

  // Highest-confidence pairs first.
  candidates.sort((x, y) => y.score - x.score);
  return candidates;
}

/** Unordered pair key so (winner,loser) and (loser,winner) dedupe together. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

export interface EmitMergeSuggestionsResult {
  candidates: MergeCandidate[];
  created: number;
  skipped: number;
}

/**
 * Scan a user's entities for duplicates and emit a `merge_suggested` decision
 * for each new candidate pair. Idempotent: pairs that already have a
 * `merge_suggested` decision (in any state) are skipped, so repeated sweeps
 * never stack duplicate prompts for the same pair.
 *
 * Non-fatal by contract — the caller (e.g. a maintenance sweep) should treat a
 * throw as "no suggestions this run", never as a workflow failure.
 */
export async function emitMergeSuggestions(params: {
  userId: string;
  /** Entity types to scan; defaults to DEFAULT_DEDUP_ENTITY_TYPES (people + project + organization). */
  entityTypes?: string[];
  threshold?: number;
}): Promise<EmitMergeSuggestionsResult> {
  const { userId, entityTypes = [...DEFAULT_DEDUP_ENTITY_TYPES], threshold } = params;

  const { data: entities, error } = await supabase
    .from('entities')
    .select('id, title, entity_type, created_at, properties, aliases')
    .eq('user_id', userId)
    .eq('archived', false)
    .in('entity_type', entityTypes);

  if (error) {
    throw new Error(`Failed to load entities for dedup scan: ${error.message}`);
  }

  const candidates = detectMergeCandidates((entities || []) as MergeCandidateEntity[], { threshold });
  if (candidates.length === 0) {
    return { candidates, created: 0, skipped: 0 };
  }

  // Existing merge decisions -> skip already-surfaced pairs (idempotent sweep).
  const { data: existing } = await supabase
    .from('system_decisions')
    .select('decision_payload')
    .eq('user_id', userId)
    .eq('decision_type', 'merge_suggested');

  const seen = new Set<string>();
  for (const row of existing || []) {
    const payload = (row.decision_payload || {}) as Record<string, unknown>;
    const w = payload.winnerEntityId;
    const l = payload.loserEntityId;
    if (typeof w === 'string' && typeof l === 'string') seen.add(pairKey(w, l));
  }

  let created = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    if (seen.has(pairKey(candidate.winnerId, candidate.loserId))) {
      skipped++;
      continue;
    }

    const { error: insertError } = await supabase.from('system_decisions').insert({
      user_id: userId,
      decision_type: 'merge_suggested',
      stage: 'organize',
      title: 'Possible duplicate',
      description: `'${candidate.loserName}' looks like a duplicate of '${candidate.winnerName}'. Merge them into one ${candidate.entityType} record?`,
      confidence_score: Math.round(candidate.score * 100),
      blocking: false,
      user_visible: true,
      requires_user_action: true,
      status: 'pending',
      review_type: 'approval',
      target_entity_type: candidate.entityType,
      target_entity_id: candidate.winnerId,
      decision_payload: {
        winnerEntityId: candidate.winnerId,
        loserEntityId: candidate.loserId,
        winnerName: candidate.winnerName,
        loserName: candidate.loserName,
        entityType: candidate.entityType,
        score: candidate.score,
        reason: candidate.reason,
      },
    });

    if (insertError) {
      logger.error('[IdentityResolution] Failed to create merge_suggested decision', {
        error: insertError.message,
        winnerId: candidate.winnerId,
        loserId: candidate.loserId,
      });
      continue;
    }

    seen.add(pairKey(candidate.winnerId, candidate.loserId));
    created++;
  }

  logger.info('[IdentityResolution] Dedup scan complete', {
    userId,
    candidates: candidates.length,
    created,
    skipped,
  });

  return { candidates, created, skipped };
}
