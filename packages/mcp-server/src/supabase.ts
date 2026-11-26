import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

// Service-role client: bypasses RLS. Acceptable for a single-user Phase 0 trial.
export const supabase = createClient(
	env.supabaseUrl,
	env.supabaseServiceRoleKey,
	{
		auth: { persistSession: false, autoRefreshToken: false },
	},
);
