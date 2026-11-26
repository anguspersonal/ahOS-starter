/**
 * Periodic dedup sweep (issue #396, follow-up to #174 / PR #395).
 *
 * The production trigger for `emitMergeSuggestions`: on a fixed cadence it scans
 * every active user's entities and surfaces duplicate people as `merge_suggested`
 * decisions — no manual function call required. It follows the mcp-server's
 * scheduler pattern (ADR-016 Slice 3, #53): an env-gated interval on the always-on
 * worker host, single-flight via a scheduler_locks row, and per-run history in
 * scheduler_runs (see migration 076 for the 'dedup' cadence).
 *
 * emitMergeSuggestions is idempotent — pairs already surfaced are skipped — so
 * re-running the sweep never stacks duplicate prompts. Per-user failures are
 * isolated: one user throwing never aborts the sweep for the rest.
 */
import { supabase } from '../utils/supabase';
import { logger } from '../utils/logger';
import { DEFAULT_DEDUP_ENTITY_TYPES, emitMergeSuggestions } from '../workflows/identityResolution';
import { keysetPaginate, DEFAULT_KEYSET_PAGE_SIZE, DEFAULT_KEYSET_MAX_PAGES } from '../utils/keysetPaginate';
import { withLock } from './lock';
import { recordRun } from './runLog';

/**
 * Entity types swept by default. Shared with the detector's
 * `DEFAULT_DEDUP_ENTITY_TYPES` (#310) so the sweep and `emitMergeSuggestions`
 * can't drift apart — the `project` coverage here is what catches the
 * motivating Work/Work AI project duplicate, not just people.
 */
const DEFAULT_ENTITY_TYPES = [...DEFAULT_DEDUP_ENTITY_TYPES];
const DEFAULT_INTERVAL_MINUTES = 1440; // daily

/**
 * Requested page size for `getActiveUserIds`' enumeration scan (#401). See
 * `utils/keysetPaginate.ts` for why this is a request size, not a
 * guarantee, and why the scan's only exhaustion signal is an empty page.
 *
 * Exported so tests can exercise multi-page, exact-page-boundary, and
 * below-page-size-server-cap enumeration without needing thousands of
 * fixture rows.
 */
export const ACTIVE_USER_SCAN_PAGE_SIZE = DEFAULT_KEYSET_PAGE_SIZE;

/** Safety valve for `getActiveUserIds` — see `utils/keysetPaginate.ts`. */
const ACTIVE_USER_SCAN_MAX_PAGES = DEFAULT_KEYSET_MAX_PAGES;

export interface DedupSweepOptions {
  /** Entity types to scan; defaults to DEFAULT_DEDUP_ENTITY_TYPES (people + project + organization). */
  entityTypes?: string[];
  /** Minimum similarity to surface a candidate; passed through to detection. */
  threshold?: number;
}

export interface DedupSweepSummary {
  users: number;
  created: number;
  skipped: number;
  errors: number;
}

type ActiveEntityRow = { id?: string | null; user_id?: string | null };

/**
 * Distinct user_ids that own at least one non-archived entity of a swept type —
 * i.e. the users worth running a dedup scan for. Mirrors the active-user
 * enumeration in learning/analyze.ts (dedupe in memory rather than a DISTINCT).
 *
 * Pages through every matching row via `keysetPaginate` (#401, #778) rather
 * than a single `.select()` or offset/`.range()` — see that module's
 * docstring for why keyset-with-empty-page-termination is the only safe
 * shape for an enumeration that must never silently truncate.
 */
export async function getActiveUserIds(entityTypes: string[]): Promise<string[]> {
  const ids = new Set<string>();

  await keysetPaginate<ActiveEntityRow>({
    label: 'getActiveUserIds',
    pageSize: ACTIVE_USER_SCAN_PAGE_SIZE,
    maxPages: ACTIVE_USER_SCAN_MAX_PAGES,
    getId: (row) => row.id,
    fetchPage: async (afterId, pageSize) => {
      let query = supabase
        .from('entities')
        .select('id, user_id')
        .eq('archived', false)
        .in('entity_type', entityTypes)
        .order('id', { ascending: true })
        .limit(pageSize);
      if (afterId) query = query.gt('id', afterId);

      const { data, error } = await query;
      if (error) {
        throw new Error(`Failed to enumerate active users for dedup sweep: ${error.message}`);
      }
      return (data || []) as ActiveEntityRow[];
    },
    onPage: (rows) => {
      for (const row of rows) {
        if (typeof row.user_id === 'string' && row.user_id) ids.add(row.user_id);
      }
    },
  });

  return Array.from(ids);
}

/**
 * One dedup sweep: run emitMergeSuggestions for every active user and record the
 * outcome. The cadence body only — single-flight is applied by the scheduler
 * (via withLock), matching the mcp-server's runEnrichCadence/runDriveDiscoverCadence
 * shape. Never throws: a failure is recorded as an error run and swallowed.
 */
export async function runDedupSweep(options: DedupSweepOptions = {}): Promise<DedupSweepSummary> {
  const startedAt = new Date();
  const entityTypes = options.entityTypes ?? DEFAULT_ENTITY_TYPES;

  try {
    const userIds = await getActiveUserIds(entityTypes);

    let created = 0;
    let skipped = 0;
    let errors = 0;

    for (const userId of userIds) {
      try {
        const result = await emitMergeSuggestions({
          userId,
          entityTypes,
          threshold: options.threshold,
        });
        created += result.created;
        skipped += result.skipped;
      } catch (err) {
        errors++;
        logger.error('[DedupSweep] emitMergeSuggestions failed for user', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue with other users even if one fails.
      }
    }

    const summary: DedupSweepSummary = { users: userIds.length, created, skipped, errors };
    await recordRun({
      cadence: 'dedup',
      startedAt,
      counts: summary as unknown as Record<string, unknown>,
      error: errors > 0 ? `${errors} user(s) failed` : undefined,
    });
    logger.info('[DedupSweep] sweep complete', summary);
    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[DedupSweep] sweep failed', { error: message });
    await recordRun({ cadence: 'dedup', startedAt, counts: {}, error: message });
    return { users: 0, created: 0, skipped: 0, errors: 1 };
  }
}

/**
 * Read scheduler config at call time (not module load) so tests and deploys can
 * set env before starting. Off by default: unset or any value other than "true"
 * leaves the sweep disabled, so running the worker locally never starts scanning
 * production data on a timer.
 */
function readSchedulerEnv() {
  return {
    enabled: process.env.KMS_DEDUP_SWEEP_ENABLED === 'true',
    intervalMinutes: Number(process.env.KMS_DEDUP_SWEEP_INTERVAL_MINUTES ?? DEFAULT_INTERVAL_MINUTES),
  };
}

/**
 * Start the periodic dedup sweep on the worker host. No-op unless
 * KMS_DEDUP_SWEEP_ENABLED=true. Runs once immediately so a deploy's effect is
 * visible without waiting a full interval, then on the configured cadence. Each
 * tick runs under the shared scheduler_locks single-flight guard.
 *
 * Returns the interval handle (or null when disabled) so a host can clear it.
 */
export function startDedupSweepScheduler(): NodeJS.Timeout | null {
  const env = readSchedulerEnv();
  if (!env.enabled) {
    logger.info("dedup sweep: KMS_DEDUP_SWEEP_ENABLED is not 'true' — dedup cadence disabled");
    return null;
  }

  const intervalMs = env.intervalMinutes * 60 * 1000;
  const tick = () => {
    withLock('dedup', runDedupSweep).catch((err) =>
      console.error('dedup sweep tick failed:', err),
    );
  };

  logger.info(`dedup sweep: enabled — running every ${env.intervalMinutes}m`);
  tick();
  return setInterval(tick, intervalMs);
}
