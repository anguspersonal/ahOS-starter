/**
 * Step 0: Upload
 * 
 * Handles uploading files to Supabase Storage with:
 * - File validation (size, MIME type, filename)
 * - Path generation (userId/timestamp_filename)
 * - Server-side retry logic (3 attempts, exponential backoff)
 * - Workflow step status tracking
 * - User notifications for failures
 * 
 * NOTE: Offline/WiFi handling is CLIENT-SIDE (mobile app).
 * The worker only handles server-side operations.
 * 
 * @see docs/Step00_Upload.md
 * @see docs/Upload_Implementation_Comparison.md
 */

import { supabase } from '../../utils/supabase';
import logger from '../../utils/logger';
import { sanitizeFileName, formatFileSize } from '../../utils/helpers';
import { retryWithBackoff } from '../../utils/retry';
import type {
  WorkflowStep,
  UploadFile,
  UserContext,
  UploadResult,
  FileMetadata,
  ValidationResult,
} from './types';
import type { WorkflowId, StepId } from './types';
import { updateStepStatus } from './stepStatus';

// Constants
const STORAGE_BUCKET = 'user-uploads';
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAYS = [2000, 4000, 8000]; // Exponential backoff: 2s, 4s, 8s

// Allowed MIME types
const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
];

// MIME type prefixes (for flexible matching)
const ALLOWED_MIME_PREFIXES = ['image/', 'video/', 'audio/'];


/**
 * Generate a unique storage path for the file
 * Format: userId/timestamp_sanitizedFilename
 */
export function generateStoragePath(userId: string, fileName: string): string {
  const timestamp = Date.now();
  const sanitized = sanitizeFileName(fileName);
  return `${userId}/${timestamp}_${sanitized}`;
}

/**
 * Validate file before upload
 * Checks: size, MIME type, filename
 */
export function validateFile(file: UploadFile): ValidationResult {
  // Check if file exists
  if (!file) {
    return { valid: false, error: 'No file provided' };
  }

  // Check filename
  if (!file.name || file.name.trim().length === 0) {
    return { valid: false, error: 'Filename is empty' };
  }

  // Check file size
  if (file.size === 0) {
    return { valid: false, error: 'File is empty (0 bytes)' };
  }

  if (file.size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: `File too large. Maximum size is ${formatFileSize(MAX_FILE_SIZE)}. Current size: ${formatFileSize(file.size)}`,
    };
  }

  // Check MIME type
  const mimeType = file.type?.toLowerCase() || '';

  const isAllowedType =
    ALLOWED_MIME_TYPES.includes(mimeType) ||
    ALLOWED_MIME_PREFIXES.some(prefix => mimeType.startsWith(prefix));

  if (!isAllowedType) {
    return {
      valid: false,
      error: `File type not supported: ${mimeType || 'unknown'}. Allowed: images, PDFs, videos, documents`,
    };
  }

  // Check file data
  if (!file.data || file.data.length === 0) {
    return { valid: false, error: 'File data is empty' };
  }

  return { valid: true };
}

/**
 * Create a user notification (system_decision) for upload failure
 */
async function createFailureNotification(
  userContext: UserContext,
  workflowId: WorkflowId,
  stepId: StepId,
  fileName: string,
  errorMessage: string
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('system_decisions')
      .insert({
        user_id: userContext.userId,
        team_id: userContext.teamId || null,
        decision_type: 'upload_failed',
        stage: 'capture',
        title: 'Upload failed',
        description: 'Failed to upload file after 3 attempts. Please retry manually or check your connection.',
        confidence_score: 100,
        blocking: true,
        user_visible: true,
        requires_user_action: true,
        status: 'pending',
        review_type: 'approval',
        decision_payload: {
          workflowId: workflowId.value,
          workflowStepId: stepId.value,
          fileName: fileName,
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

    logger.info('Created upload failure notification', { notificationId: data.id });
    return data.id;
  } catch (err) {
    logger.error('Error creating failure notification', err as Error);
    return null;
  }
}

/**
 * Execute the upload step
 * 
 * This function:
 * 1. Validates the file (size, type, filename)
 * 2. Updates step status to 'running'
 * 3. Attempts upload with retry logic (3 attempts, exponential backoff)
 * 4. On success: Returns objectPath and fileMetadata
 * 5. On failure: Creates user notification and returns error
 */
export async function executeUploadStep(
  step: WorkflowStep,
  file: UploadFile,
  userContext: UserContext,
  workflowId: WorkflowId,
  stepId: StepId
): Promise<UploadResult> {
  const startTime = Date.now();

  logger.info('Starting upload step', {
    stepId: stepId.value,
    fileName: file?.name,
    fileSize: file?.size,
    userId: userContext.userId,
  });

  // 1. VALIDATE FILE
  const validation = validateFile(file);
  if (!validation.valid) {
    logger.warn('File validation failed', { error: validation.error });

    await updateStepStatus(stepId, 'failed', {
      message: `Validation failed: ${validation.error}`,
      error_message: validation.error,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    });

    return {
      success: false,
      error: validation.error,
    };
  }

  // 2. UPDATE STEP STATUS TO RUNNING
  await updateStepStatus(stepId, 'running', {
    started_at: new Date().toISOString(),
    message: `Starting upload for file: ${file.name} (${formatFileSize(file.size)})`,
  });

  // 3. ATTEMPT UPLOAD WITH RETRY LOGIC
  let lastError: Error | null = null;
  let attempt = 0;

  while (attempt < MAX_RETRY_ATTEMPTS) {
    attempt++;

    try {
      logger.info(`Upload attempt ${attempt}/${MAX_RETRY_ATTEMPTS}`, {
        fileName: file.name,
        fileSize: file.size,
      });

      // Generate unique file path
      const filePath = generateStoragePath(userContext.userId, file.name);

      logger.debug('Uploading to path', { filePath, bucket: STORAGE_BUCKET });

      // Upload to Supabase Storage
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(filePath, file.data, {
          cacheControl: '3600',
          upsert: false,
          contentType: file.type,
        });

      if (uploadError) {
        throw new Error(uploadError.message);
      }

      // SUCCESS!
      const objectPath = uploadData.path;
      const storageObjectId = uploadData.id;

      logger.info('Upload successful', {
        objectPath,
        storageObjectId,
        attempt,
        durationMs: Date.now() - startTime,
      });

      // Build file metadata
      const fileMetadata: FileMetadata = {
        size: file.size,
        mimeType: file.type,
        fileName: file.name,
        uploadedAt: new Date().toISOString(),
        objectPath: objectPath,
        storageObjectId: storageObjectId,
      };

      // Update step status to completed
      await updateStepStatus(stepId, 'completed', {
        message: `Upload successful: ${objectPath}`,
        object_storage_path: objectPath,
        output: {
          objectStoragePath: objectPath,
          fileMetadata: fileMetadata,
          storageObjectId: storageObjectId,
        },
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        retry_count: attempt - 1,
      });

      return {
        success: true,
        objectPath: objectPath,
        fileMetadata: fileMetadata,
        storageObjectId: storageObjectId,
      };

    } catch (err) {
      lastError = err as Error;

      logger.warn(`Upload attempt ${attempt} failed`, {
        error: lastError.message,
        fileName: file.name,
      });

      // Update retry count
      await updateStepStatus(stepId, 'running', {
        retry_count: attempt,
        message: `Upload attempt ${attempt} failed: ${lastError.message}. ${attempt < MAX_RETRY_ATTEMPTS ? 'Retrying...' : 'Max retries reached.'}`,
      });

      // If not the last attempt, wait before retrying
      if (attempt < MAX_RETRY_ATTEMPTS) {
        const delay = RETRY_DELAYS[attempt - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
        logger.info(`Retrying in ${delay / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // 4. ALL RETRIES FAILED
  const errorMessage = lastError?.message || 'Unknown error';

  logger.error('Upload failed after all retry attempts', lastError, {
    attempts: MAX_RETRY_ATTEMPTS,
    fileName: file.name,
    durationMs: Date.now() - startTime,
  });

  // Create user notification
  const notificationId = await createFailureNotification(
    userContext,
    workflowId,
    stepId,
    file.name,
    errorMessage
  );

  // Update step status to failed
  await updateStepStatus(stepId, 'failed', {
    message: `Upload failed after ${MAX_RETRY_ATTEMPTS} attempts: ${errorMessage}`,
    error_message: errorMessage,
    notification_id: notificationId,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    retry_count: MAX_RETRY_ATTEMPTS,
  });

  return {
    success: false,
    error: errorMessage,
    notificationId: notificationId || undefined,
  };
}

/**
 * Create a signed URL for file access
 * Use this instead of public URLs for security
 * 
 * @param objectPath - The path to the file in storage
 * @param expiresIn - Expiration time in seconds (default: 1 hour)
 */
export async function createSignedUrl(
  objectPath: string,
  expiresIn: number = 3600
): Promise<{ signedUrl: string | null; error: string | null }> {
  try {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(objectPath, expiresIn);

    if (error) {
      logger.error('Failed to create signed URL', error, { objectPath });
      return { signedUrl: null, error: error.message };
    }

    return { signedUrl: data.signedUrl, error: null };
  } catch (err) {
    const error = err as Error;
    logger.error('Error creating signed URL', error, { objectPath });
    return { signedUrl: null, error: error.message };
  }
}

export default executeUploadStep;

