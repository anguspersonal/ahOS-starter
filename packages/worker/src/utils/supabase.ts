/**
 * Supabase client configuration for the worker
 * Uses service role key to bypass RLS for backend operations
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import logger from './logger';

// Use same project as web app: prefer SUPABASE_URL, fallback to NEXT_PUBLIC_SUPABASE_URL so one .env works for both.
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  const missing = [];
  if (!supabaseUrl) missing.push('SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL');
  if (!supabaseServiceKey) {
    missing.push('SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY)');
  }

  logger.error(`Missing Supabase credentials: ${missing.join(', ')}`);
  throw new Error(`Missing Supabase credentials: ${missing.join(', ')}`);
}

// Create Supabase client with service role (bypasses RLS)
// This is appropriate for backend worker operations
export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  db: {
    schema: 'public',
  },
});

logger.info('Supabase client initialized', {
  url: supabaseUrl,
  // Don't log the service key for security
});

export default supabase;

