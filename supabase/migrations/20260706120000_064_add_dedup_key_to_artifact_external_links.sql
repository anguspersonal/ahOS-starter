-- Migration: Add dedup_key to artifact_external_links (issue #141 — EOD Act dedup)
-- Date: 2026-07-06
-- Purpose:
--   ADR-013 §5's artifact_external_links table is 1->many: one artifact can spawn
--   several external items (several tasks from one transcript). The existing unique
--   constraint (artifact_id, provider, kind, external_id) already makes re-recording
--   the SAME created item idempotent, but it cannot express "don't create a SECOND
--   task for the same logical to-do inside this atom" ahead of time — the caller only
--   learns the external_id after creating it in Notion.
--
--   `dedup_key` is a caller-supplied, pre-creation idempotency key (e.g. a stable hash
--   or slug of the task's title/step) scoped to (artifact_id, provider, kind). A NULL
--   dedup_key means "no per-item key" (the common 1:1 case, guarded instead by
--   create_task's `single_task` any-link-exists check). A non-NULL dedup_key lets the
--   1:N case (e.g. process_artifact's eager Act spinning out several tasks from one
--   transcript, followed later by an EOD Act pass over the same atom) look up "have I
--   already created THIS task" before calling out to Notion again.
--
--   Additive nullable column, no backfill needed: this is a brand-new column, so every
--   existing row simply has dedup_key IS NULL (which the partial unique index below
--   ignores) — there is no pre-existing non-NULL data to reconcile, so there is nothing
--   to dedupe here. That also means the new constraint is safe to add immediately: it
--   only applies to rows where dedup_key IS NOT NULL, and no such rows exist yet.

ALTER TABLE public.artifact_external_links
  ADD COLUMN IF NOT EXISTS dedup_key text;

COMMENT ON COLUMN public.artifact_external_links.dedup_key IS
  'Caller-supplied pre-creation idempotency key for the 1->many Act case (e.g. one task among several spawned from a transcript). NULL for links with no per-item key (the 1:1 case, guarded by create_task''s single_task check instead). Scoped to (artifact_id, provider, kind) via the partial unique index below.';

-- Partial unique index (only enforced when dedup_key is set): the same logical task
-- cannot be recorded twice for the same artifact/provider/kind. Safe to add immediately
-- (no backfill/dedupe pass needed first) because no existing row has a non-NULL
-- dedup_key to violate it.
CREATE UNIQUE INDEX IF NOT EXISTS artifact_external_links_dedup_key_unique
  ON public.artifact_external_links (artifact_id, provider, kind, dedup_key)
  WHERE dedup_key IS NOT NULL;

-- Migration complete: artifact_external_links.dedup_key ready for per-item Act dedup.
