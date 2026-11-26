import { useCallback, useEffect, useRef, useState } from "react";
import {
  listParkedCalls,
  noticeFromResolution,
  resolveParkedCall,
  type PendingApprovalInboxRow,
  type ResolveParkedCallOutcome,
} from "../../lib/approvalActions.js";

export type ApprovalNoticeInput =
  | string
  | ResolveParkedCallOutcome
  | { error?: string; message?: string };

export interface ApprovalsListProps {
  rows: PendingApprovalInboxRow[];
  busyId?: string | null;
  notices?: ReadonlyArray<ApprovalNoticeInput> | Record<string, string> | string;
  onResolve?: (kind: "approve" | "reject", decisionId: string) => void | Promise<void>;
}

function formatUtcDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso.slice(0, 10) : parsed.toISOString().slice(0, 10);
}

function normalizeNotices(notices: ApprovalsListProps["notices"]): string[] {
  if (!notices) return [];
  const items: ApprovalNoticeInput[] =
    typeof notices === "string"
      ? [notices]
      : Array.isArray(notices)
        ? notices
        : Object.values(notices);
  return items.flatMap((item) => {
    if (typeof item === "string") return item ? [item] : [];
    if (item && typeof item === "object") {
      if ("error" in item && typeof item.error === "string" && item.error) return [item.error];
      if ("message" in item && typeof item.message === "string" && item.message) return [item.message];
    }
    return [];
  });
}

function inputEntries(input: unknown): Array<[string, string]> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, JSON.stringify(v)]);
  }
  return [["value", JSON.stringify(input)]];
}

export function ApprovalsList({ rows, busyId = null, notices, onResolve }: ApprovalsListProps) {
  const renderedNotices = normalizeNotices(notices);
  return (
    <div className="space-y-4">
      {renderedNotices.length > 0 && (
        <div role="alert" className="space-y-2">
          {renderedNotices.map((msg, idx) => (
            <div key={`${idx}-${msg}`} className="p-3 bg-rose-950/60 border border-rose-800/80 rounded-lg text-xs text-rose-200">
              {msg}
            </div>
          ))}
        </div>
      )}
      {rows.length === 0 ? (
        <div className="p-8 text-center bg-slate-900/50 border border-slate-800/80 rounded-xl">
          <p className="text-sm text-slate-400">No agent calls are waiting for your approval.</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {rows.map((row) => {
            const isBusy = busyId === row.decision_id;
            return (
              <div key={row.decision_id} className="p-5 bg-slate-900 border border-slate-800 rounded-xl space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
                    <span className="px-2 py-0.5 bg-slate-800 text-slate-200 rounded font-semibold">
                      {row.action_id ?? "unknown_action"}
                    </span>
                    <span>caller: {row.caller ?? "unknown"}</span>
                    <span>client: {row.client_id ?? "none"}</span>
                    <span>expires: {formatUtcDate(row.expires_at)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void onResolve?.("approve", row.decision_id)}
                      className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-semibold rounded-lg"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void onResolve?.("reject", row.decision_id)}
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 text-xs font-medium rounded-lg"
                    >
                      Reject
                    </button>
                  </div>
                </div>
                <dl className="p-3 bg-slate-950/70 border border-slate-800/80 rounded-lg space-y-1 text-xs font-mono">
                  {inputEntries(row.input).map(([key, serialized]) => (
                    <div key={key} className="flex items-baseline gap-2 break-all">
                      <dt className="text-slate-400 shrink-0">{key}:</dt>
                      <dd className="text-slate-200">{serialized}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ApprovalsCanvas() {
  const [rows, setRows] = useState<PendingApprovalInboxRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const inFlightRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRows(await listParkedCalls());
    } catch (err) {
      setNotices((prev) => [...prev, err instanceof Error ? err.message : String(err)]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleResolve = useCallback(
    async (kind: "approve" | "reject", decisionId: string) => {
      if (inFlightRef.current) return;
      inFlightRef.current = decisionId;
      setBusyId(decisionId);
      try {
        const notice = noticeFromResolution(await resolveParkedCall(kind, decisionId));
        if (notice) setNotices((prev) => [...prev, notice]);
        await reload();
      } finally {
        inFlightRef.current = null;
        setBusyId(null);
      }
    },
    [reload],
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight">Approvals</h2>
        <p className="text-xs text-slate-400 mt-0.5">Outward agent calls parked for owner approval (ADR-104)</p>
      </div>
      <ApprovalsList rows={rows} busyId={busyId} notices={notices} onResolve={handleResolve} />
    </div>
  );
}
