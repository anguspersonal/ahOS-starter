-- Partial unique index on entities to enforce atomic find-or-create (#1352 / ADR-101 / #1306 M1).
--
-- Background: Automated entity derivation runs periodically via scheduler cadences and
-- on-demand via system_jobs. Prior to this migration, entities lacked a unique constraint on
-- (user_id, entity_type, title) for non-archived entities, making entity find-or-create a
-- check-then-insert pattern that could create duplicate entities under concurrent runs or
-- overlapping sync tools.
--
-- An audit of the production database showed non-archived duplicate entities (e.g. "Hannah Turner"),
-- which were merged and archived. This migration defensively ensures any duplicate non-archived
-- entities in other environments are reconciled and archived before creating the partial unique index.

SET statement_timeout = '30s';

-- Step 1: Re-point any artifact links from duplicate non-archived entities to the keeper.
WITH ranked AS (
  SELECT id,
         user_id,
         entity_type,
         lower(trim(title)) AS l_title,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, entity_type, lower(trim(title))
           ORDER BY created_at ASC, id ASC
         ) AS rn
    FROM public.entities
   WHERE archived = false
),
keepers AS (
  SELECT id, user_id, entity_type, l_title
    FROM ranked
   WHERE rn = 1
),
dups AS (
  SELECT id, user_id, entity_type, l_title
    FROM ranked
   WHERE rn > 1
)
UPDATE public.artifact_entity_links ael
   SET entity_id = k.id
  FROM dups d
  JOIN keepers k ON k.user_id = d.user_id
                AND k.entity_type = d.entity_type
                AND k.l_title = d.l_title
 WHERE ael.entity_id = d.id
   AND NOT EXISTS (
     SELECT 1 FROM public.artifact_entity_links existing
      WHERE existing.artifact_id = ael.artifact_id
        AND existing.entity_id = k.id
        AND existing.link_type = ael.link_type
   );

-- Step 2: Merge non-null description into keeper if keeper lacked one.
WITH ranked AS (
  SELECT id,
         user_id,
         entity_type,
         lower(trim(title)) AS l_title,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, entity_type, lower(trim(title))
           ORDER BY created_at ASC, id ASC
         ) AS rn
    FROM public.entities
   WHERE archived = false
),
keepers AS (
  SELECT id, user_id, entity_type, l_title
    FROM ranked
   WHERE rn = 1
),
dups AS (
  SELECT id, user_id, entity_type, l_title
    FROM ranked
   WHERE rn > 1
)
UPDATE public.entities target
   SET description = COALESCE(target.description, source.description),
       updated_at = now()
  FROM dups d
  JOIN keepers k ON k.user_id = d.user_id
                AND k.entity_type = d.entity_type
                AND k.l_title = d.l_title
  JOIN public.entities source ON source.id = d.id
 WHERE target.id = k.id
   AND target.description IS NULL
   AND source.description IS NOT NULL;

-- Step 3: Archive duplicate non-archived entities.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, entity_type, lower(trim(title))
           ORDER BY created_at ASC, id ASC
         ) AS rn
    FROM public.entities
   WHERE archived = false
)
UPDATE public.entities e
   SET archived = true,
       archived_at = now(),
       properties = jsonb_set(
         COALESCE(e.properties, '{}'::jsonb),
         '{archived_reason}',
         '"duplicate_entity_reconciliation"'
       )
  FROM ranked r
 WHERE e.id = r.id
   AND r.rn > 1;

-- Step 4: Create partial unique index on active entities.
CREATE UNIQUE INDEX IF NOT EXISTS entities_user_entity_type_title_lower_unique
  ON public.entities (user_id, entity_type, lower(trim(title)))
  WHERE archived = false;

COMMENT ON INDEX public.entities_user_entity_type_title_lower_unique IS
  'Guarantees at most one active entity per (user_id, entity_type, lower(trim(title))). Prevents duplicate active entities from concurrent automated entity derivation runs and sync tools (issue #1352 / ADR-101).';
