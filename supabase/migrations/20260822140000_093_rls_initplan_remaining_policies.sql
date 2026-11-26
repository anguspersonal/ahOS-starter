-- Migration 093: evaluate EVERY remaining RLS auth call ONCE PER STATEMENT
-- Issue: #601 (80+ remaining `auth_rls_initplan` warnings — the same defect
--        that took prod down in #596)
-- Refs:  #596 (the outage) · #598 / migration 085 (the same fix on `artifacts`,
--        which established this repo's pattern)
--        https://supabase.com/docs/guides/database/database-linter?lint=0003_auth_rls_initplan
--        docs/guides/SUPABASE_MIGRATION_HISTORY_RUNBOOK.md (the write path)
-- Date:  2026-08-22
--
-- WHAT IS WRONG
-- A bare `auth.uid()` / `auth.jwt()` / `auth.email()` in an RLS predicate is
-- re-evaluated by Postgres for EVERY candidate row. On a small table that is
-- invisible. On `public.artifacts` at 151k rows it was an outage (#596): the
-- table simply stopped serving. Migration 085 fixed the four `artifacts`
-- policies. This migration fixes every other one.
--
-- Wrapping the call in a scalar subquery — `(SELECT auth.uid())` — makes the
-- expression uncorrelated (it references no column of the row under test), so
-- the planner hoists it into an InitPlan, evaluates it ONCE per statement, and
-- reuses the scalar for every row. That is the documented Supabase remedy for
-- lint 0003, and it is the only change made here.
--
-- SCOPE — 84 policies across 26 tables, every one confirmed to EXIST LIVE
-- The target list is not derived from these migration files. It is the exact
-- set of `auth_rls_initplan` entries returned by the live performance advisor
-- on project `YOUR_PROJECT_REF` (read-only MCP, 2026-08-22). That matters
-- for safety: the advisor reads `pg_policies`, so every policy named below is
-- known to exist under exactly that name, and no `ALTER POLICY` here can fail
-- on a misspelling. `ALTER POLICY` errors loudly on an unknown name, and the
-- CLI runs this file in one transaction, so a wrong name would roll back all
-- 84 statements rather than half-apply them.
--
-- The count is 84, not the 80 quoted on #601. #601 computed 80 as (84 live
-- warnings - 4 on `artifacts`) at a time when 085 was still unapplied. Since
-- then 085 HAS been applied (prod history now runs through 091), so the four
-- `artifacts` entries are gone — and migration 084 introduced
-- `public.alert_condition_state` with four fresh per-row policies of its own.
-- 84 - 4 + 4 = 84. `public.artifacts` is absent from the list below, which is
-- the positive confirmation that 085 landed and is holding.
--
-- SEMANTICS ARE IDENTICAL — the load-bearing claim
-- A policy rewrite that widens access would be far worse than a slow query, so
-- this is the claim to attack. Each `ALTER` below carries the current
-- predicate on a `-- before:` line; the statement under it is that same string
-- with `auth.fn()` replaced by `(SELECT auth.fn())` and NOTHING else changed —
-- same operators, same columns, same parenthesisation, same casts, same
-- subqueries. This was generated and then machine-checked by reversing the
-- substitution and asserting the result is byte-identical to the original.
--
--   * `auth.uid()`, `auth.jwt()` and `auth.email()` are single-row STABLE
--     scalar functions, so `(SELECT auth.uid())` is a scalar subquery yielding
--     that same one value — never zero rows, never many.
--   * NULL behaviour is unchanged. Unauthenticated, `auth.uid()` is NULL, so
--     `user_id = NULL` is NULL, which is not TRUE, so the row is filtered. The
--     wrapped form yields NULL identically. Anon access does not widen.
--   * The auth call is never correlated — these functions take no arguments
--     and read no column — so hoisting it can never change which rows match.
--   * Where the call sits inside an `EXISTS (...)` subquery, the wrap is
--     applied in place; the subquery's own correlation to the outer row (e.g.
--     `a.id = artifact_edit_log.artifact_id`) is untouched.
--
-- WHY `ALTER POLICY` AND NOT `DROP` + `CREATE`
-- Per the PostgreSQL documentation, `ALTER POLICY` can change only the role
-- list and the `USING` / `WITH CHECK` expressions. The command it applies to
-- (`FOR SELECT` / `INSERT` / `UPDATE` / `DELETE` / `ALL`) and its
-- permissive-vs-restrictive kind CANNOT be changed by this statement at all —
-- to change those the policy must be dropped and recreated. On tables holding
-- personal data that structural guarantee is worth more than the performance
-- win, and it is why DROP+CREATE is not used here: a re-CREATE that forgot a
-- clause would silently publish a wider policy, and would leave a window in
-- which the table had no policy for that command.
--
-- The role list is the ONE property `ALTER POLICY` *can* change — via a `TO`
-- clause. No statement below has a `TO` clause, so no role list moves. (This
-- is the precision correction that #598's review asked for; the earlier
-- wording claimed roles were structurally immutable, which is not true.)
--
-- Omitting a clause is also safe in the other direction: "when one of those
-- clauses is omitted, the corresponding part of the policy is unchanged". So
-- the `FOR ALL` policies below that carry a `USING` and no `WITH CHECK` keep
-- `with_check` NULL — this migration does not invent one.
--
-- EXPLICITLY LEFT ALONE (see the PR body for the full reasoning)
--   * 4 policies on `public.workflow_steps` — they contain the same bare
--     `auth.uid()`, but RLS is DISABLED on that table, so they are inert and
--     the advisor does not report them. Because they are unreported I cannot
--     confirm from here that they still exist under those names, and one wrong
--     name would roll back all 84 confirmed fixes. They must be wrapped in the
--     SAME migration that enables RLS on the table — that is an owner
--     decision, tracked separately.
--   * 5 policies on `storage.objects` (migration 023). Different schema, not
--     reported by the advisor, and owned by the storage extension rather than
--     by us.
--   * The 6 tables with RLS disabled entirely (`workflow_steps`,
--     `training_examples`, `discovered_patterns`, `teams`, `scheduler_runs`,
--     `scheduler_locks`). Out of scope by #601's own framing: enabling RLS
--     without policies blocks all access, so it needs an owner decision.
--   * The 78 `multiple_permissive_policies` warnings. A different lint with a
--     different remedy (merging or dropping policies), which WOULD change the
--     access surface. Not bundled with an inert rewrite.
--
-- IDEMPOTENT / RE-RUNNABLE. `ALTER POLICY ... USING (expr)` sets the predicate
-- to `expr`; running it twice is the same as running it once. Re-running this
-- whole file is a no-op. There is no DDL here beyond `ALTER POLICY` — no
-- table, column, index, constraint, function or trigger is created, dropped or
-- altered — and no DML: not a single row is read, written or deleted.
--
-- LOCKING. Each `ALTER POLICY` takes a brief ACCESS EXCLUSIVE lock on its
-- table. All 26 tables targeted here are small — the largest is
-- `artifact_edit_log` at 1,161 rows and 21 of the 26 hold 0 rows — and the
-- locks are metadata-only (no table rewrite, no scan), so the push is fast.
-- The one large table in the schema, `artifacts` (153,113 rows), is NOT among
-- the 26 and is not touched by this migration.
--
-- The 84 statements run in ONE transaction, so those locks are held from the
-- first statement until COMMIT rather than released per statement. If any of
-- the 26 tables is mid-query the migration would otherwise queue behind it
-- while already holding locks on the tables it has altered, so the file opens
-- with `SET LOCAL lock_timeout = '5s'` to fail fast and roll back cleanly
-- instead. `SET LOCAL` (not `SET`) is deliberate: it reverts at COMMIT, so the
-- timeout cannot leak into whatever migration the CLI runs next in the same
-- session, and if the file is ever run outside a transaction block it
-- degrades to a warning and a no-op rather than an error.
--
-- ============================================================================
-- VERIFY BEFORE PUSHING — run the dry run below, do not eyeball the file
-- ============================================================================
-- The predicates below were read from this repo's migration files (latest
-- definition wins), not from the live database: the read-only MCP available to
-- the authoring session exposes policy NAMES via the advisor but not policy
-- BODIES. So one risk survives every proof in the PR — a live policy body
-- could differ from what its `-- before:` line assumes, in which case the
-- `ALTER` would silently overwrite the live predicate with the file's version.
-- If a body had been hand-tightened out of band, that WIDENS access.
--
-- Do NOT try to check this by comparing the `-- before:` lines to `pg_policies`
-- by eye. They are not comparable: the `-- before:` lines are source verbatim,
-- while `pg_policies.qual` is Postgres's deparsed normalisation of the parsed
-- tree — it strips schema qualification, re-parenthesises AND/OR operands and
-- inserts newlines. Measured on a real cluster, 45 of the 100 clauses differ
-- textually for that reason alone. An operator told to eyeball them meets 45
-- apparent mismatches on the most safety-critical step, which trains them to
-- wave the output through — and that is exactly where a real drift would hide.
--
-- Instead run this ROLLED-BACK DRY RUN in one psql session against prod, from
-- a clean clone of `main`, immediately before the real push. Both sides then
-- come from `pg_policies` in prod's own deparsed vocabulary, so the formatting
-- difference cannot arise, and the check is upgraded from "does the name
-- exist" to "is the live body what we assumed". Nothing is committed.
--
--   \set ON_ERROR_STOP on
--
--   -- 1) Snapshot the live BEFORE state. OUTSIDE the transaction, so it
--   --    survives the ROLLBACK.
--   DROP TABLE IF EXISTS pol_before;
--   CREATE TEMP TABLE pol_before AS
--     SELECT tablename, policyname, cmd, permissive, roles::text AS roles,
--            qual, with_check
--     FROM pg_policies
--     WHERE schemaname = 'public';
--
--   -- 2) Apply this migration inside a transaction that is thrown away.
--   BEGIN;
--   \i supabase/migrations/20260822140000_093_rls_initplan_remaining_policies.sql
--
--   -- 3) THE GATE.  EXPECT: 0 rows.
--   --    NOTE both sides are un-wrapped, not just the AFTER side. Some public
--   --    policies are ALREADY wrapped — migration 085 did the four on
--   --    `artifacts` — and 093 does not touch them. Un-wrapping only AFTER
--   --    compares their wrapped BEFORE against their un-wrapped AFTER and
--   --    reports four drifts that are not there. Un-wrap both and the
--   --    comparison is "equal modulo the wrap", which is exactly the
--   --    equivalence this migration claims.
--   WITH b AS (
--     SELECT tablename, policyname, cmd, permissive, roles,
--            regexp_replace(qual,
--              '\( SELECT (auth\.[a-z_]+\(\)) AS \w+\)', '\1', 'g') AS q,
--            regexp_replace(with_check,
--              '\( SELECT (auth\.[a-z_]+\(\)) AS \w+\)', '\1', 'g') AS w,
--            qual AS raw_qual, with_check AS raw_check
--     FROM pol_before
--   ), a AS (
--     SELECT tablename, policyname, cmd, permissive, roles::text AS roles,
--            regexp_replace(qual,
--              '\( SELECT (auth\.[a-z_]+\(\)) AS \w+\)', '\1', 'g') AS q,
--            regexp_replace(with_check,
--              '\( SELECT (auth\.[a-z_]+\(\)) AS \w+\)', '\1', 'g') AS w
--     FROM pg_policies
--     WHERE schemaname = 'public'
--   )
--   SELECT tablename, policyname,
--          concat_ws('; ',
--            CASE WHEN a.policyname IS NULL THEN 'policy DISAPPEARED' END,
--            CASE WHEN b.policyname IS NULL THEN 'policy APPEARED' END,
--            CASE WHEN b.cmd        IS DISTINCT FROM a.cmd
--                 THEN 'cmd ' || b.cmd || ' -> ' || a.cmd END,
--            CASE WHEN b.permissive IS DISTINCT FROM a.permissive
--                 THEN 'permissive ' || b.permissive || ' -> ' || a.permissive END,
--            CASE WHEN b.roles      IS DISTINCT FROM a.roles
--                 THEN 'roles ' || b.roles || ' -> ' || a.roles END,
--            CASE WHEN b.q          IS DISTINCT FROM a.q
--                 THEN 'live USING body is not what the -- before: line assumes' END,
--            CASE WHEN b.w          IS DISTINCT FROM a.w
--                 THEN 'live WITH CHECK body is not what the -- before: line assumes' END
--          ) AS what_moved,
--          b.raw_qual AS live_using_before, b.raw_check AS live_check_before
--   FROM b
--   FULL JOIN a USING (tablename, policyname)
--   WHERE a.policyname IS NULL
--      OR b.policyname IS NULL
--      OR b.cmd        IS DISTINCT FROM a.cmd
--      OR b.permissive IS DISTINCT FROM a.permissive
--      OR b.roles      IS DISTINCT FROM a.roles
--      OR b.q          IS DISTINCT FROM a.q
--      OR b.w          IS DISTINCT FROM a.w
--   ORDER BY 1, 2;
--
--   -- 4) RECEIPT: prove the gate compared something, and that the migration
--   --    actually did its job.  EXPECT:  97 | 97 | 84 | 100
--   --    The two totals are INFORMATIONAL — they count every policy in the
--   --    `public` schema and will drift upward as the schema grows. The
--   --    ASSERTIONS are the last two: exactly 84 policies rewritten across
--   --    exactly 100 clauses. Those are properties of THIS migration and do
--   --    not move when unrelated policies are added.
--   SELECT (SELECT count(*) FROM pol_before)
--            AS public_before_informational,
--          (SELECT count(*) FROM pg_policies WHERE schemaname = 'public')
--            AS public_after_informational,
--          count(*) FILTER (WHERE b.qual       IS DISTINCT FROM a.qual
--                              OR b.with_check IS DISTINCT FROM a.with_check)
--            AS policies_rewritten,      -- MUST be 84
--          count(*) FILTER (WHERE b.qual       IS DISTINCT FROM a.qual)
--        + count(*) FILTER (WHERE b.with_check IS DISTINCT FROM a.with_check)
--            AS clauses_rewritten        -- MUST be 100
--   FROM pol_before b
--   JOIN (SELECT * FROM pg_policies WHERE schemaname = 'public') a
--     USING (tablename, policyname);
--
--   ROLLBACK;
--
-- HOW TO READ IT
--   * Gate returns 0 rows AND receipt ends in 84 | 100 -> the migration is
--     inert against production as it actually is. Push for real. (The full
--     expected line today is 97 | 97 | 84 | 100.)
--   * Gate returns ANY row -> DO NOT PUSH. A live body is not what this file
--     assumes. The row names the policy, says what moved, and prints the true
--     live predicate (`live_using_before` / `live_check_before`). Report those
--     policy names; the file needs its `-- before:` line and its rewrite
--     corrected before the push.
--   * The dry run aborts with `policy "..." does not exist` -> a policy has
--     been renamed or dropped since enumeration. Same answer: do not push,
--     report the name. Better to learn it here than mid-push.
--   * `policies_rewritten` is not 84, or `clauses_rewritten` is not 100 ->
--     stop. Either you are connected to the wrong database, or the live state
--     has moved since enumeration. Do not push until it is reconciled.
--   * The first two columns being something other than 97 is NOT a failure on
--     its own — they count every `public` policy, so any unrelated policy
--     added since 2026-08-22 moves them. Only the last two are assertions.
--
-- Note what the gate does and does not prove. It proves THIS MIGRATION changes
-- nothing but the wrap, measured against live state. It is not an audit of
-- whether live state is otherwise correct: a pre-existing out-of-band role or
-- command drift is neither caused nor repaired by this file, and the gate will
-- (correctly) stay silent about it.
--
-- Filtering `schemaname = 'public'` INSIDE the CTE rather than in the FULL
-- JOIN's ON clause is load-bearing. Prod carries policies in other schemas
-- (`storage.objects` at least); filtering in the ON clause leaves them
-- unmatched on one side of the full join and reports them as differences —
-- verified, it emits exactly those false positives.
--
-- The whole procedure was tested on a throwaway PostgreSQL 18.1 cluster loaded
-- with a PROD-SHAPED fixture — all 97 `public` policies (the 84 targets still
-- bare, the 4 `artifacts` policies already wrapped by 085, 5 service-role
-- policies with no auth call, and the 4 inert `workflow_steps` policies) plus
-- 5 `storage.objects` policies. Shape matters: an earlier version of this gate
-- passed against a fixture holding only the 84 targets and returned four false
-- drifts the moment the already-wrapped `artifacts` policies were present.
--
--   clean prod-shaped run            -> 0 rows, receipt 97 | 97 | 84 | 100
--   live body hand-tightened         -> exactly 1 row, prints the true predicate
--   live body hand-widened           -> exactly 1 row
--   policy renamed live              -> loud abort naming the policy
--   unrelated extra `public` policy  -> 0 rows, receipt 98 | 98 | 84 | 100
--   `storage` schema policies        -> ignored
--   already-wrapped `artifacts`      -> ignored
--
-- AFTER THE PUSH, run `get_advisors(type: 'performance')` and confirm zero
-- `auth_rls_initplan` entries. That closes AC3 on #601.
--
-- NOT APPLIED BY THIS COMMIT. Per AGENTS.md and the migration-history runbook,
-- prod DDL reaches prod ONLY via `supabase db push` run by a human from a
-- clean clone of `main` after the dev -> main release merge — file -> PR ->
-- merge -> release -> push. Never from an agent session, never via the
-- Supabase MCP `apply_migration` / `execute_sql` tools.


-- All 84 statements run in one transaction, so every ACCESS EXCLUSIVE lock is
-- held until COMMIT. Fail fast rather than queue behind a long-running query
-- while holding locks on 26 tables. `SET LOCAL` reverts at COMMIT so the
-- timeout cannot leak into the next migration of the same push; outside a
-- transaction block it is a warning and a no-op, never an error.
SET LOCAL lock_timeout = '5s';

-- --------------------------------------------------------------------------
-- public.activity_logs — 1 policy   (current definitions: 20251226182232_remote_schema.sql)
-- --------------------------------------------------------------------------

-- 1/84 · SELECT · permissive
-- before: using (((auth.uid() = user_id) OR (user_id IS NULL)))
ALTER POLICY "Users can view their own activity logs" ON public.activity_logs
  USING ((((SELECT auth.uid()) = user_id) OR (user_id IS NULL)));

-- --------------------------------------------------------------------------
-- public.alert_condition_state — 4 policies   (current definitions: 20260807130000_084_alert_condition_state_and_cadence.sql)
-- --------------------------------------------------------------------------

-- 2/84 · DELETE · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can delete own alert condition state" ON public.alert_condition_state
  USING ((SELECT auth.uid()) = user_id);

-- 3/84 · INSERT · permissive
-- before: with check (auth.uid() = user_id)
ALTER POLICY "Users can insert own alert condition state" ON public.alert_condition_state
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- 4/84 · UPDATE · permissive
-- before: using (auth.uid() = user_id)  with check (auth.uid() = user_id)
ALTER POLICY "Users can update own alert condition state" ON public.alert_condition_state
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- 5/84 · SELECT · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can view own alert condition state" ON public.alert_condition_state
  USING ((SELECT auth.uid()) = user_id);

-- --------------------------------------------------------------------------
-- public.artifact_edit_log — 1 policy   (current definitions: 20260308160000_041_artifact_edit_log.sql)
-- --------------------------------------------------------------------------

-- 6/84 · SELECT · permissive
-- before: using ( EXISTS ( SELECT 1 FROM public.artifacts a WHERE a.id = artifact_edit_log.artifact_id AND a.user_id = auth.uid() ) )
ALTER POLICY "Users can view artifact_edit_log for own artifacts" ON public.artifact_edit_log
  USING ( EXISTS ( SELECT 1 FROM public.artifacts a WHERE a.id = artifact_edit_log.artifact_id AND a.user_id = (SELECT auth.uid()) ) );

-- --------------------------------------------------------------------------
-- public.artifact_entity_links — 4 policies   (current definitions: 20260619130000_052_add_user_id_to_relationship_tables.sql)
-- --------------------------------------------------------------------------

-- 7/84 · DELETE · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can delete own artifact_entity_links" ON public.artifact_entity_links
  USING ((SELECT auth.uid()) = user_id);

-- 8/84 · INSERT · permissive
-- before: with check (auth.uid() = user_id)
ALTER POLICY "Users can insert own artifact_entity_links" ON public.artifact_entity_links
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- 9/84 · SELECT · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can select own artifact_entity_links" ON public.artifact_entity_links
  USING ((SELECT auth.uid()) = user_id);

-- 10/84 · UPDATE · permissive
-- before: using (auth.uid() = user_id)  with check (auth.uid() = user_id)
ALTER POLICY "Users can update own artifact_entity_links" ON public.artifact_entity_links
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- --------------------------------------------------------------------------
-- public.artifact_external_links — 4 policies   (current definitions: 20260606140000_047_add_artifact_external_links.sql)
-- --------------------------------------------------------------------------

-- 11/84 · DELETE · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can delete own artifact links" ON public.artifact_external_links
  USING ((SELECT auth.uid()) = user_id);

-- 12/84 · INSERT · permissive
-- before: with check (auth.uid() = user_id)
ALTER POLICY "Users can insert own artifact links" ON public.artifact_external_links
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- 13/84 · UPDATE · permissive
-- before: using (auth.uid() = user_id)  with check (auth.uid() = user_id)
ALTER POLICY "Users can update own artifact links" ON public.artifact_external_links
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- 14/84 · SELECT · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can view own artifact links" ON public.artifact_external_links
  USING ((SELECT auth.uid()) = user_id);

-- --------------------------------------------------------------------------
-- public.bindings — 4 policies   (current definitions: 20260713140000_075_bindings_and_domain_entity_type.sql)
-- --------------------------------------------------------------------------

-- 15/84 · DELETE · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can delete own bindings" ON public.bindings
  USING ((SELECT auth.uid()) = user_id);

-- 16/84 · INSERT · permissive
-- before: with check (auth.uid() = user_id)
ALTER POLICY "Users can insert own bindings" ON public.bindings
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- 17/84 · UPDATE · permissive
-- before: using (auth.uid() = user_id)  with check (auth.uid() = user_id)
ALTER POLICY "Users can update own bindings" ON public.bindings
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- 18/84 · SELECT · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can view own bindings" ON public.bindings
  USING ((SELECT auth.uid()) = user_id);

-- --------------------------------------------------------------------------
-- public.chat_messages — 4 policies   (current definitions: 20260308180000_042_chat_threads_messages.sql)
-- --------------------------------------------------------------------------

-- 19/84 · DELETE · permissive
-- before: using ( EXISTS ( SELECT 1 FROM chat_threads t WHERE t.id = chat_messages.thread_id AND t.user_id = auth.uid() ) )
ALTER POLICY "Users can delete messages in own threads" ON public.chat_messages
  USING ( EXISTS ( SELECT 1 FROM chat_threads t WHERE t.id = chat_messages.thread_id AND t.user_id = (SELECT auth.uid()) ) );

-- 20/84 · INSERT · permissive
-- before: with check ( EXISTS ( SELECT 1 FROM chat_threads t WHERE t.id = chat_messages.thread_id AND t.user_id = auth.uid() ) )
ALTER POLICY "Users can insert messages in own threads" ON public.chat_messages
  WITH CHECK ( EXISTS ( SELECT 1 FROM chat_threads t WHERE t.id = chat_messages.thread_id AND t.user_id = (SELECT auth.uid()) ) );

-- 21/84 · UPDATE · permissive
-- before: using ( EXISTS ( SELECT 1 FROM chat_threads t WHERE t.id = chat_messages.thread_id AND t.user_id = auth.uid() ) )  with check ( EXISTS ( SELECT 1 FROM chat_threads t WHERE t.id = chat_messages.thread_id AND t.user_id = auth.uid() ) )
ALTER POLICY "Users can update messages in own threads" ON public.chat_messages
  USING ( EXISTS ( SELECT 1 FROM chat_threads t WHERE t.id = chat_messages.thread_id AND t.user_id = (SELECT auth.uid()) ) )
  WITH CHECK ( EXISTS ( SELECT 1 FROM chat_threads t WHERE t.id = chat_messages.thread_id AND t.user_id = (SELECT auth.uid()) ) );

-- 22/84 · SELECT · permissive
-- before: using ( EXISTS ( SELECT 1 FROM chat_threads t WHERE t.id = chat_messages.thread_id AND t.user_id = auth.uid() ) )
ALTER POLICY "Users can view messages in own threads" ON public.chat_messages
  USING ( EXISTS ( SELECT 1 FROM chat_threads t WHERE t.id = chat_messages.thread_id AND t.user_id = (SELECT auth.uid()) ) );

-- --------------------------------------------------------------------------
-- public.chat_threads — 4 policies   (current definitions: 20260308180000_042_chat_threads_messages.sql)
-- --------------------------------------------------------------------------

-- 23/84 · DELETE · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can delete own chat_threads" ON public.chat_threads
  USING ((SELECT auth.uid()) = user_id);

-- 24/84 · INSERT · permissive
-- before: with check (auth.uid() = user_id)
ALTER POLICY "Users can insert own chat_threads" ON public.chat_threads
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- 25/84 · UPDATE · permissive
-- before: using (auth.uid() = user_id)  with check (auth.uid() = user_id)
ALTER POLICY "Users can update own chat_threads" ON public.chat_threads
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- 26/84 · SELECT · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can view own chat_threads" ON public.chat_threads
  USING ((SELECT auth.uid()) = user_id);

-- --------------------------------------------------------------------------
-- public.derived_artifacts — 1 policy   (current definitions: 20251226183644_010_update_artifacts_table.sql)
-- --------------------------------------------------------------------------

-- 27/84 · SELECT · permissive
-- before: using (((user_id = auth.uid()) OR (EXISTS ( SELECT 1 FROM artifacts a WHERE ((a.id = derived_artifacts.source_artifact_id) AND (a.user_id = auth.uid()))))))
ALTER POLICY "Users can view their own derived artifacts" ON public.derived_artifacts
  USING (((user_id = (SELECT auth.uid())) OR (EXISTS ( SELECT 1 FROM artifacts a WHERE ((a.id = derived_artifacts.source_artifact_id) AND (a.user_id = (SELECT auth.uid())))))));

-- --------------------------------------------------------------------------
-- public.entities — 4 policies   (current definitions: 20251226192107_011_update_entities_table.sql)
-- --------------------------------------------------------------------------

-- 28/84 · DELETE · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can delete own entities" ON public.entities
  USING ((SELECT auth.uid()) = user_id);

-- 29/84 · INSERT · permissive
-- before: with check (auth.uid() = user_id)
ALTER POLICY "Users can insert own entities" ON public.entities
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- 30/84 · UPDATE · permissive
-- before: using (auth.uid() = user_id)  with check (auth.uid() = user_id)
ALTER POLICY "Users can update own entities" ON public.entities
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- 31/84 · SELECT · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can view own entities" ON public.entities
  USING ((SELECT auth.uid()) = user_id);

-- --------------------------------------------------------------------------
-- public.entity_relationships — 4 policies   (current definitions: 20260704120000_062_foaf_relationship_graph.sql)
-- --------------------------------------------------------------------------

-- 32/84 · DELETE · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can delete own entity_relationships" ON public.entity_relationships
  USING ((SELECT auth.uid()) = user_id);

-- 33/84 · INSERT · permissive
-- before: with check (auth.uid() = user_id)
ALTER POLICY "Users can insert own entity_relationships" ON public.entity_relationships
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- 34/84 · SELECT · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can select own entity_relationships" ON public.entity_relationships
  USING ((SELECT auth.uid()) = user_id);

-- 35/84 · UPDATE · permissive
-- before: using (auth.uid() = user_id)  with check (auth.uid() = user_id)
ALTER POLICY "Users can update own entity_relationships" ON public.entity_relationships
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- --------------------------------------------------------------------------
-- public.events — 4 policies   (current definitions: 20251226192107_011_update_entities_table.sql)
-- --------------------------------------------------------------------------

-- 36/84 · DELETE · permissive
-- before: using ((auth.uid() = user_id))
ALTER POLICY "Users can delete own events" ON public.events
  USING (((SELECT auth.uid()) = user_id));

-- 37/84 · INSERT · permissive
-- before: with check ((auth.uid() = user_id))
ALTER POLICY "Users can insert own events" ON public.events
  WITH CHECK (((SELECT auth.uid()) = user_id));

-- 38/84 · UPDATE · permissive
-- before: using ((auth.uid() = user_id))  with check ((auth.uid() = user_id))
ALTER POLICY "Users can update own events" ON public.events
  USING (((SELECT auth.uid()) = user_id))
  WITH CHECK (((SELECT auth.uid()) = user_id));

-- 39/84 · SELECT · permissive
-- before: using ((auth.uid() = user_id))
ALTER POLICY "Users can view own events" ON public.events
  USING (((SELECT auth.uid()) = user_id));

-- --------------------------------------------------------------------------
-- public.invitations — 2 policies   (current definitions: 20251230130000_027_convert_teams_to_uuid.sql)
-- --------------------------------------------------------------------------

-- 40/84 · INSERT · permissive
-- before: with check ((EXISTS ( SELECT 1 FROM public.team_members tm WHERE ((tm.team_id = invitations.team_id) AND (tm.user_id = auth.uid()) AND ((tm.role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying])::text[]))))))
ALTER POLICY "Team owners can create invitations" ON public.invitations
  WITH CHECK ((EXISTS ( SELECT 1 FROM public.team_members tm WHERE ((tm.team_id = invitations.team_id) AND (tm.user_id = (SELECT auth.uid())) AND ((tm.role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying])::text[]))))));

-- 41/84 · SELECT · permissive
-- before: using (((auth.email() = (email)::text) OR (EXISTS ( SELECT 1 FROM public.team_members tm WHERE ((tm.team_id = invitations.team_id) AND (tm.user_id = auth.uid()) AND ((tm.role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying])::text[])))))))
ALTER POLICY "Users can view invitations for their email" ON public.invitations
  USING ((((SELECT auth.email()) = (email)::text) OR (EXISTS ( SELECT 1 FROM public.team_members tm WHERE ((tm.team_id = invitations.team_id) AND (tm.user_id = (SELECT auth.uid())) AND ((tm.role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying])::text[])))))));

-- --------------------------------------------------------------------------
-- public.subscriptions — 3 policies   (current definitions: 20251226182232_remote_schema.sql)
-- --------------------------------------------------------------------------

-- 42/84 · INSERT · permissive
-- before: with check ((auth.uid() = user_id))
ALTER POLICY "Users can insert their own subscriptions" ON public.subscriptions
  WITH CHECK (((SELECT auth.uid()) = user_id));

-- 43/84 · SELECT · permissive
-- before: using ((auth.uid() = user_id))
ALTER POLICY "Users can read their own subscriptions" ON public.subscriptions
  USING (((SELECT auth.uid()) = user_id));

-- 44/84 · UPDATE · permissive
-- before: using ((auth.uid() = user_id))
ALTER POLICY "Users can update their own subscriptions" ON public.subscriptions
  USING (((SELECT auth.uid()) = user_id));

-- --------------------------------------------------------------------------
-- public.system_decisions — 4 policies   (current definitions: 20251226182232_remote_schema.sql)
-- --------------------------------------------------------------------------

-- 45/84 · DELETE · permissive
-- before: using ((auth.uid() = user_id))
ALTER POLICY "Users can delete own system decisions" ON public.system_decisions
  USING (((SELECT auth.uid()) = user_id));

-- 46/84 · INSERT · permissive
-- before: with check ((auth.uid() = user_id))
ALTER POLICY "Users can insert own system decisions" ON public.system_decisions
  WITH CHECK (((SELECT auth.uid()) = user_id));

-- 47/84 · UPDATE · permissive
-- before: using ((auth.uid() = user_id))  with check ((auth.uid() = user_id))
ALTER POLICY "Users can update own system decisions" ON public.system_decisions
  USING (((SELECT auth.uid()) = user_id))
  WITH CHECK (((SELECT auth.uid()) = user_id));

-- 48/84 · SELECT · permissive
-- before: using ((auth.uid() = user_id))
ALTER POLICY "Users can view own system decisions" ON public.system_decisions
  USING (((SELECT auth.uid()) = user_id));

-- --------------------------------------------------------------------------
-- public.system_jobs — 5 policies   (current definitions: 20251226231400_020_create_system_jobs_table.sql)
-- --------------------------------------------------------------------------

-- 49/84 · ALL · permissive
-- before: using (auth.jwt()->>'role' = 'service_role')
ALTER POLICY "Service role full access system_jobs" ON public.system_jobs
  USING ((SELECT auth.jwt())->>'role' = 'service_role');

-- 50/84 · DELETE · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can delete own system_jobs" ON public.system_jobs
  USING ((SELECT auth.uid()) = user_id);

-- 51/84 · INSERT · permissive
-- before: with check (auth.uid() = user_id)
ALTER POLICY "Users can insert own system_jobs" ON public.system_jobs
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- 52/84 · UPDATE · permissive
-- before: using (auth.uid() = user_id)  with check (auth.uid() = user_id)
ALTER POLICY "Users can update own system_jobs" ON public.system_jobs
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- 53/84 · SELECT · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can view own system_jobs" ON public.system_jobs
  USING ((SELECT auth.uid()) = user_id);

-- --------------------------------------------------------------------------
-- public.system_learning — 5 policies   (current definitions: 20251226230203_019_create_system_learning_table.sql)
-- --------------------------------------------------------------------------

-- 54/84 · ALL · permissive
-- before: using (auth.jwt()->>'role' = 'service_role')
ALTER POLICY "Service role can manage system_learning" ON public.system_learning
  USING ((SELECT auth.jwt())->>'role' = 'service_role');

-- 55/84 · DELETE · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can delete own system_learning" ON public.system_learning
  USING ((SELECT auth.uid()) = user_id);

-- 56/84 · INSERT · permissive
-- before: with check (auth.uid() = user_id)
ALTER POLICY "Users can insert own system_learning" ON public.system_learning
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- 57/84 · UPDATE · permissive
-- before: using (auth.uid() = user_id)  with check (auth.uid() = user_id)
ALTER POLICY "Users can update own system_learning" ON public.system_learning
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- 58/84 · SELECT · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can view own system_learning" ON public.system_learning
  USING ((SELECT auth.uid()) = user_id);

-- --------------------------------------------------------------------------
-- public.team_members — 2 policies   (current definitions: 20251230130000_027_convert_teams_to_uuid.sql)
-- --------------------------------------------------------------------------

-- 59/84 · ALL · permissive
-- before: using ((EXISTS ( SELECT 1 FROM public.team_members tm WHERE ((tm.team_id = team_members.team_id) AND (tm.user_id = auth.uid()) AND ((tm.role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying])::text[]))))))
ALTER POLICY "Team owners can manage team members" ON public.team_members
  USING ((EXISTS ( SELECT 1 FROM public.team_members tm WHERE ((tm.team_id = team_members.team_id) AND (tm.user_id = (SELECT auth.uid())) AND ((tm.role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying])::text[]))))));

-- 60/84 · SELECT · permissive
-- before: using ((auth.uid() = user_id))
ALTER POLICY "Users can view their team memberships" ON public.team_members
  USING (((SELECT auth.uid()) = user_id));

-- --------------------------------------------------------------------------
-- public.user_edits — 5 policies   (current definitions: 20251226225618_018_create_user_edits_table.sql)
-- --------------------------------------------------------------------------

-- 61/84 · ALL · permissive
-- before: using (auth.jwt()->>'role' = 'service_role')
ALTER POLICY "Service role can manage user_edits" ON public.user_edits
  USING ((SELECT auth.jwt())->>'role' = 'service_role');

-- 62/84 · DELETE · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can delete own user_edits" ON public.user_edits
  USING ((SELECT auth.uid()) = user_id);

-- 63/84 · INSERT · permissive
-- before: with check (auth.uid() = user_id)
ALTER POLICY "Users can insert own user_edits" ON public.user_edits
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- 64/84 · UPDATE · permissive
-- before: using (auth.uid() = user_id)  with check (auth.uid() = user_id)
ALTER POLICY "Users can update own user_edits" ON public.user_edits
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- 65/84 · SELECT · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can view own user_edits" ON public.user_edits
  USING ((SELECT auth.uid()) = user_id);

-- --------------------------------------------------------------------------
-- public.user_integrations — 4 policies   (current definitions: 20260606130000_046_add_user_integrations.sql)
-- --------------------------------------------------------------------------

-- 66/84 · DELETE · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can delete own integrations" ON public.user_integrations
  USING ((SELECT auth.uid()) = user_id);

-- 67/84 · INSERT · permissive
-- before: with check (auth.uid() = user_id)
ALTER POLICY "Users can insert own integrations" ON public.user_integrations
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- 68/84 · UPDATE · permissive
-- before: using (auth.uid() = user_id)  with check (auth.uid() = user_id)
ALTER POLICY "Users can update own integrations" ON public.user_integrations
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- 69/84 · SELECT · permissive
-- before: using (auth.uid() = user_id)
ALTER POLICY "Users can view own integrations" ON public.user_integrations
  USING ((SELECT auth.uid()) = user_id);

-- --------------------------------------------------------------------------
-- public.user_preferences — 3 policies   (current definitions: 20251226182232_remote_schema.sql)
-- --------------------------------------------------------------------------

-- 70/84 · INSERT · permissive
-- before: with check ((auth.uid() = user_id))
ALTER POLICY "Users can insert their own preferences" ON public.user_preferences
  WITH CHECK (((SELECT auth.uid()) = user_id));

-- 71/84 · SELECT · permissive
-- before: using ((auth.uid() = user_id))
ALTER POLICY "Users can read their own preferences" ON public.user_preferences
  USING (((SELECT auth.uid()) = user_id));

-- 72/84 · UPDATE · permissive
-- before: using ((auth.uid() = user_id))
ALTER POLICY "Users can update their own preferences" ON public.user_preferences
  USING (((SELECT auth.uid()) = user_id));

-- --------------------------------------------------------------------------
-- public.user_profiles — 2 policies   (current definitions: 20251226182232_remote_schema.sql)
-- --------------------------------------------------------------------------

-- 73/84 · UPDATE · permissive
-- before: using ((auth.uid() = id))  with check ((auth.uid() = id))
ALTER POLICY "Users can update their own profile" ON public.user_profiles
  USING (((SELECT auth.uid()) = id))
  WITH CHECK (((SELECT auth.uid()) = id));

-- 74/84 · SELECT · permissive
-- before: using ((auth.uid() = id))
ALTER POLICY "Users can view their own profile" ON public.user_profiles
  USING (((SELECT auth.uid()) = id));

-- --------------------------------------------------------------------------
-- public.user_tasks — 4 policies   (current definitions: 20251226182232_remote_schema.sql)
-- --------------------------------------------------------------------------

-- 75/84 · DELETE · permissive
-- before: using ((auth.uid() = user_id))
ALTER POLICY "Users can delete own tasks" ON public.user_tasks
  USING (((SELECT auth.uid()) = user_id));

-- 76/84 · INSERT · permissive
-- before: with check ((auth.uid() = user_id))
ALTER POLICY "Users can insert own tasks" ON public.user_tasks
  WITH CHECK (((SELECT auth.uid()) = user_id));

-- 77/84 · UPDATE · permissive
-- before: using ((auth.uid() = user_id))  with check ((auth.uid() = user_id))
ALTER POLICY "Users can update own tasks" ON public.user_tasks
  USING (((SELECT auth.uid()) = user_id))
  WITH CHECK (((SELECT auth.uid()) = user_id));

-- 78/84 · SELECT · permissive
-- before: using ((auth.uid() = user_id))
ALTER POLICY "Users can view own tasks" ON public.user_tasks
  USING (((SELECT auth.uid()) = user_id));

-- --------------------------------------------------------------------------
-- public.user_trials — 3 policies   (current definitions: 20251226182232_remote_schema.sql)
-- --------------------------------------------------------------------------

-- 79/84 · INSERT · permissive
-- before: with check ((auth.uid() = user_id))
ALTER POLICY "Users can insert their own trials" ON public.user_trials
  WITH CHECK (((SELECT auth.uid()) = user_id));

-- 80/84 · SELECT · permissive
-- before: using ((auth.uid() = user_id))
ALTER POLICY "Users can read their own trials" ON public.user_trials
  USING (((SELECT auth.uid()) = user_id));

-- 81/84 · UPDATE · permissive
-- before: using ((auth.uid() = user_id))
ALTER POLICY "Users can update their own trials" ON public.user_trials
  USING (((SELECT auth.uid()) = user_id));

-- --------------------------------------------------------------------------
-- public.users — 2 policies   (current definitions: 20251226182232_remote_schema.sql)
-- --------------------------------------------------------------------------

-- 82/84 · SELECT · permissive
-- before: using ((auth.uid() = id))
ALTER POLICY "Users can read their own data" ON public.users
  USING (((SELECT auth.uid()) = id));

-- 83/84 · UPDATE · permissive
-- before: using ((auth.uid() = id))
ALTER POLICY "Users can update their own data" ON public.users
  USING (((SELECT auth.uid()) = id));

-- --------------------------------------------------------------------------
-- public.workflows — 1 policy   (current definitions: 20251226214554_012_rename_workflow_runs_to_workflows.sql)
-- --------------------------------------------------------------------------

-- 84/84 · SELECT · permissive
-- before: using (((user_id = auth.uid()) OR (EXISTS ( SELECT 1 FROM public.artifacts a WHERE ((a.id = workflows.source_artifact_id) AND (a.user_id = auth.uid()))))))
ALTER POLICY "Users can view their own workflows" ON public.workflows
  USING (((user_id = (SELECT auth.uid())) OR (EXISTS ( SELECT 1 FROM public.artifacts a WHERE ((a.id = workflows.source_artifact_id) AND (a.user_id = (SELECT auth.uid())))))));
