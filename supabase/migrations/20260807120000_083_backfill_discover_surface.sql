-- Migration: backfill artifacts.surface for existing discover-path rows
-- ADR: ADR-046 §2/§3 (per-source ingestion policy — envelope metadata, role
--      ladder), ADR-026 (rationalised provenance & derived trust)
-- Issue: #570 (Discovered artifacts carry no surface, so ADR-046's role gate
--        cannot apply to them) — read-side diagnosis in #567
-- Date: 2026-08-07
--
-- Context: the discover write path (discoverItems() in
-- packages/mcp-server/src/tools/discover.ts) now stamps
-- `artifacts.surface = artifacts.source_channel` at write time (companion
-- code change in this PR), so every NEW discover-path pointer resolves in
-- both ADR-026's surface→trust derivation and ADR-046 §3's surface→role
-- derivation. This migration is the one-time backfill for rows written
-- BEFORE that change landed — without it, historical `discovered_gdrive` (and
-- any other `discovered_<connector>`) rows stay permanently un-gateable: no
-- role, trust falling back to the bare default instead of provenance.
--
-- Scope: every artifacts row whose source_channel follows the discover write
-- path's `discovered_<connector>` convention (see discoverItems()) and whose
-- surface is still NULL. Not limited to `discovered_gdrive` — every discover
-- connector (Notion included) gets the same fix for the same reason.
--
-- WHY THE TRIGGER IS SUPPRESSED (do not remove without reading this):
-- `update_artifacts_updated_at` (migration 010, step 14) is a BEFORE UPDATE …
-- FOR EACH ROW trigger whose function sets `NEW.updated_at = NOW()`
-- unconditionally, so it cannot be defeated from the SET clause. Left live,
-- this backfill would stamp `updated_at = NOW()` on every historical discover
-- row it touches. `searchArtifacts` in packages/web/utils/knowledge/api.ts
-- orders on `updated_at DESC`, so the first `supabase db push` after this
-- lands would push a decade of backfilled Drive pointers to the top of every
-- knowledge search in the web app — the #567 flood shape relocated into the
-- web UI, and irreversible, since the original timestamps would be gone.
-- Disabling the trigger for the duration of the UPDATE preserves each row's
-- real `updated_at`, which is the honest outcome: this migration changes a
-- provenance field the row always should have had, it is not a content edit.
--
-- Safety: DML plus a transient trigger-state toggle — no column changes,
-- nothing dropped, no data destroyed. The CLI runs each migration file in a
-- transaction, and ALTER TABLE … DISABLE TRIGGER is transactional in Postgres,
-- so a failure anywhere in this file rolls the trigger back to enabled along
-- with the UPDATE; the table cannot be left with the trigger off. DISABLE/
-- ENABLE TRIGGER each take a brief ACCESS EXCLUSIVE lock on `artifacts` —
-- acceptable for a one-time backfill, and the reason this is scoped to the
-- single named trigger rather than `DISABLE TRIGGER ALL` (which would also
-- silence FK and RLS-adjacent triggers).
-- Idempotent — re-running touches zero rows the second time, since the WHERE
-- clause only ever matches rows still missing `surface`.
--
-- NOT APPLIED BY THIS COMMIT. Per AGENTS.md, prod schema/data changes reach
-- prod ONLY via `supabase db push` run by a human from a clean clone of main —
-- never via an agent session, never via the Supabase MCP `apply_migration` /
-- `execute_sql` tools. Review this file, then run it through that path.

ALTER TABLE public.artifacts DISABLE TRIGGER update_artifacts_updated_at;

UPDATE public.artifacts
SET surface = source_channel
WHERE surface IS NULL
  AND source_channel IS NOT NULL
  AND starts_with(source_channel, 'discovered_');

ALTER TABLE public.artifacts ENABLE TRIGGER update_artifacts_updated_at;
