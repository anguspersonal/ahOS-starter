/**
 * Unit tests for resume workflow helpers.
 */

import {
  handleAnalysisFeedback,
  handleEntityFeedback,
  handleEntityCreationSkippedFeedback,
  handleEntityCreatedRejectFeedback,
  resumeWorkflow,
} from '../../../src/workflows/resume';
import { executeAnalyzeStep } from '../../../src/workflows/steps/analyze';
import { executeUploadStep } from '../../../src/workflows/steps/upload';
import { executeCreateArtifactStep } from '../../../src/workflows/steps/createArtifact';
import {
  createMockWorkflow,
  createMockWorkflowStep,
  createMockArtifact,
  TEST_WORKFLOW_ID,
  TEST_ARTIFACT_ID,
} from '../../helpers/fixtures';
import {
  resetMockData,
  setMockData,
  getMockData,
  resetMockStorage,
  resetMockSupabase,
} from '../../__mocks__/supabase';

jest.mock('../../../src/workflows/steps/analyze');
jest.mock('../../../src/workflows/steps/upload');
jest.mock('../../../src/workflows/steps/createArtifact');

const mockExecuteAnalyzeStep = executeAnalyzeStep as jest.MockedFunction<typeof executeAnalyzeStep>;
const mockExecuteUploadStep = executeUploadStep as jest.MockedFunction<typeof executeUploadStep>;
const mockExecuteCreateArtifactStep = executeCreateArtifactStep as jest.MockedFunction<typeof executeCreateArtifactStep>;

function baseDecision(overrides: Partial<any> = {}) {
  return {
    id: 'decision-1',
    decision_type: 'clarification_needed',
    stage: 'extract',
    title: 'Help me understand this artifact',
    description: null,
    confidence_score: 30,
    blocking: true,
    user_visible: true,
    requires_user_action: true,
    status: 'pending',
    review_type: 'clarification',
    snooze_count: 0,
    artifact_id: TEST_ARTIFACT_ID,
    workflow_task_id: 3,
    decision_payload: {
      artifactId: TEST_ARTIFACT_ID,
      workflowId: TEST_WORKFLOW_ID,
      workflowStepId: 3,
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    user_id: 'user-123',
    team_id: 1,
    ...overrides,
  };
}

describe('resume workflow helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMockData();
    resetMockStorage();
    resetMockSupabase();
    mockExecuteAnalyzeStep.mockReset();
    mockExecuteUploadStep.mockReset();
    mockExecuteCreateArtifactStep.mockReset();
  });

  afterEach(() => {
    jest.clearAllMocks();
    resetMockData();
    resetMockStorage();
    resetMockSupabase();
  });

  it('resumeWorkflow should block if there are pending blocking decisions', async () => {
    const workflow = createMockWorkflow({
      id: TEST_WORKFLOW_ID,
      status: 'awaiting_user',
      source_artifact_id: TEST_ARTIFACT_ID,
    });
    setMockData('workflows', [workflow]);

    const steps = [
      createMockWorkflowStep({ id: 1, workflow_id: TEST_WORKFLOW_ID, step_type: 'upload', step_order: 0, status: 'completed' }),
      createMockWorkflowStep({ id: 2, workflow_id: TEST_WORKFLOW_ID, step_type: 'create_artifact', step_order: 1, status: 'completed' }),
      createMockWorkflowStep({ id: 3, workflow_id: TEST_WORKFLOW_ID, step_type: 'analyze', step_order: 2, status: 'pending', notification_id: 'decision-1' }),
    ];
    setMockData('workflow_steps', steps);
    setMockData('system_decisions', [baseDecision()]);

    const result = await resumeWorkflow(TEST_WORKFLOW_ID);

    expect(result.status).toBe('awaiting_user');
    expect(mockExecuteAnalyzeStep).not.toHaveBeenCalled();
  });

  it('should resolve decision and update artifact on clarification (workflow resumes in background)', async () => {
    const workflow = createMockWorkflow({
      id: TEST_WORKFLOW_ID,
      status: 'awaiting_user',
      source_artifact_id: TEST_ARTIFACT_ID,
    });
    setMockData('workflows', [workflow]);

    const artifact = createMockArtifact({ id: TEST_ARTIFACT_ID, user_id: 'user-123', content: { text: '' } });
    setMockData('artifacts', [artifact]);

    const steps = [
      createMockWorkflowStep({ id: 1, workflow_id: TEST_WORKFLOW_ID, step_type: 'upload', step_order: 0, status: 'completed' }),
      createMockWorkflowStep({ id: 2, workflow_id: TEST_WORKFLOW_ID, step_type: 'create_artifact', step_order: 1, status: 'completed' }),
      createMockWorkflowStep({ id: 3, workflow_id: TEST_WORKFLOW_ID, step_type: 'analyze', step_order: 2, status: 'pending', notification_id: 'decision-1' }),
    ];
    setMockData('workflow_steps', steps);
    setMockData('system_decisions', [baseDecision()]);

    const result = await handleAnalysisFeedback({
      decisionId: 'decision-1',
      clarificationText: 'These are meeting notes about roadmap planning.',
      resolvedBy: 'user-123',
    });

    // API returns immediately; workflow resume runs in background
    expect(result.workflowId).toBe(TEST_WORKFLOW_ID);
    expect(result.status).toBe('partial');
    expect(result.success).toBe(true);

    const decisions = getMockData('system_decisions');
    expect(decisions[0].status).toBe('modified');
    expect(decisions[0].resolved_at).toBeTruthy();

    const artifacts = getMockData('artifacts');
    expect(artifacts[0].content.text).toContain('roadmap planning');
  });

  it('should re-pause after resume if analysis is still awaiting_user', async () => {
    const workflow = createMockWorkflow({
      id: TEST_WORKFLOW_ID,
      status: 'awaiting_user',
      source_artifact_id: TEST_ARTIFACT_ID,
    });
    setMockData('workflows', [workflow]);

    const artifact = createMockArtifact({ id: TEST_ARTIFACT_ID, user_id: 'user-123', content: { text: '' } });
    setMockData('artifacts', [artifact]);

    const steps = [
      createMockWorkflowStep({ id: 1, workflow_id: TEST_WORKFLOW_ID, step_type: 'upload', step_order: 0, status: 'completed' }),
      createMockWorkflowStep({ id: 2, workflow_id: TEST_WORKFLOW_ID, step_type: 'create_artifact', step_order: 1, status: 'completed' }),
      createMockWorkflowStep({ id: 3, workflow_id: TEST_WORKFLOW_ID, step_type: 'analyze', step_order: 2, status: 'pending', notification_id: 'decision-1' }),
    ];
    setMockData('workflow_steps', steps);
    setMockData('system_decisions', [baseDecision()]);

    mockExecuteAnalyzeStep.mockResolvedValue({
      success: true,
      status: 'awaiting_user',
      confidence: 0.2,
      notificationId: 'decision-2',
      analysisResult: {
        intent: 'unclear',
        confidence: 0.2,
        entities_mentioned: [],
        actions_suggested: [],
        topics: [],
        sentiment: 'neutral',
      },
    } as any);

    const result = await handleAnalysisFeedback({
      decisionId: 'decision-1',
      clarificationText: 'More context, but still ambiguous.',
      resolvedBy: 'user-123',
    });

    // Workflow resume runs in background; API returns immediately with partial success
    expect(result.status).toBe('partial');
    expect(result.workflowId).toBe(TEST_WORKFLOW_ID);
  });

  it('should resume from entity disambiguation and continue workflow', async () => {
    const workflow = createMockWorkflow({
      id: TEST_WORKFLOW_ID,
      status: 'awaiting_user',
      source_artifact_id: TEST_ARTIFACT_ID,
    });
    setMockData('workflows', [workflow]);

    const artifact = createMockArtifact({ id: TEST_ARTIFACT_ID, user_id: 'user-123' });
    setMockData('artifacts', [artifact]);

    const steps = [
      createMockWorkflowStep({ id: 1, workflow_id: TEST_WORKFLOW_ID, step_type: 'upload', step_order: 0, status: 'completed' }),
      createMockWorkflowStep({ id: 2, workflow_id: TEST_WORKFLOW_ID, step_type: 'create_artifact', step_order: 1, status: 'completed' }),
      createMockWorkflowStep({
        id: 3,
        workflow_id: TEST_WORKFLOW_ID,
        step_type: 'analyze',
        step_order: 2,
        status: 'completed',
        output: {
          intent: 'meeting_notes',
          confidence: 0.9,
          entities_mentioned: [],
          actions_suggested: [],
          topics: [],
          sentiment: 'neutral',
        },
      }),
      createMockWorkflowStep({ id: 4, workflow_id: TEST_WORKFLOW_ID, step_type: 'organize_entities', step_order: 3, status: 'running' }),
    ];
    setMockData('workflow_steps', steps);

    const decision = baseDecision({
      id: 'decision-entity-1',
      decision_type: 'entity_disambiguation',
      stage: 'contextualize',
      review_type: 'approval',
      workflow_task_id: 4,
      decision_payload: {
        workflowId: TEST_WORKFLOW_ID,
        artifactId: TEST_ARTIFACT_ID,
        workflowStepId: 4,
        entityMention: { name: 'Acme', type: 'project', confidence: 0.4 },
        candidates: [{ id: 'entity-1', title: 'Acme', type: 'project', confidence: 0.5 }],
      },
    });
    setMockData('system_decisions', [decision]);

    const result = await handleEntityFeedback({
      decisionId: 'decision-entity-1',
      action: 'approve',
      selectedEntityId: 'entity-1',
      resolvedBy: 'user-123',
      resolutionNotes: 'Chose the existing Acme project',
    });

    expect(result.workflowId).toBe(TEST_WORKFLOW_ID);
    expect(result.status).not.toBe('failed');

    const links = getMockData('artifact_entity_links');
    expect(links.length).toBe(1);
    expect(links[0].artifact_id).toBe(TEST_ARTIFACT_ID);
    expect(links[0].entity_id).toBe('entity-1');
    expect(links[0].user_id).toBe('user-123');

    const decisions = getMockData('system_decisions');
    expect(decisions[0].status).toBe('approved');

    const updatedSteps = getMockData('workflow_steps');
    const organizeStep = updatedSteps.find((s: any) => s.id === 4);
    expect(organizeStep.status).toBe('completed');
  });

  it('should stamp user_id on the link when approving a blocking entity match', async () => {
    // No workflowId/stepId on the decision: the link is still created, resume is skipped.
    const decision = baseDecision({
      id: 'decision-match-1',
      decision_type: 'confirm_entity_match',
      stage: 'contextualize',
      review_type: 'approval',
      blocking: true,
      workflow_task_id: null,
      decision_payload: {
        artifactId: TEST_ARTIFACT_ID,
        candidateEntity: { id: 'entity-9', title: 'Acme' },
      },
    });
    setMockData('system_decisions', [decision]);

    const result = await handleEntityFeedback({
      decisionId: 'decision-match-1',
      action: 'approve',
      resolvedBy: 'user-123',
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('completed');

    const links = getMockData('artifact_entity_links');
    expect(links.length).toBe(1);
    expect(links[0].user_id).toBe('user-123');
    expect(links[0].entity_id).toBe('entity-9');

    const decisions = getMockData('system_decisions');
    expect(decisions[0].status).toBe('approved');
  });

  it('should stamp user_id on entity and link when approving entity creation', async () => {
    const decision = baseDecision({
      id: 'decision-create-1',
      decision_type: 'confirm_entity_creation',
      stage: 'contextualize',
      review_type: 'approval',
      blocking: false,
      decision_payload: {
        artifactId: TEST_ARTIFACT_ID,
        entityMention: { name: 'Jane Smith', type: 'people', confidence: 0.6 },
      },
    });
    setMockData('system_decisions', [decision]);

    const result = await handleEntityFeedback({
      decisionId: 'decision-create-1',
      action: 'approve',
      resolvedBy: 'user-123',
    });

    expect(result.success).toBe(true);

    const entities = getMockData('entities');
    expect(entities.length).toBe(1);
    expect(entities[0].user_id).toBe('user-123');

    const links = getMockData('artifact_entity_links');
    expect(links.length).toBe(1);
    expect(links[0].user_id).toBe('user-123');
    expect(links[0].entity_id).toBe(entities[0].id);
  });

  it('should stamp user_id on entity and link for "Create anyway" on a skipped entity', async () => {
    const decision = baseDecision({
      id: 'decision-skip-1',
      decision_type: 'entity_creation_skipped',
      stage: 'contextualize',
      review_type: 'suggestion',
      blocking: false,
      decision_payload: {
        artifactId: TEST_ARTIFACT_ID,
        entityMention: { name: 'Globex', type: 'project', confidence: 0.4 },
      },
    });
    setMockData('system_decisions', [decision]);

    await handleEntityCreationSkippedFeedback({
      decisionId: 'decision-skip-1',
      resolvedBy: 'user-123',
    });

    const entities = getMockData('entities');
    expect(entities.length).toBe(1);
    expect(entities[0].user_id).toBe('user-123');

    const links = getMockData('artifact_entity_links');
    expect(links.length).toBe(1);
    expect(links[0].user_id).toBe('user-123');
    expect(links[0].entity_id).toBe(entities[0].id);

    const decisions = getMockData('system_decisions');
    expect(decisions[0].status).toBe('approved');
  });

  // #948 step 1 / ADR-079 §3: a correction that does not record which side of
  // the threshold the call fell on cannot recalibrate that threshold.
  describe('confidence_before on captured corrections', () => {
    function skippedDecision(overrides: Partial<any> = {}) {
      return baseDecision({
        id: 'decision-skip-conf',
        decision_type: 'entity_creation_skipped',
        stage: 'contextualize',
        review_type: 'suggestion',
        blocking: false,
        confidence_score: 42,
        decision_payload: {
          artifactId: TEST_ARTIFACT_ID,
          entityMention: { name: 'Globex', type: 'project', confidence: 0.42 },
        },
        ...overrides,
      });
    }

    function rejectDecision(overrides: Partial<any> = {}) {
      return baseDecision({
        id: 'decision-reject-conf',
        decision_type: 'entity_created',
        stage: 'contextualize',
        review_type: 'suggestion',
        blocking: false,
        status: 'auto_applied',
        confidence_score: 91,
        decision_payload: {
          artifactId: TEST_ARTIFACT_ID,
          entityId: 'entity-reject-1',
          entityName: 'Initech',
        },
        ...overrides,
      });
    }

    it('records the raising confidence when a skipped entity is created anyway', async () => {
      setMockData('system_decisions', [skippedDecision()]);

      await handleEntityCreationSkippedFeedback({
        decisionId: 'decision-skip-conf',
        resolvedBy: 'user-123',
      });

      const edits = getMockData('user_edits');
      expect(edits.length).toBe(1);
      expect(edits[0].edit_type).toBe('entity_creation_correction');
      expect(edits[0].confidence_before).toBe(42);
    });

    it('records the raising confidence when an auto-created entity is rejected', async () => {
      setMockData('system_decisions', [rejectDecision()]);
      setMockData('entities', [{ id: 'entity-reject-1', user_id: 'user-123', title: 'Initech' }]);
      setMockData('artifact_entity_links', [
        { id: 1, user_id: 'user-123', artifact_id: TEST_ARTIFACT_ID, entity_id: 'entity-reject-1' },
      ]);

      await handleEntityCreatedRejectFeedback({
        decisionId: 'decision-reject-conf',
        resolvedBy: 'user-123',
      });

      const edits = getMockData('user_edits');
      expect(edits.length).toBe(1);
      expect(edits[0].confidence_before).toBe(91);
    });

    // confidence_score is numeric(5,2) on a 0-100 scale; confidence_before is
    // INTEGER. Rounding here rather than leaning on an implicit cast.
    it('rounds a fractional confidence to an integer', async () => {
      setMockData('system_decisions', [skippedDecision({ confidence_score: 87.5 })]);

      await handleEntityCreationSkippedFeedback({
        decisionId: 'decision-skip-conf',
        resolvedBy: 'user-123',
      });

      expect(getMockData('user_edits')[0].confidence_before).toBe(88);
    });

    it('records null when the decision carried no confidence', async () => {
      setMockData('system_decisions', [skippedDecision({ confidence_score: null })]);

      await handleEntityCreationSkippedFeedback({
        decisionId: 'decision-skip-conf',
        resolvedBy: 'user-123',
      });

      expect(getMockData('user_edits')[0].confidence_before).toBeNull();
    });
  });
});
