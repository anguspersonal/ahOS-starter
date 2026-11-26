import {
  ACTION_AUDIT_OUTCOMES,
  ledgerQuerySchema,
  type ActionAuditOutcome,
  type LedgerQueryInput,
  type LedgerQueryOutput,
} from "@ahkms/core/actions";
import type { z } from "zod";
import { executeActionClient, type ClientActionDefinition } from "./actionClient.js";

export { ACTION_AUDIT_OUTCOMES, ledgerQuerySchema };
export type { ActionAuditOutcome, LedgerQueryInput, LedgerQueryOutput };

export type ActionLedgerRow = Extract<LedgerQueryOutput, { mode: "rows" }>["rows"][number];
export type ActionLedgerSummary = Omit<Extract<LedgerQueryOutput, { mode: "summary" }>, "mode">;
export type LedgerQueryClientInput = z.input<typeof ledgerQuerySchema>;

export interface LedgerFilterState {
  since?: string;
  until?: string;
  action_id?: string;
  caller?: string;
  outcome?: ActionAuditOutcome;
  client_id?: string;
  trace_id?: string;
  limit?: number;
}

export const ledgerQueryActionClient: ClientActionDefinition<LedgerQueryClientInput, LedgerQueryOutput> = {
  id: "ledger_query",
  name: "ledger_query",
  description: "Query the append-only action_ledger by time window, action_id, caller, client_id, trace_id, or outcome.",
  schema: ledgerQuerySchema as unknown as z.ZodType<LedgerQueryClientInput>,
};

function stripEmptyFilters(filters: LedgerFilterState): LedgerQueryClientInput {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== "") cleaned[k] = v;
  }
  return cleaned as LedgerQueryClientInput;
}

export function shortenHash(hash: string | null | undefined, length = 12): string {
  return hash ? hash.slice(0, length) : "—";
}

export function summarizeOutcomes(
  rows: ActionLedgerRow[],
  summary?: ActionLedgerSummary | null,
): Record<ActionAuditOutcome, number> {
  const counts: Record<ActionAuditOutcome, number> = {
    success: 0,
    error: 0,
    validation_error: 0,
    denied: 0,
    pending_approval: 0,
  };
  if (summary?.by_action?.length) {
    for (const b of summary.by_action) {
      if (b.outcome in counts) counts[b.outcome] += b.count;
    }
    return counts;
  }
  for (const r of rows) {
    if (r.outcome in counts) counts[r.outcome] += 1;
  }
  return counts;
}

export async function queryLedgerRows(filters: LedgerFilterState = {}): Promise<ActionLedgerRow[]> {
  const res = await executeActionClient(ledgerQueryActionClient, { ...stripEmptyFilters(filters), mode: "rows" }, "ui");
  return "rows" in res && Array.isArray(res.rows) ? res.rows : [];
}

export async function queryLedgerSummary(filters: Omit<LedgerFilterState, "limit"> = {}): Promise<ActionLedgerSummary> {
  const { limit: _limit, ...rest } = stripEmptyFilters(filters);
  const res = await executeActionClient(ledgerQueryActionClient, { ...rest, mode: "summary" }, "ui");
  return res.mode === "summary"
    ? { by_action: res.by_action ?? [], row_estimate: res.row_estimate ?? 0, total_bytes: res.total_bytes ?? 0 }
    : { by_action: [], row_estimate: 0, total_bytes: 0 };
}

export async function queryLedgerTrace(traceId: string, limit = 500): Promise<ActionLedgerRow[]> {
  return await queryLedgerRows({ trace_id: traceId, limit });
}
