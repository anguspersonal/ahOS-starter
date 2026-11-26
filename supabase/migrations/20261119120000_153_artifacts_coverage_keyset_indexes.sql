-- Migration 153: indexes for the dos synthesis coverage and streak reads
-- Issue: #2257 (dos_synthesis_coverage times out on every call, including a single-day window)
-- Date:  2026-11-19
--
-- WHAT BROKE:
-- getSynthesisCoverage and getStreak (packages/core/src/adapters/supabase/externalLinks.ts)
-- page through the non-pointer artifacts captured in a date range:
--
--   SELECT id, captured_at, effective_at, content_subtype, lifecycle_stage
--   FROM artifacts
--   WHERE (lifecycle_stage IS NULL OR NOT lifecycle_stage = ANY ('{discovered,failed}'))
--     AND user_id = $1 AND captured_at >= $2 AND captured_at <= $3
--   ORDER BY captured_at, id LIMIT 1000 OFFSET $n
--
-- Migration 120 added idx_artifacts_user_captured_at (user_id, captured_at DESC)
-- INCLUDE (id, content_subtype, lifecycle_stage) for this read. The read has since
-- gained effective_at, which that index does not carry, so it can no longer be answered
-- from the index alone: every row in the range costs a heap fetch, including each
-- discovered pointer that the filter then discards. Past the first page the planner
-- gives up on the index and sequentially scans the whole table. Either way one page
-- across a bulk Drive discover day exceeds the 8s statement timeout (57014). The streak
-- read spans all history, so it failed on every call.
--
-- THE FIX (two indexes, deliberately; each covers the other's weak case):
--
-- 1. idx_artifacts_user_material_captured: PARTIAL, pointer rows are not in it at all.
--    The read never touches a discovered or failed row. Its predicate is the planner's
--    own normal form of the query filter, so the match is provable. A partial index is
--    only usable when the planner can see the filter values, which holds for PostgREST's
--    custom plans but not for a generic (parameter-blind) plan.
--
-- 2. idx_artifacts_user_captured_id_covering: FULL, same key and INCLUDE list. Usable by
--    any plan, generic included. It still walks pointer rows, but inside the index, with
--    no heap fetch while those pages are all-visible.
--
-- Both are keyed (user_id, captured_at, id) so the ORDER BY needs no sort, and both
-- INCLUDE every selected column so the read is index-only. Measured on a synthetic
-- 180k-row table (160k pointers), buffers per page: 15,000 to 42,000 before; 14 to 170
-- with the partial index; 470 to 1,100 with the full index alone.
--
-- idx_artifacts_user_captured_at (migration 120) is left in place. The full index here
-- supersedes it, but dropping an index needs production plans for its other readers.
--
-- SET, not SET LOCAL (AGENTS.md / runbook: SET LOCAL is silently ignored in implicit tx blocks).
SET statement_timeout = '30min';

CREATE INDEX IF NOT EXISTS idx_artifacts_user_material_captured
  ON public.artifacts USING btree (user_id, captured_at, id)
  INCLUDE (effective_at, content_subtype, lifecycle_stage)
  WHERE lifecycle_stage IS NULL OR lifecycle_stage <> ALL (ARRAY['discovered'::text, 'failed'::text]);

COMMENT ON INDEX public.idx_artifacts_user_material_captured IS
  'Partial covering index over non-pointer artifacts in (captured_at, id) order, for the dos synthesis coverage and streak reads. Its predicate must match COVERAGE_MATERIAL_FILTER in externalLinks.ts. Issue #2257, migration 153.';

CREATE INDEX IF NOT EXISTS idx_artifacts_user_captured_id_covering
  ON public.artifacts USING btree (user_id, captured_at, id)
  INCLUDE (effective_at, content_subtype, lifecycle_stage);

COMMENT ON INDEX public.idx_artifacts_user_captured_id_covering IS
  'Full covering index in (captured_at, id) order: the plan-independent fallback for the dos synthesis coverage and streak reads when the partial index is not usable. Issue #2257, migration 153.';
