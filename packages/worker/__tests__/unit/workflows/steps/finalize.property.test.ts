/**
 * Property tests for Finalize Step
 * 
 * Property 1: Blocking Decision Validation
 * Validates: Requirements 1.3, 1.4
 * 
 * Property 2: Outcome Counting Accuracy
 * Validates: Requirements 2.6, 2.7
 * 
 * Property 3: Summary Message Completeness
 * Validates: Requirements 3.1, 3.2, 3.6, 3.8
 * 
 * Property 4: Status Update Consistency
 * Validates: Requirements 5.1, 5.3
 * 
 * Property 5: Fatal Execution Model
 * Validates: Requirements 1.8, 5.2, 5.4
 * 
 * Property 6: Edge Case Handling
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4
 */

import { executeFinalizeStep } from '../../../../src/workflows/steps/finalize';
import { supabase } from '../../../../src/utils/supabase';
import type { WorkflowStep } from '../../../../src/workflows/steps/types';
import { WorkflowId, StepId } from '../../../../src/workflows/steps/types';
import type { Artifact } from '@ahkms/shared';
import {
  resetMockData,
  getMockData,
  setMockData,
} from '../../../__mocks__/supabase';
import {
  createMockWorkflowStep,
  createMockArtifact,
  createMockWorkflow,
  TEST_WORKFLOW_ID,
  NON_EXISTENT_WORKFLOW_ID,
} from '../../../helpers/fixtures';
import * as fc from 'fast-check';

// Mock dependencies
jest.mock('../../../../src/utils/supabase');

const mockSupabase = supabase as jest.Mocked<typeof supabase>;

/**
 * Property 1: Blocking Decision Validation
 * 
 * Validates: Requirements 1.3, 1.4
 * 
 * For any workflow execution:
 * - The Finalize_System SHALL NOT finalize workflows that have blocking pending decisions
 * - The Finalize_System SHALL proceed with finalization when no blocking decisions exist
 * - The Finalize_System SHALL proceed with finalization when only non-blocking pending decisions exist
 */
describe('Property 1: Blocking Decision Validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMockData();
  });

  /**
   * Helper to create a mock system decision
   */
  function createMockDecision(overrides: Partial<any> = {}): any {
    return {
      id: `decision-${Date.now()}-${Math.random()}`,
      user_id: 'user-123',
      workflow_task_id: null,
      decision_type: 'approval',
      stage: 'extract',
      title: 'Test Decision',
      description: 'Test Description',
      confidence_score: 80,
      blocking: false,
      status: 'pending',
      review_type: 'approval',
      decision_payload: {},
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it('should fail finalize when blocking pending decisions exist', async () => {
    const workflowId = TEST_WORKFLOW_ID;
    const artifactId = 'artifact-123';
    const userId = 'user-123';

    // Setup workflow
    const workflow = createMockWorkflow({
      id: workflowId,
      user_id: userId,
      source_artifact_id: artifactId,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      tokens_used: 1000,
    });
    setMockData('workflows', [workflow]);

    // Setup artifact
    const artifact = createMockArtifact({
      id: artifactId,
      user_id: userId,
    });
    setMockData('artifacts', [artifact]);

    // Setup workflow steps
    const step1 = createMockWorkflowStep({
      id: 1,
      workflow_id: workflowId,
      step_type: 'organize_entities',
      step_order: 1,
      status: 'completed',
    });
    const step2 = createMockWorkflowStep({
      id: 2,
      workflow_id: workflowId,
      step_type: 'extract_actions',
      step_order: 2,
      status: 'completed',
    });
    const finalizeStep: WorkflowStep = createMockWorkflowStep({
      id: 3,
      workflow_id: workflowId,
      step_type: 'finalize',
      step_order: 3,
      status: 'pending',
    });
    setMockData('workflow_steps', [step1, step2, finalizeStep]);

    // Create blocking pending decision for step 1
    const blockingDecision = createMockDecision({
      workflow_task_id: 1,
      blocking: true,
      status: 'pending',
    });
    setMockData('system_decisions', [blockingDecision]);

    // Execute finalize step
    const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

    // Should fail
    expect(result.success).toBe(false);
    expect(result.error).toBe('Cannot finalize workflow with blocking pending decisions');

    // Verify step status is marked as failed
    const steps = getMockData('workflow_steps');
    const updatedStep = steps.find((s: any) => s.id === 3);
    expect(updatedStep.status).toBe('failed');
    expect(updatedStep.error_message).toBe('Cannot finalize workflow with blocking pending decisions');
  });

  it('should proceed with finalize when no blocking decisions exist', async () => {
    const workflowId = TEST_WORKFLOW_ID;
    const artifactId = 'artifact-123';
    const userId = 'user-123';

    // Setup workflow
    const workflow = createMockWorkflow({
      id: workflowId,
      user_id: userId,
      source_artifact_id: artifactId,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      tokens_used: 1000,
    });
    setMockData('workflows', [workflow]);

    // Setup artifact
    const artifact = createMockArtifact({
      id: artifactId,
      user_id: userId,
    });
    setMockData('artifacts', [artifact]);

    // Setup workflow steps
    const finalizeStep: WorkflowStep = createMockWorkflowStep({
      id: 1,
      workflow_id: workflowId,
      step_type: 'finalize',
      step_order: 1,
      status: 'pending',
    });
    setMockData('workflow_steps', [finalizeStep]);

    // No blocking decisions
    setMockData('system_decisions', []);

    // Execute finalize step
    const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

    // Should succeed
    expect(result.success).toBe(true);
    expect(result.notificationId).toBeTruthy();
    expect(result.summary).toBeTruthy();
  });

  it('should proceed with finalize when only non-blocking pending decisions exist', async () => {
    const workflowId = TEST_WORKFLOW_ID;
    const artifactId = 'artifact-123';
    const userId = 'user-123';

    // Setup workflow
    const workflow = createMockWorkflow({
      id: workflowId,
      user_id: userId,
      source_artifact_id: artifactId,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      tokens_used: 1000,
    });
    setMockData('workflows', [workflow]);

    // Setup artifact
    const artifact = createMockArtifact({
      id: artifactId,
      user_id: userId,
    });
    setMockData('artifacts', [artifact]);

    // Setup workflow steps
    const step1 = createMockWorkflowStep({
      id: 1,
      workflow_id: workflowId,
      step_type: 'organize_entities',
      step_order: 1,
      status: 'completed',
    });
    const finalizeStep: WorkflowStep = createMockWorkflowStep({
      id: 2,
      workflow_id: workflowId,
      step_type: 'finalize',
      step_order: 2,
      status: 'pending',
    });
    setMockData('workflow_steps', [step1, finalizeStep]);

    // Create non-blocking pending decision
    const nonBlockingDecision = createMockDecision({
      workflow_task_id: 1,
      blocking: false,
      status: 'pending',
    });
    setMockData('system_decisions', [nonBlockingDecision]);

    // Execute finalize step
    const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

    // Should succeed (non-blocking decisions don't prevent finalization)
    expect(result.success).toBe(true);
    expect(result.notificationId).toBeTruthy();
    expect(result.summary).toBeTruthy();
  });

  it('should fail finalize when blocking decisions exist, even with non-blocking ones', async () => {
    const workflowId = TEST_WORKFLOW_ID;
    const artifactId = 'artifact-123';
    const userId = 'user-123';

    // Setup workflow
    const workflow = createMockWorkflow({
      id: workflowId,
      user_id: userId,
      source_artifact_id: artifactId,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      tokens_used: 1000,
    });
    setMockData('workflows', [workflow]);

    // Setup artifact
    const artifact = createMockArtifact({
      id: artifactId,
      user_id: userId,
    });
    setMockData('artifacts', [artifact]);

    // Setup workflow steps
    const step1 = createMockWorkflowStep({
      id: 1,
      workflow_id: workflowId,
      step_type: 'organize_entities',
      step_order: 1,
      status: 'completed',
    });
    const finalizeStep: WorkflowStep = createMockWorkflowStep({
      id: 2,
      workflow_id: workflowId,
      step_type: 'finalize',
      step_order: 2,
      status: 'pending',
    });
    setMockData('workflow_steps', [step1, finalizeStep]);

    // Create both blocking and non-blocking decisions
    const blockingDecision = createMockDecision({
      workflow_task_id: 1,
      blocking: true,
      status: 'pending',
    });
    const nonBlockingDecision = createMockDecision({
      workflow_task_id: 1,
      blocking: false,
      status: 'pending',
    });
    setMockData('system_decisions', [blockingDecision, nonBlockingDecision]);

    // Execute finalize step
    const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

    // Should fail (blocking decision takes precedence)
    expect(result.success).toBe(false);
    expect(result.error).toBe('Cannot finalize workflow with blocking pending decisions');
  });

  it('should proceed with finalize when blocking decisions are not pending', async () => {
    const workflowId = TEST_WORKFLOW_ID;
    const artifactId = 'artifact-123';
    const userId = 'user-123';

    // Setup workflow
    const workflow = createMockWorkflow({
      id: workflowId,
      user_id: userId,
      source_artifact_id: artifactId,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      tokens_used: 1000,
    });
    setMockData('workflows', [workflow]);

    // Setup artifact
    const artifact = createMockArtifact({
      id: artifactId,
      user_id: userId,
    });
    setMockData('artifacts', [artifact]);

    // Setup workflow steps
    const step1 = createMockWorkflowStep({
      id: 1,
      workflow_id: workflowId,
      step_type: 'organize_entities',
      step_order: 1,
      status: 'completed',
    });
    const finalizeStep: WorkflowStep = createMockWorkflowStep({
      id: 2,
      workflow_id: workflowId,
      step_type: 'finalize',
      step_order: 2,
      status: 'pending',
    });
    setMockData('workflow_steps', [step1, finalizeStep]);

    // Create blocking decision that is resolved (not pending)
    const resolvedBlockingDecision = createMockDecision({
      workflow_task_id: 1,
      blocking: true,
      status: 'resolved', // Not pending
    });
    setMockData('system_decisions', [resolvedBlockingDecision]);

    // Execute finalize step
    const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

    // Should succeed (only pending blocking decisions block finalization)
    expect(result.success).toBe(true);
    expect(result.notificationId).toBeTruthy();
  });

  /**
   * Property test using fast-check to generate various decision scenarios
   */
  it('should validate blocking decision property for generated scenarios', async () => {
    // Generate arbitrary decision scenarios
    const decisionArbitrary = fc.record({
      workflow_task_id: fc.constantFrom(1, 2, 3, null),
      blocking: fc.boolean(),
      status: fc.constantFrom('pending', 'resolved', 'dismissed', 'auto_applied'),
    });

    const scenariosArbitrary = fc.array(decisionArbitrary, { minLength: 0, maxLength: 5 });

    await fc.assert(
      fc.asyncProperty(scenariosArbitrary, async (decisions) => {
        resetMockData();

        const workflowId = TEST_WORKFLOW_ID;
        const artifactId = 'artifact-123';
        const userId = 'user-123';

        // Setup workflow
        const workflow = createMockWorkflow({
          id: workflowId,
          user_id: userId,
          source_artifact_id: artifactId,
          status: 'in_progress',
          started_at: new Date().toISOString(),
          tokens_used: 1000,
        });
        setMockData('workflows', [workflow]);

        // Setup artifact
        const artifact = createMockArtifact({
          id: artifactId,
          user_id: userId,
        });
        setMockData('artifacts', [artifact]);

        // Setup workflow steps
        const step1 = createMockWorkflowStep({
          id: 1,
          workflow_id: workflowId,
          step_type: 'organize_entities',
          step_order: 1,
          status: 'completed',
        });
        const step2 = createMockWorkflowStep({
          id: 2,
          workflow_id: workflowId,
          step_type: 'extract_actions',
          step_order: 2,
          status: 'completed',
        });
        const finalizeStep: WorkflowStep = createMockWorkflowStep({
          id: 3,
          workflow_id: workflowId,
          step_type: 'finalize',
          step_order: 3,
          status: 'pending',
        });
        setMockData('workflow_steps', [step1, step2, finalizeStep]);

        // Create decisions from generated scenarios
        const mockDecisions = decisions.map((d) =>
          createMockDecision({
            workflow_task_id: d.workflow_task_id,
            blocking: d.blocking,
            status: d.status,
          })
        );
        setMockData('system_decisions', mockDecisions);

        // Execute finalize step
        const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

        // Property: Finalize should fail if and only if there exists a blocking pending decision
        // for any step in the workflow (step IDs: 1, 2, 3)
        const workflowStepIds = [1, 2, 3];
        const hasBlockingPending = mockDecisions.some(
          (d) =>
            d.blocking === true &&
            d.status === 'pending' &&
            d.workflow_task_id !== null &&
            workflowStepIds.includes(d.workflow_task_id)
        );

        if (hasBlockingPending) {
          // If blocking pending decision exists, finalize should fail
          expect(result.success).toBe(false);
          expect(result.error).toBe('Cannot finalize workflow with blocking pending decisions');
        } else {
          // If no blocking pending decision exists, finalize should succeed
          expect(result.success).toBe(true);
          expect(result.notificationId).toBeTruthy();
        }
      }),
      { numRuns: 50 } // Run 50 property test iterations
    );
  });
});

/**
 * Property 2: Outcome Counting Accuracy
 * 
 * Validates: Requirements 2.6, 2.7
 * 
 * For any workflow execution:
 * - The Finalize_System SHALL accurately count outcomes from all workflow steps
 * - The Finalize_System SHALL extract counts from step output JSONB fields
 * - The Finalize_System SHALL handle null/missing output fields (treat as 0)
 * - The Finalize_System SHALL handle missing fields within output objects (treat as 0)
 */
describe('Property 2: Outcome Counting Accuracy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMockData();
  });

  /**
   * Helper function to manually count outcomes from steps (expected behavior)
   */
  function countOutcomesManually(steps: WorkflowStep[]): {
    entitiesCreated: number;
    entitiesLinked: number;
    tasksCreated: number;
    derivedArtifactsCreated: number;
  } {
    let entitiesCreated = 0;
    let entitiesLinked = 0;
    let tasksCreated = 0;
    let derivedArtifactsCreated = 0;

    for (const step of steps) {
      const stepType = step.step_type;
      const output = step.output;

      // Handle null or missing output (treat as 0)
      if (!output || typeof output !== 'object') {
        continue;
      }

      const outputObj = output as Record<string, unknown>;

      // Extract counts based on step type
      if (stepType === 'organize_entities') {
        if (Array.isArray(outputObj.entitiesCreated)) {
          entitiesCreated += outputObj.entitiesCreated.length;
        }
        if (Array.isArray(outputObj.entitiesLinked)) {
          entitiesLinked += outputObj.entitiesLinked.length;
        }
      } else if (stepType === 'extract_actions') {
        if (Array.isArray(outputObj.tasksCreated)) {
          tasksCreated += outputObj.tasksCreated.length;
        }
      } else if (stepType === 'create_derived_artifact') {
        if (outputObj.derivedArtifactId && typeof outputObj.derivedArtifactId === 'string') {
          derivedArtifactsCreated += 1;
        }
      }
    }

    return {
      entitiesCreated,
      entitiesLinked,
      tasksCreated,
      derivedArtifactsCreated,
    };
  }

  it('should accurately count entitiesCreated from organize_entities steps', async () => {
    const workflowId = TEST_WORKFLOW_ID;
    const artifactId = 'artifact-123';
    const userId = 'user-123';

    // Setup workflow
    const workflow = createMockWorkflow({
      id: workflowId,
      user_id: userId,
      source_artifact_id: artifactId,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      tokens_used: 1000,
    });
    setMockData('workflows', [workflow]);

    // Setup artifact
    const artifact = createMockArtifact({
      id: artifactId,
      user_id: userId,
    });
    setMockData('artifacts', [artifact]);

    // Setup workflow steps with entitiesCreated
    const step1 = createMockWorkflowStep({
      id: 1,
      workflow_id: workflowId,
      step_type: 'organize_entities',
      step_order: 1,
      status: 'completed',
      output: {
        entitiesCreated: ['entity-1', 'entity-2', 'entity-3'],
        entitiesLinked: ['link-1'],
      },
    });
    const step2 = createMockWorkflowStep({
      id: 2,
      workflow_id: workflowId,
      step_type: 'organize_entities',
      step_order: 2,
      status: 'completed',
      output: {
        entitiesCreated: ['entity-4', 'entity-5'],
        entitiesLinked: ['link-2', 'link-3'],
      },
    });
    const finalizeStep: WorkflowStep = createMockWorkflowStep({
      id: 3,
      workflow_id: workflowId,
      step_type: 'finalize',
      step_order: 3,
      status: 'pending',
    });
    setMockData('workflow_steps', [step1, step2, finalizeStep]);
    setMockData('system_decisions', []);

    // Execute finalize step
    const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

    expect(result.success).toBe(true);

    // Verify counts in notification payload
    const decisions = getMockData('system_decisions');
    const notification = decisions.find((d: any) => d.decision_type === 'workflow_complete');
    expect(notification).toBeDefined();
    expect(notification.decision_payload.summary.entitiesCreated).toBe(5); // 3 + 2
    expect(notification.decision_payload.summary.entitiesLinked).toBe(3); // 1 + 2
  });

  it('should accurately count tasksCreated from extract_actions steps', async () => {
    const workflowId = TEST_WORKFLOW_ID;
    const artifactId = 'artifact-123';
    const userId = 'user-123';

    // Setup workflow
    const workflow = createMockWorkflow({
      id: workflowId,
      user_id: userId,
      source_artifact_id: artifactId,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      tokens_used: 1000,
    });
    setMockData('workflows', [workflow]);

    // Setup artifact
    const artifact = createMockArtifact({
      id: artifactId,
      user_id: userId,
    });
    setMockData('artifacts', [artifact]);

    // Setup workflow steps with tasksCreated
    const step1 = createMockWorkflowStep({
      id: 1,
      workflow_id: workflowId,
      step_type: 'extract_actions',
      step_order: 1,
      status: 'completed',
      output: {
        tasksCreated: ['task-1', 'task-2'],
      },
    });
    const step2 = createMockWorkflowStep({
      id: 2,
      workflow_id: workflowId,
      step_type: 'extract_actions',
      step_order: 2,
      status: 'completed',
      output: {
        tasksCreated: ['task-3'],
      },
    });
    const finalizeStep: WorkflowStep = createMockWorkflowStep({
      id: 3,
      workflow_id: workflowId,
      step_type: 'finalize',
      step_order: 3,
      status: 'pending',
    });
    setMockData('workflow_steps', [step1, step2, finalizeStep]);
    setMockData('system_decisions', []);

    // Execute finalize step
    const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

    expect(result.success).toBe(true);

    // Verify counts in notification payload
    const decisions = getMockData('system_decisions');
    const notification = decisions.find((d: any) => d.decision_type === 'workflow_complete');
    expect(notification).toBeDefined();
    expect(notification.decision_payload.summary.tasksCreated).toBe(3); // 2 + 1
  });

  it('should accurately count derivedArtifactsCreated from create_derived_artifact steps', async () => {
    const workflowId = TEST_WORKFLOW_ID;
    const artifactId = 'artifact-123';
    const userId = 'user-123';

    // Setup workflow
    const workflow = createMockWorkflow({
      id: workflowId,
      user_id: userId,
      source_artifact_id: artifactId,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      tokens_used: 1000,
    });
    setMockData('workflows', [workflow]);

    // Setup artifact
    const artifact = createMockArtifact({
      id: artifactId,
      user_id: userId,
    });
    setMockData('artifacts', [artifact]);

    // Setup workflow steps with derivedArtifactId
    const step1 = createMockWorkflowStep({
      id: 1,
      workflow_id: workflowId,
      step_type: 'create_derived_artifact',
      step_order: 1,
      status: 'completed',
      output: {
        derivedArtifactId: 'derived-1',
      },
    });
    const step2 = createMockWorkflowStep({
      id: 2,
      workflow_id: workflowId,
      step_type: 'create_derived_artifact',
      step_order: 2,
      status: 'completed',
      output: {
        derivedArtifactId: 'derived-2',
      },
    });
    const finalizeStep: WorkflowStep = createMockWorkflowStep({
      id: 3,
      workflow_id: workflowId,
      step_type: 'finalize',
      step_order: 3,
      status: 'pending',
    });
    setMockData('workflow_steps', [step1, step2, finalizeStep]);
    setMockData('system_decisions', []);

    // Execute finalize step
    const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

    expect(result.success).toBe(true);

    // Verify counts in notification payload
    const decisions = getMockData('system_decisions');
    const notification = decisions.find((d: any) => d.decision_type === 'workflow_complete');
    expect(notification).toBeDefined();
    expect(notification.decision_payload.summary.derivedArtifactsCreated).toBe(2); // 1 + 1
  });

  it('should handle null or missing output fields (treat as 0)', async () => {
    const workflowId = TEST_WORKFLOW_ID;
    const artifactId = 'artifact-123';
    const userId = 'user-123';

    // Setup workflow
    const workflow = createMockWorkflow({
      id: workflowId,
      user_id: userId,
      source_artifact_id: artifactId,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      tokens_used: 1000,
    });
    setMockData('workflows', [workflow]);

    // Setup artifact
    const artifact = createMockArtifact({
      id: artifactId,
      user_id: userId,
    });
    setMockData('artifacts', [artifact]);

    // Setup workflow steps with null/missing outputs
    const step1 = createMockWorkflowStep({
      id: 1,
      workflow_id: workflowId,
      step_type: 'organize_entities',
      step_order: 1,
      status: 'completed',
      output: null, // Null output
    });
    const step2 = createMockWorkflowStep({
      id: 2,
      workflow_id: workflowId,
      step_type: 'extract_actions',
      step_order: 2,
      status: 'completed',
      // Missing output field
    });
    const step3 = createMockWorkflowStep({
      id: 3,
      workflow_id: workflowId,
      step_type: 'organize_entities',
      step_order: 3,
      status: 'completed',
      output: {
        entitiesCreated: ['entity-1'], // Valid output
      },
    });
    const finalizeStep: WorkflowStep = createMockWorkflowStep({
      id: 4,
      workflow_id: workflowId,
      step_type: 'finalize',
      step_order: 4,
      status: 'pending',
    });
    setMockData('workflow_steps', [step1, step2, step3, finalizeStep]);
    setMockData('system_decisions', []);

    // Execute finalize step
    const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

    expect(result.success).toBe(true);

    // Verify counts - should only count from step3
    const decisions = getMockData('system_decisions');
    const notification = decisions.find((d: any) => d.decision_type === 'workflow_complete');
    expect(notification).toBeDefined();
    expect(notification.decision_payload.summary.entitiesCreated).toBe(1);
    expect(notification.decision_payload.summary.entitiesLinked).toBe(0);
    expect(notification.decision_payload.summary.tasksCreated).toBe(0);
  });

  it('should handle missing fields within output objects (treat as 0)', async () => {
    const workflowId = TEST_WORKFLOW_ID;
    const artifactId = 'artifact-123';
    const userId = 'user-123';

    // Setup workflow
    const workflow = createMockWorkflow({
      id: workflowId,
      user_id: userId,
      source_artifact_id: artifactId,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      tokens_used: 1000,
    });
    setMockData('workflows', [workflow]);

    // Setup artifact
    const artifact = createMockArtifact({
      id: artifactId,
      user_id: userId,
    });
    setMockData('artifacts', [artifact]);

    // Setup workflow steps with missing fields in output
    const step1 = createMockWorkflowStep({
      id: 1,
      workflow_id: workflowId,
      step_type: 'organize_entities',
      step_order: 1,
      status: 'completed',
      output: {
        entitiesCreated: ['entity-1'],
        // Missing entitiesLinked field
      },
    });
    const step2 = createMockWorkflowStep({
      id: 2,
      workflow_id: workflowId,
      step_type: 'extract_actions',
      step_order: 2,
      status: 'completed',
      output: {
        // Missing tasksCreated field
      },
    });
    const step3 = createMockWorkflowStep({
      id: 3,
      workflow_id: workflowId,
      step_type: 'create_derived_artifact',
      step_order: 3,
      status: 'completed',
      output: {
        // Missing derivedArtifactId field
      },
    });
    const finalizeStep: WorkflowStep = createMockWorkflowStep({
      id: 4,
      workflow_id: workflowId,
      step_type: 'finalize',
      step_order: 4,
      status: 'pending',
    });
    setMockData('workflow_steps', [step1, step2, step3, finalizeStep]);
    setMockData('system_decisions', []);

    // Execute finalize step
    const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

    expect(result.success).toBe(true);

    // Verify counts - should only count entitiesCreated from step1
    const decisions = getMockData('system_decisions');
    const notification = decisions.find((d: any) => d.decision_type === 'workflow_complete');
    expect(notification).toBeDefined();
    expect(notification.decision_payload.summary.entitiesCreated).toBe(1);
    expect(notification.decision_payload.summary.entitiesLinked).toBe(0);
    expect(notification.decision_payload.summary.tasksCreated).toBe(0);
    expect(notification.decision_payload.summary.derivedArtifactsCreated).toBe(0);
  });

  /**
   * Property test using fast-check to generate various step output scenarios
   */
  it('should accurately count outcomes for generated step output scenarios', async () => {
    // Generate arbitrary step outputs
    const stepOutputArbitrary = fc.oneof(
      // organize_entities step output
      fc.record({
        stepType: fc.constant('organize_entities'),
        entitiesCreated: fc.array(fc.string(), { maxLength: 10 }),
        entitiesLinked: fc.array(fc.string(), { maxLength: 10 }),
      }),
      // extract_actions step output
      fc.record({
        stepType: fc.constant('extract_actions'),
        tasksCreated: fc.array(fc.string(), { maxLength: 10 }),
      }),
      // create_derived_artifact step output
      fc.record({
        stepType: fc.constant('create_derived_artifact'),
        derivedArtifactId: fc.oneof(fc.string(), fc.constant(null)),
      }),
      // Step with null output
      fc.record({
        stepType: fc.constantFrom('organize_entities', 'extract_actions', 'create_derived_artifact'),
        output: fc.constant(null),
      }),
      // Step with missing output
      fc.record({
        stepType: fc.constantFrom('organize_entities', 'extract_actions', 'create_derived_artifact'),
        output: fc.constant(undefined),
      }),
      // Step with empty output object
      fc.record({
        stepType: fc.constantFrom('organize_entities', 'extract_actions', 'create_derived_artifact'),
        output: fc.constant({}),
      })
    );

    const stepsArbitrary = fc.array(stepOutputArbitrary, { minLength: 0, maxLength: 10 });

    await fc.assert(
      fc.asyncProperty(stepsArbitrary, async (stepOutputs) => {
        resetMockData();

        const workflowId = TEST_WORKFLOW_ID;
        const artifactId = 'artifact-123';
        const userId = 'user-123';

        // Setup workflow
        const workflow = createMockWorkflow({
          id: workflowId,
          user_id: userId,
          source_artifact_id: artifactId,
          status: 'in_progress',
          started_at: new Date().toISOString(),
          tokens_used: 1000,
        });
        setMockData('workflows', [workflow]);

        // Setup artifact
        const artifact = createMockArtifact({
          id: artifactId,
          user_id: userId,
        });
        setMockData('artifacts', [artifact]);

        // Create workflow steps from generated outputs
        const workflowSteps: WorkflowStep[] = [];
        let stepId = 1;

        for (const stepOutput of stepOutputs) {
          let output: any = null;

          if ('output' in stepOutput) {
            output = stepOutput.output;
          } else if (stepOutput.stepType === 'organize_entities') {
            output = {
              entitiesCreated: stepOutput.entitiesCreated || [],
              entitiesLinked: stepOutput.entitiesLinked || [],
            };
          } else if (stepOutput.stepType === 'extract_actions') {
            output = {
              tasksCreated: stepOutput.tasksCreated || [],
            };
          } else if (stepOutput.stepType === 'create_derived_artifact') {
            output = {
              derivedArtifactId: stepOutput.derivedArtifactId || null,
            };
          }

          const step = createMockWorkflowStep({
            id: stepId++,
            workflow_id: workflowId,
            step_type: stepOutput.stepType as any,
            step_order: stepId - 1,
            status: 'completed',
            output: output === undefined ? undefined : output,
          });
          workflowSteps.push(step);
        }

        // Add finalize step
        const finalizeStep: WorkflowStep = createMockWorkflowStep({
          id: stepId,
          workflow_id: workflowId,
          step_type: 'finalize',
          step_order: stepId,
          status: 'pending',
        });
        workflowSteps.push(finalizeStep);

        setMockData('workflow_steps', workflowSteps);
        setMockData('system_decisions', []);

        // Calculate expected counts manually
        const expectedCounts = countOutcomesManually(workflowSteps.filter((s) => s.step_type !== 'finalize'));

        // Execute finalize step
        const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

        expect(result.success).toBe(true);

        // Verify counts match expected values
        const decisions = getMockData('system_decisions');
        const notification = decisions.find((d: any) => d.decision_type === 'workflow_complete');
        expect(notification).toBeDefined();

        const actualCounts = notification.decision_payload.summary;
        expect(actualCounts.entitiesCreated).toBe(expectedCounts.entitiesCreated);
        expect(actualCounts.entitiesLinked).toBe(expectedCounts.entitiesLinked);
        expect(actualCounts.tasksCreated).toBe(expectedCounts.tasksCreated);
        expect(actualCounts.derivedArtifactsCreated).toBe(expectedCounts.derivedArtifactsCreated);
      }),
      { numRuns: 50 } // Run 50 property test iterations
    );
  });
});

/**
 * Property 3: Summary Message Completeness
 * 
 * Validates: Requirements 3.1, 3.2, 3.6, 3.8
 * 
 * For any successful workflow finalization:
 * - The Finalize_System SHALL include artifact description in the summary message
 * - The Finalize_System SHALL include outcome counts in the summary message
 * - The Finalize_System SHALL include token usage (if > 0) in the summary message
 */
describe('Property 3: Summary Message Completeness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMockData();
  });

  /**
   * Helper function to verify summary message completeness
   */
  function verifySummaryCompleteness(
    summary: string,
    artifact: Artifact | null,
    entitiesCreated: number,
    entitiesLinked: number,
    tasksCreated: number,
    derivedArtifactsCreated: number,
    tokensUsed: number
  ): void {
    // Property 3.1 & 3.2: Artifact description must be present
    expect(summary).toContain("I've finished processing your ");
    
    // Determine expected artifact type
    let expectedArtifactType = 'artifact';
    if (artifact) {
      const artifactAny = artifact as any;
      if (artifactAny.content_type === 'text') {
        expectedArtifactType = 'note';
      } else if (artifactAny.content_subtype === 'photo') {
        expectedArtifactType = 'photo';
      } else if (artifactAny.content_subtype === 'document') {
        expectedArtifactType = 'document';
      } else if (artifactAny.content_subtype === 'video') {
        expectedArtifactType = 'video';
      } else if (artifactAny.content_type === 'binary') {
        expectedArtifactType = 'file';
      }
    }
    
    expect(summary).toContain(expectedArtifactType);

    // Property 3.6: Outcome counts must be included if > 0
    if (entitiesLinked > 0) {
      expect(summary).toContain('Linked to');
      expect(summary).toContain(entitiesLinked.toString());
      if (entitiesCreated > 0) {
        expect(summary).toContain('(' + entitiesCreated + ' new)');
      }
    }

    if (tasksCreated > 0) {
      expect(summary).toContain('Created');
      expect(summary).toContain(tasksCreated.toString());
      expect(summary).toContain('task');
    }

    if (derivedArtifactsCreated > 0) {
      expect(summary).toContain('Created');
      if (derivedArtifactsCreated === 1) {
        expect(summary).toContain('cleaned version');
      } else {
        expect(summary).toContain(derivedArtifactsCreated.toString());
        expect(summary).toContain('derived versions');
      }
    }

    // If all outcomes are zero, should have generic completion message
    const hasOutcomes = entitiesLinked > 0 || tasksCreated > 0 || derivedArtifactsCreated > 0;
    if (!hasOutcomes) {
      expect(summary).toContain('Artifact analyzed and stored');
    }

    // Property 3.8: Token usage must be included if > 0
    if (tokensUsed > 0) {
      expect(summary).toContain('💡 AI tokens used:');
      expect(summary).toContain(tokensUsed.toLocaleString());
    } else {
      // Token usage line should not appear if tokensUsed is 0
      expect(summary).not.toContain('💡 AI tokens used:');
    }
  }

  it('should include artifact description for text artifact', async () => {
    const workflowId = TEST_WORKFLOW_ID;
    const artifactId = 'artifact-123';
    const userId = 'user-123';

    const workflow = createMockWorkflow({
      id: workflowId,
      user_id: userId,
      source_artifact_id: artifactId,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      tokens_used: 1000,
    });
    setMockData('workflows', [workflow]);

    const artifact = createMockArtifact({
      id: artifactId,
      user_id: userId,
      content_type: 'text',
      user_content: 'Test note content',
    } as any);
    setMockData('artifacts', [artifact]);

    const finalizeStep: WorkflowStep = createMockWorkflowStep({
      id: 1,
      workflow_id: workflowId,
      step_type: 'finalize',
      step_order: 1,
      status: 'pending',
    });
    setMockData('workflow_steps', [finalizeStep]);
    setMockData('system_decisions', []);

    const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

    expect(result.success).toBe(true);
    expect(result.summary).toBeTruthy();
    expect(result.summary).toContain("I've finished processing your note");
  });

  it('should include artifact description for photo artifact', async () => {
    const workflowId = TEST_WORKFLOW_ID;
    const artifactId = 'artifact-123';
    const userId = 'user-123';

    const workflow = createMockWorkflow({
      id: workflowId,
      user_id: userId,
      source_artifact_id: artifactId,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      tokens_used: 0,
    });
    setMockData('workflows', [workflow]);

    const artifact = createMockArtifact({
      id: artifactId,
      user_id: userId,
      content_type: 'binary',
      content_subtype: 'photo',
      filename: 'photo.jpg',
    } as any);
    setMockData('artifacts', [artifact]);

    const finalizeStep: WorkflowStep = createMockWorkflowStep({
      id: 1,
      workflow_id: workflowId,
      step_type: 'finalize',
      step_order: 1,
      status: 'pending',
    });
    setMockData('workflow_steps', [finalizeStep]);
    setMockData('system_decisions', []);

    const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

    expect(result.success).toBe(true);
    expect(result.summary).toBeTruthy();
    expect(result.summary).toContain("I've finished processing your photo");
    expect(result.summary).toContain('photo.jpg');
  });

  it('should include outcome counts in summary', async () => {
    const workflowId = TEST_WORKFLOW_ID;
    const artifactId = 'artifact-123';
    const userId = 'user-123';

    const workflow = createMockWorkflow({
      id: workflowId,
      user_id: userId,
      source_artifact_id: artifactId,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      tokens_used: 2000,
    });
    setMockData('workflows', [workflow]);

    const artifact = createMockArtifact({
      id: artifactId,
      user_id: userId,
    });
    setMockData('artifacts', [artifact]);

    const step1 = createMockWorkflowStep({
      id: 1,
      workflow_id: workflowId,
      step_type: 'organize_entities',
      step_order: 1,
      status: 'completed',
      output: {
        entitiesCreated: ['entity-1', 'entity-2'],
        entitiesLinked: ['link-1', 'link-2', 'link-3'],
      },
    });
    const step2 = createMockWorkflowStep({
      id: 2,
      workflow_id: workflowId,
      step_type: 'extract_actions',
      step_order: 2,
      status: 'completed',
      output: {
        tasksCreated: ['task-1'],
      },
    });
    const finalizeStep: WorkflowStep = createMockWorkflowStep({
      id: 3,
      workflow_id: workflowId,
      step_type: 'finalize',
      step_order: 3,
      status: 'pending',
    });
    setMockData('workflow_steps', [step1, step2, finalizeStep]);
    setMockData('system_decisions', []);

    const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

    expect(result.success).toBe(true);
    expect(result.summary).toContain('Linked to 3 entities');
    expect(result.summary).toContain('(2 new)');
    expect(result.summary).toContain('Created 1 task');
  });

  it('should include token usage when > 0', async () => {
    const workflowId = TEST_WORKFLOW_ID;
    const artifactId = 'artifact-123';
    const userId = 'user-123';

    const workflow = createMockWorkflow({
      id: workflowId,
      user_id: userId,
      source_artifact_id: artifactId,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      tokens_used: 1234,
    });
    setMockData('workflows', [workflow]);

    const artifact = createMockArtifact({
      id: artifactId,
      user_id: userId,
    });
    setMockData('artifacts', [artifact]);

    const finalizeStep: WorkflowStep = createMockWorkflowStep({
      id: 1,
      workflow_id: workflowId,
      step_type: 'finalize',
      step_order: 1,
      status: 'pending',
    });
    setMockData('workflow_steps', [finalizeStep]);
    setMockData('system_decisions', []);

    const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

    expect(result.success).toBe(true);
    expect(result.summary).toContain('💡 AI tokens used:');
    expect(result.summary).toContain('1,234');
  });

  it('should omit token usage when = 0', async () => {
    const workflowId = TEST_WORKFLOW_ID;
    const artifactId = 'artifact-123';
    const userId = 'user-123';

    const workflow = createMockWorkflow({
      id: workflowId,
      user_id: userId,
      source_artifact_id: artifactId,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      tokens_used: 0,
    });
    setMockData('workflows', [workflow]);

    const artifact = createMockArtifact({
      id: artifactId,
      user_id: userId,
    });
    setMockData('artifacts', [artifact]);

    const finalizeStep: WorkflowStep = createMockWorkflowStep({
      id: 1,
      workflow_id: workflowId,
      step_type: 'finalize',
      step_order: 1,
      status: 'pending',
    });
    setMockData('workflow_steps', [finalizeStep]);
    setMockData('system_decisions', []);

    const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

    expect(result.success).toBe(true);
    expect(result.summary).not.toContain('💡 AI tokens used:');
  });

  /**
   * Property test using fast-check to generate various artifact types and outcome combinations
   */
  it('should include all required components in summary for generated scenarios', async () => {
    // Generate arbitrary artifact scenarios
    const artifactArbitrary = fc.oneof(
      // Text artifact (note)
      fc.record({
        content_type: fc.constant('text'),
        content_subtype: fc.constant(null),
        user_content: fc.string({ minLength: 1, maxLength: 100 }),
        filename: fc.constant(null),
      }),
      // Photo artifact
      fc.record({
        content_type: fc.constant('binary'),
        content_subtype: fc.constant('photo'),
        user_content: fc.constant(null),
        filename: fc.string({ minLength: 1, maxLength: 50 }),
      }),
      // Document artifact
      fc.record({
        content_type: fc.constant('binary'),
        content_subtype: fc.constant('document'),
        user_content: fc.constant(null),
        filename: fc.string({ minLength: 1, maxLength: 50 }),
      }),
      // Video artifact
      fc.record({
        content_type: fc.constant('binary'),
        content_subtype: fc.constant('video'),
        user_content: fc.constant(null),
        filename: fc.string({ minLength: 1, maxLength: 50 }),
      }),
      // Generic binary file
      fc.record({
        content_type: fc.constant('binary'),
        content_subtype: fc.constant(null),
        user_content: fc.constant(null),
        filename: fc.string({ minLength: 1, maxLength: 50 }),
      }),
      // Null artifact (missing)
      fc.constant(null)
    );

    // Generate arbitrary outcome counts
    const outcomesArbitrary = fc.record({
      entitiesCreated: fc.nat({ max: 10 }),
      entitiesLinked: fc.nat({ max: 10 }),
      tasksCreated: fc.nat({ max: 10 }),
      derivedArtifactsCreated: fc.nat({ max: 5 }),
      tokensUsed: fc.nat({ max: 10000 }),
    });

    // Generate scenario combining artifact and outcomes
    const scenarioArbitrary = fc.record({
      artifact: artifactArbitrary,
      outcomes: outcomesArbitrary,
    });

    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async (scenario) => {
        resetMockData();

        const workflowId = TEST_WORKFLOW_ID;
        const artifactId = 'artifact-123';
        const userId = 'user-123';

        // Setup workflow
        const workflow = createMockWorkflow({
          id: workflowId,
          user_id: userId,
          source_artifact_id: scenario.artifact ? artifactId : null,
          status: 'in_progress',
          started_at: new Date().toISOString(),
          tokens_used: scenario.outcomes.tokensUsed,
        });
        setMockData('workflows', [workflow]);

        // Setup artifact if provided
        if (scenario.artifact) {
          const artifact = createMockArtifact({
            id: artifactId,
            user_id: userId,
            ...scenario.artifact,
          } as any);
          setMockData('artifacts', [artifact]);
        } else {
          setMockData('artifacts', []);
        }

        // Setup workflow steps with outcomes
        const workflowSteps: WorkflowStep[] = [];
        let stepId = 1;

        if (scenario.outcomes.entitiesCreated > 0 || scenario.outcomes.entitiesLinked > 0) {
          const step = createMockWorkflowStep({
            id: stepId++,
            workflow_id: workflowId,
            step_type: 'organize_entities',
            step_order: stepId - 1,
            status: 'completed',
            output: {
              entitiesCreated: Array(scenario.outcomes.entitiesCreated).fill(0).map((_, i) => `entity-${i}`),
              entitiesLinked: Array(scenario.outcomes.entitiesLinked).fill(0).map((_, i) => `link-${i}`),
            },
          });
          workflowSteps.push(step);
        }

        if (scenario.outcomes.tasksCreated > 0) {
          const step = createMockWorkflowStep({
            id: stepId++,
            workflow_id: workflowId,
            step_type: 'extract_actions',
            step_order: stepId - 1,
            status: 'completed',
            output: {
              tasksCreated: Array(scenario.outcomes.tasksCreated).fill(0).map((_, i) => `task-${i}`),
            },
          });
          workflowSteps.push(step);
        }

        if (scenario.outcomes.derivedArtifactsCreated > 0) {
          for (let i = 0; i < scenario.outcomes.derivedArtifactsCreated; i++) {
            const step = createMockWorkflowStep({
              id: stepId++,
              workflow_id: workflowId,
              step_type: 'create_derived_artifact',
              step_order: stepId - 1,
              status: 'completed',
              output: {
                derivedArtifactId: `derived-${i}`,
              },
            });
            workflowSteps.push(step);
          }
        }

        // Add finalize step
        const finalizeStep: WorkflowStep = createMockWorkflowStep({
          id: stepId,
          workflow_id: workflowId,
          step_type: 'finalize',
          step_order: stepId,
          status: 'pending',
        });
        workflowSteps.push(finalizeStep);

        setMockData('workflow_steps', workflowSteps);
        setMockData('system_decisions', []);

        // Execute finalize step
        const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

        expect(result.success).toBe(true);
        expect(result.summary).toBeTruthy();

        // Verify summary completeness
        verifySummaryCompleteness(
          result.summary!,
          scenario.artifact ? createMockArtifact({ id: artifactId, user_id: userId, ...scenario.artifact } as any) : null,
          scenario.outcomes.entitiesCreated,
          scenario.outcomes.entitiesLinked,
          scenario.outcomes.tasksCreated,
          scenario.outcomes.derivedArtifactsCreated,
          scenario.outcomes.tokensUsed
        );
      }),
      { numRuns: 100 } // Run 100 property test iterations
    );
  });
});

describe('Property 4: Status Update Consistency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMockData();
  });

  /**
   * Property 4: Status Update Consistency
   * 
   * Validates: Requirements 5.1, 5.3
   * 
   * For any successful execution of executeFinalizeStep:
   * - Artifact lifecycle_stage SHALL be set to 'complete'
   * - Artifact processing_status SHALL be set to 'completed'
   * - Workflow status SHALL be set to 'completed'
   * - Workflow completed_at SHALL be set to a valid timestamp
   */
  describe('Status Update Consistency', () => {
    it('should update artifact lifecycle_stage to complete', async () => {
      const workflowId = TEST_WORKFLOW_ID;
      const artifactId = 'artifact-123';
      const userId = 'user-123';

      // Setup workflow
      const workflow = createMockWorkflow({
        id: workflowId,
        user_id: userId,
        source_artifact_id: artifactId,
        status: 'in_progress',
        started_at: new Date().toISOString(),
        tokens_used: 1000,
      });
      setMockData('workflows', [workflow]);

      // Setup artifact with initial status
      const artifact = createMockArtifact({
        id: artifactId,
        user_id: userId,
        lifecycle_stage: 'artifacts_created',
        processing_status: 'pending',
      });
      setMockData('artifacts', [artifact]);

      // Setup workflow steps (including the finalize step and other steps for blocking check)
      const step: WorkflowStep = createMockWorkflowStep({
        id: 1,
        workflow_id: workflowId,
        step_type: 'finalize',
        step_name: 'Finalize Workflow',
        step_order: 6,
        status: 'pending',
      });
      setMockData('workflow_steps', [step]);
      
      // Ensure no blocking decisions exist
      setMockData('system_decisions', []);

      // Execute finalize step
      await executeFinalizeStep(step, WorkflowId.parse(workflowId), StepId.parse(step.id));

      // Verify artifact was updated
      const artifacts = getMockData('artifacts');
      const updatedArtifact = artifacts.find((a: any) => a.id === artifactId);
      expect(updatedArtifact).toBeDefined();
      expect(updatedArtifact.lifecycle_stage).toBe('complete');
    });

    it('should update artifact processing_status to completed', async () => {
      const workflowId = TEST_WORKFLOW_ID;
      const artifactId = 'artifact-123';
      const userId = 'user-123';

      // Setup workflow
      const workflow = createMockWorkflow({
        id: workflowId,
        user_id: userId,
        source_artifact_id: artifactId,
        status: 'in_progress',
        started_at: new Date().toISOString(),
        tokens_used: 1000,
      });
      setMockData('workflows', [workflow]);

      // Setup artifact with initial status
      const artifact = createMockArtifact({
        id: artifactId,
        user_id: userId,
        lifecycle_stage: 'artifacts_created',
        processing_status: 'pending',
      });
      setMockData('artifacts', [artifact]);

      // Setup workflow steps
      const step: WorkflowStep = createMockWorkflowStep({
        id: 1,
        workflow_id: workflowId,
        step_type: 'finalize',
        step_name: 'Finalize Workflow',
        step_order: 6,
        status: 'pending',
      });
      setMockData('workflow_steps', [step]);
      
      // Ensure no blocking decisions exist
      setMockData('system_decisions', []);

      // Execute finalize step
      await executeFinalizeStep(step, WorkflowId.parse(workflowId), StepId.parse(step.id));

      // Verify artifact was updated
      const artifacts = getMockData('artifacts');
      const updatedArtifact = artifacts.find((a: any) => a.id === artifactId);
      expect(updatedArtifact).toBeDefined();
      expect(updatedArtifact.processing_status).toBe('completed');
    });

    it('should update workflow status to completed', async () => {
      const workflowId = TEST_WORKFLOW_ID;
      const artifactId = 'artifact-123';
      const userId = 'user-123';

      // Setup workflow with initial status
      const workflow = createMockWorkflow({
        id: workflowId,
        user_id: userId,
        source_artifact_id: artifactId,
        status: 'in_progress',
        started_at: new Date().toISOString(),
        tokens_used: 1000,
      });
      setMockData('workflows', [workflow]);

      // Setup artifact
      const artifact = createMockArtifact({
        id: artifactId,
        user_id: userId,
        lifecycle_stage: 'artifacts_created',
        processing_status: 'pending',
      });
      setMockData('artifacts', [artifact]);

      // Setup workflow steps
      const step: WorkflowStep = createMockWorkflowStep({
        id: 1,
        workflow_id: workflowId,
        step_type: 'finalize',
        step_name: 'Finalize Workflow',
        step_order: 6,
        status: 'pending',
      });
      setMockData('workflow_steps', [step]);
      
      // Ensure no blocking decisions exist
      setMockData('system_decisions', []);

      // Execute finalize step
      await executeFinalizeStep(step, WorkflowId.parse(workflowId), StepId.parse(step.id));

      // Verify workflow was updated
      const workflows = getMockData('workflows');
      const updatedWorkflow = workflows.find((w: any) => w.id === workflowId);
      expect(updatedWorkflow).toBeDefined();
      expect(updatedWorkflow.status).toBe('completed');
    });

    it('should set workflow completed_at timestamp', async () => {
      const workflowId = TEST_WORKFLOW_ID;
      const artifactId = 'artifact-123';
      const userId = 'user-123';

      // Setup workflow
      const workflow = createMockWorkflow({
        id: workflowId,
        user_id: userId,
        source_artifact_id: artifactId,
        status: 'in_progress',
        started_at: new Date().toISOString(),
        tokens_used: 1000,
        completed_at: null, // Initially null
      });
      setMockData('workflows', [workflow]);

      // Setup artifact
      const artifact = createMockArtifact({
        id: artifactId,
        user_id: userId,
        lifecycle_stage: 'artifacts_created',
        processing_status: 'pending',
      });
      setMockData('artifacts', [artifact]);

      // Setup workflow steps
      const step: WorkflowStep = createMockWorkflowStep({
        id: 1,
        workflow_id: workflowId,
        step_type: 'finalize',
        step_name: 'Finalize Workflow',
        step_order: 6,
        status: 'pending',
      });
      setMockData('workflow_steps', [step]);

      // Record time before execution
      const beforeTime = new Date().toISOString();

      // Execute finalize step
      await executeFinalizeStep(step, WorkflowId.parse(workflowId), StepId.parse(step.id));

      // Record time after execution
      const afterTime = new Date().toISOString();

      // Verify workflow was updated with completed_at
      const workflows = getMockData('workflows');
      const updatedWorkflow = workflows.find((w: any) => w.id === workflowId);
      expect(updatedWorkflow).toBeDefined();
      expect(updatedWorkflow.completed_at).toBeDefined();
      expect(updatedWorkflow.completed_at).not.toBeNull();

      // Verify completed_at is a valid ISO timestamp
      const completedAt = new Date(updatedWorkflow.completed_at);
      expect(completedAt.getTime()).not.toBeNaN();

      // Verify completed_at is between before and after times (with small tolerance)
      const completedAtTime = completedAt.getTime();
      const beforeTimeMs = new Date(beforeTime).getTime();
      const afterTimeMs = new Date(afterTime).getTime();
      expect(completedAtTime).toBeGreaterThanOrEqual(beforeTimeMs - 1000); // 1 second tolerance
      expect(completedAtTime).toBeLessThanOrEqual(afterTimeMs + 1000); // 1 second tolerance
    });

    it('should update all status fields consistently across multiple scenarios', async () => {
      // Test various initial states to ensure consistency
      const scenarios = [
        {
          name: 'artifact at artifacts_created stage',
          artifactLifecycle: 'artifacts_created',
          artifactProcessing: 'pending',
        },
        {
          name: 'artifact at entities_extracted stage',
          artifactLifecycle: 'entities_extracted',
          artifactProcessing: 'in_progress',
        },
        {
          name: 'artifact at actions_extracted stage',
          artifactLifecycle: 'actions_extracted',
          artifactProcessing: 'in_progress',
        },
      ];

      for (const scenario of scenarios) {
        resetMockData();

        const workflowId = TEST_WORKFLOW_ID;
        const artifactId = `artifact-${scenario.name.replace(/\s+/g, '-')}`;
        const userId = 'user-123';

        // Setup workflow
        const workflow = createMockWorkflow({
          id: workflowId,
          user_id: userId,
          source_artifact_id: artifactId,
          status: 'in_progress',
          started_at: new Date().toISOString(),
          tokens_used: 1000,
        });
        setMockData('workflows', [workflow]);

        // Setup artifact with scenario-specific initial state
        const artifact = createMockArtifact({
          id: artifactId,
          user_id: userId,
          lifecycle_stage: scenario.artifactLifecycle,
          processing_status: scenario.artifactProcessing,
        });
        setMockData('artifacts', [artifact]);

        // Setup workflow steps
        const step: WorkflowStep = createMockWorkflowStep({
          id: 1,
          workflow_id: workflowId,
          step_type: 'finalize',
          step_name: 'Finalize Workflow',
          step_order: 6,
          status: 'pending',
        });
        setMockData('workflow_steps', [step]);

        // Execute finalize step
        await executeFinalizeStep(step, WorkflowId.parse(workflowId), StepId.parse(step.id));

        // Verify artifact status consistency
        const artifacts = getMockData('artifacts');
        const updatedArtifact = artifacts.find((a: any) => a.id === artifactId);
        expect(updatedArtifact).toBeDefined();
        expect(updatedArtifact.lifecycle_stage).toBe('complete');
        expect(updatedArtifact.processing_status).toBe('completed');

        // Verify workflow status consistency
        const workflows = getMockData('workflows');
        const updatedWorkflow = workflows.find((w: any) => w.id === workflowId);
        expect(updatedWorkflow).toBeDefined();
        expect(updatedWorkflow.status).toBe('completed');
        expect(updatedWorkflow.completed_at).toBeDefined();
        expect(updatedWorkflow.completed_at).not.toBeNull();
      }
    });

    it('should handle workflow without artifact gracefully', async () => {
      const workflowId = TEST_WORKFLOW_ID;
      const userId = 'user-123';

      // Setup workflow without artifact
      const workflow = createMockWorkflow({
        id: workflowId,
        user_id: userId,
        source_artifact_id: null, // No artifact
        status: 'in_progress',
        started_at: new Date().toISOString(),
        tokens_used: 1000,
      });
      setMockData('workflows', [workflow]);

      // Setup workflow steps
      const step: WorkflowStep = createMockWorkflowStep({
        id: 1,
        workflow_id: workflowId,
        step_type: 'finalize',
        step_name: 'Finalize Workflow',
        step_order: 6,
        status: 'pending',
      });
      setMockData('workflow_steps', [step]);

      // Execute finalize step
      const result = await executeFinalizeStep(step, WorkflowId.parse(workflowId), StepId.parse(step.id));

      // Should still succeed even without artifact
      expect(result.success).toBe(true);

      // Verify workflow was still updated
      const workflows = getMockData('workflows');
      const updatedWorkflow = workflows.find((w: any) => w.id === workflowId);
      expect(updatedWorkflow).toBeDefined();
      expect(updatedWorkflow.status).toBe('completed');
      expect(updatedWorkflow.completed_at).toBeDefined();
    });
  });

  /**
   * Property 5: Fatal Execution Model
   * 
   * Validates: Requirements 1.8, 5.2, 5.4
   * 
   * For any finalize step failure:
   * - The step SHALL return a failure result (not throw an exception)
   * - The step status SHALL be marked as 'failed'
   * - The workflow SHALL be marked as 'failed' (handled by orchestrator, but step should fail)
   */
  describe('Property 5: Fatal Execution Model', () => {
    it('should fail step when workflow not found', async () => {
      const workflowId = NON_EXISTENT_WORKFLOW_ID;
      const finalizeStep: WorkflowStep = createMockWorkflowStep({
        id: 7,
        workflow_id: workflowId,
        step_type: 'finalize',
        step_order: 6,
        status: 'pending',
      });

      setMockData('workflows', []);
      setMockData('workflow_steps', [finalizeStep]);
      setMockData('system_decisions', []);

      const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

      expect(result.success).toBe(false);
      expect(result.error).toBe('Workflow not found');

      // Verify step status is marked as failed
      const steps = getMockData('workflow_steps');
      const updatedStep = steps.find((s: any) => s.id === 7);
      expect(updatedStep.status).toBe('failed');
      expect(updatedStep.error_message).toBe('Workflow not found');
    });

    it('should complete step when notification creation fails (notification is non-fatal)', async () => {
      const workflowId = TEST_WORKFLOW_ID;
      const artifactId = 'artifact-123';
      const userId = 'user-123';

      const workflow = createMockWorkflow({
        id: workflowId,
        user_id: userId,
        source_artifact_id: artifactId,
        status: 'in_progress',
        started_at: new Date().toISOString(),
      });
      setMockData('workflows', [workflow]);

      const artifact = createMockArtifact({
        id: artifactId,
        user_id: userId,
      });
      setMockData('artifacts', [artifact]);

      const finalizeStep: WorkflowStep = createMockWorkflowStep({
        id: 7,
        workflow_id: workflowId,
        step_type: 'finalize',
        step_order: 6,
        status: 'pending',
      });

      setMockData('workflow_steps', [finalizeStep]);
      setMockData('system_decisions', []);

      // Mock notification creation to fail by intercepting the insert call
      const originalFrom = mockSupabase.from;
      let systemDecisionsCallCount = 0;
      mockSupabase.from = jest.fn((table: string) => {
        const builder = originalFrom(table);
        if (table === 'system_decisions') {
          systemDecisionsCallCount++;
          // Only fail on the insert call (not the select for blocking check)
          if (systemDecisionsCallCount > 1) {
            // This is the insert call
            const originalInsert = builder.insert;
            builder.insert = jest.fn().mockReturnValue({
              select: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: null,
                  error: { message: 'Database error' },
                }),
              }),
            });
          }
        }
        return builder;
      });

      const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

      // Completion notification failure is non-fatal: step and workflow still complete
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();

      const steps = getMockData('workflow_steps');
      const updatedStep = steps.find((s: any) => s.id === 7);
      expect(updatedStep.status).toBe('completed');

      // Restore original mock
      mockSupabase.from = originalFrom;
    });

    it('should fail step when artifact update fails', async () => {
      const workflowId = TEST_WORKFLOW_ID;
      const artifactId = 'artifact-123';
      const userId = 'user-123';

      const workflow = createMockWorkflow({
        id: workflowId,
        user_id: userId,
        source_artifact_id: artifactId,
        status: 'in_progress',
        started_at: new Date().toISOString(),
      });
      setMockData('workflows', [workflow]);

      const artifact = createMockArtifact({
        id: artifactId,
        user_id: userId,
      });
      setMockData('artifacts', [artifact]);

      const finalizeStep: WorkflowStep = createMockWorkflowStep({
        id: 7,
        workflow_id: workflowId,
        step_type: 'finalize',
        step_order: 6,
        status: 'pending',
      });

      setMockData('workflow_steps', [finalizeStep]);
      setMockData('system_decisions', []);

      // Mock artifact update to fail
      const originalFrom = mockSupabase.from;
      let artifactsCallCount = 0;
      mockSupabase.from = jest.fn((table: string) => {
        const builder = originalFrom(table);
        if (table === 'artifacts') {
          artifactsCallCount++;
          // Only fail on the update call (not the select for fetching)
          if (artifactsCallCount > 1) {
            // This is the update call
            const originalUpdate = builder.update;
            builder.update = jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                data: null,
                error: { message: 'Update failed' },
              }),
            });
          }
        }
        return builder;
      });

      const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to update artifact status');

      // Verify step status is marked as failed
      const steps = getMockData('workflow_steps');
      const updatedStep = steps.find((s: any) => s.id === 7);
      expect(updatedStep.status).toBe('failed');
      expect(updatedStep.error_message).toContain('Failed to update artifact status');

      // Restore original mock
      mockSupabase.from = originalFrom;
    });

    it('should fail step when workflow update fails', async () => {
      const workflowId = TEST_WORKFLOW_ID;
      const artifactId = 'artifact-123';
      const userId = 'user-123';

      const workflow = createMockWorkflow({
        id: workflowId,
        user_id: userId,
        source_artifact_id: artifactId,
        status: 'in_progress',
        started_at: new Date().toISOString(),
      });
      setMockData('workflows', [workflow]);

      const artifact = createMockArtifact({
        id: artifactId,
        user_id: userId,
      });
      setMockData('artifacts', [artifact]);

      const finalizeStep: WorkflowStep = createMockWorkflowStep({
        id: 7,
        workflow_id: workflowId,
        step_type: 'finalize',
        step_order: 6,
        status: 'pending',
      });

      setMockData('workflow_steps', [finalizeStep]);
      setMockData('system_decisions', []);

      // Mock workflow update to fail
      const originalFrom = mockSupabase.from;
      let workflowsCallCount = 0;
      mockSupabase.from = jest.fn((table: string) => {
        const builder = originalFrom(table);
        if (table === 'workflows') {
          workflowsCallCount++;
          // Only fail on the update call (not the select for fetching)
          if (workflowsCallCount > 1) {
            // This is the update call
            const originalUpdate = builder.update;
            builder.update = jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({
                data: null,
                error: { message: 'Update failed' },
              }),
            });
          }
        }
        return builder;
      });

      const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to update workflow status');

      // Verify step status is marked as failed
      const steps = getMockData('workflow_steps');
      const updatedStep = steps.find((s: any) => s.id === 7);
      expect(updatedStep.status).toBe('failed');
      expect(updatedStep.error_message).toContain('Failed to update workflow status');

      // Restore original mock
      mockSupabase.from = originalFrom;
    });
  });

  /**
   * Property 6: Edge Case Handling
   * 
   * Validates: Requirements 6.1, 6.2, 6.3, 6.4
   * 
   * For workflows with edge cases (missing data, zero outcomes):
   * - The workflow SHALL finalize successfully with generic completion message
   * - The workflow SHALL NOT fail unnecessarily due to edge cases
   */
  describe('Property 6: Edge Case Handling', () => {
    it('should finalize successfully with missing artifact', async () => {
      const workflowId = TEST_WORKFLOW_ID;
      const artifactId = 'artifact-123';
      const userId = 'user-123';

      const workflow = createMockWorkflow({
        id: workflowId,
        user_id: userId,
        source_artifact_id: artifactId,
        status: 'in_progress',
        started_at: new Date().toISOString(),
      });
      setMockData('workflows', [workflow]);

      // Don't add artifact
      setMockData('artifacts', []);

      const finalizeStep: WorkflowStep = createMockWorkflowStep({
        id: 7,
        workflow_id: workflowId,
        step_type: 'finalize',
        step_order: 6,
        status: 'pending',
      });

      setMockData('workflow_steps', [finalizeStep]);
      setMockData('system_decisions', []);

      const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

      expect(result.success).toBe(true);
      expect(result.summary).toContain("I've finished processing your artifact");
      expect(result.summary).toContain('Artifact analyzed and stored');
    });

    it('should finalize successfully with zero outcomes', async () => {
      const workflowId = TEST_WORKFLOW_ID;
      const artifactId = 'artifact-123';
      const userId = 'user-123';

      const workflow = createMockWorkflow({
        id: workflowId,
        user_id: userId,
        source_artifact_id: artifactId,
        status: 'in_progress',
        started_at: new Date().toISOString(),
      });
      setMockData('workflows', [workflow]);

      const artifact = createMockArtifact({
        id: artifactId,
        user_id: userId,
      });
      setMockData('artifacts', [artifact]);

      const finalizeStep: WorkflowStep = createMockWorkflowStep({
        id: 7,
        workflow_id: workflowId,
        step_type: 'finalize',
        step_order: 6,
        status: 'pending',
      });

      // Steps with no outcomes
      const step1: WorkflowStep = createMockWorkflowStep({
        id: 3,
        workflow_id: workflowId,
        step_type: 'organize_entities',
        step_order: 2,
        status: 'completed',
        output: {},
      });

      setMockData('workflow_steps', [step1, finalizeStep]);
      setMockData('system_decisions', []);

      const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Artifact analyzed and stored');
    });

    it('should finalize successfully with all steps skipped', async () => {
      const workflowId = TEST_WORKFLOW_ID;
      const artifactId = 'artifact-123';
      const userId = 'user-123';

      const workflow = createMockWorkflow({
        id: workflowId,
        user_id: userId,
        source_artifact_id: artifactId,
        status: 'in_progress',
        started_at: new Date().toISOString(),
      });
      setMockData('workflows', [workflow]);

      const artifact = createMockArtifact({
        id: artifactId,
        user_id: userId,
      });
      setMockData('artifacts', [artifact]);

      const finalizeStep: WorkflowStep = createMockWorkflowStep({
        id: 7,
        workflow_id: workflowId,
        step_type: 'finalize',
        step_order: 6,
        status: 'pending',
      });

      // All steps skipped
      const skippedStep1: WorkflowStep = createMockWorkflowStep({
        id: 3,
        workflow_id: workflowId,
        step_type: 'organize_entities',
        step_order: 2,
        status: 'skipped',
        output: null,
      });

      const skippedStep2: WorkflowStep = createMockWorkflowStep({
        id: 4,
        workflow_id: workflowId,
        step_type: 'extract_actions',
        step_order: 3,
        status: 'skipped',
        output: null,
      });

      setMockData('workflow_steps', [skippedStep1, skippedStep2, finalizeStep]);
      setMockData('system_decisions', []);

      const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Artifact analyzed and stored');
    });

    it('should finalize successfully with missing started_at', async () => {
      const workflowId = TEST_WORKFLOW_ID;
      const artifactId = 'artifact-123';
      const userId = 'user-123';

      const workflow = createMockWorkflow({
        id: workflowId,
        user_id: userId,
        source_artifact_id: artifactId,
        status: 'in_progress',
        started_at: null, // Missing started_at
      });
      setMockData('workflows', [workflow]);

      const artifact = createMockArtifact({
        id: artifactId,
        user_id: userId,
      });
      setMockData('artifacts', [artifact]);

      const finalizeStep: WorkflowStep = createMockWorkflowStep({
        id: 7,
        workflow_id: workflowId,
        step_type: 'finalize',
        step_order: 6,
        status: 'pending',
      });

      setMockData('workflow_steps', [finalizeStep]);
      setMockData('system_decisions', []);

      const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

      expect(result.success).toBe(true);
      // Duration should be null in payload
      const decisions = getMockData('system_decisions');
      expect(decisions[0].decision_payload.summary.duration).toBeNull();
    });

    it('should handle various edge case combinations', async () => {
      const scenarios = [
        {
          name: 'no artifact, no steps',
          artifactId: 'artifact-123',
          hasArtifact: false,
          steps: [],
        },
        {
          name: 'no artifact, skipped steps',
          artifactId: 'artifact-123',
          hasArtifact: false,
          steps: [
            { id: 3, step_type: 'organize_entities', status: 'skipped', output: null },
          ],
        },
        {
          name: 'artifact, no steps',
          artifactId: 'artifact-123',
          hasArtifact: true,
          steps: [],
        },
        {
          name: 'artifact, steps with empty outputs',
          artifactId: 'artifact-123',
          hasArtifact: true,
          steps: [
            { id: 3, step_type: 'organize_entities', status: 'completed', output: {} },
            { id: 4, step_type: 'extract_actions', status: 'completed', output: {} },
          ],
        },
      ];

      for (const scenario of scenarios) {
        resetMockData();

        const workflowId = TEST_WORKFLOW_ID;
        const userId = 'user-123';

        const workflow = createMockWorkflow({
          id: workflowId,
          user_id: userId,
          source_artifact_id: scenario.artifactId,
          status: 'in_progress',
          started_at: new Date().toISOString(),
        });
        setMockData('workflows', [workflow]);

        if (scenario.hasArtifact) {
          const artifact = createMockArtifact({
            id: scenario.artifactId,
            user_id: userId,
          });
          setMockData('artifacts', [artifact]);
        } else {
          setMockData('artifacts', []);
        }

        const finalizeStep: WorkflowStep = createMockWorkflowStep({
          id: 7,
          workflow_id: workflowId,
          step_type: 'finalize',
          step_order: 6,
          status: 'pending',
        });

        const workflowSteps = scenario.steps.map((s: any) =>
          createMockWorkflowStep({
            id: s.id,
            workflow_id: workflowId,
            step_type: s.step_type,
            step_order: s.id,
            status: s.status,
            output: s.output,
          })
        );

        setMockData('workflow_steps', [...workflowSteps, finalizeStep]);
        setMockData('system_decisions', []);

        const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

        // Should always succeed with edge cases
        expect(result.success).toBe(true);
        expect(result.summary).toBeTruthy();
        expect(result.notificationId).toBeTruthy();
      }
    });
  });
});
