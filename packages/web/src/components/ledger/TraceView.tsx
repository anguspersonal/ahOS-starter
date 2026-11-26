import { useEffect, useState } from "react";
import { queryLedgerTrace, shortenHash, type ActionLedgerRow } from "../../lib/ledgerActions.js";

export interface TraceTreeNode {
  row: ActionLedgerRow;
  depth: number;
  children: TraceTreeNode[];
}

export function buildTraceTree(rows: ActionLedgerRow[]): TraceTreeNode[] {
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const byRequestId = new Map<string, TraceTreeNode>();
  const nodes = sorted.map((row) => {
    const node: TraceTreeNode = { row, depth: 0, children: [] };
    if (row.request_id && !byRequestId.has(row.request_id)) byRequestId.set(row.request_id, node);
    return node;
  });
  const roots: TraceTreeNode[] = [];
  for (const node of nodes) {
    const pId = node.row.parent_request_id;
    const parent = pId && pId !== node.row.request_id ? byRequestId.get(pId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const setDepth = (list: TraceTreeNode[], depth: number) => {
    for (const item of list) {
      item.depth = depth;
      setDepth(item.children, depth + 1);
    }
  };
  setDepth(roots, 0);
  return roots;
}

export function flattenTraceTree(rows: ActionLedgerRow[]): Array<{ row: ActionLedgerRow; depth: number }> {
  const flat: Array<{ row: ActionLedgerRow; depth: number }> = [];
  const visit = (nodes: TraceTreeNode[]) => {
    for (const n of nodes) {
      flat.push({ row: n.row, depth: n.depth });
      visit(n.children);
    }
  };
  visit(buildTraceTree(rows));
  return flat;
}

export interface TraceViewProps {
  traceId: string;
  rows?: ActionLedgerRow[];
  onClose?: () => void;
}

export function TraceView({ traceId, rows: providedRows, onClose }: TraceViewProps) {
  const [fetchedRows, setFetchedRows] = useState<ActionLedgerRow[]>([]);
  const rows = providedRows ?? fetchedRows;

  useEffect(() => {
    if (providedRows !== undefined) return;
    let active = true;
    void queryLedgerTrace(traceId).then((res) => {
      if (active) setFetchedRows(res);
    });
    return () => {
      active = false;
    };
  }, [traceId, providedRows]);

  const ordered = flattenTraceTree(rows);
  return (
    <div data-testid="ledger-trace-view" className="p-4 bg-slate-900 border border-slate-800 rounded-xl space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-mono text-slate-300">
          Trace <span className="text-indigo-400 font-semibold">{traceId}</span> ({ordered.length} rows)
        </div>
        {onClose && (
          <button type="button" onClick={onClose} className="px-2 py-1 text-xs bg-slate-800 text-slate-300 rounded">
            Close trace
          </button>
        )}
      </div>
      <div className="space-y-1.5">
        {ordered.map(({ row, depth }) => (
          <div
            key={row.id}
            data-testid={`trace-node-${row.request_id}`}
            data-request-id={row.request_id}
            data-parent-request-id={row.parent_request_id ?? ""}
            data-depth={depth}
            style={{ paddingLeft: `${depth * 20}px` }}
            className="p-2 bg-slate-950/70 border border-slate-800/80 rounded text-xs font-mono flex flex-wrap items-center gap-3 text-slate-300"
          >
            <span className="font-semibold text-white">{row.action_id}</span>
            <span>caller:{row.caller}</span>
            <span>outcome:{row.outcome}</span>
            <span>{row.duration_ms}ms</span>
            <span>req:{row.request_id}</span>
            {row.parent_request_id && <span>parent:{row.parent_request_id}</span>}
            <span>keys:[{(row.input_keys ?? []).join(", ")}]</span>
            <span>sha256:{shortenHash(row.input_sha256)}</span>
            <span className="text-slate-500">{row.created_at}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
