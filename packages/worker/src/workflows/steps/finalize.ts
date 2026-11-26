/**
 * Step 7: Finalize
 * 
 * Final step in every workflow execution. Responsible for gathering workflow results,
 * creating a user-friendly summary notification, updating artifact and workflow statuses
 * to "complete", and ensuring proper workflow completion.
 * 
 * Features:
 * - Validates that no blocking pending decisions exist before finalizing
 * - Gathers all workflow steps and counts outcomes (entities created/linked, tasks created, derived artifacts)
 * - Builds user-friendly summary messages with artifact descriptions and outcome counts
 * - Creates non-blocking completion notifications in the system_decisions table
 * - Updates artifact lifecycle stage to "complete" and processing status to "completed"
 * - Updates workflow status to "completed" with completion timestamp
 * - Handles edge cases gracefully (zero outcomes, missing data, all steps skipped)
 * - Fatal execution model (if finalize fails, entire workflow fails)
 * 
 * @see docs/finalize-step/requirements.md
 * @see docs/finalize-step/design.md
 */

import { supabase } from '../../utils/supabase';
import logger from '../../utils/logger';
import type { WorkflowStep } from './types';
import type { WorkflowId, StepId } from './types';
import { updateStepStatus } from './stepStatus';
import type { Artifact } from '@ahkms/shared';

/**
 * Result of finalize step execution
 */
export interface FinalizeResult {
  success: boolean;
  notificationId?: string;  // UUID of system_decisions record
  summary?: string;        // Human-readable summary message
  error?: string;          // Error message (if failed)
}

/**
 * Check if workflow has any blocking pending decisions
 * 
 * Uses an efficient JOIN-like approach: fetches all workflow step IDs,
 * then queries system_decisions for all steps at once.
 * 
 * @param workflowId - The UUID of the workflow to check
 * @returns Promise resolving to true if blocking decisions exist, false otherwise
 */
async function checkBlockingDecisions(workflowId: string): Promise<boolean> {
  try {
    // First, get all step IDs for this workflow
    const { data: steps, error: stepsError } = await supabase
      .from('workflow_steps')
      .select('id')
      .eq('workflow_id', workflowId);

    if (stepsError) {
      logger.error('Failed to query workflow_steps when checking blocking decisions', {
        workflowId,
        error: stepsError,
      });
      // If we can't tell, err on the side of caution and assume blocking decisions exist
      return true;
    }

    const stepIds = (steps || [])
      .map((s) => s.id)
      .filter((id): id is number => typeof id === 'number');

    if (stepIds.length === 0) {
      return false;
    }

    // Query system_decisions for all steps at once (more efficient than looping)
    // Check for pending blocking decisions across all workflow steps
    const { data: decisions, error: decisionsError } = await supabase
      .from('system_decisions')
      .select('id, blocking')
      .in('workflow_task_id', stepIds)
      .eq('status', 'pending')
      .eq('blocking', true);

    if (decisionsError) {
      logger.error('Failed to query system_decisions when checking blocking decisions', {
        workflowId,
        error: decisionsError,
      });
      // If we can't tell, err on the side of caution
      return true;
    }

    // Return true if any blocking pending decisions found
    return (decisions || []).length > 0;
  } catch (err) {
    logger.error('Error checking blocking decisions', { workflowId, err });
    // If we can't tell, err on the side of caution
    return true;
  }
}

/**
 * Workflow data structure
 */
interface WorkflowData {
  id: string;
  user_id: string;
  workflow_type: string;
  status: string;
  source_artifact_id: string | null;
  started_at: string | null;
  tokens_used: number | null;
  metadata: Record<string, unknown>;
}

/**
 * Fetch workflow from database
 * 
 * @param workflowId - The UUID of the workflow to fetch
 * @returns Promise resolving to WorkflowData or null if not found
 */
async function fetchWorkflow(workflowId: string): Promise<WorkflowData | null> {
  const { data, error } = await supabase
    .from('workflows')
    .select('*')
    .eq('id', workflowId)
    .single();

  if (error) {
    logger.error('Failed to fetch workflow', { workflowId, error });
    return null;
  }

  logger.info('Workflow fetched', { workflowId, status: data?.status });
  return data;
}

/**
 * Fetch artifact from database
 * 
 * @param artifactId - The UUID of the artifact to fetch
 * @returns Promise resolving to Artifact or null if not found
 */
async function fetchArtifact(artifactId: string | null): Promise<Artifact | null> {
  if (!artifactId) {
    return null;
  }

  const { data, error } = await supabase
    .from('artifacts')
    .select('*')
    .eq('id', artifactId)
    .single();

  if (error || !data) {
    logger.warn('Artifact not found', { artifactId, error: error?.message });
    return null;
  }

  return data as Artifact;
}

/**
 * Fetch all workflow steps for a workflow
 * 
 * @param workflowId - The UUID of the workflow
 * @returns Promise resolving to array of WorkflowStep, ordered by step_order ASC
 */
async function fetchWorkflowSteps(workflowId: string): Promise<WorkflowStep[]> {
  const { data, error } = await supabase
    .from('workflow_steps')
    .select('*')
    .eq('workflow_id', workflowId)
    .order('step_order', { ascending: true });

  if (error) {
    logger.error('Failed to fetch workflow steps', { workflowId, error });
    return [];
  }

  logger.info('Workflow steps fetched', { workflowId, stepCount: (data || []).length });
  return (data || []) as WorkflowStep[];
}

/**
 * Calculate duration between two timestamps and format as human-readable string
 * 
 * @param startTime - ISO timestamp string or null
 * @param endTime - ISO timestamp string
 * @returns Formatted duration string (e.g., "45s", "5m 23s", "1h 23m") or null if startTime is null
 */
export function calculateDuration(startTime: string | null, endTime: string): string | null {
  if (!startTime) {
    return null;
  }

  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  const durationMs = end - start;
  const durationSeconds = Math.floor(durationMs / 1000);

  if (durationSeconds < 60) {
    // Less than 60 seconds: "45s"
    return `${durationSeconds}s`;
  } else if (durationSeconds < 3600) {
    // 60-3599 seconds: "5m 23s"
    const minutes = Math.floor(durationSeconds / 60);
    const seconds = durationSeconds % 60;
    return `${minutes}m ${seconds}s`;
  } else {
    // 3600+ seconds: "1h 23m"
    const hours = Math.floor(durationSeconds / 3600);
    const minutes = Math.floor((durationSeconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }
}

/**
 * Build user-friendly summary message for workflow completion
 * 
 * @param artifact - The artifact that was processed (or null if missing)
 * @param entitiesCreated - Number of entities created
 * @param entitiesLinked - Number of entities linked
 * @param tasksCreated - Number of tasks created
 * @param derivedArtifactsCreated - Number of derived artifacts created
 * @param tokensUsed - Number of AI tokens used (0 or undefined to omit token line)
 * @returns Human-readable summary message
 */
export function buildSummaryMessage(
  artifact: Artifact | null,
  entitiesCreated: number,
  entitiesLinked: number,
  tasksCreated: number,
  derivedArtifactsCreated: number,
  tokensUsed: number = 0
): string {
  // Start with base message
  let message = "I've finished processing your ";

  // Determine artifact type
  // Note: content_type and content_subtype may exist on artifact but aren't in the TypeScript interface
  const artifactAny = artifact as any;
  let artifactType = 'artifact';
  if (artifact) {
    if (artifactAny.content_type === 'text') {
      artifactType = 'note';
    } else if (artifactAny.content_subtype === 'photo') {
      artifactType = 'photo';
    } else if (artifactAny.content_subtype === 'document') {
      artifactType = 'document';
    } else if (artifactAny.content_subtype === 'video') {
      artifactType = 'video';
    } else {
      artifactType = 'file';
    }
  }

  message += artifactType;

  // Add snippet or filename
  if (artifact) {
    // If text artifact and user_content exists and is non-empty
    if (artifactAny.content_type === 'text' && artifactAny.user_content) {
      const content = String(artifactAny.user_content).trim();
      if (content.length > 0) {
        // Take first 50 characters, append "..." if content longer than 50 chars
        const snippet = content.length > 50 ? content.substring(0, 50) + '...' : content;
        message += ` (${snippet})`;
      }
    } else if (artifactAny.content_type !== 'text' && artifact.filename) {
      // If binary artifact and filename exists
      message += ` (${artifact.filename})`;
    }
  }

  // Add outcome lines
  message += '\n\n';

  const hasOutcomes = entitiesLinked > 0 || tasksCreated > 0 || derivedArtifactsCreated > 0;

  if (entitiesLinked > 0) {
    message += `✓ Linked to ${entitiesLinked} ${entitiesLinked === 1 ? 'entity' : 'entities'}`;
    if (entitiesCreated > 0) {
      message += ` (${entitiesCreated} new)`;
    }
    message += '\n';
  }

  if (tasksCreated > 0) {
    message += `✓ Created ${tasksCreated} ${tasksCreated === 1 ? 'task' : 'tasks'}\n`;
  }

  if (derivedArtifactsCreated > 0) {
    if (derivedArtifactsCreated === 1) {
      message += '✓ Created cleaned version\n';
    } else {
      message += `✓ Created ${derivedArtifactsCreated} derived versions\n`;
    }
  }

  if (!hasOutcomes) {
    message += '✓ Artifact analyzed and stored';
  }

  // Add token usage line if tokensUsed > 0
  if (tokensUsed > 0) {
    message += `\n\n💡 AI tokens used: ${tokensUsed.toLocaleString()}`;
  }

  return message;
}

/**
 * Execute the finalize step
 * 
 * This is the last step in every workflow execution. It gathers workflow results,
 * creates a completion notification, and updates artifact and workflow statuses.
 * 
 * @param step - The workflow step record for the finalize step
 * @param workflowId - The workflow ID value object
 * @param stepId - The step ID value object
 * @returns Promise resolving to FinalizeResult with success status and notification details
 */
export async function executeFinalizeStep(
  step: WorkflowStep,
  workflowId: WorkflowId,
  stepId: StepId
): Promise<FinalizeResult> {
  // Update step status to 'running' at the very start
  await updateStepStatus(stepId, 'running', {
    started_at: new Date().toISOString(),
  });

  logger.info('Finalizing workflow', { workflowId: workflowId.value, stepId: stepId.value });

  // Check for blocking pending decisions
  const hasBlocking = await checkBlockingDecisions(workflowId.value);
  if (hasBlocking) {
    logger.warn('Cannot finalize workflow with blocking pending decisions', { workflowId: workflowId.value });
    await updateStepStatus(stepId, 'failed', {
      message: 'Cannot finalize workflow with blocking pending decisions',
      error_message: 'Cannot finalize workflow with blocking pending decisions',
      completed_at: new Date().toISOString(),
    });

    return {
      success: false,
      error: 'Cannot finalize workflow with blocking pending decisions',
    };
  }

  // Fetch workflow data
  const workflow = await fetchWorkflow(workflowId.value);
  if (!workflow) {
    logger.error('Workflow not found', { workflowId: workflowId.value });
    await updateStepStatus(stepId, 'failed', {
      message: 'Workflow not found',
      error_message: 'Workflow not found',
      completed_at: new Date().toISOString(),
    });

    return {
      success: false,
      error: 'Workflow not found',
    };
  }

  // Fetch artifact (gracefully handle missing artifact)
  const artifact = await fetchArtifact(workflow.source_artifact_id);
  if (!artifact && workflow.source_artifact_id) {
    logger.warn('Artifact not found, continuing with generic description', {
      workflowId: workflowId.value,
      artifactId: workflow.source_artifact_id,
    });
  }

  // Fetch workflow steps
  const workflowSteps = await fetchWorkflowSteps(workflowId.value);
  if (workflowSteps.length === 0) {
    logger.info('No workflow steps found, will use generic completion message', { workflowId: workflowId.value });
  }

  // Initialize outcome counters
  let entitiesCreated = 0;
  let entitiesLinked = 0;
  let tasksCreated = 0;
  let derivedArtifactsCreated = 0;

  // Iterate through workflow steps and extract outcome counts
  for (const workflowStep of workflowSteps) {
    const stepType = workflowStep.step_type;
    const output = workflowStep.output;

    // Handle null or missing output (treat as 0)
    if (!output || typeof output !== 'object') {
      continue;
    }

    const outputObj = output as Record<string, unknown>;

    // Extract counts based on step type
    if (stepType === 'organize_entities') {
      // Count entitiesCreated array length
      if (Array.isArray(outputObj.entitiesCreated)) {
        entitiesCreated += outputObj.entitiesCreated.length;
      }

      // Count entitiesLinked array length
      if (Array.isArray(outputObj.entitiesLinked)) {
        entitiesLinked += outputObj.entitiesLinked.length;
      }
    } else if (stepType === 'extract_actions') {
      // Count tasksCreated array length
      if (Array.isArray(outputObj.tasksCreated)) {
        tasksCreated += outputObj.tasksCreated.length;
      }
    } else if (stepType === 'create_derived_artifact') {
      // Count derivedArtifactId (if present, count as 1)
      if (outputObj.derivedArtifactId && typeof outputObj.derivedArtifactId === 'string') {
        derivedArtifactsCreated += 1;
      }
    }
  }

  // Log outcome counts for debugging
  logger.info('Workflow results', {
    entitiesCreated,
    entitiesLinked,
    tasksCreated,
    derivedArtifactsCreated,
  });

  // Build summary message
  const tokensUsed = workflow.tokens_used ?? 0;
  const summary = buildSummaryMessage(
    artifact,
    entitiesCreated,
    entitiesLinked,
    tasksCreated,
    derivedArtifactsCreated,
    tokensUsed
  );

  // Calculate duration
  const endTime = new Date().toISOString();
  const duration = calculateDuration(workflow.started_at, endTime);

  // Create completion notification
  const notificationId = await createCompletionNotification(
    workflow,
    artifact,
    summary,
    {
      entitiesCreated,
      entitiesLinked,
      tasksCreated,
      derivedArtifactsCreated,
      tokensUsed,
      duration,
    }
  );

  if (!notificationId) {
    // Non-fatal: log and continue so artifact/workflow still complete successfully
    logger.warn('Completion notification could not be created; continuing to finalize artifact and workflow', {
      workflowId: workflowId.value,
      artifactId: workflow.source_artifact_id,
    });
  }

  // Update artifact status (if artifact exists)
  if (artifact) {
    const { error: artifactError } = await supabase
      .from('artifacts')
      .update({
        lifecycle_stage: 'complete',
        processing_status: 'completed',
      })
      .eq('id', artifact.id);

    if (artifactError) {
      logger.error('Failed to update artifact status', {
        artifactId: artifact.id,
        error: artifactError.message,
      });
      await updateStepStatus(stepId, 'failed', {
        message: `Failed to update artifact status: ${artifactError.message}`,
        error_message: `Failed to update artifact status: ${artifactError.message}`,
        completed_at: endTime,
      });

      return {
        success: false,
        error: `Failed to update artifact status: ${artifactError.message}`,
      };
    }

    logger.info('Artifact status updated', {
      artifactId: artifact.id,
      lifecycle_stage: 'complete',
      processing_status: 'completed',
    });
  }

  // Update workflow status
  const { error: workflowError } = await supabase
    .from('workflows')
    .update({
      status: 'completed',
      completed_at: endTime,
    })
    .eq('id', workflowId.value);

  if (workflowError) {
    logger.error('Failed to update workflow status', {
      workflowId: workflowId.value,
      error: workflowError.message,
    });
    await updateStepStatus(stepId, 'failed', {
      message: `Failed to update workflow status: ${workflowError.message}`,
      error_message: `Failed to update workflow status: ${workflowError.message}`,
      completed_at: endTime,
    });

    return {
      success: false,
      error: `Failed to update workflow status: ${workflowError.message}`,
    };
  }

  logger.info('Workflow status updated', {
    workflowId: workflowId.value,
    status: 'completed',
    completed_at: endTime,
  });

  // Update workflow step status (non-critical: log warning if fails but don't fail the step)
  const stepOutput = {
    notificationId,
    summary,
    counts: {
      entitiesCreated,
      entitiesLinked,
      tasksCreated,
      derivedArtifactsCreated,
    },
  };

  const { error: stepError } = await supabase
    .from('workflow_steps')
    .update({
      status: 'completed',
      message: 'Workflow finalized successfully',
      output: stepOutput,
      completed_at: endTime,
    })
    .eq('id', stepId.value);

  if (stepError) {
    // Non-critical: log warning but don't fail
    logger.warn('Failed to update workflow step status', {
      stepId: stepId.value,
      error: stepError.message,
    });
  } else {
    logger.info('Workflow step status updated', {
      stepId: stepId.value,
      status: 'completed',
    });
  }

  // Return success result (notificationId may be undefined if creation was skipped/failed)
  return {
    success: true,
    notificationId: notificationId ?? undefined,
    summary,
  };
}

/**
 * Create completion notification in system_decisions table
 * 
 * @param workflow - The workflow data
 * @param artifact - The artifact (or null if missing)
 * @param summary - The summary message
 * @param summaryData - Summary data for decision_payload
 * @returns Promise resolving to notification ID or null if creation failed
 */
export async function createCompletionNotification(
  workflow: WorkflowData,
  artifact: Artifact | null,
  summary: string,
  summaryData: {
    entitiesCreated: number;
    entitiesLinked: number;
    tasksCreated: number;
    derivedArtifactsCreated: number;
    tokensUsed: number;
    duration: string | null;
  }
): Promise<string | null> {
  try {
    const decisionPayload = {
      workflowId: workflow.id,
      artifactId: workflow.source_artifact_id,
      summary: {
        entitiesCreated: summaryData.entitiesCreated,
        entitiesLinked: summaryData.entitiesLinked,
        tasksCreated: summaryData.tasksCreated,
        derivedArtifactsCreated: summaryData.derivedArtifactsCreated,
        tokensUsed: summaryData.tokensUsed,
        duration: summaryData.duration,
      },
    };

    const { data, error } = await supabase
      .from('system_decisions')
      .insert({
        user_id: workflow.user_id,
        artifact_id: workflow.source_artifact_id,
        decision_type: 'workflow_complete',
        stage: 'complete',
        title: 'Artifact processed successfully',
        description: summary,
        confidence_score: 100,
        blocking: false,
        status: 'auto_applied',
        review_type: 'suggestion',
        decision_payload: decisionPayload,
      })
      .select('id')
      .single();

    if (error) {
      logger.error('Failed to create completion notification', {
        workflowId: workflow.id,
        artifactId: workflow.source_artifact_id,
        error: error.message,
        code: error.code,
        details: error.details,
      });
      return null;
    }

    if (!data || !data.id) {
      logger.error('Completion notification created but no ID returned', {
        workflowId: workflow.id,
        artifactId: workflow.source_artifact_id,
      });
      return null;
    }

    logger.info('Completion notification created', {
      notificationId: data.id,
      workflowId: workflow.id,
    });

    return data.id;
  } catch (err) {
    logger.error('Error creating completion notification', {
      workflowId: workflow.id,
      artifactId: workflow.source_artifact_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
