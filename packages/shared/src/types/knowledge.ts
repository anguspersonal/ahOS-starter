/**
 * Type definitions for the Knowledge Management System
 * Shared across all packages
 */

export type LifecycleStage =
  | 'uploaded'
  | 'upload_failed'
  | 'processing'
  | 'analysed'
  | 'analysis_failed'
  | 'needs_review'
  | 'entities_extracted'
  | 'actions_extracted'
  | 'artifacts_created'
  | 'complete'
  | 'blocked'
  // Written by both the worker's capture pipeline (an analysis/extraction step threw)
  // and the mcp-server Discover & Index pipeline's enrichNext.ts (fetching/extracting a
  // discovered pointer's content threw) -- see DISCOVER_INDEX_STAGES's FAILED_STAGE in
  // packages/mcp-server/src/vocab.ts. One shared terminal-error value for both write
  // paths; already permitted by the DB CHECK (migration 033).
  | 'failed'
  | 'archived'
  // Discover & Index enrichment (ADR-016 Slice 2, #52): a discovered pointer whose
  // content has been pulled in and had its text extracted, but which has NOT been
  // classified/analysed. Distinct from 'analysed' (which implies classification we
  // don't run during enrichment). Already permitted by the DB CHECK (migrations 033/048).
  | 'extracted'
  // Discover & Index registration (ADR-016 Slice 1, #52): a lightweight pointer
  // registered by the `discover` mcp-server tool -- title/link known, no content
  // pulled in yet. Permitted by the DB CHECK since migration 048. Added here (#586):
  // this type had drifted from the mcp-server write sites (discover.ts, enrichNext.ts,
  // search.ts) that have written/read this value since #52 shipped -- see
  // DISCOVER_INDEX_STAGES's DISCOVERED_STAGE in packages/mcp-server/src/vocab.ts,
  // whose compile-time guard now keeps this union honest going forward.
  | 'discovered';

export type ProcessingStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type ArtifactType = 'original' | 'split_page' | 'ocr_text' | 'thumbnail' | 'extracted_text' | 'other';
export type PDFType = 'text' | 'images' | 'unknown';

export interface Artifact {
  id: string;
  storage_bucket: string;
  storage_path: string;
  file_type: string | null;
  file_size: number | null;
  lifecycle_stage: LifecycleStage;
  processing_status: ProcessingStatus;
  has_derived_artifacts: boolean;
  processing_completed_at?: string | null;
  processing_error?: string | null;
  user_id: string | null; // UUID from auth.users
  created_at: string;
  updated_at?: string | null;
  // Additional fields that may exist in database
  storage_url?: string | null;
  /** Semantic internal name (e.g. ai-agents-proposal_Work_Mar2026.pdf); set after analysis. */
  filename?: string | null;
  /** Exact upload filename; preserved and never overwritten. */
  original_file_name?: string | null;
  artifact_type?: string | null;
  captured_at?: string | null;
  captured_by?: string | null;
  source?: string | null;
  processed?: boolean | null;
  workflow_run_id?: string | null;
  archived?: boolean | null;
  archived_at?: string | null;
  archived_reason?: string | null;
  version?: number | null;
  previous_version_id?: string | null;
  storage_object_id?: string | null;
  derived_artifacts_location?: string | null;
  content?: Record<string, unknown> | null;
  content_html?: string | null;
  /** Canonical editable body; single source of truth for artifact content. Display and edit this; derive content_html from it when needed. */
  plain_text?: string | null;
  tags?: string[] | null;
  /** Deprecated in favor of plain_text for editable body; may still be set by extraction for backward compatibility. */
  extracted_content?: string | null;
  extraction_confidence?: number | null;
  title?: string | null;
  description?: string | null;
  file_metadata?: Record<string, unknown> | null;
  processing_metadata?: Record<string, unknown> | null;
  // Link metadata (when artifact is linked to an entity)
  link_type?: 'primary' | 'mentioned' | 'related' | null;
  confidence_score?: number | null;
}

/**
 * Fields the artifacts list view (`app/artifacts/page.tsx`) actually renders.
 *
 * `public.artifacts` also carries `embedding` (`vector(1536)`) and
 * `search_vector` (`tsvector`) — neither is on {@link Artifact} because
 * nothing reads them client-side, but the full row still costs several KB of
 * JSON per record over the wire. `fetchArtifacts` selects exactly this column
 * set (#609); this `Pick` is the compiler-enforced boundary that keeps the
 * query and the view in sync — add a field here (and to the `select()` list)
 * only when a list-view component actually needs it.
 *
 * Deliberately excludes `plain_text` (QA round 1 M1 on #765): it's the
 * largest remaining column and its only consumer was an in-browser substring
 * filter, not anything rendered — see the comment on the search filter in
 * `app/artifacts/page.tsx`. Body-text search belongs server-side (#600,
 * `searchArtifacts` over `search_vector`), not as a client-side scan of every
 * fetched row's full extracted text.
 */
export type ArtifactListItem = Pick<
  Artifact,
  | 'id'
  | 'title'
  | 'filename'
  | 'original_file_name'
  | 'storage_path'
  | 'storage_url'
  | 'file_type'
  | 'lifecycle_stage'
  | 'description'
  | 'created_at'
>;

/**
 * Fields the Inbox views (`InboxSnippet`, `InboxArtifactRow`) actually render.
 * Backs `fetchInboxArtifacts`'s two direct `artifacts` queries (#775, follow-up
 * to #609/#765) — the 'needs_review' and 'recently_captured' filters go
 * through DB RPCs (`get_artifacts_needing_attention` / `get_artifacts_by_stage`)
 * that return full rows server-side; narrowing those needs a migration and is
 * tracked separately.
 *
 * Deliberately excludes `plain_text`, same trade-off as {@link ArtifactListItem}
 * (#765 QA round 1 M1): `getDisplayTitle`'s "first line of plain_text" fallback
 * still compiles against this type (the param is `Pick<..., 'plain_text'>` with
 * an optional field) but simply never fires for inbox items — they fall back to
 * the raw filename/UUID-derived name instead, same as the artifacts list page.
 */
export type ArtifactInboxItem = Pick<
  Artifact,
  | 'id'
  | 'title'
  | 'filename'
  | 'original_file_name'
  | 'storage_path'
  | 'storage_url'
  | 'file_type'
  | 'lifecycle_stage'
>;

/**
 * {@link ArtifactInboxItem} plus the two date columns `fetchInboxArtifacts`'s
 * `'recently_captured'` filter needs (#783, narrowing `get_artifacts_by_stage`
 * off `RETURNS SETOF public.artifacts`). That filter calls the RPC once per
 * stage ('uploaded', 'processing') — each call independently limited and
 * ordered by `created_at DESC` server-side — then merges the two result sets
 * and re-sorts by `captured_at ?? created_at` before slicing to the overall
 * limit; that merge needs a date to stay correct, so unlike
 * `get_artifacts_needing_attention` (whose single ordered result the client
 * trusts and never re-sorts) this RPC's narrow shape keeps both date columns.
 */
export type ArtifactInboxStageItem = ArtifactInboxItem &
  Pick<Artifact, 'captured_at' | 'created_at'>;

/**
 * Fields the project/entity detail pages render per linked artifact
 * (`app/projects/[id]/page.tsx`, `app/entity/[id]/page.tsx`) — filename/title,
 * file type, lifecycle badge, and captured date. Backs `fetchProjectById` and
 * `fetchEntityById` (#775): both used to `select('*')` on every artifact
 * linked to the project/entity, shipping the embedding vector and tsvector
 * for a list that only ever renders these six columns.
 */
export type LinkedArtifactSummary = Pick<
  Artifact,
  'id' | 'title' | 'filename' | 'file_type' | 'lifecycle_stage' | 'created_at'
>;

/**
 * A {@link LinkedArtifactSummary} plus the artifact-entity link metadata
 * `fetchEntityById` attaches from `artifact_entity_links` (not columns of
 * `public.artifacts` itself). `fetchProjectById`'s `linked_artifacts` never
 * populates these — see {@link ProjectWithRelations}.
 */
export type EntityLinkedArtifact = LinkedArtifactSummary &
  Pick<Artifact, 'link_type' | 'confidence_score'>;

export interface DerivedArtifact {
  id: string;
  source_artifact_id: string;
  artifact_type: ArtifactType;
  storage_bucket: string;
  storage_path: string;
  page_number?: number | null;
  workflow_run_id?: string | null;
  processing_metadata?: Record<string, unknown> | null;
  user_id?: string | null; // UUID from auth.users
  created_at: string;
}

export interface WorkflowRun {
  id: string;
  source_artifact_id: string;
  workflow_name?: string | null;
  status: string;
  metadata?: Record<string, unknown> | null;
  user_id?: string | null; // UUID from auth.users
  created_at: string;
  completed_at?: string | null;
}

// System Decision types
export type DecisionType = 
  | 'entity_created'
  | 'artifact_linked'
  | 'task_created'
  | 'event_created'
  | 'text_extracted'
  | 'ocr_performed'
  | 'relationship_suggested'
  | 'duplicate_detected'
  // Identity resolution (#174): a candidate pair of duplicate entities surfaced
  // for user-confirmed merge. On approve, edges/links repoint loser->winner and
  // the loser is tombstoned. Mirrors the `relationship_suggested` decision family.
  | 'merge_suggested'
  | 'metadata_enriched'
  | 'classification_applied'
  | 'security_assigned'
  | 'automation_executed'
  | 'quality_check_flagged'
  | string; // Allow custom types

export type ProcessingStage = 
  | 'capture'
  | 'organize'
  | 'pre_process'
  | 'extract'
  | 'contextualize'
  | 'act'
  | 'refine'
  | 'automate';

export type ReviewType = 
  | 'approval'
  | 'clarification'
  | 'suggestion'
  | 'quality_check';

export type DecisionStatus = 
  | 'pending'
  | 'auto_applied'
  | 'approved'
  | 'rejected'
  | 'modified'
  | 'snoozed'
  | 'expired'
  | 'dismissed';

export interface SystemDecision {
  // Core identification
  id: string;
  decision_type: DecisionType;
  stage: ProcessingStage;
  title: string;
  description?: string | null;
  
  // Confidence & behavior
  confidence_score?: number | null; // 0-100
  blocking: boolean;
  user_visible: boolean;
  requires_user_action: boolean;
  review_type?: ReviewType | null;
  
  // Status & resolution
  status: DecisionStatus;
  resolved_at?: string | null;
  resolved_by?: string | null; // UUID
  resolution_notes?: string | null;
  
  // Snoozing
  snoozed_until?: string | null;
  snooze_count: number;
  
  // Relationships
  artifact_id?: string | null;
  workflow_task_id?: number | null;
  target_entity_type?: string | null;
  target_entity_id?: string | null;
  
  // Decision-specific data
  decision_payload: Record<string, unknown>;
  
  // Audit & ownership
  created_at: string;
  updated_at: string;
  user_id: string; // UUID
  team_id?: number | null;
}

/**
 * @deprecated Use SystemDecision instead. This interface is kept for backward compatibility.
 */
export interface Recommendation {
  id: string;
  artifact_id?: string | null; // Maps to entity_id when entity_type is 'artifact'
  recommendation_type: string;
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high';
  status: 'pending' | 'accepted' | 'rejected' | 'dismissed';
  metadata?: Record<string, unknown> | null;
  user_id?: string | null; // UUID from auth.users
  created_at: string;
  updated_at: string;
  // Additional fields that may exist in database
  entity_type?: string | null;
  entity_id?: string | null;
  issue_description?: string | null;
  suggested_action?: string | null;
  detected_at?: string | null;
  context?: Record<string, unknown> | null;
}

export interface ProcessingResult {
  type: PDFType;
  page_count?: number;
  text?: string;
  images?: Array<{
    page_number: number;
    data: string; // base64 encoded image
  }>;
}

export interface CreateSystemDecisionPayload {
  // Core classification
  decision_type: DecisionType;
  stage: ProcessingStage;
  title: string;
  description?: string;
  
  // Confidence & behavior
  confidence_score?: number; // 0-100
  blocking?: boolean;
  user_visible?: boolean;
  requires_user_action?: boolean;
  review_type?: ReviewType;
  
  // Relationships
  artifact_id?: string;
  workflow_task_id?: number;
  target_entity_type?: string;
  target_entity_id?: string;
  
  // Decision-specific data
  decision_payload?: Record<string, unknown>;
  
  // User/team (usually inferred)
  user_id?: string;
  team_id?: number;
}

/**
 * @deprecated Use CreateSystemDecisionPayload instead. This interface is kept for backward compatibility.
 */
export interface CreateRecommendationPayload {
  recommendation_type: string;
  entity_type: string;
  entity_id: string;
  issue_description: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  suggested_action: string;
  context?: Record<string, unknown>;
}

export interface ResolveDecisionPayload {
  decision_id: string;
  action: 'approve' | 'reject' | 'modify' | 'dismiss' | 'snooze';
  resolution_notes?: string;
  snooze_until?: string; // ISO timestamp
  /** For clarification_needed: required when action is approve/modify */
  clarification_text?: string;
  /** For entity_disambiguation: required when action is approve/modify */
  selected_entity_id?: string;
}

// User Tasks
export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface UserTask {
  id: string;
  title: string;
  description?: string | null;
  status: TaskStatus;
  priority?: TaskPriority | null;
  
  // Timing
  due_date?: string | null;
  completed_at?: string | null;
  
  // Relationships
  source_artifact_id?: string | null;
  entity_id?: string | null;
  assigned_to?: string | null;
  created_by?: string | null;
  
  // Auto-creation metadata
  confidence_score?: number | null;
  created_via?: 'system' | 'manual' | 'api' | null;
  
  // Standard fields
  created_at: string;
  updated_at: string;
  user_id: string;
  team_id?: number | null;
}

// Events (using EventItem to avoid conflict with native Event)
export type EventType = 'meeting' | 'deadline' | 'reminder' | 'other';

export interface EventItem {
  id: string;
  title: string;
  description?: string | null;
  event_type?: EventType | null;
  
  // Timing
  start_time: string;
  end_time?: string | null;
  all_day?: boolean;
  timezone?: string;
  
  // Relationships
  source_artifact_id?: string | null;
  entity_id?: string | null;
  
  // Attendees (array of entity IDs for People entities)
  attendees?: string[] | null;
  
  // Standard fields
  created_by?: string | null;
  created_at: string;
  updated_at: string;
  user_id: string;
  team_id?: number | null;
}

// User Preferences
export type UserMode = 'casual' | 'power';
export type AutomationLevel = 'manual' | 'balanced' | 'aggressive';

export interface DecisionFamilyThresholds {
  entity_creation?: number;
  artifact_linking?: number;
  task_creation?: number;
  relationship_suggestion?: number;
  metadata_enrichment?: number;
}

/**
 * Per-condition switch + threshold for the exception-only alert evaluator
 * (issue #573). Both live in the DB per ADR-030 so they are editable at runtime
 * (via `update_user_preferences`) without a deploy.
 */
export interface AlertConditionConfig {
  /** Whether this condition is evaluated at all. */
  enabled?: boolean;
  /** Days of silence at (or above) which the condition is breached. */
  threshold_days?: number;
}

/**
 * `source_silent` additionally needs to know *which* ingestion surfaces to
 * watch. An explicit `sources` list is authoritative; an empty list means
 * "discover the surfaces that are actually producing artifacts" (see
 * `discovery_window_days` / `min_observations`).
 */
export interface SourceSilentConditionConfig extends AlertConditionConfig {
  /** `artifacts.surface` values to watch. Empty = auto-discover. */
  sources?: string[];
  /** Lookback window used when auto-discovering active surfaces. */
  discovery_window_days?: number;
  /** Minimum artifacts a surface must have in the window to count as a live pipe. */
  min_observations?: number;
}

/**
 * Exception-only alerting config (issue #573).
 *
 * Deliberately NOT `daily_summary`: this is not a digest. `daily_summary` is a
 * bare boolean that names a periodic email — the form rejected in #493 Q3 —
 * and nothing has ever acted on it. A message that arrives every day decays
 * into wallpaper; these alerts fire on a *threshold crossing* and are expected
 * to arrive a couple of times a year.
 */
export interface ExceptionAlertsConfig {
  /** Master switch for this user's exception alerts. */
  enabled?: boolean;
  /** The synthesis ritual has not run for N days. */
  ritual_silent?: AlertConditionConfig;
  /** An ingestion surface has produced nothing for N days. */
  source_silent?: SourceSilentConditionConfig;
}

export interface NotificationPreferences {
  review_items?: boolean;
  blocking_decisions?: boolean;
  /**
   * Legacy, unimplemented. Present in the column default since migration
   * `20251226182232` and read/written by `get_user_preferences` /
   * `update_user_preferences`, but no code has ever acted on it. Kept so
   * existing rows keep round-tripping; see `exception_alerts` for the key that
   * actually drives outbound email (#573).
   */
  daily_summary?: boolean;
  task_reminders?: boolean;
  event_reminders?: boolean;
  exception_alerts?: ExceptionAlertsConfig;
}

export interface CapturePreferences {
  create_derived_artifacts?: boolean;
}

export interface UserPreferences {
  id: string;
  user_id: string;
  
  // User mode
  user_mode?: UserMode;
  
  // Automation settings
  automation_level?: AutomationLevel;
  confidence_threshold?: number; // 0-100
  decision_family_thresholds?: DecisionFamilyThresholds | null;
  
  // Notification preferences
  notification_preferences?: NotificationPreferences | null;
  
  // Capture preferences
  capture_preferences?: CapturePreferences | null;
  
  // Display preferences
  show_lifecycle_details?: boolean;
  include_secure_in_search?: boolean;
  
  // Onboarding
  has_completed_onboarding?: boolean;
  
  // Standard fields
  created_at: string;
  updated_at: string;
}

// Extended project type with relations for detail view
export interface ProjectWithRelations {
  id: string;
  title: string;
  description: string | null;
  status: string | null;
  due_date: string | null;
  priority: string | null;
  completion_percentage: number | null;
  milestones: unknown;
  tags: string[] | null;
  archived: boolean;
  archived_at: string | null;
  properties: Record<string, unknown> | null;
  user_id: string;
  team_id: number | null;
  created_at: string;
  updated_at: string;
  linked_artifacts: LinkedArtifactSummary[];
  linked_tasks: UserTask[];
  linked_events: EventItem[];
}

// Generic entity type with relations for detail view. Backs fetchEntityById,
// which queries `entities` directly with NO entity_type filter (its own
// comment: "without entity_type filter to support all types") -- so this is
// the entity DETAIL page's shape for ANY entity a user can navigate to,
// including the graph-only types (event/organization/signal/place) that have
// no dedicated CRUD view. Use GraphEntityType, not EntityType, or rendering
// code keyed on this field silently mishandles those types (see #188).
import type { BaseEntity, GraphEntityType } from './entities';

export interface EntityWithRelations extends BaseEntity {
  entity_type: GraphEntityType;
  linked_artifacts: EntityLinkedArtifact[];
  linked_tasks: UserTask[];
  linked_events: EventItem[];
}

// Global Search types
export type SearchResultType = 'artifact' | 'entity' | 'task' | 'event';

export interface SearchResult {
  id: string;
  type: SearchResultType;
  title: string;
  snippet: string;
  metadata: {
    location?: string; // PARAMPS location for entities
    updated_at: string;
    icon: string; // Icon name for UI rendering
  };
}

export interface GlobalSearchResults {
  artifacts: SearchResult[];
  entities: SearchResult[];
  tasks: SearchResult[];
  events: SearchResult[];
  total: number;
}

