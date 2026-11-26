import express from 'express';
import request from 'supertest';
import { TEST_WORKFLOW_ID } from '../../helpers/fixtures';

const mockExecuteWorkflow = jest.fn();
const mockTriggerWorkflowProcessing = jest.fn();

jest.mock('../../../routes/_shared/triggerWorkflowProcessing', () => ({
  loadOrchestrator: async () => ({ executeWorkflow: mockExecuteWorkflow }),
  triggerWorkflowProcessing: (workflowId: string) => mockTriggerWorkflowProcessing(workflowId),
}));

const mockExecuteUploadStep = jest.fn();
jest.mock('../../../routes/_shared/loadUploadStep', () => ({
  loadUploadStep: async () => ({ executeUploadStep: mockExecuteUploadStep }),
}));

// Mock Supabase client (auth + minimal workflow_steps insert chain)
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    auth: {
      getUser: jest.fn(async (_token: string) => ({ data: { user: { id: 'user-1' } }, error: null })),
    },
    from: jest.fn((table: string) => {
      if (table === 'workflow_steps') {
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({
                data: { id: 123, workflow_id: '550e8400-e29b-41d4-a716-446655440000' },
                error: null,
              }),
            }),
          }),
        };
      }

      return {};
    }),
  })),
}));

describe('POST /api/upload fast-return', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockExecuteUploadStep.mockResolvedValue({
      success: true,
      objectPath: 'user-1/test.jpg',
      fileMetadata: { name: 'test.jpg', size: 10, type: 'image/jpeg' },
    });

    mockExecuteWorkflow.mockResolvedValue({
      success: true,
      workflowId: 'workflow-1',
      status: 'partial',
      completedSteps: ['upload', 'create_artifact'],
      skippedSteps: ['analyze', 'organize_entities', 'extract_actions', 'create_derived', 'finalize'],
      artifactId: 'artifact-123',
    });
  });

  it('runs orchestrator with returnAfterStep and triggers async continuation', async () => {
    const uploadRouter = require('../../../routes/api/upload');
    const app = express();
    app.use('/api/upload', uploadRouter);

    const res = await request(app)
      .post('/api/upload')
      .set('Authorization', 'Bearer test-token')
      .field('workflowId', TEST_WORKFLOW_ID)
      .field('orchestratorMode', 'fast-return')
      .attach('file', Buffer.from('hello'), { filename: 'test.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.workflowId).toBe(TEST_WORKFLOW_ID);
    expect(res.body.orchestrator).toBeTruthy();
    expect(res.body.orchestrator.status).toBe('partial');
    expect(res.body.orchestrator.artifactId).toBe('artifact-123');

    expect(mockExecuteWorkflow).toHaveBeenCalledWith(
      TEST_WORKFLOW_ID,
      null,
      expect.any(Object),
      { returnAfterStep: 'create_artifact' }
    );
    expect(mockTriggerWorkflowProcessing).toHaveBeenCalledWith(TEST_WORKFLOW_ID);
  });

  // Property 3: Durable quick capture response
  // Validates: Requirements 5.2, 9.2
  // In fast-return mode, success response is only emitted if artifactId is present
  // Otherwise the route returns an error or failed status (no "false success")
  it('returns error when fast-return mode does not produce artifactId', async () => {
    // Mock orchestrator to return without artifactId
    mockExecuteWorkflow.mockResolvedValue({
      success: true,
      workflowId: TEST_WORKFLOW_ID,
      status: 'partial',
      completedSteps: ['upload'],
      skippedSteps: ['create_artifact', 'analyze', 'organize_entities', 'extract_actions', 'create_derived', 'finalize'],
      // No artifactId - this should cause an error
    });

    const uploadRouter = require('../../../routes/api/upload');
    const app = express();
    app.use('/api/upload', uploadRouter);

    const res = await request(app)
      .post('/api/upload')
      .set('Authorization', 'Bearer test-token')
      .field('workflowId', TEST_WORKFLOW_ID)
      .field('orchestratorMode', 'fast-return')
      .attach('file', Buffer.from('hello'), { filename: 'test.jpg', contentType: 'image/jpeg' });

    // Should return error status, not success
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('artifactId');
    expect(res.body.orchestrator).toBeTruthy();
    expect(res.body.orchestrator.artifactId).toBeUndefined();

    // Should not trigger async continuation if fast-return failed
    expect(mockTriggerWorkflowProcessing).not.toHaveBeenCalled();
  });
});

