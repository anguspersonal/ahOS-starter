import { useState } from "react";
import { z } from "zod";
import { useAction, type ClientActionDefinition } from "../../lib/actionClient.js";

export interface DecisionProposal {
  id: string;
  decisionType: string;
  title: string;
  summary: string;
  confidence: number;
  suggestedAction: string;
  createdAt: string;
  status: "pending" | "approved" | "rejected";
}

interface ResolveInput {
  decisionId: string;
  resolution: "approved" | "rejected" | "deferred";
  notes?: string;
}

interface ResolveOutput {
  success: boolean;
  decisionId: string;
  resolution: "approved" | "rejected" | "deferred";
  resolvedBy: string;
  timestamp: string;
}

const resolveProposalAction: ClientActionDefinition<ResolveInput, ResolveOutput> = {
  id: "review_resolve",
  name: "review_resolve",
  description: "Resolve a system proposal or decision item",
  schema: z.object({
    decisionId: z.string().min(1),
    resolution: z.enum(["approved", "rejected", "deferred"]),
    notes: z.string().optional(),
  }),
  run: async (input, ctx) => {
    return {
      success: true,
      decisionId: input.decisionId,
      resolution: input.resolution,
      resolvedBy: ctx.caller,
      timestamp: new Date().toISOString(),
    };
  },
};

const initialProposals: DecisionProposal[] = [
  {
    id: "dec-001",
    decisionType: "merge_suggested",
    title: "Merge duplicate CV document pointers",
    summary: "Discovered 10 identical Drive versions of 'Angus Hally - Head of Product CV'. Suggested canonical: 853a808f (newest copy).",
    confidence: 0.98,
    suggestedAction: "Set canonical pointer and archive 9 duplicate versions",
    createdAt: "2026-10-02T11:00:00Z",
    status: "pending",
  },
  {
    id: "dec-002",
    decisionType: "person_match",
    title: "Link Work team member entity",
    summary: "Discovered matching email handle between Slack and Notion integration records for Lina.",
    confidence: 0.95,
    suggestedAction: "Link person entity to Notion user id",
    createdAt: "2026-10-02T09:30:00Z",
    status: "pending",
  },
  {
    id: "dec-003",
    decisionType: "lineage_reconciliation",
    title: "Reconcile orphaned meeting note task",
    summary: "Task 'Refactor action wrapper' was created without an explicit artifact provenance link.",
    confidence: 0.91,
    suggestedAction: "Link task to session notes artifact",
    createdAt: "2026-10-01T18:20:00Z",
    status: "pending",
  },
];

export function DecisionReviewCanvas() {
  const [proposals, setProposals] = useState<DecisionProposal[]>(initialProposals);
  const { execute, loading } = useAction(resolveProposalAction);

  const handleResolve = async (id: string, resolution: "approved" | "rejected" | "deferred") => {
    try {
      await execute({ decisionId: id, resolution });
      setProposals((prev) =>
        prev.map((p) => (p.id === id ? { ...p, status: resolution === "approved" ? "approved" : "rejected" } : p)),
      );
    } catch {
      // Error surfaced by action client
    }
  };

  const pending = proposals.filter((p) => p.status === "pending");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Machine Decision Proposals</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Restores the review approval surface for machine proposals (#1218 / ADR-100)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2.5 py-1 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs font-semibold rounded-lg">
            {pending.length} Pending Approval
          </span>
        </div>
      </div>

      {pending.length === 0 ? (
        <div className="p-8 text-center bg-slate-900/50 border border-slate-800/80 rounded-xl">
          <p className="text-sm text-slate-400">All proposals have been reviewed and resolved.</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {pending.map((item) => (
            <div
              key={item.id}
              className="p-5 bg-slate-900 border border-slate-800 rounded-xl space-y-3 hover:border-slate-700/80 transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="px-2 py-0.5 bg-slate-800 text-[11px] font-mono font-medium text-slate-300 rounded">
                      {item.decisionType}
                    </span>
                    <span className="text-xs text-emerald-400 font-medium">
                      {(item.confidence * 100).toFixed(0)}% confidence
                    </span>
                  </div>
                  <h3 className="text-sm font-semibold text-white">{item.title}</h3>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => handleResolve(item.id, "approved")}
                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-semibold rounded-lg transition-colors shadow-sm"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => handleResolve(item.id, "rejected")}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-lg transition-colors"
                  >
                    Reject
                  </button>
                </div>
              </div>

              <p className="text-xs text-slate-300 leading-relaxed">{item.summary}</p>

              <div className="p-2.5 bg-slate-950/60 border border-slate-800/60 rounded-lg flex items-center justify-between text-xs">
                <span className="text-slate-400">Proposed Action:</span>
                <span className="font-medium text-slate-200">{item.suggestedAction}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
