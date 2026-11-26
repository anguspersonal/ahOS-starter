-- Add the 'approval_expiry' cadence to the scheduler (hourly action_approval expiry cadence, ADR-101 §1, ADR-104 #1403, #1429).
--
-- Single-flight via scheduler_locks, run history via scheduler_runs.
-- 'approval_expiry' moves pending action_approval rows in system_decisions past expires_at to 'expired' and never auto-approves.

alter table public.scheduler_runs
  drop constraint if exists scheduler_runs_cadence_check;

alter table public.scheduler_runs
  add constraint scheduler_runs_cadence_check
  check (cadence in ('discover', 'enrich', 'dedup', 'notion_automations', 'alerts', 'learning', 'gmail_automations', 'derive', 'jobs', 'drive-watch', 'approval_expiry'));

comment on column public.scheduler_runs.counts is
  'Cadence-specific outcome counts, e.g. discover: {new, changed, unchanged}; enrich: {enriched, failed, remaining_discovered}; dedup: {users, created, skipped, errors}; notion_automations: {scanned, stamped, cleared, unchanged, errors}; alerts: {users, conditions, fired, held, rearmed, suppressed, skipped, errors, emails, send_failures, discovery_truncated}; learning: {users, errors}; gmail_automations: {scanned, updated, archived, pendingAction, awaitingReply, unchanged, errors}; derive: {users, processed, entities_created, entities_linked, relationships_created, remaining_underived, errors}; jobs: {processed, completed, failed, retried, recovered}; drive-watch: {accounts, registered, renewed, active, errors}; approval_expiry: {expired}.';

insert into public.scheduler_locks (cadence, locked_at)
values ('approval_expiry', null)
on conflict (cadence) do nothing;
