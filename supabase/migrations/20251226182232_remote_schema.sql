create extension if not exists "vector" with schema "public";

create sequence "public"."activity_logs_id_seq";

create sequence "public"."invitations_id_seq";

create sequence "public"."team_members_id_seq";

create sequence "public"."teams_id_seq";


  create table "public"."activity_logs" (
    "id" integer not null default nextval('public.activity_logs_id_seq'::regclass),
    "team_id" integer not null,
    "action" text not null,
    "timestamp" timestamp with time zone not null default now(),
    "ip_address" character varying(45),
    "user_id" uuid not null
      );


alter table "public"."activity_logs" enable row level security;


  create table "public"."artifact_entity_links" (
    "id" uuid not null default gen_random_uuid(),
    "artifact_id" text not null,
    "entity_id" text not null,
    "link_type" text default 'related'::text,
    "confidence_score" numeric(5,2),
    "created_by" text,
    "notes" text,
    "created_at" timestamp with time zone not null default now()
      );


alter table "public"."artifact_entity_links" enable row level security;


  create table "public"."artifacts" (
    "id" text not null,
    "storage_bucket" text not null default 'inputs'::text,
    "storage_path" text not null,
    "storage_url" text not null,
    "filename" text not null,
    "file_type" text,
    "file_size" integer,
    "artifact_type" text,
    "captured_at" timestamp with time zone not null,
    "captured_by" text,
    "source" text,
    "processed" boolean default false,
    "workflow_run_id" text,
    "created_at" timestamp with time zone not null default now(),
    "archived" boolean default false,
    "archived_at" timestamp with time zone,
    "archived_reason" text,
    "version" integer default 1,
    "previous_version_id" text,
    "storage_object_id" text,
    "lifecycle_stage" text default 'uploaded'::text,
    "processing_status" text default 'pending'::text,
    "has_derived_artifacts" boolean default false,
    "derived_artifacts_location" text,
    "processing_completed_at" timestamp with time zone,
    "processing_error" text,
    "content" jsonb,
    "content_html" text,
    "plain_text" text,
    "team_id" integer,
    "user_id" uuid not null,
    "title" text,
    "tags" text[] default '{}'::text[],
    "source_channel" text,
    "extracted_content" text,
    "extraction_confidence" numeric(3,2),
    "description" text,
    "processing_metadata" jsonb default '{}'::jsonb
      );


alter table "public"."artifacts" enable row level security;


  create table "public"."derived_artifacts" (
    "id" uuid not null default gen_random_uuid(),
    "source_artifact_id" text not null,
    "artifact_type" text not null,
    "storage_bucket" text not null default 'derived-artifacts'::text,
    "storage_path" text not null,
    "storage_url" text not null,
    "page_number" integer,
    "sequence_order" integer,
    "workflow_run_id" uuid,
    "task_id" text,
    "processing_metadata" jsonb,
    "filename" text not null,
    "file_type" text,
    "file_size" bigint,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    "team_id" integer,
    "user_id" uuid not null
      );


alter table "public"."derived_artifacts" enable row level security;


  create table "public"."discovered_patterns" (
    "id" text not null,
    "pattern_name" text not null,
    "pattern_type" text,
    "description" text,
    "pattern_rule" jsonb,
    "confidence_score" numeric(3,2),
    "example_ids" text[],
    "example_count" integer,
    "times_applied" integer default 0,
    "success_rate" numeric(3,2),
    "discovered_at" timestamp with time zone not null default now(),
    "discovered_by" text,
    "status" text default 'candidate'::text,
    "notes" text
      );



  create table "public"."entities" (
    "id" text not null,
    "entity_type" text not null,
    "title" text not null,
    "description" text,
    "archived" boolean default false,
    "archived_at" timestamp with time zone,
    "properties" jsonb default '{}'::jsonb,
    "tags" text[],
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    "user_id" uuid not null,
    "team_id" integer
      );


alter table "public"."entities" enable row level security;


  create table "public"."entity_relationships" (
    "id" uuid not null default gen_random_uuid(),
    "from_entity_id" text not null,
    "to_entity_id" text not null,
    "relationship_type" text not null,
    "confidence_score" numeric(5,2),
    "created_by" text,
    "notes" text,
    "created_at" timestamp with time zone not null default now()
      );


alter table "public"."entity_relationships" enable row level security;


  create table "public"."events" (
    "id" uuid not null default gen_random_uuid(),
    "title" text not null,
    "description" text,
    "event_type" text,
    "start_time" timestamp with time zone not null,
    "end_time" timestamp with time zone,
    "all_day" boolean default false,
    "timezone" text default 'UTC'::text,
    "source_artifact_id" text,
    "entity_id" text,
    "attendees" text[],
    "location" text,
    "tags" text[],
    "notes" text,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    "user_id" uuid not null,
    "team_id" integer,
    "created_by" uuid
      );


alter table "public"."events" enable row level security;


  create table "public"."invitations" (
    "id" integer not null default nextval('public.invitations_id_seq'::regclass),
    "team_id" integer not null,
    "email" character varying(255) not null,
    "role" character varying(50) not null,
    "invited_at" timestamp with time zone not null default now(),
    "status" character varying(20) not null default 'pending'::character varying,
    "invited_by" uuid not null
      );


alter table "public"."invitations" enable row level security;


  create table "public"."subscriptions" (
    "id" uuid not null default gen_random_uuid(),
    "user_id" uuid,
    "stripe_customer_id" text,
    "stripe_subscription_id" text,
    "status" text,
    "price_id" text,
    "created_at" timestamp with time zone default now(),
    "cancel_at_period_end" boolean default false,
    "updated_at" timestamp with time zone default now(),
    "current_period_end" timestamp with time zone
      );


alter table "public"."subscriptions" enable row level security;


  create table "public"."system_decisions" (
    "id" uuid not null default gen_random_uuid(),
    "decision_type" text not null,
    "stage" text not null,
    "title" text not null,
    "description" text,
    "confidence_score" numeric(5,2),
    "blocking" boolean default false,
    "user_visible" boolean default true,
    "requires_user_action" boolean default false,
    "review_type" text,
    "status" text not null default 'pending'::text,
    "resolved_at" timestamp with time zone,
    "resolved_by" uuid,
    "resolution_notes" text,
    "snoozed_until" timestamp with time zone,
    "snooze_count" integer default 0,
    "artifact_id" text,
    "workflow_task_id" bigint,
    "target_entity_type" text,
    "target_entity_id" text,
    "decision_payload" jsonb default '{}'::jsonb,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    "user_id" uuid not null,
    "team_id" integer
      );


alter table "public"."system_decisions" enable row level security;


  create table "public"."tasks" (
    "id" bigint generated by default as identity not null,
    "workflow_run_id" text,
    "task_type" text not null,
    "task_order" integer,
    "task_name" text,
    "status" text not null default 'pending'::text,
    "input" jsonb,
    "output" jsonb,
    "object_storage_path" text,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "duration_ms" integer,
    "error_message" text,
    "retry_count" integer default 0,
    "max_retries" integer default 3,
    "logs" jsonb,
    "created_at" timestamp with time zone not null default now()
      );



  create table "public"."team_members" (
    "id" integer not null default nextval('public.team_members_id_seq'::regclass),
    "team_id" integer not null,
    "role" character varying(50) not null,
    "joined_at" timestamp with time zone not null default now(),
    "user_id" uuid not null
      );


alter table "public"."team_members" enable row level security;


  create table "public"."teams" (
    "id" integer not null default nextval('public.teams_id_seq'::regclass),
    "name" character varying(100) not null,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    "stripe_customer_id" text,
    "stripe_subscription_id" text,
    "stripe_product_id" text,
    "plan_name" character varying(50),
    "subscription_status" character varying(20)
      );



  create table "public"."training_examples" (
    "id" text not null,
    "example_type" text not null,
    "source_workflow_run_id" text,
    "source_task_id" bigint,
    "input" jsonb not null,
    "output" jsonb not null,
    "ground_truth" jsonb,
    "context_needed" jsonb,
    "pattern_category" text,
    "pattern_notes" text,
    "difficulties" text,
    "decision_rationale" text,
    "tags" text[],
    "domain" text,
    "quality_tier" text default 'bronze'::text,
    "is_validated" boolean default false,
    "validated_by" text,
    "validated_at" timestamp with time zone,
    "embedding" public.vector(1536),
    "version" integer default 1,
    "superseded_by" text,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    "created_by" text,
    "notes" text
      );



  create table "public"."user_preferences" (
    "id" uuid not null default extensions.uuid_generate_v4(),
    "user_id" uuid not null,
    "has_completed_onboarding" boolean default false,
    "created_at" timestamp with time zone not null default timezone('utc'::text, now()),
    "updated_at" timestamp with time zone not null default timezone('utc'::text, now()),
    "user_mode" text default 'casual'::text,
    "automation_level" text default 'balanced'::text,
    "global_confidence_threshold" numeric(5,2) default 70.00,
    "show_lifecycle_details" boolean default false,
    "confidence_thresholds" jsonb default '{"task_creation": {"block": 48, "review": 68, "auto_apply": 88}, "entity_creation": {"block": 50, "review": 70, "auto_apply": 90}, "artifact_linking": {"block": 45, "review": 65, "auto_apply": 85}, "relationship_suggestion": {"block": 40, "review": 60, "auto_apply": 80}, "security_classification": {"block": 60, "review": 75, "auto_apply": 95}}'::jsonb,
    "notification_preferences" jsonb default '{"review_items": true, "daily_summary": false, "task_reminders": true, "event_reminders": true}'::jsonb
      );


alter table "public"."user_preferences" enable row level security;


  create table "public"."user_profiles" (
    "id" uuid not null,
    "name" character varying(100),
    "role" character varying(20) not null default 'member'::character varying,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    "deleted_at" timestamp with time zone
      );


alter table "public"."user_profiles" enable row level security;


  create table "public"."user_tasks" (
    "id" uuid not null default gen_random_uuid(),
    "title" text not null,
    "description" text,
    "status" text not null default 'todo'::text,
    "priority" text,
    "due_date" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "source_artifact_id" text,
    "entity_id" text,
    "assigned_to" uuid,
    "created_by" uuid,
    "confidence_score" numeric(5,2),
    "created_via" text,
    "tags" text[],
    "notes" text,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    "user_id" uuid not null,
    "team_id" integer
      );


alter table "public"."user_tasks" enable row level security;


  create table "public"."user_trials" (
    "id" uuid not null default extensions.uuid_generate_v4(),
    "user_id" uuid not null,
    "trial_start_time" timestamp with time zone default now(),
    "trial_end_time" timestamp with time zone not null,
    "is_trial_used" boolean default false
      );


alter table "public"."user_trials" enable row level security;


  create table "public"."users" (
    "id" uuid not null,
    "email" text,
    "created_at" timestamp with time zone not null default timezone('utc'::text, now()),
    "updated_at" timestamp with time zone not null default timezone('utc'::text, now()),
    "is_deleted" boolean default false,
    "deleted_at" timestamp with time zone,
    "reactivated_at" timestamp with time zone
      );


alter table "public"."users" enable row level security;


  create table "public"."waitlist_entries" (
    "id" uuid not null default gen_random_uuid(),
    "user_id" uuid,
    "email" text not null,
    "source" text default 'landing'::text,
    "notes" text,
    "status" text default 'waitlisted'::text,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "public"."waitlist_entries" enable row level security;


  create table "public"."workflow_runs" (
    "id" text not null,
    "workflow_type" text not null,
    "status" text not null default 'in_progress'::text,
    "metadata" jsonb,
    "started_at" timestamp with time zone not null default now(),
    "completed_at" timestamp with time zone,
    "executed_by" text,
    "execution_mode" text,
    "source_artifact_id" text,
    "team_id" integer,
    "user_id" uuid not null
      );


alter table "public"."workflow_runs" enable row level security;

alter sequence "public"."activity_logs_id_seq" owned by "public"."activity_logs"."id";

alter sequence "public"."invitations_id_seq" owned by "public"."invitations"."id";

alter sequence "public"."team_members_id_seq" owned by "public"."team_members"."id";

alter sequence "public"."teams_id_seq" owned by "public"."teams"."id";

CREATE UNIQUE INDEX activity_logs_pkey ON public.activity_logs USING btree (id);

CREATE UNIQUE INDEX artifact_entity_links_artifact_id_entity_id_link_type_key ON public.artifact_entity_links USING btree (artifact_id, entity_id, link_type);

CREATE UNIQUE INDEX artifact_entity_links_pkey ON public.artifact_entity_links USING btree (id);

CREATE UNIQUE INDEX artifacts_pkey ON public.artifacts USING btree (id);

CREATE INDEX artifacts_plain_text_idx ON public.artifacts USING gin (to_tsvector('english'::regconfig, plain_text));

CREATE UNIQUE INDEX derived_artifacts_pkey ON public.derived_artifacts USING btree (id);

CREATE UNIQUE INDEX derived_artifacts_source_artifact_id_storage_path_key ON public.derived_artifacts USING btree (source_artifact_id, storage_path);

CREATE UNIQUE INDEX discovered_patterns_pkey ON public.discovered_patterns USING btree (id);

CREATE UNIQUE INDEX entities_pkey ON public.entities USING btree (id);

CREATE UNIQUE INDEX entity_relationships_pkey ON public.entity_relationships USING btree (id);

CREATE UNIQUE INDEX events_pkey ON public.events USING btree (id);

CREATE INDEX idx_activity_logs_team_id ON public.activity_logs USING btree (team_id);

CREATE INDEX idx_activity_logs_user_id_uuid ON public.activity_logs USING btree (user_id) WHERE (user_id IS NOT NULL);

CREATE INDEX idx_artifact_entity_artifact ON public.artifact_entity_links USING btree (artifact_id);

CREATE INDEX idx_artifact_entity_confidence ON public.artifact_entity_links USING btree (confidence_score) WHERE (confidence_score IS NOT NULL);

CREATE INDEX idx_artifact_entity_created_by ON public.artifact_entity_links USING btree (created_by);

CREATE INDEX idx_artifact_entity_entity ON public.artifact_entity_links USING btree (entity_id);

CREATE INDEX idx_artifact_entity_link_type ON public.artifact_entity_links USING btree (link_type);

CREATE INDEX idx_artifacts_active_stage ON public.artifacts USING btree (lifecycle_stage, created_at DESC) WHERE (archived = false);

CREATE INDEX idx_artifacts_archived ON public.artifacts USING btree (archived) WHERE (archived = false);

CREATE INDEX idx_artifacts_artifact_type ON public.artifacts USING btree (artifact_type);

CREATE INDEX idx_artifacts_captured_at ON public.artifacts USING btree (captured_at);

CREATE INDEX idx_artifacts_description_fts ON public.artifacts USING gin (to_tsvector('english'::regconfig, COALESCE(description, ''::text)));

CREATE INDEX idx_artifacts_extracted_content_fts ON public.artifacts USING gin (to_tsvector('english'::regconfig, COALESCE(extracted_content, ''::text)));

CREATE INDEX idx_artifacts_extraction_confidence ON public.artifacts USING btree (extraction_confidence) WHERE (extraction_confidence IS NOT NULL);

CREATE INDEX idx_artifacts_has_derived ON public.artifacts USING btree (has_derived_artifacts) WHERE (has_derived_artifacts = true);

CREATE INDEX idx_artifacts_lifecycle_stage ON public.artifacts USING btree (lifecycle_stage);

CREATE INDEX idx_artifacts_processing_metadata ON public.artifacts USING gin (processing_metadata);

CREATE INDEX idx_artifacts_processing_status ON public.artifacts USING btree (processing_status);

CREATE INDEX idx_artifacts_source_channel ON public.artifacts USING btree (source_channel) WHERE (source_channel IS NOT NULL);

CREATE INDEX idx_artifacts_storage_object_id ON public.artifacts USING btree (storage_object_id) WHERE (storage_object_id IS NOT NULL);

CREATE INDEX idx_artifacts_tags ON public.artifacts USING gin (tags);

CREATE INDEX idx_artifacts_team_id ON public.artifacts USING btree (team_id) WHERE (team_id IS NOT NULL);

CREATE INDEX idx_artifacts_title ON public.artifacts USING btree (title) WHERE (title IS NOT NULL);

CREATE INDEX idx_artifacts_title_fts ON public.artifacts USING gin (to_tsvector('english'::regconfig, COALESCE(title, ''::text)));

CREATE INDEX idx_artifacts_user_id_uuid ON public.artifacts USING btree (user_id) WHERE (user_id IS NOT NULL);

CREATE INDEX idx_artifacts_workflow_run ON public.artifacts USING btree (workflow_run_id);

CREATE INDEX idx_derived_artifacts_metadata ON public.derived_artifacts USING gin (processing_metadata) WHERE (processing_metadata IS NOT NULL);

CREATE INDEX idx_derived_artifacts_page_number ON public.derived_artifacts USING btree (source_artifact_id, page_number) WHERE (page_number IS NOT NULL);

CREATE INDEX idx_derived_artifacts_sequence ON public.derived_artifacts USING btree (source_artifact_id, sequence_order) WHERE (sequence_order IS NOT NULL);

CREATE INDEX idx_derived_artifacts_source ON public.derived_artifacts USING btree (source_artifact_id);

CREATE INDEX idx_derived_artifacts_team_id ON public.derived_artifacts USING btree (team_id) WHERE (team_id IS NOT NULL);

CREATE INDEX idx_derived_artifacts_type ON public.derived_artifacts USING btree (artifact_type);

CREATE INDEX idx_derived_artifacts_user_id_uuid ON public.derived_artifacts USING btree (user_id) WHERE (user_id IS NOT NULL);

CREATE INDEX idx_derived_artifacts_workflow ON public.derived_artifacts USING btree (workflow_run_id) WHERE (workflow_run_id IS NOT NULL);

CREATE INDEX idx_entities_archived ON public.entities USING btree (archived) WHERE (archived = false);

CREATE INDEX idx_entities_created_at ON public.entities USING btree (created_at DESC);

CREATE INDEX idx_entities_entity_type ON public.entities USING btree (entity_type);

CREATE INDEX idx_entities_people_properties ON public.entities USING gin (properties) WHERE (entity_type = 'people'::text);

CREATE INDEX idx_entities_project_properties ON public.entities USING gin (properties) WHERE (entity_type = 'project'::text);

CREATE INDEX idx_entities_properties ON public.entities USING gin (properties);

CREATE INDEX idx_entities_resource_properties ON public.entities USING gin (properties) WHERE (entity_type = 'resource'::text);

CREATE INDEX idx_entities_tags ON public.entities USING gin (tags);

CREATE INDEX idx_entities_team_id ON public.entities USING btree (team_id) WHERE (team_id IS NOT NULL);

CREATE INDEX idx_entities_updated_at ON public.entities USING btree (updated_at DESC);

CREATE INDEX idx_entities_user_id ON public.entities USING btree (user_id);

CREATE INDEX idx_entity_rel_both ON public.entity_relationships USING btree (from_entity_id, to_entity_id);

CREATE INDEX idx_entity_rel_from ON public.entity_relationships USING btree (from_entity_id);

CREATE INDEX idx_entity_rel_to ON public.entity_relationships USING btree (to_entity_id);

CREATE INDEX idx_entity_rel_type ON public.entity_relationships USING btree (relationship_type);

CREATE INDEX idx_events_attendees ON public.events USING gin (attendees) WHERE (attendees IS NOT NULL);

CREATE INDEX idx_events_created_by ON public.events USING btree (created_by) WHERE (created_by IS NOT NULL);

CREATE INDEX idx_events_date_range ON public.events USING btree (start_time, end_time);

CREATE INDEX idx_events_end_time ON public.events USING btree (end_time) WHERE (end_time IS NOT NULL);

CREATE INDEX idx_events_entity ON public.events USING btree (entity_id) WHERE (entity_id IS NOT NULL);

CREATE INDEX idx_events_event_type ON public.events USING btree (event_type) WHERE (event_type IS NOT NULL);

CREATE INDEX idx_events_source_artifact ON public.events USING btree (source_artifact_id) WHERE (source_artifact_id IS NOT NULL);

CREATE INDEX idx_events_start_time ON public.events USING btree (start_time);

CREATE INDEX idx_events_tags ON public.events USING gin (tags) WHERE (tags IS NOT NULL);

CREATE INDEX idx_events_team_id ON public.events USING btree (team_id) WHERE (team_id IS NOT NULL);

CREATE INDEX idx_events_user_id ON public.events USING btree (user_id);

CREATE INDEX idx_invitations_email ON public.invitations USING btree (email);

CREATE INDEX idx_invitations_status ON public.invitations USING btree (status);

CREATE INDEX idx_invitations_team_id ON public.invitations USING btree (team_id);

CREATE INDEX idx_system_decisions_artifact ON public.system_decisions USING btree (artifact_id);

CREATE INDEX idx_system_decisions_blocking ON public.system_decisions USING btree (artifact_id, blocking, status) WHERE ((blocking = true) AND (status = 'pending'::text));

CREATE INDEX idx_system_decisions_created_at ON public.system_decisions USING btree (created_at DESC);

CREATE INDEX idx_system_decisions_decision_type ON public.system_decisions USING btree (decision_type);

CREATE INDEX idx_system_decisions_payload ON public.system_decisions USING gin (decision_payload);

CREATE INDEX idx_system_decisions_requires_action ON public.system_decisions USING btree (user_id, requires_user_action, status) WHERE ((requires_user_action = true) AND (status = 'pending'::text));

CREATE INDEX idx_system_decisions_review_backlog ON public.system_decisions USING btree (user_id, status, blocking, user_visible) WHERE ((user_visible = true) AND (status = ANY (ARRAY['pending'::text, 'snoozed'::text])));

CREATE INDEX idx_system_decisions_review_type ON public.system_decisions USING btree (review_type) WHERE (review_type IS NOT NULL);

CREATE INDEX idx_system_decisions_snoozed ON public.system_decisions USING btree (snoozed_until) WHERE (snoozed_until IS NOT NULL);

CREATE INDEX idx_system_decisions_stage ON public.system_decisions USING btree (stage);

CREATE INDEX idx_system_decisions_status ON public.system_decisions USING btree (status);

CREATE INDEX idx_system_decisions_target ON public.system_decisions USING btree (target_entity_type, target_entity_id);

CREATE INDEX idx_system_decisions_team ON public.system_decisions USING btree (team_id);

CREATE INDEX idx_system_decisions_user ON public.system_decisions USING btree (user_id);

CREATE INDEX idx_system_decisions_workflow_task ON public.system_decisions USING btree (workflow_task_id);

CREATE INDEX idx_tasks_status ON public.tasks USING btree (status);

CREATE INDEX idx_tasks_type ON public.tasks USING btree (task_type);

CREATE INDEX idx_tasks_workflow_run_id ON public.tasks USING btree (workflow_run_id);

CREATE INDEX idx_team_members_team_id ON public.team_members USING btree (team_id);

CREATE INDEX idx_team_members_user_id_uuid ON public.team_members USING btree (user_id) WHERE (user_id IS NOT NULL);

CREATE INDEX idx_teams_stripe_customer_id ON public.teams USING btree (stripe_customer_id);

CREATE INDEX idx_teams_stripe_subscription_id ON public.teams USING btree (stripe_subscription_id);

CREATE INDEX idx_training_examples_pattern_category ON public.training_examples USING btree (pattern_category);

CREATE INDEX idx_training_examples_quality_tier ON public.training_examples USING btree (quality_tier);

CREATE INDEX idx_training_examples_source_workflow ON public.training_examples USING btree (source_workflow_run_id);

CREATE INDEX idx_training_examples_tags ON public.training_examples USING gin (tags);

CREATE INDEX idx_training_examples_type ON public.training_examples USING btree (example_type);

CREATE INDEX idx_user_preferences_confidence_thresholds ON public.user_preferences USING gin (confidence_thresholds);

CREATE INDEX idx_user_preferences_notifications ON public.user_preferences USING gin (notification_preferences);

CREATE INDEX idx_user_profiles_deleted_at ON public.user_profiles USING btree (deleted_at);

CREATE INDEX idx_user_profiles_role ON public.user_profiles USING btree (role);

CREATE INDEX idx_user_tasks_assigned_to ON public.user_tasks USING btree (assigned_to) WHERE (assigned_to IS NOT NULL);

CREATE INDEX idx_user_tasks_created_at ON public.user_tasks USING btree (created_at DESC);

CREATE INDEX idx_user_tasks_created_by ON public.user_tasks USING btree (created_by) WHERE (created_by IS NOT NULL);

CREATE INDEX idx_user_tasks_due_date ON public.user_tasks USING btree (due_date) WHERE ((status <> 'done'::text) AND (due_date IS NOT NULL));

CREATE INDEX idx_user_tasks_entity ON public.user_tasks USING btree (entity_id) WHERE (entity_id IS NOT NULL);

CREATE INDEX idx_user_tasks_priority ON public.user_tasks USING btree (priority) WHERE (priority IS NOT NULL);

CREATE INDEX idx_user_tasks_source_artifact ON public.user_tasks USING btree (source_artifact_id) WHERE (source_artifact_id IS NOT NULL);

CREATE INDEX idx_user_tasks_status ON public.user_tasks USING btree (status);

CREATE INDEX idx_user_tasks_status_active ON public.user_tasks USING btree (status) WHERE (status = ANY (ARRAY['todo'::text, 'in_progress'::text]));

CREATE INDEX idx_user_tasks_tags ON public.user_tasks USING gin (tags) WHERE (tags IS NOT NULL);

CREATE INDEX idx_user_tasks_team_id ON public.user_tasks USING btree (team_id) WHERE (team_id IS NOT NULL);

CREATE INDEX idx_user_tasks_user_id ON public.user_tasks USING btree (user_id);

CREATE INDEX idx_waitlist_entries_created_at ON public.waitlist_entries USING btree (created_at DESC);

CREATE UNIQUE INDEX idx_waitlist_entries_user_id ON public.waitlist_entries USING btree (user_id) WHERE (user_id IS NOT NULL);

CREATE INDEX idx_workflow_runs_started_at ON public.workflow_runs USING btree (started_at);

CREATE INDEX idx_workflow_runs_status ON public.workflow_runs USING btree (status);

CREATE INDEX idx_workflow_runs_team_id ON public.workflow_runs USING btree (team_id) WHERE (team_id IS NOT NULL);

CREATE INDEX idx_workflow_runs_type ON public.workflow_runs USING btree (workflow_type);

CREATE INDEX idx_workflow_runs_user_id_uuid ON public.workflow_runs USING btree (user_id) WHERE (user_id IS NOT NULL);

CREATE UNIQUE INDEX invitations_pkey ON public.invitations USING btree (id);

CREATE UNIQUE INDEX subscriptions_pkey ON public.subscriptions USING btree (id);

CREATE UNIQUE INDEX system_decisions_pkey ON public.system_decisions USING btree (id);

CREATE UNIQUE INDEX tasks_pkey ON public.tasks USING btree (id);

CREATE UNIQUE INDEX team_members_pkey ON public.team_members USING btree (id);

CREATE UNIQUE INDEX teams_pkey ON public.teams USING btree (id);

CREATE UNIQUE INDEX teams_stripe_customer_id_key ON public.teams USING btree (stripe_customer_id);

CREATE UNIQUE INDEX teams_stripe_subscription_id_key ON public.teams USING btree (stripe_subscription_id);

CREATE UNIQUE INDEX training_examples_pkey ON public.training_examples USING btree (id);

CREATE UNIQUE INDEX user_preferences_pkey ON public.user_preferences USING btree (id);

CREATE UNIQUE INDEX user_preferences_user_id_key ON public.user_preferences USING btree (user_id);

CREATE UNIQUE INDEX user_profiles_pkey ON public.user_profiles USING btree (id);

CREATE UNIQUE INDEX user_tasks_pkey ON public.user_tasks USING btree (id);

CREATE UNIQUE INDEX user_trials_pkey ON public.user_trials USING btree (id);

CREATE UNIQUE INDEX user_trials_user_id_key ON public.user_trials USING btree (user_id);

CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id);

CREATE UNIQUE INDEX waitlist_entries_email_key ON public.waitlist_entries USING btree (email);

CREATE UNIQUE INDEX waitlist_entries_pkey ON public.waitlist_entries USING btree (id);

CREATE UNIQUE INDEX workflow_runs_pkey ON public.workflow_runs USING btree (id);

alter table "public"."activity_logs" add constraint "activity_logs_pkey" PRIMARY KEY using index "activity_logs_pkey";

alter table "public"."artifact_entity_links" add constraint "artifact_entity_links_pkey" PRIMARY KEY using index "artifact_entity_links_pkey";

alter table "public"."artifacts" add constraint "artifacts_pkey" PRIMARY KEY using index "artifacts_pkey";

alter table "public"."derived_artifacts" add constraint "derived_artifacts_pkey" PRIMARY KEY using index "derived_artifacts_pkey";

alter table "public"."discovered_patterns" add constraint "discovered_patterns_pkey" PRIMARY KEY using index "discovered_patterns_pkey";

alter table "public"."entities" add constraint "entities_pkey" PRIMARY KEY using index "entities_pkey";

alter table "public"."entity_relationships" add constraint "entity_relationships_pkey" PRIMARY KEY using index "entity_relationships_pkey";

alter table "public"."events" add constraint "events_pkey" PRIMARY KEY using index "events_pkey";

alter table "public"."invitations" add constraint "invitations_pkey" PRIMARY KEY using index "invitations_pkey";

alter table "public"."subscriptions" add constraint "subscriptions_pkey" PRIMARY KEY using index "subscriptions_pkey";

alter table "public"."system_decisions" add constraint "system_decisions_pkey" PRIMARY KEY using index "system_decisions_pkey";

alter table "public"."tasks" add constraint "tasks_pkey" PRIMARY KEY using index "tasks_pkey";

alter table "public"."team_members" add constraint "team_members_pkey" PRIMARY KEY using index "team_members_pkey";

alter table "public"."teams" add constraint "teams_pkey" PRIMARY KEY using index "teams_pkey";

alter table "public"."training_examples" add constraint "training_examples_pkey" PRIMARY KEY using index "training_examples_pkey";

alter table "public"."user_preferences" add constraint "user_preferences_pkey" PRIMARY KEY using index "user_preferences_pkey";

alter table "public"."user_profiles" add constraint "user_profiles_pkey" PRIMARY KEY using index "user_profiles_pkey";

alter table "public"."user_tasks" add constraint "user_tasks_pkey" PRIMARY KEY using index "user_tasks_pkey";

alter table "public"."user_trials" add constraint "user_trials_pkey" PRIMARY KEY using index "user_trials_pkey";

alter table "public"."users" add constraint "users_pkey" PRIMARY KEY using index "users_pkey";

alter table "public"."waitlist_entries" add constraint "waitlist_entries_pkey" PRIMARY KEY using index "waitlist_entries_pkey";

alter table "public"."workflow_runs" add constraint "workflow_runs_pkey" PRIMARY KEY using index "workflow_runs_pkey";

alter table "public"."activity_logs" add constraint "activity_logs_team_id_fkey" FOREIGN KEY (team_id) REFERENCES public.teams(id) not valid;

alter table "public"."activity_logs" validate constraint "activity_logs_team_id_fkey";

alter table "public"."activity_logs" add constraint "activity_logs_user_id_uuid_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."activity_logs" validate constraint "activity_logs_user_id_uuid_fkey";

alter table "public"."artifact_entity_links" add constraint "artifact_entity_links_artifact_id_entity_id_link_type_key" UNIQUE using index "artifact_entity_links_artifact_id_entity_id_link_type_key";

alter table "public"."artifact_entity_links" add constraint "artifact_entity_links_artifact_id_fkey" FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON DELETE CASCADE not valid;

alter table "public"."artifact_entity_links" validate constraint "artifact_entity_links_artifact_id_fkey";

alter table "public"."artifact_entity_links" add constraint "artifact_entity_links_confidence_score_check" CHECK (((confidence_score >= (0)::numeric) AND (confidence_score <= (100)::numeric))) not valid;

alter table "public"."artifact_entity_links" validate constraint "artifact_entity_links_confidence_score_check";

alter table "public"."artifact_entity_links" add constraint "artifact_entity_links_entity_id_fkey" FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE not valid;

alter table "public"."artifact_entity_links" validate constraint "artifact_entity_links_entity_id_fkey";

alter table "public"."artifact_entity_links" add constraint "artifact_entity_links_link_type_check" CHECK ((link_type = ANY (ARRAY['primary'::text, 'mentioned'::text, 'related'::text]))) not valid;

alter table "public"."artifact_entity_links" validate constraint "artifact_entity_links_link_type_check";

alter table "public"."artifacts" add constraint "artifacts_extraction_confidence_check" CHECK (((extraction_confidence IS NULL) OR ((extraction_confidence >= (0)::numeric) AND (extraction_confidence <= (1)::numeric)))) not valid;

alter table "public"."artifacts" validate constraint "artifacts_extraction_confidence_check";

alter table "public"."artifacts" add constraint "artifacts_lifecycle_stage_check" CHECK ((lifecycle_stage = ANY (ARRAY['uploaded'::text, 'processing'::text, 'extracted'::text, 'contextualized'::text, 'actionable'::text, 'refined'::text, 'processed'::text, 'archived'::text, 'blocked'::text, 'needs_review'::text, 'failed'::text]))) not valid;

alter table "public"."artifacts" validate constraint "artifacts_lifecycle_stage_check";

alter table "public"."artifacts" add constraint "artifacts_previous_version_id_fkey" FOREIGN KEY (previous_version_id) REFERENCES public.artifacts(id) not valid;

alter table "public"."artifacts" validate constraint "artifacts_previous_version_id_fkey";

alter table "public"."artifacts" add constraint "artifacts_processing_status_check" CHECK ((processing_status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'completed'::text, 'failed'::text]))) not valid;

alter table "public"."artifacts" validate constraint "artifacts_processing_status_check";

alter table "public"."artifacts" add constraint "artifacts_source_channel_check" CHECK (((source_channel IS NULL) OR (source_channel = ANY (ARRAY['phone_app'::text, 'web_upload'::text, 'email'::text, 'api'::text, 'whatsapp'::text, 'slack'::text, 'telegram'::text, 'browser_extension'::text, 'desktop_app'::text, 'other'::text])) OR (source_channel ~ '^[a-z_]+$'::text))) not valid;

alter table "public"."artifacts" validate constraint "artifacts_source_channel_check";

alter table "public"."artifacts" add constraint "artifacts_team_id_fkey" FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE SET NULL not valid;

alter table "public"."artifacts" validate constraint "artifacts_team_id_fkey";

alter table "public"."artifacts" add constraint "artifacts_user_id_uuid_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."artifacts" validate constraint "artifacts_user_id_uuid_fkey";

alter table "public"."artifacts" add constraint "artifacts_workflow_run_id_fkey" FOREIGN KEY (workflow_run_id) REFERENCES public.workflow_runs(id) ON DELETE SET NULL not valid;

alter table "public"."artifacts" validate constraint "artifacts_workflow_run_id_fkey";

alter table "public"."derived_artifacts" add constraint "derived_artifacts_artifact_type_check" CHECK ((artifact_type = ANY (ARRAY['split_page'::text, 'ocr_text'::text, 'thumbnail'::text, 'extracted_text'::text, 'other'::text]))) not valid;

alter table "public"."derived_artifacts" validate constraint "derived_artifacts_artifact_type_check";

alter table "public"."derived_artifacts" add constraint "derived_artifacts_source_artifact_id_fkey" FOREIGN KEY (source_artifact_id) REFERENCES public.artifacts(id) ON DELETE CASCADE not valid;

alter table "public"."derived_artifacts" validate constraint "derived_artifacts_source_artifact_id_fkey";

alter table "public"."derived_artifacts" add constraint "derived_artifacts_source_artifact_id_storage_path_key" UNIQUE using index "derived_artifacts_source_artifact_id_storage_path_key";

alter table "public"."derived_artifacts" add constraint "derived_artifacts_team_id_fkey" FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE SET NULL not valid;

alter table "public"."derived_artifacts" validate constraint "derived_artifacts_team_id_fkey";

alter table "public"."derived_artifacts" add constraint "derived_artifacts_user_id_uuid_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."derived_artifacts" validate constraint "derived_artifacts_user_id_uuid_fkey";

alter table "public"."entities" add constraint "entities_entity_type_check" CHECK ((entity_type = ANY (ARRAY['project'::text, 'area'::text, 'resource'::text, 'memory'::text, 'people'::text, 'secure'::text, 'archive'::text]))) not valid;

alter table "public"."entities" validate constraint "entities_entity_type_check";

alter table "public"."entities" add constraint "entities_team_id_fkey" FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE not valid;

alter table "public"."entities" validate constraint "entities_team_id_fkey";

alter table "public"."entities" add constraint "entities_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."entities" validate constraint "entities_user_id_fkey";

alter table "public"."entity_relationships" add constraint "entity_relationships_confidence_score_check" CHECK (((confidence_score >= (0)::numeric) AND (confidence_score <= (100)::numeric))) not valid;

alter table "public"."entity_relationships" validate constraint "entity_relationships_confidence_score_check";

alter table "public"."entity_relationships" add constraint "entity_relationships_from_entity_id_fkey" FOREIGN KEY (from_entity_id) REFERENCES public.entities(id) ON DELETE CASCADE not valid;

alter table "public"."entity_relationships" validate constraint "entity_relationships_from_entity_id_fkey";

alter table "public"."entity_relationships" add constraint "entity_relationships_relationship_type_check" CHECK ((relationship_type = ANY (ARRAY['belongs_to'::text, 'related_to'::text, 'mentions'::text, 'depends_on'::text, 'supersedes'::text]))) not valid;

alter table "public"."entity_relationships" validate constraint "entity_relationships_relationship_type_check";

alter table "public"."entity_relationships" add constraint "entity_relationships_to_entity_id_fkey" FOREIGN KEY (to_entity_id) REFERENCES public.entities(id) ON DELETE CASCADE not valid;

alter table "public"."entity_relationships" validate constraint "entity_relationships_to_entity_id_fkey";

alter table "public"."entity_relationships" add constraint "no_self_reference" CHECK ((from_entity_id <> to_entity_id)) not valid;

alter table "public"."entity_relationships" validate constraint "no_self_reference";

alter table "public"."events" add constraint "events_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL not valid;

alter table "public"."events" validate constraint "events_created_by_fkey";

alter table "public"."events" add constraint "events_entity_id_fkey" FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE SET NULL not valid;

alter table "public"."events" validate constraint "events_entity_id_fkey";

alter table "public"."events" add constraint "events_event_type_check" CHECK ((event_type = ANY (ARRAY['meeting'::text, 'deadline'::text, 'reminder'::text, 'other'::text]))) not valid;

alter table "public"."events" validate constraint "events_event_type_check";

alter table "public"."events" add constraint "events_source_artifact_id_fkey" FOREIGN KEY (source_artifact_id) REFERENCES public.artifacts(id) ON DELETE SET NULL not valid;

alter table "public"."events" validate constraint "events_source_artifact_id_fkey";

alter table "public"."events" add constraint "events_team_id_fkey" FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE not valid;

alter table "public"."events" validate constraint "events_team_id_fkey";

alter table "public"."events" add constraint "events_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."events" validate constraint "events_user_id_fkey";

alter table "public"."invitations" add constraint "invitations_invited_by_uuid_fkey" FOREIGN KEY (invited_by) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."invitations" validate constraint "invitations_invited_by_uuid_fkey";

alter table "public"."invitations" add constraint "invitations_team_id_fkey" FOREIGN KEY (team_id) REFERENCES public.teams(id) not valid;

alter table "public"."invitations" validate constraint "invitations_team_id_fkey";

alter table "public"."subscriptions" add constraint "subscriptions_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."subscriptions" validate constraint "subscriptions_user_id_fkey";

alter table "public"."system_decisions" add constraint "system_decisions_artifact_id_fkey" FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON DELETE CASCADE not valid;

alter table "public"."system_decisions" validate constraint "system_decisions_artifact_id_fkey";

alter table "public"."system_decisions" add constraint "system_decisions_resolved_by_fkey" FOREIGN KEY (resolved_by) REFERENCES auth.users(id) ON DELETE SET NULL not valid;

alter table "public"."system_decisions" validate constraint "system_decisions_resolved_by_fkey";

alter table "public"."system_decisions" add constraint "system_decisions_review_type_check" CHECK ((review_type = ANY (ARRAY['approval'::text, 'clarification'::text, 'suggestion'::text, 'quality_check'::text]))) not valid;

alter table "public"."system_decisions" validate constraint "system_decisions_review_type_check";

alter table "public"."system_decisions" add constraint "system_decisions_stage_check" CHECK ((stage = ANY (ARRAY['capture'::text, 'organize'::text, 'pre_process'::text, 'extract'::text, 'contextualize'::text, 'act'::text, 'refine'::text, 'automate'::text]))) not valid;

alter table "public"."system_decisions" validate constraint "system_decisions_stage_check";

alter table "public"."system_decisions" add constraint "system_decisions_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'auto_applied'::text, 'approved'::text, 'rejected'::text, 'modified'::text, 'snoozed'::text, 'expired'::text]))) not valid;

alter table "public"."system_decisions" validate constraint "system_decisions_status_check";

alter table "public"."system_decisions" add constraint "system_decisions_team_id_fkey" FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE not valid;

alter table "public"."system_decisions" validate constraint "system_decisions_team_id_fkey";

alter table "public"."system_decisions" add constraint "system_decisions_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."system_decisions" validate constraint "system_decisions_user_id_fkey";

alter table "public"."system_decisions" add constraint "system_decisions_workflow_task_id_fkey" FOREIGN KEY (workflow_task_id) REFERENCES public.tasks(id) ON DELETE SET NULL not valid;

alter table "public"."system_decisions" validate constraint "system_decisions_workflow_task_id_fkey";

alter table "public"."tasks" add constraint "tasks_workflow_run_id_fkey" FOREIGN KEY (workflow_run_id) REFERENCES public.workflow_runs(id) ON DELETE CASCADE not valid;

alter table "public"."tasks" validate constraint "tasks_workflow_run_id_fkey";

alter table "public"."tasks" add constraint "valid_task_status" CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text, 'skipped'::text]))) not valid;

alter table "public"."tasks" validate constraint "valid_task_status";

alter table "public"."team_members" add constraint "team_members_team_id_fkey" FOREIGN KEY (team_id) REFERENCES public.teams(id) not valid;

alter table "public"."team_members" validate constraint "team_members_team_id_fkey";

alter table "public"."team_members" add constraint "team_members_user_id_uuid_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."team_members" validate constraint "team_members_user_id_uuid_fkey";

alter table "public"."teams" add constraint "teams_stripe_customer_id_key" UNIQUE using index "teams_stripe_customer_id_key";

alter table "public"."teams" add constraint "teams_stripe_subscription_id_key" UNIQUE using index "teams_stripe_subscription_id_key";

alter table "public"."training_examples" add constraint "training_examples_source_task_id_fkey" FOREIGN KEY (source_task_id) REFERENCES public.tasks(id) ON DELETE SET NULL not valid;

alter table "public"."training_examples" validate constraint "training_examples_source_task_id_fkey";

alter table "public"."training_examples" add constraint "training_examples_source_workflow_run_id_fkey" FOREIGN KEY (source_workflow_run_id) REFERENCES public.workflow_runs(id) ON DELETE SET NULL not valid;

alter table "public"."training_examples" validate constraint "training_examples_source_workflow_run_id_fkey";

alter table "public"."training_examples" add constraint "training_examples_superseded_by_fkey" FOREIGN KEY (superseded_by) REFERENCES public.training_examples(id) not valid;

alter table "public"."training_examples" validate constraint "training_examples_superseded_by_fkey";

alter table "public"."training_examples" add constraint "valid_quality_tier" CHECK ((quality_tier = ANY (ARRAY['gold'::text, 'silver'::text, 'bronze'::text]))) not valid;

alter table "public"."training_examples" validate constraint "valid_quality_tier";

alter table "public"."user_preferences" add constraint "user_preferences_automation_level_check" CHECK ((automation_level = ANY (ARRAY['manual'::text, 'balanced'::text, 'aggressive'::text]))) not valid;

alter table "public"."user_preferences" validate constraint "user_preferences_automation_level_check";

alter table "public"."user_preferences" add constraint "user_preferences_global_confidence_threshold_check" CHECK (((global_confidence_threshold >= (0)::numeric) AND (global_confidence_threshold <= (100)::numeric))) not valid;

alter table "public"."user_preferences" validate constraint "user_preferences_global_confidence_threshold_check";

alter table "public"."user_preferences" add constraint "user_preferences_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."user_preferences" validate constraint "user_preferences_user_id_fkey";

alter table "public"."user_preferences" add constraint "user_preferences_user_id_key" UNIQUE using index "user_preferences_user_id_key";

alter table "public"."user_preferences" add constraint "user_preferences_user_mode_check" CHECK ((user_mode = ANY (ARRAY['casual'::text, 'power'::text]))) not valid;

alter table "public"."user_preferences" validate constraint "user_preferences_user_mode_check";

alter table "public"."user_profiles" add constraint "user_profiles_id_fkey" FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."user_profiles" validate constraint "user_profiles_id_fkey";

alter table "public"."user_tasks" add constraint "user_tasks_assigned_to_fkey" FOREIGN KEY (assigned_to) REFERENCES auth.users(id) ON DELETE SET NULL not valid;

alter table "public"."user_tasks" validate constraint "user_tasks_assigned_to_fkey";

alter table "public"."user_tasks" add constraint "user_tasks_confidence_score_check" CHECK (((confidence_score >= (0)::numeric) AND (confidence_score <= (100)::numeric))) not valid;

alter table "public"."user_tasks" validate constraint "user_tasks_confidence_score_check";

alter table "public"."user_tasks" add constraint "user_tasks_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL not valid;

alter table "public"."user_tasks" validate constraint "user_tasks_created_by_fkey";

alter table "public"."user_tasks" add constraint "user_tasks_created_via_check" CHECK ((created_via = ANY (ARRAY['system'::text, 'manual'::text, 'api'::text]))) not valid;

alter table "public"."user_tasks" validate constraint "user_tasks_created_via_check";

alter table "public"."user_tasks" add constraint "user_tasks_entity_id_fkey" FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE SET NULL not valid;

alter table "public"."user_tasks" validate constraint "user_tasks_entity_id_fkey";

alter table "public"."user_tasks" add constraint "user_tasks_priority_check" CHECK ((priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'urgent'::text]))) not valid;

alter table "public"."user_tasks" validate constraint "user_tasks_priority_check";

alter table "public"."user_tasks" add constraint "user_tasks_source_artifact_id_fkey" FOREIGN KEY (source_artifact_id) REFERENCES public.artifacts(id) ON DELETE SET NULL not valid;

alter table "public"."user_tasks" validate constraint "user_tasks_source_artifact_id_fkey";

alter table "public"."user_tasks" add constraint "user_tasks_status_check" CHECK ((status = ANY (ARRAY['todo'::text, 'in_progress'::text, 'done'::text, 'cancelled'::text]))) not valid;

alter table "public"."user_tasks" validate constraint "user_tasks_status_check";

alter table "public"."user_tasks" add constraint "user_tasks_team_id_fkey" FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE not valid;

alter table "public"."user_tasks" validate constraint "user_tasks_team_id_fkey";

alter table "public"."user_tasks" add constraint "user_tasks_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."user_tasks" validate constraint "user_tasks_user_id_fkey";

alter table "public"."user_trials" add constraint "user_trials_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) not valid;

alter table "public"."user_trials" validate constraint "user_trials_user_id_fkey";

alter table "public"."user_trials" add constraint "user_trials_user_id_key" UNIQUE using index "user_trials_user_id_key";

alter table "public"."users" add constraint "users_id_fkey" FOREIGN KEY (id) REFERENCES auth.users(id) not valid;

alter table "public"."users" validate constraint "users_id_fkey";

alter table "public"."waitlist_entries" add constraint "waitlist_entries_email_key" UNIQUE using index "waitlist_entries_email_key";

alter table "public"."waitlist_entries" add constraint "waitlist_entries_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."waitlist_entries" validate constraint "waitlist_entries_user_id_fkey";

alter table "public"."workflow_runs" add constraint "valid_status" CHECK ((status = ANY (ARRAY['in_progress'::text, 'completed'::text, 'failed'::text, 'cancelled'::text]))) not valid;

alter table "public"."workflow_runs" validate constraint "valid_status";

alter table "public"."workflow_runs" add constraint "workflow_runs_source_artifact_id_fkey" FOREIGN KEY (source_artifact_id) REFERENCES public.artifacts(id) not valid;

alter table "public"."workflow_runs" validate constraint "workflow_runs_source_artifact_id_fkey";

alter table "public"."workflow_runs" add constraint "workflow_runs_team_id_fkey" FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE SET NULL not valid;

alter table "public"."workflow_runs" validate constraint "workflow_runs_team_id_fkey";

alter table "public"."workflow_runs" add constraint "workflow_runs_user_id_uuid_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."workflow_runs" validate constraint "workflow_runs_user_id_uuid_fkey";

set check_function_bodies = off;

create or replace view "public"."active_workflows" as  SELECT wr.id,
    wr.workflow_type,
    wr.status,
    wr.metadata,
    wr.started_at,
    wr.completed_at,
    wr.executed_by,
    wr.execution_mode,
    count(t.id) AS total_tasks,
    sum(
        CASE
            WHEN (t.status = 'completed'::text) THEN 1
            ELSE 0
        END) AS completed_tasks,
    sum(
        CASE
            WHEN (t.status = 'failed'::text) THEN 1
            ELSE 0
        END) AS failed_tasks
   FROM (public.workflow_runs wr
     LEFT JOIN public.tasks t ON ((wr.id = t.workflow_run_id)))
  WHERE (wr.status = 'in_progress'::text)
  GROUP BY wr.id;


CREATE OR REPLACE FUNCTION public.add_artifact_tags(p_artifact_id text, p_new_tags text[])
 RETURNS public.artifacts
 LANGUAGE plpgsql
AS $function$
DECLARE
  updated_artifact public.artifacts;
BEGIN
  UPDATE public.artifacts
  SET tags = array(SELECT DISTINCT unnest(tags || p_new_tags)),
      updated_at = NOW()
  WHERE id = p_artifact_id
  RETURNING * INTO updated_artifact;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Artifact not found: %', p_artifact_id;
  END IF;
  
  RETURN updated_artifact;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.add_event_attendees(p_event_id uuid, p_attendee_ids text[])
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
  valid_count INTEGER;
BEGIN
  -- Verify all attendee IDs are valid People entities
  SELECT COUNT(*) INTO valid_count
  FROM entities
  WHERE id = ANY(p_attendee_ids)
    AND entity_type = 'people';
  
  IF valid_count != array_length(p_attendee_ids, 1) THEN
    RAISE EXCEPTION 'One or more attendee IDs are not valid People entities';
  END IF;
  
  -- Update event with attendees
  UPDATE events
  SET attendees = p_attendee_ids,
      updated_at = NOW()
  WHERE id = p_event_id;
  
  RETURN FOUND;
END;
$function$
;

create or replace view "public"."archive" as  SELECT id,
    entity_type,
    title,
    description,
    (properties ->> 'original_entity_type'::text) AS original_entity_type,
    (properties ->> 'archived_reason'::text) AS archived_reason,
    (properties ->> 'archived_from_id'::text) AS archived_from_id,
    (properties ->> 'archive_notes'::text) AS archive_notes,
    tags,
    archived,
    archived_at,
    properties,
    user_id,
    team_id,
    created_at,
    updated_at
   FROM public.entities
  WHERE ((archived = true) OR (entity_type = 'archive'::text));


create or replace view "public"."areas" as  SELECT id,
    title,
    description,
    (properties ->> 'responsibility_type'::text) AS responsibility_type,
    (properties ->> 'review_frequency'::text) AS review_frequency,
    ((properties ->> 'active'::text))::boolean AS active,
    tags,
    archived,
    archived_at,
    properties,
    user_id,
    team_id,
    created_at,
    updated_at
   FROM public.entities
  WHERE (entity_type = 'area'::text);


CREATE OR REPLACE FUNCTION public.create_entity(p_entity_type text, p_title text, p_description text DEFAULT NULL::text, p_properties jsonb DEFAULT '{}'::jsonb, p_tags text[] DEFAULT ARRAY[]::text[], p_user_id uuid DEFAULT NULL::uuid, p_team_id integer DEFAULT NULL::integer)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
  new_id TEXT;
BEGIN
  -- Generate ID based on entity type
  new_id := generate_entity_id(p_entity_type);
  
  -- Insert entity
  INSERT INTO entities (
    id, entity_type, title, description, properties, tags, user_id, team_id
  ) VALUES (
    new_id, p_entity_type, p_title, p_description, p_properties, p_tags, p_user_id, p_team_id
  );
  
  RETURN new_id;
END;
$function$
;

create or replace view "public"."example_statistics" as  SELECT pattern_category,
    example_type,
    count(*) AS example_count,
    avg(
        CASE quality_tier
            WHEN 'gold'::text THEN 3
            WHEN 'silver'::text THEN 2
            WHEN 'bronze'::text THEN 1
            ELSE NULL::integer
        END) AS avg_quality_score
   FROM public.training_examples
  GROUP BY pattern_category, example_type;


CREATE OR REPLACE FUNCTION public.generate_entity_id(entity_type_param text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
  prefix TEXT;
  uuid_part TEXT;
BEGIN
  -- Determine prefix based on entity type
  prefix := CASE entity_type_param
    WHEN 'project' THEN 'proj'
    WHEN 'area' THEN 'area'
    WHEN 'resource' THEN 'rsrc'
    WHEN 'memory' THEN 'mem'
    WHEN 'people' THEN 'person'
    WHEN 'secure' THEN 'sec'
    WHEN 'archive' THEN 'arch'
    ELSE 'entity'
  END;
  
  -- Get first 8 characters of a new UUID (without hyphens)
  uuid_part := SUBSTRING(REPLACE(gen_random_uuid()::TEXT, '-', ''), 1, 8);
  
  RETURN prefix || '_' || uuid_part;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_artifact_decision_history(p_artifact_id text)
 RETURNS TABLE(id uuid, decision_type text, stage text, title text, description text, confidence_score numeric, blocking boolean, user_visible boolean, status text, target_entity_type text, target_entity_id text, decision_payload jsonb, resolved_at timestamp with time zone, resolved_by uuid, resolution_notes text, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT 
    id,
    decision_type,
    stage,
    title,
    description,
    confidence_score,
    blocking,
    user_visible,
    status,
    target_entity_type,
    target_entity_id,
    decision_payload,
    resolved_at,
    resolved_by,
    resolution_notes,
    created_at
  FROM system_decisions
  WHERE artifact_id = p_artifact_id
  ORDER BY created_at ASC;
$function$
;

CREATE OR REPLACE FUNCTION public.get_artifacts_by_stage(p_user_id uuid, p_stage text, p_limit integer DEFAULT 100)
 RETURNS SETOF public.artifacts
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.artifacts
  WHERE user_id = p_user_id
    AND lifecycle_stage = p_stage
    AND archived = FALSE
  ORDER BY created_at DESC
  LIMIT p_limit;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_artifacts_needing_attention(p_user_id uuid)
 RETURNS SETOF public.artifacts
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.artifacts
  WHERE user_id = p_user_id
    AND lifecycle_stage IN ('blocked', 'needs_review', 'failed')
    AND archived = FALSE
  ORDER BY 
    CASE lifecycle_stage
      WHEN 'blocked' THEN 1
      WHEN 'needs_review' THEN 2
      WHEN 'failed' THEN 3
      ELSE 4
    END,
    created_at DESC;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_automation_preset_values(p_automation_level text)
 RETURNS TABLE(global_threshold numeric, description text, typical_behavior text)
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    CASE p_automation_level
      WHEN 'manual' THEN 90.00
      WHEN 'balanced' THEN 70.00
      WHEN 'aggressive' THEN 50.00
      ELSE 70.00
    END as global_threshold,
    CASE p_automation_level
      WHEN 'manual' THEN 'High involvement - System suggests, rarely auto-applies'
      WHEN 'balanced' THEN 'Assistive - High-confidence decisions auto-applied, medium creates suggestions'
      WHEN 'aggressive' THEN 'Automatic - System auto-applies most decisions, only risky ones need review'
      ELSE 'Balanced automation'
    END as description,
    CASE p_automation_level
      WHEN 'manual' THEN 'Many review items, ideal for early days or cautious users'
      WHEN 'balanced' THEN 'Safe default, good balance of automation and control'
      WHEN 'aggressive' THEN 'Ideal for power users who trust the system'
      ELSE 'Balanced approach'
    END as typical_behavior;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_blocking_decisions(p_artifact_id text)
 RETURNS TABLE(id uuid, decision_type text, stage text, title text, description text, review_type text, requires_user_action boolean, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT 
    id,
    decision_type,
    stage,
    title,
    description,
    review_type,
    requires_user_action,
    created_at
  FROM system_decisions
  WHERE artifact_id = p_artifact_id
    AND blocking = TRUE
    AND status = 'pending'
  ORDER BY created_at ASC;
$function$
;

CREATE OR REPLACE FUNCTION public.get_review_backlog(p_user_id uuid, p_include_snoozed boolean DEFAULT false)
 RETURNS TABLE(id uuid, decision_type text, stage text, title text, description text, confidence_score numeric, blocking boolean, requires_user_action boolean, review_type text, status text, artifact_id text, target_entity_type text, target_entity_id text, decision_payload jsonb, snoozed_until timestamp with time zone, created_at timestamp with time zone, team_id integer)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT 
    id,
    decision_type,
    stage,
    title,
    description,
    confidence_score,
    blocking,
    requires_user_action,
    review_type,
    status,
    artifact_id,
    target_entity_type,
    target_entity_id,
    decision_payload,
    snoozed_until,
    created_at,
    team_id
  FROM system_decisions
  WHERE user_id = p_user_id
    AND user_visible = TRUE
    AND (
      status = 'pending'
      OR (p_include_snoozed AND status = 'snoozed' AND snoozed_until <= NOW())
    )
  ORDER BY 
    blocking DESC,           -- Blocking items first
    requires_user_action DESC, -- Action items before FYI
    created_at ASC;          -- Oldest first
$function$
;

CREATE OR REPLACE FUNCTION public.get_tasks_for_today(p_user_id uuid)
 RETURNS TABLE(id uuid, title text, description text, status text, priority text, due_date timestamp with time zone, entity_id text, entity_title text, entity_type text)
 LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    ut.id,
    ut.title,
    ut.description,
    ut.status,
    ut.priority,
    ut.due_date,
    ut.entity_id,
    e.title as entity_title,
    e.entity_type
  FROM user_tasks ut
  LEFT JOIN entities e ON ut.entity_id = e.id
  WHERE ut.user_id = p_user_id
    AND ut.status IN ('todo', 'in_progress')
    AND (
      ut.due_date::date = CURRENT_DATE
      OR ut.due_date IS NULL
    )
  ORDER BY 
    CASE ut.priority
      WHEN 'urgent' THEN 1
      WHEN 'high' THEN 2
      WHEN 'medium' THEN 3
      WHEN 'low' THEN 4
      ELSE 5
    END,
    ut.due_date NULLS LAST,
    ut.created_at DESC;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_upcoming_events(p_user_id uuid, p_days integer DEFAULT 7)
 RETURNS TABLE(id uuid, title text, description text, event_type text, start_time timestamp with time zone, end_time timestamp with time zone, location text, attendees text[], entity_id text, entity_title text)
 LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    ev.id,
    ev.title,
    ev.description,
    ev.event_type,
    ev.start_time,
    ev.end_time,
    ev.location,
    ev.attendees,
    ev.entity_id,
    e.title as entity_title
  FROM events ev
  LEFT JOIN entities e ON ev.entity_id = e.id
  WHERE ev.user_id = p_user_id
    AND ev.start_time >= NOW()
    AND ev.start_time <= NOW() + (p_days || ' days')::interval
  ORDER BY ev.start_time ASC;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_user_preferences(p_user_id uuid)
 RETURNS public.user_preferences
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  prefs public.user_preferences;
BEGIN
  SELECT * INTO prefs
  FROM public.user_preferences
  WHERE user_id = p_user_id;
  
  -- If no preferences exist, create with defaults
  IF NOT FOUND THEN
    INSERT INTO public.user_preferences (
      user_id,
      user_mode,
      automation_level,
      global_confidence_threshold,
      show_lifecycle_details,
      confidence_thresholds,
      notification_preferences,
      has_completed_onboarding
    )
    VALUES (
      p_user_id,
      'casual',
      'balanced',
      70.00,
      false,
      '{
        "entity_creation": {"auto_apply": 90, "review": 70, "block": 50},
        "artifact_linking": {"auto_apply": 85, "review": 65, "block": 45},
        "task_creation": {"auto_apply": 88, "review": 68, "block": 48},
        "relationship_suggestion": {"auto_apply": 80, "review": 60, "block": 40},
        "security_classification": {"auto_apply": 95, "review": 75, "block": 60}
      }'::jsonb,
      '{
        "review_items": true,
        "daily_summary": false,
        "task_reminders": true,
        "event_reminders": true
      }'::jsonb,
      false
    )
    RETURNING * INTO prefs;
  END IF;
  
  RETURN prefs;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_user_profile(user_uuid uuid)
 RETURNS TABLE(id uuid, email text, name character varying, role character varying, created_at timestamp without time zone, updated_at timestamp without time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    up.id,
    au.email::TEXT,
    up.name,
    up.role,
    up.created_at,
    up.updated_at
  FROM user_profiles up
  JOIN auth.users au ON au.id = up.id
  WHERE up.id = user_uuid
    AND up.deleted_at IS NULL;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_workflow_progress_summary(p_user_id uuid)
 RETURNS TABLE(lifecycle_stage text, count bigint, oldest_artifact timestamp with time zone, newest_artifact timestamp with time zone)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    a.lifecycle_stage,
    COUNT(*) as count,
    MIN(a.created_at) as oldest_artifact,
    MAX(a.created_at) as newest_artifact
  FROM public.artifacts a
  WHERE a.user_id = p_user_id
    AND a.archived = FALSE
  GROUP BY a.lifecycle_stage
  ORDER BY 
    CASE a.lifecycle_stage
      WHEN 'uploaded' THEN 1
      WHEN 'processing' THEN 2
      WHEN 'extracted' THEN 3
      WHEN 'contextualized' THEN 4
      WHEN 'actionable' THEN 5
      WHEN 'refined' THEN 6
      WHEN 'processed' THEN 7
      WHEN 'blocked' THEN 8
      WHEN 'needs_review' THEN 9
      WHEN 'failed' THEN 10
      WHEN 'archived' THEN 11
      ELSE 12
    END;
END;
$function$
;

create or replace view "public"."gold_examples" as  SELECT id,
    example_type,
    source_workflow_run_id,
    source_task_id,
    input,
    output,
    ground_truth,
    context_needed,
    pattern_category,
    pattern_notes,
    difficulties,
    decision_rationale,
    tags,
    domain,
    quality_tier,
    is_validated,
    validated_by,
    validated_at,
    embedding,
    version,
    superseded_by,
    created_at,
    updated_at,
    created_by,
    notes
   FROM public.training_examples
  WHERE ((quality_tier = 'gold'::text) AND (is_validated = true));


CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  INSERT INTO public.user_profiles (id, name, role, created_at, updated_at)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', NEW.raw_user_meta_data->>'full_name', NULL),
    'member',
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;
  
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_user_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  UPDATE public.user_profiles
  SET
    name = COALESCE(NEW.raw_user_meta_data->>'name', NEW.raw_user_meta_data->>'full_name', user_profiles.name),
    updated_at = NOW()
  WHERE id = NEW.id;
  
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.inherit_user_team_from_source()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    BEGIN
      -- Get user_id_uuid and team_id from source artifact
      SELECT user_id_uuid, team_id 
      INTO NEW.user_id_uuid, NEW.team_id
      FROM artifacts 
      WHERE id = NEW.source_artifact_id;
      
      RETURN NEW;
    END;
    $function$
;

create or replace view "public"."memories" as  SELECT id,
    title,
    description,
    ((properties ->> 'memory_date'::text))::timestamp with time zone AS memory_date,
    (properties ->> 'location'::text) AS location,
    (properties ->> 'emotional_context'::text) AS emotional_context,
    (properties -> 'people_present'::text) AS people_present,
    tags,
    archived,
    archived_at,
    properties,
    user_id,
    team_id,
    created_at,
    updated_at
   FROM public.entities
  WHERE (entity_type = 'memory'::text);


create or replace view "public"."people" as  SELECT id,
    title AS name,
    description AS bio,
    (properties ->> 'role'::text) AS role,
    (properties ->> 'organization'::text) AS organization,
    (properties ->> 'email'::text) AS email,
    (properties ->> 'phone'::text) AS phone,
    (properties ->> 'relationship'::text) AS relationship,
    ((properties ->> 'last_contact'::text))::timestamp with time zone AS last_contact,
    tags,
    archived,
    archived_at,
    properties,
    user_id,
    team_id,
    created_at,
    updated_at
   FROM public.entities
  WHERE (entity_type = 'people'::text);


create or replace view "public"."projects" as  SELECT id,
    title,
    description,
    (properties ->> 'status'::text) AS status,
    ((properties ->> 'due_date'::text))::timestamp with time zone AS due_date,
    (properties ->> 'priority'::text) AS priority,
    ((properties ->> 'completion_percentage'::text))::integer AS completion_percentage,
    (properties -> 'milestones'::text) AS milestones,
    tags,
    archived,
    archived_at,
    properties,
    user_id,
    team_id,
    created_at,
    updated_at
   FROM public.entities
  WHERE (entity_type = 'project'::text);


CREATE OR REPLACE FUNCTION public.resolve_decision(p_decision_id uuid, p_user_id uuid, p_action text, p_resolution_notes text DEFAULT NULL::text, p_snooze_until timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS public.system_decisions
 LANGUAGE plpgsql
AS $function$
DECLARE
  updated_decision system_decisions;
BEGIN
  -- Validate action
  IF p_action NOT IN ('approve', 'reject', 'modify', 'snooze') THEN
    RAISE EXCEPTION 'Invalid action: %. Must be approve, reject, modify, or snooze.', p_action;
  END IF;
  
  -- Update decision based on action
  UPDATE system_decisions
  SET
    status = CASE
      WHEN p_action = 'approve' THEN 'approved'
      WHEN p_action = 'reject' THEN 'rejected'
      WHEN p_action = 'modify' THEN 'modified'
      WHEN p_action = 'snooze' THEN 'snoozed'
    END,
    resolved_at = CASE WHEN p_action != 'snooze' THEN NOW() ELSE resolved_at END,
    resolved_by = CASE WHEN p_action != 'snooze' THEN p_user_id ELSE resolved_by END,
    resolution_notes = COALESCE(p_resolution_notes, resolution_notes),
    snoozed_until = CASE WHEN p_action = 'snooze' THEN p_snooze_until ELSE NULL END,
    snooze_count = CASE WHEN p_action = 'snooze' THEN snooze_count + 1 ELSE snooze_count END,
    updated_at = NOW()
  WHERE id = p_decision_id
  RETURNING * INTO updated_decision;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Decision not found: %', p_decision_id;
  END IF;
  
  RETURN updated_decision;
END;
$function$
;

create or replace view "public"."resources" as  SELECT id,
    title,
    description,
    (properties ->> 'resource_type'::text) AS resource_type,
    (properties ->> 'url'::text) AS url,
    (properties ->> 'author'::text) AS author,
    (properties ->> 'date_published'::text) AS date_published,
    (properties ->> 'date_accessed'::text) AS date_accessed,
    tags,
    archived,
    archived_at,
    properties,
    user_id,
    team_id,
    created_at,
    updated_at
   FROM public.entities
  WHERE (entity_type = 'resource'::text);


CREATE OR REPLACE FUNCTION public.search_artifacts_by_tags(p_user_id uuid, p_tags text[], p_match_all boolean DEFAULT false)
 RETURNS SETOF public.artifacts
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  IF p_match_all THEN
    -- Match artifacts that have ALL specified tags
    RETURN QUERY
    SELECT * FROM public.artifacts
    WHERE user_id = p_user_id
      AND tags @> p_tags  -- Array contains operator
      AND archived = FALSE
    ORDER BY created_at DESC;
  ELSE
    -- Match artifacts that have ANY of the specified tags
    RETURN QUERY
    SELECT * FROM public.artifacts
    WHERE user_id = p_user_id
      AND tags && p_tags  -- Array overlap operator
      AND archived = FALSE
    ORDER BY created_at DESC;
  END IF;
END;
$function$
;

create or replace view "public"."secure" as  SELECT id,
    title,
    description,
    (properties ->> 'sensitivity_level'::text) AS sensitivity_level,
    ((properties ->> 'requires_2fa'::text))::boolean AS requires_2fa,
    ((properties ->> 'last_accessed'::text))::timestamp with time zone AS last_accessed,
    (properties -> 'access_log'::text) AS access_log,
    tags,
    archived,
    archived_at,
    properties,
    user_id,
    team_id,
    created_at,
    updated_at
   FROM public.entities
  WHERE (entity_type = 'secure'::text);


CREATE OR REPLACE FUNCTION public.should_auto_apply_decision(p_user_id uuid, p_decision_type text, p_confidence_score numeric)
 RETURNS TABLE(should_apply boolean, should_review boolean, should_block boolean, action text)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  prefs public.user_preferences;
  decision_family TEXT;
  family_thresholds JSONB;
  auto_apply_threshold NUMERIC;
  review_threshold NUMERIC;
  block_threshold NUMERIC;
BEGIN
  -- Get user preferences
  SELECT * INTO prefs FROM get_user_preferences(p_user_id);
  
  -- Map decision_type to decision_family
  decision_family := CASE
    WHEN p_decision_type LIKE '%entity%create%' THEN 'entity_creation'
    WHEN p_decision_type LIKE '%link%' THEN 'artifact_linking'
    WHEN p_decision_type LIKE '%task%create%' THEN 'task_creation'
    WHEN p_decision_type LIKE '%relationship%' THEN 'relationship_suggestion'
    WHEN p_decision_type LIKE '%security%' OR p_decision_type LIKE '%classif%' THEN 'security_classification'
    ELSE 'entity_creation' -- Default fallback
  END;
  
  -- Get thresholds for this decision family
  family_thresholds := prefs.confidence_thresholds->decision_family;
  
  -- Extract threshold values (with fallbacks to global threshold)
  auto_apply_threshold := COALESCE(
    (family_thresholds->>'auto_apply')::numeric,
    prefs.global_confidence_threshold + 20
  );
  
  review_threshold := COALESCE(
    (family_thresholds->>'review')::numeric,
    prefs.global_confidence_threshold
  );
  
  block_threshold := COALESCE(
    (family_thresholds->>'block')::numeric,
    prefs.global_confidence_threshold - 20
  );
  
  -- Determine action based on confidence score
  IF p_confidence_score >= auto_apply_threshold THEN
    -- High confidence: auto-apply silently
    RETURN QUERY SELECT true, false, false, 'auto_apply'::TEXT;
  ELSIF p_confidence_score >= review_threshold THEN
    -- Medium confidence: apply with review item
    RETURN QUERY SELECT true, true, false, 'apply_with_review'::TEXT;
  ELSIF p_confidence_score >= block_threshold THEN
    -- Low confidence: create review item, don't apply
    RETURN QUERY SELECT false, true, false, 'review_only'::TEXT;
  ELSE
    -- Very low confidence: block workflow
    RETURN QUERY SELECT false, false, true, 'block'::TEXT;
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.transition_lifecycle_state(p_artifact_id text, p_new_state text, p_skip_validation boolean DEFAULT false)
 RETURNS public.artifacts
 LANGUAGE plpgsql
AS $function$
DECLARE
  current_state TEXT;
  updated_artifact public.artifacts;
  valid_states TEXT[] := ARRAY[
    'uploaded', 'processing', 'extracted', 'contextualized', 
    'actionable', 'refined', 'processed', 'archived',
    'blocked', 'needs_review', 'failed'
  ];
BEGIN
  -- Validate new state
  IF NOT (p_new_state = ANY(valid_states)) THEN
    RAISE EXCEPTION 'Invalid lifecycle state: %. Valid states: %', 
      p_new_state, array_to_string(valid_states, ', ');
  END IF;
  
  -- Get current state
  SELECT lifecycle_stage INTO current_state
  FROM public.artifacts
  WHERE id = p_artifact_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Artifact not found: %', p_artifact_id;
  END IF;
  
  -- Optional: Add validation logic here if needed
  -- For now, allow any transition (permissive approach)
  
  -- Update state
  UPDATE public.artifacts
  SET lifecycle_stage = p_new_state,
      updated_at = NOW()
  WHERE id = p_artifact_id
  RETURNING * INTO updated_artifact;
  
  RETURN updated_artifact;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_artifact_title(p_artifact_id text, p_title text)
 RETURNS public.artifacts
 LANGUAGE plpgsql
AS $function$
DECLARE
  updated_artifact public.artifacts;
BEGIN
  UPDATE public.artifacts
  SET title = p_title,
      updated_at = NOW()
  WHERE id = p_artifact_id
  RETURNING * INTO updated_artifact;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Artifact not found: %', p_artifact_id;
  END IF;
  
  RETURN updated_artifact;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_automation_level(p_user_id uuid, p_automation_level text)
 RETURNS public.user_preferences
 LANGUAGE plpgsql
AS $function$
DECLARE
  updated_prefs public.user_preferences;
  new_threshold NUMERIC(5,2);
BEGIN
  -- Validate automation level
  IF p_automation_level NOT IN ('manual', 'balanced', 'aggressive') THEN
    RAISE EXCEPTION 'Invalid automation level: %. Must be manual, balanced, or aggressive.', p_automation_level;
  END IF;
  
  -- Map automation level to global threshold
  new_threshold := CASE p_automation_level
    WHEN 'manual' THEN 90.00      -- High bar for auto-apply
    WHEN 'balanced' THEN 70.00    -- Moderate threshold
    WHEN 'aggressive' THEN 50.00  -- Low bar, more automation
  END;
  
  -- Update or insert preferences
  INSERT INTO public.user_preferences (
    user_id,
    automation_level,
    global_confidence_threshold,
    updated_at
  )
  VALUES (
    p_user_id,
    p_automation_level,
    new_threshold,
    NOW()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET 
    automation_level = p_automation_level,
    global_confidence_threshold = new_threshold,
    updated_at = NOW()
  RETURNING * INTO updated_prefs;
  
  RETURN updated_prefs;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_confidence_threshold(p_user_id uuid, p_decision_family text, p_auto_apply numeric DEFAULT NULL::numeric, p_review numeric DEFAULT NULL::numeric, p_block numeric DEFAULT NULL::numeric)
 RETURNS public.user_preferences
 LANGUAGE plpgsql
AS $function$
DECLARE
  updated_prefs public.user_preferences;
  current_thresholds JSONB;
  family_thresholds JSONB;
BEGIN
  -- Get current thresholds
  SELECT confidence_thresholds INTO current_thresholds
  FROM public.user_preferences
  WHERE user_id = p_user_id;
  
  -- If no preferences exist, create with defaults first
  IF NOT FOUND THEN
    PERFORM get_user_preferences(p_user_id);
    SELECT confidence_thresholds INTO current_thresholds
    FROM public.user_preferences
    WHERE user_id = p_user_id;
  END IF;
  
  -- Get existing family thresholds or create new
  family_thresholds := COALESCE(
    current_thresholds->p_decision_family,
    '{"auto_apply": 80, "review": 60, "block": 40}'::jsonb
  );
  
  -- Update provided values
  IF p_auto_apply IS NOT NULL THEN
    family_thresholds := jsonb_set(family_thresholds, '{auto_apply}', to_jsonb(p_auto_apply));
  END IF;
  
  IF p_review IS NOT NULL THEN
    family_thresholds := jsonb_set(family_thresholds, '{review}', to_jsonb(p_review));
  END IF;
  
  IF p_block IS NOT NULL THEN
    family_thresholds := jsonb_set(family_thresholds, '{block}', to_jsonb(p_block));
  END IF;
  
  -- Update the decision family in the main thresholds object
  current_thresholds := jsonb_set(
    current_thresholds,
    ARRAY[p_decision_family],
    family_thresholds
  );
  
  -- Save updated thresholds
  UPDATE public.user_preferences
  SET 
    confidence_thresholds = current_thresholds,
    updated_at = NOW()
  WHERE user_id = p_user_id
  RETURNING * INTO updated_prefs;
  
  RETURN updated_prefs;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_derived_artifacts_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_entities_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_events_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_notification_preference(p_user_id uuid, p_preference_key text, p_enabled boolean)
 RETURNS public.user_preferences
 LANGUAGE plpgsql
AS $function$
DECLARE
  updated_prefs public.user_preferences;
  current_notifs JSONB;
BEGIN
  -- Get current notification preferences
  SELECT notification_preferences INTO current_notifs
  FROM public.user_preferences
  WHERE user_id = p_user_id;
  
  -- If no preferences exist, create with defaults first
  IF NOT FOUND THEN
    PERFORM get_user_preferences(p_user_id);
    SELECT notification_preferences INTO current_notifs
    FROM public.user_preferences
    WHERE user_id = p_user_id;
  END IF;
  
  -- Update the specific preference
  current_notifs := jsonb_set(
    current_notifs,
    ARRAY[p_preference_key],
    to_jsonb(p_enabled)
  );
  
  -- Save updated preferences
  UPDATE public.user_preferences
  SET 
    notification_preferences = current_notifs,
    updated_at = NOW()
  WHERE user_id = p_user_id
  RETURNING * INTO updated_prefs;
  
  RETURN updated_prefs;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_source_artifact_derived_flag()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Update source artifact when derived artifact is created
  IF TG_OP = 'INSERT' THEN
    UPDATE artifacts 
    SET has_derived_artifacts = TRUE,
        derived_artifacts_location = NEW.storage_bucket
    WHERE id = NEW.source_artifact_id;
    RETURN NEW;
  END IF;
  
  -- Update source artifact when derived artifact is deleted
  IF TG_OP = 'DELETE' THEN
    -- Check if any derived artifacts still exist
    IF NOT EXISTS (
      SELECT 1 FROM derived_artifacts 
      WHERE source_artifact_id = OLD.source_artifact_id
    ) THEN
      UPDATE artifacts 
      SET has_derived_artifacts = FALSE,
          derived_artifacts_location = NULL
      WHERE id = OLD.source_artifact_id;
    END IF;
    RETURN OLD;
  END IF;
  
  RETURN NULL;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_user_mode(p_user_id uuid, p_user_mode text)
 RETURNS public.user_preferences
 LANGUAGE plpgsql
AS $function$
DECLARE
  updated_prefs public.user_preferences;
BEGIN
  -- Validate user mode
  IF p_user_mode NOT IN ('casual', 'power') THEN
    RAISE EXCEPTION 'Invalid user mode: %. Must be casual or power.', p_user_mode;
  END IF;
  
  -- Update or insert preferences
  INSERT INTO public.user_preferences (
    user_id,
    user_mode,
    show_lifecycle_details,
    updated_at
  )
  VALUES (
    p_user_id,
    p_user_mode,
    p_user_mode = 'power', -- Auto-enable lifecycle details for power users
    NOW()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET 
    user_mode = p_user_mode,
    show_lifecycle_details = CASE 
      WHEN p_user_mode = 'power' THEN true
      ELSE user_preferences.show_lifecycle_details
    END,
    updated_at = NOW()
  RETURNING * INTO updated_prefs;
  
  RETURN updated_prefs;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_user_tasks_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  
  -- Auto-set completed_at when status changes to 'done'
  IF NEW.status = 'done' AND OLD.status != 'done' THEN
    NEW.completed_at = NOW();
  END IF;
  
  -- Clear completed_at if status changes from 'done' to something else
  IF NEW.status != 'done' AND OLD.status = 'done' THEN
    NEW.completed_at = NULL;
  END IF;
  
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_waitlist_entries_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$
;

grant delete on table "public"."activity_logs" to "anon";

grant insert on table "public"."activity_logs" to "anon";

grant references on table "public"."activity_logs" to "anon";

grant select on table "public"."activity_logs" to "anon";

grant trigger on table "public"."activity_logs" to "anon";

grant truncate on table "public"."activity_logs" to "anon";

grant update on table "public"."activity_logs" to "anon";

grant delete on table "public"."activity_logs" to "authenticated";

grant insert on table "public"."activity_logs" to "authenticated";

grant references on table "public"."activity_logs" to "authenticated";

grant select on table "public"."activity_logs" to "authenticated";

grant trigger on table "public"."activity_logs" to "authenticated";

grant truncate on table "public"."activity_logs" to "authenticated";

grant update on table "public"."activity_logs" to "authenticated";

grant delete on table "public"."activity_logs" to "service_role";

grant insert on table "public"."activity_logs" to "service_role";

grant references on table "public"."activity_logs" to "service_role";

grant select on table "public"."activity_logs" to "service_role";

grant trigger on table "public"."activity_logs" to "service_role";

grant truncate on table "public"."activity_logs" to "service_role";

grant update on table "public"."activity_logs" to "service_role";

grant delete on table "public"."artifact_entity_links" to "anon";

grant insert on table "public"."artifact_entity_links" to "anon";

grant references on table "public"."artifact_entity_links" to "anon";

grant select on table "public"."artifact_entity_links" to "anon";

grant trigger on table "public"."artifact_entity_links" to "anon";

grant truncate on table "public"."artifact_entity_links" to "anon";

grant update on table "public"."artifact_entity_links" to "anon";

grant delete on table "public"."artifact_entity_links" to "authenticated";

grant insert on table "public"."artifact_entity_links" to "authenticated";

grant references on table "public"."artifact_entity_links" to "authenticated";

grant select on table "public"."artifact_entity_links" to "authenticated";

grant trigger on table "public"."artifact_entity_links" to "authenticated";

grant truncate on table "public"."artifact_entity_links" to "authenticated";

grant update on table "public"."artifact_entity_links" to "authenticated";

grant delete on table "public"."artifact_entity_links" to "service_role";

grant insert on table "public"."artifact_entity_links" to "service_role";

grant references on table "public"."artifact_entity_links" to "service_role";

grant select on table "public"."artifact_entity_links" to "service_role";

grant trigger on table "public"."artifact_entity_links" to "service_role";

grant truncate on table "public"."artifact_entity_links" to "service_role";

grant update on table "public"."artifact_entity_links" to "service_role";

grant delete on table "public"."artifacts" to "anon";

grant insert on table "public"."artifacts" to "anon";

grant references on table "public"."artifacts" to "anon";

grant select on table "public"."artifacts" to "anon";

grant trigger on table "public"."artifacts" to "anon";

grant truncate on table "public"."artifacts" to "anon";

grant update on table "public"."artifacts" to "anon";

grant delete on table "public"."artifacts" to "authenticated";

grant insert on table "public"."artifacts" to "authenticated";

grant references on table "public"."artifacts" to "authenticated";

grant select on table "public"."artifacts" to "authenticated";

grant trigger on table "public"."artifacts" to "authenticated";

grant truncate on table "public"."artifacts" to "authenticated";

grant update on table "public"."artifacts" to "authenticated";

grant delete on table "public"."artifacts" to "service_role";

grant insert on table "public"."artifacts" to "service_role";

grant references on table "public"."artifacts" to "service_role";

grant select on table "public"."artifacts" to "service_role";

grant trigger on table "public"."artifacts" to "service_role";

grant truncate on table "public"."artifacts" to "service_role";

grant update on table "public"."artifacts" to "service_role";

grant delete on table "public"."derived_artifacts" to "anon";

grant insert on table "public"."derived_artifacts" to "anon";

grant references on table "public"."derived_artifacts" to "anon";

grant select on table "public"."derived_artifacts" to "anon";

grant trigger on table "public"."derived_artifacts" to "anon";

grant truncate on table "public"."derived_artifacts" to "anon";

grant update on table "public"."derived_artifacts" to "anon";

grant delete on table "public"."derived_artifacts" to "authenticated";

grant insert on table "public"."derived_artifacts" to "authenticated";

grant references on table "public"."derived_artifacts" to "authenticated";

grant select on table "public"."derived_artifacts" to "authenticated";

grant trigger on table "public"."derived_artifacts" to "authenticated";

grant truncate on table "public"."derived_artifacts" to "authenticated";

grant update on table "public"."derived_artifacts" to "authenticated";

grant delete on table "public"."derived_artifacts" to "service_role";

grant insert on table "public"."derived_artifacts" to "service_role";

grant references on table "public"."derived_artifacts" to "service_role";

grant select on table "public"."derived_artifacts" to "service_role";

grant trigger on table "public"."derived_artifacts" to "service_role";

grant truncate on table "public"."derived_artifacts" to "service_role";

grant update on table "public"."derived_artifacts" to "service_role";

grant delete on table "public"."discovered_patterns" to "anon";

grant insert on table "public"."discovered_patterns" to "anon";

grant references on table "public"."discovered_patterns" to "anon";

grant select on table "public"."discovered_patterns" to "anon";

grant trigger on table "public"."discovered_patterns" to "anon";

grant truncate on table "public"."discovered_patterns" to "anon";

grant update on table "public"."discovered_patterns" to "anon";

grant delete on table "public"."discovered_patterns" to "authenticated";

grant insert on table "public"."discovered_patterns" to "authenticated";

grant references on table "public"."discovered_patterns" to "authenticated";

grant select on table "public"."discovered_patterns" to "authenticated";

grant trigger on table "public"."discovered_patterns" to "authenticated";

grant truncate on table "public"."discovered_patterns" to "authenticated";

grant update on table "public"."discovered_patterns" to "authenticated";

grant delete on table "public"."discovered_patterns" to "service_role";

grant insert on table "public"."discovered_patterns" to "service_role";

grant references on table "public"."discovered_patterns" to "service_role";

grant select on table "public"."discovered_patterns" to "service_role";

grant trigger on table "public"."discovered_patterns" to "service_role";

grant truncate on table "public"."discovered_patterns" to "service_role";

grant update on table "public"."discovered_patterns" to "service_role";

grant delete on table "public"."entities" to "anon";

grant insert on table "public"."entities" to "anon";

grant references on table "public"."entities" to "anon";

grant select on table "public"."entities" to "anon";

grant trigger on table "public"."entities" to "anon";

grant truncate on table "public"."entities" to "anon";

grant update on table "public"."entities" to "anon";

grant delete on table "public"."entities" to "authenticated";

grant insert on table "public"."entities" to "authenticated";

grant references on table "public"."entities" to "authenticated";

grant select on table "public"."entities" to "authenticated";

grant trigger on table "public"."entities" to "authenticated";

grant truncate on table "public"."entities" to "authenticated";

grant update on table "public"."entities" to "authenticated";

grant delete on table "public"."entities" to "service_role";

grant insert on table "public"."entities" to "service_role";

grant references on table "public"."entities" to "service_role";

grant select on table "public"."entities" to "service_role";

grant trigger on table "public"."entities" to "service_role";

grant truncate on table "public"."entities" to "service_role";

grant update on table "public"."entities" to "service_role";

grant delete on table "public"."entity_relationships" to "anon";

grant insert on table "public"."entity_relationships" to "anon";

grant references on table "public"."entity_relationships" to "anon";

grant select on table "public"."entity_relationships" to "anon";

grant trigger on table "public"."entity_relationships" to "anon";

grant truncate on table "public"."entity_relationships" to "anon";

grant update on table "public"."entity_relationships" to "anon";

grant delete on table "public"."entity_relationships" to "authenticated";

grant insert on table "public"."entity_relationships" to "authenticated";

grant references on table "public"."entity_relationships" to "authenticated";

grant select on table "public"."entity_relationships" to "authenticated";

grant trigger on table "public"."entity_relationships" to "authenticated";

grant truncate on table "public"."entity_relationships" to "authenticated";

grant update on table "public"."entity_relationships" to "authenticated";

grant delete on table "public"."entity_relationships" to "service_role";

grant insert on table "public"."entity_relationships" to "service_role";

grant references on table "public"."entity_relationships" to "service_role";

grant select on table "public"."entity_relationships" to "service_role";

grant trigger on table "public"."entity_relationships" to "service_role";

grant truncate on table "public"."entity_relationships" to "service_role";

grant update on table "public"."entity_relationships" to "service_role";

grant delete on table "public"."events" to "anon";

grant insert on table "public"."events" to "anon";

grant references on table "public"."events" to "anon";

grant select on table "public"."events" to "anon";

grant trigger on table "public"."events" to "anon";

grant truncate on table "public"."events" to "anon";

grant update on table "public"."events" to "anon";

grant delete on table "public"."events" to "authenticated";

grant insert on table "public"."events" to "authenticated";

grant references on table "public"."events" to "authenticated";

grant select on table "public"."events" to "authenticated";

grant trigger on table "public"."events" to "authenticated";

grant truncate on table "public"."events" to "authenticated";

grant update on table "public"."events" to "authenticated";

grant delete on table "public"."events" to "service_role";

grant insert on table "public"."events" to "service_role";

grant references on table "public"."events" to "service_role";

grant select on table "public"."events" to "service_role";

grant trigger on table "public"."events" to "service_role";

grant truncate on table "public"."events" to "service_role";

grant update on table "public"."events" to "service_role";

grant delete on table "public"."invitations" to "anon";

grant insert on table "public"."invitations" to "anon";

grant references on table "public"."invitations" to "anon";

grant select on table "public"."invitations" to "anon";

grant trigger on table "public"."invitations" to "anon";

grant truncate on table "public"."invitations" to "anon";

grant update on table "public"."invitations" to "anon";

grant delete on table "public"."invitations" to "authenticated";

grant insert on table "public"."invitations" to "authenticated";

grant references on table "public"."invitations" to "authenticated";

grant select on table "public"."invitations" to "authenticated";

grant trigger on table "public"."invitations" to "authenticated";

grant truncate on table "public"."invitations" to "authenticated";

grant update on table "public"."invitations" to "authenticated";

grant delete on table "public"."invitations" to "service_role";

grant insert on table "public"."invitations" to "service_role";

grant references on table "public"."invitations" to "service_role";

grant select on table "public"."invitations" to "service_role";

grant trigger on table "public"."invitations" to "service_role";

grant truncate on table "public"."invitations" to "service_role";

grant update on table "public"."invitations" to "service_role";

grant delete on table "public"."subscriptions" to "anon";

grant insert on table "public"."subscriptions" to "anon";

grant references on table "public"."subscriptions" to "anon";

grant select on table "public"."subscriptions" to "anon";

grant trigger on table "public"."subscriptions" to "anon";

grant truncate on table "public"."subscriptions" to "anon";

grant update on table "public"."subscriptions" to "anon";

grant delete on table "public"."subscriptions" to "authenticated";

grant insert on table "public"."subscriptions" to "authenticated";

grant references on table "public"."subscriptions" to "authenticated";

grant select on table "public"."subscriptions" to "authenticated";

grant trigger on table "public"."subscriptions" to "authenticated";

grant truncate on table "public"."subscriptions" to "authenticated";

grant update on table "public"."subscriptions" to "authenticated";

grant delete on table "public"."subscriptions" to "service_role";

grant insert on table "public"."subscriptions" to "service_role";

grant references on table "public"."subscriptions" to "service_role";

grant select on table "public"."subscriptions" to "service_role";

grant trigger on table "public"."subscriptions" to "service_role";

grant truncate on table "public"."subscriptions" to "service_role";

grant update on table "public"."subscriptions" to "service_role";

grant delete on table "public"."system_decisions" to "anon";

grant insert on table "public"."system_decisions" to "anon";

grant references on table "public"."system_decisions" to "anon";

grant select on table "public"."system_decisions" to "anon";

grant trigger on table "public"."system_decisions" to "anon";

grant truncate on table "public"."system_decisions" to "anon";

grant update on table "public"."system_decisions" to "anon";

grant delete on table "public"."system_decisions" to "authenticated";

grant insert on table "public"."system_decisions" to "authenticated";

grant references on table "public"."system_decisions" to "authenticated";

grant select on table "public"."system_decisions" to "authenticated";

grant trigger on table "public"."system_decisions" to "authenticated";

grant truncate on table "public"."system_decisions" to "authenticated";

grant update on table "public"."system_decisions" to "authenticated";

grant delete on table "public"."system_decisions" to "service_role";

grant insert on table "public"."system_decisions" to "service_role";

grant references on table "public"."system_decisions" to "service_role";

grant select on table "public"."system_decisions" to "service_role";

grant trigger on table "public"."system_decisions" to "service_role";

grant truncate on table "public"."system_decisions" to "service_role";

grant update on table "public"."system_decisions" to "service_role";

grant delete on table "public"."tasks" to "anon";

grant insert on table "public"."tasks" to "anon";

grant references on table "public"."tasks" to "anon";

grant select on table "public"."tasks" to "anon";

grant trigger on table "public"."tasks" to "anon";

grant truncate on table "public"."tasks" to "anon";

grant update on table "public"."tasks" to "anon";

grant delete on table "public"."tasks" to "authenticated";

grant insert on table "public"."tasks" to "authenticated";

grant references on table "public"."tasks" to "authenticated";

grant select on table "public"."tasks" to "authenticated";

grant trigger on table "public"."tasks" to "authenticated";

grant truncate on table "public"."tasks" to "authenticated";

grant update on table "public"."tasks" to "authenticated";

grant delete on table "public"."tasks" to "service_role";

grant insert on table "public"."tasks" to "service_role";

grant references on table "public"."tasks" to "service_role";

grant select on table "public"."tasks" to "service_role";

grant trigger on table "public"."tasks" to "service_role";

grant truncate on table "public"."tasks" to "service_role";

grant update on table "public"."tasks" to "service_role";

grant delete on table "public"."team_members" to "anon";

grant insert on table "public"."team_members" to "anon";

grant references on table "public"."team_members" to "anon";

grant select on table "public"."team_members" to "anon";

grant trigger on table "public"."team_members" to "anon";

grant truncate on table "public"."team_members" to "anon";

grant update on table "public"."team_members" to "anon";

grant delete on table "public"."team_members" to "authenticated";

grant insert on table "public"."team_members" to "authenticated";

grant references on table "public"."team_members" to "authenticated";

grant select on table "public"."team_members" to "authenticated";

grant trigger on table "public"."team_members" to "authenticated";

grant truncate on table "public"."team_members" to "authenticated";

grant update on table "public"."team_members" to "authenticated";

grant delete on table "public"."team_members" to "service_role";

grant insert on table "public"."team_members" to "service_role";

grant references on table "public"."team_members" to "service_role";

grant select on table "public"."team_members" to "service_role";

grant trigger on table "public"."team_members" to "service_role";

grant truncate on table "public"."team_members" to "service_role";

grant update on table "public"."team_members" to "service_role";

grant delete on table "public"."teams" to "anon";

grant insert on table "public"."teams" to "anon";

grant references on table "public"."teams" to "anon";

grant select on table "public"."teams" to "anon";

grant trigger on table "public"."teams" to "anon";

grant truncate on table "public"."teams" to "anon";

grant update on table "public"."teams" to "anon";

grant delete on table "public"."teams" to "authenticated";

grant insert on table "public"."teams" to "authenticated";

grant references on table "public"."teams" to "authenticated";

grant select on table "public"."teams" to "authenticated";

grant trigger on table "public"."teams" to "authenticated";

grant truncate on table "public"."teams" to "authenticated";

grant update on table "public"."teams" to "authenticated";

grant delete on table "public"."teams" to "service_role";

grant insert on table "public"."teams" to "service_role";

grant references on table "public"."teams" to "service_role";

grant select on table "public"."teams" to "service_role";

grant trigger on table "public"."teams" to "service_role";

grant truncate on table "public"."teams" to "service_role";

grant update on table "public"."teams" to "service_role";

grant delete on table "public"."training_examples" to "anon";

grant insert on table "public"."training_examples" to "anon";

grant references on table "public"."training_examples" to "anon";

grant select on table "public"."training_examples" to "anon";

grant trigger on table "public"."training_examples" to "anon";

grant truncate on table "public"."training_examples" to "anon";

grant update on table "public"."training_examples" to "anon";

grant delete on table "public"."training_examples" to "authenticated";

grant insert on table "public"."training_examples" to "authenticated";

grant references on table "public"."training_examples" to "authenticated";

grant select on table "public"."training_examples" to "authenticated";

grant trigger on table "public"."training_examples" to "authenticated";

grant truncate on table "public"."training_examples" to "authenticated";

grant update on table "public"."training_examples" to "authenticated";

grant delete on table "public"."training_examples" to "service_role";

grant insert on table "public"."training_examples" to "service_role";

grant references on table "public"."training_examples" to "service_role";

grant select on table "public"."training_examples" to "service_role";

grant trigger on table "public"."training_examples" to "service_role";

grant truncate on table "public"."training_examples" to "service_role";

grant update on table "public"."training_examples" to "service_role";

grant delete on table "public"."user_preferences" to "anon";

grant insert on table "public"."user_preferences" to "anon";

grant references on table "public"."user_preferences" to "anon";

grant select on table "public"."user_preferences" to "anon";

grant trigger on table "public"."user_preferences" to "anon";

grant truncate on table "public"."user_preferences" to "anon";

grant update on table "public"."user_preferences" to "anon";

grant delete on table "public"."user_preferences" to "authenticated";

grant insert on table "public"."user_preferences" to "authenticated";

grant references on table "public"."user_preferences" to "authenticated";

grant select on table "public"."user_preferences" to "authenticated";

grant trigger on table "public"."user_preferences" to "authenticated";

grant truncate on table "public"."user_preferences" to "authenticated";

grant update on table "public"."user_preferences" to "authenticated";

grant delete on table "public"."user_preferences" to "service_role";

grant insert on table "public"."user_preferences" to "service_role";

grant references on table "public"."user_preferences" to "service_role";

grant select on table "public"."user_preferences" to "service_role";

grant trigger on table "public"."user_preferences" to "service_role";

grant truncate on table "public"."user_preferences" to "service_role";

grant update on table "public"."user_preferences" to "service_role";

grant delete on table "public"."user_profiles" to "anon";

grant insert on table "public"."user_profiles" to "anon";

grant references on table "public"."user_profiles" to "anon";

grant select on table "public"."user_profiles" to "anon";

grant trigger on table "public"."user_profiles" to "anon";

grant truncate on table "public"."user_profiles" to "anon";

grant update on table "public"."user_profiles" to "anon";

grant delete on table "public"."user_profiles" to "authenticated";

grant insert on table "public"."user_profiles" to "authenticated";

grant references on table "public"."user_profiles" to "authenticated";

grant select on table "public"."user_profiles" to "authenticated";

grant trigger on table "public"."user_profiles" to "authenticated";

grant truncate on table "public"."user_profiles" to "authenticated";

grant update on table "public"."user_profiles" to "authenticated";

grant delete on table "public"."user_profiles" to "service_role";

grant insert on table "public"."user_profiles" to "service_role";

grant references on table "public"."user_profiles" to "service_role";

grant select on table "public"."user_profiles" to "service_role";

grant trigger on table "public"."user_profiles" to "service_role";

grant truncate on table "public"."user_profiles" to "service_role";

grant update on table "public"."user_profiles" to "service_role";

grant delete on table "public"."user_tasks" to "anon";

grant insert on table "public"."user_tasks" to "anon";

grant references on table "public"."user_tasks" to "anon";

grant select on table "public"."user_tasks" to "anon";

grant trigger on table "public"."user_tasks" to "anon";

grant truncate on table "public"."user_tasks" to "anon";

grant update on table "public"."user_tasks" to "anon";

grant delete on table "public"."user_tasks" to "authenticated";

grant insert on table "public"."user_tasks" to "authenticated";

grant references on table "public"."user_tasks" to "authenticated";

grant select on table "public"."user_tasks" to "authenticated";

grant trigger on table "public"."user_tasks" to "authenticated";

grant truncate on table "public"."user_tasks" to "authenticated";

grant update on table "public"."user_tasks" to "authenticated";

grant delete on table "public"."user_tasks" to "service_role";

grant insert on table "public"."user_tasks" to "service_role";

grant references on table "public"."user_tasks" to "service_role";

grant select on table "public"."user_tasks" to "service_role";

grant trigger on table "public"."user_tasks" to "service_role";

grant truncate on table "public"."user_tasks" to "service_role";

grant update on table "public"."user_tasks" to "service_role";

grant delete on table "public"."user_trials" to "anon";

grant insert on table "public"."user_trials" to "anon";

grant references on table "public"."user_trials" to "anon";

grant select on table "public"."user_trials" to "anon";

grant trigger on table "public"."user_trials" to "anon";

grant truncate on table "public"."user_trials" to "anon";

grant update on table "public"."user_trials" to "anon";

grant delete on table "public"."user_trials" to "authenticated";

grant insert on table "public"."user_trials" to "authenticated";

grant references on table "public"."user_trials" to "authenticated";

grant select on table "public"."user_trials" to "authenticated";

grant trigger on table "public"."user_trials" to "authenticated";

grant truncate on table "public"."user_trials" to "authenticated";

grant update on table "public"."user_trials" to "authenticated";

grant delete on table "public"."user_trials" to "service_role";

grant insert on table "public"."user_trials" to "service_role";

grant references on table "public"."user_trials" to "service_role";

grant select on table "public"."user_trials" to "service_role";

grant trigger on table "public"."user_trials" to "service_role";

grant truncate on table "public"."user_trials" to "service_role";

grant update on table "public"."user_trials" to "service_role";

grant delete on table "public"."users" to "anon";

grant insert on table "public"."users" to "anon";

grant references on table "public"."users" to "anon";

grant select on table "public"."users" to "anon";

grant trigger on table "public"."users" to "anon";

grant truncate on table "public"."users" to "anon";

grant update on table "public"."users" to "anon";

grant delete on table "public"."users" to "authenticated";

grant insert on table "public"."users" to "authenticated";

grant references on table "public"."users" to "authenticated";

grant select on table "public"."users" to "authenticated";

grant trigger on table "public"."users" to "authenticated";

grant truncate on table "public"."users" to "authenticated";

grant update on table "public"."users" to "authenticated";

grant delete on table "public"."users" to "service_role";

grant insert on table "public"."users" to "service_role";

grant references on table "public"."users" to "service_role";

grant select on table "public"."users" to "service_role";

grant trigger on table "public"."users" to "service_role";

grant truncate on table "public"."users" to "service_role";

grant update on table "public"."users" to "service_role";

grant delete on table "public"."waitlist_entries" to "anon";

grant insert on table "public"."waitlist_entries" to "anon";

grant references on table "public"."waitlist_entries" to "anon";

grant select on table "public"."waitlist_entries" to "anon";

grant trigger on table "public"."waitlist_entries" to "anon";

grant truncate on table "public"."waitlist_entries" to "anon";

grant update on table "public"."waitlist_entries" to "anon";

grant delete on table "public"."waitlist_entries" to "authenticated";

grant insert on table "public"."waitlist_entries" to "authenticated";

grant references on table "public"."waitlist_entries" to "authenticated";

grant select on table "public"."waitlist_entries" to "authenticated";

grant trigger on table "public"."waitlist_entries" to "authenticated";

grant truncate on table "public"."waitlist_entries" to "authenticated";

grant update on table "public"."waitlist_entries" to "authenticated";

grant delete on table "public"."waitlist_entries" to "service_role";

grant insert on table "public"."waitlist_entries" to "service_role";

grant references on table "public"."waitlist_entries" to "service_role";

grant select on table "public"."waitlist_entries" to "service_role";

grant trigger on table "public"."waitlist_entries" to "service_role";

grant truncate on table "public"."waitlist_entries" to "service_role";

grant update on table "public"."waitlist_entries" to "service_role";

grant delete on table "public"."workflow_runs" to "anon";

grant insert on table "public"."workflow_runs" to "anon";

grant references on table "public"."workflow_runs" to "anon";

grant select on table "public"."workflow_runs" to "anon";

grant trigger on table "public"."workflow_runs" to "anon";

grant truncate on table "public"."workflow_runs" to "anon";

grant update on table "public"."workflow_runs" to "anon";

grant delete on table "public"."workflow_runs" to "authenticated";

grant insert on table "public"."workflow_runs" to "authenticated";

grant references on table "public"."workflow_runs" to "authenticated";

grant select on table "public"."workflow_runs" to "authenticated";

grant trigger on table "public"."workflow_runs" to "authenticated";

grant truncate on table "public"."workflow_runs" to "authenticated";

grant update on table "public"."workflow_runs" to "authenticated";

grant delete on table "public"."workflow_runs" to "service_role";

grant insert on table "public"."workflow_runs" to "service_role";

grant references on table "public"."workflow_runs" to "service_role";

grant select on table "public"."workflow_runs" to "service_role";

grant trigger on table "public"."workflow_runs" to "service_role";

grant truncate on table "public"."workflow_runs" to "service_role";

grant update on table "public"."workflow_runs" to "service_role";


  create policy "Users can view their own activity logs"
  on "public"."activity_logs"
  as permissive
  for select
  to public
using (((auth.uid() = user_id) OR (user_id IS NULL)));



  create policy "Users can delete own artifact_entity_links"
  on "public"."artifact_entity_links"
  as permissive
  for delete
  to public
using ((EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = artifact_entity_links.entity_id) AND (e.user_id = auth.uid())))));



  create policy "Users can insert own artifact_entity_links"
  on "public"."artifact_entity_links"
  as permissive
  for insert
  to public
with check (((EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = artifact_entity_links.entity_id) AND (e.user_id = auth.uid())))) AND (EXISTS ( SELECT 1
   FROM public.artifacts a
  WHERE ((a.id = artifact_entity_links.artifact_id) AND (a.user_id = auth.uid()))))));



  create policy "Users can update own artifact_entity_links"
  on "public"."artifact_entity_links"
  as permissive
  for update
  to public
using ((EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = artifact_entity_links.entity_id) AND (e.user_id = auth.uid())))))
with check ((EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = artifact_entity_links.entity_id) AND (e.user_id = auth.uid())))));



  create policy "Users can view own artifact_entity_links"
  on "public"."artifact_entity_links"
  as permissive
  for select
  to public
using (((EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = artifact_entity_links.entity_id) AND (e.user_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM public.artifacts a
  WHERE ((a.id = artifact_entity_links.artifact_id) AND (a.user_id = auth.uid()))))));



  create policy "Users can create their own artifacts"
  on "public"."artifacts"
  as permissive
  for insert
  to authenticated
with check ((user_id = auth.uid()));



  create policy "Users can delete their own artifacts"
  on "public"."artifacts"
  as permissive
  for delete
  to authenticated
using ((user_id = auth.uid()));



  create policy "Users can update their own artifacts"
  on "public"."artifacts"
  as permissive
  for update
  to authenticated
using ((user_id = auth.uid()))
with check ((user_id = auth.uid()));



  create policy "Users can view their own artifacts"
  on "public"."artifacts"
  as permissive
  for select
  to authenticated
using ((user_id = auth.uid()));



  create policy "Users can view their own derived artifacts"
  on "public"."derived_artifacts"
  as permissive
  for select
  to authenticated
using (((user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.artifacts a
  WHERE ((a.id = derived_artifacts.source_artifact_id) AND (a.user_id = auth.uid()))))));



  create policy "Users can delete own entities"
  on "public"."entities"
  as permissive
  for delete
  to public
using ((auth.uid() = user_id));



  create policy "Users can insert own entities"
  on "public"."entities"
  as permissive
  for insert
  to public
with check ((auth.uid() = user_id));



  create policy "Users can update own entities"
  on "public"."entities"
  as permissive
  for update
  to public
using ((auth.uid() = user_id))
with check ((auth.uid() = user_id));



  create policy "Users can view own entities"
  on "public"."entities"
  as permissive
  for select
  to public
using ((auth.uid() = user_id));



  create policy "Users can delete own entity_relationships"
  on "public"."entity_relationships"
  as permissive
  for delete
  to public
using ((EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = entity_relationships.from_entity_id) AND (e.user_id = auth.uid())))));



  create policy "Users can insert own entity_relationships"
  on "public"."entity_relationships"
  as permissive
  for insert
  to public
with check (((EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = entity_relationships.from_entity_id) AND (e.user_id = auth.uid())))) AND (EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = entity_relationships.to_entity_id) AND (e.user_id = auth.uid()))))));



  create policy "Users can update own entity_relationships"
  on "public"."entity_relationships"
  as permissive
  for update
  to public
using ((EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = entity_relationships.from_entity_id) AND (e.user_id = auth.uid())))))
with check ((EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = entity_relationships.from_entity_id) AND (e.user_id = auth.uid())))));



  create policy "Users can view own entity_relationships"
  on "public"."entity_relationships"
  as permissive
  for select
  to public
using ((EXISTS ( SELECT 1
   FROM public.entities e
  WHERE ((e.id = entity_relationships.from_entity_id) AND (e.user_id = auth.uid())))));



  create policy "Users can delete own events"
  on "public"."events"
  as permissive
  for delete
  to public
using ((auth.uid() = user_id));



  create policy "Users can insert own events"
  on "public"."events"
  as permissive
  for insert
  to public
with check ((auth.uid() = user_id));



  create policy "Users can update own events"
  on "public"."events"
  as permissive
  for update
  to public
using ((auth.uid() = user_id))
with check ((auth.uid() = user_id));



  create policy "Users can view own events"
  on "public"."events"
  as permissive
  for select
  to public
using ((auth.uid() = user_id));



  create policy "Team owners can create invitations"
  on "public"."invitations"
  as permissive
  for insert
  to public
with check ((EXISTS ( SELECT 1
   FROM public.team_members tm
  WHERE ((tm.team_id = invitations.team_id) AND (tm.user_id = auth.uid()) AND ((tm.role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying])::text[]))))));



  create policy "Users can view invitations for their email"
  on "public"."invitations"
  as permissive
  for select
  to public
using (((auth.email() = (email)::text) OR (EXISTS ( SELECT 1
   FROM public.team_members tm
  WHERE ((tm.team_id = invitations.team_id) AND (tm.user_id = auth.uid()) AND ((tm.role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying])::text[])))))));



  create policy "Service role full access to subscriptions"
  on "public"."subscriptions"
  as permissive
  for all
  to service_role
using (true);



  create policy "Users can insert their own subscriptions"
  on "public"."subscriptions"
  as permissive
  for insert
  to public
with check ((auth.uid() = user_id));



  create policy "Users can read their own subscriptions"
  on "public"."subscriptions"
  as permissive
  for select
  to public
using ((auth.uid() = user_id));



  create policy "Users can update their own subscriptions"
  on "public"."subscriptions"
  as permissive
  for update
  to public
using ((auth.uid() = user_id));



  create policy "Users can delete own system decisions"
  on "public"."system_decisions"
  as permissive
  for delete
  to public
using ((auth.uid() = user_id));



  create policy "Users can insert own system decisions"
  on "public"."system_decisions"
  as permissive
  for insert
  to public
with check ((auth.uid() = user_id));



  create policy "Users can update own system decisions"
  on "public"."system_decisions"
  as permissive
  for update
  to public
using ((auth.uid() = user_id))
with check ((auth.uid() = user_id));



  create policy "Users can view own system decisions"
  on "public"."system_decisions"
  as permissive
  for select
  to public
using ((auth.uid() = user_id));



  create policy "Team owners can manage team members"
  on "public"."team_members"
  as permissive
  for all
  to public
using ((EXISTS ( SELECT 1
   FROM public.team_members tm
  WHERE ((tm.team_id = team_members.team_id) AND (tm.user_id = auth.uid()) AND ((tm.role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying])::text[]))))));



  create policy "Users can view their team memberships"
  on "public"."team_members"
  as permissive
  for select
  to public
using ((auth.uid() = user_id));



  create policy "Service role full access to preferences"
  on "public"."user_preferences"
  as permissive
  for all
  to service_role
using (true);



  create policy "Users can insert their own preferences"
  on "public"."user_preferences"
  as permissive
  for insert
  to public
with check ((auth.uid() = user_id));



  create policy "Users can read their own preferences"
  on "public"."user_preferences"
  as permissive
  for select
  to public
using ((auth.uid() = user_id));



  create policy "Users can update their own preferences"
  on "public"."user_preferences"
  as permissive
  for update
  to public
using ((auth.uid() = user_id));



  create policy "Users can update their own profile"
  on "public"."user_profiles"
  as permissive
  for update
  to public
using ((auth.uid() = id))
with check ((auth.uid() = id));



  create policy "Users can view their own profile"
  on "public"."user_profiles"
  as permissive
  for select
  to public
using ((auth.uid() = id));



  create policy "Users can delete own tasks"
  on "public"."user_tasks"
  as permissive
  for delete
  to public
using ((auth.uid() = user_id));



  create policy "Users can insert own tasks"
  on "public"."user_tasks"
  as permissive
  for insert
  to public
with check ((auth.uid() = user_id));



  create policy "Users can update own tasks"
  on "public"."user_tasks"
  as permissive
  for update
  to public
using ((auth.uid() = user_id))
with check ((auth.uid() = user_id));



  create policy "Users can view own tasks"
  on "public"."user_tasks"
  as permissive
  for select
  to public
using ((auth.uid() = user_id));



  create policy "Service role full access to trials"
  on "public"."user_trials"
  as permissive
  for all
  to service_role
using (true);



  create policy "Users can insert their own trials"
  on "public"."user_trials"
  as permissive
  for insert
  to public
with check ((auth.uid() = user_id));



  create policy "Users can read their own trials"
  on "public"."user_trials"
  as permissive
  for select
  to public
using ((auth.uid() = user_id));



  create policy "Users can update their own trials"
  on "public"."user_trials"
  as permissive
  for update
  to public
using ((auth.uid() = user_id));



  create policy "Service role full access to users"
  on "public"."users"
  as permissive
  for all
  to service_role
using (true);



  create policy "Users can read their own data"
  on "public"."users"
  as permissive
  for select
  to public
using ((auth.uid() = id));



  create policy "Users can update their own data"
  on "public"."users"
  as permissive
  for update
  to public
using ((auth.uid() = id));



  create policy "Service role only - no anon access"
  on "public"."waitlist_entries"
  as permissive
  for all
  to public
using (false)
with check (false);



  create policy "Users can view their own workflow runs"
  on "public"."workflow_runs"
  as permissive
  for select
  to authenticated
using (((user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.artifacts a
  WHERE ((a.id = workflow_runs.source_artifact_id) AND (a.user_id = auth.uid()))))));


CREATE TRIGGER trigger_inherit_user_team_from_source BEFORE INSERT ON public.derived_artifacts FOR EACH ROW EXECUTE FUNCTION public.inherit_user_team_from_source();

CREATE TRIGGER trigger_update_derived_artifacts_updated_at BEFORE UPDATE ON public.derived_artifacts FOR EACH ROW EXECUTE FUNCTION public.update_derived_artifacts_updated_at();

CREATE TRIGGER trigger_update_source_artifact_derived_flag AFTER INSERT OR DELETE ON public.derived_artifacts FOR EACH ROW EXECUTE FUNCTION public.update_source_artifact_derived_flag();

CREATE TRIGGER entities_updated_at_trigger BEFORE UPDATE ON public.entities FOR EACH ROW EXECUTE FUNCTION public.update_entities_updated_at();

CREATE TRIGGER events_updated_at_trigger BEFORE UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.update_events_updated_at();

CREATE TRIGGER update_system_decisions_updated_at BEFORE UPDATE ON public.system_decisions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER user_tasks_updated_at_trigger BEFORE UPDATE ON public.user_tasks FOR EACH ROW EXECUTE FUNCTION public.update_user_tasks_updated_at();

CREATE TRIGGER waitlist_entries_updated_at_trigger BEFORE UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION public.update_waitlist_entries_updated_at();

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE TRIGGER on_auth_user_updated AFTER UPDATE ON auth.users FOR EACH ROW WHEN ((old.raw_user_meta_data IS DISTINCT FROM new.raw_user_meta_data)) EXECUTE FUNCTION public.handle_user_update();

CREATE TRIGGER "artifact-tracker" AFTER INSERT ON storage.buckets FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('https://YOUR_PROJECT_REF.supabase.co/functions/v1/storage-webhook-handler', 'POST', '{"Content-type":"application/json","Authorization":"Bearer YOUR_SUPABASE_SERVICE_ROLE_KEY"}', '{}', '5000');


