-- Narrow the inbox RPCs' return shape (#783, follow-up to #609/#765/#775).
--
-- get_artifacts_needing_attention/get_artifacts_by_stage backed
-- fetchInboxArtifacts's 'needs_review'/'recently_captured' filters via
-- `RETURNS SETOF public.artifacts`, so every row -- including the 1536-dim
-- `embedding` vector and the `search_vector` tsvector -- came back over the
-- wire for two of the four inbox filters, same egress problem #609/#765/#775
-- already fixed for fetchArtifacts/fetchProjectById/fetchEntityById and for
-- this same function's other two filters ('all'/'blocking', narrowed
-- client-side in #775 via INBOX_ARTIFACT_COLUMNS).
--
-- Narrowed to exactly what the client needs:
--   - get_artifacts_needing_attention: the ArtifactInboxItem columns the
--     Inbox views render (fetchInboxArtifacts trusts this RPC's own
--     ORDER BY and never re-sorts, so no date column is needed).
--   - get_artifacts_by_stage: the same columns plus captured_at/created_at.
--     fetchInboxArtifacts calls this RPC twice ('uploaded' and 'processing',
--     each independently limited and ordered by created_at DESC) and merges
--     the two result sets client-side, re-sorting by captured_at ?? created_at
--     before slicing to the overall limit -- that merge needs a date to stay
--     correct, so it is the one filter that keeps date columns in its narrow
--     shape.
--
-- DROP is required: Postgres does not allow changing a function's return
-- type via CREATE OR REPLACE (same reason as migration 039).

DROP FUNCTION IF EXISTS public.get_artifacts_needing_attention(uuid);

CREATE FUNCTION public.get_artifacts_needing_attention(p_user_id uuid)
RETURNS TABLE(
  id text,
  title text,
  filename text,
  original_file_name text,
  storage_path text,
  storage_url text,
  file_type text,
  lifecycle_stage text
)
LANGUAGE sql
STABLE
AS $function$
  SELECT
    a.id,
    a.title,
    a.filename,
    a.original_file_name,
    a.storage_path,
    a.storage_url,
    a.file_type,
    a.lifecycle_stage
  FROM public.artifacts a
  WHERE a.user_id = p_user_id
    AND a.lifecycle_stage IN ('blocked', 'needs_review', 'failed')
    AND a.archived = FALSE
  ORDER BY
    CASE a.lifecycle_stage
      WHEN 'blocked' THEN 1
      WHEN 'needs_review' THEN 2
      WHEN 'failed' THEN 3
      ELSE 4
    END,
    a.created_at DESC;
$function$;

DROP FUNCTION IF EXISTS public.get_artifacts_by_stage(uuid, text, integer);

CREATE FUNCTION public.get_artifacts_by_stage(p_user_id uuid, p_stage text, p_limit integer DEFAULT 100)
RETURNS TABLE(
  id text,
  title text,
  filename text,
  original_file_name text,
  storage_path text,
  storage_url text,
  file_type text,
  lifecycle_stage text,
  captured_at timestamptz,
  created_at timestamptz
)
LANGUAGE sql
STABLE
AS $function$
  SELECT
    a.id,
    a.title,
    a.filename,
    a.original_file_name,
    a.storage_path,
    a.storage_url,
    a.file_type,
    a.lifecycle_stage,
    a.captured_at,
    a.created_at
  FROM public.artifacts a
  WHERE a.user_id = p_user_id
    AND a.lifecycle_stage = p_stage
    AND a.archived = FALSE
  ORDER BY a.created_at DESC
  LIMIT p_limit;
$function$;
