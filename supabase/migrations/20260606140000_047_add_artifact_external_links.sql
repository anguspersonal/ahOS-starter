-- Migration: Add artifact_external_links table (cross-store lineage)
-- Date: 2026-06-06
-- Purpose:
--   ADR-013 §5: truth is split — knowledge (artifacts) lives in Supabase, working state
--   (tasks, the SOD/EOD state doc) lives in Notion. The link between an artifact and the
--   external things derived from it is a stored reference, not a join, so that
--   "what tasks came out of that meeting?" is answerable from the memory side WITHOUT
--   making Notion the retrieval engine.
--
--   One artifact can produce many external items (several tasks from one transcript), so
--   this is a 1->many table, not a column on artifacts.
--
--   This same table also carries the ADR-013 §7 consumption marker: a row with
--   kind='consumed_by_state' records that an artifact has been folded into a state doc.
--   We store only that positive fact; "pending"/"n/a" are derived from a scope predicate.

CREATE TABLE IF NOT EXISTS public.artifact_external_links (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES public.artifacts(id) ON DELETE CASCADE,
  -- Where the external thing lives, e.g. 'notion'. 'internal' is allowed for links to
  -- other Supabase rows (e.g. a state-doc derived artifact) when kept here for uniformity.
  provider text NOT NULL,
  -- What the link represents: 'task' | 'state_doc' | 'consumed_by_state' | ...
  kind text NOT NULL,
  -- The external identifier (e.g. a Notion page id) or internal id, as text.
  external_id text NOT NULL,
  -- Optional convenience URL for humans/agents; never required for lookups.
  external_url text,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT artifact_external_links_pkey PRIMARY KEY (id),
  -- Idempotency: re-recording the same link is a no-op (supports re-runnable enrichment).
  CONSTRAINT artifact_external_links_unique UNIQUE (artifact_id, provider, kind, external_id)
);

COMMENT ON TABLE public.artifact_external_links IS
  'Cross-store lineage (ADR-013 §5): links an artifact to external items derived from it (Notion task/state_doc) and carries the consumed_by_state marker (§7). 1->many.';

CREATE INDEX IF NOT EXISTS idx_artifact_external_links_artifact
  ON public.artifact_external_links(artifact_id);
-- Fast "which artifacts are consumed / produced kind X" scans for EOD/SOD.
CREATE INDEX IF NOT EXISTS idx_artifact_external_links_kind
  ON public.artifact_external_links(user_id, kind);

ALTER TABLE public.artifact_external_links ENABLE ROW LEVEL SECURITY;

-- Owner-only RLS, matching entities/artifacts. The MCP server uses the service role
-- (bypasses RLS); these protect any RLS-bound client.
CREATE POLICY "Users can view own artifact links"
ON public.artifact_external_links AS PERMISSIVE FOR SELECT TO public
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own artifact links"
ON public.artifact_external_links AS PERMISSIVE FOR INSERT TO public
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own artifact links"
ON public.artifact_external_links AS PERMISSIVE FOR UPDATE TO public
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own artifact links"
ON public.artifact_external_links AS PERMISSIVE FOR DELETE TO public
USING (auth.uid() = user_id);

-- Migration complete: artifact_external_links ready for lineage + state consumption.
