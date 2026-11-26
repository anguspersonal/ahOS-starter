/**
 * Step 1: Create Artifact
 * 
 * Creates a database record for an uploaded artifact.
 * This step occurs after the file has been successfully uploaded to object storage
 * and before AI analysis begins.
 * 
 * Features:
 * - File type classification (photo, document, text, etc.)
 * - Artifact record creation with metadata
 * - Retry logic for database failures (3 attempts, exponential backoff)
 * - Orphaned file handling (notifications when creation fails)
 * - Links artifact to workflow
 * 
 * @see docs/Step01_CreateArtifact.md
 */

import { supabase } from '../../utils/supabase';
import logger from '../../utils/logger';
import { classifyFileType, FileTypeClassification } from '../../utils/helpers';
import { ARTIFACT_SURFACES, deriveArtifactTitle, type ArtifactSurface } from '@ahkms/shared';
import type {
  WorkflowStep,
  FileMetadata,
  UserContext,
} from './types';
import type { WorkflowId, StepId } from './types';
import { updateStepStatus } from './stepStatus';

// Constants
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAYS = [2000, 4000, 8000]; // Exponential backoff: 2s, 4s, 8s
const STORAGE_BUCKET = 'user-uploads';
/** Minimum bytes for a text capture to be accepted; below this with no content we reject as empty. */
const MIN_CONTENT_BYTES = 100;

/**
 * Build the storage URL for an artifact
 * Uses the Supabase storage URL pattern
 */
function buildStorageUrl(objectPath: string): string {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  // Format: https://{project-ref}.supabase.co/storage/v1/object/public/{bucket}/{path}
  return `${supabaseUrl}/storage/v1/object/public/${STORAGE_BUCKET}/${objectPath}`;
}

/**
 * The `artifacts.surface` an upload gets, from the client platform alone
 * (ADR-026; ADR-046 §2/§3, #584).
 *
 * TOTAL BY CONSTRUCTION — that is the whole point. `source_channel` a few lines
 * below leaves an unrecognised platform as `null`, and `surface` deliberately
 * does not follow it: a null `source_channel` costs a fallback rung in
 * `resolveTrust`, whereas a null `surface` costs the row its only addressable
 * identity, since ADR-046 §3 stores one role PER SURFACE and there is no key to
 * write a map entry against. An unknown platform still reached the store
 * programmatically, so `api` is the honest floor rather than an invented value.
 *
 * Pure and exported so the mapping is pinned by tests rather than exercised
 * only through a full workflow run.
 */
export function resolveUploadSurface(platform: string | null | undefined): ArtifactSurface {
  switch (platform) {
    case 'web':
      return ARTIFACT_SURFACES.webApp;
    case 'ios':
    case 'android':
      return ARTIFACT_SURFACES.mobileApp;
    default:
      return ARTIFACT_SURFACES.api;
  }
}

/**
 * Input parameters for the create artifact step
 */
export interface CreateArtifactInput {
  step: WorkflowStep;
  objectPath: string;
  fileMetadata: FileMetadata;
  userTextContent: string | null | undefined;
  userContext: UserContext;
  workflowId: WorkflowId;
  stepId: StepId;
  captureUrl?: string;
}

/**
 * Result of create artifact step execution
 */
export interface CreateArtifactResult {
  success: boolean;
  artifactId?: string;          // UUID of created artifact (if successful)
  error?: string;               // Error message (if failed)
  notificationId?: string;      // ID of user notification (if failed)
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a user notification (system_decision) for artifact creation failure
 */
async function createFailureNotification(
  userContext: UserContext,
  workflowId: WorkflowId,
  stepId: StepId,
  objectPath: string,
  errorMessage: string
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('system_decisions')
      .insert({
        user_id: userContext.userId,
        team_id: userContext.teamId || null,
        decision_type: 'artifact_creation_failed',
        stage: 'capture',
        title: 'Failed to process file',
        description: `File uploaded but couldn't create record. Reference: ${objectPath}`,
        confidence_score: 100,
        blocking: true,
        user_visible: true,
        requires_user_action: true,
        status: 'pending',
        review_type: 'approval',
        decision_payload: {
          objectPath: objectPath,
          workflowId: workflowId.value,
          workflowStepId: stepId.value,
          error: errorMessage,
          retryAction: 'manual_retry',
        },
        workflow_task_id: stepId.value,
      })
      .select('id')
      .single();

    if (error) {
      logger.error('Failed to create failure notification', error);
      return null;
    }

    logger.info('Created artifact creation failure notification', { notificationId: data.id });
    return data.id;
  } catch (err) {
    logger.error('Error creating failure notification', err as Error);
    return null;
  }
}

/**
 * Create a user notification when an empty capture is rejected (no content, tiny file).
 */
async function createEmptyCaptureRejectedNotification(
  userContext: UserContext,
  workflowId: WorkflowId,
  stepId: StepId,
  fileName: string
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('system_decisions')
      .insert({
        user_id: userContext.userId,
        team_id: userContext.teamId || null,
        decision_type: 'artifact_creation_failed',
        stage: 'capture',
        title: 'Empty capture not saved',
        description: 'This capture had no usable content and was not saved. Add text or content before uploading.',
        confidence_score: 100,
        blocking: false,
        user_visible: true,
        requires_user_action: false,
        status: 'pending',
        review_type: 'approval',
        decision_payload: {
          fileName,
          workflowId: workflowId.value,
          workflowStepId: stepId.value,
          reason: 'empty_capture_rejected',
        },
        workflow_task_id: stepId.value,
      })
      .select('id')
      .single();

    if (error) {
      logger.error('Failed to create empty-capture-rejected notification', error);
      return null;
    }

    logger.info('Created empty capture rejected notification', { notificationId: data.id });
    return data.id;
  } catch (err) {
    logger.error('Error creating empty-capture-rejected notification', { stepId: stepId.value, err });
    return null;
  }
}

/**
 * Link artifact to workflow by updating workflow.source_artifact_id
 */
async function linkArtifactToWorkflow(
  workflowId: WorkflowId,
  artifactId: string
): Promise<void> {
  try {
    const { error } = await supabase
      .from('workflows')
      .update({ source_artifact_id: artifactId })
      .eq('id', workflowId.value);

    if (error) {
      logger.warn('Failed to link artifact to workflow', {
        workflowId: workflowId.value,
        artifactId,
        error: error.message,
      });
      // Don't throw - workflow can continue without link (suboptimal but not fatal)
    } else {
      logger.info('Linked artifact to workflow', { workflowId: workflowId.value, artifactId });
    }
  } catch (err) {
    logger.error('Error linking artifact to workflow', { workflowId: workflowId.value, artifactId, err });
    // Don't throw - workflow can continue without link
  }
}

/**
 * Execute the create artifact step
 * 
 * This function:
 * 1. Updates step status to 'processing'
 * 2. Classifies file type
 * 3. Prepares artifact data
 * 4. Creates artifact record with retry logic (3 attempts, exponential backoff)
 * 5. Links artifact to workflow
 * 6. On failure: Creates user notification and returns error
 */
export async function executeCreateArtifactStep(
  input: CreateArtifactInput
): Promise<CreateArtifactResult> {
  const { step, objectPath, fileMetadata, userTextContent, userContext, workflowId, stepId, captureUrl } = input;
  const startTime = Date.now();

  logger.info('Starting create artifact step', {
    stepId: stepId.value,
    objectPath,
    fileName: fileMetadata.fileName,
    userId: userContext.userId,
  });

  // 1. UPDATE STEP STATUS TO PROCESSING
  await updateStepStatus(stepId, 'running', {
    started_at: new Date().toISOString(),
    message: `Creating artifact record for: ${fileMetadata.fileName}`,
  });

  // 2. CLASSIFY FILE TYPE
  const classification: FileTypeClassification = classifyFileType(
    fileMetadata.mimeType,
    fileMetadata.fileName
  );

  logger.debug('File type classification', {
    fileName: fileMetadata.fileName,
    mimeType: fileMetadata.mimeType,
    classification,
  });

  // 2b. REJECT COMPLETELY EMPTY TEXT CAPTURES (unless this is a URL capture)
  const hasContent = userTextContent != null && String(userTextContent).trim().length > 0;
  const hasCaptureUrl = typeof captureUrl === 'string' && captureUrl.trim().length > 0;
  const size = fileMetadata.size ?? 0;
  if (
    classification.contentType === 'text' &&
    !hasContent &&
    !hasCaptureUrl &&
    size < MIN_CONTENT_BYTES
  ) {
    logger.info('Rejecting empty text capture', {
      fileName: fileMetadata.fileName,
      size,
      minBytes: MIN_CONTENT_BYTES,
    });
    const notificationId = await createEmptyCaptureRejectedNotification(
      userContext,
      workflowId,
      stepId,
      fileMetadata.fileName
    );
    await updateStepStatus(stepId, 'failed', {
      message: 'Empty or no-content capture was not saved',
      error_message: 'Empty capture rejected',
      notification_id: notificationId,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    });
    return {
      success: false,
      error: 'Empty or no-content capture was not saved',
      notificationId: notificationId || undefined,
    };
  }

  // 3. PREPARE ARTIFACT DATA
  const storageUrl = buildStorageUrl(objectPath);
  const now = new Date().toISOString();

  // Get default team ID from environment variable if userContext.teamId is not provided
  // Note: team_id is now UUID (not integer), so we use the string value directly
  const defaultTeamId = process.env.DEFAULT_TEAM_ID || null;

  // Derive a non-null title so search never falls back to "(untitled)" (#131):
  // first line of pasted text, else the filename (extension stripped). Falls
  // back to the raw `fileMetadata.fileName` (required, non-empty on this
  // type) only if both are unavailable — every current caller (orchestrator
  // upload step, URL-capture route) always supplies a real filename, so this
  // is a defensive last resort rather than an expected path. `analyze.ts` may
  // refine the title later once AI analysis runs, but every artifact should
  // have a title from the moment it's created.
  const title =
    deriveArtifactTitle({ text: userTextContent, filename: fileMetadata.fileName }) ??
    fileMetadata.fileName;

  const artifactData: Record<string, unknown> = {
    // id is auto-generated by database (gen_random_uuid())
    user_id: userContext.userId,
    team_id: userContext.teamId || defaultTeamId || null,
    storage_path: objectPath,
    storage_url: storageUrl, // Required by database
    filename: fileMetadata.fileName,
    original_file_name: fileMetadata.fileName, // Preserved at upload; filename updated to semantic name after analysis
    title, // Derived above; never null (#131) — analyze.ts may refine it later
    file_type: fileMetadata.mimeType, // Store original MIME type
    file_size: fileMetadata.size || null, // Fallback to file_metadata.file_size if needed (set below)
    file_extension: classification.fileExtension,
    content_type: fileMetadata.mimeType, // Can be same as file_type or separate
    artifact_type: 'original', // Original uploaded artifacts (distinct from derived_artifacts)
    workflow_run_id: workflowId.value, // Link artifact to workflow execution record
    content: hasCaptureUrl
      ? { url: captureUrl!.trim(), ...(userTextContent && String(userTextContent).trim().length > 0 ? { text: String(userTextContent).trim() } : {}) }
      : userTextContent
        ? { text: userTextContent }
        : null,
    // Single source of truth for editable body: URL or user text so Content section and preview have a value
    plain_text: hasCaptureUrl
      ? captureUrl!.trim()
      : userTextContent != null && String(userTextContent).trim().length > 0
        ? String(userTextContent).trim()
        : null,
    lifecycle_stage: 'uploaded',
    processing_status: 'pending',
    captured_at: fileMetadata.uploadedAt || now, // Required by database - when artifact was captured
    captured_by: userContext.userId, // User ID who captured the artifact
    source: userContext.deviceInfo?.platform === 'web' ? 'web_upload'
      : userContext.deviceInfo?.platform === 'ios' || userContext.deviceInfo?.platform === 'android' ? 'phone_app'
        : userContext.deviceInfo?.platform === 'worker' ? 'api'
          : 'web_upload', // Default fallback
    source_channel: userContext.deviceInfo?.platform === 'web' ? 'web_upload'
      : userContext.deviceInfo?.platform === 'ios' ? 'phone_app'
        : userContext.deviceInfo?.platform === 'android' ? 'phone_app'
          : userContext.deviceInfo?.platform === 'worker' ? 'api'
            : null, // Leave null if platform is unknown
    // Provenance (ADR-026; ADR-046 §2/§3, #584). Same platform signal as the two
    // fields above, but resolved through a TOTAL function — see
    // resolveUploadSurface for why this one may not fall through to null.
    surface: resolveUploadSurface(userContext.deviceInfo?.platform),
    file_metadata: {
      upload_location: userContext.location || null,
      uploaded_at: fileMetadata.uploadedAt,
      file_size: fileMetadata.size,
      mime_type: fileMetadata.mimeType,
      content_type: classification.contentType,
      content_subtype: classification.contentSubtype,
    },
    // Use file_metadata.file_size as fallback if file_size is null
    // (file_metadata is set above, so we can reference it here)
    storage_object_id: fileMetadata.storageObjectId || null,
    processing_metadata: {},
    tags: [],
  };

  // 4. CREATE ARTIFACT WITH RETRY LOGIC
  let lastError: Error | null = null;
  let attempt = 0;

  while (attempt < MAX_RETRY_ATTEMPTS) {
    attempt++;

    try {
      logger.info(`Creating artifact record (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`, {
        objectPath,
        fileName: fileMetadata.fileName,
      });

      // Insert artifact record
      const { data: insertedData, error: insertError } = await supabase
        .from('artifacts')
        .insert(artifactData)
        .select('id')
        .single();

      if (insertError) {
        throw new Error(insertError.message);
      }

      if (!insertedData || !insertedData.id) {
        throw new Error('Artifact created but no ID returned');
      }

      const artifactId = insertedData.id;

      logger.info('Artifact created successfully', {
        artifactId,
        attempt,
        durationMs: Date.now() - startTime,
      });

      // SUCCESS! Link artifact to workflow
      await linkArtifactToWorkflow(workflowId, artifactId);

      // Update step status to completed
      await updateStepStatus(stepId, 'completed', {
        message: 'Artifact created successfully',
        output: { artifactId },
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
      });

      return {
        success: true,
        artifactId,
      };
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));

      logger.warn(`Artifact creation attempt ${attempt}/${MAX_RETRY_ATTEMPTS} failed`, {
        error: lastError.message,
        attempt,
      });

      // Check if it's a validation error (don't retry)
      if (lastError.message.includes('violates') ||
        lastError.message.includes('constraint') ||
        lastError.message.includes('invalid') ||
        lastError.message.includes('required')) {
        logger.error('Validation error - not retrying', { error: lastError.message });
        break;
      }

      // Wait before retry (if not last attempt)
      if (attempt < MAX_RETRY_ATTEMPTS) {
        const delay = RETRY_DELAYS[attempt - 1];
        logger.info(`Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  // 5. ALL RETRIES FAILED - ORPHANED FILE
  logger.error('Artifact creation failed after all retries', {
    objectPath,
    fileName: fileMetadata.fileName,
    lastError: lastError?.message,
  });

  // Create user notification
  const notificationId = await createFailureNotification(
    userContext,
    workflowId,
    stepId,
    objectPath,
    lastError?.message || 'Unknown error'
  );

  // Update step status to failed
  await updateStepStatus(stepId, 'failed', {
    message: `Failed after ${MAX_RETRY_ATTEMPTS} attempts: ${lastError?.message || 'Unknown error'}`,
    error_message: lastError?.message || 'Unknown error',
    notification_id: notificationId,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
  });

  return {
    success: false,
    error: lastError?.message || 'Unknown error',
    notificationId: notificationId || undefined,
  };
}

