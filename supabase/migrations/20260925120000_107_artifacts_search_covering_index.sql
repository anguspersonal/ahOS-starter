-- Migration: covering index for knowledge_search's filter-only reads
-- Issue: #911 (the backlog slice), found while verifying #1135 on 2026-09-25
-- Date: 2026-09-25
--
-- WHAT BROKE. knowledge_search's filter-only path (no `query`) asks PostgREST for
-- `count: "exact"` (#567) so its "N more" line is true. PostgREST answers that with
-- a second CTE, `pgrst_source_count`, that counts EVERY row matching the filters:
--
--   user_id = $u AND archived = false
--   AND (content_subtype IS NULL OR NOT content_subtype = ANY($subtypes))
--   AND (lifecycle_stage IS NULL OR NOT lifecycle_stage = ANY($unenriched))
--   AND NOT id = ANY($consumed)                 -- not_consumed
--   AND effective_at <= $before                 -- captured_before, when passed
--
-- `artifacts` holds ~157k rows, most of them Drive pointers the lifecycle filter
-- throws away. No existing index carries lifecycle_stage, content_subtype and id
-- together with user_id/archived, so the count has to visit the heap for every
-- candidate row, and the heap is wide (plain_text, extracted_content, embeddings).
-- On 2026-09-25 every wide read timed out (SQLSTATE 57014, postgres_logs, user
-- `authenticator`, application `postgrest`): `{not_consumed: true}`,
-- `{captured_before: <today>}` and dos Setup read 5's `{captured_before: <today>,
-- not_consumed: true}` alike. Narrow windows (`captured_after: <yesterday>`) still
-- answer. So the ritual's backlog slice — the one read ADR-067 hangs the queue on
-- — cannot load at all.
--
-- THE FIX. One btree whose keys are the equality columns then the order column,
-- and whose INCLUDE list is every other column the WHERE clause reads, so both
-- halves of the statement CAN run from the index:
--   * the count as an index-only scan (visibility map permitting): user_id and
--     archived bound the range, and the subtype / lifecycle / id predicates are
--     evaluable on INCLUDE columns without touching the heap;
--   * the page (`ORDER BY effective_at DESC LIMIT n`) by walking the same index
--     in order and fetching only the n rows it returns.
-- This is the intended plan, not a measured one: nobody could run EXPLAIN against
-- prod from the session that wrote this. The PR carries the EXPLAIN to run after
-- the push, and if the planner declines the index this file is harmless and the
-- fix moves to the read side (drop `count: "exact"` on the wide path).
-- The planner uses the index only when it prices it cheaper, so it cannot make an
-- existing query slower; it costs one more index to maintain on write.
--
-- Not covered: #1135's `rank_by_role` per-tier filters read columns outside the
-- INCLUDE list, so those counts still fetch heap rows — but only for rows the
-- index has already narrowed to active, enriched, unconsumed ones. And a read
-- with `include_archived: true` drops the `archived = false` predicate, so the
-- index is no longer one sorted run for `ORDER BY effective_at DESC`: the count
-- can still be index-only, but the page may need a sort of the matching rows.
-- That flag is opt-in and rare, and it is not the path that timed out.
--
-- NOT CONCURRENTLY: `supabase db push` sends this file as one multi-statement
-- query, which Postgres runs as an implicit transaction block, and CREATE INDEX
-- CONCURRENTLY refuses to run inside one. A plain build takes a SHARE lock (writes
-- to artifacts wait; reads do not) for the few seconds a ~157k-row build takes.
--
-- `SET`, not `SET LOCAL` (AGENTS.md; runbook "db push and transactions"): the
-- migration role's own statement_timeout is what killed migration 104's backfill.

SET statement_timeout = '30min';

CREATE INDEX IF NOT EXISTS idx_artifacts_user_active_effective
  ON public.artifacts USING btree (user_id, archived, effective_at DESC)
  INCLUDE (id, lifecycle_stage, content_subtype);

COMMENT ON INDEX public.idx_artifacts_user_active_effective IS
  'Covers knowledge_search filter-only reads (count: exact + ORDER BY effective_at DESC LIMIT n) so the count is an index-only scan. Migration 107; see its header.';
