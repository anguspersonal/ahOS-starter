import { useState } from "react";
import { z } from "zod";
import { useAction, type ClientActionDefinition } from "../../lib/actionClient.js";

interface FreshActionInput {
  name: string;
  notes?: string;
}

interface FreshActionOutput {
  success: boolean;
  message: string;
  timestamp: string;
  caller: string;
}

const freshAction: ClientActionDefinition<FreshActionInput, FreshActionOutput> = {
  id: "fresh_action",
  name: "fresh_action",
  description: "Starter action for fresh canvas development",
  schema: z.object({
    name: z.string().min(1, "Name is required"),
    notes: z.string().optional(),
  }),
  run: async (input, ctx) => {
    return {
      success: true,
      message: `Fresh action executed for: ${input.name}`,
      timestamp: new Date().toISOString(),
      caller: ctx.caller,
    };
  },
};

export function FreshCanvas() {
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const { data, loading, error, execute, reset } = useAction(freshAction);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await execute({ name: name.trim(), notes: notes.trim() || undefined });
  };

  return (
    <div className="space-y-6">
      {/* 1. Header & Context */}
      <div className="flex items-center justify-between pb-4 border-b border-slate-800">
        <div>
          <h2 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
            <span>Fresh Canvas</span>
            <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 text-xs font-mono font-medium rounded-full">
              starter
            </span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Clean development surface for building new agent-native components and workflows.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 2. Starter Interactive Form */}
        <div className="p-6 bg-slate-900 border border-slate-800 rounded-xl space-y-4">
          <h3 className="text-sm font-semibold text-white">Action Playground</h3>
          <p className="text-xs text-slate-400">
            Submit data through the Unified Action Wrapper (useAction client hook).
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="action-name" className="block text-xs font-medium text-slate-300 mb-1">
                Item / Subject Name
              </label>
              <input
                id="action-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. My new feature or test item"
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
              />
            </div>

            <div>
              <label htmlFor="action-notes" className="block text-xs font-medium text-slate-300 mb-1">
                Notes (optional)
              </label>
              <textarea
                id="action-notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Add contextual details or instructions..."
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
              />
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button
                type="submit"
                disabled={loading || !name.trim()}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold rounded-lg transition-colors shadow-sm"
              >
                {loading ? "Executing..." : "Run Action"}
              </button>
              {(data || error) && (
                <button
                  type="button"
                  onClick={() => {
                    reset();
                    setName("");
                    setNotes("");
                  }}
                  className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-lg transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
          </form>

          {error && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-lg text-xs text-rose-400">
              {error.message}
            </div>
          )}

          {data && (
            <div className="p-4 bg-slate-950 border border-slate-800 rounded-lg space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-emerald-400 font-semibold font-mono">Status: Success</span>
                <span className="text-slate-400 font-mono text-[11px]">{data.timestamp}</span>
              </div>
              <p className="text-xs text-slate-200">{data.message}</p>
              <div className="text-[11px] text-slate-400 font-mono">Caller: {data.caller}</div>
            </div>
          )}
        </div>

        {/* 3. Starter Checklist & Architecture Notes */}
        <div className="p-6 bg-slate-900 border border-slate-800 rounded-xl space-y-4">
          <h3 className="text-sm font-semibold text-white">Development Guidelines</h3>
          <ul className="space-y-3 text-xs text-slate-300">
            <li className="flex items-start gap-2.5">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 mt-1.5 shrink-0" />
              <span>
                <strong>Agent-UI Parity</strong>: Expose logic through Unified Actions so both human UI and AI agents use identical handlers.
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 mt-1.5 shrink-0" />
              <span>
                <strong>Strict Auth</strong>: All network actions require a valid Supabase session; zero unauthenticated public routes.
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 mt-1.5 shrink-0" />
              <span>
                <strong>Typography Rule</strong>: Strictly zero em-dashes or en-dashes across the codebase and text.
              </span>
            </li>
          </ul>

          <div className="pt-2 border-t border-slate-800">
            <div className="text-xs text-slate-400 font-mono">Location: packages/web/src/components/fresh/FreshCanvas.tsx</div>
          </div>
        </div>
      </div>
    </div>
  );
}
