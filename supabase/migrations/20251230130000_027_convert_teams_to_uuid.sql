-- Migration: Convert teams.id from integer to UUID
-- Date: 2025-12-30
-- Description: Converts teams table primary key and all team_id foreign keys from integer to UUID
-- This migration follows the pattern established in migration 025 for UUID conversions

-- ============================================================================
-- PART 1: Create mapping table for existing team IDs
-- ============================================================================

CREATE TEMP TABLE teams_id_mapping (
  old_id INTEGER PRIMARY KEY,
  new_id UUID NOT NULL DEFAULT gen_random_uuid()
);

-- Populate mapping with existing teams
INSERT INTO teams_id_mapping (old_id)
SELECT id FROM teams
ON CONFLICT DO NOTHING;

-- ============================================================================
-- PART 2: Drop all foreign key constraints that reference teams.id
-- ============================================================================

ALTER TABLE IF EXISTS activity_logs 
  DROP CONSTRAINT IF EXISTS activity_logs_team_id_fkey;

ALTER TABLE IF EXISTS artifacts 
  DROP CONSTRAINT IF EXISTS artifacts_team_id_fkey;

ALTER TABLE IF EXISTS derived_artifacts 
  DROP CONSTRAINT IF EXISTS derived_artifacts_team_id_fkey;

ALTER TABLE IF EXISTS entities 
  DROP CONSTRAINT IF EXISTS entities_team_id_fkey;

ALTER TABLE IF EXISTS events 
  DROP CONSTRAINT IF EXISTS events_team_id_fkey;

ALTER TABLE IF EXISTS invitations 
  DROP CONSTRAINT IF EXISTS invitations_team_id_fkey;

ALTER TABLE IF EXISTS system_decisions 
  DROP CONSTRAINT IF EXISTS system_decisions_team_id_fkey;

ALTER TABLE IF EXISTS team_members 
  DROP CONSTRAINT IF EXISTS team_members_team_id_fkey;

ALTER TABLE IF EXISTS user_tasks 
  DROP CONSTRAINT IF EXISTS user_tasks_team_id_fkey;

-- Handle workflows table (may be named workflow_runs in older migrations)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workflows' AND table_schema = 'public') THEN
    ALTER TABLE workflows DROP CONSTRAINT IF EXISTS workflows_team_id_fkey;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workflow_runs' AND table_schema = 'public') THEN
    ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_team_id_fkey;
  END IF;
END $$;

-- ============================================================================
-- PART 3: Drop RLS policies that depend on team_id columns before conversion
-- ============================================================================

-- Drop policies on invitations table that reference team_id
DROP POLICY IF EXISTS "Team owners can create invitations" ON public.invitations;
DROP POLICY IF EXISTS "Users can view invitations for their email" ON public.invitations;

-- Drop policies on team_members table that reference team_id
DROP POLICY IF EXISTS "Team owners can manage team members" ON public.team_members;

-- Note: Other policies may reference team_id indirectly through joins, but the main ones
-- that directly reference team_id columns are dropped above. Policies that only check
-- user_id or other columns will continue to work after the conversion.

-- ============================================================================
-- PART 4: Drop views that depend on team_id columns before conversion
-- ============================================================================

-- Drop entity type views that depend on entities.team_id
DROP VIEW IF EXISTS public.archive;
DROP VIEW IF EXISTS public.areas;
DROP VIEW IF EXISTS public.memories;
DROP VIEW IF EXISTS public.people;
DROP VIEW IF EXISTS public.projects;
DROP VIEW IF EXISTS public.resources;
DROP VIEW IF EXISTS public.secure;

-- ============================================================================
-- PART 5: Convert all team_id columns from integer to UUID
-- ============================================================================

-- Helper function to convert team_id column in a table
CREATE OR REPLACE FUNCTION convert_team_id_column(table_name TEXT, column_name TEXT DEFAULT 'team_id')
RETURNS void AS $$
DECLARE
  temp_col_name TEXT := column_name || '_new';
BEGIN
  -- Add new UUID column
  EXECUTE format('ALTER TABLE %I ADD COLUMN %I UUID', table_name, temp_col_name);
  
  -- Populate new column from mapping
  EXECUTE format('
    UPDATE %I t
    SET %I = m.new_id
    FROM teams_id_mapping m
    WHERE t.%I = m.old_id',
    table_name, temp_col_name, column_name);
  
  -- Drop old column
  EXECUTE format('ALTER TABLE %I DROP COLUMN %I', table_name, column_name);
  
  -- Rename new column
  EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', table_name, temp_col_name, column_name);
END;
$$ LANGUAGE plpgsql;

-- Convert team_id columns in all referencing tables
SELECT convert_team_id_column('activity_logs', 'team_id');
SELECT convert_team_id_column('artifacts', 'team_id');
SELECT convert_team_id_column('derived_artifacts', 'team_id');
SELECT convert_team_id_column('entities', 'team_id');
SELECT convert_team_id_column('events', 'team_id');
SELECT convert_team_id_column('invitations', 'team_id');
SELECT convert_team_id_column('system_decisions', 'team_id');
SELECT convert_team_id_column('team_members', 'team_id');
SELECT convert_team_id_column('user_tasks', 'team_id');

-- Handle workflows/workflow_runs
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workflows' AND table_schema = 'public') THEN
    PERFORM convert_team_id_column('workflows', 'team_id');
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workflow_runs' AND table_schema = 'public') THEN
    PERFORM convert_team_id_column('workflow_runs', 'team_id');
  END IF;
END $$;

-- Drop helper function
DROP FUNCTION convert_team_id_column(TEXT, TEXT);

-- ============================================================================
-- PART 6: Convert teams.id from integer to UUID
-- ============================================================================

-- Step 6.1: Add new UUID column
ALTER TABLE teams ADD COLUMN id_new UUID;

-- Step 6.2: Populate new column from mapping
UPDATE teams t
SET id_new = m.new_id
FROM teams_id_mapping m
WHERE t.id = m.old_id;

-- Step 6.3: For any rows without mapping (shouldn't happen), generate new UUID
UPDATE teams
SET id_new = gen_random_uuid()
WHERE id_new IS NULL;

-- Step 6.4: Make new column NOT NULL
ALTER TABLE teams ALTER COLUMN id_new SET NOT NULL;

-- Step 6.5: Drop old primary key, sequence, and column
ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_pkey;
DROP SEQUENCE IF EXISTS public.teams_id_seq CASCADE;
ALTER TABLE teams DROP COLUMN id;

-- Step 6.6: Rename and add primary key with default
ALTER TABLE teams RENAME COLUMN id_new TO id;
ALTER TABLE teams ADD CONSTRAINT teams_pkey PRIMARY KEY (id);
ALTER TABLE teams ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- ============================================================================
-- PART 7: Recreate all foreign key constraints
-- ============================================================================

ALTER TABLE activity_logs 
  ADD CONSTRAINT activity_logs_team_id_fkey 
  FOREIGN KEY (team_id) REFERENCES teams(id);

ALTER TABLE artifacts 
  ADD CONSTRAINT artifacts_team_id_fkey 
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL;

ALTER TABLE derived_artifacts 
  ADD CONSTRAINT derived_artifacts_team_id_fkey 
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL;

ALTER TABLE entities 
  ADD CONSTRAINT entities_team_id_fkey 
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;

ALTER TABLE events 
  ADD CONSTRAINT events_team_id_fkey 
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;

ALTER TABLE invitations 
  ADD CONSTRAINT invitations_team_id_fkey 
  FOREIGN KEY (team_id) REFERENCES teams(id);

ALTER TABLE system_decisions 
  ADD CONSTRAINT system_decisions_team_id_fkey 
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;

ALTER TABLE team_members 
  ADD CONSTRAINT team_members_team_id_fkey 
  FOREIGN KEY (team_id) REFERENCES teams(id);

ALTER TABLE user_tasks 
  ADD CONSTRAINT user_tasks_team_id_fkey 
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;

-- Handle workflows/workflow_runs
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workflows' AND table_schema = 'public') THEN
    ALTER TABLE workflows 
      ADD CONSTRAINT workflows_team_id_fkey 
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'workflow_runs' AND table_schema = 'public') THEN
    ALTER TABLE workflow_runs 
      ADD CONSTRAINT workflow_runs_team_id_fkey 
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ============================================================================
-- PART 8: Recreate views that depend on team_id columns
-- ============================================================================

-- Recreate entity type views (team_id is now UUID, but views don't need changes)
CREATE OR REPLACE VIEW public.archive AS
  SELECT id,
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

CREATE OR REPLACE VIEW public.areas AS
  SELECT id,
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

CREATE OR REPLACE VIEW public.memories AS
  SELECT id,
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

CREATE OR REPLACE VIEW public.people AS
  SELECT id,
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

CREATE OR REPLACE VIEW public.projects AS
  SELECT id,
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

CREATE OR REPLACE VIEW public.resources AS
  SELECT id,
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

CREATE OR REPLACE VIEW public.secure AS
  SELECT id,
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

-- ============================================================================
-- PART 9: Recreate RLS policies that reference team_id
-- ============================================================================

-- Recreate invitations policies (team_id is now UUID, but policy logic is unchanged)
CREATE POLICY "Team owners can create invitations"
  ON public.invitations
  AS PERMISSIVE
  FOR INSERT
  TO public
WITH CHECK ((EXISTS ( SELECT 1
   FROM public.team_members tm
  WHERE ((tm.team_id = invitations.team_id) AND (tm.user_id = auth.uid()) AND ((tm.role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying])::text[]))))));

CREATE POLICY "Users can view invitations for their email"
  ON public.invitations
  AS PERMISSIVE
  FOR SELECT
  TO public
USING (((auth.email() = (email)::text) OR (EXISTS ( SELECT 1
   FROM public.team_members tm
  WHERE ((tm.team_id = invitations.team_id) AND (tm.user_id = auth.uid()) AND ((tm.role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying])::text[])))))));

-- Recreate team_members policies (team_id is now UUID, but policy logic is unchanged)
CREATE POLICY "Team owners can manage team members"
  ON public.team_members
  AS PERMISSIVE
  FOR ALL
  TO public
USING ((EXISTS ( SELECT 1
   FROM public.team_members tm
  WHERE ((tm.team_id = team_members.team_id) AND (tm.user_id = auth.uid()) AND ((tm.role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying])::text[]))))));

-- ============================================================================
-- PART 10: Cleanup
-- ============================================================================

DROP TABLE teams_id_mapping;

-- ============================================================================
-- PART 11: Update stored procedures and functions that reference team_id as integer
-- ============================================================================

-- Update create_entity function signature to use UUID for team_id
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'create_entity'
  ) THEN
    -- Drop old function signature
    DROP FUNCTION IF EXISTS public.create_entity(text, text, text, jsonb, text[], uuid, integer);
    -- Note: Function body will need to be recreated by application or later migration
    -- The parameter type change is handled by dropping the old signature
  END IF;
END $$;

-- Update function return types that include team_id as integer
-- Note: These functions will need their bodies updated in a later migration
-- The schema conversion ensures columns are UUID, so function signatures must match

-- Add comment documenting the standard
COMMENT ON COLUMN teams.id IS 'Primary key - UUID auto-generated by database';

