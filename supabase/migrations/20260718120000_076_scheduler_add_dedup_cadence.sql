-- Add the 'dedup' cadence to the scheduler (issue #396, follow-up to #174).
--
-- The periodic dedup sweep runs emitMergeSuggestions per active user so that
-- duplicate people are surfaced as merge_suggested decisions automatically,
-- with no manual function call. It reuses the Discover & Index scheduler infra
-- from migration 073 (ADR-016 Slice 3, #53): single-flight via scheduler_locks
-- and run history via scheduler_runs.
--
-- scheduler_runs.cadence carries a CHECK constraint that must be widened to
-- accept 'dedup'. scheduler_locks.cadence has no CHECK (it is the primary key),
-- so it only needs the new lock row seeded.

alter table public.scheduler_runs
  drop constraint if exists scheduler_runs_cadence_check;

alter table public.scheduler_runs
  add constraint scheduler_runs_cadence_check
  check (cadence in ('discover', 'enrich', 'dedup'));

comment on column public.scheduler_runs.counts is
  'Cadence-specific outcome counts, e.g. discover: {new, changed, unchanged}; enrich: {enriched, failed, remaining_discovered}; dedup: {users, created, skipped, errors}.';

insert into public.scheduler_locks (cadence, locked_at)
values ('dedup', null)
on conflict (cadence) do nothing;
