-- Migration: Add user_integrations table
-- Date: 2026-06-06
-- Purpose:
--   The system's taxonomy and behaviour are opinionated and shared in the repo. What
--   is genuinely per-user is the *wiring* that points the opinionated system at a
--   given user's instances of rented services — e.g. the Notion database id of their
--   task list ("Work"), a calendar id, etc. These non-secret pointers are persisted
--   here so they follow the user across machines and out of the public skill files.
--
--   SECRETS DO NOT LIVE HERE. Tokens/keys (e.g. NOTION_API_KEY) stay in environment
--   config. This table holds only non-secret identifiers + mapping config.
--
--   config JSONB shape is provider-specific. For provider 'notion':
--     {
--       "tasks_database_id": "<notion database id>",   // required to create tasks
--       "title_property": "Name",                       // optional; defaults to "Name"
--       "property_map": {                               // optional extra property names
--         "due": "Due",
--         "status": "Status"
--       }
--     }

CREATE TABLE IF NOT EXISTS public.user_integrations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT user_integrations_pkey PRIMARY KEY (id),
  -- One config row per (user, provider). Upserts target this.
  CONSTRAINT user_integrations_user_provider_key UNIQUE (user_id, provider)
);

COMMENT ON TABLE public.user_integrations IS
  'Per-user pointers to external service instances (non-secret). Tokens stay in env. config JSONB is provider-specific; see migration 046.';

ALTER TABLE public.user_integrations ENABLE ROW LEVEL SECURITY;

-- Owner-only RLS, matching the entities/artifacts pattern. The MCP server uses the
-- service role (bypasses RLS); these policies protect any RLS-bound client (web app).
CREATE POLICY "Users can view own integrations"
ON public.user_integrations AS PERMISSIVE FOR SELECT TO public
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own integrations"
ON public.user_integrations AS PERMISSIVE FOR INSERT TO public
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own integrations"
ON public.user_integrations AS PERMISSIVE FOR UPDATE TO public
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own integrations"
ON public.user_integrations AS PERMISSIVE FOR DELETE TO public
USING (auth.uid() = user_id);

-- Keep updated_at honest on writes.
CREATE OR REPLACE FUNCTION update_user_integrations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_user_integrations_updated_at ON public.user_integrations;
CREATE TRIGGER update_user_integrations_updated_at
  BEFORE UPDATE ON public.user_integrations
  FOR EACH ROW
  EXECUTE FUNCTION update_user_integrations_updated_at();

-- Migration complete: user_integrations table ready for per-user external wiring.
