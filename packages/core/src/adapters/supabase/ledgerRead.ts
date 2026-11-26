/**
 * Supabase LedgerReadPort adapter (ADR-104, ADR-105, #1476).
 *
 * Queries public.action_ledger for rows (enriched with client_name from
 * public.mcp_oauth_clients) or summary statistics (by_action counts plus
 * row_estimate and total_bytes from public.action_ledger_stats()).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionAuditOutcome } from "../../actions/types.js";
import type {
	ActionLedgerRow,
	ActionLedgerSummary,
	ActionLedgerSummaryBucket,
	LedgerQueryFilters,
	LedgerReadPort,
} from "../../ports/ledger.js";

export type LedgerReadSupabaseClient = Pick<SupabaseClient, "from"> &
	Partial<Pick<SupabaseClient, "rpc">>;

function formatLedgerError(error: { code?: string; message?: string }): Error {
	const code = error.code ? ` [${error.code}]` : "";
	return new Error(`action_ledger query failed${code}: ${error.message ?? "unknown error"}`);
}

function applyLedgerFilters(query: any, filters: Omit<LedgerQueryFilters, "limit">): any {
	let q = query;
	if (filters.action_id !== undefined) q = q.eq("action_id", filters.action_id);
	if (filters.caller !== undefined) q = q.eq("caller", filters.caller);
	if (filters.client_id !== undefined) q = q.eq("client_id", filters.client_id);
	if (filters.session_id !== undefined) q = q.eq("session_id", filters.session_id);
	if (filters.request_id !== undefined) q = q.eq("request_id", filters.request_id);
	if (filters.trace_id !== undefined) q = q.eq("trace_id", filters.trace_id);
	if (filters.parent_request_id !== undefined) q = q.eq("parent_request_id", filters.parent_request_id);
	if (filters.outcome !== undefined) q = q.eq("outcome", filters.outcome);
	if (filters.since !== undefined) q = q.gte("created_at", filters.since);
	if (filters.until !== undefined) q = q.lt("created_at", filters.until);
	return q;
}

function extractClientName(row: Record<string, unknown>): string | null {
	if (typeof row.client_name === "string" && row.client_name) {
		return row.client_name;
	}
	const clientObj = row.client;
	if (
		clientObj &&
		typeof clientObj === "object" &&
		typeof (clientObj as Record<string, unknown>).client_name === "string"
	) {
		return (clientObj as Record<string, unknown>).client_name as string;
	}
	return null;
}

export function createSupabaseLedgerReadAdapter(
	client: LedgerReadSupabaseClient,
): LedgerReadPort {
	return {
		async queryRows(filters: LedgerQueryFilters): Promise<ActionLedgerRow[]> {
			const limit = filters.limit ?? 100;
			let query = applyLedgerFilters(client.from("action_ledger").select("*"), filters);
			query = query.order("created_at", { ascending: false }).limit(limit);

			const { data, error } = await query;
			if (error) {
				throw formatLedgerError(error);
			}

			const rawRows = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
			const distinctClientIds = Array.from(
				new Set(
					rawRows
						.map((r) => r.client_id)
						.filter((id): id is string => typeof id === "string" && id.length > 0),
				),
			);

			const clientNames = new Map<string, string | null>();
			if (distinctClientIds.length > 0) {
				const { data: clientsData, error: clientsError } = await client
					.from("mcp_oauth_clients")
					.select("client_id, client")
					.in("client_id", distinctClientIds);

				if (clientsError) {
					throw formatLedgerError(clientsError);
				}

				for (const c of (Array.isArray(clientsData) ? clientsData : []) as Array<
					Record<string, unknown>
				>) {
					if (typeof c.client_id === "string") {
						clientNames.set(c.client_id, extractClientName(c));
					}
				}
			}

			return rawRows.map((row) => {
				const clientId = typeof row.client_id === "string" ? row.client_id : null;
				return {
					...(row as unknown as ActionLedgerRow),
					client_id: clientId,
					client_name: clientId ? (clientNames.get(clientId) ?? null) : null,
				};
			});
		},

		async querySummary(filters: Omit<LedgerQueryFilters, "limit">): Promise<ActionLedgerSummary> {
			const query = applyLedgerFilters(
				client.from("action_ledger").select("action_id, outcome"),
				filters,
			);
			const { data, error } = await query;
			if (error) {
				throw formatLedgerError(error);
			}

			const counts = new Map<string, ActionLedgerSummaryBucket>();
			for (const row of (Array.isArray(data) ? data : []) as Array<{
				action_id: string;
				outcome: ActionAuditOutcome;
			}>) {
				const key = `${row.action_id}\0${row.outcome}`;
				const existing = counts.get(key);
				if (existing) {
					existing.count += 1;
				} else {
					counts.set(key, {
						action_id: row.action_id,
						outcome: row.outcome,
						count: 1,
					});
				}
			}

			const by_action = Array.from(counts.values()).sort((a, b) =>
				a.action_id === b.action_id
					? a.outcome.localeCompare(b.outcome)
					: a.action_id.localeCompare(b.action_id),
			);

			let row_estimate = 0;
			let total_bytes = 0;

			if (typeof client.rpc === "function") {
				const { data: statsData, error: statsError } = await client.rpc("action_ledger_stats");
				if (statsError) {
					throw formatLedgerError(statsError);
				}
				const statsRow = Array.isArray(statsData) ? statsData[0] : statsData;
				if (statsRow && typeof statsRow === "object") {
					row_estimate = Number((statsRow as Record<string, unknown>).row_estimate ?? 0);
					total_bytes = Number((statsRow as Record<string, unknown>).total_bytes ?? 0);
				}
			}

			return {
				by_action,
				row_estimate,
				total_bytes,
			};
		},
	};
}
