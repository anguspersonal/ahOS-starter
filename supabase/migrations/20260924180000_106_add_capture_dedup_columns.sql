-- Migration: add capture dedup columns to artifacts (issue #993 — capture-side double
-- submission)
-- Date: 2026-09-24
-- Purpose:
--   `capture` had no idempotency guard at all: a client that retries after a slow or
--   dropped response (observed 5 Sep — the MCP connection dropped mid-write) gets a
--   second row with a new id, identical title/body, identical provenance. Reads that
--   count atoms (dos coverage) or list them (search_knowledge) then show the same event
--   twice. See #993 for the read of the four duplicated rows it names.
--
--   Two independent dedup keys, matching the two ways a caller can ask for idempotency:
--
--   `dedup_key` — an explicit, caller-supplied idempotency key (the same shape as
--   artifact_external_links.dedup_key, migration 064). Scoped to user_id, enforced
--   FOREVER (no time window) by the partial unique index below, so it is the race-safe
--   mechanism: a genuine concurrent double-submit with the same dedup_key gets a real
--   23505 back from Postgres, the same pattern links.ts's claimDedupSlot already uses.
--
--   `content_fingerprint` — a sha256 of the normalised title+body PLUS content_subtype,
--   the resolved surface, the resolved source_channel and sorted tags (see capture.ts's
--   computeContentFingerprint; widened on round-1 QA review of PR #1124 from an initial
--   title+body-only shape that collapsed distinct legitimate captures — see that PR's
--   review for the traced mis-attribution). Computed by capture.ts, not by the database,
--   so normalisation logic stays in one place and is unit-testable without a DB.
--   Deliberately NOT covered by a unique index: capture.ts only treats a fingerprint
--   match as a duplicate within a short trailing window (2 minutes — see
--   CAPTURE_DEDUP_WINDOW_MS), because the same title+body legitimately recurs later (a
--   recurring note, a repeated quote) and a permanent unique constraint would silently
--   eat that. A window has no fixed unique-index shape, so this dedup path is a
--   pre-insert SELECT in application code, not DB-enforced — see capture.ts for the
--   race-safety trade-off this implies. capture.ts also skips this check ENTIRELY for
--   system-produced content_subtypes (SYSTEM_PRODUCED_CONTENT_SUBTYPES in vocab.ts) —
--   the fingerprint column is still written for those rows (for diagnostics/future use),
--   just never matched against, so it stays a faithful record of what was written even
--   though the dedup guard does not read it back for those rows.
--
--   Both columns are additive and nullable, no backfill needed: every existing row simply
--   has both IS NULL (no dedup key was ever recorded, no fingerprint was ever computed
--   for it), which the partial unique index and the window query both ignore. Safe to add
--   immediately — no existing non-NULL data to reconcile. Follows the partial-unique
--   precedent in migration 064 (artifact_external_links.dedup_key) and migration 077
--   (entities.source_url).

ALTER TABLE public.artifacts
  ADD COLUMN IF NOT EXISTS dedup_key text,
  ADD COLUMN IF NOT EXISTS content_fingerprint text;

COMMENT ON COLUMN public.artifacts.dedup_key IS
  'Caller-supplied pre-insert idempotency key for capture (#993). A second capture call with the same (user_id, dedup_key) returns the first artifact''s id instead of inserting — race-safe via the partial unique index artifacts_user_dedup_key_unique, checked forever (no time window). NULL = caller declared no key (the common case, guarded instead by content_fingerprint''s windowed check).';

COMMENT ON COLUMN public.artifacts.content_fingerprint IS
  'sha256(normalised title + body + content_subtype + resolved surface + resolved source_channel + sorted tags), computed by capture.ts, for #993''s default idempotency guard. A second capture call with a matching fingerprint WITHIN CAPTURE_DEDUP_WINDOW_MS (2 minutes, capture.ts) returns the first artifact''s id instead of inserting -- except for system-produced content_subtypes (SYSTEM_PRODUCED_CONTENT_SUBTYPES in vocab.ts), where this column is still written but never matched against. Deliberately not covered by a unique index (a fixed window has no fixed-index shape) — the check is a pre-insert SELECT, not DB-enforced; see capture.ts for the race-safety trade-off. NULL on any row captured before this migration.';

-- Partial unique index (only enforced when dedup_key IS NOT NULL): within one user's
-- artifacts, the same caller-declared idempotency key cannot claim two rows. Scoped to
-- user_id (artifacts is multi-tenant, RLS-scoped), not a bare global (dedup_key), for the
-- same reason as migration 077's entities_user_source_url_unique — the same key string
-- must not let one user's capture block another user's. Safe to add immediately: no
-- existing row has a non-NULL dedup_key to violate it.
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_user_dedup_key_unique
  ON public.artifacts (user_id, dedup_key)
  WHERE dedup_key IS NOT NULL;

-- Plain (non-unique) index so the windowed content_fingerprint lookup capture.ts runs
-- before every insert (WHERE user_id = ? AND content_fingerprint = ? AND created_at >=
-- ?) stays index-backed rather than scanning every one of a user's artifacts on every
-- capture.
CREATE INDEX IF NOT EXISTS artifacts_user_content_fingerprint_idx
  ON public.artifacts (user_id, content_fingerprint, created_at)
  WHERE content_fingerprint IS NOT NULL;

-- Migration complete: artifacts.dedup_key / content_fingerprint ready for capture's
-- idempotency guard (#993).
