/**
 * Unit tests for Finalize Step
 */

import { calculateDuration, buildSummaryMessage, createCompletionNotification, executeFinalizeStep } from '../../../../src/workflows/steps/finalize';
import { supabase } from '../../../../src/utils/supabase';
import type { Artifact } from '@ahkms/shared';
import type { WorkflowStep } from '../../../../src/workflows/steps/types';
import { WorkflowId, StepId } from '../../../../src/workflows/steps/types';
import { resetMockData, getMockData, setMockData } from '../../../__mocks__/supabase';
import { createMockWorkflowStep, createMockArtifact, createMockWorkflow, TEST_WORKFLOW_ID, NON_EXISTENT_WORKFLOW_ID, TEST_ARTIFACT_ID } from '../../../helpers/fixtures';

// Mock dependencies
jest.mock('../../../../src/utils/supabase');

const mockSupabase = supabase as jest.Mocked<typeof supabase>;

describe('Finalize Step', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMockData();
  });

  describe('calculateDuration', () => {
    it('should return null when startTime is null', () => {
      const endTime = new Date().toISOString();
      const result = calculateDuration(null, endTime);
      expect(result).toBeNull();
    });

    it('should format duration < 60s as "45s"', () => {
      const startTime = new Date('2025-01-24T10:00:00Z').toISOString();
      const endTime = new Date('2025-01-24T10:00:45Z').toISOString();
      const result = calculateDuration(startTime, endTime);
      expect(result).toBe('45s');
    });

    it('should format duration 60-3599s as "5m 23s"', () => {
      const startTime = new Date('2025-01-24T10:00:00Z').toISOString();
      const endTime = new Date('2025-01-24T10:05:23Z').toISOString();
      const result = calculateDuration(startTime, endTime);
      expect(result).toBe('5m 23s');
    });

    it('should format duration >= 3600s as "1h 23m"', () => {
      const startTime = new Date('2025-01-24T10:00:00Z').toISOString();
      const endTime = new Date('2025-01-24T11:23:00Z').toISOString();
      const result = calculateDuration(startTime, endTime);
      expect(result).toBe('1h 23m');
    });

    it('should handle exactly 60 seconds', () => {
      const startTime = new Date('2025-01-24T10:00:00Z').toISOString();
      const endTime = new Date('2025-01-24T10:01:00Z').toISOString();
      const result = calculateDuration(startTime, endTime);
      expect(result).toBe('1m 0s');
    });

    it('should handle exactly 3600 seconds (1 hour)', () => {
      const startTime = new Date('2025-01-24T10:00:00Z').toISOString();
      const endTime = new Date('2025-01-24T11:00:00Z').toISOString();
      const result = calculateDuration(startTime, endTime);
      expect(result).toBe('1h 0m');
    });

    it('should handle multi-hour durations', () => {
      const startTime = new Date('2025-01-24T10:00:00Z').toISOString();
      const endTime = new Date('2025-01-24T13:45:00Z').toISOString();
      const result = calculateDuration(startTime, endTime);
      expect(result).toBe('3h 45m');
    });

    it('should handle zero seconds', () => {
      const startTime = new Date('2025-01-24T10:00:00Z').toISOString();
      const endTime = new Date('2025-01-24T10:00:00Z').toISOString();
      const result = calculateDuration(startTime, endTime);
      expect(result).toBe('0s');
    });
  });

  describe('buildSummaryMessage', () => {
    it('should show snippet for text artifact with user_content', () => {
      const artifact: any = {
        id: 'artifact-123',
        storage_bucket: 'inputs',
        storage_path: 'test.txt',
        file_type: 'text/plain',
        file_size: 100,
        lifecycle_stage: 'complete',
        processing_status: 'completed',
        has_derived_artifacts: false,
        user_id: 'user-123',
        created_at: new Date().toISOString(),
        content_type: 'text',
        user_content: 'This is a test note with some content',
      } as Artifact;

      const result = buildSummaryMessage(artifact, 0, 0, 0, 0, 0);
      expect(result).toContain("I've finished processing your note");
      expect(result).toContain('(This is a test note with some content)');
    });

    it('should show filename for photo artifact', () => {
      const artifact: any = {
        id: 'artifact-123',
        storage_bucket: 'inputs',
        storage_path: 'photo.jpg',
        file_type: 'image/jpeg',
        file_size: 1024,
        lifecycle_stage: 'complete',
        processing_status: 'completed',
        has_derived_artifacts: false,
        user_id: 'user-123',
        created_at: new Date().toISOString(),
        filename: 'vacation-photo.jpg',
        content_type: 'binary',
        content_subtype: 'photo',
      } as Artifact;

      const result = buildSummaryMessage(artifact, 0, 0, 0, 0, 0);
      expect(result).toContain("I've finished processing your photo");
      expect(result).toContain('(vacation-photo.jpg)');
    });

    it('should show filename for document artifact', () => {
      const artifact: any = {
        id: 'artifact-123',
        storage_bucket: 'inputs',
        storage_path: 'doc.pdf',
        file_type: 'application/pdf',
        file_size: 2048,
        lifecycle_stage: 'complete',
        processing_status: 'completed',
        has_derived_artifacts: false,
        user_id: 'user-123',
        created_at: new Date().toISOString(),
        filename: 'report.pdf',
        content_type: 'binary',
        content_subtype: 'document',
      } as Artifact;

      const result = buildSummaryMessage(artifact, 0, 0, 0, 0, 0);
      expect(result).toContain("I've finished processing your document");
      expect(result).toContain('(report.pdf)');
    });

    it('should use "your artifact" when artifact is null', () => {
      const result = buildSummaryMessage(null, 0, 0, 0, 0, 0);
      expect(result).toContain("I've finished processing your artifact");
      expect(result).toContain('✓ Artifact analyzed and stored');
    });

    it('should show singular "1 entity" when one entity linked', () => {
      const artifact: Artifact = {
        id: 'artifact-123',
        storage_bucket: 'inputs',
        storage_path: 'test.txt',
        file_type: 'text/plain',
        file_size: 100,
        lifecycle_stage: 'complete',
        processing_status: 'completed',
        has_derived_artifacts: false,
        user_id: 'user-123',
        created_at: new Date().toISOString(),
      } as Artifact;

      const result = buildSummaryMessage(artifact, 0, 1, 0, 0, 0);
      expect(result).toContain('✓ Linked to 1 entity');
      expect(result).not.toContain('entities');
    });

    it('should show plural "3 entities" when multiple entities linked', () => {
      const artifact: Artifact = {
        id: 'artifact-123',
        storage_bucket: 'inputs',
        storage_path: 'test.txt',
        file_type: 'text/plain',
        file_size: 100,
        lifecycle_stage: 'complete',
        processing_status: 'completed',
        has_derived_artifacts: false,
        user_id: 'user-123',
        created_at: new Date().toISOString(),
      } as Artifact;

      const result = buildSummaryMessage(artifact, 0, 3, 0, 0, 0);
      expect(result).toContain('✓ Linked to 3 entities');
    });

    it('should show "(X new)" in parentheses when entities created', () => {
      const artifact: Artifact = {
        id: 'artifact-123',
        storage_bucket: 'inputs',
        storage_path: 'test.txt',
        file_type: 'text/plain',
        file_size: 100,
        lifecycle_stage: 'complete',
        processing_status: 'completed',
        has_derived_artifacts: false,
        user_id: 'user-123',
        created_at: new Date().toISOString(),
      } as Artifact;

      const result = buildSummaryMessage(artifact, 2, 3, 0, 0, 0);
      expect(result).toContain('✓ Linked to 3 entities (2 new)');
    });

    it('should show "Artifact analyzed and stored" when zero outcomes', () => {
      const artifact: Artifact = {
        id: 'artifact-123',
        storage_bucket: 'inputs',
        storage_path: 'test.txt',
        file_type: 'text/plain',
        file_size: 100,
        lifecycle_stage: 'complete',
        processing_status: 'completed',
        has_derived_artifacts: false,
        user_id: 'user-123',
        created_at: new Date().toISOString(),
      } as Artifact;

      const result = buildSummaryMessage(artifact, 0, 0, 0, 0, 0);
      expect(result).toContain('✓ Artifact analyzed and stored');
    });

    it('should omit token usage line when tokensUsed is 0', () => {
      const artifact: Artifact = {
        id: 'artifact-123',
        storage_bucket: 'inputs',
        storage_path: 'test.txt',
        file_type: 'text/plain',
        file_size: 100,
        lifecycle_stage: 'complete',
        processing_status: 'completed',
        has_derived_artifacts: false,
        user_id: 'user-123',
        created_at: new Date().toISOString(),
      } as Artifact;

      const result = buildSummaryMessage(artifact, 0, 0, 0, 0, 0);
      expect(result).not.toContain('💡 AI tokens used');
    });

    it('should format token usage with comma when > 1000', () => {
      const artifact: Artifact = {
        id: 'artifact-123',
        storage_bucket: 'inputs',
        storage_path: 'test.txt',
        file_type: 'text/plain',
        file_size: 100,
        lifecycle_stage: 'complete',
        processing_status: 'completed',
        has_derived_artifacts: false,
        user_id: 'user-123',
        created_at: new Date().toISOString(),
      } as Artifact;

      const result = buildSummaryMessage(artifact, 0, 0, 0, 0, 1234);
      expect(result).toContain('💡 AI tokens used: 1,234');
    });

    it('should truncate very long artifact content to 50 chars', () => {
      const longContent = 'A'.repeat(100);
      const artifact: any = {
        id: 'artifact-123',
        storage_bucket: 'inputs',
        storage_path: 'test.txt',
        file_type: 'text/plain',
        file_size: 100,
        lifecycle_stage: 'complete',
        processing_status: 'completed',
        has_derived_artifacts: false,
        user_id: 'user-123',
        created_at: new Date().toISOString(),
        content_type: 'text',
        user_content: longContent,
      } as Artifact;

      const result = buildSummaryMessage(artifact, 0, 0, 0, 0, 0);
      const snippetMatch = result.match(/\(([^)]+)\)/);
      expect(snippetMatch).toBeTruthy();
      if (snippetMatch) {
        const snippet = snippetMatch[1];
        expect(snippet.length).toBe(53); // 50 chars + "..."
        expect(snippet).toContain('...');
      }
    });

    it('should show tasks created', () => {
      const artifact: Artifact = {
        id: 'artifact-123',
        storage_bucket: 'inputs',
        storage_path: 'test.txt',
        file_type: 'text/plain',
        file_size: 100,
        lifecycle_stage: 'complete',
        processing_status: 'completed',
        has_derived_artifacts: false,
        user_id: 'user-123',
        created_at: new Date().toISOString(),
      } as Artifact;

      const result = buildSummaryMessage(artifact, 0, 0, 5, 0, 0);
      expect(result).toContain('✓ Created 5 tasks');
    });

    it('should show singular "task" when one task created', () => {
      const artifact: Artifact = {
        id: 'artifact-123',
        storage_bucket: 'inputs',
        storage_path: 'test.txt',
        file_type: 'text/plain',
        file_size: 100,
        lifecycle_stage: 'complete',
        processing_status: 'completed',
        has_derived_artifacts: false,
        user_id: 'user-123',
        created_at: new Date().toISOString(),
      } as Artifact;

      const result = buildSummaryMessage(artifact, 0, 0, 1, 0, 0);
      expect(result).toContain('✓ Created 1 task');
    });

    it('should show "Created cleaned version" when one derived artifact', () => {
      const artifact: Artifact = {
        id: 'artifact-123',
        storage_bucket: 'inputs',
        storage_path: 'test.txt',
        file_type: 'text/plain',
        file_size: 100,
        lifecycle_stage: 'complete',
        processing_status: 'completed',
        has_derived_artifacts: false,
        user_id: 'user-123',
        created_at: new Date().toISOString(),
      } as Artifact;

      const result = buildSummaryMessage(artifact, 0, 0, 0, 1, 0);
      expect(result).toContain('✓ Created cleaned version');
    });

    it('should show "Created X derived versions" when multiple derived artifacts', () => {
      const artifact: Artifact = {
        id: 'artifact-123',
        storage_bucket: 'inputs',
        storage_path: 'test.txt',
        file_type: 'text/plain',
        file_size: 100,
        lifecycle_stage: 'complete',
        processing_status: 'completed',
        has_derived_artifacts: false,
        user_id: 'user-123',
        created_at: new Date().toISOString(),
      } as Artifact;

      const result = buildSummaryMessage(artifact, 0, 0, 0, 3, 0);
      expect(result).toContain('✓ Created 3 derived versions');
    });
  });

  describe('createCompletionNotification', () => {
    const mockWorkflow = {
      id: TEST_WORKFLOW_ID,
      user_id: 'user-123',
      workflow_type: 'upload',
      status: 'in_progress',
      source_artifact_id: 'artifact-123',
      started_at: '2025-01-24T10:00:00Z',
      tokens_used: 1500,
      metadata: {},
    };

    const mockArtifact: Artifact = {
      id: 'artifact-123',
      storage_bucket: 'inputs',
      storage_path: 'test.txt',
      file_type: 'text/plain',
      file_size: 100,
      lifecycle_stage: 'complete',
      processing_status: 'completed',
      has_derived_artifacts: false,
      user_id: 'user-123',
      created_at: new Date().toISOString(),
    } as Artifact;

    it('should return notification ID on successful creation', async () => {
      const summary = 'Test summary message';
      const summaryData = {
        entitiesCreated: 2,
        entitiesLinked: 3,
        tasksCreated: 5,
        derivedArtifactsCreated: 1,
        tokensUsed: 1500,
        duration: '5m 23s',
      };

      const notificationId = await createCompletionNotification(
        mockWorkflow,
        mockArtifact,
        summary,
        summaryData
      );

      expect(notificationId).toBeTruthy();
      expect(typeof notificationId).toBe('string');

      // Verify notification was created in mock data
      const decisions = getMockData('system_decisions');
      expect(decisions.length).toBe(1);
      const notification = decisions[0];
      expect(notification.user_id).toBe('user-123');
      expect(notification.artifact_id).toBe('artifact-123');
      expect(notification.decision_type).toBe('workflow_complete');
      expect(notification.stage).toBe('complete');
      expect(notification.title).toBe('Artifact processed successfully');
      expect(notification.description).toBe(summary);
      expect(notification.confidence_score).toBe(100);
      expect(notification.blocking).toBe(false);
      expect(notification.status).toBe('auto_applied');
      expect(notification.review_type).toBe('suggestion');
    });

    it('should include correct payload fields', async () => {
      const summary = 'Test summary';
      const summaryData = {
        entitiesCreated: 1,
        entitiesLinked: 2,
        tasksCreated: 3,
        derivedArtifactsCreated: 0,
        tokensUsed: 1000,
        duration: '2m 30s',
      };

      await createCompletionNotification(mockWorkflow, mockArtifact, summary, summaryData);

      const decisions = getMockData('system_decisions');
      const notification = decisions[0];
      const payload = notification.decision_payload;

      expect(payload.workflowId).toBe(TEST_WORKFLOW_ID);
      expect(payload.artifactId).toBe('artifact-123');
      expect(payload.summary).toBeDefined();
      expect(payload.summary.entitiesCreated).toBe(1);
      expect(payload.summary.entitiesLinked).toBe(2);
      expect(payload.summary.tasksCreated).toBe(3);
      expect(payload.summary.derivedArtifactsCreated).toBe(0);
      expect(payload.summary.tokensUsed).toBe(1000);
      expect(payload.summary.duration).toBe('2m 30s');
    });

    it('should include duration in payload when started_at exists', async () => {
      const workflowWithStartTime = {
        ...mockWorkflow,
        started_at: '2025-01-24T10:00:00Z',
      };

      const summary = 'Test summary';
      const summaryData = {
        entitiesCreated: 0,
        entitiesLinked: 0,
        tasksCreated: 0,
        derivedArtifactsCreated: 0,
        tokensUsed: 500,
        duration: '1m 0s',
      };

      await createCompletionNotification(workflowWithStartTime, mockArtifact, summary, summaryData);

      const decisions = getMockData('system_decisions');
      const notification = decisions[0];
      expect(notification.decision_payload.summary.duration).toBe('1m 0s');
    });

    it('should set duration to null in payload when started_at is missing', async () => {
      const workflowWithoutStartTime = {
        ...mockWorkflow,
        started_at: null,
      };

      const summary = 'Test summary';
      const summaryData = {
        entitiesCreated: 0,
        entitiesLinked: 0,
        tasksCreated: 0,
        derivedArtifactsCreated: 0,
        tokensUsed: 500,
        duration: null,
      };

      await createCompletionNotification(workflowWithoutStartTime, mockArtifact, summary, summaryData);

      const decisions = getMockData('system_decisions');
      const notification = decisions[0];
      expect(notification.decision_payload.summary.duration).toBeNull();
    });

    it('should return null when notification creation fails', async () => {
      // Mock supabase to return an error on insert
      const originalFrom = mockSupabase.from;
      mockSupabase.from = jest.fn((table: string) => {
        if (table === 'system_decisions') {
          return {
            insert: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: null,
                  error: { message: 'Database error' },
                }),
              }),
            }),
          } as any;
        }
        return originalFrom(table);
      });

      const summary = 'Test summary';
      const summaryData = {
        entitiesCreated: 0,
        entitiesLinked: 0,
        tasksCreated: 0,
        derivedArtifactsCreated: 0,
        tokensUsed: 0,
        duration: null,
      };

      const notificationId = await createCompletionNotification(
        mockWorkflow,
        mockArtifact,
        summary,
        summaryData
      );

      expect(notificationId).toBeNull();

      // Restore original mock
      mockSupabase.from = originalFrom;
    });

    it('should return null when no ID is returned', async () => {
      // Mock supabase to return data without id
      const originalFrom = mockSupabase.from;
      mockSupabase.from = jest.fn((table: string) => {
        if (table === 'system_decisions') {
          return {
            insert: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: {},
                  error: null,
                }),
              }),
            }),
          } as any;
        }
        return originalFrom(table);
      });

      const summary = 'Test summary';
      const summaryData = {
        entitiesCreated: 0,
        entitiesLinked: 0,
        tasksCreated: 0,
        derivedArtifactsCreated: 0,
        tokensUsed: 0,
        duration: null,
      };

      const notificationId = await createCompletionNotification(
        mockWorkflow,
        mockArtifact,
        summary,
        summaryData
      );

      expect(notificationId).toBeNull();

      // Restore original mock
      mockSupabase.from = originalFrom;
    });
  });

  describe('executeFinalizeStep', () => {
    describe('Happy path', () => {
      it('should complete successfully with all outcomes present', async () => {
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
          tokens_used: 1500,
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

        // Setup workflow steps with outcomes
        const finalizeStep: WorkflowStep = createMockWorkflowStep({
          id: 7,
          workflow_id: workflowId,
          step_type: 'finalize',
          step_name: 'Finalize Workflow',
          step_order: 6,
          status: 'pending',
        });

        const organizeStep: WorkflowStep = createMockWorkflowStep({
          id: 3,
          workflow_id: workflowId,
          step_type: 'organize_entities',
          step_order: 2,
          status: 'completed',
          output: {
            entitiesCreated: [{ id: 'entity-1' }, { id: 'entity-2' }],
            entitiesLinked: [{ id: 'entity-1' }, { id: 'entity-2' }, { id: 'entity-3' }],
          },
        });

        const extractActionsStep: WorkflowStep = createMockWorkflowStep({
          id: 4,
          workflow_id: workflowId,
          step_type: 'extract_actions',
          step_order: 3,
          status: 'completed',
          output: {
            tasksCreated: [{ id: 'task-1' }, { id: 'task-2' }, { id: 'task-3' }],
          },
        });

        const createDerivedStep: WorkflowStep = createMockWorkflowStep({
          id: 5,
          workflow_id: workflowId,
          step_type: 'create_derived_artifact',
          step_order: 4,
          status: 'completed',
          output: {
            derivedArtifactId: 'derived-123',
          },
        });

        setMockData('workflow_steps', [organizeStep, extractActionsStep, createDerivedStep, finalizeStep]);
        setMockData('system_decisions', []);

        // Execute finalize step
        const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

        // Verify success
        expect(result.success).toBe(true);
        expect(result.notificationId).toBeTruthy();
        expect(result.summary).toBeTruthy();
        expect(result.summary).toContain('Linked to 3 entities');
        expect(result.summary).toContain('(2 new)');
        expect(result.summary).toContain('Created 3 tasks');
        expect(result.summary).toContain('Created cleaned version');

        // Verify artifact status updated
        const artifacts = getMockData('artifacts');
        const updatedArtifact = artifacts.find((a: any) => a.id === artifactId);
        expect(updatedArtifact.lifecycle_stage).toBe('complete');
        expect(updatedArtifact.processing_status).toBe('completed');

        // Verify workflow status updated
        const workflows = getMockData('workflows');
        const updatedWorkflow = workflows.find((w: any) => w.id === workflowId);
        expect(updatedWorkflow.status).toBe('completed');
        expect(updatedWorkflow.completed_at).toBeTruthy();

        // Verify notification created
        const decisions = getMockData('system_decisions');
        expect(decisions.length).toBe(1);
        expect(decisions[0].decision_type).toBe('workflow_complete');
      });

      it('should complete successfully with some outcomes present', async () => {
        const workflowId = TEST_WORKFLOW_ID;
        const artifactId = 'artifact-123';
        const userId = 'user-123';

        const workflow = createMockWorkflow({
          id: workflowId,
          user_id: userId,
          source_artifact_id: artifactId,
          status: 'in_progress',
          started_at: new Date().toISOString(),
          tokens_used: 500,
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

        const extractActionsStep: WorkflowStep = createMockWorkflowStep({
          id: 4,
          workflow_id: workflowId,
          step_type: 'extract_actions',
          step_order: 3,
          status: 'completed',
          output: {
            tasksCreated: [{ id: 'task-1' }],
          },
        });

        setMockData('workflow_steps', [extractActionsStep, finalizeStep]);
        setMockData('system_decisions', []);

        const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

        expect(result.success).toBe(true);
        expect(result.summary).toContain('Created 1 task');
        expect(result.summary).not.toContain('entities');
        expect(result.summary).not.toContain('derived');
      });

      it('should complete successfully with no outcomes', async () => {
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
        expect(result.summary).toContain('Artifact analyzed and stored');
      });

      it('should create notification successfully', async () => {
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
        expect(result.notificationId).toBeTruthy();

        const decisions = getMockData('system_decisions');
        expect(decisions.length).toBe(1);
        expect(decisions[0].decision_type).toBe('workflow_complete');
        expect(decisions[0].title).toBe('Artifact processed successfully');
      });
    });

    describe('Edge cases', () => {
      it('should handle workflow with no steps', async () => {
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

        const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

        expect(result.success).toBe(true);
        expect(result.summary).toContain('Artifact analyzed and stored');
      });

      it('should handle all steps skipped', async () => {
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

        const skippedStep: WorkflowStep = createMockWorkflowStep({
          id: 3,
          workflow_id: workflowId,
          step_type: 'organize_entities',
          step_order: 2,
          status: 'skipped',
          output: null,
        });

        setMockData('workflow_steps', [skippedStep, finalizeStep]);
        setMockData('system_decisions', []);

        const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

        expect(result.success).toBe(true);
        expect(result.summary).toContain('Artifact analyzed and stored');
      });

      it('should handle missing artifact gracefully', async () => {
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

        // Don't add artifact to mock data
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
      });

      it('should handle missing workflow.started_at', async () => {
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

        // Verify duration is null in notification payload
        const decisions = getMockData('system_decisions');
        expect(decisions[0].decision_payload.summary.duration).toBeNull();
      });
    });

    describe('Error cases', () => {
      it('should fail when workflow not found', async () => {
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
      });

      it('should fail when blocking pending decisions exist', async () => {
        const workflowId = TEST_WORKFLOW_ID;
        const artifactId = 'artifact-123';
        const userId = 'user-123';

        const workflow = createMockWorkflow({
          id: workflowId,
          user_id: userId,
          source_artifact_id: artifactId,
          status: 'in_progress',
        });
        setMockData('workflows', [workflow]);

        const finalizeStep: WorkflowStep = createMockWorkflowStep({
          id: 7,
          workflow_id: workflowId,
          step_type: 'finalize',
          step_order: 6,
          status: 'pending',
        });

        const otherStep: WorkflowStep = createMockWorkflowStep({
          id: 3,
          workflow_id: workflowId,
          step_type: 'organize_entities',
          step_order: 2,
          status: 'completed',
        });

        setMockData('workflow_steps', [otherStep, finalizeStep]);

        // Add blocking decision
        setMockData('system_decisions', [
          {
            id: 'decision-1',
            workflow_task_id: 3,
            status: 'pending',
            blocking: true,
          },
        ]);

        const result = await executeFinalizeStep(finalizeStep, WorkflowId.parse(workflowId), StepId.parse(finalizeStep.id));

        expect(result.success).toBe(false);
        expect(result.error).toBe('Cannot finalize workflow with blocking pending decisions');
      });

      it('should succeed when notification creation fails (notification is non-fatal)', async () => {
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
        // We need to ensure blocking decisions check passes first
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

        // Completion notification failure is non-fatal: artifact and workflow still complete
        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();

        // Restore original mock
        mockSupabase.from = originalFrom;
      });

      it('should fail when artifact update fails', async () => {
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

        // Restore original mock
        mockSupabase.from = originalFrom;
      });

      it('should fail when workflow update fails', async () => {
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

        // Restore original mock
        mockSupabase.from = originalFrom;
      });
    });
  });
});
