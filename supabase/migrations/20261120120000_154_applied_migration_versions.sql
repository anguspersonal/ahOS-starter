-- Migration 154: applied_migration_versions(), a read-only view of migration history
-- Issue: #2269 (ahos_doctor outcomes: report migrations on main that are not applied)
-- Date:  2026-11-20
--
-- WHY:
-- On 2026-11-20 production's migration history stopped at 151 while `main` carried 152
-- (for ten days) and 153. Nothing reported it: the #2257 fix was merged and deployed
-- but its indexes did not exist. `ahos_doctor` could not see the gap, because
-- supabase_migrations.schema_migrations is not exposed through PostgREST.
--
-- WHAT:
-- One function returning the applied version strings, so the server can compare them
-- with the migration files it was built with. Versions only: no names, no statements.
--
-- SECURITY DEFINER because the server's role cannot read the supabase_migrations
-- schema directly. search_path is pinned empty and every relation is schema-qualified.
-- Execute is granted to service_role alone, the same grant shape as
-- action_ledger_stats() (migration 144).
--
-- Additive and backward-compatible: nothing deployed calls it before this lands, and
-- the doctor check reports the function's own absence as "this migration is unapplied".

CREATE OR REPLACE FUNCTION public.applied_migration_versions()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT m.version::text
    FROM supabase_migrations.schema_migrations m
    ORDER BY m.version;
$$;

COMMENT ON FUNCTION public.applied_migration_versions() IS
  'Applied migration version strings from supabase_migrations.schema_migrations, for the ahos_doctor "migrations applied" outcome check. Read-only; versions only. Issue #2269, migration 154.';

REVOKE ALL ON FUNCTION public.applied_migration_versions() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.applied_migration_versions() TO service_role;
