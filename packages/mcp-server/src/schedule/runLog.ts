import { supabase } from "../supabase.js";
import type { Cadence } from "./lock.js";

// Persists one row per scheduled run to scheduler_runs (ADR-016 Slice 3, #53), so
// cadence health (counts, failures, backlog) is queryable rather than only living
// in Railway log lines.
export async function recordRun(args: {
	cadence: Cadence;
	connector?: string;
	startedAt: Date;
	counts: Record<string, unknown>;
	error?: string;
}): Promise<void> {
	const { error: insertError } = await supabase.from("scheduler_runs").insert({
		cadence: args.cadence,
		connector: args.connector ?? null,
		status: args.error ? "error" : "ok",
		counts: args.counts,
		error_message: args.error ?? null,
		started_at: args.startedAt.toISOString(),
		finished_at: new Date().toISOString(),
	});
	// A logging failure should never take down the cadence itself — surface it to
	// stderr and move on.
	if (insertError) {
		console.error(`scheduler_runs insert failed (${args.cadence}):`, insertError.message);
	}
}
