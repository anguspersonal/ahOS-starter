import React, { useState } from "react";
import { supabase, isSupabaseConfigured } from "../../lib/supabase.js";

export function LoginView() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"magic-link" | "password">("magic-link");
  const [status, setStatus] = useState<{ type: "idle" | "loading" | "success" | "error"; message?: string }>({
    type: "idle",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    setStatus({ type: "loading" });

    try {
      if (mode === "magic-link") {
        const { error } = await supabase.auth.signInWithOtp({
          email: email.trim(),
          options: {
            emailRedirectTo: window.location.origin,
          },
        });
        if (error) throw error;
        setStatus({
          type: "success",
          message: "Magic sign-in link dispatched. Check your inbox.",
        });
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;
        setStatus({ type: "success", message: "Authenticated successfully." });
      }
    } catch (err) {
      setStatus({
        type: "error",
        message: err instanceof Error ? err.message : "Authentication failed.",
      });
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-slate-950">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-xl p-8 shadow-2xl">
        <div className="mb-6 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-lg bg-indigo-600/20 text-indigo-400 font-bold text-xl mb-3 border border-indigo-500/30">
            ah
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">ahOS Co-Editing Workspace</h1>
          <p className="text-sm text-slate-400 mt-1">
            Authenticated surface for human-agent collaboration
          </p>
        </div>

        <div className="flex border-b border-slate-800 mb-6">
          <button
            type="button"
            className={`flex-1 py-2 text-xs font-semibold uppercase tracking-wider transition-colors border-b-2 ${
              mode === "magic-link"
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-300"
            }`}
            onClick={() => {
              setMode("magic-link");
              setStatus({ type: "idle" });
            }}
          >
            Magic Link
          </button>
          <button
            type="button"
            className={`flex-1 py-2 text-xs font-semibold uppercase tracking-wider transition-colors border-b-2 ${
              mode === "password"
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-300"
            }`}
            onClick={() => {
              setMode("password");
              setStatus({ type: "idle" });
            }}
          >
            Password
          </button>
        </div>

        {!isSupabaseConfigured && (
          <div className="mb-4 p-3 bg-amber-950/60 border border-amber-800/80 rounded-lg text-xs text-amber-200">
            <strong>Configuration required:</strong> Supabase credentials are not set. Set <code className="bg-slate-900 px-1 py-0.5 rounded text-amber-100">VITE_SUPABASE_URL</code> and <code className="bg-slate-900 px-1 py-0.5 rounded text-amber-100">VITE_SUPABASE_ANON_KEY</code> for local builds (the Dockerfile maps Railway&apos;s <code className="bg-slate-900 px-1 py-0.5 rounded text-amber-100">SUPABASE_URL</code> / <code className="bg-slate-900 px-1 py-0.5 rounded text-amber-100">SUPABASE_PUBLISHABLE_KEY</code> onto them).
          </div>
        )}

        {status.type === "error" && (
          <div className="mb-4 p-3 bg-red-950/60 border border-red-800/80 rounded-lg text-xs text-red-200">
            {status.message}
          </div>
        )}

        {status.type === "success" && (
          <div className="mb-4 p-3 bg-emerald-950/60 border border-emerald-800/80 rounded-lg text-xs text-emerald-200">
            {status.message}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Email Address
            </label>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="owner@example.com"
              required
              className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          {mode === "password" && (
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Password
              </label>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                required
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={status.type === "loading"}
            className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium text-sm rounded-lg transition-colors shadow-lg shadow-indigo-600/20"
          >
            {status.type === "loading"
              ? "Authenticating..."
              : mode === "magic-link"
                ? "Send Magic Link"
                : "Sign In"}
          </button>
        </form>

        <div className="mt-6 pt-4 border-t border-slate-800/80 text-center">
          <p className="text-[11px] text-slate-400">
            Strict session gating enforced (ADR-096 / ADR-100). Zero unauthenticated routes.
          </p>
        </div>
      </div>
    </div>
  );
}
