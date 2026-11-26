-- Migration 118: discover's existing-row lookup index, a set-based envelope
--                refresh, and accurate comments on the Drive columns
-- Issues: #1207 (personal Drive discover has failed every run since ~2026-08-07)
--         #1228 (Drive pointers carry their envelope)
-- Refs:   migration 048 (the partial unique index part 1 does NOT replace),
--         migration 052 (the Drive columns), migration 041 (the edit-log trigger),
--         migration 051 (the HNSW embedding index),
--         packages/mcp-server/src/tools/discover.ts discoverItems()
-- Date:   2026-09-29
--
-- Three parts. Part 1 is the #1207 fix. Parts 2 and 3 serve #1228.
--
-- ===== 1. idx_artifacts_user_channel_source (#1207) ============================
--
-- WHAT BROKE. discoverItems() asks, per batch of 50 external ids, which pointers
-- already exist:
--
--   GET /artifacts?select=id,source,processing_metadata
--       &user_id=eq.<u>&source_channel=eq.discovered_gdrive&source=in.(<50 ids>)
--
-- For `discovered_gdrive` (~150k of the ~157k artifacts rows) that request dies with
-- 57014 `canceling statement due to statement timeout` on every run since
-- 2026-08-07 (edge + postgres logs, project YOUR_PROJECT_REF). The run fails,
-- the Drive watermark never advances, and the next run relists the whole estate and
-- fails the same way. The same lookup for `discovered_gdrive_work` and
-- `discovered_notion` returns 200 in every one of those runs.
--
-- WHY MIGRATION 048'S INDEX DOES NOT SAVE IT. 048 created
-- `idx_artifacts_discovered_external ON artifacts (user_id, source_channel, source)
-- WHERE source_channel LIKE 'discovered\_%'`. A PARTIAL index is usable only when
-- the planner can prove the query's WHERE implies the index predicate. The lookup
-- says `source_channel = <channel>`, and LIKE is not a btree comparison operator,
-- so the planner cannot derive `LIKE 'discovered\_%'` from that equality: not from
-- a bind parameter under a generic plan, and not from a literal constant under a
-- custom plan either. 048's index is chosen only when a query repeats the LIKE
-- clause verbatim, which PostgREST's `source_channel=eq.` never does. The lookup
-- therefore falls back to `idx_artifacts_source_channel (source_channel)` or a seq
-- scan, which for the big channel means ~150k heap fetches of wide rows
-- (plain_text, embeddings, search_vector). The small channels answer fast on the
-- same fallback; the big one times out.
--
-- Reproduced locally on 2026-09-29: PostgreSQL 18, a synthetic 158k-row artifacts
-- table with 048's and remote_schema.sql's indexes and prod's channel mix. This
-- is NOT a prod measurement. The same prepared lookup, EXPLAIN (ANALYZE, BUFFERS):
--   before 118, custom plan    Parallel Seq Scan on artifacts, ~19.7k buffers
--   before 118, generic plan   Index Scan using idx_artifacts_source_channel,
--                              Rows Removed by Filter: 149950, ~18.9k buffers
--   + a literal LIKE clause    Index Scan using idx_artifacts_discovered_external
--   after 118, custom plan     Index Scan using idx_artifacts_user_channel_source, 54 buffers
--   after 118, generic plan    Index Scan using idx_artifacts_user_channel_source, 54 buffers
-- Prod's plan has not been measured: the session that wrote this had no SQL
-- access to the project. The PR carries the EXPLAIN to run before and after the
-- push, and #1207 stays open until that and a `status='ok'` gdrive run are recorded.
--
-- THE FIX. The same key columns with NO predicate, so the lookup's three equality
-- conditions (user_id, source_channel, source = ANY) are index conditions under a
-- custom OR a generic plan. 048's partial UNIQUE index stays: it is what keeps
-- re-discovery idempotent, and dropping it would be a separate, destructive change.
-- The planner uses this index only when it prices it cheaper, so it cannot make an
-- existing query slower. It costs one more index to maintain on artifacts writes.
--
-- NON-PARTIAL MEANS EVERY ROW'S `source` IS A KEY. A btree tuple over ~2700 bytes
-- (after compression) fails with "index row size exceeds btree version 4 maximum".
-- Before pushing, `SELECT max(octet_length(source)) FROM public.artifacts;` must be
-- well under that, or this CREATE fails and blocks the push. capture's
-- `source_url` (the one writer that stores a caller-supplied string here) is capped
-- at 2048 characters in the same change.
--
-- NOT CONCURRENTLY: `supabase db push` sends this file as one multi-statement
-- query, which Postgres runs as an implicit transaction block, and CREATE INDEX
-- CONCURRENTLY refuses to run inside one. A plain build takes a SHARE lock (writes
-- to artifacts wait; reads do not) for the few seconds a ~157k-row build takes.
--
-- ===== 2. discover_envelope_refresh(p_user_id, p_rows) (#1228) =================
--
-- WHAT IT IS FOR. A pointer discovered before #1228 has no envelope (mime_type,
-- size, parents, owner_email). The first relist that sees it merges one in
-- (discoverItems' needsEnvelopeRefresh). On the first full personal-Drive relist
-- after this ships, that is every existing pointer, ~150k rows. This function takes
-- one discoverItems batch (at most 200 rows) and updates it in ONE statement. The
-- first version sent one PATCH per row, 8 at a time: ~150k HTTP round trips, and 8
-- PostgREST connections held for the whole backfill.
--
-- WHAT IT DOES. For each {id, envelope, drive_file_id, parent_ids, dequeue} in
-- p_rows, where the row belongs to p_user_id and its stored discovery block has no
-- mime_type yet:
--   - processing_metadata.discovery := the STORED discovery block || envelope. The
--     merge happens here, against the row as it is now, so keys enrich wrote after
--     the caller's lookup survive. The PATCH version wrote back the object it had
--     read, and could lose them.
--   - source_drive_file_id / source_parent_folder_ids := the given value, or the
--     stored one when the given value is null. Never nulled.
--   - processing_status := 'completed' when dequeue is true and the row is still at
--     lifecycle 'discovered' (a Drive folder leaving the enrich queue). Otherwise it
--     is unchanged, so a row enrich already moved on is left alone.
-- It returns the number of rows updated. The mime_type guard makes a replay a no-op.
--
-- COST (the part to plan around). Every one of these updates is non-HOT:
-- processing_metadata is in GIN idx_artifacts_processing_metadata
-- (remote_schema.sql), so each writes a new heap tuple and a new entry in every
-- index on artifacts whose predicate the row meets. That includes several GIN
-- indexes and the HNSW artifacts_embedding_idx (migration 051), which stores the
-- whole 1536-d vector per entry. Migration 041's AFTER UPDATE trigger also runs
-- to_jsonb(OLD) and to_jsonb(NEW) over the whole row, embedding included. It inserts
-- an edit-log row only when a tracked column changes, which here means only the
-- dequeued folders. Going set-based removes the round trips and the held
-- connections, not that per-row work. Expect the backfill run to leave ~150k dead
-- tuples and larger indexes (HNSW the largest, up to ~1 GB of growth), and run
-- `VACUUM (ANALYZE) public.artifacts;` once it has finished (a post-deploy step in
-- the PR). It happens once: after the first full relist, Drive discover is
-- incremental and only newly modified files reach this path.
--
-- SECURITY INVOKER, EXECUTE for service_role only. The function updates whatever
-- rows the caller names (under its user_id filter), so the client roles get no
-- EXECUTE. Supabase grants EXECUTE on new public functions to anon and
-- authenticated by default. mcp-server calls it with the service-role key and its
-- own user id, like every other artifacts write in discoverItems.
--
-- ===== 3. Drive column comments (#1228) ========================================
--
-- 052 described source_drive_file_id as "Drive file id for imported Drive
-- artifacts". Since #1228 the Drive discover sweep also fills it on bytes-less
-- discovered_* pointers. That is how meetingNotesIngest's "already imported?"
-- lookup came to match a pointer; #1228 fixed that reader. These comments now name
-- both writers and how to tell them apart, so the next reader does not repeat it.
--
-- `SET`, not `SET LOCAL` (AGENTS.md; runbook "db push and transactions"): the
-- migration role's own statement_timeout is what killed migration 104's backfill,
-- and `SET LOCAL` is a silent no-op outside an explicit transaction block.
--
-- RE-RUN: `IF NOT EXISTS` makes the CREATE INDEX a no-op the second time; CREATE OR
-- REPLACE, REVOKE, GRANT and COMMENT all rewrite the same state.

SET statement_timeout = '30min';

-- 1. The lookup index.

CREATE INDEX IF NOT EXISTS idx_artifacts_user_channel_source
  ON public.artifacts USING btree (user_id, source_channel, source);

COMMENT ON INDEX public.idx_artifacts_user_channel_source IS
  'Non-partial (user_id, source_channel, source) btree for discoverItems() existing-row lookups (#1207). The lookup filters source_channel by equality, from which the planner cannot prove the LIKE predicate of the partial idx_artifacts_discovered_external (migration 048), so that index never serves it; 048 remains the idempotency guard. Migration 118; see its header.';

-- 2. The set-based envelope refresh.

CREATE OR REPLACE FUNCTION public.discover_envelope_refresh(p_user_id uuid, p_rows jsonb)
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH r AS (
    SELECT *
    FROM jsonb_to_recordset(p_rows)
      AS r(id uuid, envelope jsonb, drive_file_id text, parent_ids text[], dequeue boolean)
  ),
  updated AS (
    UPDATE public.artifacts a
       SET processing_metadata = jsonb_set(
             COALESCE(a.processing_metadata, '{}'::jsonb),
             '{discovery}',
             (CASE
                WHEN jsonb_typeof(a.processing_metadata -> 'discovery') = 'object'
                  THEN a.processing_metadata -> 'discovery'
                ELSE '{}'::jsonb
              END) || COALESCE(r.envelope, '{}'::jsonb)
           ),
           source_drive_file_id = COALESCE(r.drive_file_id, a.source_drive_file_id),
           source_parent_folder_ids = COALESCE(r.parent_ids, a.source_parent_folder_ids),
           processing_status = CASE
             WHEN r.dequeue IS TRUE AND a.lifecycle_stage = 'discovered' THEN 'completed'
             ELSE a.processing_status
           END
      FROM r
     WHERE a.id = r.id
       AND a.user_id = p_user_id
       AND jsonb_typeof(COALESCE(a.processing_metadata, '{}'::jsonb)) = 'object'
       AND a.processing_metadata #>> '{discovery,mime_type}' IS NULL
    RETURNING a.id
  )
  SELECT count(*)::integer FROM updated;
$$;

REVOKE ALL ON FUNCTION public.discover_envelope_refresh(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discover_envelope_refresh(uuid, jsonb) TO service_role;

COMMENT ON FUNCTION public.discover_envelope_refresh(uuid, jsonb) IS
  'Set-based envelope refresh for discovered pointers (#1228): merges each p_rows[].envelope into the stored processing_metadata.discovery of rows owned by p_user_id that have no discovery.mime_type yet, fills source_drive_file_id / source_parent_folder_ids without ever nulling them, and moves a still-discovered row to processing_status completed when dequeue is true. One statement per discoverItems batch (at most 200 rows). Returns the number of rows updated. Every update is non-HOT; see the migration 118 header for the one-time backfill cost and the post-backfill VACUUM.';

-- 3. The Drive columns, now written by two paths.

COMMENT ON COLUMN public.artifacts.source_drive_file_id IS
  'Drive file id. Written by TWO paths: drive_import_file / ingest_drive (source_channel google_drive, bytes stored in the app bucket) AND the Drive discover sweep on discovered_gdrive* pointers (storage_bucket external, no bytes; #1228, migration 118). Filter on source_channel (or storage_bucket) to tell an imported file from a pointer; the same Drive file can have one of each (ADR-069: two atoms).';

COMMENT ON COLUMN public.artifacts.source_parent_folder_ids IS
  'Drive parent folder ids as of when the row was last written: at import by drive_import_file / ingest_drive, or by the Drive discover sweep on discovered_gdrive* pointers (#1228, migration 118), which rewrites them only when the source reports a content change (plus once, via discover_envelope_refresh, for pointers that predate #1228). A move alone does not update them, so treat them as last-known, not live. Filter on source_channel to tell imports from pointers.';
