/**
 * Test factories
 * Provides factory functions for creating test data with common scenarios
 */

import {
  createMockWorkflow,
  createMockWorkflowStep,
  createMockFile,
  createMockUserContext,
  createMockFileMetadata,
  createMockArtifact,
} from './fixtures';

/**
 * Create a workflow in 'in_progress' status
 */
export function createInProgressWorkflow(overrides: Partial<any> = {}) {
  return createMockWorkflow({
    status: 'in_progress',
    ...overrides,
  });
}

/**
 * Create a completed workflow
 */
export function createCompletedWorkflow(overrides: Partial<any> = {}) {
  return createMockWorkflow({
    status: 'completed',
    completed_at: new Date().toISOString(),
    ...overrides,
  });
}

/**
 * Create a completed workflow step
 */
export function createCompletedStep(stepType: string, stepOrder: number, output: any = {}) {
  return createMockWorkflowStep({
    step_type: stepType,
    step_order: stepOrder,
    status: 'completed',
    output,
    completed_at: new Date().toISOString(),
  });
}

/**
 * Create a failed workflow step
 */
export function createFailedStep(stepType: string, stepOrder: number, errorMessage: string) {
  return createMockWorkflowStep({
    step_type: stepType,
    step_order: stepOrder,
    status: 'failed',
    error_message: errorMessage,
    completed_at: new Date().toISOString(),
  });
}

/**
 * Create a large file (exceeding size limit)
 */
export function createLargeFile() {
  return createMockFile({
    name: 'large-file.jpg',
    size: 60 * 1024 * 1024, // 60MB (exceeds 50MB limit)
    data: Buffer.alloc(60 * 1024 * 1024),
  });
}

/**
 * Create a PDF file
 */
export function createPdfFile() {
  return createMockFile({
    name: 'document.pdf',
    type: 'application/pdf',
    data: Buffer.from('fake-pdf-data'),
  });
}

/**
 * Create an artifact with analysis results
 */
export function createAnalyzedArtifact(analysisResult: any) {
  return createMockArtifact({
    lifecycle_stage: 'analysed',
    metadata: {
      analysis: analysisResult,
    },
  });
}

/**
 * Create an artifact needing review (low confidence)
 */
export function createArtifactNeedingReview(analysisResult: any) {
  return createMockArtifact({
    lifecycle_stage: 'needs_review',
    processing_status: 'pending',
    metadata: {
      analysis: analysisResult,
    },
  });
}

