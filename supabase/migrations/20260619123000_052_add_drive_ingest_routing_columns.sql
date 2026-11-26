-- Migration: add Drive ingest provenance + routing audit columns.
-- Purpose: keep Drive source details on artifacts, and make safe-mode routing a
-- first-class user preference instead of a hidden convention.

alter table public.user_preferences
  add column if not exists safe_mode boolean not null default true;

update public.user_preferences
set safe_mode = true
where safe_mode is null;

comment on column public.user_preferences.safe_mode is
  'When true, routing should prefer non-destructive actions (move/archive) over permanent delete.';

alter table public.artifacts
  add column if not exists source_url text,
  add column if not exists source_drive_file_id text,
  add column if not exists source_parent_folder_ids text[],
  add column if not exists source_parent_folder_path text,
  add column if not exists routing_decision text,
  add column if not exists routing_confidence numeric,
  add column if not exists routing_reason text,
  add column if not exists drive_action text,
  add column if not exists drive_action_at timestamptz;

alter table public.artifacts
  drop constraint if exists artifacts_routing_confidence_check;

alter table public.artifacts
  add constraint artifacts_routing_confidence_check
  check (
    routing_confidence is null
    or (routing_confidence >= 0 and routing_confidence <= 1)
  );

comment on column public.artifacts.source_url is
  'Canonical source URL for the artifact, when available.';

comment on column public.artifacts.source_drive_file_id is
  'Drive file id for imported Drive artifacts.';

comment on column public.artifacts.source_parent_folder_ids is
  'Drive parent folder ids for imported Drive artifacts.';

comment on column public.artifacts.source_parent_folder_path is
  'Human-readable Drive parent folder path for imported Drive artifacts.';

comment on column public.artifacts.routing_decision is
  'Semantic routing decision chosen by the agent after ingest.';

comment on column public.artifacts.routing_confidence is
  'Routing confidence from 0 to 1.';

comment on column public.artifacts.routing_reason is
  'Natural-language reason for the routing decision.';

comment on column public.artifacts.drive_action is
  'Drive action that was actually taken after routing.';

comment on column public.artifacts.drive_action_at is
  'Timestamp when the Drive action was taken.';
