-- Exception-only alert evaluator: durable crossing state + the 'alerts' cadence
-- (issue #573).
--
-- WHY THIS TABLE EXISTS
--   packages/worker/src/utils/alerts.ts dedupes on a 10-MINUTE IN-MEMORY window.
--   It does not survive a restart and does not span days. An evaluator that
--   fired whenever `days_since_ritual >= 6` would therefore email every day from
--   day 6 onward — converting an exception-only alert into exactly the daily
--   digest that was rejected in #493 Q3 ("a message that repeats every day
--   decays into wallpaper").
--
--   So the evaluator fires on the threshold being CROSSED, not on it being
--   HELD, and that needs durable per-condition state:
--
--     breached && armed  -> send once, set armed = false
--     breached && !armed -> silent (still true, already reported)
--     !breached          -> armed = true (re-arm; the next crossing may fire)
--
--   A missing row means armed, so no seeding is required and the first
--   evaluation of an already-breached condition fires exactly once — the
--   2026-08-04 case (a month of silence produces one email, not thirty).
--
-- The evaluator READS AND EMAILS, NOTHING ELSE. This is the only table it
-- writes; the allowlist is enforced in code (alertEvaluator.ts WRITABLE_TABLES)
-- and asserted by unit tests.
--
-- Additive and backward-compatible: a new table plus a widened CHECK. Nothing
-- currently deployed reads either, so this is safe to push ahead of the code.

create table if not exists public.alert_condition_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Stable condition identity, e.g. 'ritual_silent' or 'source_silent:gmail_ingest'.
  -- Open vocabulary (free text) so a new condition needs no schema change.
  condition_key text not null,
  -- false = a crossing has already been reported and not yet cleared.
  armed boolean not null default true,
  -- Last measured value (days of silence). Kept for debugging and for the
  -- #495 coverage view; the fire/hold decision only needs `armed`.
  last_value numeric,
  last_evaluated_at timestamptz,
  last_fired_at timestamptz,
  last_fired_value numeric,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  -- One row per condition per user; the evaluator upserts on this.
  constraint alert_condition_state_unique unique (user_id, condition_key)
);

comment on table public.alert_condition_state is
  'Durable crossing state for the exception-only alert evaluator (#573). One row per (user, condition). `armed` is the whole mechanism: an alert fires only on a threshold CROSSING and re-arms only after the condition clears, so a held condition produces exactly one email rather than one per run.';
comment on column public.alert_condition_state.condition_key is
  'Stable condition identity: ''ritual_silent'' | ''source_silent:<surface>'' | ''source_coverage_degraded''. Open vocab — a new condition needs no migration.';
comment on column public.alert_condition_state.armed is
  'true = the next breach fires an alert. Set false ONLY when an alert was confirmed delivered; set true again only when the measured value actually improves (a threshold raise is not a clear). An undelivered crossing stays armed so the next run retries.';
comment on column public.alert_condition_state.last_value is
  'Most recent measured value (days of silence). NULL when the signal is unmeasurable (e.g. the ritual has never run), which never fires and never disturbs `armed`.';

alter table public.alert_condition_state enable row level security;

-- Owner-only RLS, matching artifact_external_links (migration 047). The worker
-- uses the service role and bypasses RLS; these protect any RLS-bound client.
create policy "Users can view own alert condition state"
on public.alert_condition_state as permissive for select to public
using (auth.uid() = user_id);

create policy "Users can insert own alert condition state"
on public.alert_condition_state as permissive for insert to public
with check (auth.uid() = user_id);

create policy "Users can update own alert condition state"
on public.alert_condition_state as permissive for update to public
using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Users can delete own alert condition state"
on public.alert_condition_state as permissive for delete to public
using (auth.uid() = user_id);

-- Register the 'alerts' cadence on the shared scheduler infra from migration
-- 073 (ADR-016 Slice 3, #53) — the same two steps migrations 076 ('dedup') and
-- 082 ('notion_automations') took.
--
-- NOTE FOR THE RELEASE TRAIN: the CHECK is rebuilt from a literal list, so if a
-- parallel migration also adds a cadence, whichever file sorts LAST must include
-- the other's value. Checked against the in-flight 083
-- (20260807120000_083_backfill_discover_surface.sql, PR #583): it contains no
-- scheduler_runs / cadence / constraint references at all, and 084 sorts after
-- it either way, so this list is complete.
--
-- TIMESTAMP: this file was originally 20260807120000_084_…, which COLLIDED with
-- 083's 14-digit prefix. Supabase derives schema_migrations.version from that
-- prefix and it is the primary key, so a single `db push` carrying both would
-- have died on a duplicate key. Renamed to 20260807130000 (the same-day
-- 081/082 convention) before this migration had ever been applied or merged.
-- Issue #585 tracks adding a pre-merge guard so the next one is caught by CI.
alter table public.scheduler_runs
  drop constraint if exists scheduler_runs_cadence_check;

alter table public.scheduler_runs
  add constraint scheduler_runs_cadence_check
  check (cadence in ('discover', 'enrich', 'dedup', 'notion_automations', 'alerts'));

comment on column public.scheduler_runs.counts is
  'Cadence-specific outcome counts, e.g. discover: {new, changed, unchanged}; enrich: {enriched, failed, remaining_discovered}; dedup: {users, created, skipped, errors}; notion_automations: {scanned, stamped, cleared, unchanged, errors}; alerts: {users, conditions, fired, held, rearmed, suppressed, skipped, errors, emails, send_failures, discovery_truncated}.';

insert into public.scheduler_locks (cadence, locked_at)
values ('alerts', null)
on conflict (cadence) do nothing;

-- Document the config home. Thresholds and enable/disable live in the DB per
-- ADR-030 so they are editable at runtime (update_user_preferences deep-merges
-- this blob) without a deploy.
--
-- `exception_alerts` is a NEW, purpose-named key — the orphaned `daily_summary`
-- boolean is deliberately NOT reused. `daily_summary` names a digest, which is
-- precisely what these alerts are not, and it is a bare boolean with nowhere to
-- put a threshold. It stays in the column default so existing rows keep
-- round-tripping, but nothing acts on it; see #573.
comment on column public.user_preferences.notification_preferences is
  'Notification config (JSONB). `exception_alerts` drives the worker''s exception-only alert evaluator (#573): {enabled, ritual_silent:{enabled,threshold_days}, source_silent:{enabled,threshold_days,sources[],discovery_window_days,min_observations}}. `daily_summary` is a legacy, unimplemented boolean kept for round-tripping only — it is a digest switch, which is explicitly not what exception alerts are.';
