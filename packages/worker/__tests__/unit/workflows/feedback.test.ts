/**
 * Unit tests for workflow feedback handler.
 */

import * as Resume from '../../../src/workflows/resume';
import {
  handleUserFeedback,
  handleSnooze,
  handleDismissal,
} from '../../../src/workflows/feedback';
import { createMockWorkflowStep } from '../../helpers/fixtures';
import {
  resetMockData,
  setMockData,
  getMockData,
  resetMockStorage,
  resetMockSupabase,
} from '../../__mocks__/supabase';

jest.mock('../../../src/workflows/resume', () => {
  const actual = jest.requireActual('../../../src/workflows/resume');
  return {
    ...actual,
    handleAnalysisFeedback: jest.fn(),
    handleEntityFeedback: jest.fn(),
    resumeWorkflow: jest.fn(),
    continueWorkflowFromAnalysis: jest.fn(),
  };
});

const mockHandleAnalysisFeedback = Resume.handleAnalysisFeedback as unknown as jest.Mock;
const mockHandleEntityFeedback = Resume.handleEntityFeedback as unknown as jest.Mock;
const mockResumeWorkflow = Resume.resumeWorkflow as unknown as jest.Mock;
const mockContinueWorkflowFromAnalysis = Resume.continueWorkflowFromAnalysis as unknown as jest.Mock;

function decisionBase(overrides: Partial<any> = {}) {
  return {
    id: 'decision-1',
    decision_type: 'clarification_needed',
    stage: 'extract',
    title: 'Need clarification',
    description: null,
    confidence_score: 30,
    blocking: true,
    user_visible: true,
    requires_user_action: true,
    status: 'pending',
    review_type: 'clarification',
    snooze_count: 0,
    artifact_id: 'artifact-1',
    workflow_task_id: 3,
    decision_payload: {
      artifactId: 'artifact-1',
      workflowId: 'workflow-1',
      workflowStepId: 3,
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    user_id: 'user-123',
    team_id: 1,
    ...overrides,
  };
}

describe('workflow feedback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMockData();
    resetMockStorage();
    resetMockSupabase();
    mockHandleAnalysisFeedback.mockReset();
    mockHandleEntityFeedback.mockReset();
    mockResumeWorkflow.mockReset();
    mockContinueWorkflowFromAnalysis.mockReset();
  });

  afterEach(() => {
    jest.clearAllMocks();
    resetMockData();
    resetMockStorage();
    resetMockSupabase();
  });

  it('rejects unauthorized user', async () => {
    setMockData('system_decisions', [decisionBase({ user_id: 'user-other' })]);

    await expect(handleUserFeedback({
      decisionId: 'decision-1',
      userId: 'user-123',
      action: 'approve',
      clarificationText: 'text',
    })).rejects.toThrow('Unauthorized');
  });

  it('validates snooze requires snoozeUntil', async () => {
    setMockData('system_decisions', [decisionBase()]);

    await expect(handleUserFeedback({
      decisionId: 'decision-1',
      userId: 'user-123',
      action: 'snooze',
    } as any)).rejects.toThrow('Missing snoozeUntil');
  });

  it('handleSnooze increments snooze_count and sets snoozed_until', async () => {
    setMockData('system_decisions', [decisionBase({ snooze_count: 1 })]);

    await handleSnooze({
      decisionId: 'decision-1',
      userId: 'user-123',
      snoozeUntil: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
    });

    const decisions = getMockData('system_decisions');
    expect(decisions[0].status).toBe('snoozed');
    expect(decisions[0].snooze_count).toBe(2);
    expect(decisions[0].snoozed_until).toBeTruthy();
  });

  it('handleDismissal hides decision from user', async () => {
    setMockData('system_decisions', [decisionBase()]);

    await handleDismissal({ decisionId: 'decision-1', userId: 'user-123' });

    const decisions = getMockData('system_decisions');
    expect(decisions[0].status).toBe('rejected');
    expect(decisions[0].user_visible).toBe(false);
  });

  it('clarification_needed requires clarificationText for approve/modify', async () => {
    setMockData('system_decisions', [decisionBase({ decision_type: 'clarification_needed' })]);

    await expect(handleUserFeedback({
      decisionId: 'decision-1',
      userId: 'user-123',
      action: 'modify',
    })).rejects.toThrow('Missing clarificationText');
  });

  it('clarification_needed delegates to handleAnalysisFeedback when provided', async () => {
    setMockData('system_decisions', [decisionBase({ decision_type: 'clarification_needed' })]);
    mockHandleAnalysisFeedback.mockResolvedValue({
      success: true,
      workflowId: 'workflow-1',
      status: 'partial',
      completedSteps: [],
      skippedSteps: [],
    });

    const result = await handleUserFeedback({
      decisionId: 'decision-1',
      userId: 'user-123',
      action: 'modify',
      clarificationText: 'more context',
    });

    expect(mockHandleAnalysisFeedback).toHaveBeenCalledWith(expect.objectContaining({
      decisionId: 'decision-1',
      clarificationText: 'more context',
      resolvedBy: 'user-123',
    }));
    expect((result as any).workflowId).toBe('workflow-1');
  });

  it('entity_disambiguation requires selectedEntityId for approve/modify', async () => {
    setMockData('system_decisions', [decisionBase({ decision_type: 'entity_disambiguation' })]);

    await expect(handleUserFeedback({
      decisionId: 'decision-1',
      userId: 'user-123',
      action: 'approve',
    })).rejects.toThrow('Missing selectedEntityId');
  });

  it('entity_disambiguation delegates to handleEntityFeedback', async () => {
    setMockData('system_decisions', [decisionBase({ decision_type: 'entity_disambiguation' })]);
    mockHandleEntityFeedback.mockResolvedValue({
      success: true,
      workflowId: 'workflow-1',
      status: 'partial',
      completedSteps: [],
      skippedSteps: [],
    });

    const result = await handleUserFeedback({
      decisionId: 'decision-1',
      userId: 'user-123',
      action: 'approve',
      selectedEntityId: 'entity-1',
    });

    expect(mockHandleEntityFeedback).toHaveBeenCalledWith(expect.objectContaining({
      decisionId: 'decision-1',
      action: 'approve',
      resolvedBy: 'user-123',
      selectedEntityId: 'entity-1',
    }));
    expect((result as any).workflowId).toBe('workflow-1');
  });

  it('fallback resolves unknown decision types and attempts resume', async () => {
    setMockData('system_decisions', [decisionBase({ decision_type: 'something_else' })]);
    mockResumeWorkflow.mockResolvedValue({
      success: true,
      workflowId: 'workflow-1',
      status: 'partial',
      completedSteps: [],
      skippedSteps: [],
    });

    const result = await handleUserFeedback({
      decisionId: 'decision-1',
      userId: 'user-123',
      action: 'approve',
      resolutionNotes: 'ok',
    });

    expect(getMockData('system_decisions')[0].status).toBe('approved');
    expect(mockResumeWorkflow).toHaveBeenCalledWith('workflow-1');
    expect((result as any).workflowId).toBe('workflow-1');
  });

  it('fallback resolves and returns void when no workflowId exists', async () => {
    setMockData('system_decisions', [decisionBase({
      decision_type: 'something_else',
      decision_payload: {},
    })]);

    const result = await handleUserFeedback({
      decisionId: 'decision-1',
      userId: 'user-123',
      action: 'approve',
    });

    expect(getMockData('system_decisions')[0].status).toBe('approved');
    expect(result).toBeUndefined();
  });

  it('confirm_entity_creation delegates to handleEntityFeedback', async () => {
    setMockData('system_decisions', [decisionBase({ decision_type: 'confirm_entity_creation' })]);
    mockHandleEntityFeedback.mockResolvedValue({
      success: true,
      workflowId: 'workflow-1',
      status: 'partial',
      completedSteps: [],
      skippedSteps: [],
    });

    const result = await handleUserFeedback({
      decisionId: 'decision-1',
      userId: 'user-123',
      action: 'approve',
      resolutionNotes: 'yes',
    });

    expect(mockHandleEntityFeedback).toHaveBeenCalledWith(expect.objectContaining({
      decisionId: 'decision-1',
      action: 'approve',
      resolvedBy: 'user-123',
    }));
    expect((result as any).workflowId).toBe('workflow-1');
  });

  it('confirm_entity_match delegates to handleEntityFeedback', async () => {
    setMockData('system_decisions', [decisionBase({ decision_type: 'confirm_entity_match' })]);
    mockHandleEntityFeedback.mockResolvedValue({
      success: true,
      workflowId: 'workflow-1',
      status: 'partial',
      completedSteps: [],
      skippedSteps: [],
    });

    const result = await handleUserFeedback({
      decisionId: 'decision-1',
      userId: 'user-123',
      action: 'reject',
      resolutionNotes: 'nope',
    });

    expect(mockHandleEntityFeedback).toHaveBeenCalledWith(expect.objectContaining({
      decisionId: 'decision-1',
      action: 'reject',
      resolvedBy: 'user-123',
      resolutionNotes: 'nope',
    }));
    expect((result as any).workflowId).toBe('workflow-1');
  });

  it('clarification reject resolves decision, sets artifact flag, and resumes workflow in background', async () => {
    setMockData('system_decisions', [decisionBase({ decision_type: 'clarification_needed' })]);
    setMockData('artifacts', [{ id: 'artifact-1', processing_metadata: {} }]);
    mockContinueWorkflowFromAnalysis.mockResolvedValue({
      success: true,
      workflowId: 'workflow-1',
      status: 'partial',
      completedSteps: [],
      skippedSteps: [],
    });

    const result = await handleUserFeedback({
      decisionId: 'decision-1',
      userId: 'user-123',
      action: 'reject',
      resolutionNotes: 'skip',
    });

    expect(getMockData('system_decisions')[0].status).toBe('rejected');
    expect(mockContinueWorkflowFromAnalysis).toHaveBeenCalledWith('workflow-1');
    expect((result as any).workflowId).toBe('workflow-1');
    expect((result as any).status).toBe('partial');
  });

  it('dismiss action returns void (no resume attempt)', async () => {
    setMockData('system_decisions', [decisionBase()]);

    const result = await handleUserFeedback({
      decisionId: 'decision-1',
      userId: 'user-123',
      action: 'dismiss',
    });

    expect(result).toBeUndefined();
    expect(getMockData('system_decisions')[0].user_visible).toBe(false);
    expect(mockResumeWorkflow).not.toHaveBeenCalled();
  });

  it('snooze action returns void (no resume attempt)', async () => {
    setMockData('system_decisions', [decisionBase()]);

    const result = await handleUserFeedback({
      decisionId: 'decision-1',
      userId: 'user-123',
      action: 'snooze',
      snoozeUntil: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
    });

    expect(result).toBeUndefined();
    expect(getMockData('system_decisions')[0].status).toBe('snoozed');
    expect(mockResumeWorkflow).not.toHaveBeenCalled();
  });

  describe('relationship_suggested (#178)', () => {
    function relationshipDecisionBase(overrides: Partial<any> = {}) {
      return decisionBase({
        decision_type: 'relationship_suggested',
        stage: 'contextualize',
        title: 'Suggested relationship',
        confidence_score: 55,
        blocking: false,
        review_type: 'approval',
        decision_payload: {
          fromEntityId: 'entity-alice',
          toEntityId: 'entity-bob',
          fromEntityName: 'Alice',
          toEntityName: 'Bob',
          relationshipType: 'friendOf',
          confidence: 0.55,
          artifactId: 'artifact-1',
        },
        ...overrides,
      });
    }

    it('approve writes the typed edge (dedupe-safe) and resolves the decision, without resuming a workflow', async () => {
      setMockData('system_decisions', [relationshipDecisionBase()]);
      setMockData('entity_relationships', []);

      const result = await handleUserFeedback({
        decisionId: 'decision-1',
        userId: 'user-123',
        action: 'approve',
      });

      const edges = getMockData('entity_relationships');
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({
        user_id: 'user-123',
        from_entity_id: 'entity-alice',
        to_entity_id: 'entity-bob',
        relationship_type: 'friendOf',
        created_by: 'user-123',
      });

      expect(getMockData('system_decisions')[0].status).toBe('approved');
      expect(mockResumeWorkflow).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('approve is dedupe-safe: does not create a duplicate edge if one already exists for (user, from, to, type)', async () => {
      setMockData('system_decisions', [relationshipDecisionBase()]);
      setMockData('entity_relationships', [
        {
          id: 'existing-edge',
          user_id: 'user-123',
          from_entity_id: 'entity-alice',
          to_entity_id: 'entity-bob',
          relationship_type: 'friendOf',
          confidence_score: 40,
        },
      ]);

      await handleUserFeedback({
        decisionId: 'decision-1',
        userId: 'user-123',
        action: 'approve',
      });

      const edges = getMockData('entity_relationships');
      expect(edges).toHaveLength(1);
      expect(edges[0].id).toBe('existing-edge');
      // Updated in place rather than duplicated.
      expect(edges[0].confidence_score).toBe(55);
    });

    it('reject resolves the decision without writing an edge', async () => {
      setMockData('system_decisions', [relationshipDecisionBase()]);
      setMockData('entity_relationships', []);

      const result = await handleUserFeedback({
        decisionId: 'decision-1',
        userId: 'user-123',
        action: 'reject',
        resolutionNotes: 'not related',
      });

      expect(getMockData('entity_relationships')).toHaveLength(0);
      expect(getMockData('system_decisions')[0].status).toBe('rejected');
      expect(mockResumeWorkflow).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('approve falls back to "other" for an unrecognised relationship type without crashing', async () => {
      setMockData('system_decisions', [
        relationshipDecisionBase({
          decision_payload: {
            fromEntityId: 'entity-alice',
            toEntityId: 'entity-bob',
            relationshipType: 'totally_unrecognised_phrase',
            confidence: 0.9,
            artifactId: 'artifact-1',
          },
        }),
      ]);
      setMockData('entity_relationships', []);

      await expect(handleUserFeedback({
        decisionId: 'decision-1',
        userId: 'user-123',
        action: 'approve',
      })).resolves.not.toThrow();

      const edges = getMockData('entity_relationships');
      expect(edges).toHaveLength(1);
      expect(edges[0].relationship_type).toBe('other');
      expect(edges[0].notes).toContain('totally_unrecognised_phrase');
    });
  });

  describe('merge_suggested selectedEntityId pass-through (#310)', () => {
    // handleMergeSuggestedFeedback is NOT mocked in the module factory above
    // (only handleAnalysisFeedback/handleEntityFeedback/resumeWorkflow/
    // continueWorkflowFromAnalysis are), so these exercise the real merge
    // logic end-to-end through handleUserFeedback.
    function mergeDecisionBase(overrides: Partial<any> = {}) {
      return decisionBase({
        decision_type: 'merge_suggested',
        stage: 'contextualize',
        title: 'Suggested merge',
        confidence_score: 90,
        blocking: false,
        review_type: 'approval',
        decision_payload: { winnerEntityId: 'w', loserEntityId: 'l' },
        ...overrides,
      });
    }

    function seedMergeEntities() {
      setMockData('entities', [
        { id: 'w', title: 'Angus Hally', entity_type: 'people', user_id: 'user-123', archived: false, properties: {} },
        { id: 'l', title: 'Angus', entity_type: 'people', user_id: 'user-123', archived: false, properties: {} },
      ]);
    }

    it('threads selectedEntityId through to flip the merge survivor', async () => {
      setMockData('system_decisions', [mergeDecisionBase()]);
      seedMergeEntities();

      await handleUserFeedback({
        decisionId: 'decision-1',
        userId: 'user-123',
        action: 'approve',
        selectedEntityId: 'l',
      });

      const entities = getMockData('entities');
      expect(entities.find((e: any) => e.id === 'w').archived).toBe(true);
      expect(entities.find((e: any) => e.id === 'l').archived).toBe(false);

      const decision = getMockData('system_decisions')[0];
      expect(decision.decision_payload.survivorOverridden).toBe(true);
    });

    it('without selectedEntityId, merges using the auto-oriented winner (survivorOverridden false)', async () => {
      setMockData('system_decisions', [mergeDecisionBase()]);
      seedMergeEntities();

      await handleUserFeedback({
        decisionId: 'decision-1',
        userId: 'user-123',
        action: 'approve',
      });

      const entities = getMockData('entities');
      expect(entities.find((e: any) => e.id === 'l').archived).toBe(true);
      expect(entities.find((e: any) => e.id === 'w').archived).toBe(false);

      const decision = getMockData('system_decisions')[0];
      expect(decision.decision_payload.survivorOverridden).toBe(false);
    });
  });
});

