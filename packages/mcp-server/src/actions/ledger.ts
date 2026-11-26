import type { SupabaseClient } from "@supabase/supabase-js";
import {
	setDefaultAuditSink,
	stderrAuditSink,
	type ActionAuditRecord,
	type ActionAuditSink,
} from "@ahkms/core";
import { createSupabaseActionLedgerSink } from "@ahkms/core/adapters";
import { Sentry } from "../instrument.js";
import { supabase } from "../supabase.js";

export interface LedgerHealth {
	installed: boolean;
	failuresSinceBoot: number;
	lastFailureAt: string | null;
	lastFailureMessage: string | null;
	sentry: "on" | "off";
}

let installed = false;
let failuresSinceBoot = 0;
let lastFailureAt: string | null = null;
let lastFailureMessage: string | null = null;

/**
 * Returns the in-process health snapshot for the action ledger audit sink.
 */
export function ledgerHealth(): LedgerHealth {
	return {
		installed,
		failuresSinceBoot,
		lastFailureAt,
		lastFailureMessage,
		sentry: Sentry.isInitialized() ? "on" : "off",
	};
}

/**
 * Installs the default action audit sink writing to stderr and `action_ledger`,
 * resetting in-process failure counters and returning the installed sink.
 */
export function configureLedger(
	client: Pick<SupabaseClient, "from"> = supabase,
): ActionAuditSink {
	installed = true;
	failuresSinceBoot = 0;
	lastFailureAt = null;
	lastFailureMessage = null;

	const supabaseSink = createSupabaseActionLedgerSink(client);

	const sink: ActionAuditSink = async (record: ActionAuditRecord) => {
		stderrAuditSink(record);
		try {
			await supabaseSink(record);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			failuresSinceBoot += 1;
			lastFailureAt = new Date().toISOString();
			lastFailureMessage = message;

			Sentry.captureException(err, {
				tags: {
					requestId: record.requestId,
					actionId: record.actionId,
				},
				fingerprint: ["action_ledger_sink_failure"],
			});

			console.error(
				`[audit:ledger] actionId=${record.actionId} requestId=${record.requestId} ${message}`,
			);
			throw err;
		}
	};

	setDefaultAuditSink(sink);
	return sink;
}
