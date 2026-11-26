/**
 * Unified user feedback handling for workflow decisions.
 *
 * This module is the single entrypoint for applying a user's response to a
 * `system_decisions` record, with:
 * - authorization checks (decision must belong to user)
 * - validation (required fields per decision type)
 * - delegation to workflow resume helpers for blocking workflow decisions
 */

import supabase from '../utils/supabase';
import { logger } from '../utils/logger';
import {
  handleAnalysisFeedback,
  handleEntityFeedback,
  handleEntityCreationSkippedFeedback,
  handleEntityCreatedRejectFeedback,
  handleRelationshipSuggestedFeedback,
  handleMergeSuggestedFeedback,
  resumeWorkflow as resumePausedWorkflow,
  continueWorkflowFromAnalysis,
  type OrchestratorResult,
} from './resume';

export type FeedbackAction = 'approve' | 'reject' | 'modify' | 'snooze' | 'dismiss';

export interface HandleUserFeedbackInput {
  decisionId: string;
  userId: string;
  action: FeedbackAction;
  /**
   * Generic notes to store on the decision.
   * For clarification decisions prefer `clarificationText`.
   */
  resolutionNotes?: string;
  /** Required for action === 'snooze' */
  snoozeUntil?: string;
  /** Required for clarification decisions when action is approve/modify */
  clarificationText?: string;
  /**
   * Required for entity_disambiguation when approving/modifying. Also used
   * optionally on `merge_suggested` decisions as a survivor override: passing
   * the loser id flips which entity survives the merge, passing the winner id
   * is a no-op, and any other id throws.
   */
  selectedEntityId?: string;
}

type DecisionStatus = 'pending' | 'auto_applied' | 'approved' | 'rejected' | 'modified' | 'snoozed' | 'expired';

function nowIso(): string {
  return new Date().toISOString();
}

function isIsoDateString(value: string): boolean {
  // Accept ISO-ish timestamps. Date.parse handles a wide set, but that's OK here.
  return !Number.isNaN(Date.parse(value));
}

async function fetchDecision(decisionId: string): Promise<any> {
  const { data, error } = await supabase
    .from('system_decisions')
    .select('*')
    .eq('id', decisionId)
    .single();

  if (error || !data) {
    throw new Error(`System decision not found: ${decisionId}`);
  }

  return data;
}

function assertAuthorized(decision: any, userId: string): void {
  if (!decision?.user_id) {
    throw new Error('Decision is missing user_id');
  }
  if (decision.user_id !== userId) {
    throw new Error('Unauthorized: decision does not belong to user');
  }
}

async function updateDecision(decisionId: string, updates: Record<string, unknown>): Promise<void> {
  const { error } = await supabase
    .from('system_decisions')
    .update(updates)
    .eq('id', decisionId);

  if (error) {
    throw new Error(`Failed to update system decision ${decisionId}: ${error.message}`);
  }
}

function mapActionToStatus(action: FeedbackAction): Exclude<DecisionStatus, 'pending' | 'auto_applied'> {
  if (action === 'approve') return 'approved';
  if (action === 'reject') return 'rejected';
  if (action === 'modify') return 'modified';
  if (action === 'snooze') return 'snoozed';
  // "dismiss" is a UI concept; persist as "rejected" and hide from user by default.
  return 'rejected';
}

export async function handleClarificationFeedback(input: {
  decisionId: string;
  userId: string;
  action: Exclude<FeedbackAction, 'snooze' | 'dismiss'>; // approve/reject/modify
  clarificationText?: string;
  resolutionNotes?: string;
}): Promise<OrchestratorResult> {
  const { decisionId, userId, action, clarificationText, resolutionNotes } = input;

  if (action === 'reject') {
    // User chose "Continue without more context": resolve decision, set artifact flag so
    // analyze step accepts low confidence and proceeds, then resume workflow in background.
    const decision = await fetchDecision(decisionId);
    assertAuthorized(decision, userId);

    await updateDecision(decisionId, {
      status: 'rejected',
      resolved_at: nowIso(),
      resolved_by: userId,
      resolution_notes: resolutionNotes || 'User rejected clarification request',
    });

    const payload = (decision.decision_payload || {}) as Record<string, unknown>;
    const workflowId = payload.workflowId as string | undefined;
    const artifactId = decision.artifact_id as string | undefined;
    const workflowStepId =
      typeof payload.workflowStepId === 'number'
        ? payload.workflowStepId
        : undefined;

    if (artifactId) {
      const { data: artifact } = await supabase
        .from('artifacts')
        .select('processing_metadata')
        .eq('id', artifactId)
        .single();
      const meta = (artifact?.processing_metadata as Record<string, unknown>) || {};
      await supabase
        .from('artifacts')
        .update({
          processing_metadata: { ...meta, user_continued_without_clarification: true },
        })
        .eq('id', artifactId);
    }

    if (typeof workflowStepId === 'number') {
      await supabase
        .from('workflow_steps')
        .update({
          status: 'pending',
          notification_id: null,
          message: 'User continued without context, resuming analysis',
        })
        .eq('id', workflowStepId);
    }

    // Set workflow to in_progress immediately so the UI (Realtime) shows "Processing" not "Paused"
    if (workflowId) {
      await supabase
        .from('workflows')
        .update({
          status: 'in_progress',
          last_message: 'Resuming after you continued without context',
        })
        .eq('id', workflowId);
    }

    if (workflowId) {
      continueWorkflowFromAnalysis(workflowId).catch((err: unknown) => {
        logger.error('[Feedback] Background workflow resume after continue-without-context failed', {
          workflowId,
          decisionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return {
      success: true,
      workflowId: workflowId || 'unknown',
      status: 'partial',
      completedSteps: [],
      skippedSteps: [],
    };
  }

  const text = (clarificationText || '').trim();
  if (!text) {
    throw new Error('Missing clarificationText');
  }

  // Apply clarification and resume from analysis.
  return handleAnalysisFeedback({
    decisionId,
    clarificationText: text,
    resolvedBy: userId,
  });
}

export async function handleEntityDisambiguationFeedback(input: {
  decisionId: string;
  userId: string;
  action: Exclude<FeedbackAction, 'snooze' | 'dismiss'>; // approve/reject/modify
  selectedEntityId?: string;
  resolutionNotes?: string;
}): Promise<OrchestratorResult> {
  const { decisionId, userId, action, selectedEntityId, resolutionNotes } = input;

  if ((action === 'approve' || action === 'modify') && (!selectedEntityId || !selectedEntityId.trim())) {
    throw new Error('Missing selectedEntityId');
  }

  return handleEntityFeedback({
    decisionId,
    action,
    resolvedBy: userId,
    selectedEntityId: selectedEntityId?.trim(),
    resolutionNotes,
  });
}

export async function handleEntityCreationFeedback(input: {
  decisionId: string;
  userId: string;
  action: Exclude<FeedbackAction, 'snooze' | 'dismiss'>; // approve/reject/modify
  resolutionNotes?: string;
}): Promise<OrchestratorResult> {
  const { decisionId, userId, action, resolutionNotes } = input;
  return handleEntityFeedback({
    decisionId,
    action,
    resolvedBy: userId,
    resolutionNotes,
  });
}

export async function handleEntityMatchFeedback(input: {
  decisionId: string;
  userId: string;
  action: Exclude<FeedbackAction, 'snooze' | 'dismiss'>; // approve/reject/modify
  resolutionNotes?: string;
}): Promise<OrchestratorResult> {
  const { decisionId, userId, action, resolutionNotes } = input;
  return handleEntityFeedback({
    decisionId,
    action,
    resolvedBy: userId,
    resolutionNotes,
  });
}

export async function handleDismissal(input: {
  decisionId: string;
  userId: string;
  resolutionNotes?: string;
}): Promise<void> {
  const { decisionId, userId, resolutionNotes } = input;
  const decision = await fetchDecision(decisionId);
  assertAuthorized(decision, userId);

  await updateDecision(decisionId, {
    status: 'rejected',
    user_visible: false,
    resolved_at: nowIso(),
    resolved_by: userId,
    resolution_notes: resolutionNotes || 'Dismissed by user',
  });
}

export async function handleSnooze(input: {
  decisionId: string;
  userId: string;
  snoozeUntil: string;
  resolutionNotes?: string;
}): Promise<void> {
  const { decisionId, userId, snoozeUntil, resolutionNotes } = input;

  if (!snoozeUntil || !isIsoDateString(snoozeUntil)) {
    throw new Error('Invalid snoozeUntil');
  }

  const decision = await fetchDecision(decisionId);
  assertAuthorized(decision, userId);

  const currentCount = typeof decision.snooze_count === 'number' ? decision.snooze_count : 0;

  await updateDecision(decisionId, {
    status: 'snoozed',
    snoozed_until: snoozeUntil,
    snooze_count: currentCount + 1,
    resolved_at: nowIso(),
    resolved_by: userId,
    resolution_notes: resolutionNotes || 'Snoozed by user',
  });
}

/**
 * Main entrypoint: validate, authorize, apply feedback, and resume workflow if applicable.
 */
export async function handleUserFeedback(input: HandleUserFeedbackInput): Promise<OrchestratorResult | void> {
  const { decisionId, userId, action } = input;

  if (!decisionId || !decisionId.trim()) throw new Error('Missing decisionId');
  if (!userId || !userId.trim()) throw new Error('Missing userId');

  const decision = await fetchDecision(decisionId);
  assertAuthorized(decision, userId);

  // Snooze/dismiss are handled uniformly.
  if (action === 'dismiss') {
    await handleDismissal({ decisionId, userId, resolutionNotes: input.resolutionNotes });
    return;
  }
  if (action === 'snooze') {
    if (!input.snoozeUntil) throw new Error('Missing snoozeUntil');
    await handleSnooze({ decisionId, userId, snoozeUntil: input.snoozeUntil, resolutionNotes: input.resolutionNotes });
    return;
  }

  // Decision-type-specific handlers (blocking workflow decisions).
  const decisionType = String(decision.decision_type || '');
  if (decisionType === 'clarification_needed') {
    return handleClarificationFeedback({
      decisionId,
      userId,
      action,
      clarificationText: input.clarificationText,
      resolutionNotes: input.resolutionNotes,
    });
  }

  if (decisionType === 'entity_disambiguation') {
    return handleEntityDisambiguationFeedback({
      decisionId,
      userId,
      action,
      selectedEntityId: input.selectedEntityId,
      resolutionNotes: input.resolutionNotes,
    });
  }

  if (decisionType === 'confirm_entity_creation') {
    if (action === 'reject') {
      await updateDecision(decisionId, {
        status: 'rejected',
        resolved_at: nowIso(),
        resolved_by: userId,
        resolution_notes: input.resolutionNotes || null,
      });
      const payload = (decision.decision_payload || {}) as Record<string, unknown>;
      const workflowId = payload.workflowId ?? payload.workflow_id;
      if (workflowId && typeof workflowId === 'string') {
        try {
          return resumePausedWorkflow(String(workflowId));
        } catch (err: unknown) {
          logger.warn('[Feedback] Resume after confirm_entity_creation reject failed', {
            decisionId,
            workflowId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return;
    }
    return handleEntityCreationFeedback({
      decisionId,
      userId,
      action,
      resolutionNotes: input.resolutionNotes,
    });
  }

  if (decisionType === 'confirm_entity_match') {
    return handleEntityMatchFeedback({
      decisionId,
      userId,
      action,
      resolutionNotes: input.resolutionNotes,
    });
  }

  if (decisionType === 'entity_creation_skipped') {
    if (action === 'approve') {
      await handleEntityCreationSkippedFeedback({
        decisionId,
        resolvedBy: userId,
        resolutionNotes: input.resolutionNotes,
      });
    } else {
      await updateDecision(decisionId, {
        status: mapActionToStatus(action),
        resolved_at: nowIso(),
        resolved_by: userId,
        resolution_notes: input.resolutionNotes || null,
      });
    }
    return;
  }

  if (decisionType === 'entity_created') {
    if (action === 'reject') {
      await handleEntityCreatedRejectFeedback({
        decisionId,
        resolvedBy: userId,
        resolutionNotes: input.resolutionNotes,
      });
    } else {
      await updateDecision(decisionId, {
        status: mapActionToStatus(action),
        resolved_at: nowIso(),
        resolved_by: userId,
        resolution_notes: input.resolutionNotes || null,
      });
    }
    return;
  }

  if (decisionType === 'relationship_suggested') {
    // Approve/modify write the typed edge; reject just resolves the decision.
    // No workflow resume — this decision family never blocks the workflow.
    await handleRelationshipSuggestedFeedback({
      decisionId,
      action,
      resolvedBy: userId,
      resolutionNotes: input.resolutionNotes,
    });
    return;
  }

  if (decisionType === 'merge_suggested') {
    // Approve/modify repoint edges+links loser->winner and tombstone the loser;
    // reject just resolves the decision. Non-blocking (issue #174).
    // selectedEntityId lets the user override which of the pair survives (#310)
    // — omit to accept the auto-oriented winner; pass the loser's id to flip.
    await handleMergeSuggestedFeedback({
      decisionId,
      action,
      resolvedBy: userId,
      resolutionNotes: input.resolutionNotes,
      selectedEntityId: input.selectedEntityId,
    });
    return;
  }

  // Fallback: mark decision resolved and try to resume workflow (if linked).
  const status = mapActionToStatus(action);

  await updateDecision(decisionId, {
    status,
    resolved_at: nowIso(),
    resolved_by: userId,
    resolution_notes: input.resolutionNotes || null,
  });

  const workflowId = (decision.decision_payload as any)?.workflowId;
  if (workflowId) {
    try {
      return resumePausedWorkflow(String(workflowId));
    } catch (err: any) {
      logger.warn('[Feedback] Resume after fallback decision resolution failed', { decisionId, workflowId, error: err?.message });
    }
  }

  // No workflow to resume; return void to indicate feedback applied.
  return;
}

