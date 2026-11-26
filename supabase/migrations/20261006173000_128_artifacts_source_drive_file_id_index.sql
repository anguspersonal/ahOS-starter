-- Migration 128: index for artifacts lookup by source_drive_file_id
-- Issue: #1368 (ingest_meeting_notes times out on 'Artifact lookup by Drive file id')
-- Date:  2026-10-06
--
-- WHAT BROKE:
-- findArtifactByDriveFileId in meetingNotesIngest.ts and dedup in ingest_drive
-- query artifacts by user_id and source_drive_file_id:
--
--   GET /artifacts?select=id,title...
--       &user_id=eq.<u>&source_drive_file_id=eq.<id>&or=(source_channel.is.null,source_channel.not.like.discovered_*)
--
-- The artifacts table has ~158k rows (mostly discovered_gdrive pointers).
-- With no index on source_drive_file_id, this query performs a full sequential scan
-- of wide heap rows, exceeding the statement_timeout (57014) on production.
--
-- THE FIX:
-- A btree index on (user_id, source_drive_file_id). This allows the planner to
-- immediately narrow down candidates to O(1) matching rows before applying the
-- filter on source_channel, returning well within the timeout.
--
-- `SET statement_timeout`: 30min per repository migration standards (AGENTS.md).
-- Plain SET takes effect for the migration session.

SET statement_timeout = '30min';

CREATE INDEX IF NOT EXISTS idx_artifacts_user_source_drive_file_id
  ON public.artifacts USING btree (user_id, source_drive_file_id);
