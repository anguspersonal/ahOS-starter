-- Migration: artifacts.originated_at + generated artifacts.effective_at
-- ADR: ADR-088 (A day window reads valid time; coverage reads transaction time)
-- Issue: #571
-- Date: 2026-09-14
--
-- `captured_at` records WHEN THE INGEST RAN, not when the content is from. A
-- bulk Drive backfill on 2026-08-05 (#567) therefore landed a decade of files —
-- a 2016 flat-hunting spreadsheet, GCSE homework, an old employment contract —
-- stamped with that day, and every day-scoped consumer read them as things that
-- happened that day. #567's read-side stage filter removed the visible half of
-- that (those rows were unenriched pointers with no body). It cannot reach the
-- case this migration is for: an ENRICHED historic document is legitimately
-- synthesis-eligible, and lands in today's window with nothing to mark it as
-- 2016.
--
-- This is ordinary bitemporality. `captured_at` is TRANSACTION time (when the
-- system learned it); `originated_at` is VALID time (when the content is from).
-- ADR-088 records the decision; the grill is on #571.
--
-- WHY A COLUMN RATHER THAN DERIVING IT AT READ. The timestamps are already
-- stored, in `processing_metadata.discovery.source_created_at` /
-- `source_modified_at` (tools/discover.ts), and enrichment preserves them
-- (enrichNext.ts). Reading them there was priced first (#571, 2026-09-05) and
-- rejected on four counts:
--   1. knowledge_search filters the window in three places, one of which is a
--      PostgREST query builder (tools/search.ts). COALESCE over a jsonb path and
--      a column is not expressible in PostgREST's filter grammar, so option 1
--      needed a view, a generated column or an RPC anyway — i.e. a migration.
--   2. idx_artifacts_processing_metadata is GIN jsonb_ops: containment, not
--      range comparison. A day window over a jsonb text field is a seq scan,
--      comparing STRINGS — correct only while every source serves identical UTC
--      formatting. A timestamptz normalises at write.
--   3. It would widen the hot search projection to a jsonb blob to read one
--      string out of it, against the four PRs (#609/#765/#775/#783, migration
--      098) spent narrowing exactly that.
--   4. It reaches only rows that arrived through `ingest_discover`. `capture`
--      has no discovery block and never will, and drive_import writes none —
--      so the Daily Log twin (#562) and the session summary (#565), the other
--      two atoms whose day is wrong, are permanently out of its reach.
--
-- `effective_at` IS GENERATED, NOT A SECOND WRITABLE COLUMN. It is the one
-- definition of "the day this atom belongs to", so the SQL filter and the
-- JS filters cannot drift apart — which they would, being three call sites in
-- two languages. STORED (not VIRTUAL) so it can carry a btree index, giving the
-- day window the same access path `captured_at` has today.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO. `dos_synthesis_coverage` and
-- the marker reads in links.ts stay on `captured_at`, on purpose (#571 (b)):
-- coverage answers "did I run the ritual", which is an ingest-shaped question,
-- while the day window answers "what is this day about", which is an
-- origination-shaped one. The two keying on different dates is the decision,
-- not an oversight — see the comment at getSynthesisCoverage before "fixing" it.

-- THE BACKFILL USED TO LIVE IN THIS FILE AND TOOK THE WHOLE MIGRATION DOWN WITH
-- IT (2026-09-15). `UPDATE ... WHERE processing_metadata->'discovery'->>'connector'
-- IN (...)` cannot use idx_artifacts_processing_metadata — a GIN jsonb_ops index
-- serves containment and key-existence, not a text comparison on an extracted
-- path — so it was a sequential scan with per-row JSON extraction over every
-- artifact, and it hit Supabase's statement timeout. The migration is
-- transactional, so the timeout rolled back the ADD COLUMNs too: the schema
-- change never landed, while the deployed mcp-server was already selecting
-- `effective_at`. knowledge_search 500'd on every call until the columns were
-- added by hand.
--
-- Schema and data are now separate migrations. This one is fast and cannot fail
-- on volume; migration 105 carries the backfill, where a timeout costs a retry
-- rather than an outage. Keep it that way: a slow data step must never be able
-- to block a fast schema step.
--
-- `SET LOCAL` because `db push` runs each migration in a transaction; the
-- generated column below rewrites the table, which is O(rows) even with no
-- backfill, and the CLI's default timeout is not sized for it.
SET LOCAL statement_timeout = '30min';

ALTER TABLE public.artifacts
  ADD COLUMN IF NOT EXISTS originated_at timestamptz;

COMMENT ON COLUMN public.artifacts.originated_at IS
  'Valid time (ADR-088 / #571): when this content is FROM, as opposed to captured_at, which is when the ingest ran. NULL is the ordinary case and means "the source told us nothing", not "today" — readers coalesce via the generated effective_at. Written only as a deterministic field-copy of the source API''s own timestamp (ADR-046 §2 envelope rule), never inferred from the body, which ADR-018 forbids at write time. WHICH envelope field is per source, in ORIGINATION_FIELD_BY_CONNECTOR (packages/mcp-server/src/vocab.ts): Drive uses createdTime (a 2016 contract is from 2016), Notion uses last_edited_time (a page edited today is content from today).';

ALTER TABLE public.artifacts
  ADD COLUMN IF NOT EXISTS effective_at timestamptz
  GENERATED ALWAYS AS (COALESCE(originated_at, captured_at)) STORED;

COMMENT ON COLUMN public.artifacts.effective_at IS
  'The day this atom belongs to (ADR-088 / #571): COALESCE(originated_at, captured_at). The ONLY definition of that, deliberately — knowledge_search filters the day window in three places across two languages, and a hand-written coalesce in each is a drift waiting to happen. Read it; never re-derive it. NULL only when captured_at is also NULL, which no writer produces. Day-scoped synthesis reads key on this; dos_synthesis_coverage deliberately does NOT — it keys on captured_at, because "did I run the ritual" is an ingest-shaped question (#571 (b)).';

CREATE INDEX IF NOT EXISTS idx_artifacts_effective_at
  ON public.artifacts USING btree (effective_at);
