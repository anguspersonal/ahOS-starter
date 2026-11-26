-- ADR-016 Slice 3 (#53): schedule the discover -> enrich loop.
--
-- Two small tables:
--   scheduler_runs  - append-only history of each scheduled run (discover/enrich),
--                     with cadence-specific counts kept as jsonb rather than a
--                     wide typed column set, since discover and enrich report
--                     different shapes (new/changed vs enriched/failed/remaining).
--   scheduler_locks - single-flight guard. mcp-server talks to Postgres only via
--                     the Supabase REST client (no held connection), so a real
--                     session-scoped pg_advisory_lock isn't reachable here; this
--                     row-based lock gives the same guarantee (one atomic UPDATE
--                     picks a winner) without a new DB connection/dependency.

create table if not exists public.scheduler_runs (
  id uuid primary key default gen_random_uuid(),
  cadence text not null check (cadence in ('discover', 'enrich')),
  connector text,
  status text not null check (status in ('ok', 'error')),
  counts jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.scheduler_runs is
  'Run history for the scheduled Discover & Index cadences (ADR-016 Slice 3, #53). One row per discover or enrich_next run.';
comment on column public.scheduler_runs.counts is
  'Cadence-specific outcome counts, e.g. discover: {new, changed, unchanged}; enrich: {enriched, failed, remaining_discovered}.';

create index if not exists idx_scheduler_runs_cadence_started
  on public.scheduler_runs (cadence, started_at desc);

create table if not exists public.scheduler_locks (
  cadence text primary key,
  locked_at timestamptz
);

comment on table public.scheduler_locks is
  'Single-flight guard for scheduled cadences (ADR-016 Slice 3, #53). One row per cadence; locked_at is cleared when the run finishes and treated as stale/expired after a timeout as a safety net against a crashed holder.';

insert into public.scheduler_locks (cadence, locked_at)
values ('discover', null), ('enrich', null)
on conflict (cadence) do nothing;
