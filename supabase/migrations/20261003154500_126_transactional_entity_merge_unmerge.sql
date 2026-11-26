-- Migration 126: transactional entity merge and unmerge RPCs (#1192).
--
-- CONTEXT:
--   Entity merges (worker resume.ts / mcp-server review.ts) and unmerges (mcp-server
--   entityUnmerge.ts) previously executed as multi-step HTTP REST calls across
--   entity_relationships, artifact_entity_links, and entities. A mid-sequence failure
--   (network blip, Supabase timeout, or client crash) left the graph in a half-merged
--   or half-unmerged state (e.g. relationship edges repointed back to a still-archived
--   loser) with no automatic rollback.
--
-- WHAT THIS ADDS:
--   1. public.unmerge_entities(p_loser_id uuid, p_user_id uuid) -> jsonb
--      Executes winner staleness check, edge staleness check, relationship edge
--      repointing (restoring #170-demoted relationship types), un-archiving redundant
--      edges, repointing artifact entity links, cleaning winner properties & aliases,
--      and restoring the loser entity row in a single database function call.
--   2. public.merge_entities(p_winner_id uuid, p_loser_id uuid, p_user_id uuid, ...) -> jsonb
--      Executes edge repointing (handling self-loops, collisions, #170 demotions),
--      artifact link repointing (handling collisions), updating winner properties &
--      aliases, tombstoning loser with _merge record, and optionally updating the
--      system_decisions row in a single database function call.
--
-- RE-RUN / SIGNATURE RULE:
--   DROP FUNCTION IF EXISTS before CREATE OR REPLACE FUNCTION ensures versioned drop+create
--   with no stale overload traps (AGENTS.md / check-migration-signatures.js).

SET statement_timeout = '30min';

-- ---------------------------------------------------------------------------
-- 1. unmerge_entities
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.unmerge_entities(uuid, uuid);

CREATE OR REPLACE FUNCTION public.unmerge_entities(
  p_loser_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_loser record;
  v_winner record;
  v_merge_record jsonb;
  v_winner_id uuid;
  v_merged_at timestamptz;
  v_moved_edge_ids text[];
  v_archived_edge_ids text[];
  v_links_moved text[];
  v_aliases_added text[];
  v_properties_carried text[];
  v_demoted_edge_types jsonb;
  v_edge_id text;
  v_edge record;
  v_edge_conflicts text[] := '{}';
  v_type_restored_count integer := 0;
  v_patch_from_winner boolean;
  v_patch_to_winner boolean;
  v_original_type text;
  v_winner_props jsonb;
  v_updated_winner_props jsonb;
  v_loser_props jsonb;
  v_updated_loser_props jsonb;
  v_filtered_winner_aliases text[];
  v_res_aliases jsonb;
BEGIN
  -- 1. Fetch loser entity
  SELECT * INTO v_loser
  FROM entities
  WHERE id = p_loser_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entity not found: %', p_loser_id;
  END IF;

  v_loser_props := COALESCE(v_loser.properties, '{}'::jsonb);
  v_merge_record := v_loser_props->'_merge';

  IF v_merge_record IS NULL OR (v_merge_record->>'winner_id') IS NULL THEN
    RAISE EXCEPTION 'Entity % ("%") does not contain a valid _merge record (properties._merge is missing).',
      v_loser.id, COALESCE(v_loser.title, 'Untitled');
  END IF;

  v_winner_id := (v_merge_record->>'winner_id')::uuid;
  v_merged_at := (v_merge_record->>'merged_at')::timestamptz;

  SELECT COALESCE(array_agg(elem), '{}'::text[])
  INTO v_moved_edge_ids
  FROM jsonb_array_elements_text(COALESCE(v_merge_record->'moved_edge_ids', '[]'::jsonb)) AS elem;

  SELECT COALESCE(array_agg(elem), '{}'::text[])
  INTO v_archived_edge_ids
  FROM jsonb_array_elements_text(COALESCE(v_merge_record->'archived_edge_ids', '[]'::jsonb)) AS elem;

  SELECT COALESCE(array_agg(elem), '{}'::text[])
  INTO v_links_moved
  FROM jsonb_array_elements_text(COALESCE(v_merge_record->'links_moved', '[]'::jsonb)) AS elem;

  SELECT COALESCE(array_agg(elem), '{}'::text[])
  INTO v_aliases_added
  FROM jsonb_array_elements_text(COALESCE(v_merge_record->'aliases_added', '[]'::jsonb)) AS elem;

  SELECT COALESCE(array_agg(elem), '{}'::text[])
  INTO v_properties_carried
  FROM jsonb_array_elements_text(COALESCE(v_merge_record->'properties_carried', '[]'::jsonb)) AS elem;

  v_demoted_edge_types := COALESCE(v_merge_record->'demoted_edge_types', '{}'::jsonb);

  -- 2. Fetch winner entity
  SELECT * INTO v_winner
  FROM entities
  WHERE id = v_winner_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Winner entity % not found.', v_winner_id;
  END IF;

  -- 3. Safety check: refuse if winner modified since merge.
  -- Post-merge embed-on-write (embedEntityAndStore/embedAndStore) fires update_entities_updated_at
  -- trigger immediately after the merge commits, updating winner.updated_at within seconds of
  -- merged_at. We allow a 60-second grace window after merged_at for this automatic embed update,
  -- while catching substantive manual edits made later.
  IF v_winner.updated_at IS NOT NULL AND v_winner.updated_at > (v_merged_at + interval '60 seconds') THEN
    RAISE EXCEPTION 'Unmerge refused: winner entity % has been modified since the merge at % (winner.updated_at=%). Reconcile the winner''s properties manually before unmerging.',
      v_winner.id, v_merged_at, v_winner.updated_at;
  END IF;

  -- 4. Safety check: refuse if any edge modified since merge or deleted
  IF array_length(v_moved_edge_ids, 1) > 0 OR array_length(v_archived_edge_ids, 1) > 0 THEN
    FOR v_edge_id IN SELECT DISTINCT unnest(array_cat(v_moved_edge_ids, v_archived_edge_ids))
    LOOP
      SELECT * INTO v_edge
      FROM entity_relationships
      WHERE id = v_edge_id::uuid AND user_id = p_user_id;

      IF NOT FOUND THEN
        v_edge_conflicts := array_append(v_edge_conflicts, 'Edge ' || v_edge_id || ' was deleted after merge');
      ELSIF v_edge.updated_at > v_merged_at THEN
        v_edge_conflicts := array_append(
          v_edge_conflicts,
          'Edge ' || v_edge.id || ' (' || v_edge.relationship_type || ') was edited at ' || v_edge.updated_at || ' (after merge at ' || v_merged_at || ')'
        );
      END IF;
    END LOOP;

    IF array_length(v_edge_conflicts, 1) > 0 THEN
      RAISE EXCEPTION 'Unmerge refused: the following edge(s) have been modified since the merge at %:%',
        v_merged_at, E'\n- ' || array_to_string(v_edge_conflicts, E'\n- ');
    END IF;
  END IF;

  -- 5. Move edges back, restoring demoted types
  IF array_length(v_moved_edge_ids, 1) > 0 THEN
    FOREACH v_edge_id IN ARRAY v_moved_edge_ids
    LOOP
      SELECT * INTO v_edge
      FROM entity_relationships
      WHERE id = v_edge_id::uuid AND user_id = p_user_id
      FOR UPDATE;

      IF FOUND THEN
        v_patch_from_winner := (v_edge.from_entity_id = v_winner_id);
        v_patch_to_winner := (v_edge.to_entity_id = v_winner_id);
        v_original_type := v_demoted_edge_types->>v_edge_id;

        UPDATE entity_relationships
        SET
          from_entity_id = CASE WHEN v_patch_from_winner THEN p_loser_id ELSE from_entity_id END,
          to_entity_id = CASE WHEN v_patch_to_winner THEN p_loser_id ELSE to_entity_id END,
          relationship_type = CASE WHEN v_original_type IS NOT NULL AND v_original_type <> relationship_type THEN v_original_type ELSE relationship_type END,
          updated_at = now()
        WHERE id = v_edge.id AND user_id = p_user_id;

        IF v_original_type IS NOT NULL AND v_original_type <> v_edge.relationship_type THEN
          v_type_restored_count := v_type_restored_count + 1;
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- 6. Un-archive redundant edges
  IF array_length(v_archived_edge_ids, 1) > 0 THEN
    UPDATE entity_relationships
    SET archived = false, updated_at = now()
    WHERE id = ANY(v_archived_edge_ids::uuid[]) AND user_id = p_user_id;
  END IF;

  -- 7. Move artifact links back
  IF array_length(v_links_moved, 1) > 0 THEN
    UPDATE artifact_entity_links
    SET entity_id = p_loser_id
    WHERE id = ANY(v_links_moved::uuid[]) AND user_id = p_user_id;
  END IF;

  -- 8. Clean up winner entity
  v_winner_props := COALESCE(v_winner.properties, '{}'::jsonb);
  v_updated_winner_props := v_winner_props;

  IF array_length(v_properties_carried, 1) > 0 THEN
    v_updated_winner_props := v_updated_winner_props - v_properties_carried;
  END IF;

  IF array_length(v_aliases_added, 1) > 0 THEN
    IF jsonb_typeof(v_updated_winner_props->'aliases') = 'array' THEN
      SELECT jsonb_agg(elem) INTO v_res_aliases
      FROM jsonb_array_elements_text(v_updated_winner_props->'aliases') elem
      WHERE elem <> ALL(v_aliases_added);

      IF v_res_aliases IS NULL THEN
        v_updated_winner_props := v_updated_winner_props - 'aliases';
      ELSE
        v_updated_winner_props := jsonb_set(v_updated_winner_props, '{aliases}', v_res_aliases);
      END IF;
    END IF;

    IF v_winner.aliases IS NOT NULL THEN
      SELECT COALESCE(array_agg(a), '{}'::text[])
      INTO v_filtered_winner_aliases
      FROM unnest(v_winner.aliases) AS a
      WHERE a <> ALL(v_aliases_added);
    ELSE
      v_filtered_winner_aliases := NULL;
    END IF;
  ELSE
    v_filtered_winner_aliases := v_winner.aliases;
  END IF;

  UPDATE entities
  SET
    properties = v_updated_winner_props,
    aliases = v_filtered_winner_aliases,
    updated_at = now()
  WHERE id = v_winner_id AND user_id = p_user_id;

  -- 9. Restore loser entity
  v_updated_loser_props := v_loser_props - ARRAY['merged_into', 'merged_at', 'archived_reason', '_merge'];

  UPDATE entities
  SET
    archived = false,
    archived_at = NULL,
    properties = v_updated_loser_props,
    updated_at = now()
  WHERE id = p_loser_id AND user_id = p_user_id;

  -- 10. Return summary
  RETURN jsonb_build_object(
    'success', true,
    'loser_id', p_loser_id,
    'winner_id', v_winner_id,
    'loser_title', v_loser.title,
    'loser_description', v_loser.description,
    'loser_properties', v_updated_loser_props,
    'winner_title', v_winner.title,
    'winner_description', v_winner.description,
    'winner_properties', v_updated_winner_props,
    'moved_edge_ids', to_jsonb(v_moved_edge_ids),
    'archived_edge_ids', to_jsonb(v_archived_edge_ids),
    'type_restored_count', v_type_restored_count,
    'links_moved', to_jsonb(v_links_moved),
    'aliases_removed', to_jsonb(v_aliases_added),
    'properties_removed', to_jsonb(v_properties_carried)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.unmerge_entities(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unmerge_entities(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.unmerge_entities(uuid, uuid) IS
  'Atomically reverses an entity merge operation (#1192). Validates staleness guards, repoints relationship edges (restoring demoted types), un-archives redundant edges, repoints artifact links, cleans winner properties/aliases, and restores the tombstoned loser in a single transaction.';

-- ---------------------------------------------------------------------------
-- 2. merge_entities
-- ---------------------------------------------------------------------------

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
          resolved_by = COALESCE(p_resolved_by, p_user_id::text),
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
      WHERE id = p_decision_id AND user_id = p_user_id;
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
          resolved_by = COALESCE(p_resolved_by, p_user_id::text),
          resolved_at = now(),
          resolution_notes = COALESCE(p_resolution_notes, 'Superseded: loser entity was already merged into another entity')
      WHERE id = p_decision_id AND user_id = p_user_id AND status = 'pending';
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
        resolved_by = COALESCE(p_resolved_by, p_user_id::text),
        resolved_at = v_merged_at,
        resolution_notes = p_resolution_notes,
        decision_payload = COALESCE(decision_payload, '{}'::jsonb) || jsonb_build_object(
          'winnerEntityId', p_winner_id::text,
          'loserEntityId', p_loser_id::text,
          'mergedAt', v_merged_at_iso,
          'survivorOverridden', p_survivor_overridden,
          'mergeOpId', v_op_id::text
        )
    WHERE id = p_decision_id AND user_id = p_user_id;
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
