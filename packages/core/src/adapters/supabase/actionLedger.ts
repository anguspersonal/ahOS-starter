/**
 * Supabase action_ledger audit sink (ADR-104 L1, L3, L5, L7-L9).
 *
 * Persists action audit records to the append-only public.action_ledger table.
 * A timed-out insert holds the call for at most timeoutMs (default 2000 ms) and
 * is uncoupled from execution completion.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionAuditRecord, ActionAuditSink } from "../../actions/types.js";

export interface SupabaseActionLedgerSinkOptions {
	timeoutMs?: number;
}

export interface SupabaseActionLedgerSink extends ActionAuditSink {
	(record: ActionAuditRecord): Promise<void>;
	record: (record: ActionAuditRecord) => Promise<void>;
}

export function createSupabaseActionLedgerSink(
	client: Pick<SupabaseClient, "from">,
	{ timeoutMs = 2000 }: SupabaseActionLedgerSinkOptions = {},
): SupabaseActionLedgerSink {
	const sink = async (record: ActionAuditRecord): Promise<void> => {
		const payload = {
			action_id: record.actionId,
			seam: record.seam,
			caller: record.caller,
			request_id: record.requestId,
			parent_request_id: record.parentRequestId ?? null,
			trace_id: record.traceId ?? null,
			user_id: record.userId ?? null,
			client_id: record.clientId ?? null,
			session_id: record.sessionId ?? null,
			outcome: record.outcome,
			duration_ms: Math.round(record.durationMs),
			error_message: record.errorMessage ?? null,
			input_keys: record.inputKeys,
			input_sha256: record.inputSha256 ?? null,
			decision_id: record.decisionId ?? null,
		};

		let timer: ReturnType<typeof setTimeout> | undefined;

		try {
			const insertPromise = client.from("action_ledger").insert(payload);

			const timeoutPromise = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					reject(new Error(`action_ledger insert timed out after ${timeoutMs} ms`));
				}, timeoutMs);
			});

			const { error } = (await Promise.race([insertPromise, timeoutPromise])) as any;
			if (error) {
				const code = error.code ? ` [${error.code}]` : "";
				throw new Error(`action_ledger insert failed${code}: ${error.message}`);
			}
		} finally {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		}
	};

	sink.record = sink;
	return sink as SupabaseActionLedgerSink;
}
