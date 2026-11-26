-- Migration 085: evaluate the `artifacts` RLS auth call ONCE PER STATEMENT
-- Issue: #596 (PROD BROKEN — artifacts queries time out: 151,554 rows meets
--        per-row RLS auth re-evaluation)
-- Refs:  https://supabase.com/docs/guides/database/database-linter?lint=0003_auth_rls_initplan
--        docs/guides/SUPABASE_MIGRATION_HISTORY_RUNBOOK.md (the write path)
-- Date:  2026-08-07
--
-- WHAT BROKE
-- `public.artifacts` holds 151,554 rows (verified read-only via list_tables on
-- project YOUR_PROJECT_REF; every other table in the schema is under 400).
-- All four RLS policies on the table call `auth.uid()` BARE. Postgres treats a
-- bare volatile-ish function call in a policy predicate as row-dependent and
-- re-evaluates it for EVERY candidate row — 151,554 calls per query. Even
-- `select id where user_id = <uuid>`, which the composite index
-- `idx_artifacts_user_created_at` (migration 032) should answer as an
-- index-only scan, dies with `canceling statement due to statement timeout`.
-- The Supabase performance advisor flags all four as `auth_rls_initplan` WARN.
--
-- THE FIX
-- Wrap the call: `(select auth.uid())`. The subquery is uncorrelated — it
-- references no column of the row being tested — so the planner hoists it into
-- an InitPlan, evaluates it once per statement, and reuses the scalar for every
-- row. This is the documented Supabase remedy for lint 0003.
--
-- SEMANTICS ARE IDENTICAL — this is the load-bearing claim of this migration,
-- because `artifacts` holds the owner's entire personal corpus and a policy
-- rewrite that widens access would be far worse than the timeout it fixes:
--
--   before                       after
--   ---------------------------  -------------------------------------
--   user_id = auth.uid()         user_id = (select auth.uid())
--
-- `auth.uid()` is a single-row scalar function, so `(select auth.uid())` is a
-- scalar subquery returning exactly that same value. The comparison operator,
-- the column, and the null behaviour are untouched: when `auth.uid()` is NULL
-- (anon / no JWT), `user_id = NULL` evaluates to NULL and the row is filtered
-- out in both forms. No row that was previously invisible becomes visible; no
-- row that was previously visible disappears. Only the number of times the
-- function is called changes.
--
-- WHY `ALTER POLICY` AND NOT `DROP POLICY` + `CREATE POLICY`
-- `ALTER POLICY … USING/WITH CHECK` changes ONLY the named expression. The
-- policy's command (`FOR INSERT` / `SELECT` / `UPDATE` / `DELETE`), its
-- permissive-vs-restrictive kind, and its role list (`TO authenticated`) are
-- carried over untouched — they cannot be accidentally widened by a typo in a
-- re-CREATE. Under DROP+CREATE, forgetting `TO authenticated` would silently
-- publish the policy to `public` (which includes `anon`). ALTER also never
-- leaves a window in which the table has no policy for that command. It fails
-- loudly if a policy name does not exist, which is the behaviour we want:
-- better a failed push than a silently-created extra policy.
--
-- SCOPE: `public.artifacts` ONLY. The same `auth_rls_initplan` warning fires
-- 84 times across this schema; the other 80 are deliberately left for separate
-- migrations (#596 scopes itself to the table that is actually down). No rows
-- are read, written, archived, or deleted here — what happens to the 151k
-- backfill rows is a data decision recorded as AC4 on #596, not a schema one.
--
-- SAFETY: four `ALTER POLICY` statements. No table, column, index, constraint,
-- function, or trigger is created, dropped, or altered; no DML. Each ALTER
-- takes a brief ACCESS EXCLUSIVE lock on `artifacts`. The CLI runs the file in
-- a transaction, so a failure in any statement rolls all four back.
--
-- VERIFY BEFORE PUSHING (the repo file below is the source of truth for the
-- CURRENT definitions — no migration after 20251226182232_remote_schema.sql
-- touches these four policies — but confirm against the live database first,
-- per the runbook's "verify the live schema BEFORE trusting" rule):
--
--   SELECT policyname, cmd, permissive, roles, qual, with_check
--   FROM pg_policies
--   WHERE schemaname = 'public' AND tablename = 'artifacts'
--   ORDER BY policyname;
--
-- Expected BEFORE: qual/with_check read `(user_id = auth.uid())`.
-- Expected AFTER:  `(user_id = ( SELECT auth.uid() AS uid))`, with cmd,
--                  permissive and roles unchanged from the before row.
--
-- NOT APPLIED BY THIS COMMIT. Per AGENTS.md and the migration-history runbook,
-- prod DDL reaches prod ONLY via `supabase db push` run by a human from a
-- clean clone of `main` — file → PR → merge → push. Never via an agent
-- session, never via the Supabase MCP `apply_migration` / `execute_sql` tools.

-- 1/4 — INSERT. Before: with check ((user_id = auth.uid()))
ALTER POLICY "Users can create their own artifacts"
  ON public.artifacts
  WITH CHECK (user_id = (SELECT auth.uid()));

-- 2/4 — DELETE. Before: using ((user_id = auth.uid()))
ALTER POLICY "Users can delete their own artifacts"
  ON public.artifacts
  USING (user_id = (SELECT auth.uid()));

-- 3/4 — UPDATE. Before: using ((user_id = auth.uid()))
--                       with check ((user_id = auth.uid()))
ALTER POLICY "Users can update their own artifacts"
  ON public.artifacts
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- 4/4 — SELECT. Before: using ((user_id = auth.uid()))
ALTER POLICY "Users can view their own artifacts"
  ON public.artifacts
  USING (user_id = (SELECT auth.uid()));
