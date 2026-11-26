/**
 * Workflow Orchestrator
 * 
 * Controls the execution of workflow steps in sequence.
 * Handles graceful degradation for unimplemented steps.
 */

import type { Span } from '@sentry/node';
import { logger } from '../utils/logger';
import supabase from '../utils/supabase';
import {
  getWorkflow,
  updateWorkflowStatus,
  getOrCreateWorkflowStep,
  updateStepStatus,
  setArtifactProcessingFailed,
  getArtifactIdForWorkflow,
  getAnalysisResultForWorkflow,
  type WorkflowData,
} from './workflowContext';
import {
  startWorkflowTransaction,
  startStepSpan,
  trackStepCompletion,
  finishWorkflowTransaction,
  finishWorkflowTransactionOnError,
} from './workflowMonitoring';
import { executeUploadStep } from './steps/upload';
import { executeCreateArtifactStep } from './steps/createArtifact';
import { executeAnalyzeStep } from './steps/analyze';
import { executeOrganizeEntitiesStep } from './steps/organizeEntities';
import { executeExtractActionsStep } from './steps/extractActions';
import { executeCreateDerivedArtifactStep } from './steps/createDerived';
import { executeFinalizeStep } from './steps/finalize';
import { WorkflowStep, UploadFile, UserContext, FileMetadata, AnalysisResult } from './steps/types';
import { resumeWorkflow as resumePausedWorkflow } from './resume';
import * as activeWorkflows from './activeWorkflows';
import { WorkflowId, ArtifactId, StepId } from './ids';

/**
 * Performance metrics for workflow execution
 */
interface WorkflowPerformanceMetrics {
  workflowExecutionTime: number;
  stepExecutionTimes: Record<string, number>;
  retryCounts: Record<string, number>;
  tokenUsage: number;
}

// Step implementation status
const IMPLEMENTED_STEPS: Record<string, boolean> = {
  upload: true,              // Step 0: ✅ Implemented
  create_artifact: true,     // Step 1: ✅ Implemented
  analyze: true,             // Step 2: ✅ Implemented
  organize_entities: true,  // Step 3: ✅ Implemented
  extract_actions: true,    // Step 4: ✅ Implemented
  create_derived: true,      // Step 5: ✅ Implemented
  finalize: true,            // Step 6: ✅ Implemented
};

// Step order for the workflow
const WORKFLOW_STEPS = [
  { type: 'upload', name: 'Upload File to Storage', order: 0 },
  { type: 'create_artifact', name: 'Create Artifact Record', order: 1 },
  { type: 'analyze', name: 'AI Content Analysis', order: 2 },
  { type: 'organize_entities', name: 'Organize Entities', order: 3 },
  { type: 'extract_actions', name: 'Extract Actions', order: 4 },
  { type: 'create_derived', name: 'Create Derived Artifacts', order: 5 },
  { type: 'finalize', name: 'Finalize Workflow', order: 6 },
];

interface OrchestratorResult {
  success: boolean;
  workflowId: string;
  status: 'completed' | 'partial' | 'failed' | 'awaiting_user';
  completedSteps: string[];
  skippedSteps: string[];
  failedStep?: string;
  error?: string;
  artifactId?: string;
}

type OrchestratorReturnAfterStep =
  | 'upload'
  | 'create_artifact'
  | 'analyze'
  | 'organize_entities'
  | 'extract_actions'
  | 'create_derived'
  | 'finalize';

interface ExecuteWorkflowOptions {
  /**
   * Return early from this invocation after the specified step is completed.
   * Intended for "fast-return" capture flows that only need durability guarantees.
   */
  returnAfterStep?: OrchestratorReturnAfterStep;
  /**
   * Capture options for per-capture overrides (e.g., create_derived_artifacts).
   * Takes precedence over user preferences.
   */
  captureOptions?: Record<string, unknown>;
}

/** Context passed to runStep for executing a single workflow step. */
export interface WorkflowStepContext {
  workflowId: WorkflowId;
  workflow: WorkflowData;
  file: UploadFile | null | undefined;
  userContext: UserContext | undefined;
  options: ExecuteWorkflowOptions | undefined;
  artifactId: { current: ArtifactId | undefined };
  completedSteps: string[];
  skippedSteps: string[];
  stepExecutionTimes: Record<string, number>;
  totalTokenUsage: { current: number };
  stepStartTime: number;
  stepSpan: Span | null;
  stepFailedIntentionally: { current: boolean };
  /**
   * The step's real outcome, for `executeWorkflow`'s fallback `trackStepCompletion`
   * call to stamp on the span when a branch falls through to the shared `break`
   * instead of returning early (see #796). Defaults to 'completed' -- the common
   * case, where a branch neither fails nor skips -- and each failure/skip branch
   * below sets it to match the DB status it just wrote, so the span's status
   * attribute never disagrees with what `workflow_steps` says happened.
   */
  stepOutcome: { current: 'completed' | 'failed' | 'skipped' };
}

type StepDef = (typeof WORKFLOW_STEPS)[number];

/**
 * Execute a single workflow step. Mutates context (artifactId, completedSteps, skippedSteps,
 * stepExecutionTimes, totalTokenUsage, stepFailedIntentionally). Returns an OrchestratorResult
 * to return early from the workflow, or null to continue.
 */
async function runStep(
  stepDef: StepDef,
  step: WorkflowStep,
  ctx: WorkflowStepContext,
  stepId: StepId
): Promise<OrchestratorResult | null> {
  const {
    workflowId,
    workflow,
    file,
    userContext,
    options,
    completedSteps,
    skippedSteps,
    stepExecutionTimes,
    totalTokenUsage,
    stepStartTime,
    stepSpan,
  } = ctx;
  const artifactId = () => ctx.artifactId.current;
  const setArtifactId = (v: ArtifactId | undefined) => {
    ctx.artifactId.current = v;
  };
  const wid = workflowId;
  const workflowIdStr = wid.value;

  switch (stepDef.type) {
    case 'upload':
      if (file && userContext) {
        const uploadResult = await executeUploadStep(step, file, userContext, wid, stepId);
        if (!uploadResult.success) {
          await updateWorkflowStatus(workflowIdStr, 'failed', `Upload failed: ${uploadResult.error}`);
          await setArtifactProcessingFailed(artifactId()?.value, `Upload failed: ${uploadResult.error}`);
          // This return bypasses executeWorkflow's fallback trackStepCompletion
          // (it only runs when runStep returns null), so the step's own span
          // must be closed here -- otherwise it never ends and a failed
          // upload emits a transaction with no step spans at all (#787).
          const { stepDuration } = trackStepCompletion(
            'upload',
            stepStartTime,
            stepSpan,
            undefined,
            'failed',
            uploadResult.error
          );
          stepExecutionTimes['upload'] = stepDuration;
          return {
            success: false,
            workflowId: workflowIdStr,
            status: 'failed',
            completedSteps,
            skippedSteps,
            failedStep: 'upload',
            error: uploadResult.error,
            artifactId: artifactId()?.value,
          };
        }
        completedSteps.push('upload');
        if (uploadResult.fileMetadata && uploadResult.objectPath) {
          step.output = {
            objectPath: uploadResult.objectPath,
            fileMetadata: uploadResult.fileMetadata,
          };
        }
      } else {
        await updateStepStatus(stepId.value, 'completed', 'File already uploaded', { skipped: true });
        completedSteps.push('upload');
        logger.info('[Orchestrator] Upload step skipped - file already uploaded');
      }
      break;

    case 'create_artifact':
      if (!userContext) {
        ctx.stepFailedIntentionally.current = true;
        ctx.stepOutcome.current = 'failed';
        logger.error('[Orchestrator] Missing userContext for create_artifact step');
        try {
          await updateStepStatus(stepId.value, 'failed', 'Missing userContext');
        } catch (updateError: any) {
          logger.error('[Orchestrator] Failed to update step status to failed', updateError);
        }
        break;
      }
      let objectPath: string | undefined;
      let fileMetadata: FileMetadata | undefined;
      let userTextContent: string | null | undefined = null;
      let captureUrl: string | undefined;
      let uploadStep: WorkflowStep | null = null;
      try {
        uploadStep = await getOrCreateWorkflowStep(workflowIdStr, 'upload', 'Upload File to Storage', 0);
        if (uploadStep?.output && typeof uploadStep.output === 'object') {
          const uploadOutput = uploadStep.output as Record<string, unknown>;
          objectPath = uploadOutput.objectStoragePath as string || uploadOutput.objectPath as string;
          fileMetadata = uploadOutput.fileMetadata as FileMetadata;
          if (fileMetadata && uploadOutput.storageObjectId) {
            fileMetadata.storageObjectId = uploadOutput.storageObjectId as string;
          }
        }
        if (uploadStep?.input && typeof uploadStep.input === 'object') {
          const uploadInput = uploadStep.input as Record<string, unknown>;
          if (!userTextContent && typeof uploadInput.userTextContent === 'string' && uploadInput.userTextContent.trim().length > 0) {
            userTextContent = uploadInput.userTextContent;
          }
          if (typeof uploadInput.captureUrl === 'string' && uploadInput.captureUrl.trim().length > 0) {
            captureUrl = uploadInput.captureUrl.trim();
          }
        }
      } catch (uploadStepError: any) {
        logger.warn('[Orchestrator] Could not get upload step for create_artifact', uploadStepError);
      }
      if (!objectPath || !fileMetadata) {
        if (step.input && typeof step.input === 'object') {
          const stepInput = step.input as Record<string, unknown>;
          objectPath = stepInput.objectPath as string || stepInput.objectStoragePath as string;
          fileMetadata = stepInput.fileMetadata as FileMetadata;
          userTextContent = stepInput.userTextContent as string | null | undefined;
          if (typeof stepInput.captureUrl === 'string' && stepInput.captureUrl.trim()) {
            captureUrl = stepInput.captureUrl.trim();
          }
        }
      }
      if (!objectPath || !fileMetadata) {
        ctx.stepFailedIntentionally.current = true;
        ctx.stepOutcome.current = 'failed';
        logger.error('[Orchestrator] Missing objectPath or fileMetadata for create_artifact step', {
          objectPath,
          hasFileMetadata: !!fileMetadata,
          uploadStepStatus: uploadStep?.status,
        });
        try {
          await updateStepStatus(stepId.value, 'failed', 'Missing objectPath or fileMetadata from upload step');
        } catch (updateError: any) {
          logger.error('[Orchestrator] Failed to update step status to failed', updateError);
        }
        break;
      }
      const createArtifactResult = await executeCreateArtifactStep({
        step,
        objectPath,
        fileMetadata,
        userTextContent,
        userContext,
        workflowId: wid,
        stepId,
        captureUrl,
      });
      if (!createArtifactResult.success) {
        ctx.stepOutcome.current = 'failed';
        logger.error('[Orchestrator] Create artifact step failed', {
          error: createArtifactResult.error,
          notificationId: createArtifactResult.notificationId,
        });
      } else {
        setArtifactId(createArtifactResult.artifactId ? ArtifactId.parse(createArtifactResult.artifactId) : undefined);
        completedSteps.push('create_artifact');
        logger.info('[Orchestrator] Create artifact step completed', { artifactId: createArtifactResult.artifactId });
      }
      break;

    case 'analyze': {
      const analyzeArtifactId = await getArtifactIdForWorkflow(workflowIdStr, workflow, artifactId()?.value);
      if (!analyzeArtifactId) {
        ctx.stepFailedIntentionally.current = true;
        ctx.stepOutcome.current = 'failed';
        logger.error('[Orchestrator] Missing artifactId for analyze step', {
          hasArtifactIdVar: !!artifactId(),
          hasSourceArtifactId: !!workflow.source_artifact_id,
        });
        try {
          await updateStepStatus(stepId.value, 'failed', 'Missing artifactId from create_artifact step');
        } catch (updateError: any) {
          logger.error('[Orchestrator] Failed to update step status to failed', updateError);
        }
        skippedSteps.push('analyze');
        break;
      }
      const analyzeResult = await executeAnalyzeStep(step, ArtifactId.parse(analyzeArtifactId), stepId);
      if (!analyzeResult.success) {
        ctx.stepFailedIntentionally.current = true;
        ctx.stepOutcome.current = 'failed';
        logger.error('[Orchestrator] Analyze step failed', {
          error: analyzeResult.error,
          errorDetails: analyzeResult.errorDetails,
        });
        try {
          await updateStepStatus(stepId.value, 'failed', `Analysis failed: ${analyzeResult.error || 'Unknown error'}`);
        } catch (updateError: any) {
          logger.error('[Orchestrator] Failed to update step status to failed', updateError);
        }
        skippedSteps.push('analyze');
      } else if (analyzeResult.status === 'awaiting_user') {
        logger.info('[Orchestrator] Analyze step paused for user clarification', {
          notificationId: analyzeResult.notificationId,
          confidence: analyzeResult.confidence,
        });
        await updateWorkflowStatus(workflowIdStr, 'awaiting_user', 'Waiting for user clarification');
        completedSteps.push('analyze');
        const { stepDuration, tokensUsed: stepTokens } = trackStepCompletion(
          'analyze',
          stepStartTime,
          stepSpan,
          analyzeResult.tokensUsed,
          'awaiting_user'
        );
        stepExecutionTimes['analyze'] = stepDuration;
        totalTokenUsage.current += stepTokens;
        return {
          success: true,
          workflowId: workflowIdStr,
          status: 'awaiting_user',
          completedSteps,
          skippedSteps,
          artifactId: analyzeArtifactId,
        };
      } else {
        setArtifactId(ArtifactId.parse(analyzeArtifactId));
        completedSteps.push('analyze');
        logger.info('[Orchestrator] Analyze step completed', {
          artifactId: analyzeArtifactId,
          intent: analyzeResult.analysisResult?.intent,
          confidence: analyzeResult.confidence,
          tokensUsed: analyzeResult.tokensUsed,
        });
        const { stepDuration, tokensUsed: stepTokens } = trackStepCompletion(
          'analyze',
          stepStartTime,
          stepSpan,
          analyzeResult.tokensUsed,
          'completed'
        );
        stepExecutionTimes['analyze'] = stepDuration;
        totalTokenUsage.current += stepTokens;
      }
      break;
    }

    case 'organize_entities': {
      const organizeArtifactId = await getArtifactIdForWorkflow(workflowIdStr, workflow, artifactId()?.value);
      const analysisResult = await getAnalysisResultForWorkflow(workflowIdStr);
      if (!organizeArtifactId) {
        ctx.stepFailedIntentionally.current = true;
        ctx.stepOutcome.current = 'failed';
        logger.error('[Orchestrator] Missing artifactId for organize_entities step');
        try {
          await updateStepStatus(stepId.value, 'failed', 'Missing artifactId from create_artifact step');
        } catch (updateError: any) {
          logger.error('[Orchestrator] Failed to update step status to failed', updateError);
        }
        skippedSteps.push('organize_entities');
        break;
      }
      if (!analysisResult || !analysisResult.entities_mentioned || analysisResult.entities_mentioned.length === 0) {
        logger.info('[Orchestrator] No entities to organize, skipping organize_entities step');
        await updateStepStatus(stepId.value, 'skipped', 'No entities found in analysis');
        ctx.stepOutcome.current = 'skipped';
        skippedSteps.push('organize_entities');
        break;
      }
      const organizeResult = await executeOrganizeEntitiesStep(step, ArtifactId.parse(organizeArtifactId), stepId, analysisResult);
      if (!organizeResult.success) {
        ctx.stepOutcome.current = 'failed';
        logger.error('[Orchestrator] Organize entities step failed', { error: organizeResult.error });
        skippedSteps.push('organize_entities');
      } else if (organizeResult.status === 'awaiting_user') {
        logger.info('[Orchestrator] Organize entities step paused for user disambiguation', {
          notificationCount: organizeResult.notificationsCreated.length,
        });
        await updateWorkflowStatus(workflowIdStr, 'awaiting_user', 'Waiting for user to disambiguate entities');
        completedSteps.push('organize_entities');
        // This return bypasses executeWorkflow's fallback trackStepCompletion
        // (it only runs when runStep returns null), so the step's own span
        // must be closed here -- same shape as the upload/finalize failure
        // branches above, and the `analyze` awaiting_user branch a few cases
        // up, which this one had been missing (#794).
        const { stepDuration } = trackStepCompletion(
          'organize_entities',
          stepStartTime,
          stepSpan,
          undefined,
          'awaiting_user'
        );
        stepExecutionTimes['organize_entities'] = stepDuration;
        return {
          success: true,
          workflowId: workflowIdStr,
          status: 'awaiting_user',
          completedSteps,
          skippedSteps,
          artifactId: organizeArtifactId,
        };
      } else {
        completedSteps.push('organize_entities');
        logger.info('[Orchestrator] Organize entities step completed', {
          linked: organizeResult.entitiesLinked.length,
          created: organizeResult.entitiesCreated.length,
        });
      }
      break;
    }

    case 'extract_actions': {
      const extractActionsArtifactId = await getArtifactIdForWorkflow(workflowIdStr, workflow, artifactId()?.value);
      const extractActionsAnalysisResult = await getAnalysisResultForWorkflow(workflowIdStr);
      if (!extractActionsArtifactId) {
        logger.error('[Orchestrator] Missing artifactId for extract_actions step');
        await updateStepStatus(stepId.value, 'skipped', 'Missing artifactId from create_artifact step');
        ctx.stepOutcome.current = 'skipped';
        skippedSteps.push('extract_actions');
        break;
      }
      if (!extractActionsAnalysisResult) {
        logger.warn('[Orchestrator] Missing analysisResult for extract_actions step, skipping');
        await updateStepStatus(stepId.value, 'skipped', 'Missing analysisResult from analyze step');
        ctx.stepOutcome.current = 'skipped';
        skippedSteps.push('extract_actions');
        break;
      }
      const extractResult = await executeExtractActionsStep(
        step,
        ArtifactId.parse(extractActionsArtifactId),
        stepId,
        extractActionsAnalysisResult
      );
      if (!extractResult.success) {
        ctx.stepOutcome.current = 'failed';
        logger.error('[Orchestrator] Extract actions step failed', { error: extractResult.error });
        skippedSteps.push('extract_actions');
      } else {
        completedSteps.push('extract_actions');
        logger.info('[Orchestrator] Extract actions step completed', {
          tasksCreated: extractResult.tasksCreated?.length ?? 0,
        });
      }
      break;
    }

    case 'create_derived': {
      const createDerivedArtifactId = await getArtifactIdForWorkflow(workflowIdStr, workflow, artifactId()?.value);
      const createDerivedAnalysisResult = await getAnalysisResultForWorkflow(workflowIdStr);
      if (!createDerivedArtifactId) {
        logger.error('[Orchestrator] Missing artifactId for create_derived step');
        await updateStepStatus(stepId.value, 'skipped', 'Missing artifactId');
        ctx.stepOutcome.current = 'skipped';
        skippedSteps.push('create_derived');
        break;
      }
      if (!createDerivedAnalysisResult) {
        logger.warn('[Orchestrator] Missing analysisResult for create_derived step, skipping');
        await updateStepStatus(stepId.value, 'skipped', 'Missing analysisResult from analyze step');
        ctx.stepOutcome.current = 'skipped';
        break;
      }
      const createDerivedResult = await executeCreateDerivedArtifactStep(
        step,
        ArtifactId.parse(createDerivedArtifactId),
        stepId,
        createDerivedAnalysisResult,
        undefined,
        options?.captureOptions
      );
      if (!createDerivedResult.success) {
        ctx.stepOutcome.current = 'skipped';
        logger.warn('[Orchestrator] Create derived step failed (non-fatal)', {
          error: createDerivedResult.error,
        });
      } else {
        completedSteps.push('create_derived');
        logger.info('[Orchestrator] Create derived step completed', {
          derivedArtifactId: createDerivedResult.derivedArtifactId,
          derivedType: createDerivedResult.derivedType,
        });
      }
      break;
    }

    case 'finalize': {
      const finalizeResult = await executeFinalizeStep(step, wid, stepId);
      if (!finalizeResult.success) {
        await updateWorkflowStatus(workflowIdStr, 'failed', finalizeResult.error || 'Finalize step failed');
        await setArtifactProcessingFailed(artifactId()?.value, finalizeResult.error || 'Finalize step failed');
        ctx.stepFailedIntentionally.current = true;
        // See the matching comment on the 'upload' branch above: this return
        // bypasses executeWorkflow's fallback trackStepCompletion, so the
        // step's own span must be closed here (#787).
        const { stepDuration } = trackStepCompletion(
          'finalize',
          stepStartTime,
          stepSpan,
          undefined,
          'failed',
          finalizeResult.error || 'Finalize step failed'
        );
        stepExecutionTimes['finalize'] = stepDuration;
        return {
          success: false,
          workflowId: workflowIdStr,
          status: 'failed',
          completedSteps,
          skippedSteps,
          failedStep: 'finalize',
          error: finalizeResult.error,
          artifactId: artifactId()?.value,
        };
      }
      completedSteps.push('finalize');
      logger.info('[Orchestrator] Finalize step completed', { notificationId: finalizeResult.notificationId });
      break;
    }

    default:
      logger.warn(`[Orchestrator] Unknown step type: ${stepDef.type}`);
      await updateStepStatus(stepId.value, 'skipped', 'Unknown step type');
      ctx.stepOutcome.current = 'skipped';
      skippedSteps.push(stepDef.type);
  }

  return null;
}

function computeFinalStatus(
  completedSteps: string[],
  skippedSteps: string[]
): { finalStatus: 'completed' | 'partial' | 'failed'; finalMessage: string } {
  const hasCompletedSteps = completedSteps.length > 0;
  const allSkipped = completedSteps.length === 0 && skippedSteps.length > 0;

  if (allSkipped) {
    return { finalStatus: 'failed', finalMessage: 'No steps were completed' };
  }
  if (skippedSteps.length > 0) {
    if (completedSteps.includes('finalize')) {
      return { finalStatus: 'completed', finalMessage: 'All steps completed successfully' };
    }
    return {
      finalStatus: 'partial',
      finalMessage: `Completed ${completedSteps.length}/${WORKFLOW_STEPS.length} steps. Skipped: ${skippedSteps.join(', ')} (not yet implemented)`,
    };
  }
  return { finalStatus: 'completed', finalMessage: 'All steps completed successfully' };
}

async function tryReturnAfterStep(
  workflowId: string,
  stepDef: StepDef,
  stepIndex: number,
  artifactId: string | undefined,
  completedSteps: string[],
  skippedSteps: string[],
  options: ExecuteWorkflowOptions | undefined
): Promise<OrchestratorResult | null> {
  if (!options?.returnAfterStep || options.returnAfterStep !== stepDef.type) {
    return null;
  }
  if (stepDef.type === 'create_artifact' && !artifactId) {
    logger.warn('[Orchestrator] returnAfterStep=create_artifact requested but artifactId missing; continuing', {
      workflowId,
    });
    return null;
  }
  for (const remainingDef of WORKFLOW_STEPS.slice(stepIndex + 1)) {
    if (!skippedSteps.includes(remainingDef.type)) skippedSteps.push(remainingDef.type);
  }
  await updateWorkflowStatus(workflowId, 'partial', `Stopped early after ${stepDef.type} (returnAfterStep)`);
  logger.info('[Orchestrator] Returning early due to returnAfterStep', {
    workflowId,
    returnAfterStep: stepDef.type,
    artifactId,
  });
  return {
    success: true,
    workflowId,
    status: 'partial',
    completedSteps,
    skippedSteps,
    artifactId,
  };
}

/**
 * Main orchestrator function
 * Executes workflow steps in sequence, gracefully handling unimplemented steps
 */
export async function executeWorkflow(
  workflowId: string,
  file?: UploadFile,
  userContext?: UserContext,
  options?: ExecuteWorkflowOptions
): Promise<OrchestratorResult> {
  let wid: WorkflowId;
  try {
    wid = WorkflowId.parse(workflowId);
  } catch {
    return {
      success: false,
      workflowId,
      status: 'failed',
      completedSteps: [],
      skippedSteps: [],
      error: 'Invalid workflow ID',
    };
  }

  logger.info(`[Orchestrator] Starting workflow: ${wid.value}`);

  // Performance tracking
  const workflowStartTime = Date.now();
  const stepExecutionTimes: Record<string, number> = {};
  const retryCounts: Record<string, number> = {};
  let totalTokenUsage = 0;

  const workflowTransaction = startWorkflowTransaction(wid.value, userContext);
  // Tracks whether the root span has already been ended, so the `finally`
  // below can guarantee exactly one `finishWorkflowTransaction` call no
  // matter which exit path fires. Every non-throw return in this function
  // routes through `finishSpanAndReturn`, which sets this flag -- the
  // `finally` guard exists only to catch a *future* exit path that forgets
  // to (see #764 round-1 QA: the pre-fix version ended the span on only 2 of
  // ~7 exit paths, so a paused/fast-returned/handled-failure run vanished
  // from Sentry entirely -- an unended root drops the whole trace, including
  // any already-ended child spans, because Sentry only flushes a trace once
  // its root ends). `span.end()` itself is idempotent (verified against the
  // installed SDK: a second call is a silent no-op, not a throw or a
  // corrupted timestamp), so this flag is belt-and-suspenders, not a
  // correctness requirement for the paths that already route through it.
  let workflowSpanFinished = false;

  /** Ends the root span with the outcome actually being returned, then returns it unchanged. */
  function finishSpanAndReturn(result: OrchestratorResult): OrchestratorResult {
    workflowSpanFinished = true;
    finishWorkflowTransaction(workflowTransaction, {
      workflowExecutionTime: Date.now() - workflowStartTime,
      totalTokenUsage,
      completedStepsCount: result.completedSteps.length,
      skippedStepsCount: result.skippedSteps.length,
      finalStatus: result.status,
    });
    return result;
  }

  const completedSteps: string[] = [];
  const skippedSteps: string[] = [];
  let artifactId: ArtifactId | undefined;

  try {
    // 1. Fetch workflow data
    const workflow = await getWorkflow(wid.value);
    if (!workflow) {
      return finishSpanAndReturn({
        success: false,
        workflowId: wid.value,
        status: 'failed',
        completedSteps,
        skippedSteps,
        error: 'Workflow not found',
      });
    }

    // 2. Update workflow to in_progress
    await updateWorkflowStatus(wid.value, 'in_progress', 'Starting workflow execution');

    artifactId = workflow.source_artifact_id ? ArtifactId.parse(workflow.source_artifact_id) : undefined;

    // 3. Execute each step in order
    for (let stepIndex = 0; stepIndex < WORKFLOW_STEPS.length; stepIndex++) {
      const stepDef = WORKFLOW_STEPS[stepIndex];
      logger.info(`[Orchestrator] Processing step: ${stepDef.type} (${stepDef.name})`);

      // Get existing step or create new one
      const step = await getOrCreateWorkflowStep(
        wid.value,
        stepDef.type,
        stepDef.name,
        stepDef.order
      );

      if (!step) {
        logger.error(`[Orchestrator] Failed to get/create step: ${stepDef.type}`);
        continue;
      }

      const stepId = StepId.parse(step.id);

      // Check if step is already completed or skipped
      if (step.status === 'completed' || step.status === 'skipped') {
        logger.info(`[Orchestrator] Step already ${step.status}: ${stepDef.type}`);
        if (step.status === 'completed') {
          completedSteps.push(stepDef.type);
        } else {
          skippedSteps.push(stepDef.type);
        }
        continue;
      }

      // Check if step is implemented
      if (!IMPLEMENTED_STEPS[stepDef.type]) {
        logger.warn(`[Orchestrator] Step not implemented: ${stepDef.type} - skipping`);
        await updateStepStatus(
          stepId.value,
          'skipped',
          `Step not yet implemented (Phase 2+)`,
          { reason: 'not_implemented' }
        );
        skippedSteps.push(stepDef.type);
        continue;
      }

      // Execute the step
      let stepFailedIntentionally = false; // Track if step was intentionally marked as failed
      // Real outcome for the fallback trackStepCompletion call below (#796) --
      // defaults to 'completed', overridden by runStep when a branch fails or
      // skips via `break` rather than `return`.
      let stepOutcome: 'completed' | 'failed' | 'skipped' = 'completed';
      const stepStartTime = Date.now();
      let stepSpan: Span | null = null;

      // Start Sentry span for step if Performance Monitoring is available
      stepSpan = startStepSpan(workflowTransaction, stepDef);

      // Track retry count if available
      if (step.retry_count !== undefined && step.retry_count !== null) {
        retryCounts[stepDef.type] = step.retry_count;
      }

      try {
        await updateStepStatus(stepId.value, 'running', `Executing ${stepDef.name}`);
        await updateWorkflowStatus(wid.value, 'in_progress', `Running: ${stepDef.name}`);
        const stepContext: WorkflowStepContext = {
          workflowId: wid,
          workflow,
          file: file ?? null,
          userContext,
          options,
          artifactId: { current: artifactId },
          completedSteps,
          skippedSteps,
          stepExecutionTimes,
          totalTokenUsage: { current: totalTokenUsage },
          stepStartTime,
          stepSpan,
          stepFailedIntentionally: { current: false },
          stepOutcome: { current: 'completed' },
        };
        const earlyResult = await runStep(stepDef, step, stepContext, stepId);
        artifactId = stepContext.artifactId.current;
        totalTokenUsage = stepContext.totalTokenUsage.current;
        stepFailedIntentionally = stepContext.stepFailedIntentionally.current;
        stepOutcome = stepContext.stepOutcome.current;
        if (earlyResult) return finishSpanAndReturn(earlyResult);
      } catch (stepError: any) {
        logger.error(`[Orchestrator] Step failed: ${stepDef.type}`, stepError);
        if (!stepFailedIntentionally) {
          await updateStepStatus(stepId.value, 'skipped', `Error: ${stepError.message}`);
        }
        const { stepDuration } = trackStepCompletion(
          stepDef.type,
          stepStartTime,
          stepSpan,
          undefined,
          'failed',
          stepError.message
        );
        stepExecutionTimes[stepDef.type] = stepDuration;
        skippedSteps.push(stepDef.type);
      }
      // Track step completion for all steps (even if not explicitly tracked above)
      // This ensures all steps have execution time recorded. Span lifecycle stays
      // inside workflowMonitoring.ts -- the orchestrator never touches Sentry's API.
      //
      // Stamps `stepOutcome`, not a literal 'completed' (#796): a step that fails
      // via `break` rather than `return` (e.g. create_artifact's missing-objectPath
      // path) falls through to this exact branch, and runStep has already recorded
      // its real outcome on ctx.stepOutcome as it did so. Steps that never touch
      // stepOutcome keep the 'completed' default set above, so this is a no-op
      // change for every already-correct path.
      //
      // `=== undefined`, not `!stepExecutionTimes[...]` (also #796): a step whose
      // duration legitimately rounds to 0ms (reachable under mocks/tests, not real
      // DB round-trips) would otherwise read as "not yet tracked" and get
      // re-tracked here, overwriting whatever status its own explicit
      // trackStepCompletion call (e.g. the catch block below) had just recorded.
      if (stepExecutionTimes[stepDef.type] === undefined && stepSpan) {
        const { stepDuration } = trackStepCompletion(stepDef.type, stepStartTime, stepSpan, undefined, stepOutcome);
        stepExecutionTimes[stepDef.type] = stepDuration;
      }

      const earlyResult = await tryReturnAfterStep(
        wid.value,
        stepDef,
        stepIndex,
        artifactId?.value,
        completedSteps,
        skippedSteps,
        options
      );
      if (earlyResult) return finishSpanAndReturn(earlyResult);
    }

    const { finalStatus, finalMessage } = computeFinalStatus(completedSteps, skippedSteps);
    await updateWorkflowStatus(wid.value, finalStatus, finalMessage);

    // Calculate workflow execution time
    const workflowExecutionTime = Date.now() - workflowStartTime;

    // Log performance metrics
    const performanceMetrics: WorkflowPerformanceMetrics = {
      workflowExecutionTime,
      stepExecutionTimes,
      retryCounts,
      tokenUsage: totalTokenUsage,
    };

    // Log to Railway logs (structured format)
    logger.info(`[Orchestrator] Workflow ${wid.value} finished with status: ${finalStatus}`, {
      performanceMetrics,
    });
    logger.info(`[Orchestrator] Completed: ${completedSteps.join(', ') || 'none'}`);
    logger.info(`[Orchestrator] Skipped: ${skippedSteps.join(', ') || 'none'}`);

    return finishSpanAndReturn({
      success: completedSteps.length > 0,
      workflowId: wid.value,
      status: finalStatus,
      completedSteps,
      skippedSteps,
      artifactId: artifactId?.value,
    });

  } catch (error: any) {
    logger.error(`[Orchestrator] Workflow failed: ${wid.value}`, error);
    const errMsg = `Orchestrator error: ${error.message}`;
    await updateWorkflowStatus(wid.value, 'failed', errMsg);
    await setArtifactProcessingFailed(artifactId?.value, errMsg);

    workflowSpanFinished = true;
    finishWorkflowTransactionOnError(
      workflowTransaction,
      Date.now() - workflowStartTime,
      error.message
    );

    return {
      success: false,
      workflowId: wid.value,
      status: 'failed',
      completedSteps,
      skippedSteps,
      error: error.message,
      artifactId: artifactId?.value,
    };
  } finally {
    activeWorkflows.remove(wid.value);
    // Safety net, not the primary mechanism: every exit path above already
    // routes through finishSpanAndReturn or the catch block, so this should
    // never fire. It exists so that a future exit path added without going
    // through finishSpanAndReturn degrades to "traced with an approximate
    // status" rather than silently dropping the whole run's trace again.
    if (workflowTransaction && !workflowSpanFinished) {
      finishWorkflowTransaction(workflowTransaction, {
        workflowExecutionTime: Date.now() - workflowStartTime,
        totalTokenUsage,
        completedStepsCount: completedSteps.length,
        skippedStepsCount: skippedSteps.length,
        finalStatus: 'partial',
      });
    }
  }
}

/**
 * Resume a paused workflow (e.g., after user approval)
 */
export async function resumeWorkflow(
  workflowId: string,
  fromStep?: string
): Promise<OrchestratorResult> {
  logger.info(`[Orchestrator] Resuming workflow: ${workflowId} from step: ${fromStep || 'auto'}`);

  // Delegate to the resume helper which blocks if decisions are still pending.
  return resumePausedWorkflow(workflowId);
}

