/**
 * @ahkms/core/adapters - Supabase Scheduler Persistence Adapter
 *
 * Implements SchedulerLockPort and SchedulerRunLogPort against Supabase REST client
 * (ADR-016 Slice 3, ADR-101 #1321).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Cadence, SchedulerLockPort } from "../../engine/lock.js";
import type { SchedulerRunEntry, SchedulerRunLogPort } from "../../engine/runLog.js";

/**
 * Minimal duck-typed database client interface matching SupabaseClient.
 * Satisfied by both real SupabaseClient and mock test clients (#1319, #1340).
 */
export interface GenericSupabaseClient {
	from(table: string): {
		update(values: Record<string, unknown>, options?: { count?: string }): any;
		insert(values: Record<string, unknown> | Array<Record<string, unknown>>): any;
	};
}

export type SchedulerSupabaseClient = GenericSupabaseClient | Pick<SupabaseClient, "from">;

export function createSupabaseSchedulerLockPort(
	supabase: SchedulerSupabaseClient,
): SchedulerLockPort {
	return {
		async tryAcquire(cadence: Cadence, staleCutoff: string, lockedAt: string): Promise<boolean> {
			// Acquisition MUST be judged by the affected-row COUNT, never by a returned
			// representation (#516). Using count: "exact" without .select() prevents
			// PostgREST 42703 errors and ensures sound mutual exclusion across processes.
			const { count, error } = await supabase
				.from("scheduler_locks")
				.update({ locked_at: lockedAt }, { count: "exact" })
				.eq("cadence", cadence)
				.or(`locked_at.is.null,locked_at.lt.${staleCutoff}`);

			if (error) {
				throw new Error(`scheduler lock acquire failed (${cadence}): ${error.message}`);
			}
			return (count ?? 0) > 0;
		},

		async release(cadence: Cadence): Promise<void> {
			const { error } = await supabase
				.from("scheduler_locks")
				.update({ locked_at: null })
				.eq("cadence", cadence);

			if (error) {
				throw new Error(`scheduler lock release failed (${cadence}): ${error.message}`);
			}
		},
	};
}

export function createSupabaseSchedulerRunLogPort(
	supabase: SchedulerSupabaseClient,
): SchedulerRunLogPort {
	return {
		async record(entry: SchedulerRunEntry): Promise<void> {
			const { error: insertError } = await supabase.from("scheduler_runs").insert({
				cadence: entry.cadence,
				connector: entry.connector ?? null,
				status: entry.error ? "error" : "ok",
				counts: entry.counts,
				error_message: entry.error ?? null,
				started_at: entry.startedAt.toISOString(),
				finished_at: new Date().toISOString(),
			});

			if (insertError) {
				console.error(
					`scheduler_runs insert failed (${entry.cadence}):`,
					insertError.message,
				);
			}
		},
	};
}
