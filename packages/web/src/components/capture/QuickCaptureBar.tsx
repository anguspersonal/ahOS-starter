import React, { useState } from "react";
import { z } from "zod";
import { useAction, type ClientActionDefinition } from "../../lib/actionClient.js";

interface CaptureInput {
  text: string;
  title?: string;
}

interface CaptureOutput {
  captured: boolean;
  text: string;
  title?: string;
  caller: string;
  id: string;
}

const clientCaptureAction: ClientActionDefinition<CaptureInput, CaptureOutput> = {
  id: "capture",
  name: "capture",
  description: "Capture thought, decision, or note into knowledge store",
  schema: z.object({
    text: z.string().min(1, "Capture text cannot be empty"),
    title: z.string().optional(),
  }),
  run: async (input, ctx) => {
    return {
      captured: true,
      text: input.text,
      title: input.title,
      caller: ctx.caller,
      id: `art-${Date.now()}`,
    };
  },
};

export function QuickCaptureBar() {
  const [text, setText] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const { execute, loading, error } = useAction(clientCaptureAction);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || loading) return;

    try {
      await execute({ text: text.trim() });
      setText("");
      setSuccessMsg("Captured to ahOS store");
      setTimeout(() => setSuccessMsg(""), 3000);
    } catch {
      // Error handled by hook
    }
  };

  return (
    <div className="w-full max-w-2xl mx-auto">
      <form onSubmit={handleSubmit} className="relative">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Quick capture note or instruction (Cmd+Enter to submit)..."
          disabled={loading}
          className="w-full px-4 py-2.5 bg-slate-900/90 border border-slate-800 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 shadow-lg"
        />
        <div className="absolute right-2 top-2 flex items-center gap-2">
          {successMsg && (
            <span className="text-xs text-emerald-400 font-medium animate-pulse">
              {successMsg}
            </span>
          )}
          {error && (
            <span className="text-xs text-red-400 font-medium">
              {error.message}
            </span>
          )}
          <button
            type="submit"
            disabled={loading || !text.trim()}
            className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-xs font-semibold text-white rounded-lg transition-colors"
          >
            {loading ? "Capturing..." : "Capture"}
          </button>
        </div>
      </form>
    </div>
  );
}
