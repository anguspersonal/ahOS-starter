import { createClient } from '@supabase/supabase-js';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  options?: {
    auth?: {
      persistSession?: boolean;
      autoRefreshToken?: boolean;
      detectSessionInUrl?: boolean;
      storage?: any;
    };
    global?: {
      headers?: Record<string, string>;
    };
  };
}

/**
 * Create a Supabase client with the provided configuration
 * This is a shared utility that can be used across all packages
 */
export function createSupabaseClient(config: SupabaseConfig): ReturnType<typeof createClient> {
  if (!config.url) {
    throw new Error('Missing Supabase URL');
  }
  if (!config.anonKey) {
    throw new Error('Missing Supabase anon key');
  }

  return createClient(config.url, config.anonKey, config.options || {});
}

