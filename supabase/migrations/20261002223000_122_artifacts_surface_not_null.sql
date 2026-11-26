-- Migration 122: Add NOT NULL constraint to artifacts.surface (#736)
-- ADR: ADR-026 (provenance and derived trust), ADR-046 section 2/3 (source ingestion policy)
-- Issue: #736 (Add NOT NULL to artifacts.surface once write paths close and n8n writer confirmed retired)
-- Date: 2026-10-02
--
-- Preconditions verified:
--   1. All in-repo write paths under packages/ stamp a non-null surface (verified by
--      scripts/check-artifact-surface-writes.js, 0 remaining gaps).
--   2. The external n8n writer that created 14 historical rows in Nov 2025 has been
--      confirmed retired (owner decision 2026-09-26).
--   3. Production re-scan on 2026-10-02 confirmed 0 rows with surface IS NULL.
--
-- This migration:
--   1. Executes a safety backfill for any stray rows where surface IS NULL.
--   2. Enforces ALTER TABLE public.artifacts ALTER COLUMN surface SET NOT NULL.
--   3. Drops artifacts_surface_null_idx, which is now unsatisfiable per migration 092.
--   4. Updates the column comment.

SET statement_timeout = '60s';

-- 1. Safety backfill if any null surface row exists
ALTER TABLE public.artifacts DISABLE TRIGGER update_artifacts_updated_at;

UPDATE public.artifacts
SET surface = CASE
    WHEN content_subtype IN ('task_request', 'event_request') THEN 'act_receipt'
    WHEN source_channel = 'derived' THEN 'derived'
    WHEN source = 'n8n_upload' THEN 'n8n_upload'
    WHEN source_channel = 'web_upload' THEN 'web_app'
    WHEN source_channel = 'mcp' THEN 'api'
    WHEN source_channel IS NOT NULL THEN source_channel
    ELSE 'legacy_unrecorded'
  END
WHERE surface IS NULL;

ALTER TABLE public.artifacts ENABLE TRIGGER update_artifacts_updated_at;

-- 2. Add the NOT NULL constraint
ALTER TABLE public.artifacts ALTER COLUMN surface SET NOT NULL;

-- 3. Drop the partial index for surface IS NULL (unsatisfiable now that surface is NOT NULL)
DROP INDEX IF EXISTS public.artifacts_surface_null_idx;

-- 4. Update the column comment
COMMENT ON COLUMN public.artifacts.surface IS
  'Specific app/agent/ingest path the capture came through (e.g. claude_code, web_app, drive_import, act_receipt, derived). Finer than source_channel; OPEN vocab, free text, no CHECK: the values this repo''s writers stamp are single-sourced in @ahkms/shared ARTIFACT_SURFACES, and mcp-server vocab.ts SURFACES is the wider human-facing suggestion list. Read by BOTH derivations: ADR-026 surface->trust and ADR-046 section 3 surface->role, the latter storing one role PER SURFACE. A NULL here is therefore not a wrong classification but an UNADDRESSABLE row: the resolvers fall through to source_channel and then a bare default, and no surface_role_map / surface_trust_map entry can ever reach it, so a flooding path cannot be demoted (#567, #570, #584). Every write path in packages/ is inventoried by scripts/check-artifact-surface-writes.js, which pins the stamp on each closed path and counts the ones still able to write NULL. The column is NOT NULL (enforced by migration 122, #736), after all write paths were verified and the external n8n writer was confirmed retired.';
