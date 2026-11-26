/**
 * Unit tests for workflow context module (getWorkflow, updateWorkflowStatus,
 * getOrCreateWorkflowStep, updateStepStatus, setArtifactProcessingFailed).
 */

import {
  getWorkflow,
  updateWorkflowStatus,
  getOrCreateWorkflowStep,
  updateStepStatus,
  setArtifactProcessingFailed,
  getArtifactIdForWorkflow,
  getAnalysisResultFromStepOutput,
  getAnalysisResultForWorkflow,
} from '../../../src/workflows/workflowContext';
import { createMockWorkflow, createMockWorkflowStep } from '../../helpers/fixtures';
import { resetMockData, setMockData, getMockData } from '../../__mocks__/supabase';

describe('workflowContext', () => {
  beforeEach(() => {
    resetMockData();
  });

  afterEach(() => {
    resetMockData();
  });

  describe('getWorkflow', () => {
    it('returns null when workflow does not exist', async () => {
      setMockData('workflows', []);
      const result = await getWorkflow('non-existent-id');
      expect(result).toBeNull();
    });

    it('returns workflow when it exists', async () => {
      const workflow = createMockWorkflow({ id: 'wf-1', status: 'pending' });
      setMockData('workflows', [workflow]);
      const result = await getWorkflow('wf-1');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('wf-1');
      expect(result?.status).toBe('pending');
    });
  });

  describe('updateWorkflowStatus', () => {
    it('updates workflow status and sets completed_at for terminal status', async () => {
      const workflow = createMockWorkflow({ id: 'wf-1', status: 'in_progress' });
      setMockData('workflows', [workflow]);
      await updateWorkflowStatus('wf-1', 'completed', 'Done');
      const workflows = getMockData('workflows') as any[];
      const updated = workflows.find((w: any) => w.id === 'wf-1');
      expect(updated?.status).toBe('completed');
      expect(updated?.last_message).toBe('Done');
      expect(updated?.completed_at).toBeDefined();
    });

    it('accepts additionalFields', async () => {
      const workflow = createMockWorkflow({ id: 'wf-1', status: 'in_progress' });
      setMockData('workflows', [workflow]);
      await updateWorkflowStatus('wf-1', 'in_progress', undefined, { last_message: 'Custom' });
      const workflows = getMockData('workflows') as any[];
      const updated = workflows.find((w: any) => w.id === 'wf-1');
      expect(updated?.status).toBe('in_progress');
      expect(updated?.last_message).toBe('Custom');
    });
  });

  describe('getOrCreateWorkflowStep', () => {
    it('creates a new step when none exists', async () => {
      setMockData('workflows', [createMockWorkflow({ id: 'wf-1' })]);
      setMockData('workflow_steps', []);
      const step = await getOrCreateWorkflowStep('wf-1', 'upload', 'Upload File', 0);
      expect(step).not.toBeNull();
      expect(step?.step_type).toBe('upload');
      expect(step?.step_name).toBe('Upload File');
      expect(step?.step_order).toBe(0);
      expect(step?.status).toBe('pending');
      const steps = getMockData('workflow_steps') as any[];
      expect(steps.length).toBe(1);
    });

    it('returns existing step when one exists', async () => {
      const existing = createMockWorkflowStep({
        id: 42,
        workflow_id: 'wf-1',
        step_type: 'upload',
        status: 'completed',
      });
      setMockData('workflow_steps', [existing]);
      const step = await getOrCreateWorkflowStep('wf-1', 'upload', 'Upload File', 0);
      expect(step).not.toBeNull();
      expect(step?.id).toBe(42);
      expect(step?.status).toBe('completed');
      const steps = getMockData('workflow_steps') as any[];
      expect(steps.length).toBe(1);
    });
  });

  describe('updateStepStatus', () => {
    it('updates step status and sets completed_at for terminal status', async () => {
      const step = createMockWorkflowStep({ id: 1, workflow_id: 'wf-1', status: 'running' });
      setMockData('workflow_steps', [step]);
      await updateStepStatus(1, 'completed', 'Done', { artifactId: 'art-1' });
      const steps = getMockData('workflow_steps') as any[];
      const updated = steps.find((s: any) => s.id === 1);
      expect(updated?.status).toBe('completed');
      expect(updated?.message).toBe('Done');
      expect(updated?.output).toEqual({ artifactId: 'art-1' });
      expect(updated?.completed_at).toBeDefined();
    });
  });

  describe('setArtifactProcessingFailed', () => {
    it('updates artifact processing_status and processing_error when artifactId provided', async () => {
      setMockData('artifacts', [{ id: 'art-1', user_id: 'u1', processing_status: 'processing' }]);
      await setArtifactProcessingFailed('art-1', 'Upload failed');
      const artifacts = getMockData('artifacts') as any[];
      const updated = artifacts.find((a: any) => a.id === 'art-1');
      expect(updated?.processing_status).toBe('failed');
      expect(updated?.processing_error).toBe('Upload failed');
    });

    it('does nothing when artifactId is undefined', async () => {
      setMockData('artifacts', [{ id: 'art-1', processing_status: 'processing' }]);
      await setArtifactProcessingFailed(undefined, 'Some error');
      const artifacts = getMockData('artifacts') as any[];
      const art = artifacts.find((a: any) => a.id === 'art-1');
      expect(art?.processing_status).toBe('processing');
    });
  });

  describe('getArtifactIdForWorkflow', () => {
    it('returns currentArtifactId when provided', async () => {
      const workflow = createMockWorkflow({ id: 'wf-1', source_artifact_id: null });
      setMockData('workflows', [workflow]);
      setMockData('workflow_steps', []);
      const result = await getArtifactIdForWorkflow('wf-1', workflow, 'current-art-123');
      expect(result).toBe('current-art-123');
    });

    it('returns artifactId from create_artifact step output when current is undefined', async () => {
      const workflow = createMockWorkflow({ id: 'wf-1', source_artifact_id: null });
      const createStep = createMockWorkflowStep({
        workflow_id: 'wf-1',
        step_type: 'create_artifact',
        output: { artifactId: 'from-step-art' },
      });
      setMockData('workflows', [workflow]);
      setMockData('workflow_steps', [createStep]);
      const result = await getArtifactIdForWorkflow('wf-1', workflow, undefined);
      expect(result).toBe('from-step-art');
    });

    it('returns workflow.source_artifact_id when current and step output are missing', async () => {
      const workflow = createMockWorkflow({ id: 'wf-1', source_artifact_id: 'source-art-456' });
      setMockData('workflows', [workflow]);
      setMockData('workflow_steps', []);
      const result = await getArtifactIdForWorkflow('wf-1', workflow, undefined);
      expect(result).toBe('source-art-456');
    });

    it('returns undefined when no artifactId available', async () => {
      const workflow = createMockWorkflow({ id: 'wf-1', source_artifact_id: null });
      setMockData('workflows', [workflow]);
      setMockData('workflow_steps', []);
      const result = await getArtifactIdForWorkflow('wf-1', workflow, undefined);
      expect(result).toBeUndefined();
    });
  });

  describe('getAnalysisResultFromStepOutput', () => {
    const validAnalysis = {
      intent: 'meeting_notes',
      entities_mentioned: [],
      actions_suggested: [],
      topics: [],
      sentiment: 'neutral',
      confidence: 0.9,
    };

    it('returns null for null or non-object output', () => {
      expect(getAnalysisResultFromStepOutput(null)).toBeNull();
      expect(getAnalysisResultFromStepOutput(undefined)).toBeNull();
      expect(getAnalysisResultFromStepOutput('string')).toBeNull();
    });

    it('returns analysis when output has analysis at top-level', () => {
      const result = getAnalysisResultFromStepOutput(validAnalysis);
      expect(result).not.toBeNull();
      expect(result?.intent).toBe('meeting_notes');
      expect(result?.confidence).toBe(0.9);
    });

    it('returns analysis when output has analysisResult nested', () => {
      const result = getAnalysisResultFromStepOutput({ analysisResult: validAnalysis });
      expect(result).not.toBeNull();
      expect(result?.intent).toBe('meeting_notes');
    });
  });

  describe('getAnalysisResultForWorkflow', () => {
    const validAnalysis = {
      intent: 'idea',
      entities_mentioned: [{ name: 'Alice', type: 'people', confidence: 0.8 }],
      actions_suggested: [],
      topics: ['product'],
      sentiment: 'positive',
      confidence: 0.85,
    };

    it('returns null when no analyze step exists', async () => {
      setMockData('workflow_steps', []);
      const result = await getAnalysisResultForWorkflow('wf-1');
      expect(result).toBeNull();
    });

    it('returns AnalysisResult when analyze step has valid output', async () => {
      const analyzeStep = createMockWorkflowStep({
        workflow_id: 'wf-1',
        step_type: 'analyze',
        output: validAnalysis,
      });
      setMockData('workflow_steps', [analyzeStep]);
      const result = await getAnalysisResultForWorkflow('wf-1');
      expect(result).not.toBeNull();
      expect(result?.intent).toBe('idea');
      expect(result?.entities_mentioned).toHaveLength(1);
    });
  });
});
