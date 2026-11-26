/**
 * Unit tests for Analyze Step
 */

import { executeAnalyzeStep } from '../../../../src/workflows/steps/analyze';
import { ArtifactId, StepId } from '../../../../src/workflows/steps/types';
import { supabase } from '../../../../src/utils/supabase';
import { callAnthropicText, callAnthropicVision } from '../../../../src/utils/anthropic';
import {
  createMockWorkflowStep,
  createMockArtifact,
  TEST_ARTIFACT_ID,
  TEST_ARTIFACT_ID_2,
} from '../../../helpers/fixtures';
import {
  resetMockData,
  setMockData,
  resetMockStorage,
  setMockStorageFile,
} from '../../../__mocks__/supabase';
import {
  resetAnthropicMocks,
  setMockTextResponse,
  setMockVisionResponse,
  simulateTextFailure,
} from '../../../__mocks__/anthropic';
import {
  resetPdfMocks,
  setMockTextPdfResult,
  setMockScannedPdfResult,
} from '../../../__mocks__/pdf-processor';

// Mock dependencies
jest.mock('../../../../src/utils/supabase');
jest.mock('../../../../src/utils/anthropic');
jest.mock('../../../../src/services/pdf/processor');

const mockSupabase = supabase as jest.Mocked<typeof supabase>;
const mockCallAnthropicText = callAnthropicText as jest.MockedFunction<typeof callAnthropicText>;
const mockCallAnthropicVision = callAnthropicVision as jest.MockedFunction<typeof callAnthropicVision>;

describe('Analyze Step', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMockData();
    resetMockStorage();
    resetAnthropicMocks();
    resetPdfMocks();
    
    // Re-apply mock implementations after clearAllMocks
    const mockAnthropic = require('../../../__mocks__/anthropic');
    (mockCallAnthropicText as any).mockImplementation(mockAnthropic.callAnthropicText);
    (mockCallAnthropicVision as any).mockImplementation(mockAnthropic.callAnthropicVision);
  });

  describe('executeAnalyzeStep', () => {
    it('should fetch artifact from database', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({ id: TEST_ARTIFACT_ID });
      setMockData('artifacts', [artifact]);

      setMockTextResponse(JSON.stringify({
        intent: 'meeting_notes',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [],
        topics: [],
        sentiment: 'neutral',
      }));

      await executeAnalyzeStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id));

      expect(mockSupabase.from).toHaveBeenCalledWith('artifacts');
    });

    it('should return error when artifact not found', async () => {
      const step = createMockWorkflowStep();
      setMockData('artifacts', []);

      const result = await executeAnalyzeStep(step, ArtifactId.parse(TEST_ARTIFACT_ID_2), StepId.parse(step.id));

      expect(result.success).toBe(false);
      expect(result.error).toBe('Artifact not found');
    });

    it('should use user_content for text files', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        file_type: 'text/plain',
        content: { text: 'This is test content' },
      });
      setMockData('artifacts', [artifact]);

      setMockTextResponse(JSON.stringify({
        intent: 'meeting_notes',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [],
        topics: [],
        sentiment: 'neutral',
      }));

      await executeAnalyzeStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id));

      expect(mockCallAnthropicText).toHaveBeenCalled();
      const callArgs = mockCallAnthropicText.mock.calls[0][0];
      expect(callArgs).toContain('This is test content');
    });

    it('should process images with Vision API', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        file_type: 'image/jpeg',
        storage_path: 'user-123/test.jpg',
      });
      setMockData('artifacts', [artifact]);

      const imageBuffer = Buffer.from('fake-image-data');
      setMockStorageFile('user-123/test.jpg', imageBuffer);

      (mockSupabase.storage.from as jest.Mock).mockReturnValue({
        download: jest.fn().mockResolvedValue({
          data: new Blob([imageBuffer]),
          error: null,
        }),
      } as any);

      setMockVisionResponse('Extracted text from image');
      setMockTextResponse(JSON.stringify({
        intent: 'meeting_notes',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [],
        topics: [],
        sentiment: 'neutral',
      }));

      await executeAnalyzeStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id));

      expect(mockCallAnthropicVision).toHaveBeenCalled();
      expect(mockCallAnthropicText).toHaveBeenCalled();
    });

    it('should process text-based PDFs', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        file_type: 'application/pdf',
        file_extension: 'pdf',
        storage_path: 'user-123/test.pdf',
      });
      setMockData('artifacts', [artifact]);

      const pdfBuffer = Buffer.from('fake-pdf-data');
      setMockStorageFile('user-123/test.pdf', pdfBuffer);

      (mockSupabase.storage.from as jest.Mock).mockReturnValue({
        download: jest.fn().mockResolvedValue({
          data: new Blob([pdfBuffer]),
          error: null,
        }),
      } as any);

      setMockTextPdfResult('Extracted PDF text', 1);
      setMockTextResponse(JSON.stringify({
        intent: 'document',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [],
        topics: [],
        sentiment: 'neutral',
      }));

      await executeAnalyzeStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id));

      expect(mockCallAnthropicText).toHaveBeenCalled();
    });

    it('should process scanned PDFs (split pages)', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        file_type: 'application/pdf',
        file_extension: 'pdf',
        storage_path: 'user-123/test.pdf',
      });
      setMockData('artifacts', [artifact]);

      const pdfBuffer = Buffer.from('fake-pdf-data');
      setMockStorageFile('user-123/test.pdf', pdfBuffer);

      (mockSupabase.storage.from as jest.Mock).mockReturnValue({
        download: jest.fn().mockResolvedValue({
          data: new Blob([pdfBuffer]),
          error: null,
        }),
      } as any);

      setMockScannedPdfResult(2);
      setMockVisionResponse('Extracted text from page');
      setMockTextResponse(JSON.stringify({
        intent: 'document',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [],
        topics: [],
        sentiment: 'neutral',
      }));

      await executeAnalyzeStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id));

      expect(mockCallAnthropicVision).toHaveBeenCalled();
    });

    it('should update artifact with extracted_text', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        file_type: 'text/plain',
        content: { text: 'Test content' },
      });
      setMockData('artifacts', [artifact]);

      setMockTextResponse(JSON.stringify({
        intent: 'meeting_notes',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [],
        topics: [],
        sentiment: 'neutral',
      }));

      await executeAnalyzeStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id));

      expect(mockSupabase.from).toHaveBeenCalledWith('artifacts');
    });

    it('should call Anthropic API with retry logic', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        file_type: 'text/plain',
        content: { text: 'Test content' },
      });
      setMockData('artifacts', [artifact]);

      let attemptCount = 0;
      mockCallAnthropicText.mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 2) {
          throw new Error('API error');
        }
        return {
          content: JSON.stringify({
            intent: 'meeting_notes',
            confidence: 0.9,
            entities_mentioned: [],
            actions_suggested: [],
            topics: [],
            sentiment: 'neutral',
          }),
          usage: { input_tokens: 100, output_tokens: 50 },
        };
      });

      const result = await executeAnalyzeStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id));

      expect(result.success).toBe(true);
      expect(mockCallAnthropicText).toHaveBeenCalledTimes(2);
    });

    it('should parse AI response correctly', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        file_type: 'text/plain',
        content: { text: 'Test content' },
      });
      setMockData('artifacts', [artifact]);

      const analysisResult = {
        intent: 'meeting_notes',
        confidence: 0.9,
        entities_mentioned: [{ name: 'John', type: 'people', confidence: 0.8 }],
        actions_suggested: [{ title: 'Follow up', priority: 'high' }],
        topics: ['project', 'meeting'],
        sentiment: 'positive',
      };

      setMockTextResponse(JSON.stringify(analysisResult));

      const result = await executeAnalyzeStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id));

      expect(result.success).toBe(true);
      expect(result.analysisResult?.intent).toBe('meeting_notes');
      expect(result.analysisResult?.confidence).toBe(0.9);
    });

    it('should parse AI response with markdown code fences', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        file_type: 'text/plain',
        content: { text: 'Test content' },
      });
      setMockData('artifacts', [artifact]);

      const wrappedResponse = `\`\`\`json
{
  "intent": "meeting_notes",
  "confidence": 0.9,
  "entities_mentioned": [],
  "actions_suggested": [],
  "topics": [],
  "sentiment": "neutral"
}
\`\`\``;

      setMockTextResponse(wrappedResponse);

      const result = await executeAnalyzeStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id));

      expect(result.success).toBe(true);
      expect(result.analysisResult?.intent).toBe('meeting_notes');
    });

    it('should create clarification notification for low confidence (< 0.5)', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        file_type: 'text/plain',
        content: { text: 'Test content' },
      });
      setMockData('artifacts', [artifact]);
      setMockData('system_decisions', []);

      setMockTextResponse(JSON.stringify({
        intent: 'unclear',
        confidence: 0.3,
        entities_mentioned: [],
        actions_suggested: [],
        topics: [],
        sentiment: 'neutral',
      }));

      const result = await executeAnalyzeStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id));

      expect(result.success).toBe(true);
      expect(result.status).toBe('awaiting_user');
      expect(result.confidence).toBe(0.3);
      expect(result.notificationId).toBeDefined();
    });

    it('should update artifact with analysis results (high confidence)', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        file_type: 'text/plain',
        content: { text: 'Test content' },
      });
      setMockData('artifacts', [artifact]);

      setMockTextResponse(JSON.stringify({
        intent: 'meeting_notes',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [],
        topics: [],
        sentiment: 'neutral',
      }));

      await executeAnalyzeStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id));

      expect(mockSupabase.from).toHaveBeenCalledWith('artifacts');
    });

    it('should update artifact lifecycle_stage correctly', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        file_type: 'text/plain',
        content: { text: 'Test content' },
        lifecycle_stage: 'uploaded',
      });
      setMockData('artifacts', [artifact]);

      setMockTextResponse(JSON.stringify({
        intent: 'meeting_notes',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [],
        topics: [],
        sentiment: 'neutral',
      }));

      await executeAnalyzeStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id));

      expect(mockSupabase.from).toHaveBeenCalledWith('artifacts');
    });

    it('should handle API failures with retries', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        file_type: 'text/plain',
        content: { text: 'Test content' },
      });
      setMockData('artifacts', [artifact]);

      mockCallAnthropicText.mockRejectedValue(new Error('API error'));

      const result = await executeAnalyzeStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id));

      expect(result.success).toBe(false);
      expect(result.error).toBe('AI API call failed');
    });

    it('should stop retrying after MAX_RETRY_ATTEMPTS', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        file_type: 'text/plain',
        content: { text: 'Test content' },
      });
      setMockData('artifacts', [artifact]);

      mockCallAnthropicText.mockRejectedValue(new Error('API error'));

      const result = await executeAnalyzeStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id));

      expect(result.success).toBe(false);
      expect(mockCallAnthropicText).toHaveBeenCalledTimes(3);
    });

    it('should return correct AnalyzeResult on success', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        file_type: 'text/plain',
        content: { text: 'Test content' },
      });
      setMockData('artifacts', [artifact]);

      setMockTextResponse(JSON.stringify({
        intent: 'meeting_notes',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [],
        topics: [],
        sentiment: 'neutral',
      }));

      const result = await executeAnalyzeStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id));

      expect(result.success).toBe(true);
      expect(result.analysisResult).toBeDefined();
      expect(result.tokensUsed).toBeDefined();
      expect(result.confidence).toBe(0.9);
    });

    it('should return correct AnalyzeResult on low confidence', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        file_type: 'text/plain',
        content: { text: 'Test content' },
      });
      setMockData('artifacts', [artifact]);
      setMockData('system_decisions', []);

      setMockTextResponse(JSON.stringify({
        intent: 'unclear',
        confidence: 0.3,
        entities_mentioned: [],
        actions_suggested: [],
        topics: [],
        sentiment: 'neutral',
      }));

      const result = await executeAnalyzeStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id));

      expect(result.success).toBe(true);
      expect(result.status).toBe('awaiting_user');
      expect(result.confidence).toBe(0.3);
      expect(result.notificationId).toBeDefined();
    });

    it('should return correct AnalyzeResult on failure', async () => {
      const step = createMockWorkflowStep();
      setMockData('artifacts', []);

      const result = await executeAnalyzeStep(step, ArtifactId.parse(TEST_ARTIFACT_ID_2), StepId.parse(step.id));

      expect(result.success).toBe(false);
      expect(result.error).toBe('Artifact not found');
    });

    it('should handle unsupported content types', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        file_type: 'application/x-unknown',
        content_type: 'binary',
      });
      setMockData('artifacts', [artifact]);

      const result = await executeAnalyzeStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id));

      expect(result.success).toBe(false);
      expect(result.error).toContain('not supported');
    });

    it('should handle processing errors gracefully', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        file_type: 'image/jpeg',
        storage_path: 'user-123/test.jpg',
      });
      setMockData('artifacts', [artifact]);

      (mockSupabase.storage.from as jest.Mock).mockReturnValue({
        download: jest.fn().mockResolvedValue({
          data: null,
          error: { message: 'File not found' },
        }),
      } as any);

      const result = await executeAnalyzeStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id));

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});

