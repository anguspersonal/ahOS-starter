/**
 * Exception-only alert evaluator (issue #573).
 *
 * ## The gap this closes
 *
 * ahOS had no outbound notification channel. Every surface was pull — the
 * ritual preamble, the State Doc, the planned #495 dashboard — so on 2026-08-04
 * the system ran degraded for a month (dead inbox pipe, stale State Doc,
 * embeddings down) and nothing said so, because every surface that could have
 * said so was downstream of the break.
 *
 * This cadence is the push half. It reads a small set of threshold conditions
 * and calls the existing `sendAlert` (`src/utils/alerts.ts`) when one is
 * **crossed**.
 *
 * ## What it is NOT
 *
 * - Not a digest. No daily/periodic summary email — that form was rejected in
 *   #493 Q3 because a message that repeats every day decays into wallpaper.
 * - Not a ritual runner. It prompts a human and never synthesises anything
 *   (ADR-050 §8: rituals are not autonomously schedulable; #568 is the
 *   scheduled-writer anti-pattern).
 * - Not a second notification channel. Email only, via what already exists.
 *
 * ## Write boundary (acceptance criterion, not a suggestion)
 *
 * The evaluator **reads and emails, nothing else**. Every Supabase access goes
 * through `readTable` / `writeTable`, which refuse any table outside the
 * allowlists below. `WRITABLE_TABLES` contains exactly one table — the
 * evaluator's own crossing state — so no synthesis path (`artifacts`,
 * `artifact_external_links`, `entities`, `user_tasks`, …) is reachable for
 * writing even by accident. Run history and the single-flight lock go through
 * the shared `runLog` / `lock` modules, exactly as the dedup sweep does.
 */

import { EVIDENCE_CLOSING_KINDS, SYNTHESIS_MARKER_KINDS } from '@ahkms/shared';
import { supabase } from '../utils/supabase';
import { logger } from '../utils/logger';
import { isAlertDeliveryConfigured, sendAlert } from '../utils/alerts';
import { withLock } from './lock';
import { recordRun } from './runLog';
import {
  ConditionState,
  RITUAL_SILENT_KEY,
  ResolvedAlertConfig,
  SOURCE_COVERAGE_KEY,
  daysBetween,
  decideAlert,
  resolveAlertConfig,
  sourceSilentKey,
  sweepMissedKey,
  sweepUnreadableKey,
} from './alertConditions';
import { getSweepOutcomes } from '../utils/sweepOutcome';

// ── Table access boundary ──────────────────────────────────────────────────

/** Tables the evaluator may SELECT from. */
export const READABLE_TABLES = [
  'user_preferences',
  'artifact_external_links',
  'artifacts',
  'alert_condition_state',
] as const;

/**
 * Tables the evaluator may write. Exactly one: its own crossing state. Nothing
 * on a synthesis path appears here, and `writeTable` throws for anything else.
 */
export const WRITABLE_TABLES = ['alert_condition_state'] as const;

export type ReadableTable = (typeof READABLE_TABLES)[number];
export type WritableTable = (typeof WRITABLE_TABLES)[number];

function readTable(table: ReadableTable) {
  if (!(READABLE_TABLES as readonly string[]).includes(table)) {
    throw new Error(`[AlertEvaluator] refusing to read non-allowlisted table: ${table}`);
  }
  return supabase.from(table);
}

function writeTable(table: WritableTable) {
  if (!(WRITABLE_TABLES as readonly string[]).includes(table)) {
    throw new Error(`[AlertEvaluator] refusing to write non-allowlisted table: ${table}`);
  }
  return supabase.from(table);
}

// ── Signals ────────────────────────────────────────────────────────────────

/**
 * Synthesis markers that count as "the ritual ran".
 *
 * This evaluator defined the set locally while the ADR-050 §6 rename was still
 * pending. #560 landed the rename and hoisted the vocabulary into
 * `@ahkms/shared`, so `links.ts`, `search.ts` and this file now read one list.
 * Re-exported rather than re-declared to keep this module's public surface (and
 * its tests' import path) unchanged.
 */
export { SYNTHESIS_MARKER_KINDS };

export interface AlertUser {
  userId: string;
  config: ResolvedAlertConfig;
}

/**
 * Users with an alert config. `user_preferences` is the ADR-030 home for
 * per-user config, and `notification_preferences` is the blob the existing
 * `update_user_preferences` tool already deep-merges — so thresholds and
 * enable/disable are editable at runtime with no deploy.
 */
export async function getAlertUsers(): Promise<AlertUser[]> {
  const { data, error } = await readTable('user_preferences').select(
    'user_id, notification_preferences',
  );

  if (error) {
    throw new Error(`Failed to read alert config from user_preferences: ${error.message}`);
  }

  const users: AlertUser[] = [];
  for (const row of (data || []) as Array<{
    user_id?: string | null;
    notification_preferences?: Record<string, unknown> | null;
  }>) {
    if (typeof row.user_id !== 'string' || !row.user_id) continue;
    const raw = row.notification_preferences?.exception_alerts;
    const config = resolveAlertConfig(raw);
    if (!config.enabled) continue;
    users.push({ userId: row.user_id, config });
  }
  return users;
}

/**
 * Days since the most recent synthesis marker for this user, or `null` when the
 * ritual has never run.
 *
 * `null` is deliberately NOT "infinitely silent": a system with no marker at
 * all is a fresh install, and telling a new owner their ritual has gone quiet
 * before they have ever run it is noise, not signal. Nothing to alert about
 * means nothing is sent (see `decideAlert`).
 */
export async function getDaysSinceRitual(userId: string, now: Date): Promise<number | null> {
  const { data, error } = await readTable('artifact_external_links')
    .select('created_at')
    .eq('user_id', userId)
    .in('kind', [...SYNTHESIS_MARKER_KINDS, ...EVIDENCE_CLOSING_KINDS])
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`Failed to read synthesis markers for ${userId}: ${error.message}`);
  }

  const newest = (data || [])[0] as { created_at?: string } | undefined;
  if (!newest?.created_at) return null;
  return daysBetween(new Date(newest.created_at), now);
}

export interface SourceSilence {
  surface: string;
  /** Days since this surface last produced an artifact; null = never seen. */
  daysSince: number | null;
}

export interface SourceSilenceResult {
  /**
   * The surfaces the discovery scan actually saw, each with the composite
   * `(captured_at DESC, id DESC)` cursor's exact `daysSince` for its newest
   * row in this scan (see the function docstring). When `discoveryTruncated`
   * is true, this is the newest-first slice the scan managed to cover before
   * `DISCOVERY_ROW_CAP` — trustworthy for every surface it contains, but a
   * surface whose most recent artifact falls outside that slice is silently
   * absent rather than reported (#786).
   */
  sources: SourceSilence[];
  /**
   * True when auto-discovery hit its hard row cap, so the scan stopped
   * before covering the full window — `sources` may be missing surfaces
   * that were silent even further back than the cap reached. Escalated to
   * its own alert condition regardless (see `coverageDegradedAlert`), since
   * a surface missing from `sources` this run looks identical to "healthy
   * and not reported" without that separate signal.
   */
  discoveryTruncated: boolean;
}

/** Rows fetched per discovery page. */
const DISCOVERY_PAGE_SIZE = 1000;
/** Hard ceiling on the discovery scan, across all pages. */
const DISCOVERY_ROW_CAP = 50_000;

type DiscoveryRow = { id?: string | null; surface?: string | null; captured_at?: string | null };

/**
 * Per-surface silence for the surfaces this user watches.
 *
 * An explicit `sources` list is authoritative — one `limit 1` probe per surface,
 * no caps, no holes. With an empty list the evaluator discovers which surfaces
 * are actually live by scanning the recent window and keeping those with at
 * least `min_observations` artifacts, so the condition is useful before the
 * owner has predicted which pipe will die.
 *
 * ## Why the discovery scan pages via a composite `(captured_at DESC, id
 * DESC)` keyset cursor (#573 review round 1 M2; #780; #785 review round 1
 * H1; #786)
 *
 * It used to be one `order('captured_at', desc).limit(5000)`, i.e. the 5000
 * NEWEST artifacts in the window. That biases exactly backwards: the more silent
 * a surface is, the further down the ordering its newest row sits, so the
 * surfaces most in need of watching are the first to fall off the end and never
 * get a condition at all. Paging through the whole window removes the bias.
 *
 * It was then hand-rolled as offset/`.range()` pagination ordered by
 * `captured_at` (plus an `id` tiebreaker for stability under ties), stopping
 * on `rows.length < DISCOVERY_PAGE_SIZE` — the same #401-class defect fixed
 * elsewhere in this package: a server that clamps every page below the
 * requested size makes every page look short, so that test stops after page
 * one and silently drops every artifact past it (#780).
 *
 * That was fixed by switching to the shared `keysetPaginate` helper's
 * single-column `id ASC` cursor, whose empty-page-only termination sidesteps
 * the #401-class defect. But `id` order is NOT a drop-in replacement for
 * `captured_at` order — a real behaviour change, not a no-op cleanup (#785
 * review round 1 H1). The `seen` aggregation folding every row regardless of
 * arrival order is only true for a **complete** walk. `DISCOVERY_ROW_CAP`
 * deliberately makes the walk incomplete sometimes, and on an incomplete walk
 * arrival order decides *which* rows get seen. Under `id ASC` — and
 * `artifacts.id` is a uuid, uncorrelated with time — a capped scan's retained
 * rows were an arbitrary slice with respect to time: a busy surface's true
 * most-recent row could fall outside that slice, understating how alive it
 * actually was and risking a **false `source_silent` alert on a live pipe**.
 * #785 closed that with a fail-safe: on truncation, discard `seen` entirely
 * and return `sources: []` rather than report from an untrustworthy slice.
 * Correct and safe, but it meant a genuinely truncated run's per-surface
 * condition went silent for that run instead — better than being wrong,
 * worse than being right, and tracked as this issue (#786) to do properly.
 *
 * The fix is this composite cursor: order by `captured_at DESC` first, `id
 * DESC` as the tiebreaker (uuids are not orderable by time, so ties need a
 * stable secondary key), and advance the cursor off the last row's
 * `(captured_at, id)` pair rather than just its `id`. A page's exhaustion
 * test is still "the page came back empty" — the #780 fix's termination
 * signal is completely independent of what the ordering is, so this keeps
 * it. `fetchPage` excludes everything at-or-after the cursor via
 * `.or('captured_at.lt.<c>,and(captured_at.eq.<c>,id.lt.<i>)')`, PostgREST's
 * standard keyset-pagination-with-tiebreaker pattern (`captured_at < c`, OR
 * `captured_at = c AND id < i` for the tie band) — the two-column analogue of
 * `keysetPaginate`'s single `.gt('id', afterId)`. That helper's contract is a
 * scalar `id` cursor (`getId: (row) => string`) shared by two other call
 * sites (`dedupSweep.ts`, `learning/analyze.ts`), so rather than generalise it
 * to a tuple cursor for one caller, this one call site hand-rolls its own
 * loop instead (the second option the issue offered).
 *
 * Under `captured_at DESC` order, a capped scan's retained rows are always
 * the newest ones — restoring the pre-#780 recency bias, but now reached via
 * a keyset cursor instead of the offset pagination that motivated #780 in the
 * first place. That makes a truncated scan trustworthy again for exactly the
 * surfaces it *did* see: the first sighting of a surface is necessarily its
 * newest row in this scan (defensively re-checked anyway, in case a future
 * caller relaxes the ordering), so `info.newest` stays exact for every
 * reported surface even when `DISCOVERY_ROW_CAP` cuts the walk short. The cap
 * still costs something — a surface whose most recent artifact sits deeper
 * than `DISCOVERY_ROW_CAP` rows into the window is entirely absent from
 * `sources`, not falsely silent — the same documented, known bias the
 * original `captured_at DESC` scan had, which is a fine trade: omission reads
 * as "not evaluated", never as a false alert. `discoveryTruncated` stays true
 * whenever the cap is hit so `coverageDegradedAlert` can still say the run
 * was incomplete, even though `sources` is no longer forced empty.
 *
 * Note there is no index on `artifacts.surface`, nor on the discovery scan's
 * own access path (`user_id = $1 AND captured_at >= $2 ORDER BY captured_at
 * DESC, id DESC`) — the table has `artifacts_pkey(id)`,
 * `idx_artifacts_user_id_uuid(user_id)`, `idx_artifacts_captured_at(captured_at)`,
 * and `idx_artifacts_user_created_at(user_id, created_at)` (that last one is
 * `created_at`, not `captured_at`), so the planner is expected to walk
 * `idx_artifacts_captured_at` and filter by `user_id`. No benchmark backs
 * that expectation, and no migration is proposed here. Flagged so the next
 * reader is not misled (L3); a `(user_id, captured_at, id)` index is worth
 * adding if this ever goes multi-tenant.
 */
export async function getSourceSilence(
  userId: string,
  config: ResolvedAlertConfig['sourceSilent'],
  now: Date,
): Promise<SourceSilenceResult> {
  if (config.sources.length > 0) {
    const sources: SourceSilence[] = [];
    for (const surface of config.sources) {
      const { data, error } = await readTable('artifacts')
        .select('captured_at')
        .eq('user_id', userId)
        .eq('surface', surface)
        .order('captured_at', { ascending: false })
        .limit(1);

      if (error) {
        throw new Error(`Failed to read artifacts for surface ${surface}: ${error.message}`);
      }
      const newest = (data || [])[0] as { captured_at?: string } | undefined;
      sources.push({
        surface,
        daysSince: newest?.captured_at ? daysBetween(new Date(newest.captured_at), now) : null,
      });
    }
    return { sources, discoveryTruncated: false };
  }

  const cutoff = new Date(now.getTime() - config.discovery_window_days * 24 * 60 * 60 * 1000);
  const seen = new Map<string, { newest: string; count: number }>();
  let scannedRows = 0;
  let discoveryTruncated = false;
  // The composite keyset cursor (#786) — `null` for the first page, then the
  // last row's `(captured_at, id)` pair. See the function docstring for why
  // this is a tuple rather than `keysetPaginate`'s scalar `id` cursor.
  let cursor: { capturedAt: string; id: string } | null = null;

  for (;;) {
    let query = readTable('artifacts')
      .select('id, surface, captured_at')
      .eq('user_id', userId)
      .gte('captured_at', cutoff.toISOString())
      .order('captured_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(DISCOVERY_PAGE_SIZE);
    if (cursor) {
      // `captured_at < cursor` OR (`captured_at = cursor` AND `id < cursor`)
      // — standard keyset-pagination-with-tiebreaker, matching the `DESC`
      // ordering above. Neither value can contain `,`/`(`/`)`/`"` (an ISO
      // timestamp and a uuid), so no PostgREST `.or()` structural escaping
      // is needed here (contrast the free-text search filters in
      // `web/utils/knowledge/api.ts`, #789).
      query = query.or(
        `captured_at.lt.${cursor.capturedAt},and(captured_at.eq.${cursor.capturedAt},id.lt.${cursor.id})`,
      );
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to discover active surfaces for ${userId}: ${error.message}`);
    }
    const rows = (data || []) as DiscoveryRow[];
    if (rows.length === 0) break;

    scannedRows += rows.length;
    for (const row of rows) {
      if (typeof row.surface !== 'string' || !row.surface || !row.captured_at) continue;
      const existing = seen.get(row.surface);
      if (!existing) {
        seen.set(row.surface, { newest: row.captured_at, count: 1 });
      } else {
        existing.count += 1;
        // Defensive only: `captured_at DESC` order guarantees a surface's
        // first sighting in this scan is already its newest row.
        if (row.captured_at > existing.newest) existing.newest = row.captured_at;
      }
    }

    const last = rows[rows.length - 1];
    if (typeof last.id !== 'string' || !last.id || typeof last.captured_at !== 'string' || !last.captured_at) {
      throw new Error(
        `AlertEvaluator.discoverSurfaces(${userId}): a returned row is missing id/captured_at — cannot page further`,
      );
    }

    if (scannedRows >= DISCOVERY_ROW_CAP) {
      discoveryTruncated = true;
      break;
    }

    cursor = { capturedAt: last.captured_at, id: last.id };
  }

  if (discoveryTruncated) {
    logger.warn(
      `[AlertEvaluator] discovery scan hit DISCOVERY_ROW_CAP=${DISCOVERY_ROW_CAP} for ${userId} ` +
        `after scanning ${scannedRows} rows — reporting the newest-first slice it saw for every ` +
        'surface that slice reached; a surface whose most recent artifact falls further back than ' +
        'the cap is silently absent from sources this run rather than reported.',
      { userId, scannedRows, discoveryRowCap: DISCOVERY_ROW_CAP },
    );
  }

  const sources: SourceSilence[] = [];
  for (const [surface, info] of seen.entries()) {
    if (info.count < config.min_observations) continue;
    sources.push({ surface, daysSince: daysBetween(new Date(info.newest), now) });
  }

  return { sources, discoveryTruncated };
}

// ── Durable crossing state ─────────────────────────────────────────────────

/**
 * Load every stored condition state for a user, keyed by `condition_key`.
 * A missing key means "armed" (see `decideAlert`) — no seeding required.
 */
export async function loadConditionStates(
  userId: string,
): Promise<Map<string, ConditionState>> {
  const { data, error } = await readTable('alert_condition_state')
    .select('condition_key, armed, last_value, last_fired_at, last_fired_value')
    .eq('user_id', userId);

  if (error) {
    throw new Error(`Failed to read alert_condition_state for ${userId}: ${error.message}`);
  }

  const out = new Map<string, ConditionState>();
  for (const row of (data || []) as Array<{
    condition_key?: string;
    armed?: boolean;
    last_value?: number | string | null;
    last_fired_at?: string | null;
    last_fired_value?: number | string | null;
  }>) {
    if (!row.condition_key) continue;
    out.set(row.condition_key, {
      armed: row.armed !== false,
      lastValue: row.last_value === null || row.last_value === undefined ? null : Number(row.last_value),
      lastFiredAt: row.last_fired_at ?? null,
      lastFiredValue:
        row.last_fired_value === null || row.last_fired_value === undefined
          ? null
          : Number(row.last_fired_value),
    });
  }
  return out;
}

/**
 * Persist a condition's state after an evaluation. Upserted on
 * `(user_id, condition_key)` so the row is created on first sight and the
 * armed flag survives restarts and redeploys — the whole point of not relying
 * on `alerts.ts`'s 10-minute in-memory window.
 */
export async function saveConditionState(args: {
  userId: string;
  conditionKey: string;
  armed: boolean;
  value: number | null;
  fired: boolean;
  now: Date;
  previous: ConditionState | null;
}): Promise<void> {
  const nowIso = args.now.toISOString();
  const { error } = await writeTable('alert_condition_state').upsert(
    {
      user_id: args.userId,
      condition_key: args.conditionKey,
      armed: args.armed,
      last_value: args.value,
      last_evaluated_at: nowIso,
      last_fired_at: args.fired ? nowIso : (args.previous?.lastFiredAt ?? null),
      last_fired_value: args.fired ? args.value : (args.previous?.lastFiredValue ?? null),
      updated_at: nowIso,
    },
    { onConflict: 'user_id,condition_key' },
  );

  if (error) {
    throw new Error(
      `Failed to persist alert_condition_state (${args.conditionKey}): ${error.message}`,
    );
  }
}

// ── Alert copy ─────────────────────────────────────────────────────────────

interface AlertCopy {
  subject: string;
  message: string;
  context: Record<string, unknown>;
}

export function ritualSilentAlert(days: number, threshold: number): AlertCopy {
  return {
    subject: `[ahOS] End-of-day ritual silent for ${days} days`,
    message:
      `No synthesis marker has been written for ${days} days (threshold: ${threshold}). ` +
      `Every ahOS surface that would normally surface this — the ritual preamble, the ` +
      `State Doc, the dashboard — is downstream of the ritual, so none of them can tell you.`,
    context: {
      errorType: 'ritual_silent',
      affectedService: 'ahOS end-of-day synthesis',
      userImpact:
        'Atoms are accumulating unconsumed; the State Doc is drifting from current truth.',
      suggestedAction:
        'Run the end-of-day ritual. This alert never runs or synthesises anything on your behalf ' +
        '(ADR-050 §8) — it only tells you the ritual has gone quiet. You will not get this message ' +
        'again until the condition clears and is crossed afresh.',
    },
  };
}

export function sourceSilentAlert(surface: string, days: number, threshold: number): AlertCopy {
  return {
    subject: `[ahOS] Ingestion source "${surface}" silent for ${days} days`,
    message:
      `The "${surface}" ingestion surface has produced no artifacts for ${days} days ` +
      `(threshold: ${threshold}). A pipe whose newest record is weeks old is a dead pipe, and ` +
      `synthesis reading it will look like it is working while reading nothing.`,
    context: {
      errorType: 'source_silent',
      affectedService: `ingestion surface: ${surface}`,
      userImpact: 'Captures from this surface are missing from search, synthesis, and the graph.',
      suggestedAction:
        'Check the connector/credential for this surface. You will not get this message again ' +
        'until the source produces something and then goes quiet again.',
    },
  };
}

/**
 * The `source_silent` watch is enabled but is measuring nothing (or measuring
 * an incomplete picture). Raised as a condition of its own so a watcher that
 * has gone blind cannot report a clean run — which is the exact failure class
 * #573 exists to close (#573 review round 1, M2 + M3).
 */
export function coverageDegradedAlert(reason: string): AlertCopy {
  return {
    subject: '[ahOS] Source-silence alerting is watching nothing',
    message:
      `The source_silent condition is enabled but has no usable surfaces to watch (${reason}). ` +
      `Until this is fixed, "no source_silent alert" means "nothing was measured", not "every pipe is healthy".`,
    context: {
      errorType: 'source_coverage_degraded',
      affectedService: 'ahOS exception-alert evaluator (source_silent)',
      userImpact:
        'A dead ingestion pipe would not raise an alert, because no surface is under observation.',
      suggestedAction:
        'Most likely cause: artifacts.surface is unstamped (see #570). Either fix the stamping, or set ' +
        'notification_preferences.exception_alerts.source_silent.sources to an explicit list of surfaces ' +
        'via update_user_preferences. This message will not repeat until coverage recovers and degrades again.',
    },
  };
}

/**
 * The nightly dos sweep left days with material unclosed (#2270). Same finding
 * as `ahos_doctor`'s `dos sweep closed` outcome check, pushed instead of pulled.
 */
export function sweepMissedAlert(
  domain: string,
  missed: Array<{ date: string; atoms: number }>,
): AlertCopy {
  const days = missed.map((d) => `${d.date} (${d.atoms} atoms)`).join(', ');
  return {
    subject: `[ahOS] dos sweep missed ${missed.length} day(s) in ${domain}`,
    message:
      `${missed.length} day(s) the nightly sweep has already had a run to close have material and ` +
      `neither a draft nor a confirmed Daily Log in ${domain}: ${days}. The sweep routine reports ` +
      `"succeeded" whenever its session finishes, so its run status will not have told you.`,
    context: {
      errorType: 'sweep_missed',
      affectedService: `ahOS nightly dos sweep (${domain})`,
      userImpact: 'These days have no Daily Log draft; after 7 days the sweep can no longer reach them.',
      suggestedAction:
        'Run ahos_doctor with families ["outcomes"] to see why, then an attended `sync catchup`. ' +
        'This alert never runs or synthesises anything on your behalf (ADR-050 §8). You will not get ' +
        'this message again until every missed day is closed and a new one is missed.',
    },
  };
}

/**
 * The read that says whether the sweep closed its days is failing (#2270). A
 * condition of its own, for the same reason as `coverageDegradedAlert`: while it
 * fails, "no sweep_missed alert" means "nothing was measured".
 */
export function sweepUnreadableAlert(domain: string, reason: string): AlertCopy {
  return {
    subject: `[ahOS] dos sweep coverage cannot be read in ${domain}`,
    message:
      `The coverage read the nightly sweep uses to decide which days to close is failing in ` +
      `${domain} (${reason}). While it fails the sweep cannot close anything, and this alert ` +
      `cannot tell whether days are being missed.`,
    context: {
      errorType: 'sweep_unreadable',
      affectedService: `ahOS nightly dos sweep (${domain})`,
      userImpact: 'The sweep writes no drafts while this read fails.',
      suggestedAction:
        'Run ahos_doctor with families ["outcomes"]. A statement timeout usually means a migration ' +
        'is unapplied (see the "migrations applied" check). This message will not repeat until the ' +
        'read recovers and fails again.',
    },
  };
}

/**
 * One email covering every condition that crossed on the same run.
 *
 * A correlated outage — one expired credential, one wedged ingestion worker, a
 * deploy into an already-degraded system — takes every surface quiet at once,
 * and they all cross the same shared threshold on the same tick. Sending one
 * message per condition would put 9 emails in the inbox in ~30 seconds, and a
 * channel that can do that is a channel that gets filtered into a folder — the
 * same decay #493 Q3 rejected, arriving by burst instead of by drip. So delivery
 * coalesces; the per-condition arm/disarm bookkeeping is untouched
 * (#573 review round 1, H3).
 */
export function coalescedAlert(parts: AlertCopy[]): AlertCopy {
  return {
    subject: `[ahOS] ${parts.length} exception alerts crossed together`,
    message:
      `${parts.length} conditions crossed their thresholds on the same evaluation, which usually means ` +
      `one shared cause rather than ${parts.length} separate ones:\n\n` +
      parts.map((part, i) => `${i + 1}. ${part.subject}\n   ${part.message}`).join('\n\n'),
    context: {
      errorType: 'exception_alerts_coalesced',
      affectedService: parts
        .map((part) => String(part.context.affectedService ?? 'unknown'))
        .join('; '),
      userImpact:
        'Several ahOS signals went quiet at once — look for a single shared cause before treating these separately.',
      suggestedAction:
        parts.map((part, i) => `${i + 1}. ${String(part.context.suggestedAction ?? '')}`).join('\n') +
        '\nEach condition re-arms independently; you will not get these again until each clears and is crossed afresh.',
    },
  };
}

// ── The cadence ────────────────────────────────────────────────────────────

export interface AlertEvaluationSummary {
  users: number;
  conditions: number;
  /** Conditions that crossed AND whose email was confirmed delivered. */
  fired: number;
  held: number;
  rearmed: number;
  /** Below threshold only because the threshold moved — stayed disarmed (M1). */
  suppressed: number;
  skipped: number;
  errors: number;
  /** Emails actually put on the wire (a run's crossings are coalesced — H3). */
  emails: number;
  /** Crossings whose email could NOT be delivered; left armed to retry (H1). */
  send_failures: number;
  /** Auto-discovery hit its hard row cap for at least one user. */
  discovery_truncated: boolean;
}

const DEFAULT_INTERVAL_MINUTES = 1440; // daily

export interface AlertEvaluationOptions {
  /** Injectable clock so tests can drive N consecutive days deterministically. */
  now?: Date;
}

interface Evaluation {
  key: string;
  value: number | null;
  threshold: number;
  copy: () => AlertCopy;
}

/**
 * One evaluation pass over every configured user. Never throws: a total failure
 * is recorded as an error run and swallowed, matching `runDedupSweep`.
 */
export async function runAlertEvaluation(
  options: AlertEvaluationOptions = {},
): Promise<AlertEvaluationSummary> {
  const startedAt = new Date();
  const now = options.now ?? startedAt;

  const summary: AlertEvaluationSummary = {
    users: 0,
    conditions: 0,
    fired: 0,
    held: 0,
    rearmed: 0,
    suppressed: 0,
    skipped: 0,
    errors: 0,
    emails: 0,
    send_failures: 0,
    discovery_truncated: false,
  };

  let deliveryFailureDetail: string | null = null;

  try {
    const users = await getAlertUsers();
    summary.users = users.length;

    for (const user of users) {
      try {
        const states = await loadConditionStates(user.userId);
        const evaluations: Evaluation[] = [];

        if (user.config.ritualSilent.enabled) {
          const days = await getDaysSinceRitual(user.userId, now);
          const threshold = user.config.ritualSilent.threshold_days;
          evaluations.push({
            key: RITUAL_SILENT_KEY,
            value: days,
            threshold,
            copy: () => ritualSilentAlert(days as number, threshold),
          });
        }

        if (user.config.sourceSilent.enabled) {
          const result = await getSourceSilence(user.userId, user.config.sourceSilent, now);
          if (result.discoveryTruncated) summary.discovery_truncated = true;
          const threshold = user.config.sourceSilent.threshold_days;
          for (const source of result.sources) {
            evaluations.push({
              key: sourceSilentKey(source.surface),
              value: source.daysSince,
              threshold,
              copy: () => sourceSilentAlert(source.surface, source.daysSince as number, threshold),
            });
          }

          // Is the watch actually watching anything? A `source_silent` condition
          // that measures zero surfaces reports a clean run forever — which is
          // the 2026-08-04 shape, not the absence of it. `artifacts.surface` is
          // optional and largely unstamped (#570), so this is the likely state
          // today, not a tail case. Ride the same crossing machinery so it
          // emails once and re-arms when coverage recovers (M2 + M3).
          const measurable = result.sources.filter((s) => s.daysSince !== null).length;
          const degradedReason = result.discoveryTruncated
            ? `the discovery scan hit its ${DISCOVERY_ROW_CAP}-row cap`
            : measurable === 0
              ? 'no surface produced a measurable signal — artifacts.surface is probably unstamped'
              : null;
          evaluations.push({
            key: SOURCE_COVERAGE_KEY,
            value: degradedReason ? 1 : 0,
            threshold: 1,
            copy: () => coverageDegradedAlert(degradedReason ?? 'unknown'),
          });
        }

        // Did the nightly sweep close its days? (#2270) Not separately
        // configurable: it rides the master switch, because a routine that
        // silently writes nothing is the failure this whole evaluator exists
        // to catch. Reads go through `readTable`, so the allowlist still holds.
        const sweepOutcomes = await getSweepOutcomes(user.userId, now, {
          from: (table: string) => readTable(table as ReadableTable),
        });
        for (const outcome of sweepOutcomes) {
          const missed = outcome.missed;
          evaluations.push({
            key: sweepMissedKey(outcome.domain),
            // An unreadable window is unmeasured, not clean: null never fires
            // and never re-arms, and `sweep_unreadable` reports it instead.
            value: missed === null ? null : missed.length,
            threshold: 1,
            copy: () => sweepMissedAlert(outcome.domain, missed ?? []),
          });
          evaluations.push({
            key: sweepUnreadableKey(outcome.domain),
            value: outcome.error ? 1 : 0,
            threshold: 1,
            copy: () => sweepUnreadableAlert(outcome.domain, outcome.error ?? 'unknown'),
          });
        }

        // ── Phase 1: decide every condition (pure, no I/O) ──────────────────
        const decisions = evaluations.map((evaluation) => ({
          evaluation,
          previous: states.get(evaluation.key) ?? null,
          decision: decideAlert(
            evaluation.value,
            evaluation.threshold,
            states.get(evaluation.key) ?? null,
          ),
        }));

        for (const { evaluation, decision } of decisions) {
          summary.conditions += 1;
          if (evaluation.value === null) summary.skipped += 1;
          else if (decision.outcome === 'held') summary.held += 1;
          else if (decision.outcome === 'rearm') summary.rearmed += 1;
          else if (decision.outcome === 'suppressed') summary.suppressed += 1;
        }

        // ── Phase 2: one email for the whole run's crossings (H3) ───────────
        const crossings = decisions.filter((d) => d.decision.shouldSend);
        let delivered = false;
        let deliveryDetail: string | undefined;

        if (crossings.length > 0) {
          const parts = crossings.map((d) => d.evaluation.copy());
          const copy = parts.length === 1 ? parts[0] : coalescedAlert(parts);
          // The only outbound side effect in this module.
          const result = await sendAlert('warning', copy.subject, copy.message, copy.context);
          delivered = result.delivered;
          deliveryDetail = result.detail ?? result.reason;
          if (delivered) {
            summary.emails += 1;
          } else {
            summary.send_failures += crossings.length;
            // LOUD. A crossing we could not deliver is the one alert that
            // matters most, and `ritual_silent` only re-arms when the ritual
            // runs — the very thing the email exists to prompt. Leaving it armed
            // (below) makes the next run retry; saying so makes it findable.
            logger.error('[AlertEvaluator] ALERT NOT DELIVERED — leaving conditions armed to retry', {
              userId: user.userId,
              conditions: crossings.map((d) => d.evaluation.key),
              reason: result.reason,
              detail: result.detail,
            });
          }
        }

        // ── Phase 3: persist, disarming ONLY on a confirmed send (H1) ───────
        for (const { evaluation, previous, decision } of decisions) {
          const wasCrossing = decision.shouldSend;
          // An undelivered crossing must not look like a fire: keep the previous
          // armed flag (armed, by definition — an unarmed condition cannot
          // cross) and leave last_fired_* alone, so the next run tries again.
          const confirmed = wasCrossing && delivered;
          if (confirmed) summary.fired += 1;

          await saveConditionState({
            userId: user.userId,
            conditionKey: evaluation.key,
            armed: wasCrossing && !delivered ? true : decision.nextArmed,
            value: evaluation.value,
            fired: confirmed,
            now,
            previous,
          });
        }

        // An undelivered crossing is a failed run, not a quiet one — so it lands
        // in `scheduler_runs.error` rather than only in a counts field.
        if (crossings.length > 0 && !delivered) {
          summary.errors += 1;
          deliveryFailureDetail = deliveryDetail ?? 'unknown';
        }
      } catch (err) {
        summary.errors += 1;
        logger.error('[AlertEvaluator] evaluation failed for user', {
          userId: user.userId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue with other users even if one fails.
      }
    }

    const runError =
      summary.send_failures > 0
        ? `${summary.send_failures} crossing(s) undelivered (${deliveryFailureDetail ?? 'unknown'}) — left armed to retry`
        : summary.errors > 0
          ? `${summary.errors} user(s) failed`
          : undefined;

    await recordRun({
      cadence: 'alerts',
      startedAt,
      counts: summary as unknown as Record<string, unknown>,
      error: runError,
    });
    logger.info('[AlertEvaluator] evaluation complete', summary);
    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[AlertEvaluator] evaluation failed', { error: message });
    await recordRun({ cadence: 'alerts', startedAt, counts: {}, error: message });
    return { ...summary, errors: summary.errors + 1 };
  }
}

/**
 * Read scheduler config at call time (not module load) so tests and deploys can
 * set env before starting. Off by default: unset or any value other than "true"
 * leaves the cadence disabled, so running the worker locally never starts
 * emailing on a timer.
 *
 * This env gate is the *deploy-level* switch (does this host run the cadence at
 * all). The *per-user* enable/disable and thresholds live in the DB per ADR-030
 * and are editable without a deploy.
 */
function readSchedulerEnv() {
  return {
    enabled: process.env.KMS_ALERT_EVALUATOR_ENABLED === 'true',
    intervalMinutes: Number(
      process.env.KMS_ALERT_EVALUATOR_INTERVAL_MINUTES ?? DEFAULT_INTERVAL_MINUTES,
    ),
  };
}

/**
 * Start the periodic alert evaluator on the worker host. No-op unless
 * KMS_ALERT_EVALUATOR_ENABLED=true. Runs once immediately so a deploy's effect
 * is visible without waiting a full interval, then on the configured cadence.
 * Each tick runs under the shared `scheduler_locks` single-flight guard, so two
 * worker replicas cannot both email for the same crossing.
 *
 * Returns the interval handle (or null when disabled) so a host can clear it.
 */
export function startAlertEvaluatorScheduler(): NodeJS.Timeout | null {
  const env = readSchedulerEnv();
  if (!env.enabled) {
    logger.info(
      "alert evaluator: KMS_ALERT_EVALUATOR_ENABLED is not 'true' — alerts cadence disabled",
    );
    return null;
  }

  // Fail loudly rather than discovering this one crossing at a time. The
  // cadence still starts: since round 1 an undelivered crossing stays armed and
  // is retried, so a host that is missing its key recovers on the next run
  // instead of losing the alert — but nobody should have to read a counts field
  // to find out. (#573 review round 1, H1.)
  if (!isAlertDeliveryConfigured()) {
    logger.error(
      'alert evaluator: KMS_ALERT_EVALUATOR_ENABLED=true but RESEND_API_KEY is not set — ' +
        'no alert can be delivered. Crossings will stay armed and retry every run until it is. ' +
        'Set RESEND_API_KEY (and ALERT_EMAIL / ALERT_FROM_EMAIL) on this host.',
    );
  }

  const intervalMs = env.intervalMinutes * 60 * 1000;
  const tick = () => {
    withLock('alerts', () => runAlertEvaluation()).catch((err) =>
      console.error('alert evaluator tick failed:', err),
    );
  };

  logger.info(`alert evaluator: enabled — running every ${env.intervalMinutes}m`);
  tick();
  return setInterval(tick, intervalMs);
}
