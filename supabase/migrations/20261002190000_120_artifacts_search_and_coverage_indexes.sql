-- Migration: Add covering index for role-ranked search and composite index for captured_at
-- Issue: #1221 (nightly dos sweep search and coverage timeouts)
-- Date: 2026-10-02
--
-- WHAT BROKE:
-- 1. knowledge_search with rank_by_role: true times out on the narrative tier.
--    Migration 107 added idx_artifacts_user_active_effective on (user_id, archived, effective_at DESC)
--    with INCLUDE (id, lifecycle_stage, content_subtype). The rank_by_role per-tier filters
--    read surface and source_channel, which were outside the INCLUDE list. For wide or
--    unbounded reads, the count: "exact" step visits the heap for thousands of candidate rows,
--    hitting Postgres statement timeout.
--
-- 2. dos_synthesis_coverage and getStreak filter artifacts on (user_id, captured_at).
--    Only idx_artifacts_captured_at (captured_at) and idx_artifacts_user_id_uuid (user_id)
--    existed independently. Without a composite index on (user_id, captured_at), windowed
--    and streak coverage queries scan large ranges of the table and hit statement timeouts.
--
-- THE FIX:
-- 1. idx_artifacts_user_active_role_search covers user_id, archived, effective_at DESC
--    and includes surface and source_channel alongside id, lifecycle_stage, and content_subtype.
--    This allows role-ranked filter-only reads to run as index-only scans without touching the heap.
--
-- 2. idx_artifacts_user_captured_at indexes (user_id, captured_at DESC) with
--    INCLUDE (id, content_subtype, lifecycle_stage), turning windowed coverage queries
--    into fast index range scans.
--
-- SET, not SET LOCAL (AGENTS.md / runbook: SET LOCAL is silently ignored in implicit tx blocks).
SET statement_timeout = '30min';

CREATE INDEX IF NOT EXISTS idx_artifacts_user_active_role_search
  ON public.artifacts USING btree (user_id, archived, effective_at DESC)
  INCLUDE (id, lifecycle_stage, content_subtype, surface, source_channel);

COMMENT ON INDEX public.idx_artifacts_user_active_role_search IS
  'Covers knowledge_search rank_by_role reads (including surface and source_channel) so per-tier counts and pages run as index-only scans. Issue #1221, migration 120.';

CREATE INDEX IF NOT EXISTS idx_artifacts_user_captured_at
  ON public.artifacts USING btree (user_id, captured_at DESC)
  INCLUDE (id, content_subtype, lifecycle_stage);

COMMENT ON INDEX public.idx_artifacts_user_captured_at IS
  'Indexes artifacts by user_id and captured_at with content_subtype and lifecycle_stage for fast windowed synthesis coverage and streak reads. Issue #1221, migration 120.';
