-- Add the 'learning' cadence to the scheduler (issue #948).
--
-- `runBatchLearningAnalysis` (packages/worker/src/learning/analyze.ts) has had
-- no caller since it was written: not from `schedule/`, not dynamically. Its
-- five pattern analysers therefore never ran, so `system_learning` never
-- accumulated a row. This migration registers the cadence on the existing
-- Discover & Index scheduler infra (migration 073, ADR-016 Slice 3, #53) the
-- same way migrations 076 ('dedup'), 082 ('notion_automations') and 084
-- ('alerts') did: single-flight via scheduler_locks, run history via
-- scheduler_runs.
--
-- scheduler_runs.cadence carries a CHECK constraint that must be widened to
-- accept 'learning'. scheduler_locks.cadence has no CHECK (it is the primary
-- key), so it only needs the new lock row seeded.
--
-- The cadence itself (packages/worker/src/schedule/learningAnalysis.ts) stays
-- off unless KMS_LEARNING_ANALYSIS_ENABLED=true on the worker host — see that
-- module's docstring and the PR that lands alongside this migration.

alter table public.scheduler_runs
  drop constraint if exists scheduler_runs_cadence_check;

alter table public.scheduler_runs
  add constraint scheduler_runs_cadence_check
  check (cadence in ('discover', 'enrich', 'dedup', 'notion_automations', 'alerts', 'learning'));

comment on column public.scheduler_runs.counts is
  'Cadence-specific outcome counts, e.g. discover: {new, changed, unchanged}; enrich: {enriched, failed, remaining_discovered}; dedup: {users, created, skipped, errors}; notion_automations: {scanned, stamped, cleared, unchanged, errors}; alerts: {users, conditions, fired, held, rearmed, suppressed, skipped, errors, emails, send_failures, discovery_truncated}; learning: {users, errors}.';

insert into public.scheduler_locks (cadence, locked_at)
values ('learning', null)
on conflict (cadence) do nothing;
