/**
 * Workflow context and step DB helpers.
 * Single place for workflow/step persistence used by the orchestrator.
 */

import { logger } from '../utils/logger';
import supabase from '../utils/supabase';
import type { WorkflowStep, AnalysisResult } from './steps/types';

export interface WorkflowData {
  id: string;
  user_id: string;
  workflow_type: string;
  status: string;
  source_artifact_id: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Fetch workflow data from database
 */
export async function getWorkflow(workflowId: string): Promise<WorkflowData | null> {
  const { data, error } = await supabase
    .from('workflows')
    .select('*')
    .eq('id', workflowId)
    .single();

  if (error) {
    logger.error('Failed to fetch workflow', error, { workflowId });
    return null;
  }

  return data;
}

/**
 * Update workflow status
 */
export async function updateWorkflowStatus(
  workflowId: string,
  status: string,
  lastMessage?: string,
  additionalFields?: Record<string, unknown>
): Promise<void> {
  const updates: Record<string, unknown> = { status };
  if (lastMessage) updates.last_message = lastMessage;
  if (status === 'completed' || status === 'failed') {
    updates.completed_at = new Date().toISOString();
  }
  if (additionalFields) {
    Object.assign(updates, additionalFields);
  }

  const { error } = await supabase
    .from('workflows')
    .update(updates)
    .eq('id', workflowId);

  if (error) {
    logger.error('Failed to update workflow status', error, { workflowId, status });
  }
}

/**
 * When a workflow fails, persist the error on the artifact so the UI can show it.
 */
export async function setArtifactProcessingFailed(
  artifactId: string | undefined,
  errorMessage: string
): Promise<void> {
  if (!artifactId) return;
  const { error } = await supabase
    .from('artifacts')
    .update({
      processing_status: 'failed',
      processing_error: errorMessage,
    })
    .eq('id', artifactId);
  if (error) {
    logger.warn('[workflowContext] Failed to set artifact processing_error', {
      artifactId,
      error: error.message,
    });
  }
}

/**
 * Get existing workflow step or create a new one
 */
export async function getOrCreateWorkflowStep(
  workflowId: string,
  stepType: string,
  stepName: string,
  stepOrder: number
): Promise<WorkflowStep | null> {
  const { data: existing, error: fetchError } = await supabase
    .from('workflow_steps')
    .select('*')
    .eq('workflow_id', workflowId)
    .eq('step_type', stepType)
    .single();

  if (existing && !fetchError) {
    logger.info(`[workflowContext] Found existing step: ${stepType} (id: ${existing.id}, status: ${existing.status})`);
    return existing;
  }

  const { data, error } = await supabase
    .from('workflow_steps')
    .insert({
      workflow_id: workflowId,
      step_type: stepType,
      step_name: stepName,
      step_order: stepOrder,
      status: 'pending',
      max_retries: 3,
    })
    .select('*')
    .single();

  if (error) {
    logger.error('Failed to create workflow step', error, { workflowId, stepType });
    return null;
  }

  return data;
}

/**
 * Update workflow step status.
 * Errors are logged but not thrown so workflow execution can continue.
 */
export async function updateStepStatus(
  stepId: number,
  status: string,
  message?: string,
  output?: Record<string, unknown>
): Promise<void> {
  const updates: Record<string, unknown> = { status };
  if (message) updates.message = message;
  if (output) updates.output = output;
  if (status === 'completed' || status === 'failed' || status === 'skipped') {
    updates.completed_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from('workflow_steps')
    .update(updates)
    .eq('id', stepId);

  if (error) {
    logger.error('Failed to update step status', error, { stepId, status });
  }
}

/**
 * Type guard to check if an object has analysis result structure
 */
function isAnalysisResultShape(obj: unknown): obj is AnalysisResult {
  if (!obj || typeof obj !== 'object') return false;
  const record = obj as Record<string, unknown>;
  return (
    typeof record.intent === 'string' &&
    Array.isArray(record.entities_mentioned) &&
    Array.isArray(record.actions_suggested) &&
    Array.isArray(record.topics) &&
    typeof record.sentiment === 'string' &&
    typeof record.confidence === 'number'
  );
}

/**
 * Normalize analyze step output to AnalysisResult.
 * Handles both top-level analysis fields and nested { analysisResult } shape.
 */
export function getAnalysisResultFromStepOutput(output: unknown): AnalysisResult | null {
  if (!output || typeof output !== 'object') return null;
  const obj = output as Record<string, unknown>;
  if (obj.analysisResult && typeof obj.analysisResult === 'object') {
    const analysisResult = obj.analysisResult;
    if (isAnalysisResultShape(analysisResult)) return analysisResult;
  }
  if (isAnalysisResultShape(obj)) return obj;
  return null;
}

/**
 * Get artifact ID for a workflow: current value, create_artifact step output, or workflow.source_artifact_id.
 */
export async function getArtifactIdForWorkflow(
  workflowId: string,
  workflow: WorkflowData,
  currentArtifactId?: string
): Promise<string | undefined> {
  if (currentArtifactId) return currentArtifactId;
  const createStep = await getOrCreateWorkflowStep(workflowId, 'create_artifact', 'Create Artifact Record', 1);
  if (createStep?.output && typeof createStep.output === 'object') {
    const out = createStep.output as Record<string, unknown>;
    const id = out.artifactId;
    if (typeof id === 'string') return id;
  }
  return workflow.source_artifact_id ?? undefined;
}

/**
 * Get analysis result for a workflow by loading the analyze step output.
 */
export async function getAnalysisResultForWorkflow(workflowId: string): Promise<AnalysisResult | null> {
  const analyzeStep = await getOrCreateWorkflowStep(workflowId, 'analyze', 'AI Content Analysis', 2);
  if (!analyzeStep?.output) return null;
  return getAnalysisResultFromStepOutput(analyzeStep.output);
}
