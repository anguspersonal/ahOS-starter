/**
 * Type definitions for workflow steps
 */

import type { EntityListColumn, SystemDecision } from '@ahkms/shared';

/**
 * Workflow step record from workflow_steps table
 */
export interface WorkflowStep {
  id: number;
  workflow_id: string;
  step_type: string;
  step_name: string;
  step_order: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  object_storage_path: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  message: string | null;
  error_message: string | null;
  retry_count: number;
  max_retries: number;
  system_job_id: string | null;
  notification_id: string | null;
  logs: Record<string, unknown>[] | null;
  created_at: string;
}

/**
 * File object for upload
 */
export interface UploadFile {
  name: string;
  size: number;
  type: string;           // MIME type
  data: Buffer;           // File binary data
}

/**
 * User context for workflow operations
 */
export interface UserContext {
  userId: string;         // UUID of the user
  teamId?: number;        // Optional team ID
  location?: {            // Device GPS location (optional)
    lat: number;
    lng: number;
    accuracy: number;
  };
  deviceInfo?: {          // Device metadata (optional)
    platform: 'ios' | 'android' | 'web' | 'worker';
    version: string;
  };
  uploadTime: Date;       // When upload was initiated
}

/**
 * File metadata returned after successful upload
 */
export interface FileMetadata {
  size: number;
  mimeType: string;
  fileName: string;
  uploadedAt: string;
  objectPath: string;
  storageObjectId?: string;
}

/**
 * Result of upload step execution
 */
export interface UploadResult {
  success: boolean;
  objectPath?: string;
  fileMetadata?: FileMetadata;
  error?: string;
  notificationId?: string;
  storageObjectId?: string;
}

/**
 * Result of file validation
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * System decision (notification) record
 * 
 * Note: This type is imported from @ahkms/shared to maintain a single source of truth.
 * The shared type includes additional optional fields (resolved_at, snoozed_until, etc.)
 * that are not set during initial creation but may be present when reading from the database.
 * 
 * The database schema allows description to be nullable, and the shared type reflects this.
 * Worker code should handle optional description when reading from the database.
 */
// Re-export for convenience
export type { SystemDecision };

/**
 * Analysis result from AI
 */
export interface AnalysisResult {
  intent: string;                    // "meeting_notes", "personal_reflection", "idea", "reminder", "reference", "task", "document", "unclear"
  entities_mentioned: Array<{
    name: string;
    type: string;                     // "people", "area", "project", "resource"
    confidence: number;                // 0-1
  }>;
  actions_suggested: Array<{
    title: string;
    description?: string;
    priority?: string;                // "low", "medium", "high", "urgent"
    dueDate?: string;                 // "YYYY-MM-DD"
    suggestedDuration?: number;       // minutes
  }>;
  topics: string[];                   // Main themes/keywords
  sentiment: string;                  // "positive", "neutral", "negative", "mixed"
  confidence: number;                 // Overall confidence 0-1
  shouldClean?: boolean;              // For documents/notes, should a cleaned version be created?
}

/**
 * Result of analyze step execution
 */
export interface AnalyzeResult {
  success: boolean;
  status?: string;                    // "awaiting_user" if low confidence
  analysisResult?: AnalysisResult;     // Structured analysis from AI
  tokensUsed?: number;                // Anthropic API tokens consumed
  confidence?: number;                 // Overall confidence (0-1)
  notificationId?: string;             // ID of clarification request (if low confidence)
  error?: string;                      // Error message (if failed)
  errorDetails?: string;               // Detailed error info
}

/**
 * Entity record from entities table
 * 
 * Note: This is a workflow-specific entity type, simpler than BaseEntity in @ahkms/shared.
 * This type is used for workflow execution context (matching, scoring, linking).
 * For domain operations, use BaseEntity from @ahkms/shared.
 */
export interface Entity {
  id: string;
  user_id: string;
  team_id?: number | null;
  entity_type: string;
  title: string;
  description?: string | null;
  properties: Record<string, unknown>;
  tags: string[];
  archived: boolean;
  archived_at?: string | null;
  aliases?: string[];
  hot?: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Errors — naming the offender — if an {@link Entity} field is not among the
 * columns the worker's entity reads actually select (#550).
 *
 * Both worker readers of `public.entities` — `findEntityCandidates` /
 * `resolveContainmentParent` in `steps/organizeEntities.ts` and the merge
 * winner/loser pair in `../resume.ts` — went from `select('*')` to
 * `select(ENTITY_LIST_COLUMNS.join(', '))` so migration 095's `search_vector`
 * and 1536-float `embedding` stop riding along on candidate lookups that can
 * return many rows. An explicit list can silently under-select, so this pins
 * the two together: add a field here and the build fails until
 * `ENTITY_LIST_COLUMNS` (packages/shared/src/constants/entityColumns.ts)
 * selects it. The mirror-image guard for `BaseEntity` lives in that file.
 */
type UnselectedEntityField = Exclude<keyof Entity, EntityListColumn>;
const _allEntityFieldsSelected: UnselectedEntityField extends never
  ? true
  : UnselectedEntityField = true;

/**
 * Scored candidate entity with confidence breakdown
 */
export interface ScoredCandidate {
  entity: Entity;
  confidence: number;
  breakdown: {
    nameSimilarity: number;
    recencyScore: number;
    cooccurrenceScore: number;
    contextScore: number;
  };
}

/**
 * Result of organize entities step execution
 */
export interface OrganizeResult {
  success: boolean;
  status?: string;                      // "awaiting_user" if disambiguation needed
  entitiesLinked: Entity[];            // Entities successfully linked
  entitiesCreated: Entity[];           // New entities created
  notificationsCreated: SystemDecision[]; // User notifications
  error?: string;                      // Error message (if failed)
}

/**
 * Result of extract actions step execution
 */
export interface ExtractActionsResult {
  success: boolean;
  tasksCreated: Array<{
    id: string;
    title: string;
    dueDate?: string | null;
    priority: string;
  }>;
  tokensUsed?: number;
  error?: string;
}

/** Re-export workflow ID value objects (single place for step/caller imports) */
export { WorkflowId, ArtifactId, StepId } from '../ids';
