-- Migration 130: merge_entities resolves its decision only while pending, and writes resolved_by as uuid (#1397).
--
-- Fixes two issues in migration 126's public.merge_entities:
-- 1. Atomic claim on system_decisions: Each of the three UPDATE system_decisions statements now
--    requires status = 'pending'. If a concurrent resolution raced and won, IF NOT FOUND raises
--    an exception rolling back the entire merge transaction.
-- 2. Type mismatch on resolved_by: resolved_by is typed uuid in system_decisions. Replaces
--    COALESCE(p_resolved_by, p_user_id::text) with COALESCE(p_resolved_by::uuid, p_user_id) to
--    prevent runtime "column resolved_by is of type uuid but expression is of type text" errors.

DROP FUNCTION IF EXISTS public.merge_entities(uuid, uuid, uuid, jsonb, text[], text[], text[], jsonb, uuid, text, boolean, text, text);

CREATE OR REPLACE FUNCTION public.merge_entities(
  p_winner_id uuid,
  p_loser_id uuid,
  p_user_id uuid,
  p_winner_properties jsonb,
  p_winner_aliases text[],
  p_aliases_added text[],
  p_properties_carried text[],
  p_properties_skipped jsonb DEFAULT '{}'::jsonb,
  p_decision_id uuid DEFAULT NULL,
  p_resolution_notes text DEFAULT 'Approved by user',
  p_survivor_overridden boolean DEFAULT false,
  p_decision_status text DEFAULT 'approved',
  p_resolved_by text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_winner record;
  v_loser record;
  v_loser_props jsonb;
  v_loser_merged_into text;
  v_edge record;
  v_new_from uuid;
  v_new_to uuid;
  v_new_type text;
  v_moved_edge_ids text[] := '{}';
  v_archived_edge_ids text[] := '{}';
  v_demoted_edge_types jsonb := '{}'::jsonb;
  v_link record;
  v_links_moved text[] := '{}';
  v_links_deleted text[] := '{}';
  v_op_id uuid;
  v_merged_at timestamptz;
  v_merged_at_iso text;
  v_merge_op jsonb;
BEGIN
  IF p_winner_id = p_loser_id THEN
    RAISE EXCEPTION 'merge_suggested decision has winnerEntityId === loserEntityId';
  END IF;

  -- 1. Fetch winner entity
  SELECT * INTO v_winner
  FROM entities
  WHERE id = p_winner_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Merge winner entity not found: %', p_winner_id;
  END IF;

  IF v_winner.archived IS TRUE THEN
    RAISE EXCEPTION 'Merge winner entity % is archived; refusing to merge onto a tombstoned winner.', p_winner_id;
  END IF;

  -- 2. Fetch loser entity
  SELECT * INTO v_loser
  FROM entities
  WHERE id = p_loser_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Merge loser entity not found: %', p_loser_id;
  END IF;

  v_loser_props := COALESCE(v_loser.properties, '{}'::jsonb);
  v_loser_merged_into := v_loser_props->>'merged_into';

  -- 3. Check if already merged
  IF v_loser.archived IS TRUE AND v_loser_merged_into = p_winner_id::text THEN
    IF p_decision_id IS NOT NULL THEN
      UPDATE system_decisions
      SET status = p_decision_status,
          resolved_by = COALESCE(p_resolved_by::uuid, p_user_id),
          resolved_at = now(),
          resolution_notes = p_resolution_notes,
          decision_payload = jsonb_set(
            jsonb_set(
              jsonb_set(
                COALESCE(decision_payload, '{}'::jsonb),
                '{winnerEntityId}',
                to_jsonb(p_winner_id::text)
              ),
              '{loserEntityId}',
              to_jsonb(p_loser_id::text)
            ),
            '{survivorOverridden}',
            to_jsonb(p_survivor_overridden)
          )
      WHERE id = p_decision_id AND user_id = p_user_id AND status = 'pending';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Decision % was resolved concurrently; nothing changed.', p_decision_id;
      END IF;
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'already_merged', true,
      'idempotent', true,
      'winner_id', p_winner_id,
      'loser_id', p_loser_id
    );
  END IF;

  IF v_loser.archived IS TRUE AND v_loser_merged_into IS NOT NULL AND v_loser_merged_into <> p_winner_id::text THEN
    IF p_decision_id IS NOT NULL THEN
      UPDATE system_decisions
      SET status = 'rejected',
          resolved_by = COALESCE(p_resolved_by::uuid, p_user_id),
          resolved_at = now(),
          resolution_notes = COALESCE(p_resolution_notes, 'Superseded: loser entity was already merged into another entity')
      WHERE id = p_decision_id AND user_id = p_user_id AND status = 'pending';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Decision % was resolved concurrently; nothing changed.', p_decision_id;
      END IF;
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'superseded', true,
      'winner_id', p_winner_id,
      'loser_id', p_loser_id,
      'merged_into', v_loser_merged_into
    );
  END IF;

  -- 4. Repoint relationship edges touching loser
  FOR v_edge IN
    SELECT * FROM entity_relationships
    WHERE (from_entity_id = p_loser_id OR to_entity_id = p_loser_id)
      AND user_id = p_user_id
    FOR UPDATE
  LOOP
    v_new_from := CASE WHEN v_edge.from_entity_id = p_loser_id THEN p_winner_id ELSE v_edge.from_entity_id END;
    v_new_to := CASE WHEN v_edge.to_entity_id = p_loser_id THEN p_winner_id ELSE v_edge.to_entity_id END;

    IF v_new_from = v_new_to THEN
      UPDATE entity_relationships SET archived = true, updated_at = now() WHERE id = v_edge.id;
      v_archived_edge_ids := array_append(v_archived_edge_ids, v_edge.id::text);
      CONTINUE;
    END IF;

    v_new_type := v_edge.relationship_type;
    IF v_edge.relationship_type = 'belongs_to'
       AND v_edge.from_entity_id = p_loser_id
       AND v_edge.archived IS NOT TRUE
       AND (v_winner.entity_type IN ('project', 'resource')) THEN
      IF EXISTS (
        SELECT 1 FROM entity_relationships
        WHERE user_id = p_user_id
          AND from_entity_id = p_winner_id
          AND relationship_type = 'belongs_to'
          AND archived IS NOT TRUE
          AND to_entity_id <> v_new_to
      ) THEN
        v_demoted_edge_types := jsonb_set(v_demoted_edge_types, ARRAY[v_edge.id::text], to_jsonb(v_edge.relationship_type));
        v_new_type := 'associated_with';
      END IF;
    END IF;

    IF EXISTS (
      SELECT 1 FROM entity_relationships
      WHERE user_id = p_user_id
        AND from_entity_id = v_new_from
        AND to_entity_id = v_new_to
        AND relationship_type = v_new_type
        AND archived IS NOT TRUE
        AND id <> v_edge.id
    ) THEN
      v_demoted_edge_types := v_demoted_edge_types - v_edge.id::text;
      UPDATE entity_relationships SET archived = true, updated_at = now() WHERE id = v_edge.id;
      v_archived_edge_ids := array_append(v_archived_edge_ids, v_edge.id::text);
      CONTINUE;
    END IF;

    UPDATE entity_relationships
    SET from_entity_id = v_new_from,
        to_entity_id = v_new_to,
        relationship_type = v_new_type,
        updated_at = now()
    WHERE id = v_edge.id;
    v_moved_edge_ids := array_append(v_moved_edge_ids, v_edge.id::text);
  END LOOP;

  -- 5. Repoint artifact entity links
  FOR v_link IN
    SELECT * FROM artifact_entity_links
    WHERE entity_id = p_loser_id AND user_id = p_user_id
    FOR UPDATE
  LOOP
    IF EXISTS (
      SELECT 1 FROM artifact_entity_links
      WHERE artifact_id = v_link.artifact_id
        AND entity_id = p_winner_id
        AND link_type = v_link.link_type
        AND user_id = p_user_id
        AND id <> v_link.id
    ) THEN
      DELETE FROM artifact_entity_links WHERE id = v_link.id;
      v_links_deleted := array_append(v_links_deleted, v_link.id::text);
      CONTINUE;
    END IF;

    UPDATE artifact_entity_links SET entity_id = p_winner_id WHERE id = v_link.id;
    v_links_moved := array_append(v_links_moved, v_link.id::text);
  END LOOP;

  -- 6. Update winner entity
  UPDATE entities
  SET properties = p_winner_properties,
      aliases = p_winner_aliases,
      updated_at = now()
  WHERE id = p_winner_id AND user_id = p_user_id;

  -- 7. Tombstone loser with _merge record
  v_op_id := gen_random_uuid();
  v_merged_at := clock_timestamp();
  v_merged_at_iso := to_char(v_merged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');

  v_merge_op := jsonb_build_object(
    'op_id', v_op_id::text,
    'merged_at', v_merged_at_iso,
    'winner_id', p_winner_id::text,
    'moved_edge_ids', to_jsonb(v_moved_edge_ids),
    'archived_edge_ids', to_jsonb(v_archived_edge_ids),
    'aliases_added', to_jsonb(p_aliases_added),
    'properties_carried', to_jsonb(p_properties_carried),
    'links_moved', to_jsonb(v_links_moved),
    'links_deleted', to_jsonb(v_links_deleted)
  );

  IF p_properties_skipped IS NOT NULL AND p_properties_skipped <> '{}'::jsonb THEN
    v_merge_op := jsonb_set(v_merge_op, '{properties_skipped}', p_properties_skipped);
  END IF;

  IF v_demoted_edge_types IS NOT NULL AND v_demoted_edge_types <> '{}'::jsonb THEN
    v_merge_op := jsonb_set(v_merge_op, '{demoted_edge_types}', v_demoted_edge_types);
  END IF;

  UPDATE entities
  SET archived = true,
      archived_at = v_merged_at,
      properties = v_loser_props || jsonb_build_object(
        'merged_into', p_winner_id::text,
        'merged_at', v_merged_at_iso,
        'archived_reason', 'merged_duplicate',
        '_merge', v_merge_op
      ),
      updated_at = v_merged_at
  WHERE id = p_loser_id AND user_id = p_user_id;

  -- 8. Resolve decision if passed
  IF p_decision_id IS NOT NULL THEN
    UPDATE system_decisions
    SET status = p_decision_status,
        resolved_by = COALESCE(p_resolved_by::uuid, p_user_id),
        resolved_at = v_merged_at,
        resolution_notes = p_resolution_notes,
        decision_payload = COALESCE(decision_payload, '{}'::jsonb) || jsonb_build_object(
          'winnerEntityId', p_winner_id::text,
          'loserEntityId', p_loser_id::text,
          'mergedAt', v_merged_at_iso,
          'survivorOverridden', p_survivor_overridden,
          'mergeOpId', v_op_id::text
        )
    WHERE id = p_decision_id AND user_id = p_user_id AND status = 'pending';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Decision % was resolved concurrently; nothing changed.', p_decision_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'winner_id', p_winner_id,
    'loser_id', p_loser_id,
    'op_id', v_op_id,
    'merged_at', v_merged_at_iso,
    'merge_op', v_merge_op,
    'winner_title', v_winner.title,
    'winner_description', v_winner.description
  );
END;
$$;

REVOKE ALL ON FUNCTION public.merge_entities(uuid, uuid, uuid, jsonb, text[], text[], text[], jsonb, uuid, text, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_entities(uuid, uuid, uuid, jsonb, text[], text[], text[], jsonb, uuid, text, boolean, text, text) TO service_role;

COMMENT ON FUNCTION public.merge_entities(uuid, uuid, uuid, jsonb, text[], text[], text[], jsonb, uuid, text, boolean, text, text) IS
  'Atomically merges an entity into a surviving winner (#1192). Repoints relationship edges, repoints artifact links, updates winner properties/aliases, stamps the loser tombstone with _merge metadata, and resolves any linked system_decisions row in a single atomic transaction.';
