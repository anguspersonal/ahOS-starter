-- Migration: backfill artifacts.originated_at from the discovery envelope
-- ADR: ADR-088 (A day window reads valid time; coverage reads transaction time)
-- Issue: #571
-- Date: 2026-09-15
--
-- The data half of migration 104, split out after the two together took down
-- knowledge_search on 2026-09-15.
--
-- WHAT WENT WRONG, SO IT IS NOT REPEATED. 104 shipped the columns and this
-- backfill in one file. The backfill's predicate was
-- `processing_metadata->'discovery'->>'connector' IN (...)`, which CANNOT use
-- idx_artifacts_processing_metadata: a GIN jsonb_ops index answers containment
-- and key-existence, never a text comparison on an extracted path. So it became
-- a sequential scan with per-row JSON extraction across every artifact, and it
-- hit Supabase's statement timeout. Migrations are transactional, so the timeout
-- rolled back the ADD COLUMNs as well — and the deployed mcp-server was by then
-- already selecting `effective_at`, so every knowledge_search call 500'd until
-- the columns were added by hand.
--
-- Two changes follow from that, and both matter more than the backfill itself:
--
--   1. SCHEMA AND DATA ARE SEPARATE MIGRATIONS NOW. A slow data step must never
--      be able to block a fast schema step. If this file times out, the retry
--      costs nothing: the columns are already in, readers already work, and the
--      only consequence is that historic rows keep reading as their ingest date
--      for a while longer.
--   2. `@>` INSTEAD OF AN EXTRACTED-PATH COMPARISON. Containment is exactly what
--      GIN jsonb_ops indexes, so this narrows to rows that actually carry a
--      discovery block — the pointers — instead of scanning the whole table.
--      `processing_metadata ? 'discovery'` would be the more natural spelling
--      and is equally indexable, but `?` is a parameter placeholder to several
--      drivers, and a migration file should not depend on which one runs it.
--      `@> '{"discovery": {}}'` matches any object at that key, empty or not.
--
-- Idempotent via `originated_at IS NULL`, so a re-run after a partial failure
-- cannot overwrite a value a writer has since set.
--
-- The `~` guard stays: these are verbatim strings from third-party APIs, and one
-- malformed value would abort the whole statement on the cast. A row that fails
-- it keeps NULL and falls back to captured_at through effective_at, which is the
-- pre-ADR-088 behaviour — the safe direction.
--
-- Per-source rule restated in SQL because a one-shot backfill cannot import
-- TypeScript. Harmless precisely because it runs once; the live rule has exactly
-- one home, ORIGINATION_FIELD_BY_CONNECTOR in packages/mcp-server/src/vocab.ts.

SET LOCAL statement_timeout = '30min';

-- Drive: createdTime. The discover cadence is incremental on modifiedTime, so
-- keying on modified would refile a 2016 contract re-saved last week as last
-- week's — the bug this exists to remove.
UPDATE public.artifacts
SET originated_at = (processing_metadata->'discovery'->>'source_created_at')::timestamptz
WHERE originated_at IS NULL
  AND processing_metadata @> '{"discovery": {}}'::jsonb
  AND processing_metadata->'discovery'->>'connector' IN
      ('gdrive', 'google_drive', 'drive', 'gdrive_work')
  AND processing_metadata->'discovery'->>'source_created_at' ~ '^\d{4}-\d{2}-\d{2}';

-- Notion: last_edited_time. A page is a living document; one edited today holds
-- content from today, and created_time would file a heavily-revised 2024 page
-- under 2024 forever.
UPDATE public.artifacts
SET originated_at = (processing_metadata->'discovery'->>'source_modified_at')::timestamptz
WHERE originated_at IS NULL
  AND processing_metadata @> '{"discovery": {}}'::jsonb
  AND processing_metadata->'discovery'->>'connector' = 'notion'
  AND processing_metadata->'discovery'->>'source_modified_at' ~ '^\d{4}-\d{2}-\d{2}';
