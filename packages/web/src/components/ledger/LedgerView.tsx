import { useCallback, useEffect, useState } from "react";
import {
  ACTION_AUDIT_OUTCOMES,
  queryLedgerRows,
  queryLedgerSummary,
  queryLedgerTrace,
  shortenHash,
  summarizeOutcomes,
  type ActionAuditOutcome,
  type ActionLedgerRow,
  type ActionLedgerSummary,
  type LedgerFilterState,
} from "../../lib/ledgerActions.js";
import { TraceView } from "./TraceView.js";

export interface LedgerViewProps {
  initialRows?: ActionLedgerRow[];
  initialSummary?: ActionLedgerSummary | null;
  initialFilters?: LedgerFilterState;
  initialTraceId?: string | null;
  initialTraceRows?: ActionLedgerRow[];
}

export function LedgerView({
  initialRows = [],
  initialSummary = null,
  initialFilters = {},
  initialTraceId = null,
  initialTraceRows,
}: LedgerViewProps = {}) {
  const [rows, setRows] = useState<ActionLedgerRow[]>(initialRows);
  const [summary, setSummary] = useState<ActionLedgerSummary | null>(initialSummary);
  const [filters, setFilters] = useState<LedgerFilterState>(initialFilters);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(initialTraceId);
  const [traceRows, setTraceRows] = useState<ActionLedgerRow[] | undefined>(initialTraceRows);
  const [error, setError] = useState<string | null>(null);

  const loadRows = useCallback(async (nextFilters: LedgerFilterState) => {
    try {
      setError(null);
      const fetched = await queryLedgerRows(nextFilters);
      setRows(fetched);
      return fetched;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    }
  }, []);

  useEffect(() => {
    if (initialRows.length === 0) void loadRows(filters);
    if (!initialSummary) void queryLedgerSummary(filters).then(setSummary).catch(() => undefined);
  }, []);

  const updateFilter = useCallback(
    async (patch: Partial<LedgerFilterState>) => {
      const next = { ...filters, ...patch };
      setFilters(next);
      await loadRows(next);
    },
    [filters, loadRows],
  );

  const handleSelectTrace = useCallback(async (traceId: string) => {
    setSelectedTraceId(traceId);
    try {
      setTraceRows(await queryLedgerTrace(traceId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const outcomeCounts = summarizeOutcomes(rows, summary);
  const inputCls = "px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded text-slate-200 font-mono";

  return (
    <div data-testid="ledger-view" className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight">Action Ledger</h2>
        <p className="text-xs text-slate-400 mt-0.5">Append-only audit trail via ledger_query (keys &amp; SHA-256 hashes only)</p>
      </div>
      <div data-testid="ledger-summary-strip" className="p-3 bg-slate-900 border border-slate-800 rounded-xl flex flex-wrap items-center gap-4 text-xs font-mono text-slate-300">
        {ACTION_AUDIT_OUTCOMES.map((o) => (
          <span key={o} data-testid={`summary-outcome-${o}`}>{o}: {outcomeCounts[o]}</span>
        ))}
        <span data-testid="summary-row-estimate">rows: {summary?.row_estimate ?? rows.length}</span>
        <span data-testid="summary-total-bytes">bytes: {summary?.total_bytes ?? 0}</span>
      </div>
      <div data-testid="ledger-filters" className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
        <input type="text" placeholder="Since (ISO)" value={filters.since ?? ""} onChange={(e) => void updateFilter({ since: e.target.value || undefined })} className={inputCls} />
        <input type="text" placeholder="Action ID" value={filters.action_id ?? ""} onChange={(e) => void updateFilter({ action_id: e.target.value || undefined })} className={inputCls} />
        <input type="text" placeholder="Caller (mcp, ui...)" value={filters.caller ?? ""} onChange={(e) => void updateFilter({ caller: e.target.value || undefined })} className={inputCls} />
        <select aria-label="Outcome filter" value={filters.outcome ?? ""} onChange={(e) => void updateFilter({ outcome: (e.target.value || undefined) as ActionAuditOutcome | undefined })} className={inputCls}>
          <option value="">All outcomes</option>
          {ACTION_AUDIT_OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <input type="text" placeholder="Client ID" value={filters.client_id ?? ""} onChange={(e) => void updateFilter({ client_id: e.target.value || undefined })} className={inputCls} />
      </div>
      {error && <div role="alert" className="p-3 bg-rose-950/60 border border-rose-800 rounded-lg text-xs text-rose-200">{error}</div>}
      {selectedTraceId && (
        <TraceView traceId={selectedTraceId} rows={traceRows} onClose={() => { setSelectedTraceId(null); setTraceRows(undefined); }} />
      )}
      <div className="space-y-2">
        {rows.map((row) => (
          <div
            key={row.id}
            data-testid={`ledger-row-${row.id}`}
            onClick={() => row.trace_id && void handleSelectTrace(row.trace_id)}
            className={`p-3 bg-slate-900 border border-slate-800 rounded-xl text-xs font-mono flex flex-wrap items-center justify-between gap-2 text-slate-300 ${row.trace_id ? "cursor-pointer hover:border-indigo-500/60" : ""}`}
          >
            <div className="flex flex-wrap items-center gap-3">
              <span className="px-2 py-0.5 bg-slate-800 text-white rounded font-semibold">{row.action_id}</span>
              <span>caller: {row.caller}</span>
              <span>outcome: {row.outcome}</span>
              <span>{row.duration_ms}ms</span>
              <span>client: {row.client_name ?? row.client_id ?? "none"}</span>
              <span>keys: [{(row.input_keys ?? []).join(", ")}]</span>
              <span>sha256: {shortenHash(row.input_sha256)}</span>
            </div>
            <div className="flex items-center gap-3 text-slate-400">
              {row.trace_id && <span className="text-indigo-400 underline">trace: {shortenHash(row.trace_id, 8)}</span>}
              <span>{row.created_at}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
