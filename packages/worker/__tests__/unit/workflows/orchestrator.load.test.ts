/**
 * Load tests for Workflow Orchestrator
 * 
 * These tests verify the orchestrator's ability to handle multiple concurrent workflows
 * without interference, and measure performance under load.
 */

import { executeWorkflow } from '../../../src/workflows/orchestrator';
import { executeUploadStep } from '../../../src/workflows/steps/upload';
import { executeCreateArtifactStep } from '../../../src/workflows/steps/createArtifact';
import { executeAnalyzeStep } from '../../../src/workflows/steps/analyze';
import { executeFinalizeStep } from '../../../src/workflows/steps/finalize';
import {
  createMockWorkflow,
  createMockWorkflowStep,
  createMockFile,
  createMockUserContext,
  createMockFileMetadata,
  createMockArtifact,
  TEST_WORKFLOW_ID,
  TEST_WORKFLOW_ID_2,
  TEST_WORKFLOW_ID_3,
  LOAD_TEST_WORKFLOW_IDS,
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

describe('Orchestrator Load Tests - Concurrent Workflows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMockData();
    resetMockStorage();
    resetMockSupabase();
    
    mockExecuteUploadStep.mockReset();
    mockExecuteCreateArtifactStep.mockReset();
    mockExecuteAnalyzeStep.mockReset();
    mockExecuteFinalizeStep.mockReset();
  });

  afterEach(() => {
    jest.clearAllMocks();
    resetMockData();
    resetMockStorage();
    resetMockSupabase();
  });

  /**
   * Helper function to create a workflow with all necessary setup
   */
  function setupWorkflow(workflowId: string, userId: string = 'user-123') {
    const workflow = createMockWorkflow({
      id: workflowId,
      status: 'pending',
      user_id: userId,
      source_artifact_id: null,
    });
    setMockData('workflows', [...getMockData('workflows'), workflow]);

    // Setup mock step responses (use valid UUID for artifactId - orchestrator parses it)
    const artifactId = workflowId;
    const objectPath = `user-${userId}/${workflowId}/test.jpg`;

    mockExecuteUploadStep.mockImplementation(async (step, file, userContext) => {
      // Simulate some async work
      await new Promise(resolve => setTimeout(resolve, 10));
      return {
        success: true,
        objectPath,
        fileMetadata: createMockFileMetadata({
          objectPath,
          fileName: `test-${workflowId}.jpg`,
        }),
      };
    });

    mockExecuteCreateArtifactStep.mockImplementation(async (_input) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      const artifact = createMockArtifact({
        id: artifactId,
        user_id: userId,
        storage_path: objectPath,
      });
      setMockData('artifacts', [...getMockData('artifacts'), artifact]);
      return {
        success: true,
        artifactId,
      };
    });

    mockExecuteAnalyzeStep.mockImplementation(async (step, artifactIdParam) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return {
        success: true,
        analysisResult: {
          intent: 'meeting_notes',
          confidence: 0.9,
          entities_mentioned: [],
          actions_suggested: [],
          topics: [],
          sentiment: 'neutral',
        },
      };
    });

    mockExecuteFinalizeStep.mockImplementation(async (step, _workflowIdParam, _stepIdParam) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return {
        success: true,
        summary: `Workflow ${workflowId} completed successfully`,
      };
    });

    return { workflow, artifactId, objectPath };
  }

  describe('Concurrent workflow execution', () => {
    it('should handle 5 concurrent workflows successfully', async () => {
      const concurrency = 5;
      const workflows: Array<{ id: string; file: any; userContext: any }> = [];

      // Setup all workflows (valid UUIDs)
      for (let i = 0; i < concurrency; i++) {
        const workflowId = LOAD_TEST_WORKFLOW_IDS[i];
        setupWorkflow(workflowId);
        workflows.push({
          id: workflowId,
          file: createMockFile({ name: `test-${i}.jpg` }),
          userContext: createMockUserContext({ userId: `user-${i}` }),
        });
      }

      // Execute all workflows concurrently
      const startTime = Date.now();
      const results = await Promise.all(
        workflows.map(({ id, file, userContext }) =>
          executeWorkflow(id, file, userContext)
        )
      );
      const endTime = Date.now();
      const duration = endTime - startTime;

      // Verify all workflows completed successfully
      expect(results).toHaveLength(concurrency);
      results.forEach((result, index) => {
        expect(result.success).toBe(true);
        expect(result.workflowId).toBe(LOAD_TEST_WORKFLOW_IDS[index]);
        expect(['partial', 'completed']).toContain(result.status); // completed when finalize runs; partial when steps skipped
      });

      // Verify all workflows were created in database
      const allWorkflows = getMockData('workflows');
      expect(allWorkflows.length).toBeGreaterThanOrEqual(concurrency);

      // Performance check: should complete reasonably quickly
      expect(duration).toBeLessThan(5000); // 5 seconds max for 5 concurrent workflows

      console.log(`[Load Test] 5 concurrent workflows completed in ${duration}ms`);
    }, 10000); // 10 second timeout

    it('should handle 10 concurrent workflows successfully', async () => {
      const concurrency = 10;
      const workflows: Array<{ id: string; file: any; userContext: any }> = [];

      // Setup all workflows (valid UUIDs)
      for (let i = 0; i < concurrency; i++) {
        const workflowId = LOAD_TEST_WORKFLOW_IDS[i];
        setupWorkflow(workflowId);
        workflows.push({
          id: workflowId,
          file: createMockFile({ name: `test-${i}.jpg` }),
          userContext: createMockUserContext({ userId: `user-${i}` }),
        });
      }

      // Execute all workflows concurrently
      const startTime = Date.now();
      const results = await Promise.all(
        workflows.map(({ id, file, userContext }) =>
          executeWorkflow(id, file, userContext)
        )
      );
      const endTime = Date.now();
      const duration = endTime - startTime;

      // Verify all workflows completed successfully
      expect(results).toHaveLength(concurrency);
      const successCount = results.filter(r => r.success).length;
      expect(successCount).toBe(concurrency);

      // Verify workflows don't interfere with each other
      const uniqueWorkflowIds = new Set(results.map(r => r.workflowId));
      expect(uniqueWorkflowIds.size).toBe(concurrency);

      // Performance check
      expect(duration).toBeLessThan(10000); // 10 seconds max for 10 concurrent workflows

      console.log(`[Load Test] 10 concurrent workflows completed in ${duration}ms (${successCount}/${concurrency} successful)`);
    }, 15000); // 15 second timeout

    it('should handle 20 concurrent workflows successfully', async () => {
      const concurrency = 20;
      const workflows: Array<{ id: string; file: any; userContext: any }> = [];

      // Setup all workflows (valid UUIDs)
      for (let i = 0; i < concurrency; i++) {
        const workflowId = LOAD_TEST_WORKFLOW_IDS[i];
        setupWorkflow(workflowId);
        workflows.push({
          id: workflowId,
          file: createMockFile({ name: `test-${i}.jpg` }),
          userContext: createMockUserContext({ userId: `user-${i}` }),
        });
      }

      // Execute all workflows concurrently
      const startTime = Date.now();
      const results = await Promise.all(
        workflows.map(({ id, file, userContext }) =>
          executeWorkflow(id, file, userContext)
        )
      );
      const endTime = Date.now();
      const duration = endTime - startTime;

      // Verify all workflows completed
      expect(results).toHaveLength(concurrency);
      const successCount = results.filter(r => r.success).length;
      expect(successCount).toBe(concurrency);

      // Verify no workflow IDs are duplicated
      const workflowIds = results.map(r => r.workflowId);
      const uniqueIds = new Set(workflowIds);
      expect(uniqueIds.size).toBe(concurrency);

      // Performance check
      expect(duration).toBeLessThan(20000); // 20 seconds max for 20 concurrent workflows

      console.log(`[Load Test] 20 concurrent workflows completed in ${duration}ms (${successCount}/${concurrency} successful)`);
    }, 25000); // 25 second timeout
  });

  describe('Workflow isolation', () => {
    it('should ensure workflows do not interfere with each other', async () => {
      const workflow1Id = TEST_WORKFLOW_ID;
      const workflow2Id = TEST_WORKFLOW_ID_2;
      const userId = 'user-123';

      // Setup two workflows with different IDs (valid UUIDs)
      setupWorkflow(workflow1Id, userId);
      setupWorkflow(workflow2Id, userId);

      const file1 = createMockFile({ name: 'test1.jpg' });
      const file2 = createMockFile({ name: 'test2.jpg' });
      const userContext = createMockUserContext({ userId });

      // Execute both workflows concurrently
      const [result1, result2] = await Promise.all([
        executeWorkflow(workflow1Id, file1, userContext),
        executeWorkflow(workflow2Id, file2, userContext),
      ]);

      // Both should succeed
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // Workflow IDs should be different
      expect(result1.workflowId).toBe(workflow1Id);
      expect(result2.workflowId).toBe(workflow2Id);

      // Verify each workflow has its own steps
      const allSteps = getMockData('workflow_steps');
      const workflow1Steps = allSteps.filter(s => s.workflow_id === workflow1Id);
      const workflow2Steps = allSteps.filter(s => s.workflow_id === workflow2Id);

      expect(workflow1Steps.length).toBeGreaterThan(0);
      expect(workflow2Steps.length).toBeGreaterThan(0);
      expect(workflow1Steps.length).toBe(workflow2Steps.length);

      // Verify no step belongs to both workflows
      const stepIds1 = new Set(workflow1Steps.map(s => s.id));
      const stepIds2 = new Set(workflow2Steps.map(s => s.id));
      const intersection = [...stepIds1].filter(id => stepIds2.has(id));
      expect(intersection.length).toBe(0);
    }, 10000);

    it('should handle workflows from different users concurrently', async () => {
      const workflows = [
        { id: TEST_WORKFLOW_ID, userId: 'user-1' },
        { id: TEST_WORKFLOW_ID_2, userId: 'user-2' },
        { id: TEST_WORKFLOW_ID_3, userId: 'user-3' },
      ];

      // Setup workflows for different users (valid UUIDs)
      workflows.forEach(({ id, userId }) => {
        setupWorkflow(id, userId);
      });
      setMockData('workflows', workflows.map(({ id, userId }) =>
        createMockWorkflow({ id, status: 'pending', user_id: userId, source_artifact_id: null })
      ));

      // Execute all workflows concurrently
      const results = await Promise.all(
        workflows.map(({ id, userId }) =>
          executeWorkflow(
            id,
            createMockFile({ name: `test-${id}.jpg` }),
            createMockUserContext({ userId })
          )
        )
      );

      // All should succeed
      results.forEach((result, index) => {
        expect(result.success).toBe(true);
        expect(result.workflowId).toBe(workflows[index].id);
      });

      // Verify workflows are associated with correct users
      const allWorkflows = getMockData('workflows');
      workflows.forEach(({ id, userId }) => {
        const workflow = allWorkflows.find(w => w.id === id);
        expect(workflow).toBeDefined();
        expect(workflow?.user_id).toBe(userId);
      });
    }, 10000);
  });

  describe('Performance metrics', () => {
    it('should measure average execution time per workflow', async () => {
      const concurrency = 5;
      const workflows: Array<{ id: string; file: any; userContext: any }> = [];

      // Setup workflows (valid UUIDs)
      for (let i = 0; i < concurrency; i++) {
        const workflowId = LOAD_TEST_WORKFLOW_IDS[i];
        setupWorkflow(workflowId);
        workflows.push({
          id: workflowId,
          file: createMockFile({ name: `test-${i}.jpg` }),
          userContext: createMockUserContext({ userId: `user-${i}` }),
        });
      }

      // Measure individual execution times
      const executionTimes: number[] = [];
      const startTime = Date.now();

      await Promise.all(
        workflows.map(async ({ id, file, userContext }) => {
          const workflowStart = Date.now();
          await executeWorkflow(id, file, userContext);
          const workflowEnd = Date.now();
          executionTimes.push(workflowEnd - workflowStart);
        })
      );

      const totalTime = Date.now() - startTime;
      const avgTime = executionTimes.reduce((a, b) => a + b, 0) / executionTimes.length;
      const minTime = Math.min(...executionTimes);
      const maxTime = Math.max(...executionTimes);

      // Log performance metrics
      console.log(`[Load Test] Performance metrics for ${concurrency} workflows:`);
      console.log(`  Total time: ${totalTime}ms`);
      console.log(`  Average execution time: ${avgTime.toFixed(2)}ms`);
      console.log(`  Min execution time: ${minTime}ms`);
      console.log(`  Max execution time: ${maxTime}ms`);

      // Verify metrics are reasonable
      expect(avgTime).toBeGreaterThan(0);
      expect(minTime).toBeGreaterThan(0);
      expect(maxTime).toBeGreaterThan(0);
      expect(totalTime).toBeLessThan(avgTime * concurrency * 2); // Concurrent execution should be faster than sequential
    }, 10000);

    it('should track step execution counts across concurrent workflows', async () => {
      const concurrency = 5;
      const workflows: Array<{ id: string; file: any; userContext: any }> = [];

      // Setup workflows (valid UUIDs)
      for (let i = 0; i < concurrency; i++) {
        const workflowId = LOAD_TEST_WORKFLOW_IDS[i];
        setupWorkflow(workflowId);
        workflows.push({
          id: workflowId,
          file: createMockFile({ name: `test-${i}.jpg` }),
          userContext: createMockUserContext({ userId: `user-${i}` }),
        });
      }
      setMockData('workflows', LOAD_TEST_WORKFLOW_IDS.slice(0, concurrency).map((id, i) =>
        createMockWorkflow({ id, status: 'pending', user_id: `user-${i}`, source_artifact_id: null })
      ));

      // Execute all workflows
      await Promise.all(
        workflows.map(({ id, file, userContext }) =>
          executeWorkflow(id, file, userContext)
        )
      );

      // Verify step execution counts
      expect(mockExecuteUploadStep).toHaveBeenCalledTimes(concurrency);
      expect(mockExecuteCreateArtifactStep).toHaveBeenCalledTimes(concurrency);
      expect(mockExecuteAnalyzeStep).toHaveBeenCalledTimes(concurrency);
      expect(mockExecuteFinalizeStep).toHaveBeenCalledTimes(concurrency);

      // Verify all steps were created in database
      const allSteps = getMockData('workflow_steps');
      expect(allSteps.length).toBeGreaterThanOrEqual(concurrency * 4); // At least 4 steps per workflow
    }, 10000);
  });

  describe('Error handling under load', () => {
    it('should handle partial failures gracefully', async () => {
      const concurrency = 10;
      const failingWorkflowId = LOAD_TEST_WORKFLOW_IDS[0]; // This one will fail
      const workflows: Array<{ id: string; file: any; userContext: any }> = [];

      // Setup workflows (valid UUIDs; mocks set up below)
      for (let i = 0; i < concurrency; i++) {
        const workflowId = LOAD_TEST_WORKFLOW_IDS[i];
        const userId = `user-${i}`;
        const workflow = createMockWorkflow({
          id: workflowId,
          status: 'pending',
          user_id: userId,
          source_artifact_id: null,
        });
        setMockData('workflows', [...getMockData('workflows'), workflow]);
        workflows.push({
          id: workflowId,
          file: createMockFile({ name: `test-${i}.jpg` }),
          userContext: createMockUserContext({ userId }),
        });
      }

      // Set up mocks that work for all workflows, with one failure
      mockExecuteUploadStep.mockImplementation(async (step, file, userContext) => {
        // Check if this is the failing workflow - return failure instead of throwing
        if (step.workflow_id === failingWorkflowId) {
          return {
            success: false,
            error: 'Upload failed',
          };
        }
        // Simulate some async work
        await new Promise(resolve => setTimeout(resolve, 10));
        const objectPath = `user-${userContext.userId}/${step.workflow_id}/test.jpg`;
        return {
          success: true,
          objectPath,
          fileMetadata: createMockFileMetadata({
            objectPath,
            fileName: `test-${step.workflow_id}.jpg`,
          }),
        };
      });

      mockExecuteCreateArtifactStep.mockImplementation(async (input) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        const { step, objectPath: objectPathParam, userContext } = input;
        const artifactId = `artifact-${step.workflow_id}`;
        const artifact = createMockArtifact({
          id: artifactId,
          user_id: userContext.userId,
          storage_path: objectPathParam,
        });
        setMockData('artifacts', [...getMockData('artifacts'), artifact]);
        return {
          success: true,
          artifactId,
        };
      });

      mockExecuteAnalyzeStep.mockImplementation(async (step, artifactIdParam) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return {
          success: true,
          analysisResult: {
            intent: 'meeting_notes',
            confidence: 0.9,
            entities_mentioned: [],
            actions_suggested: [],
            topics: [],
            sentiment: 'neutral',
          },
        };
      });

      mockExecuteFinalizeStep.mockImplementation(async (step, workflowIdParam) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return {
          success: true,
          summary: `Workflow ${workflowIdParam} completed successfully`,
        };
      });

      // Execute all workflows concurrently
      const results = await Promise.all(
        workflows.map(({ id, file, userContext }) =>
          executeWorkflow(id, file, userContext).catch(error => ({
            success: false,
            workflowId: id,
            status: 'failed',
            error: error.message,
            completedSteps: [],
            skippedSteps: [],
          }))
        )
      );

      // Most should succeed, one should fail
      const successCount = results.filter(r => r.success).length;
      const failureCount = results.filter(r => !r.success).length;

      expect(successCount).toBe(concurrency - 1);
      expect(failureCount).toBe(1);

      // Verify the correct workflow failed
      const failedResult = results.find(r => !r.success);
      expect(failedResult?.workflowId).toBe(failingWorkflowId);

      // Successful workflows should not be affected by the failure
      results.filter(r => r.success).forEach(result => {
        expect(result.status).not.toBe('failed');
      });
    }, 15000);
  });
});
