import { supabase } from '../utils/supabase';

/**
 * Single-flight guard for the worker's scheduled cadences (issue #396). Mirrors
 * the mcp-server's row-based lock (packages/mcp-server/src/schedule/lock.ts,
 * ADR-016 Slice 3 #53): the worker talks to Postgres only via the Supabase REST
 * client (no held connection), so a session-scoped pg_advisory_lock isn't
 * reachable. One atomic UPDATE picks a single winner even across process/deploy
 * boundaries — without adding a new DB connection or dependency.
 *
 * A stale lock (holder crashed without releasing) expires after STALE_MS so a
 * wedged lock can't block the cadence forever.
 *
 * The lock rows live in scheduler_locks, shared with the mcp-server scheduler;
 * the 'dedup' row is seeded by migration 076, the 'alerts' row by migration
 * 084 (#573), and the 'learning' row by migration 103 (#948).
 */
const STALE_MS = 30 * 60 * 1000; // 30 minutes

export type Cadence = 'dedup' | 'alerts' | 'learning';

export async function tryAcquireLock(cadence: Cadence): Promise<boolean> {
  const staleCutoff = new Date(Date.now() - STALE_MS).toISOString();
  const { data, error } = await supabase
    .from('scheduler_locks')
    .update({ locked_at: new Date().toISOString() })
    .eq('cadence', cadence)
    .or(`locked_at.is.null,locked_at.lt.${staleCutoff}`)
    .select('cadence');

  if (error) throw new Error(`scheduler lock acquire failed (${cadence}): ${error.message}`);
  return (data?.length ?? 0) > 0;
}

export async function releaseLock(cadence: Cadence): Promise<void> {
  const { error } = await supabase
    .from('scheduler_locks')
    .update({ locked_at: null })
    .eq('cadence', cadence);
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
