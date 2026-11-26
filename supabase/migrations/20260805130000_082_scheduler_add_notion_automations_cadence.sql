-- Add the 'notion_automations' cadence to the scheduler (issue #546 / ADR-048).
--
-- The daily Notion automations reconciliation sweep converges the personal Tasks
-- DB's `Completed at` column when the webhook fast path missed events (endpoint
-- down, subscription broken, event dropped past Notion's retries). It reuses the
-- Discover & Index scheduler infra from migration 073 (ADR-016 Slice 3, #53):
-- single-flight via scheduler_locks and run history via scheduler_runs — exactly
-- the pattern migration 076 followed for the 'dedup' cadence.
--
-- scheduler_runs.cadence carries a CHECK constraint that must be widened to
-- accept 'notion_automations'. scheduler_locks.cadence has no CHECK (it is the
-- primary key), so it only needs the new lock row seeded.

alter table public.scheduler_runs
  drop constraint if exists scheduler_runs_cadence_check;

alter table public.scheduler_runs
  add constraint scheduler_runs_cadence_check
  check (cadence in ('discover', 'enrich', 'dedup', 'notion_automations'));

comment on column public.scheduler_runs.counts is
  'Cadence-specific outcome counts, e.g. discover: {new, changed, unchanged}; enrich: {enriched, failed, remaining_discovered}; dedup: {users, created, skipped, errors}; notion_automations: {scanned, stamped, cleared, unchanged, errors}.';

insert into public.scheduler_locks (cadence, locked_at)
values ('notion_automations', null)
on conflict (cadence) do nothing;
