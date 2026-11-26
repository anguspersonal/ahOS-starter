-- Add the 'gmail_automations' cadence to the scheduler (issue #356).
--
-- Single-flight via scheduler_locks, run history via scheduler_runs.
-- Idempotent per-thread labeling workflow: AhOS, AhOSProcessed,
-- archive on resolve / Pending Action / awaiting reply.

alter table public.scheduler_runs
  drop constraint if exists scheduler_runs_cadence_check;

alter table public.scheduler_runs
  add constraint scheduler_runs_cadence_check
  check (cadence in ('discover', 'enrich', 'dedup', 'notion_automations', 'alerts', 'learning', 'gmail_automations'));

comment on column public.scheduler_runs.counts is
  'Cadence-specific outcome counts, e.g. discover: {new, changed, unchanged}; enrich: {enriched, failed, remaining_discovered}; dedup: {users, created, skipped, errors}; notion_automations: {scanned, stamped, cleared, unchanged, errors}; alerts: {users, conditions, fired, held, rearmed, suppressed, skipped, errors, emails, send_failures, discovery_truncated}; learning: {users, errors}; gmail_automations: {scanned, updated, archived, pendingAction, awaitingReply, unchanged, errors}.';

insert into public.scheduler_locks (cadence, locked_at)
values ('gmail_automations', null)
on conflict (cadence) do nothing;
