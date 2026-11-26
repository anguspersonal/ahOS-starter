/**
 * Test fixtures
 * Provides factory functions for creating mock data
 */

import type {
  WorkflowStep,
  UploadFile,
  UserContext,
  FileMetadata,
} from '../../src/workflows/steps/types';

/** Valid UUID used for workflow IDs in tests (WorkflowId value object requires UUID format). */
export const TEST_WORKFLOW_ID = '550e8400-e29b-41d4-a716-446655440000';
/** Valid UUID for "not found" flows (valid format but not in mock DB). */
export const NON_EXISTENT_WORKFLOW_ID = '00000000-0000-4000-a000-000000000001';
/** Valid UUID for artifact IDs in tests (ArtifactId value object requires UUID format). */
export const TEST_ARTIFACT_ID = '550e8400-e29b-41d4-a716-446655440001';
/** Second valid UUID for artifact (e.g. fallback source_artifact_id tests). */
export const TEST_ARTIFACT_ID_2 = '550e8400-e29b-41d4-a716-446655440002';
/** Second/third workflow UUIDs for multi-workflow tests (e.g. load, isolation). */
export const TEST_WORKFLOW_ID_2 = '550e8400-e29b-41d4-a716-446655440010';
export const TEST_WORKFLOW_ID_3 = '550e8400-e29b-41d4-a716-446655440011';
/** 20 valid workflow UUIDs for load tests (orchestrator requires UUID format). */
export const LOAD_TEST_WORKFLOW_IDS = Array.from({ length: 20 }, (_, i) =>
  `550e8400-e29b-41d4-a716-44665544${(1000 + i).toString().padStart(4, '0')}`
);

/**
 * Create a mock workflow object
 */
export function createMockWorkflow(overrides: Partial<any> = {}): any {
  return {
    id: TEST_WORKFLOW_ID,
    user_id: 'user-123',
    workflow_type: 'upload',
    status: 'pending',
    source_artifact_id: null,
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create a mock workflow step object
 */
export function createMockWorkflowStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: 1,
    workflow_id: TEST_WORKFLOW_ID,
    step_type: 'upload',
    step_name: 'Upload File to Storage',
    step_order: 0,
    status: 'pending',
    input: null,
    output: null,
    object_storage_path: null,
    started_at: null,
    completed_at: null,
    duration_ms: null,
    message: null,
    error_message: null,
    retry_count: 0,
    max_retries: 3,
    system_job_id: null,
    notification_id: null,
    logs: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create a mock file object
 */
export function createMockFile(overrides: Partial<UploadFile> = {}): UploadFile {
  return {
    name: 'test.jpg',
    size: 1024,
    type: 'image/jpeg',
    data: Buffer.from('fake-image-data'),
    ...overrides,
  };
}

/**
 * Create a mock user context object
 */
export function createMockUserContext(overrides: Partial<UserContext> = {}): UserContext {
  return {
    userId: 'user-123',
    teamId: 1,
    uploadTime: new Date(),
    ...overrides,
  };
}

/**
 * Create a mock file metadata object
 */
export function createMockFileMetadata(overrides: Partial<FileMetadata> = {}): FileMetadata {
  return {
    size: 1024,
    mimeType: 'image/jpeg',
    fileName: 'test.jpg',
    uploadedAt: new Date().toISOString(),
    objectPath: 'user-123/1234567890_test.jpg',
    ...overrides,
  };
}

/**
 * Create a mock artifact object
 */
export function createMockArtifact(overrides: Partial<any> = {}): any {
  return {
    id: 'artifact-123',
    user_id: 'user-123',
    team_id: 1,
    storage_path: 'user-123/1234567890_test.jpg',
    filename: 'test.jpg',
    file_type: 'image/jpeg',
    file_extension: 'jpg',
    content_type: 'image/jpeg',
    content: null,
    user_content: null,
    extracted_text: null,
    lifecycle_stage: 'uploaded',
    processing_status: 'pending',
    file_metadata: {
      upload_location: null,
      uploaded_at: new Date().toISOString(),
      file_size: 1024,
      mime_type: 'image/jpeg',
      content_type: 'binary',
      content_subtype: 'photo',
    },
    processing_metadata: {},
    metadata: {},
    tags: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

