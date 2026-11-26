// Supabase client configuration
// Use same project as web app: SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL (same value as web), same SUPABASE_SERVICE_ROLE_KEY.

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(
  supabaseUrl,
  supabaseServiceKey  // Use service role key for server-side
);

module.exports = { supabase };
