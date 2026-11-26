-- Add the 'drive-watch' cadence to the scheduler (Google Drive changes.watch registration and renewal cadence, ADR-048, ADR-101 §2, #1408).
--
-- Single-flight via scheduler_locks, run history via scheduler_runs.
-- 'drive-watch' manages Google Drive changes push notification channels for /webhooks/drive across configured accounts.
-- Needs a scheduler_locks row (lock acquisition is judged by the UPDATE's affected-row count) and a slot in
-- scheduler_runs_cadence_check (run-log inserts are rejected otherwise).

alter table public.scheduler_runs
  drop constraint if exists scheduler_runs_cadence_check;

alter table public.scheduler_runs
  add constraint scheduler_runs_cadence_check
  check (cadence in ('discover', 'enrich', 'dedup', 'notion_automations', 'alerts', 'learning', 'gmail_automations', 'derive', 'jobs', 'drive-watch'));

comment on column public.scheduler_runs.counts is
  'Cadence-specific outcome counts, e.g. discover: {new, changed, unchanged}; enrich: {enriched, failed, remaining_discovered}; dedup: {users, created, skipped, errors}; notion_automations: {scanned, stamped, cleared, unchanged, errors}; alerts: {users, conditions, fired, held, rearmed, suppressed, skipped, errors, emails, send_failures, discovery_truncated}; learning: {users, errors}; gmail_automations: {scanned, updated, archived, pendingAction, awaitingReply, unchanged, errors}; derive: {users, processed, entities_created, entities_linked, relationships_created, remaining_underived, errors}; jobs: {processed, completed, failed, retried, recovered}; drive-watch: {accounts, registered, renewed, active, errors}.';

insert into public.scheduler_locks (cadence, locked_at)
values ('drive-watch', null)
on conflict (cadence) do nothing;
