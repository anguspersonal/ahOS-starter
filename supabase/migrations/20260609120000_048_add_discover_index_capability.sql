-- Migration 048: Discover & Index capability (ADR-016, Slice 1)
--
-- ADDITIVE ONLY. This does not rebuild any table and removes no existing value.
-- It enables registry/pointer rows written by the `discover` MCP tool: lightweight
-- "what exists and where it lives" records for items inventoried from external
-- systems (Notion first), reusing the existing `artifacts` substrate per the
-- registry-not-store principle. See docs/ADRs/ADR016_Discover_And_Index_Axis.md.
--
-- A discovered pointer is an `artifacts` row with:
--   lifecycle_stage = 'discovered'        (new value added below)
--   source_channel  = 'discovered_<conn>' (e.g. 'discovered_notion')
--   source          = <external id>       (stable id in the source system)
--   storage_url     = link to the external item (content stays where it lives)
-- It carries no stored blob and is not enriched until the budgeted enrich pass
-- (Slice 2) promotes it.

BEGIN;

-- 1) Allow the 'discovered' lifecycle stage. Re-create the CHECK preserving every
--    existing value (mirrors migration 033) and append 'discovered'.
ALTER TABLE public.artifacts
  DROP CONSTRAINT IF EXISTS artifacts_lifecycle_stage_check;

ALTER TABLE public.artifacts
  ADD CONSTRAINT artifacts_lifecycle_stage_check
  CHECK (
    lifecycle_stage = ANY (ARRAY[
      -- Current app values (packages/shared/src/types/knowledge.ts)
      'uploaded'::text,
      'upload_failed'::text,
      'processing'::text,
      'analysed'::text,
      'analysis_failed'::text,
      'needs_review'::text,
      'entities_extracted'::text,
      'actions_extracted'::text,
      'artifacts_created'::text,
      'complete'::text,
      'blocked'::text,
      'failed'::text,
      'archived'::text,
      -- Legacy values kept for backward compatibility with older data
      'extracted'::text,
      'contextualized'::text,
      'actionable'::text,
      'refined'::text,
      'processed'::text,
      -- ADR-016 Discover & Index: registry/pointer row, inventoried but not yet enriched
      'discovered'::text
    ])
  );

-- 2) Idempotent re-discovery: at most one pointer per (user, discovery channel,
--    external id). Partial predicate so this index NEVER applies to captured or
--    uploaded rows -- only Discover & Index channels. Keeps re-running discovery
--    safe and prevents the inventory from accumulating duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_discovered_external
  ON public.artifacts (user_id, source_channel, source)
  WHERE source_channel LIKE 'discovered\_%';

COMMENT ON INDEX public.idx_artifacts_discovered_external IS
  'ADR-016 Discover & Index: keeps re-discovery idempotent. source holds the external id; source_channel is discovered_<connector>.';

COMMIT;
