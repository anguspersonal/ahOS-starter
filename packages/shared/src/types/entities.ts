/**
 * The closed CRUD set: entity types with a dedicated typed shape
 * (`EntityTypeMap`), a real Postgres view (`public.projects`, `public.people`,
 * ...), and a listing page. This is NOT the full set of `entity_type` values
 * the database accepts — see `GraphEntityType` below for that.
 *
 * 'memory', 'secure', 'archive' were dropped in migration 067 (#172): zero
 * rows in prod, and 'archive' duplicated the existing `archived` boolean
 * column. The dedicated interfaces and EntityTypeMap entries were removed here
 * in sync with the DB CHECK constraint change.
 */
export type EntityType =
  | 'project'
  | 'area'
  | 'resource'
  | 'people';

/**
 * Every `entity_type` value the `entities.entity_type` CHECK constraint
 * accepts (PARAMPS + graph-only node types), i.e. `EntityType` plus the
 * types added for the interpersonal/knowledge graph: `event`
 * (ADR-025), `organization` (ADR-025), `signal` (ADR-025), `place` (#188),
 * `concept` (#209, ADR-DRAFT-concept-entity-type — anchored to skos:Concept),
 * `capability` (#63, ADR-031 — the skill/agent/command registry), `domain`
 * (#62, ADR-019 — the binding-layer scope axis, anchored to ahos:Domain),
 * `arrangement` (#327, ADR-035 — a reified n-ary/repeated fact node, e.g. an
 * employment or residency, with per-role participant edges; kind in
 * properties.kind), `term` (#1023, ADR-092 — an acronym or piece of internal
 * shorthand; expansion and context in properties), `decision` (#2003,
 * ADR-038 §6 — an executive or architectural decision node in the knowledge
 * graph).
 *
 * Graph-only types have no dedicated view/listing page — they exist so
 * `process_artifact`/`artifact_entity_sync` can create real nodes for things
 * mentioned in captures (a wedding, a venue, a city, a topic/subject) and the
 * knowledge graph can relate people to them. Code that renders an entity
 * fetched generically (e.g. by following a relationship edge, where the type
 * isn't known ahead of time) should key off `GraphEntityType`, not
 * `EntityType`, so it doesn't silently mis-render
 * event/organization/signal/place/concept nodes.
 *
 * Kept in sync BY HAND with `ENTITY_TYPES` in
 * `packages/mcp-server/src/vocab.ts` (the DB-CHECK-mirroring source of truth
 * for what can be written) and the `entities_entity_type_check` constraint —
 * `shared` has no dependency on `mcp-server`, so this can't be generated from
 * it. Update all three together.
 */
export type GraphEntityType =
  | EntityType
  | 'event'
  | 'organization'
  | 'signal'
  | 'place'
  | 'concept'
  | 'capability'
  | 'domain'
  | 'arrangement'
  | 'term'
  | 'decision';

export interface BaseEntity {
  id: string;
  title?: string | null;
  description?: string | null;
  tags: string[] | null;
  archived: boolean;
  archived_at: string | null;
  properties: Record<string, unknown> | null;
  /**
   * URL of the external record that IS this entity (e.g. a person's Notion
   * People row), not pages that merely mention it. `null` = native to the
   * graph — created from a capture or by hand, no external home — NOT "lookup
   * failed" or "not yet fetched". Real column on `entities`, unique per user
   * where not null. See migration 077 and issue #426.
   */
  source_url: string | null;
  /**
   * Other names an entity answers to (#1023, ADR-092, migration 110).
   * Real text[] column on entities.
   */
  aliases: string[];
  /**
   * Hand-curated membership of the hot tier (#1023, ADR-092, migration 110).
   * Real boolean column on entities.
   */
  hot: boolean;
  /**
   * IRI local part (ADR-037 / #1104). Identifies seeded instance nodes and vocab
   * terms. Real column on `entities`, unique per (user_id, namespace, local_name)
   * where not null.
   */
  local_name?: string | null;
  /**
   * Namespace pointer for IRI identity (ADR-037 / #1104). Null = default 'ahos'.
   */
  namespace?: string | null;
  user_id: string;
  team_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectEntity extends BaseEntity {
  title: string;
  status: string | null;
  due_date: string | null;
  priority: string | null;
  completion_percentage: number | null;
  milestones: unknown;
}

export interface AreaEntity extends BaseEntity {
  title: string;
  responsibility_type: string | null;
  review_frequency: string | null;
  active: boolean | null;
}

export interface ResourceEntity extends BaseEntity {
  title: string;
  resource_type: string | null;
  url: string | null;
  author: string | null;
  date_published: string | null;
  date_accessed: string | null;
}

export interface PersonEntity extends BaseEntity {
  name: string;
  bio: string | null;
  role: string | null;
  organization: string | null;
  email: string | null;
  phone: string | null;
  relationship: string | null;
  last_contact: string | null;
}

/**
 * Relationship vocabulary for the interpersonal knowledge graph.
 *
 * Built on FOAF (http://xmlns.com/foaf/0.1/) plus its standard companion, the
 * RELATIONSHIP vocabulary (http://purl.org/vocab/relationship/). FOAF deliberately
 * ships only `foaf:knows`; RELATIONSHIP supplies the granular typed edges. Every
 * `rel:*` term is `rdfs:subPropertyOf foaf:knows`. See ADR-021.
 *
 * Runtime metadata (labels, categories, inverses, symmetry) lives in
 * `RELATIONSHIP_VOCABULARY` in `../constants`.
 */
export type KnownRelationshipType =
  // RELATIONSHIP — family
  | 'parentOf'
  | 'childOf'
  | 'grandparentOf'
  | 'grandchildOf'
  | 'ancestorOf'
  | 'descendantOf'
  | 'siblingOf'
  | 'spouseOf'
  | 'lifePartnerOf'
  | 'engagedTo'
  // ahOS-coined — romantic (dating stage; ungendered, specific kind as edge qualifier)
  | 'romanticPartnerOf'
  // RELATIONSHIP — social
  | 'friendOf'
  | 'closeFriendOf'
  | 'acquaintanceOf'
  | 'neighborOf'
  | 'livesWith'
  | 'hasMet'
  | 'knowsOf'
  | 'knowsInPassing'
  | 'knowsByReputation'
  | 'wouldLikeToKnow'
  | 'lostContactWith'
  // RELATIONSHIP — professional
  | 'colleagueOf'
  | 'worksWith'
  | 'collaboratesWith'
  | 'employedBy'
  | 'employerOf'
  | 'mentorOf'
  | 'apprenticeTo'
  | 'influencedBy'
  // RELATIONSHIP — negative / ambivalent
  | 'enemyOf'
  | 'antagonistOf'
  | 'ambivalentOf'
  // FOAF core
  | 'knows'
  | 'member'
  | 'currentProject'
  | 'pastProject'
  | 'made'
  // Place edges (#188) — person -> place and place -> place containment.
  // Not `rdfs:subPropertyOf foaf:knows` (a person doesn't "know" a place):
  // deliberately its own branch, not folded into RELATIONSHIP above.
  | 'livesAt'
  | 'basedNear'
  | 'locatedIn'
  // SKOS concept-hierarchy edges (#195/#232) — e.g. the Areas tree, written by
  // writeAreaHierarchyEdge as an auto-paired inverse (child --broader--> parent,
  // parent --narrower--> child). Not subPropertyOf foaf:knows: a concept-hierarchy
  // edge isn't an interpersonal `knows` edge.
  | 'broader'
  | 'narrower'
  // System-generated (statistical co-occurrence)
  | 'co_occurs_with'
  // Fallback for unmapped/soft values
  | 'other';

/**
 * Open string keeps unknown/soft relationship values valid (ADR-021 soft
 * validation) while `KnownRelationshipType` still drives editor autocomplete.
 * Mirrors the `| string` escape hatch on `DecisionType`.
 */
export type RelationshipType = KnownRelationshipType | (string & {});

/** A directed edge in the entity relationship graph (`entity_relationships`). */
export interface EntityRelationship {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  relationship_type: RelationshipType;
  confidence_score: number | null;
  metadata: Record<string, unknown> | null;
  created_by: string | null;
  notes: string | null;
  created_at: string;
  /** Start of the relationship's validity window. null = unknown/unbounded start. Issue #175. */
  valid_from: string | null;
  /** End of the relationship's validity window. null = still active/unbounded end. Issue #175. */
  valid_to: string | null;
  /** Soft-delete flag; archived edges are excluded from default reads. Issue #175. */
  archived: boolean;
  updated_at: string;
}

/**
 * One traversed entity<->entity edge as returned by the mcp-server
 * `entity_neighbourhood` tool (packages/mcp-server/src/tools/entityNeighbourhood.ts).
 * Mirrors a subset of `EntityRelationship`'s columns under the tool's own
 * `from`/`to`/`confidence` read-time naming (renamed from `from_entity_id` /
 * `to_entity_id` / `confidence_score`). `valid_from`/`valid_to` are surfaced
 * here so callers can render timelines and pass them through an optional
 * `as_of` as-of filter — written since migration 068 (#175) but never read
 * until #315.
 */
export interface NeighbourhoodEdge {
  from: string;
  to: string;
  type: RelationshipType;
  confidence: number | null;
  metadata: Record<string, unknown> | null;
  /** Free-text qualifier or context stored on the relationship edge. */
  notes?: string | null;
  /** Start of the relationship's validity window. null = unknown/unbounded start. Issue #315. */
  valid_from: string | null;
  /** End of the relationship's validity window. null = still active/unbounded end. Issue #315. */
  valid_to: string | null;
}

/**
 * Record of an entity merge operation (#456, #457).
 * Written to `properties._merge` on the tombstoned loser entity.
 */
export interface EntityMergeRecord {
  /** Unique ID of this merge operation */
  op_id: string;
  /** ISO timestamp when the merge executed */
  merged_at: string;
  /** ID of the surviving (winner) entity */
  winner_id: string;
  /** Edge IDs that were repointed from loser to winner */
  moved_edge_ids: string[];
  /** Edge IDs archived due to collisions or self-loops */
  archived_edge_ids: string[];
  /** Alternate titles added to the winner's aliases list */
  aliases_added: string[];
  /** Property keys from the loser carried over to the winner */
  properties_carried: string[];
  /** Property keys from the loser skipped during merge, mapped to the reason */
  properties_skipped?: Record<string, string>;
  /** Artifact link IDs repointed from loser to winner */
  links_moved: string[];
  /**
   * Artifact link IDs dropped (hard-deleted, not repointed) because they
   * collided with an existing winner link on the `artifact_entity_links`
   * `UNIQUE(artifact_id, entity_id, link_type)` key. `artifact_entity_links`
   * has no soft-delete column, so these rows are gone; recorded here so the
   * merge record stays a complete audit trail for #457's unmerge support.
   */
  links_deleted: string[];
  /**
   * Edge id -> pre-merge `relationship_type`, for edges the #170
   * primary-containment rule demoted (e.g. `belongs_to` -> `associated_with`)
   * while repointing. Only present when at least one demotion occurred, so
   * `entity_unmerge` can restore the original type; absent for merges that
   * predate this field, where the demotion is unreversed.
   */
  demoted_edge_types?: Record<string, string>;
}

export interface EntityTypeMap {
  project: ProjectEntity;
  area: AreaEntity;
  resource: ResourceEntity;
  people: PersonEntity;
}

export type EntityRecord<T extends EntityType> = EntityTypeMap[T];

