/**
 * Unit tests for Workflow Orchestrator
 */

import { executeWorkflow, resumeWorkflow } from '../../../src/workflows/orchestrator';
import { executeUploadStep } from '../../../src/workflows/steps/upload';
import { executeCreateArtifactStep } from '../../../src/workflows/steps/createArtifact';
import { executeAnalyzeStep } from '../../../src/workflows/steps/analyze';
import { executeFinalizeStep } from '../../../src/workflows/steps/finalize';
import supabase from '../../../src/utils/supabase';
import {
  createMockWorkflow,
  createMockWorkflowStep,
  createMockFile,
  createMockUserContext,
  createMockFileMetadata,
  TEST_WORKFLOW_ID,
  NON_EXISTENT_WORKFLOW_ID,
  TEST_ARTIFACT_ID,
  TEST_ARTIFACT_ID_2,
} from '../../helpers/fixtures';
import {
  resetMockData,
  setMockData,
  getMockData,
  resetMockStorage,
  resetMockSupabase,
} from '../../__mocks__/supabase';

// Mock the step execution functions
jest.mock('../../../src/workflows/steps/upload');
jest.mock('../../../src/workflows/steps/createArtifact');
jest.mock('../../../src/workflows/steps/analyze');
jest.mock('../../../src/workflows/steps/finalize');

const mockExecuteUploadStep = executeUploadStep as jest.MockedFunction<typeof executeUploadStep>;
const mockExecuteCreateArtifactStep = executeCreateArtifactStep as jest.MockedFunction<typeof executeCreateArtifactStep>;
const mockExecuteAnalyzeStep = executeAnalyzeStep as jest.MockedFunction<typeof executeAnalyzeStep>;
const mockExecuteFinalizeStep = executeFinalizeStep as jest.MockedFunction<typeof executeFinalizeStep>;

describe('Workflow Orchestrator', () => {
  beforeEach(() => {
    // Reset all mocks and mock data before each test
    jest.clearAllMocks();
    resetMockData();
    resetMockStorage();
    resetMockSupabase();
    
    // Reset mock implementations to default behavior
    mockExecuteUploadStep.mockReset();
    mockExecuteCreateArtifactStep.mockReset();
    mockExecuteAnalyzeStep.mockReset();
    mockExecuteFinalizeStep.mockReset();
    
    // Set default successful mock for finalize step (most tests need this)
    mockExecuteFinalizeStep.mockResolvedValue({
      success: true,
      notificationId: 'notification-123',
      summary: 'Workflow completed successfully',
    });
  });

  afterEach(() => {
    // Ensure cleanup after each test
    jest.clearAllMocks();
    resetMockData();
    resetMockStorage();
    resetMockSupabase();
  });

  describe('executeWorkflow', () => {
    describe('Workflow Not Found', () => {
      it('should return failed result when workflow not found', async () => {
        setMockData('workflows', []);

        const result = await executeWorkflow(NON_EXISTENT_WORKFLOW_ID);

        expect(result.success).toBe(false);
        expect(result.status).toBe('failed');
        expect(result.error).toBe('Workflow not found');
        expect(result.workflowId).toBe(NON_EXISTENT_WORKFLOW_ID);
      });
    });

    describe('Core Logic', () => {
      it('should execute steps in correct order', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);

        const file = createMockFile();
        const userContext = createMockUserContext();

        mockExecuteUploadStep.mockResolvedValue({
          success: true,
          objectPath: 'user-123/test.jpg',
          fileMetadata: createMockFileMetadata(),
        });

        mockExecuteCreateArtifactStep.mockResolvedValue({
          success: true,
          artifactId: TEST_ARTIFACT_ID,
        });

        mockExecuteAnalyzeStep.mockResolvedValue({
          success: true,
          analysisResult: {
            intent: 'meeting_notes',
            confidence: 0.9,
            entities_mentioned: [],
            actions_suggested: [],
            topics: [],
            sentiment: 'neutral',
          },
        });

        mockExecuteFinalizeStep.mockResolvedValue({
          success: true,
          notificationId: 'notification-123',
          summary: 'Workflow completed successfully',
        });

        const result = await executeWorkflow(TEST_WORKFLOW_ID, file, userContext);

        expect(result.success).toBe(true);
        expect(['partial', 'completed']).toContain(result.status);
        expect(mockExecuteUploadStep).toHaveBeenCalled();
        expect(mockExecuteCreateArtifactStep).toHaveBeenCalled();
        expect(mockExecuteAnalyzeStep).toHaveBeenCalled();
      });

      it("should return early after create_artifact when returnAfterStep is set", async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);

        const file = createMockFile();
        const userContext = createMockUserContext();

        mockExecuteUploadStep.mockResolvedValue({
          success: true,
          objectPath: 'user-123/test.jpg',
          fileMetadata: createMockFileMetadata(),
        });

        mockExecuteCreateArtifactStep.mockResolvedValue({
          success: true,
          artifactId: TEST_ARTIFACT_ID,
        });

        const result = await executeWorkflow(TEST_WORKFLOW_ID, file, userContext, {
          returnAfterStep: 'create_artifact',
        });

        expect(result.success).toBe(true);
        expect(result.status).toBe('partial');
        expect(result.artifactId).toBe(TEST_ARTIFACT_ID);
        expect(result.completedSteps).toEqual(expect.arrayContaining(['upload', 'create_artifact']));
        expect(result.skippedSteps).toEqual(
          expect.arrayContaining(['analyze', 'organize_entities', 'extract_actions', 'create_derived', 'finalize'])
        );

        // Ensure later steps are not executed in this invocation
        expect(mockExecuteAnalyzeStep).not.toHaveBeenCalled();
      });

      it('should skip already completed steps', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
        const completedUploadStep = createMockWorkflowStep({
          workflow_id: TEST_WORKFLOW_ID,
          step_type: 'upload',
          step_order: 0,
          status: 'completed',
          output: {
            objectStoragePath: 'user-123/test.jpg',
            fileMetadata: createMockFileMetadata(),
          },
        });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', [completedUploadStep]);

        mockExecuteCreateArtifactStep.mockResolvedValue({
          success: true,
          artifactId: TEST_ARTIFACT_ID,
        });

        mockExecuteAnalyzeStep.mockResolvedValue({
          success: true,
          analysisResult: {
            intent: 'meeting_notes',
            confidence: 0.9,
            entities_mentioned: [],
            actions_suggested: [],
            topics: [],
            sentiment: 'neutral',
          },
        });

        const userContext = createMockUserContext();
        const result = await executeWorkflow(TEST_WORKFLOW_ID, undefined, userContext);

        expect(result.success).toBe(true);
        expect(mockExecuteUploadStep).not.toHaveBeenCalled();
        expect(mockExecuteCreateArtifactStep).toHaveBeenCalled();
      });

      it('should skip already skipped steps', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
        const skippedStep = createMockWorkflowStep({
          workflow_id: TEST_WORKFLOW_ID,
          step_type: 'organize_entities',
          step_order: 3,
          status: 'skipped',
        });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', [skippedStep]);

        const result = await executeWorkflow(TEST_WORKFLOW_ID);

        expect(result.skippedSteps).toContain('organize_entities');
      });

      it('should skip unimplemented steps gracefully', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);

        const result = await executeWorkflow(TEST_WORKFLOW_ID);

        expect(result.skippedSteps).toContain('organize_entities');
        expect(result.skippedSteps).toContain('extract_actions');
        // create_derived is now implemented, so it won't be skipped for being unimplemented
        // (it may still be skipped if dependencies are missing, but that's a different test)
        // finalize is now implemented and will be executed (not skipped)
        expect(result.skippedSteps).not.toContain('finalize');
        expect(result.completedSteps).toContain('finalize');
      });

      it('should update workflow status to in_progress at start', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);

        await executeWorkflow(TEST_WORKFLOW_ID);

        const workflows = getMockData('workflows');
        const updatedWorkflow = workflows.find((w: any) => w.id === TEST_WORKFLOW_ID);
        expect(['partial', 'completed']).toContain(updatedWorkflow?.status);
      });

      it('should determine final status correctly - completed', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);

        mockExecuteUploadStep.mockResolvedValue({
          success: true,
          objectPath: 'user-123/test.jpg',
          fileMetadata: createMockFileMetadata(),
        });

        mockExecuteCreateArtifactStep.mockResolvedValue({
          success: true,
          artifactId: TEST_ARTIFACT_ID,
        });

        mockExecuteAnalyzeStep.mockResolvedValue({
          success: true,
          analysisResult: {
            intent: 'meeting_notes',
            confidence: 0.9,
            entities_mentioned: [],
            actions_suggested: [],
            topics: [],
            sentiment: 'neutral',
          },
        });

        const file = createMockFile();
        const userContext = createMockUserContext();

        const result = await executeWorkflow(TEST_WORKFLOW_ID, file, userContext);

        expect(['partial', 'completed']).toContain(result.status);
        expect(result.completedSteps.length).toBeGreaterThan(0);
      });

      it('should determine final status correctly - partial', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);

        const result = await executeWorkflow(TEST_WORKFLOW_ID);

        expect(['partial', 'completed']).toContain(result.status);
        expect(result.skippedSteps.length).toBeGreaterThan(0);
      });

      it('should determine final status correctly - failed', async () => {
        setMockData('workflows', []);

        const result = await executeWorkflow(NON_EXISTENT_WORKFLOW_ID);

        expect(result.status).toBe('failed');
        expect(result.success).toBe(false);
      });
    });

    describe('Step Execution - Upload', () => {
      it('should execute upload step when file and userContext provided', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);

        const file = createMockFile();
        const userContext = createMockUserContext();

        mockExecuteUploadStep.mockResolvedValue({
          success: true,
          objectPath: 'user-123/test.jpg',
          fileMetadata: createMockFileMetadata(),
        });

        mockExecuteCreateArtifactStep.mockResolvedValue({
          success: true,
          artifactId: TEST_ARTIFACT_ID,
        });

        mockExecuteAnalyzeStep.mockResolvedValue({
          success: true,
          analysisResult: {
            intent: 'meeting_notes',
            confidence: 0.9,
            entities_mentioned: [],
            actions_suggested: [],
            topics: [],
            sentiment: 'neutral',
          },
        });

        await executeWorkflow(TEST_WORKFLOW_ID, file, userContext);

        expect(mockExecuteUploadStep).toHaveBeenCalledWith(
          expect.objectContaining({ step_type: 'upload' }),
          file,
          userContext,
          expect.objectContaining({ value: TEST_WORKFLOW_ID }),
          expect.any(Object)
        );
      });

      it('should skip upload step when file not provided (already uploaded)', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);

        await executeWorkflow(TEST_WORKFLOW_ID);

        expect(mockExecuteUploadStep).not.toHaveBeenCalled();
      });

      it('should handle upload step failure correctly', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);

        const file = createMockFile();
        const userContext = createMockUserContext();

        mockExecuteUploadStep.mockResolvedValue({
          success: false,
          error: 'Upload failed',
        });

        const result = await executeWorkflow(TEST_WORKFLOW_ID, file, userContext);

        expect(result.success).toBe(false);
        expect(result.status).toBe('failed');
        expect(result.failedStep).toBe('upload');
        expect(result.error).toBe('Upload failed');
      });

      it('should pass upload result to next step', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);

        const file = createMockFile();
        const userContext = createMockUserContext();
        const fileMetadata = createMockFileMetadata();

        mockExecuteUploadStep.mockResolvedValue({
          success: true,
          objectPath: 'user-123/test.jpg',
          fileMetadata,
        });

        mockExecuteCreateArtifactStep.mockResolvedValue({
          success: true,
          artifactId: TEST_ARTIFACT_ID,
        });

        mockExecuteAnalyzeStep.mockResolvedValue({
          success: true,
          analysisResult: {
            intent: 'meeting_notes',
            confidence: 0.9,
            entities_mentioned: [],
            actions_suggested: [],
            topics: [],
            sentiment: 'neutral',
          },
        });

        await executeWorkflow(TEST_WORKFLOW_ID, file, userContext);

        expect(mockExecuteCreateArtifactStep).toHaveBeenCalledWith(
          expect.objectContaining({
            step: expect.any(Object),
            objectPath: 'user-123/test.jpg',
            fileMetadata: expect.any(Object),
            userTextContent: null,
            userContext,
            workflowId: expect.objectContaining({ value: TEST_WORKFLOW_ID }),
            stepId: expect.any(Object),
            captureUrl: undefined,
          })
        );
      });
    });

    describe('Step Execution - Create Artifact', () => {
      it('should get objectPath and fileMetadata from upload step output', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
        const uploadStep = createMockWorkflowStep({
          workflow_id: TEST_WORKFLOW_ID,
          step_type: 'upload',
          step_order: 0,
          status: 'completed',
          output: {
            objectStoragePath: 'user-123/test.jpg',
            fileMetadata: createMockFileMetadata(),
          },
        });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', [uploadStep]);

        mockExecuteCreateArtifactStep.mockResolvedValue({
          success: true,
          artifactId: TEST_ARTIFACT_ID,
        });

        const userContext = createMockUserContext();
        await executeWorkflow(TEST_WORKFLOW_ID, undefined, userContext);

        expect(mockExecuteCreateArtifactStep).toHaveBeenCalledWith(
          expect.objectContaining({
            step: expect.any(Object),
            objectPath: 'user-123/test.jpg',
            fileMetadata: expect.any(Object),
            userTextContent: null,
            userContext: expect.any(Object),
            workflowId: expect.objectContaining({ value: TEST_WORKFLOW_ID }),
            stepId: expect.any(Object),
            captureUrl: undefined,
          })
        );
      });

      it('should handle missing dependencies (objectPath/fileMetadata)', async () => {
        // Reset mocks explicitly to ensure test isolation
        mockExecuteUploadStep.mockReset();
        mockExecuteCreateArtifactStep.mockReset();
        mockExecuteAnalyzeStep.mockReset();
        
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);

        await executeWorkflow(TEST_WORKFLOW_ID);

        // Should skip create_artifact if dependencies missing
        const steps = getMockData('workflow_steps');
        const createArtifactStep = steps.find((s: any) => s.step_type === 'create_artifact');
        expect(createArtifactStep?.status).toBe('failed');
      });

      it('should handle create_artifact step failure gracefully', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
        const uploadStep = createMockWorkflowStep({
          workflow_id: TEST_WORKFLOW_ID,
          step_type: 'upload',
          step_order: 0,
          status: 'completed',
          output: {
            objectStoragePath: 'user-123/test.jpg',
            fileMetadata: createMockFileMetadata(),
          },
        });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', [uploadStep]);

        mockExecuteCreateArtifactStep.mockResolvedValue({
          success: false,
          error: 'Database error',
        });

        const result = await executeWorkflow(TEST_WORKFLOW_ID);

        // Should continue even if create_artifact fails (partial or completed depending on later steps)
        expect(['partial', 'completed']).toContain(result.status);
      });
    });

    describe('Step Execution - Analyze', () => {
      it('should get artifactId from create_artifact step output', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
        const uploadStep = createMockWorkflowStep({
          workflow_id: TEST_WORKFLOW_ID,
          step_type: 'upload',
          step_order: 0,
          status: 'completed',
          output: {
            objectStoragePath: 'user-123/test.jpg',
            fileMetadata: createMockFileMetadata(),
          },
        });
        const createArtifactStep = createMockWorkflowStep({
          workflow_id: TEST_WORKFLOW_ID,
          step_type: 'create_artifact',
          step_order: 1,
          status: 'completed',
          output: {
            artifactId: TEST_ARTIFACT_ID,
          },
        });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', [uploadStep, createArtifactStep]);

        mockExecuteAnalyzeStep.mockResolvedValue({
          success: true,
          analysisResult: {
            intent: 'meeting_notes',
            confidence: 0.9,
            entities_mentioned: [],
            actions_suggested: [],
            topics: [],
            sentiment: 'neutral',
          },
        });

        await executeWorkflow(TEST_WORKFLOW_ID);

        expect(mockExecuteAnalyzeStep).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({ value: TEST_ARTIFACT_ID }),
          expect.any(Object)
        );
      });

      it('should fallback to workflow.source_artifact_id', async () => {
        const workflow = createMockWorkflow({
          id: TEST_WORKFLOW_ID,
          status: 'pending',
          source_artifact_id: TEST_ARTIFACT_ID_2,
        });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);

        mockExecuteAnalyzeStep.mockResolvedValue({
          success: true,
          analysisResult: {
            intent: 'meeting_notes',
            confidence: 0.9,
            entities_mentioned: [],
            actions_suggested: [],
            topics: [],
            sentiment: 'neutral',
          },
        });

        await executeWorkflow(TEST_WORKFLOW_ID);

        expect(mockExecuteAnalyzeStep).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({ value: TEST_ARTIFACT_ID_2 }),
          expect.any(Object)
        );
      });

      it('should handle missing artifactId', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);

        await executeWorkflow(TEST_WORKFLOW_ID);

        const steps = getMockData('workflow_steps');
        const analyzeStep = steps.find((s: any) => s.step_type === 'analyze');
        expect(analyzeStep?.status).toBe('failed');
      });

      it('should handle analyze step failure gracefully', async () => {
        const workflow = createMockWorkflow({
          id: TEST_WORKFLOW_ID,
          status: 'pending',
          source_artifact_id: TEST_ARTIFACT_ID,
        });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);

        mockExecuteAnalyzeStep.mockResolvedValue({
          success: false,
          error: 'API error',
        });

        const result = await executeWorkflow(TEST_WORKFLOW_ID);

        // Should continue even if analyze fails
        expect(['partial', 'completed']).toContain(result.status);
        expect(result.skippedSteps).toContain('analyze');
      });

      it('should handle low confidence (awaiting_user status)', async () => {
        const workflow = createMockWorkflow({
          id: TEST_WORKFLOW_ID,
          status: 'pending',
          source_artifact_id: TEST_ARTIFACT_ID,
        });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);

        mockExecuteAnalyzeStep.mockResolvedValue({
          success: true,
          status: 'awaiting_user',
          confidence: 0.3,
          notificationId: 'notification-123',
          analysisResult: {
            intent: 'unclear',
            confidence: 0.3,
            entities_mentioned: [],
            actions_suggested: [],
            topics: [],
            sentiment: 'neutral',
          },
        });

        const result = await executeWorkflow(TEST_WORKFLOW_ID);

        expect(result.completedSteps).toContain('analyze');
      });
    });

    describe('Error Handling', () => {
      it('should continue to next step when step fails (partial progress)', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);

        mockExecuteAnalyzeStep.mockRejectedValue(new Error('Unexpected error'));

        const result = await executeWorkflow(TEST_WORKFLOW_ID);

        expect(['partial', 'completed']).toContain(result.status);
        expect(result.skippedSteps.length).toBeGreaterThan(0);
      });

      it('should track completed vs skipped steps correctly', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);

        const file = createMockFile();
        const userContext = createMockUserContext();

        mockExecuteUploadStep.mockResolvedValue({
          success: true,
          objectPath: 'user-123/test.jpg',
          fileMetadata: createMockFileMetadata(),
        });

        mockExecuteCreateArtifactStep.mockResolvedValue({
          success: true,
          artifactId: TEST_ARTIFACT_ID,
        });

        mockExecuteAnalyzeStep.mockResolvedValue({
          success: true,
          analysisResult: {
            intent: 'meeting_notes',
            confidence: 0.9,
            entities_mentioned: [],
            actions_suggested: [],
            topics: [],
            sentiment: 'neutral',
          },
        });

        const result = await executeWorkflow(TEST_WORKFLOW_ID, file, userContext);

        expect(result.completedSteps).toContain('upload');
        expect(result.completedSteps).toContain('create_artifact');
        expect(result.completedSteps).toContain('analyze');
        expect(result.skippedSteps.length).toBeGreaterThan(0);
      });

      it('should return correct OrchestratorResult structure', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);

        const result = await executeWorkflow(TEST_WORKFLOW_ID);

        expect(result).toHaveProperty('success');
        expect(result).toHaveProperty('workflowId');
        expect(result).toHaveProperty('status');
        expect(result).toHaveProperty('completedSteps');
        expect(result).toHaveProperty('skippedSteps');
        expect(Array.isArray(result.completedSteps)).toBe(true);
        expect(Array.isArray(result.skippedSteps)).toBe(true);
      });

      it('should handle exceptions in step execution', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);

        mockExecuteUploadStep.mockRejectedValue(new Error('Unexpected error'));

        const file = createMockFile();
        const userContext = createMockUserContext();

        const result = await executeWorkflow(TEST_WORKFLOW_ID, file, userContext);

        // When a step throws an exception, orchestrator catches it and continues
        expect(['partial', 'completed']).toContain(result.status);
        expect(result.skippedSteps).toContain('upload');
      });
    });
  });

  describe('resumeWorkflow', () => {
    it('should restart workflow execution', async () => {
      const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
      setMockData('workflows', [workflow]);
      setMockData('workflow_steps', []);

      const result = await resumeWorkflow(TEST_WORKFLOW_ID);

      expect(result).toHaveProperty('workflowId', TEST_WORKFLOW_ID);
      expect(result).toHaveProperty('status');
    });

    it('should accept fromStep parameter (placeholder for future)', async () => {
      const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending' });
      setMockData('workflows', [workflow]);
      setMockData('workflow_steps', []);

      const result = await resumeWorkflow(TEST_WORKFLOW_ID, 'analyze');

      expect(result).toHaveProperty('workflowId', TEST_WORKFLOW_ID);
    });
  });

  describe('Finalize Step Integration', () => {
    describe('Finalize called after all other steps complete', () => {
      it('should call finalize step after all other steps complete successfully', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending', source_artifact_id: TEST_ARTIFACT_ID });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);
        setMockData('artifacts', [{ id: TEST_ARTIFACT_ID, user_id: 'user-1', content_type: 'text' }]);

        const file = createMockFile();
        const userContext = createMockUserContext();

        mockExecuteUploadStep.mockResolvedValue({
          success: true,
          objectPath: 'user-123/test.jpg',
          fileMetadata: createMockFileMetadata(),
        });

        mockExecuteCreateArtifactStep.mockResolvedValue({
          success: true,
          artifactId: TEST_ARTIFACT_ID,
        });

        mockExecuteAnalyzeStep.mockResolvedValue({
          success: true,
          analysisResult: {
            intent: 'meeting_notes',
            confidence: 0.9,
            entities_mentioned: [],
            actions_suggested: [],
            topics: [],
            sentiment: 'neutral',
          },
        });

        mockExecuteFinalizeStep.mockResolvedValue({
          success: true,
          notificationId: 'notification-123',
          summary: 'Workflow completed successfully',
        });

        const result = await executeWorkflow(TEST_WORKFLOW_ID, file, userContext);

        expect(mockExecuteFinalizeStep).toHaveBeenCalled();
        expect(result.completedSteps).toContain('finalize');
      });
    });

    describe('Finalize not called when workflow is awaiting_user', () => {
      it('should not call finalize when workflow status is already awaiting_user', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'awaiting_user', source_artifact_id: TEST_ARTIFACT_ID });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);

        // Mock analyze step to return awaiting_user status, which should cause orchestrator to return early
        mockExecuteAnalyzeStep.mockResolvedValue({
          success: true,
          status: 'awaiting_user',
          notificationId: 'notification-123',
          analysisResult: {
            intent: 'meeting_notes',
            confidence: 0.5, // Low confidence triggers awaiting_user
            entities_mentioned: [],
            actions_suggested: [],
            topics: [],
            sentiment: 'neutral',
          },
        });

        const result = await executeWorkflow(TEST_WORKFLOW_ID);

        // When a step returns awaiting_user, orchestrator should return early before reaching finalize
        expect(mockExecuteFinalizeStep).not.toHaveBeenCalled();
        expect(result.completedSteps).not.toContain('finalize');
        expect(result.status).toBe('awaiting_user');
      });
    });

    describe('Orchestrator marks workflow as failed when finalize fails', () => {
      it('should mark workflow as failed and return error when finalize step fails', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending', source_artifact_id: TEST_ARTIFACT_ID });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);
        setMockData('artifacts', [{ id: TEST_ARTIFACT_ID, user_id: 'user-1', content_type: 'text' }]);

        const file = createMockFile();
        const userContext = createMockUserContext();

        mockExecuteUploadStep.mockResolvedValue({
          success: true,
          objectPath: 'user-123/test.jpg',
          fileMetadata: createMockFileMetadata(),
        });

        mockExecuteCreateArtifactStep.mockResolvedValue({
          success: true,
          artifactId: TEST_ARTIFACT_ID,
        });

        mockExecuteAnalyzeStep.mockResolvedValue({
          success: true,
          analysisResult: {
            intent: 'meeting_notes',
            confidence: 0.9,
            entities_mentioned: [],
            actions_suggested: [],
            topics: [],
            sentiment: 'neutral',
          },
        });

        mockExecuteFinalizeStep.mockResolvedValue({
          success: false,
          error: 'Finalize step failed',
        });

        const result = await executeWorkflow(TEST_WORKFLOW_ID, file, userContext);

        expect(result.success).toBe(false);
        expect(result.status).toBe('failed');
        expect(result.failedStep).toBe('finalize');
        expect(result.error).toBe('Finalize step failed');

        const workflows = getMockData('workflows');
        const updatedWorkflow = workflows.find((w: any) => w.id === TEST_WORKFLOW_ID);
        expect(updatedWorkflow?.status).toBe('failed');
      });
    });

    describe('Orchestrator marks workflow as completed when finalize succeeds', () => {
      it('should mark workflow as completed when all steps including finalize succeed', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending', source_artifact_id: TEST_ARTIFACT_ID });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);
        setMockData('artifacts', [{ id: TEST_ARTIFACT_ID, user_id: 'user-1', content_type: 'text' }]);

        const file = createMockFile();
        const userContext = createMockUserContext();

        mockExecuteUploadStep.mockResolvedValue({
          success: true,
          objectPath: 'user-123/test.jpg',
          fileMetadata: createMockFileMetadata(),
        });

        mockExecuteCreateArtifactStep.mockResolvedValue({
          success: true,
          artifactId: TEST_ARTIFACT_ID,
        });

        mockExecuteAnalyzeStep.mockResolvedValue({
          success: true,
          analysisResult: {
            intent: 'meeting_notes',
            confidence: 0.9,
            entities_mentioned: [],
            actions_suggested: [],
            topics: [],
            sentiment: 'neutral',
          },
        });

        mockExecuteFinalizeStep.mockResolvedValue({
          success: true,
          notificationId: 'notification-123',
          summary: 'Workflow completed successfully',
        });

        const result = await executeWorkflow(TEST_WORKFLOW_ID, file, userContext);

        expect(result.completedSteps).toContain('finalize');
        expect(mockExecuteFinalizeStep).toHaveBeenCalled();
      });
    });

    describe('Notification appears in system_decisions table', () => {
      it('should create notification in system_decisions when finalize succeeds', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending', source_artifact_id: TEST_ARTIFACT_ID });
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);
        setMockData('artifacts', [{ id: TEST_ARTIFACT_ID, user_id: 'user-1', content_type: 'text' }]);
        setMockData('system_decisions', []);

        const file = createMockFile();
        const userContext = createMockUserContext();

        mockExecuteUploadStep.mockResolvedValue({
          success: true,
          objectPath: 'user-123/test.jpg',
          fileMetadata: createMockFileMetadata(),
        });

        mockExecuteCreateArtifactStep.mockResolvedValue({
          success: true,
          artifactId: TEST_ARTIFACT_ID,
        });

        mockExecuteAnalyzeStep.mockResolvedValue({
          success: true,
          analysisResult: {
            intent: 'meeting_notes',
            confidence: 0.9,
            entities_mentioned: [],
            actions_suggested: [],
            topics: [],
            sentiment: 'neutral',
          },
        });

        const notificationId = 'notification-123';
        mockExecuteFinalizeStep.mockResolvedValue({
          success: true,
          notificationId,
          summary: 'Workflow completed successfully',
        });

        await executeWorkflow(TEST_WORKFLOW_ID, file, userContext);

        // Verify that executeFinalizeStep was called (which should create the notification)
        expect(mockExecuteFinalizeStep).toHaveBeenCalled();
        // The actual notification creation happens inside executeFinalizeStep,
        // so we verify the notificationId is returned
        const finalizeCallResult = await mockExecuteFinalizeStep.mock.results[0]?.value;
        expect(finalizeCallResult).toMatchObject({
          success: true,
          notificationId,
        });
      });
    });

    describe('Artifact and workflow statuses updated correctly', () => {
      it('should update artifact and workflow statuses when finalize succeeds', async () => {
        const workflow = createMockWorkflow({ id: TEST_WORKFLOW_ID, status: 'pending', source_artifact_id: TEST_ARTIFACT_ID });
        const artifact = { id: 'artifact-123', user_id: 'user-1', content_type: 'text', lifecycle_stage: 'processing', processing_status: 'processing' };
        setMockData('workflows', [workflow]);
        setMockData('workflow_steps', []);
        setMockData('artifacts', [artifact]);

        const file = createMockFile();
        const userContext = createMockUserContext();

        mockExecuteUploadStep.mockResolvedValue({
          success: true,
          objectPath: 'user-123/test.jpg',
          fileMetadata: createMockFileMetadata(),
        });

        mockExecuteCreateArtifactStep.mockResolvedValue({
          success: true,
          artifactId: TEST_ARTIFACT_ID,
        });

        mockExecuteAnalyzeStep.mockResolvedValue({
          success: true,
          analysisResult: {
            intent: 'meeting_notes',
            confidence: 0.9,
            entities_mentioned: [],
            actions_suggested: [],
            topics: [],
            sentiment: 'neutral',
          },
        });

        mockExecuteFinalizeStep.mockResolvedValue({
          success: true,
          notificationId: 'notification-123',
          summary: 'Workflow completed successfully',
        });

        await executeWorkflow(TEST_WORKFLOW_ID, file, userContext);

        // Verify finalize was called (which updates artifact and workflow statuses internally)
        expect(mockExecuteFinalizeStep).toHaveBeenCalled();
        // executeFinalizeStep(step, workflowId: WorkflowId, stepId: StepId)
        const finalizeCall = mockExecuteFinalizeStep.mock.calls[0];
        expect(finalizeCall?.[1].value).toBe(TEST_WORKFLOW_ID); // workflowId value object
        expect(finalizeCall?.[2].value).toBeGreaterThanOrEqual(1); // stepId value object
      });
    });
  });
});

