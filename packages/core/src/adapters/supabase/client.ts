/**
 * @ahkms/core/adapters - Supabase Client Factory
 *
 * Constructs a real @supabase/supabase-js client inside adapters only (ADR-101 §3, #1340).
 * Used by composition roots (packages/core/src/engine/main.ts).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function createSupabaseAdminClient(url: string, key: string): SupabaseClient {
	return createClient(url, key, {
		auth: {
			persistSession: false,
			autoRefreshToken: false,
		},
	});
}

export type { SupabaseClient };
