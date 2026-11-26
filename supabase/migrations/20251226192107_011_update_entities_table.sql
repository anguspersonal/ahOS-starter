-- Migration: Update entities table
-- 1. Change id from TEXT to UUID
-- 2. Add default to tags column
-- 3. Ensure archived_at is preserved
-- 4. Update all foreign key references to use UUID
-- 5. Recreate all constraints, indexes, and RLS policies

-- Step 1: Create a temporary mapping table to store old TEXT ids and new UUIDs
CREATE TEMP TABLE entity_id_mapping (
  old_id TEXT PRIMARY KEY,
  new_id UUID NOT NULL DEFAULT gen_random_uuid()
);

-- Step 2: Generate UUIDs for all existing entities
INSERT INTO entity_id_mapping (old_id)
SELECT id FROM entities
ON CONFLICT DO NOTHING;

-- Step 3: Add new UUID columns to all tables that reference entities.id
-- We'll populate these in the next step, then drop the old columns

-- artifact_entity_links
ALTER TABLE artifact_entity_links 
  ADD COLUMN entity_id_new UUID;

-- entity_relationships
ALTER TABLE entity_relationships 
  ADD COLUMN from_entity_id_new UUID,
  ADD COLUMN to_entity_id_new UUID;

-- events
ALTER TABLE events 
  ADD COLUMN entity_id_new UUID;

-- user_tasks
ALTER TABLE user_tasks 
  ADD COLUMN entity_id_new UUID;

-- entities (for self-reference if needed in future)
ALTER TABLE entities 
  ADD COLUMN id_new UUID;

-- Step 4: Populate new UUID columns using the mapping table
-- artifact_entity_links
UPDATE artifact_entity_links ael
SET entity_id_new = m.new_id
FROM entity_id_mapping m
WHERE ael.entity_id = m.old_id;

-- entity_relationships (from_entity_id)
UPDATE entity_relationships er
SET from_entity_id_new = m.new_id
FROM entity_id_mapping m
WHERE er.from_entity_id = m.old_id;

-- entity_relationships (to_entity_id)
UPDATE entity_relationships er
SET to_entity_id_new = m.new_id
FROM entity_id_mapping m
WHERE er.to_entity_id = m.old_id;

-- events
UPDATE events e
SET entity_id_new = m.new_id
FROM entity_id_mapping m
WHERE e.entity_id = m.old_id;

-- user_tasks
UPDATE user_tasks ut
SET entity_id_new = m.new_id
FROM entity_id_mapping m
WHERE ut.entity_id = m.old_id;

-- entities (populate id_new from mapping)
UPDATE entities e
SET id_new = m.new_id
FROM entity_id_mapping m
WHERE e.id = m.old_id;

-- Step 5: Drop foreign key constraints and unique constraints that reference entity_id columns
-- artifact_entity_links
ALTER TABLE artifact_entity_links 
  DROP CONSTRAINT IF EXISTS artifact_entity_links_entity_id_fkey,
  DROP CONSTRAINT IF EXISTS artifact_entity_links_artifact_id_entity_id_link_type_key;

-- entity_relationships
ALTER TABLE entity_relationships 
  DROP CONSTRAINT IF EXISTS entity_relationships_from_entity_id_fkey,
  DROP CONSTRAINT IF EXISTS entity_relationships_to_entity_id_fkey;

-- events
ALTER TABLE events 
  DROP CONSTRAINT IF EXISTS events_entity_id_fkey;

-- user_tasks
ALTER TABLE user_tasks 
  DROP CONSTRAINT IF EXISTS user_tasks_entity_id_fkey;

-- Step 5a: Drop RLS policies that reference entity_id columns
-- artifact_entity_links policies (these reference entities via entity_id)
DROP POLICY IF EXISTS "Users can delete own artifact_entity_links" ON artifact_entity_links;
DROP POLICY IF EXISTS "Users can insert own artifact_entity_links" ON artifact_entity_links;
DROP POLICY IF EXISTS "Users can update own artifact_entity_links" ON artifact_entity_links;
DROP POLICY IF EXISTS "Users can view own artifact_entity_links" ON artifact_entity_links;

-- entity_relationships policies
DROP POLICY IF EXISTS "Users can view own entity_relationships" ON entity_relationships;
DROP POLICY IF EXISTS "Users can insert own entity_relationships" ON entity_relationships;
DROP POLICY IF EXISTS "Users can update own entity_relationships" ON entity_relationships;
DROP POLICY IF EXISTS "Users can delete own entity_relationships" ON entity_relationships;

-- events policies (if they reference entities)
DROP POLICY IF EXISTS "Users can view own events" ON events;
DROP POLICY IF EXISTS "Users can insert own events" ON events;
DROP POLICY IF EXISTS "Users can update own events" ON events;
DROP POLICY IF EXISTS "Users can delete own events" ON events;

-- user_tasks policies (none exist in actual schema, skip)

-- entities policies (will be recreated after id change)
DROP POLICY IF EXISTS "Users can view own entities" ON entities;
DROP POLICY IF EXISTS "Users can insert own entities" ON entities;
DROP POLICY IF EXISTS "Users can update own entities" ON entities;
DROP POLICY IF EXISTS "Users can delete own entities" ON entities;

-- Step 5b: Drop views that depend on entities.id
DROP VIEW IF EXISTS public.archive;
DROP VIEW IF EXISTS public.areas;
DROP VIEW IF EXISTS public.memories;
DROP VIEW IF EXISTS public.people;
DROP VIEW IF EXISTS public.projects;
DROP VIEW IF EXISTS public.resources;
DROP VIEW IF EXISTS public.secure;

-- Step 6: Drop old primary key constraint on entities
ALTER TABLE entities 
  DROP CONSTRAINT IF EXISTS entities_pkey;

-- Step 7: Drop old TEXT columns and rename new UUID columns
-- artifact_entity_links
ALTER TABLE artifact_entity_links 
  DROP COLUMN entity_id;

ALTER TABLE artifact_entity_links 
  RENAME COLUMN entity_id_new TO entity_id;

ALTER TABLE artifact_entity_links 
  ALTER COLUMN entity_id SET NOT NULL;

-- entity_relationships
ALTER TABLE entity_relationships 
  DROP COLUMN from_entity_id;

ALTER TABLE entity_relationships 
  RENAME COLUMN from_entity_id_new TO from_entity_id;

ALTER TABLE entity_relationships 
  ALTER COLUMN from_entity_id SET NOT NULL;

ALTER TABLE entity_relationships 
  DROP COLUMN to_entity_id;

ALTER TABLE entity_relationships 
  RENAME COLUMN to_entity_id_new TO to_entity_id;

ALTER TABLE entity_relationships 
  ALTER COLUMN to_entity_id SET NOT NULL;

-- events
ALTER TABLE events 
  DROP COLUMN entity_id;

ALTER TABLE events 
  RENAME COLUMN entity_id_new TO entity_id;

-- user_tasks
ALTER TABLE user_tasks 
  DROP COLUMN entity_id;

ALTER TABLE user_tasks 
  RENAME COLUMN entity_id_new TO entity_id;

-- entities (primary key)
ALTER TABLE entities 
  DROP COLUMN id;

ALTER TABLE entities 
  RENAME COLUMN id_new TO id;

ALTER TABLE entities 
  ALTER COLUMN id SET NOT NULL;

-- Step 8: Recreate primary key constraint
ALTER TABLE entities 
  ADD CONSTRAINT entities_pkey PRIMARY KEY (id);

-- Step 9: Add default to tags column (if not already set)
ALTER TABLE entities 
  ALTER COLUMN tags SET DEFAULT '{}';

-- Update existing NULL tags to empty array
UPDATE entities
SET tags = '{}'
WHERE tags IS NULL;

-- Step 10: Recreate foreign key constraints
-- artifact_entity_links
ALTER TABLE artifact_entity_links 
  ADD CONSTRAINT artifact_entity_links_entity_id_fkey 
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE;

-- Recreate unique constraint
ALTER TABLE artifact_entity_links 
  ADD CONSTRAINT artifact_entity_links_artifact_id_entity_id_link_type_key 
  UNIQUE (artifact_id, entity_id, link_type);

-- entity_relationships
ALTER TABLE entity_relationships 
  ADD CONSTRAINT entity_relationships_from_entity_id_fkey 
  FOREIGN KEY (from_entity_id) REFERENCES entities(id) ON DELETE CASCADE;

ALTER TABLE entity_relationships 
  ADD CONSTRAINT entity_relationships_to_entity_id_fkey 
  FOREIGN KEY (to_entity_id) REFERENCES entities(id) ON DELETE CASCADE;

-- events
ALTER TABLE events 
  ADD CONSTRAINT events_entity_id_fkey 
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE SET NULL;

-- user_tasks
ALTER TABLE user_tasks 
  ADD CONSTRAINT user_tasks_entity_id_fkey 
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE SET NULL;

-- Step 11: Recreate indexes
-- entities indexes
CREATE INDEX IF NOT EXISTS idx_entities_user_id ON entities(user_id);
CREATE INDEX IF NOT EXISTS idx_entities_team_id ON entities(team_id) WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entities_entity_type ON entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_archived ON entities(archived) WHERE archived = false;
CREATE INDEX IF NOT EXISTS idx_entities_updated_at ON entities(updated_at DESC);

-- artifact_entity_links indexes (entity_id)
CREATE INDEX IF NOT EXISTS idx_artifact_entity_entity ON artifact_entity_links(entity_id);

-- entity_relationships indexes
CREATE INDEX IF NOT EXISTS idx_entity_rel_from ON entity_relationships(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_rel_to ON entity_relationships(to_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_rel_both ON entity_relationships(from_entity_id, to_entity_id);

-- events indexes (entity_id)
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_id) WHERE entity_id IS NOT NULL;

-- user_tasks indexes (entity_id)
CREATE INDEX IF NOT EXISTS idx_user_tasks_entity ON user_tasks(entity_id) WHERE entity_id IS NOT NULL;

-- Step 12: Recreate RLS policies
-- entities policies
CREATE POLICY "Users can view own entities"
ON entities
AS PERMISSIVE
FOR SELECT
TO public
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own entities"
ON entities
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own entities"
ON entities
AS PERMISSIVE
FOR UPDATE
TO public
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own entities"
ON entities
AS PERMISSIVE
FOR DELETE
TO public
USING (auth.uid() = user_id);

-- artifact_entity_links policies
CREATE POLICY "Users can view own artifact_entity_links"
ON artifact_entity_links
AS PERMISSIVE
FOR SELECT
TO public
USING ((EXISTS ( SELECT 1
   FROM entities e
  WHERE ((e.id = artifact_entity_links.entity_id) AND (e.user_id = auth.uid())))));

CREATE POLICY "Users can insert own artifact_entity_links"
ON artifact_entity_links
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK (((EXISTS ( SELECT 1
   FROM entities e
  WHERE ((e.id = artifact_entity_links.entity_id) AND (e.user_id = auth.uid())))) AND (EXISTS ( SELECT 1
   FROM artifacts a
  WHERE ((a.id = artifact_entity_links.artifact_id) AND (a.user_id = auth.uid()))))));

CREATE POLICY "Users can update own artifact_entity_links"
ON artifact_entity_links
AS PERMISSIVE
FOR UPDATE
TO public
USING ((EXISTS ( SELECT 1
   FROM entities e
  WHERE ((e.id = artifact_entity_links.entity_id) AND (e.user_id = auth.uid())))))
WITH CHECK ((EXISTS ( SELECT 1
   FROM entities e
  WHERE ((e.id = artifact_entity_links.entity_id) AND (e.user_id = auth.uid())))));

CREATE POLICY "Users can delete own artifact_entity_links"
ON artifact_entity_links
AS PERMISSIVE
FOR DELETE
TO public
USING ((EXISTS ( SELECT 1
   FROM entities e
  WHERE ((e.id = artifact_entity_links.entity_id) AND (e.user_id = auth.uid())))));

-- entity_relationships policies
CREATE POLICY "Users can view own entity_relationships"
ON entity_relationships
AS PERMISSIVE
FOR SELECT
TO public
USING (((EXISTS ( SELECT 1
   FROM entities e
  WHERE ((e.id = entity_relationships.from_entity_id) AND (e.user_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM entities e
  WHERE ((e.id = entity_relationships.to_entity_id) AND (e.user_id = auth.uid()))))));

CREATE POLICY "Users can insert own entity_relationships"
ON entity_relationships
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK (((EXISTS ( SELECT 1
   FROM entities e
  WHERE ((e.id = entity_relationships.from_entity_id) AND (e.user_id = auth.uid())))) AND (EXISTS ( SELECT 1
   FROM entities e
  WHERE ((e.id = entity_relationships.to_entity_id) AND (e.user_id = auth.uid()))))));

CREATE POLICY "Users can update own entity_relationships"
ON entity_relationships
AS PERMISSIVE
FOR UPDATE
TO public
USING (((EXISTS ( SELECT 1
   FROM entities e
  WHERE ((e.id = entity_relationships.from_entity_id) AND (e.user_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM entities e
  WHERE ((e.id = entity_relationships.to_entity_id) AND (e.user_id = auth.uid()))))))
WITH CHECK (((EXISTS ( SELECT 1
   FROM entities e
  WHERE ((e.id = entity_relationships.from_entity_id) AND (e.user_id = auth.uid())))) AND (EXISTS ( SELECT 1
   FROM entities e
  WHERE ((e.id = entity_relationships.to_entity_id) AND (e.user_id = auth.uid()))))));

CREATE POLICY "Users can delete own entity_relationships"
ON entity_relationships
AS PERMISSIVE
FOR DELETE
TO public
USING (((EXISTS ( SELECT 1
   FROM entities e
  WHERE ((e.id = entity_relationships.from_entity_id) AND (e.user_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM entities e
  WHERE ((e.id = entity_relationships.to_entity_id) AND (e.user_id = auth.uid()))))));

-- events policies (if they reference entities)
CREATE POLICY "Users can view own events"
ON events
AS PERMISSIVE
FOR SELECT
TO public
USING ((auth.uid() = user_id));

CREATE POLICY "Users can insert own events"
ON events
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can update own events"
ON events
AS PERMISSIVE
FOR UPDATE
TO public
USING ((auth.uid() = user_id))
WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can delete own events"
ON events
AS PERMISSIVE
FOR DELETE
TO public
USING ((auth.uid() = user_id));

-- Step 13: Recreate views that depend on entities.id
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

-- Clean up: Drop temporary mapping table (it's TEMP so will be dropped automatically)
-- But let's be explicit
DROP TABLE IF EXISTS entity_id_mapping;

