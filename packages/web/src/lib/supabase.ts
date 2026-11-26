import { createClient } from "@supabase/supabase-js";

// Helper to read client environment variable from runtime window.__ENV__
// (injected dynamically by container startup).
export function getRuntimeEnv(key: string): string {
  if (
    typeof window !== "undefined" &&
    (window as unknown as { __ENV__?: Record<string, string> }).__ENV__?.[key]
  ) {
    const val = (window as unknown as { __ENV__?: Record<string, string> }).__ENV__![key];
    if (val && val.trim().length > 0) {
      return val.trim();
    }
  }
  return "";
}

// Read Supabase credentials from runtime window.__ENV__ or Vite environment variables.
// In production, these point to the secure Supabase project.
const supabaseUrl =
  getRuntimeEnv("VITE_SUPABASE_URL") ||
  import.meta.env.VITE_SUPABASE_URL ||
  "https://placeholder-project.supabase.co";

const supabaseAnonKey =
  getRuntimeEnv("VITE_SUPABASE_ANON_KEY") ||
  getRuntimeEnv("VITE_SUPABASE_PUBLISHABLE_KEY") ||
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  "placeholder-anon-key";

export const isSupabaseConfigured =
  supabaseUrl !== "https://placeholder-project.supabase.co" &&
  supabaseAnonKey !== "placeholder-anon-key";

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

