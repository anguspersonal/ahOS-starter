/**
 * Resume helpers for paused workflows.
 *
 * A workflow can pause when a blocking `system_decisions` record is created
 * (e.g. low-confidence analysis clarification, or entity disambiguation).
 *
 * This module applies user feedback, resolves the blocking decision(s),
 * and then continues orchestration from the appropriate point.
 */

import supabase from '../utils/supabase';
import { logger } from '../utils/logger';
import { generateUUID } from '../utils/helpers';
import { StepId } from './ids';
import { captureUserEdit } from '../learning/capture';
import { mapEntityType } from '../utils/entityTypes';
import type { Entity } from './steps/types';
import {
  ENTITY_LIST_COLUMNS,
  normalizeRelationshipType,
  mergeEntityProperties,
  type EntityMergeRecord,
} from '@ahkms/shared';
import { embedEntityAndStore } from '../utils/embeddings';

/**
 * The confidence a `system_decisions` row carried when it was raised, in the
 * shape `user_edits.confidence_before` stores.
 *
 * Units are the trap here, so they are converted in one place (#948): decisions
 * are written with `confidence_score: entityMention.confidence * 100`, so the
 * column is `numeric(5,2)` on a **0-100** scale, while `confidence_before` is a
 * plain `INTEGER`. Passing the raw value through would lean on an implicit
 * numeric-to-integer cast, and passing an LLM's native 0-1 confidence would
 * silently record every correction as 0 or 1.
 *
 * A correction that does not say which side of the threshold the call fell on
 * cannot recalibrate that threshold, which is why this is recorded at all
 * (ADR-079 §3).
 */
function confidenceBeforeFrom(decision: { confidence_score?: number | null }): number | null {
  const raw = decision?.confidence_score;
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : null;
}

type OrchestratorStatus = 'completed' | 'partial' | 'failed' | 'awaiting_user';

export interface OrchestratorResult {
  success: boolean;
  workflowId: string;
  status: OrchestratorStatus;
  completedSteps: string[];
  skippedSteps: string[];
  failedStep?: string;
  error?: string;
  artifactId?: string;
}

type DecisionStatus = 'pending' | 'auto_applied' | 'approved' | 'rejected' | 'modified' | 'snoozed' | 'expired';

function nowIso(): string {
  return new Date().toISOString();
}


async function resolveDecision(params: {
  decisionId: string;
  status: Exclude<DecisionStatus, 'pending'>;
  resolvedBy?: string;
  resolutionNotes?: string | null;
  decisionPayloadPatch?: Record<string, unknown>;
}): Promise<void> {
  const { decisionId, status, resolvedBy, resolutionNotes, decisionPayloadPatch } = params;

  const { data: existing, error: fetchError } = await supabase
    .from('system_decisions')
    .select('*')
    .eq('id', decisionId)
    .single();

  if (fetchError || !existing) {
    throw new Error(`System decision not found: ${decisionId}`);
  }

  const nextPayload = decisionPayloadPatch
    ? { ...(existing.decision_payload || {}), ...decisionPayloadPatch }
    : existing.decision_payload;

  const update: Record<string, unknown> = {
    status,
    resolved_at: nowIso(),
    resolution_notes: resolutionNotes ?? null,
    decision_payload: nextPayload,
  };

  if (resolvedBy) update.resolved_by = resolvedBy;

  const { error: updateError } = await supabase
    .from('system_decisions')
    .update(update)
    .eq('id', decisionId);

  if (updateError) {
    throw new Error(`Failed to resolve system decision ${decisionId}: ${updateError.message}`);
  }
}

async function setWorkflowStatus(workflowId: string, status: string, lastMessage?: string): Promise<void> {
  const updates: Record<string, unknown> = { status };
  if (lastMessage) updates.last_message = lastMessage;

  const { error } = await supabase
    .from('workflows')
    .update(updates)
    .eq('id', workflowId);

  if (error) {
    logger.warn('[Resume] Failed to update workflow status', { workflowId, status, error: error.message });
  }
}

async function updateWorkflowStep(stepId: number, updates: Record<string, unknown>): Promise<void> {
  const { error } = await supabase
    .from('workflow_steps')
    .update(updates)
    .eq('id', stepId);

  if (error) {
    logger.warn('[Resume] Failed to update workflow step', { stepId, error: error.message });
  }
}

async function hasBlockingPendingDecisionsForWorkflow(workflowId: string): Promise<boolean> {
  const { data: steps, error: stepsError } = await supabase
    .from('workflow_steps')
    .select('*')
    .eq('workflow_id', workflowId);

  if (stepsError) {
    // If we can't tell, err on the side of trying to execute (caller will see failures).
    logger.warn('[Resume] Failed to query workflow_steps when checking pending decisions', { workflowId, error: stepsError.message });
    return false;
  }

  const stepIds = (steps || []).map((s: any) => s.id).filter((id: any) => typeof id === 'number') as number[];
  if (stepIds.length === 0) return false;

  for (const stepId of stepIds) {
    const { data: decisions } = await supabase
      .from('system_decisions')
      .select('*')
      .eq('workflow_task_id', stepId)
      .eq('status', 'pending');

    const blockingPending = (decisions || []).some((d: any) => d?.blocking === true);
    if (blockingPending) return true;
  }

  return false;
}

async function executeWorkflowDynamic(workflowId: string): Promise<OrchestratorResult> {
  // Avoid a static import cycle with orchestrator.ts.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const orchestrator = require('./orchestrator') as { executeWorkflow: (id: string) => Promise<OrchestratorResult> };
  return orchestrator.executeWorkflow(workflowId);
}

/**
 * Resume a workflow if there are no blocking pending decisions.
 * If blocking decisions remain, return `awaiting_user` without executing.
 */
export async function resumeWorkflow(workflowId: string): Promise<OrchestratorResult> {
  const hasBlocking = await hasBlockingPendingDecisionsForWorkflow(workflowId);
  if (hasBlocking) {
    logger.info('[Resume] Workflow still awaiting user input', { workflowId });
    return {
      success: true,
      workflowId,
      status: 'awaiting_user',
      completedSteps: [],
      skippedSteps: [],
    };
  }

  await setWorkflowStatus(workflowId, 'in_progress', 'Resuming workflow');
  return executeWorkflowDynamic(workflowId);
}

export async function continueWorkflowFromAnalysis(workflowId: string): Promise<OrchestratorResult> {
  await setWorkflowStatus(workflowId, 'in_progress', 'Continuing workflow from analysis');
  return executeWorkflowDynamic(workflowId);
}

export async function continueWorkflowFromOrganize(workflowId: string): Promise<OrchestratorResult> {
  await setWorkflowStatus(workflowId, 'in_progress', 'Continuing workflow from organize_entities');
  return executeWorkflowDynamic(workflowId);
}

export async function handleAnalysisFeedback(params: {
  decisionId: string;
  clarificationText: string;
  resolvedBy?: string;
}): Promise<OrchestratorResult> {
  const { decisionId, clarificationText, resolvedBy } = params;

  const { data: decision, error: decisionError } = await supabase
    .from('system_decisions')
    .select('*')
    .eq('id', decisionId)
    .single();

  if (decisionError || !decision) {
    throw new Error(`System decision not found: ${decisionId}`);
  }

  const workflowId: string | undefined =
    (decision.decision_payload && (decision.decision_payload as any).workflowId) ||
    undefined;

  const artifactId: string | undefined =
    decision.artifact_id ||
    (decision.decision_payload && (decision.decision_payload as any).artifactId) ||
    undefined;

  const workflowStepId: number | undefined =
    decision.workflow_task_id ||
    (decision.decision_payload && (decision.decision_payload as any).workflowStepId) ||
    undefined;

  if (!workflowId) {
    throw new Error('Missing workflowId on clarification decision');
  }
  if (!artifactId) {
    throw new Error('Missing artifactId on clarification decision');
  }

  // Persist the user's clarification onto the artifact, so a re-run of analyze can use it.
  const { data: artifact } = await supabase
    .from('artifacts')
    .select('*')
    .eq('id', artifactId)
    .single();

  const existingContent = (artifact?.content && typeof artifact.content === 'object')
    ? (artifact.content as Record<string, unknown>)
    : {};

  const existingText = typeof existingContent.text === 'string' ? existingContent.text : '';
  const mergedText = existingText
    ? `${existingText}\n\nUser clarification:\n${clarificationText}`.trim()
    : clarificationText.trim();

  await supabase
    .from('artifacts')
    .update({
      content: { ...existingContent, text: mergedText },
      processing_metadata: {
        ...(artifact?.processing_metadata || {}),
        user_clarification: {
          provided_at: nowIso(),
          text: clarificationText,
        },
      },
    })
    .eq('id', artifactId);

  await resolveDecision({
    decisionId,
    status: 'modified',
    resolvedBy,
    resolutionNotes: clarificationText,
    decisionPayloadPatch: { userClarification: clarificationText },
  });

  if (typeof workflowStepId === 'number') {
    await updateWorkflowStep(workflowStepId, {
      status: 'pending',
      notification_id: null,
      message: 'User provided clarification, resuming analysis',
    });
  }

  // Set workflow to in_progress immediately so the UI (Realtime) shows "Processing" not "Paused"
  await setWorkflowStatus(workflowId, 'in_progress', 'Resuming after your clarification');

  // Run workflow resume in background so the API can return quickly; frontend can refetch to see progress
  continueWorkflowFromAnalysis(workflowId).catch((err) => {
    logger.error('[Resume] Background workflow resume after clarification failed', {
      workflowId,
      decisionId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return {
    success: true,
    workflowId,
    status: 'partial',
    completedSteps: [],
    skippedSteps: [],
  };
}

/**
 * Decision-payload fields needed to resolve and (possibly) resume a blocking
 * entity decision. Bundles the workflowId/artifactId/stepId data clump that
 * `handleEntityFeedback` previously extracted as four separate locals.
 *
 * Extraction here is deliberately entity-feedback-specific: it accepts
 * snake_case payload fallbacks and parses `stepId` via `StepId.parse`, which
 * `handleAnalysisFeedback` does not. Sharing this across both handlers would
 * change `handleAnalysisFeedback`'s behavior (see issue #35 triage), so it
 * stays local to this function.
 */
interface EntityDecisionContext {
  decisionType: string;
  wasBlocking: boolean;
  workflowId: string | undefined;
  artifactId: string | undefined;
  stepId: number | undefined;
  /** True when a blocking decision has enough identifiers to resume the workflow. */
  canResumeBlocking: boolean;
}

function resolveEntityDecisionContext(decision: any, payload: Record<string, any>): EntityDecisionContext {
  const decisionType: string = decision.decision_type;
  const wasBlocking = decision.blocking === true;

  const workflowId: string | undefined = payload.workflowId ?? payload.workflow_id;
  const artifactId: string | undefined = decision.artifact_id ?? payload.artifactId ?? payload.artifact_id;
  const rawStepId = decision.workflow_task_id ?? payload.workflowStepId ?? payload.workflow_task_id;
  let stepId: number | undefined;
  try {
    if (rawStepId != null && rawStepId !== '') stepId = StepId.parse(rawStepId).value;
  } catch {
    stepId = undefined;
  }

  const canResumeBlocking =
    wasBlocking && !!workflowId && typeof stepId === 'number' && !Number.isNaN(stepId);

  return { decisionType, wasBlocking, workflowId, artifactId, stepId, canResumeBlocking };
}

export async function handleEntityFeedback(params: {
  decisionId: string;
  action: 'approve' | 'reject' | 'modify';
  resolvedBy?: string;
  selectedEntityId?: string;
  resolutionNotes?: string;
}): Promise<OrchestratorResult> {
  const { decisionId, action, resolvedBy, selectedEntityId, resolutionNotes } = params;

  const { data: decision, error: decisionError } = await supabase
    .from('system_decisions')
    .select('*')
    .eq('id', decisionId)
    .single();

  if (decisionError || !decision) {
    throw new Error(`System decision not found: ${decisionId}`);
  }

  const payload = (decision.decision_payload || {}) as Record<string, any>;

  const { decisionType, wasBlocking, workflowId, artifactId, stepId, canResumeBlocking } =
    resolveEntityDecisionContext(decision, payload);

  // workflowId and stepId only required when decision was blocking and we need to resume. If missing, we still resolve the decision but skip resume.
  if (wasBlocking && !canResumeBlocking) {
    logger.warn('[Resume] Blocking entity decision missing workflowId or stepId; will resolve decision only', {
      decisionId,
      hasWorkflowId: !!workflowId,
      stepId,
    });
  }
  if (!artifactId) throw new Error('Missing artifactId on entity decision');

  // Apply user decision to the graph (links/entities). For non-blocking decisions we already
  // created the link at step time; approve = confirm (or swap if different entity), reject = remove link.

  if (action === 'approve' || action === 'modify') {
    if (decisionType === 'entity_disambiguation') {
      const chosen = selectedEntityId || payload?.selectedEntityId;
      if (!chosen) throw new Error('Missing selectedEntityId for entity_disambiguation approval/modify');

      if (wasBlocking) {
        await supabase.from('artifact_entity_links').insert({
          user_id: decision.user_id,
          artifact_id: artifactId,
          entity_id: chosen,
          link_type: 'primary',
          confidence_score: 100,
        });
      } else {
        const autoLinked = payload?.autoLinkedEntityId;
        if (autoLinked && chosen !== autoLinked) {
          await supabase
            .from('artifact_entity_links')
            .delete()
            .eq('artifact_id', artifactId)
            .eq('entity_id', autoLinked);
          await supabase.from('artifact_entity_links').insert({
            user_id: decision.user_id,
            artifact_id: artifactId,
            entity_id: chosen,
            link_type: 'primary',
            confidence_score: 100,
          });
        }
      }
    } else if (decisionType === 'confirm_entity_match') {
      const candidateId = payload?.candidateEntity?.id;
      if (!candidateId) throw new Error('Missing candidateEntity.id for confirm_entity_match approval');

      if (wasBlocking) {
        await supabase.from('artifact_entity_links').insert({
          user_id: decision.user_id,
          artifact_id: artifactId,
          entity_id: candidateId,
          link_type: 'primary',
          confidence_score: 100,
        });
      }
      // Non-blocking: link already created at step time
    } else if (decisionType === 'confirm_entity_creation') {
      const mention = payload?.entityMention;
      if (!mention?.name || !mention?.type) throw new Error('Missing entityMention for confirm_entity_creation approval');

      const entityId = generateUUID();
      const entityType = mapEntityType(String(mention.type));

      await supabase.from('entities').insert({
        id: entityId,
        user_id: decision.user_id,
        team_id: decision.team_id || null,
        entity_type: entityType,
        title: String(mention.name),
        description: null,
        properties: {},
        tags: [],
        archived: false,
        created_at: nowIso(),
        updated_at: nowIso(),
      });

      await supabase.from('artifact_entity_links').insert({
        user_id: decision.user_id,
        artifact_id: artifactId,
        entity_id: entityId,
        link_type: 'primary',
        confidence_score: 100,
      });
    } else {
      logger.warn('[Resume] Unsupported entity decision_type for approval', { decisionId, decisionType });
    }
  } else if (action === 'reject' && !wasBlocking && (decisionType === 'confirm_entity_match' || decisionType === 'entity_disambiguation')) {
    const linkEntityId =
      decisionType === 'confirm_entity_match' ? payload?.candidateEntity?.id : payload?.autoLinkedEntityId;
    if (linkEntityId) {
      await supabase
        .from('artifact_entity_links')
        .delete()
        .eq('artifact_id', artifactId)
        .eq('entity_id', linkEntityId);
    }
  }

  const nextStatus: Exclude<DecisionStatus, 'pending'> =
    action === 'approve' ? 'approved'
      : action === 'reject' ? 'rejected'
        : 'modified';

  await resolveDecision({
    decisionId,
    status: nextStatus,
    resolvedBy,
    resolutionNotes: resolutionNotes ?? null,
    decisionPayloadPatch: selectedEntityId ? { selectedEntityId } : undefined,
  });

  // Non-blocking decisions, or blocking but missing workflowId/stepId: no resume needed.
  if (!wasBlocking || !canResumeBlocking) {
    return {
      success: true,
      workflowId: workflowId ?? '',
      status: 'completed',
      completedSteps: [],
      skippedSteps: [],
      artifactId,
    };
  }

  // If there are no more blocking pending decisions for the organize_entities step, mark it completed.
  const { data: remaining } = await supabase
    .from('system_decisions')
    .select('*')
    .eq('workflow_task_id', stepId)
    .eq('status', 'pending');

  const stillBlocking = (remaining || []).some((d: any) => d?.blocking === true);

  if (!stillBlocking && typeof stepId === 'number') {
    await updateWorkflowStep(stepId, {
      status: 'completed',
      message: 'User decisions resolved',
      completed_at: nowIso(),
    });

    await supabase
      .from('artifacts')
      .update({ lifecycle_stage: 'entities_extracted' })
      .eq('id', artifactId);
  }

  // `canResumeBlocking` (from resolveEntityDecisionContext) is only true when workflowId is
  // present; the early return above handles the false case, so this is guaranteed defined here.
  await setWorkflowStatus(workflowId!, 'in_progress', 'User feedback applied, resuming workflow');
  return continueWorkflowFromOrganize(workflowId!);
}

/**
 * Handle "Create anyway" on a skipped-entity decision (entity_creation_skipped).
 * Non-blocking: create entity, link to artifact, record user_edit, resolve decision. No workflow resume.
 */
export async function handleEntityCreationSkippedFeedback(params: {
  decisionId: string;
  resolvedBy: string;
  resolutionNotes?: string;
}): Promise<void> {
  const { decisionId, resolvedBy, resolutionNotes } = params;

  const { data: decision, error: decisionError } = await supabase
    .from('system_decisions')
    .select('*')
    .eq('id', decisionId)
    .single();

  if (decisionError || !decision) {
    throw new Error(`System decision not found: ${decisionId}`);
  }

  const payload = (decision.decision_payload || {}) as Record<string, any>;
  const mention = payload?.entityMention;
  const artifactId: string | undefined = decision.artifact_id || payload?.artifactId;

  if (!mention?.name || !mention?.type) {
    throw new Error('Missing entityMention for entity_creation_skipped approval');
  }
  if (!artifactId) {
    throw new Error('Missing artifactId on entity_creation_skipped decision');
  }

  const entityId = generateUUID();
  const entityType = mapEntityType(String(mention.type));

  await supabase.from('entities').insert({
    id: entityId,
    user_id: decision.user_id,
    team_id: decision.team_id || null,
    entity_type: entityType,
    title: String(mention.name),
    description: null,
    properties: {},
    tags: [],
    archived: false,
    created_at: nowIso(),
    updated_at: nowIso(),
  });

  await supabase.from('artifact_entity_links').insert({
    user_id: decision.user_id,
    artifact_id: artifactId,
    entity_id: entityId,
    link_type: 'primary',
    confidence_score: 100,
  });

  await captureUserEdit(
    resolvedBy,
    'entity_creation_correction',
    { action: 'skipped', entityMention: mention, artifactId },
    { action: 'created', entityId },
    { artifactId, entityId, confidenceBefore: confidenceBeforeFrom(decision) }
  );

  await resolveDecision({
    decisionId,
    status: 'approved',
    resolvedBy,
    resolutionNotes: resolutionNotes ?? 'Create anyway',
    decisionPayloadPatch: { createdEntityId: entityId },
  });

  logger.info('[Resume] Entity created from skipped decision (Create anyway)', { decisionId, entityId, artifactId });
}

/**
 * Handle "Reject" on an auto-created entity decision (entity_created).
 * Unlink artifact–entity, record user_edit, delete entity only if it has no other links.
 */
export async function handleEntityCreatedRejectFeedback(params: {
  decisionId: string;
  resolvedBy: string;
  resolutionNotes?: string;
}): Promise<void> {
  const { decisionId, resolvedBy, resolutionNotes } = params;

  const { data: decision, error: decisionError } = await supabase
    .from('system_decisions')
    .select('*')
    .eq('id', decisionId)
    .single();

  if (decisionError || !decision) {
    throw new Error(`System decision not found: ${decisionId}`);
  }

  const payload = (decision.decision_payload || {}) as Record<string, any>;
  const entityId: string | undefined = payload?.entityId;
  const artifactId: string | undefined = decision.artifact_id || payload?.artifactId;
  const entityName: string | undefined = payload?.entityName;

  if (!entityId) {
    throw new Error('Missing entityId for entity_created reject');
  }
  if (!artifactId) {
    throw new Error('Missing artifactId on entity_created decision');
  }

  await supabase
    .from('artifact_entity_links')
    .delete()
    .eq('artifact_id', artifactId)
    .eq('entity_id', entityId);

  const { data: otherLinks } = await supabase
    .from('artifact_entity_links')
    .select('id')
    .eq('entity_id', entityId)
    .limit(1);

  if (!otherLinks || otherLinks.length === 0) {
    await supabase.from('entities').delete().eq('id', entityId);
    logger.info('[Resume] Entity deleted (no other links) after reject', { entityId });
  }

  await captureUserEdit(
    resolvedBy,
    'entity_creation_correction',
    { action: 'auto_created', entityId, entityName, artifactId },
    { action: 'rejected' },
    { artifactId, entityId, confidenceBefore: confidenceBeforeFrom(decision) }
  );

  await resolveDecision({
    decisionId,
    status: 'rejected',
    resolvedBy,
    resolutionNotes: resolutionNotes ?? 'Rejected by user',
  });

  logger.info('[Resume] Entity created decision rejected', { decisionId, entityId, artifactId });
}

/**
 * Handle approve/reject on a `relationship_suggested` decision (issue #178).
 * Non-blocking, mirrors `handleEntityCreationSkippedFeedback`/
 * `handleEntityCreatedRejectFeedback`: on approve, write the typed edge
 * (dedupe-safe on the `UNIQUE(user_id, from_entity_id, to_entity_id,
 * relationship_type)` constraint, migration 062); on reject, just resolve the
 * decision — nothing is written. No workflow resume (this decision never
 * blocks the workflow).
 */
export async function handleRelationshipSuggestedFeedback(params: {
  decisionId: string;
  action: 'approve' | 'reject' | 'modify';
  resolvedBy: string;
  resolutionNotes?: string;
}): Promise<void> {
  const { decisionId, action, resolvedBy, resolutionNotes } = params;

  const { data: decision, error: decisionError } = await supabase
    .from('system_decisions')
    .select('*')
    .eq('id', decisionId)
    .single();

  if (decisionError || !decision) {
    throw new Error(`System decision not found: ${decisionId}`);
  }

  if (action === 'reject') {
    await resolveDecision({
      decisionId,
      status: 'rejected',
      resolvedBy,
      resolutionNotes: resolutionNotes ?? 'Rejected by user',
    });
    logger.info('[Resume] Relationship suggestion rejected', { decisionId });
    return;
  }

  const payload = (decision.decision_payload || {}) as Record<string, any>;
  const fromEntityId: string | undefined = payload?.fromEntityId;
  const toEntityId: string | undefined = payload?.toEntityId;
  const relationshipType: string | undefined = payload?.relationshipType;

  if (!fromEntityId || !toEntityId) {
    throw new Error('Missing fromEntityId/toEntityId for relationship_suggested approval');
  }
  if (!relationshipType) {
    throw new Error('Missing relationshipType for relationship_suggested approval');
  }
  if (fromEntityId === toEntityId) {
    throw new Error('relationship_suggested decision has fromEntityId === toEntityId');
  }

  const resolved = normalizeRelationshipType(relationshipType);
  const rawNotes: string | undefined = typeof payload?.notes === 'string' ? payload.notes : undefined;
  const edgeNotes = [rawNotes, resolved.notes].filter(Boolean).join(' | ') || null;
  const confidence: number | undefined = typeof payload?.confidence === 'number' ? payload.confidence : undefined;

  // Dedup on (user, from, to, type): update if present, else insert — mirrors
  // relateEntities.ts / writeAreaHierarchyEdge's dedup shape. `.single()` errors
  // (e.g. PGRST116) on zero rows, same "not found" signal used elsewhere in this
  // module, so a findError here just means "no existing edge", not a real failure.
  const { data: existing } = await supabase
    .from('entity_relationships')
    .select('id')
    .eq('user_id', decision.user_id)
    .eq('from_entity_id', fromEntityId)
    .eq('to_entity_id', toEntityId)
    .eq('relationship_type', resolved.type)
    .single();

  if (existing) {
    const { error: updateError } = await supabase
      .from('entity_relationships')
      .update({
        confidence_score: confidence !== undefined ? Math.round(confidence * 100) : decision.confidence_score,
        created_by: resolvedBy,
        notes: edgeNotes,
      })
      .eq('id', existing.id);
    if (updateError) {
      throw new Error(`Failed to update relationship edge: ${updateError.message}`);
    }
  } else {
    const { error: insertError } = await supabase.from('entity_relationships').insert({
      user_id: decision.user_id,
      from_entity_id: fromEntityId,
      to_entity_id: toEntityId,
      relationship_type: resolved.type,
      confidence_score: confidence !== undefined ? Math.round(confidence * 100) : decision.confidence_score,
      created_by: resolvedBy,
      notes: edgeNotes,
    });
    if (insertError) {
      throw new Error(`Failed to create relationship edge: ${insertError.message}`);
    }
  }

  await resolveDecision({
    decisionId,
    status: action === 'modify' ? 'modified' : 'approved',
    resolvedBy,
    resolutionNotes: resolutionNotes ?? 'Approved by user',
    decisionPayloadPatch: { appliedRelationshipType: resolved.type },
  });

  logger.info('[Resume] Relationship suggestion approved and edge written', {
    decisionId,
    fromEntityId,
    toEntityId,
    relationshipType: resolved.type,
  });
}


/**
 * Handle approve/reject on a `merge_suggested` decision (issue #174 — entity
 * identity resolution). User-confirmed merge (Angus, 2026-07-07): on approve,
 * repoint the loser's edges (`entity_relationships`) and links
 * (`artifact_entity_links`) onto the winner, record the loser's name as an
 * alias on the winner, then tombstone the loser (`archived = true` +
 * `properties.merged_into = winnerId`) — provenance is preserved by keeping the
 * tombstone row rather than hard-deleting. On reject, just resolve the decision.
 * An optional caller-supplied `selectedEntityId` (#310) can override which
 * entity survives the merge; see its param doc below for the exact rules.
 * Non-blocking; no workflow resume. Idempotent if the loser is already merged.
 */
export async function handleMergeSuggestedFeedback(params: {
  decisionId: string;
  action: 'approve' | 'reject' | 'modify';
  resolvedBy: string;
  resolutionNotes?: string;
  /**
   * Optional user-picked survivor (#310); must be one of the pair — winner id
   * confirms auto-orientation (no-op), loser id flips the merge; any other id
   * is rejected. Omit to accept the decision's auto-oriented winner.
   */
  selectedEntityId?: string;
}): Promise<void> {
  const { decisionId, action, resolvedBy, resolutionNotes, selectedEntityId } = params;

  const { data: decision, error: decisionError } = await supabase
    .from('system_decisions')
    .select('*')
    .eq('id', decisionId)
    .single();

  if (decisionError || !decision) {
    throw new Error(`System decision not found: ${decisionId}`);
  }

  // Refuse to reprocess a decision that has already been resolved (approve
  // after approve/reject, or a stale-client double-submit). Merges are much
  // harder to undo than a relationship edge, so — unlike the sibling
  // relationship_suggested handler above — this is enforced rather than left
  // as a pre-existing gap.
  if (decision.status !== 'pending') {
    throw new Error(
      `Merge suggestion decision ${decisionId} is not pending (status: ${decision.status}); refusing to reprocess`,
    );
  }

  if (action === 'reject') {
    await resolveDecision({
      decisionId,
      status: 'rejected',
      resolvedBy,
      resolutionNotes: resolutionNotes ?? 'Rejected by user',
    });
    logger.info('[Resume] Merge suggestion rejected', { decisionId });
    return;
  }

  const payload = (decision.decision_payload || {}) as Record<string, any>;
  const payloadWinnerId: string | undefined = payload?.winnerEntityId;
  const payloadLoserId: string | undefined = payload?.loserEntityId;

  if (!payloadWinnerId || !payloadLoserId) {
    throw new Error('Missing winnerEntityId/loserEntityId for merge_suggested approval');
  }
  if (payloadWinnerId === payloadLoserId) {
    throw new Error('merge_suggested decision has winnerEntityId === loserEntityId');
  }

  // Effective winner/loser, honoring a user-picked survivor override (#310).
  let winnerId = payloadWinnerId;
  let loserId = payloadLoserId;
  let survivorOverridden = false;
  const survivor = selectedEntityId?.trim();
  if (survivor) {
    if (survivor === payloadLoserId) {
      winnerId = payloadLoserId;
      loserId = payloadWinnerId;
      survivorOverridden = true;
    } else if (survivor !== payloadWinnerId) {
      throw new Error(
        `selectedEntityId ${survivor} is not part of merge decision ${decisionId} ` +
          `(winner ${payloadWinnerId} / loser ${payloadLoserId})`,
      );
    }
  }
  if (survivorOverridden) {
    logger.info('[Resume] Merge survivor overridden by user', { decisionId, autoWinner: payloadWinnerId, chosenWinner: winnerId });
  }

  // {@link ENTITY_LIST_COLUMNS} rather than `*` (#550): migration 095 put a
  // `search_vector` and a 1536-float `embedding` on `public.entities`, and the
  // merge path reads neither — it needs id/entity_type/title/archived/
  // properties/user_id. A dynamic (non-literal) `.select()` string defeats
  // postgrest-js's column-parsing type inference, so cast immediately rather
  // than leaving `data` typed as its `GenericStringError` fallback.
  const { data: winnerRow } = await supabase
    .from('entities')
    .select(ENTITY_LIST_COLUMNS.join(', '))
    .eq('id', winnerId)
    .single();
  const { data: loserRow } = await supabase
    .from('entities')
    .select(ENTITY_LIST_COLUMNS.join(', '))
    .eq('id', loserId)
    .single();
  const winner = winnerRow as unknown as Entity | null;
  const loser = loserRow as unknown as Entity | null;

  if (!winner) {
    throw new Error(`Merge winner entity not found: ${winnerId}`);
  }
  if (!loser) {
    throw new Error(`Merge loser entity not found: ${loserId}`);
  }
  // Both entities must belong to the decision owner (defence in depth).
  if (winner.user_id !== decision.user_id || loser.user_id !== decision.user_id) {
    throw new Error('Merge entities do not belong to the decision owner');
  }

  // The winner may itself have been archived (tombstoned) by a different,
  // independently-approved merge_suggested decision since this one was
  // generated — e.g. a 3+ entity duplicate cluster produces multiple pending
  // decisions from one sweep, and approving them out of order can point this
  // decision's "winner" at a now-dead entity. Merging onto a tombstoned
  // entity would silently orphan the loser's data (archived entities are
  // filtered out of live graph/context queries elsewhere in this package).
  // Fail fast instead of guessing at the transitive chain: the next
  // detection sweep re-scans live, non-archived entities and will regenerate
  // a correct decision against the real canonical entity.
  if (winner.archived) {
    throw new Error(
      `Merge winner entity ${winnerId} is archived (already merged into another entity); refusing to merge the loser onto a tombstoned winner. Re-run duplicate detection to regenerate a decision against the current canonical entity.`,
    );
  }

  const loserProps = (loser.properties || {}) as Record<string, unknown>;
  const loserMergedInto = typeof loserProps.merged_into === 'string' ? loserProps.merged_into : undefined;
  const alreadyMerged = loser.archived === true && loserMergedInto === winnerId;

  // The loser was archived, but by a different merge (a different winner) —
  // this decision's pairing never actually happened. Resolving it as
  // "approved" would misrepresent the audit trail, so supersede it instead.
  if (loser.archived === true && loserMergedInto !== undefined && loserMergedInto !== winnerId) {
    await resolveDecision({
      decisionId,
      status: 'rejected',
      resolvedBy,
      resolutionNotes:
        resolutionNotes ??
        `Superseded: loser entity ${loserId} was already merged into a different entity (${loserMergedInto}), not this decision's winner (${winnerId}).`,
    });
    logger.info('[Resume] Merge suggestion superseded — loser already merged elsewhere', {
      decisionId,
      winnerId,
      loserId,
      loserMergedInto,
    });
    return;
  }

  let mergeOp: EntityMergeRecord | undefined;

  if (!alreadyMerged) {
    // 1. Union non-conflicting scalar properties (#456) and record aliases.
    const winnerProps = (winner.properties || {}) as Record<string, unknown>;
    const {
      mergedProperties,
      carriedKeys: propertiesCarried,
      skippedKeys: propertiesSkipped,
    } = mergeEntityProperties(winner.entity_type, winnerProps, loserProps);

    const aliasSet = new Set<string>();
    // Seed with existing winner aliases (column first, plus legacy jsonb if present)
    if (Array.isArray(winner.aliases)) {
      for (const a of winner.aliases) {
        if (typeof a === 'string' && a.trim()) aliasSet.add(a.trim());
      }
    }
    const winnerLegacyAliases = winnerProps.aliases;
    if (Array.isArray(winnerLegacyAliases)) {
      for (const a of winnerLegacyAliases) {
        if (typeof a === 'string' && a.trim()) aliasSet.add(a.trim());
      }
    }

    const aliasesAdded: string[] = [];
    if (loser.title && loser.title !== winner.title && !aliasSet.has(loser.title)) {
      aliasSet.add(loser.title);
      aliasesAdded.push(loser.title);
    }
    if (Array.isArray(loser.aliases)) {
      for (const a of loser.aliases) {
        if (typeof a === 'string' && a.trim() && a.trim() !== winner.title && !aliasSet.has(a.trim())) {
          aliasSet.add(a.trim());
          aliasesAdded.push(a.trim());
        }
      }
    }
    if (Array.isArray(loserProps.aliases)) {
      for (const a of loserProps.aliases as unknown[]) {
        if (typeof a === 'string' && a.trim() && a.trim() !== winner.title && !aliasSet.has(a.trim())) {
          aliasSet.add(a.trim());
          aliasesAdded.push(a.trim());
        }
      }
    }

    const finalWinnerProps = {
      ...mergedProperties,
    };
    delete (finalWinnerProps as Record<string, unknown>).aliases;

    const { data: rpcResult, error: rpcError } = await supabase.rpc('merge_entities', {
      p_winner_id: winnerId,
      p_loser_id: loserId,
      p_user_id: decision.user_id,
      p_winner_properties: finalWinnerProps,
      p_winner_aliases: Array.from(aliasSet),
      p_aliases_added: aliasesAdded,
      p_properties_carried: propertiesCarried,
      p_properties_skipped: propertiesSkipped,
      p_decision_id: decisionId,
      p_resolution_notes: resolutionNotes ?? 'Approved by user',
      p_survivor_overridden: survivorOverridden,
      p_decision_status: action === 'modify' ? 'modified' : 'approved',
      p_resolved_by: resolvedBy ?? null,
    });

    if (rpcError) {
      throw new Error(`Failed to execute entity merge: ${rpcError.message}`);
    }

    mergeOp = rpcResult?.merge_op as EntityMergeRecord | undefined;

    // 2. Re-embed the surviving row (#882, ADR-047 §2: "merge/dedup rewrites
    // ... rewrite the surviving row's text — it must re-embed"). Best-effort.
    try {
      await embedEntityAndStore(winnerId, {
        title: winner.title,
        description: winner.description,
        properties: finalWinnerProps,
      });
    } catch (error: any) {
      logger.warn('[Resume] Embed-on-write failed for merge survivor', {
        error: error.message,
        winnerId,
      });
    }
  } else {
    await resolveDecision({
      decisionId,
      status: action === 'modify' ? 'modified' : 'approved',
      resolvedBy,
      resolutionNotes: resolutionNotes ?? 'Approved by user',
      decisionPayloadPatch: {
        winnerEntityId: winnerId,
        loserEntityId: loserId,
        mergedAt: nowIso(),
        survivorOverridden,
      },
    });
  }

  logger.info('[Resume] Merge suggestion approved and entities merged', {
    decisionId,
    winnerId,
    loserId,
    alreadyMerged,
    survivorOverridden,
  });
}

