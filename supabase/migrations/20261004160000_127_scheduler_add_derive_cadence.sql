-- Add the 'derive' and 'jobs' cadences to the scheduler (Automated Entity Derivation Pipeline).
--
-- Single-flight via scheduler_locks, run history via scheduler_runs.
-- 'derive' extracts entities and relationships from enriched artifacts and links them into the
-- knowledge graph; 'jobs' drains system_jobs rows (e.g. on-demand entity_derive). Both need a
-- scheduler_locks row (lock acquisition is judged by the UPDATE's affected-row count) and a slot
-- in scheduler_runs_cadence_check (run-log inserts are rejected otherwise).
--
-- Also adds set_artifact_derivation(), which merges only the 'derivation' key into
-- artifacts.processing_metadata so derivation does not clobber concurrent writers of other keys.

alter table public.scheduler_runs
  drop constraint if exists scheduler_runs_cadence_check;

alter table public.scheduler_runs
  add constraint scheduler_runs_cadence_check
  check (cadence in ('discover', 'enrich', 'dedup', 'notion_automations', 'alerts', 'learning', 'gmail_automations', 'derive', 'jobs'));

comment on column public.scheduler_runs.counts is
  'Cadence-specific outcome counts, e.g. discover: {new, changed, unchanged}; enrich: {enriched, failed, remaining_discovered}; dedup: {users, created, skipped, errors}; notion_automations: {scanned, stamped, cleared, unchanged, errors}; alerts: {users, conditions, fired, held, rearmed, suppressed, skipped, errors, emails, send_failures, discovery_truncated}; learning: {users, errors}; gmail_automations: {scanned, updated, archived, pendingAction, awaitingReply, unchanged, errors}; derive: {users, processed, entities_created, entities_linked, relationships_created, remaining_underived, errors}; jobs: {processed, completed, failed, retried, recovered}.';

insert into public.scheduler_locks (cadence, locked_at)
values ('derive', null), ('jobs', null)
on conflict (cadence) do nothing;

create or replace function public.set_artifact_derivation(
  p_user_id uuid,
  p_artifact_id uuid,
  p_derivation jsonb
)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_updated integer;
begin
  update public.artifacts
     set processing_metadata = jsonb_set(coalesce(processing_metadata, '{}'::jsonb), '{derivation}', p_derivation, true)
   where id = p_artifact_id
     and user_id = p_user_id;
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

revoke all on function public.set_artifact_derivation(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.set_artifact_derivation(uuid, uuid, jsonb) to service_role;
