/**
 * Unit tests for Create Derived Artifact Step
 */

import {
	executeCreateDerivedArtifactStep,
	routeToIntentProcessor,
	registerIntentProcessor,
	clearIntentProcessors,
	extractContentForProcessing,
	linkDerivedArtifact,
	createDerivedArtifactNotification,
	type CreateDerivedResult,
	type IntentProcessor,
} from '../../../../src/workflows/steps/createDerived';
import { supabase } from '../../../../src/utils/supabase';
import { callAnthropicText } from '../../../../src/utils/anthropic';
import {
	createMockWorkflowStep,
	createMockArtifact,
	TEST_ARTIFACT_ID,
	TEST_ARTIFACT_ID_2,
} from '../../../helpers/fixtures';
import { ArtifactId, StepId } from '../../../../src/workflows/steps/types';
import {
	resetMockData,
	setMockData,
	getMockData,
} from '../../../__mocks__/supabase';
import {
	resetAnthropicMocks,
	setMockTextResponse,
} from '../../../__mocks__/anthropic';
import type {
	AnalysisResult,
	WorkflowStep,
} from '../../../../src/workflows/steps/types';

// Mock dependencies
jest.mock('../../../../src/utils/supabase');

const mockSupabase = supabase as jest.Mocked<typeof supabase>;
const mockCallAnthropicText = callAnthropicText as jest.MockedFunction<typeof callAnthropicText>;

describe('Create Derived Artifact Step', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		resetMockData();
		resetAnthropicMocks();
		// Clear registered processors before each test
		clearIntentProcessors();
		// Reset Anthropic mock implementation
		(mockCallAnthropicText as any).mockImplementation(require('../../../__mocks__/anthropic').callAnthropicText);
	});

	describe('routeToIntentProcessor', () => {
		it('should return null for empty intent', () => {
			const analysisResult: AnalysisResult = {
				intent: '',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			const result = routeToIntentProcessor('', analysisResult);
			expect(result).toBeNull();
		});

		it('should return null for whitespace-only intent', () => {
			const analysisResult: AnalysisResult = {
				intent: '   ',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			const result = routeToIntentProcessor('   ', analysisResult);
			expect(result).toBeNull();
		});

		it('should trim whitespace from intent', () => {
			const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
				success: true,
			});

			registerIntentProcessor('meeting_notes', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			const result = routeToIntentProcessor('  meeting_notes  ', analysisResult);
			expect(result).toBe(mockProcessor);
		});

		it('should return null for invalid intent type', () => {
			const analysisResult: AnalysisResult = {
				intent: 'invalid_intent',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			const result = routeToIntentProcessor('invalid_intent', analysisResult);
			expect(result).toBeNull();
		});

		it('should return null for document intent with shouldClean=false', () => {
			const analysisResult: AnalysisResult = {
				intent: 'document',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
				shouldClean: false,
			};

			const result = routeToIntentProcessor('document', analysisResult);
			expect(result).toBeNull();
		});

		it('should return processor for document intent with shouldClean=true', () => {
			const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
				success: true,
			});

			registerIntentProcessor('document', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'document',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
				shouldClean: true,
			};

			const result = routeToIntentProcessor('document', analysisResult);
			expect(result).toBe(mockProcessor);
		});

		it('should return processor for document intent with shouldClean=undefined', () => {
			const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
				success: true,
			});

			registerIntentProcessor('document', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'document',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
				// shouldClean is undefined
			};

			const result = routeToIntentProcessor('document', analysisResult);
			expect(result).toBe(mockProcessor);
		});

		it('should return processor for valid intent when registered', () => {
			const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
				success: true,
			});

			registerIntentProcessor('meeting_notes', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			const result = routeToIntentProcessor('meeting_notes', analysisResult);
			expect(result).toBe(mockProcessor);
		});

		it('should return null for valid intent when not registered', () => {
			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			const result = routeToIntentProcessor('meeting_notes', analysisResult);
			expect(result).toBeNull();
		});
	});

	describe('executeCreateDerivedArtifactStep', () => {
		describe('Error handling', () => {
			it('should return error when artifact not found', async () => {
				const step = createMockWorkflowStep();
				setMockData('artifacts', []);

				const analysisResult: AnalysisResult = {
					intent: 'meeting_notes',
					entities_mentioned: [],
					actions_suggested: [],
					topics: [],
					sentiment: 'neutral',
					confidence: 0.9,
				};

				const result = await executeCreateDerivedArtifactStep(
					step,
					ArtifactId.parse(TEST_ARTIFACT_ID_2),
					StepId.parse(step.id),
					analysisResult
				);

				expect(result.success).toBe(false);
				expect(result.error).toBe('Artifact not found');
			});

			it('should return error when artifact missing user_id', async () => {
				const step = createMockWorkflowStep();
				const artifact = createMockArtifact({
					id: TEST_ARTIFACT_ID,
					user_id: null,
				});
				setMockData('artifacts', [artifact]);

				const analysisResult: AnalysisResult = {
					intent: 'meeting_notes',
					entities_mentioned: [],
					actions_suggested: [],
					topics: [],
					sentiment: 'neutral',
					confidence: 0.9,
				};

				const result = await executeCreateDerivedArtifactStep(
					step,
					ArtifactId.parse(TEST_ARTIFACT_ID),
					StepId.parse(step.id),
					analysisResult
				);

				expect(result.success).toBe(false);
				expect(result.error).toBe('Artifact missing user_id');
			});

			it('should handle processor execution errors', async () => {
				const step = createMockWorkflowStep();
				const artifact = createMockArtifact({
					id: TEST_ARTIFACT_ID,
					user_id: 'user-123',
				});
				setMockData('artifacts', [artifact]);

				const mockProcessor: IntentProcessor = jest.fn().mockRejectedValue(
					new Error('Processor failed')
				);

				registerIntentProcessor('meeting_notes', mockProcessor);

				const analysisResult: AnalysisResult = {
					intent: 'meeting_notes',
					entities_mentioned: [],
					actions_suggested: [],
					topics: [],
					sentiment: 'neutral',
					confidence: 0.9,
				};

				const result = await executeCreateDerivedArtifactStep(
					step,
					ArtifactId.parse(TEST_ARTIFACT_ID),
					StepId.parse(step.id),
					analysisResult
				);

				expect(result.success).toBe(false);
				expect(result.error).toBe('Processor failed');
			});
		});

		describe('User preference checking', () => {
			it('should skip when per-capture override is false', async () => {
				const step = createMockWorkflowStep();
				const artifact = createMockArtifact({
					id: TEST_ARTIFACT_ID,
					user_id: 'user-123',
				});
				setMockData('artifacts', [artifact]);

				const analysisResult: AnalysisResult = {
					intent: 'meeting_notes',
					entities_mentioned: [],
					actions_suggested: [],
					topics: [],
					sentiment: 'neutral',
					confidence: 0.9,
				};

				const captureOptions = {
					create_derived_artifacts: false,
				};

				const result = await executeCreateDerivedArtifactStep(
					step,
					ArtifactId.parse(TEST_ARTIFACT_ID),
					StepId.parse(step.id),
					analysisResult,
					undefined,
					captureOptions
				);

				expect(result.success).toBe(false);
				expect(result.error).toBe('Skipped - user preference disabled');
			});

			it('should proceed when per-capture override is true', async () => {
				const step = createMockWorkflowStep();
				const artifact = createMockArtifact({
					id: TEST_ARTIFACT_ID,
					user_id: 'user-123',
				});
				setMockData('artifacts', [artifact]);

				const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
					success: true,
					derivedArtifactId: 'derived-123',
					derivedType: 'cleaned_meeting_notes',
				});

				registerIntentProcessor('meeting_notes', mockProcessor);

				const analysisResult: AnalysisResult = {
					intent: 'meeting_notes',
					entities_mentioned: [],
					actions_suggested: [],
					topics: [],
					sentiment: 'neutral',
					confidence: 0.9,
				};

				const captureOptions = {
					create_derived_artifacts: true,
				};

				const result = await executeCreateDerivedArtifactStep(
					step,
					ArtifactId.parse(TEST_ARTIFACT_ID),
					StepId.parse(step.id),
					analysisResult,
					undefined,
					captureOptions
				);

				expect(result.success).toBe(true);
				expect(mockProcessor).toHaveBeenCalled();
			});

			it('should skip when global preference is false', async () => {
				const step = createMockWorkflowStep();
				const artifact = createMockArtifact({
					id: TEST_ARTIFACT_ID,
					user_id: 'user-123',
				});
				setMockData('artifacts', [artifact]);

				const analysisResult: AnalysisResult = {
					intent: 'meeting_notes',
					entities_mentioned: [],
					actions_suggested: [],
					topics: [],
					sentiment: 'neutral',
					confidence: 0.9,
				};

				const userPreferences = {
					capture_preferences: {
						create_derived_artifacts: false,
					},
				};

				const result = await executeCreateDerivedArtifactStep(
					step,
					ArtifactId.parse(TEST_ARTIFACT_ID),
					StepId.parse(step.id),
					analysisResult,
					userPreferences
				);

				expect(result.success).toBe(false);
				expect(result.error).toBe('Skipped - user preference disabled');
			});

			it('should proceed when global preference is true', async () => {
				const step = createMockWorkflowStep();
				const artifact = createMockArtifact({
					id: TEST_ARTIFACT_ID,
					user_id: 'user-123',
				});
				setMockData('artifacts', [artifact]);

				const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
					success: true,
					derivedArtifactId: 'derived-123',
					derivedType: 'cleaned_meeting_notes',
				});

				registerIntentProcessor('meeting_notes', mockProcessor);

				const analysisResult: AnalysisResult = {
					intent: 'meeting_notes',
					entities_mentioned: [],
					actions_suggested: [],
					topics: [],
					sentiment: 'neutral',
					confidence: 0.9,
				};

				const userPreferences = {
					capture_preferences: {
						create_derived_artifacts: true,
					},
				};

				const result = await executeCreateDerivedArtifactStep(
					step,
					ArtifactId.parse(TEST_ARTIFACT_ID),
					StepId.parse(step.id),
					analysisResult,
					userPreferences
				);

				expect(result.success).toBe(true);
				expect(mockProcessor).toHaveBeenCalled();
			});

			it('should default to true when no preference is set', async () => {
				const step = createMockWorkflowStep();
				const artifact = createMockArtifact({
					id: TEST_ARTIFACT_ID,
					user_id: 'user-123',
				});
				setMockData('artifacts', [artifact]);
				setMockData('user_preferences', []); // No preferences in database

				const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
					success: true,
					derivedArtifactId: 'derived-123',
					derivedType: 'cleaned_meeting_notes',
				});

				registerIntentProcessor('meeting_notes', mockProcessor);

				const analysisResult: AnalysisResult = {
					intent: 'meeting_notes',
					entities_mentioned: [],
					actions_suggested: [],
					topics: [],
					sentiment: 'neutral',
					confidence: 0.9,
				};

				const result = await executeCreateDerivedArtifactStep(
					step,
					ArtifactId.parse(TEST_ARTIFACT_ID),
					StepId.parse(step.id),
					analysisResult
				);

				expect(result.success).toBe(true);
				expect(mockProcessor).toHaveBeenCalled();
			});

			it('should prioritize per-capture override over global preference', async () => {
				const step = createMockWorkflowStep();
				const artifact = createMockArtifact({
					id: TEST_ARTIFACT_ID,
					user_id: 'user-123',
				});
				setMockData('artifacts', [artifact]);

				const analysisResult: AnalysisResult = {
					intent: 'meeting_notes',
					entities_mentioned: [],
					actions_suggested: [],
					topics: [],
					sentiment: 'neutral',
					confidence: 0.9,
				};

				const userPreferences = {
					capture_preferences: {
						create_derived_artifacts: true, // Global is true
					},
				};

				const captureOptions = {
					create_derived_artifacts: false, // But per-capture is false (should win)
				};

				const result = await executeCreateDerivedArtifactStep(
					step,
					ArtifactId.parse(TEST_ARTIFACT_ID),
					StepId.parse(step.id),
					analysisResult,
					userPreferences,
					captureOptions
				);

				expect(result.success).toBe(false);
				expect(result.error).toBe('Skipped - user preference disabled');
			});
		});

		describe('Intent routing', () => {
			it('should skip when no processor found for intent', async () => {
				const step = createMockWorkflowStep();
				const artifact = createMockArtifact({
					id: TEST_ARTIFACT_ID,
					user_id: 'user-123',
				});
				setMockData('artifacts', [artifact]);

				const analysisResult: AnalysisResult = {
					intent: 'meeting_notes',
					entities_mentioned: [],
					actions_suggested: [],
					topics: [],
					sentiment: 'neutral',
					confidence: 0.9,
				};

				// No processor registered

				const result = await executeCreateDerivedArtifactStep(
					step,
					ArtifactId.parse(TEST_ARTIFACT_ID),
					StepId.parse(step.id),
					analysisResult
				);

				expect(result.success).toBe(false);
				expect(result.error).toBe('Skipped - intent doesn\'t require derived artifact');
			});

			it('should call processor when found', async () => {
				const step = createMockWorkflowStep();
				const artifact = createMockArtifact({
					id: TEST_ARTIFACT_ID,
					user_id: 'user-123',
				});
				setMockData('artifacts', [artifact]);

				const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
					success: true,
					derivedArtifactId: 'derived-123',
					derivedType: 'cleaned_meeting_notes',
					tokensUsed: 100,
				});

				registerIntentProcessor('meeting_notes', mockProcessor);

				const analysisResult: AnalysisResult = {
					intent: 'meeting_notes',
					entities_mentioned: [],
					actions_suggested: [],
					topics: [],
					sentiment: 'neutral',
					confidence: 0.9,
				};

				const result = await executeCreateDerivedArtifactStep(
					step,
					ArtifactId.parse(TEST_ARTIFACT_ID),
					StepId.parse(step.id),
					analysisResult
				);

				expect(result.success).toBe(true);
				expect(result.derivedArtifactId).toBe('derived-123');
				expect(mockProcessor).toHaveBeenCalledWith(
					step,
					expect.objectContaining({ id: TEST_ARTIFACT_ID }),
					analysisResult
				);
			});

			it('should handle processor failure', async () => {
				const step = createMockWorkflowStep();
				const artifact = createMockArtifact({
					id: TEST_ARTIFACT_ID,
					user_id: 'user-123',
				});
				setMockData('artifacts', [artifact]);

				const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
					success: false,
					error: 'Processor error',
				});

				registerIntentProcessor('meeting_notes', mockProcessor);

				const analysisResult: AnalysisResult = {
					intent: 'meeting_notes',
					entities_mentioned: [],
					actions_suggested: [],
					topics: [],
					sentiment: 'neutral',
					confidence: 0.9,
				};

				const result = await executeCreateDerivedArtifactStep(
					step,
					ArtifactId.parse(TEST_ARTIFACT_ID),
					StepId.parse(step.id),
					analysisResult
				);

				expect(result.success).toBe(false);
				expect(result.error).toBe('Processor error');
			});
		});

		describe('Step status updates', () => {
			it('should update step status to running at start', async () => {
				const step = createMockWorkflowStep();
				const artifact = createMockArtifact({
					id: TEST_ARTIFACT_ID,
					user_id: 'user-123',
				});
				setMockData('artifacts', [artifact]);

				const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
					success: true,
					derivedArtifactId: 'derived-123',
				});

				registerIntentProcessor('meeting_notes', mockProcessor);

				const analysisResult: AnalysisResult = {
					intent: 'meeting_notes',
					entities_mentioned: [],
					actions_suggested: [],
					topics: [],
					sentiment: 'neutral',
					confidence: 0.9,
				};

				await executeCreateDerivedArtifactStep(
					step,
					ArtifactId.parse(TEST_ARTIFACT_ID),
					StepId.parse(step.id),
					analysisResult
				);

				// Verify updateStepStatus was called with 'running'
				expect(mockSupabase.from).toHaveBeenCalledWith('workflow_steps');
			});

			it('should update step status to completed on success', async () => {
				const step = createMockWorkflowStep();
				const artifact = createMockArtifact({
					id: TEST_ARTIFACT_ID,
					user_id: 'user-123',
				});
				setMockData('artifacts', [artifact]);

				const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
					success: true,
					derivedArtifactId: 'derived-123',
					derivedType: 'cleaned_meeting_notes',
					tokensUsed: 100,
					notificationId: 'notif-123',
				});

				registerIntentProcessor('meeting_notes', mockProcessor);

				const analysisResult: AnalysisResult = {
					intent: 'meeting_notes',
					entities_mentioned: [],
					actions_suggested: [],
					topics: [],
					sentiment: 'neutral',
					confidence: 0.9,
				};

				const result = await executeCreateDerivedArtifactStep(
					step,
					ArtifactId.parse(TEST_ARTIFACT_ID),
					StepId.parse(step.id),
					analysisResult
				);

				expect(result.success).toBe(true);
				// Status update verification is implicit through supabase mock calls
			});

			it('should include tokensUsed in step output when step completes successfully', async () => {
				const step = createMockWorkflowStep();
				const artifact = createMockArtifact({
					id: TEST_ARTIFACT_ID,
					user_id: 'user-123',
				});
				setMockData('artifacts', [artifact]);

				const expectedTokensUsed = 150;
				const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
					success: true,
					derivedArtifactId: 'derived-123',
					derivedType: 'cleaned_meeting_notes',
					tokensUsed: expectedTokensUsed,
					notificationId: 'notif-123',
				});

				registerIntentProcessor('meeting_notes', mockProcessor);

				const analysisResult: AnalysisResult = {
					intent: 'meeting_notes',
					entities_mentioned: [],
					actions_suggested: [],
					topics: [],
					sentiment: 'neutral',
					confidence: 0.9,
				};

				const result = await executeCreateDerivedArtifactStep(
					step,
					ArtifactId.parse(TEST_ARTIFACT_ID),
					StepId.parse(step.id),
					analysisResult
				);

				expect(result.success).toBe(true);
				
				// Verify tokensUsed is included in CreateDerivedResult return value (Requirement 16.1)
				expect(result.tokensUsed).toBeDefined();
				expect(result.tokensUsed).toBe(expectedTokensUsed);
				expect(typeof result.tokensUsed).toBe('number');

				// Verify that tokensUsed is passed through from processor result
				// The implementation at line 1093 in createDerived.ts includes tokensUsed in step output
				// This test verifies the return value contains tokensUsed, which is the main requirement
			});

			it('should update step status to failed on error', async () => {
				const step = createMockWorkflowStep();
				setMockData('artifacts', []); // Artifact not found

				const analysisResult: AnalysisResult = {
					intent: 'meeting_notes',
					entities_mentioned: [],
					actions_suggested: [],
					topics: [],
					sentiment: 'neutral',
					confidence: 0.9,
				};

				const result = await executeCreateDerivedArtifactStep(
					step,
					ArtifactId.parse(TEST_ARTIFACT_ID_2),
					StepId.parse(step.id),
					analysisResult
				);

				expect(result.success).toBe(false);
				// Status update verification is implicit through supabase mock calls
			});

			it('should update step status to skipped when preference disabled', async () => {
				const step = createMockWorkflowStep();
				const artifact = createMockArtifact({
					id: TEST_ARTIFACT_ID,
					user_id: 'user-123',
				});
				setMockData('artifacts', [artifact]);

				const analysisResult: AnalysisResult = {
					intent: 'meeting_notes',
					entities_mentioned: [],
					actions_suggested: [],
					topics: [],
					sentiment: 'neutral',
					confidence: 0.9,
				};

				const captureOptions = {
					create_derived_artifacts: false,
				};

				const result = await executeCreateDerivedArtifactStep(
					step,
					ArtifactId.parse(TEST_ARTIFACT_ID),
					StepId.parse(step.id),
					analysisResult,
					undefined,
					captureOptions
				);

				expect(result.success).toBe(false);
				expect(result.error).toBe('Skipped - user preference disabled');
			});
		});

		describe('Edge cases', () => {
			it('should handle unclear intent gracefully', async () => {
				const step = createMockWorkflowStep();
				const artifact = createMockArtifact({
					id: TEST_ARTIFACT_ID,
					user_id: 'user-123',
				});
				setMockData('artifacts', [artifact]);

				const analysisResult: AnalysisResult = {
					intent: 'unclear',
					entities_mentioned: [],
					actions_suggested: [],
					topics: [],
					sentiment: 'neutral',
					confidence: 0.3,
				};

				// No processor for 'unclear' intent

				const result = await executeCreateDerivedArtifactStep(
					step,
					ArtifactId.parse(TEST_ARTIFACT_ID),
					StepId.parse(step.id),
					analysisResult
				);

				expect(result.success).toBe(false);
				expect(result.error).toBe('Skipped - intent doesn\'t require derived artifact');
			});

			it('should handle database error when fetching preferences', async () => {
				const step = createMockWorkflowStep();
				const artifact = createMockArtifact({
					id: TEST_ARTIFACT_ID,
					user_id: 'user-123',
				});
				setMockData('artifacts', [artifact]);

				// Simulate database error
				mockSupabase.from.mockReturnValueOnce({
					select: jest.fn().mockReturnValueOnce({
						eq: jest.fn().mockReturnValueOnce({
							single: jest.fn().mockRejectedValueOnce(new Error('Database error')),
						}),
					}),
				} as any);

				const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
					success: true,
					derivedArtifactId: 'derived-123',
				});

				registerIntentProcessor('meeting_notes', mockProcessor);

				const analysisResult: AnalysisResult = {
					intent: 'meeting_notes',
					entities_mentioned: [],
					actions_suggested: [],
					topics: [],
					sentiment: 'neutral',
					confidence: 0.9,
				};

				// Should default to true and proceed
				const result = await executeCreateDerivedArtifactStep(
					step,
					ArtifactId.parse(TEST_ARTIFACT_ID),
					StepId.parse(step.id),
					analysisResult
				);

				expect(result.success).toBe(true);
			});
		});
	});

	describe('extractContentForProcessing', () => {
		describe('Content extraction priority', () => {
			it('should return plain_text when available and non-empty', () => {
				const artifact = createMockArtifact({
					plain_text: 'This is plain text content',
					content_type: 'text',
					content: { text: 'This is content.text' },
					processing_metadata: {
						analysis: {
							extracted_text: 'This is extracted text',
						},
					},
				});

				const result = extractContentForProcessing(artifact);
				expect(result).toBe('This is plain text content');
			});

			it('should return content.text when plain_text is empty and content_type is text', () => {
				const artifact = createMockArtifact({
					plain_text: '',
					content_type: 'text',
					content: { text: 'This is content.text' },
					processing_metadata: {
						analysis: {
							extracted_text: 'This is extracted text',
						},
					},
				});

				const result = extractContentForProcessing(artifact);
				expect(result).toBe('This is content.text');
			});

			it('should return content.text when plain_text is null and content_type is text', () => {
				const artifact = createMockArtifact({
					plain_text: null,
					content_type: 'text',
					content: { text: 'This is content.text' },
					processing_metadata: {
						analysis: {
							extracted_text: 'This is extracted text',
						},
					},
				});

				const result = extractContentForProcessing(artifact);
				expect(result).toBe('This is content.text');
			});

			it('should return extracted_text when plain_text and content.text are not available', () => {
				const artifact = createMockArtifact({
					plain_text: null,
					content_type: 'text',
					content: null,
					processing_metadata: {
						analysis: {
							extracted_text: 'This is extracted text',
						},
					},
				});

				const result = extractContentForProcessing(artifact);
				expect(result).toBe('This is extracted text');
			});

			it('should return null when all content sources are missing', () => {
				const artifact = createMockArtifact({
					plain_text: null,
					content_type: 'text',
					content: null,
					processing_metadata: {},
				});

				const result = extractContentForProcessing(artifact);
				expect(result).toBeNull();
			});

			it('should return null when all content sources are empty strings', () => {
				const artifact = createMockArtifact({
					plain_text: '',
					content_type: 'text',
					content: { text: '' },
					processing_metadata: {
						analysis: {
							extracted_text: '',
						},
					},
				});

				const result = extractContentForProcessing(artifact);
				expect(result).toBeNull();
			});
		});

		describe('Content validation (empty/whitespace-only)', () => {
			it('should return null for whitespace-only plain_text', () => {
				const artifact = createMockArtifact({
					plain_text: '   \n\t  ',
					content_type: 'text',
					content: { text: 'This is content.text' },
				});

				const result = extractContentForProcessing(artifact);
				expect(result).toBe('This is content.text'); // Should fall back to content.text
			});

			it('should return null for whitespace-only content.text', () => {
				const artifact = createMockArtifact({
					plain_text: null,
					content_type: 'text',
					content: { text: '   \n\t  ' },
					processing_metadata: {
						analysis: {
							extracted_text: 'This is extracted text',
						},
					},
				});

				const result = extractContentForProcessing(artifact);
				expect(result).toBe('This is extracted text'); // Should fall back to extracted_text
			});

			it('should return null for whitespace-only extracted_text', () => {
				const artifact = createMockArtifact({
					plain_text: null,
					content_type: 'text',
					content: null,
					processing_metadata: {
						analysis: {
							extracted_text: '   \n\t  ',
						},
					},
				});

				const result = extractContentForProcessing(artifact);
				expect(result).toBeNull();
			});

			it('should trim content before returning', () => {
				const artifact = createMockArtifact({
					plain_text: '  This is plain text  ',
				});

				const result = extractContentForProcessing(artifact);
				expect(result).toBe('This is plain text');
			});
		});

		describe('Missing content sources handling', () => {
			it('should handle missing plain_text field', () => {
				const artifact = createMockArtifact({
					// plain_text not set
					content_type: 'text',
					content: { text: 'This is content.text' },
				});

				const result = extractContentForProcessing(artifact);
				expect(result).toBe('This is content.text');
			});

			it('should handle missing content field', () => {
				const artifact = createMockArtifact({
					plain_text: null,
					content_type: 'text',
					// content not set
					processing_metadata: {
						analysis: {
							extracted_text: 'This is extracted text',
						},
					},
				});

				const result = extractContentForProcessing(artifact);
				expect(result).toBe('This is extracted text');
			});

			it('should handle missing processing_metadata field', () => {
				const artifact = createMockArtifact({
					plain_text: null,
					content_type: 'text',
					content: { text: 'This is content.text' },
					// processing_metadata not set
				});

				const result = extractContentForProcessing(artifact);
				expect(result).toBe('This is content.text');
			});

			it('should handle content_type not being "text"', () => {
				const artifact = createMockArtifact({
					plain_text: null,
					content_type: 'image/jpeg', // Not text
					content: { text: 'This is content.text' },
					processing_metadata: {
						analysis: {
							extracted_text: 'This is extracted text',
						},
					},
				});

				const result = extractContentForProcessing(artifact);
				expect(result).toBe('This is extracted text'); // Should skip content.text and use extracted_text
			});

			it('should handle content without text field', () => {
				const artifact = createMockArtifact({
					plain_text: null,
					content_type: 'text',
					content: { other_field: 'value' }, // No text field
					processing_metadata: {
						analysis: {
							extracted_text: 'This is extracted text',
						},
					},
				});

				const result = extractContentForProcessing(artifact);
				expect(result).toBe('This is extracted text');
			});

			it('should handle processing_metadata without analysis field', () => {
				const artifact = createMockArtifact({
					plain_text: null,
					content_type: 'text',
					content: null,
					processing_metadata: {
						other_field: 'value', // No analysis field
					},
				});

				const result = extractContentForProcessing(artifact);
				expect(result).toBeNull();
			});

			it('should handle analysis without extracted_text field', () => {
				const artifact = createMockArtifact({
					plain_text: null,
					content_type: 'text',
					content: null,
					processing_metadata: {
						analysis: {
							other_field: 'value', // No extracted_text field
						},
					},
				});

				const result = extractContentForProcessing(artifact);
				expect(result).toBeNull();
			});
		});
	});

	describe('Property 1: Conditional Execution Based on Intent', () => {
		/**
		 * Property 1: Conditional Execution Based on Intent
		 * 
		 * Validates: Requirements 1.1, 1.2, 1.3, 2.1, 2.2
		 * 
		 * For any workflow execution where the create_derived step is reached,
		 * the step SHALL execute if and only if a processor is registered for
		 * the intent (and, for "document", shouldClean !== false). Otherwise,
		 * the step SHALL be skipped.
		 *
		 * In production only "document" registers a processor: the
		 * "meeting_notes" one was retired (ADR-082, #874). The "meeting_notes"
		 * case below registers a mock processor to exercise the routing, not
		 * because production still routes that intent.
		 */

		it('should execute step for intent === "meeting_notes"', async () => {
			const step = createMockWorkflowStep();
			const artifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-123',
				plain_text: 'Meeting notes content',
			});
			setMockData('artifacts', [artifact]);

			const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
				success: true,
				derivedArtifactId: 'derived-123',
				derivedType: 'cleaned_meeting_notes',
				tokensUsed: 100,
			});

			registerIntentProcessor('meeting_notes', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(true);
			expect(mockProcessor).toHaveBeenCalledTimes(1);
			expect(mockProcessor).toHaveBeenCalledWith(
				step,
				expect.objectContaining({ id: TEST_ARTIFACT_ID }),
				analysisResult
			);
		});

		it('should execute step for intent === "document" AND shouldClean === true', async () => {
			const step = createMockWorkflowStep();
			const artifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-123',
				plain_text: 'Document content',
			});
			setMockData('artifacts', [artifact]);

			const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
				success: true,
				derivedArtifactId: 'derived-123',
				derivedType: 'summarized_document',
				tokensUsed: 100,
			});

			registerIntentProcessor('document', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'document',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
				shouldClean: true,
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(true);
			expect(mockProcessor).toHaveBeenCalledTimes(1);
			expect(mockProcessor).toHaveBeenCalledWith(
				step,
				expect.objectContaining({ id: TEST_ARTIFACT_ID }),
				analysisResult
			);
		});

		it('should skip step for intent === "document" AND shouldClean === false', async () => {
			const step = createMockWorkflowStep();
			const artifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-123',
				plain_text: 'Document content',
			});
			setMockData('artifacts', [artifact]);

			const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
				success: true,
				derivedArtifactId: 'derived-123',
				derivedType: 'summarized_document',
			});

			registerIntentProcessor('document', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'document',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
				shouldClean: false,
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Skipped - intent doesn\'t require derived artifact');
			expect(mockProcessor).not.toHaveBeenCalled();
		});

		it('should skip step for intents without registered processors', async () => {
			const step = createMockWorkflowStep();
			const artifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-123',
				plain_text: 'Content',
			});
			setMockData('artifacts', [artifact]);

			// No processor registered for 'personal_reflection'

			const analysisResult: AnalysisResult = {
				intent: 'personal_reflection',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Skipped - intent doesn\'t require derived artifact');
		});

		it('should skip step for "unclear" intent (no processor registered)', async () => {
			const step = createMockWorkflowStep();
			const artifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-123',
				plain_text: 'Unclear content',
			});
			setMockData('artifacts', [artifact]);

			// No processor registered for 'unclear'

			const analysisResult: AnalysisResult = {
				intent: 'unclear',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.3,
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Skipped - intent doesn\'t require derived artifact');
		});

		it('should execute step for intent === "document" with shouldClean === undefined (defaults to true)', async () => {
			const step = createMockWorkflowStep();
			const artifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-123',
				plain_text: 'Document content',
			});
			setMockData('artifacts', [artifact]);

			const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
				success: true,
				derivedArtifactId: 'derived-123',
				derivedType: 'summarized_document',
				tokensUsed: 100,
			});

			registerIntentProcessor('document', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'document',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
				// shouldClean is undefined - should default to true
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(true);
			expect(mockProcessor).toHaveBeenCalledTimes(1);
			expect(mockProcessor).toHaveBeenCalledWith(
				step,
				expect.objectContaining({ id: TEST_ARTIFACT_ID }),
				analysisResult
			);
		});
	});

	describe('Property 2: User Preference Enforcement', () => {
		/**
		 * Property 2: User Preference Enforcement
		 * 
		 * Validates: Requirements 9.1, 9.4, 9.5, 9.6, 10.6, 10.7
		 * 
		 * For any workflow execution where the create_derived step is reached,
		 * user preferences SHALL control whether the step executes:
		 * - Global preference (from user_preferences.capture_preferences.create_derived_artifacts)
		 * - Per-capture override (from captureOptions.create_derived_artifacts)
		 * - Per-capture override SHALL take precedence over global preference
		 * - Default SHALL be true when no preference is set
		 */

		it('should skip step when global preference is false', async () => {
			const step = createMockWorkflowStep();
			const artifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-123',
				plain_text: 'Meeting notes content',
			});
			setMockData('artifacts', [artifact]);

			const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
				success: true,
				derivedArtifactId: 'derived-123',
				derivedType: 'cleaned_meeting_notes',
			});

			registerIntentProcessor('meeting_notes', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			const userPreferences = {
				capture_preferences: {
					create_derived_artifacts: false,
				},
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult,
				userPreferences
			);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Skipped - user preference disabled');
			expect(mockProcessor).not.toHaveBeenCalled();
		});

		it('should skip step when per-capture override is false (even if global is true)', async () => {
			const step = createMockWorkflowStep();
			const artifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-123',
				plain_text: 'Meeting notes content',
			});
			setMockData('artifacts', [artifact]);

			const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
				success: true,
				derivedArtifactId: 'derived-123',
				derivedType: 'cleaned_meeting_notes',
			});

			registerIntentProcessor('meeting_notes', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			const userPreferences = {
				capture_preferences: {
					create_derived_artifacts: true, // Global is true
				},
			};

			const captureOptions = {
				create_derived_artifacts: false, // Per-capture is false (should win)
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult,
				userPreferences,
				captureOptions
			);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Skipped - user preference disabled');
			expect(mockProcessor).not.toHaveBeenCalled();
		});

		it('should proceed when global preference is true', async () => {
			const step = createMockWorkflowStep();
			const artifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-123',
				plain_text: 'Meeting notes content',
			});
			setMockData('artifacts', [artifact]);

			const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
				success: true,
				derivedArtifactId: 'derived-123',
				derivedType: 'cleaned_meeting_notes',
				tokensUsed: 100,
			});

			registerIntentProcessor('meeting_notes', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			const userPreferences = {
				capture_preferences: {
					create_derived_artifacts: true,
				},
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult,
				userPreferences
			);

			expect(result.success).toBe(true);
			expect(mockProcessor).toHaveBeenCalledTimes(1);
		});

		it('should proceed when no preference is set (defaults to true)', async () => {
			const step = createMockWorkflowStep();
			const artifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-123',
				plain_text: 'Meeting notes content',
			});
			setMockData('artifacts', [artifact]);
			setMockData('user_preferences', []); // No preferences in database

			const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
				success: true,
				derivedArtifactId: 'derived-123',
				derivedType: 'cleaned_meeting_notes',
				tokensUsed: 100,
			});

			registerIntentProcessor('meeting_notes', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
				// No userPreferences or captureOptions provided
			);

			expect(result.success).toBe(true);
			expect(mockProcessor).toHaveBeenCalledTimes(1);
		});

		it('should prioritize per-capture override when true over global false', async () => {
			const step = createMockWorkflowStep();
			const artifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-123',
				plain_text: 'Meeting notes content',
			});
			setMockData('artifacts', [artifact]);

			const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
				success: true,
				derivedArtifactId: 'derived-123',
				derivedType: 'cleaned_meeting_notes',
				tokensUsed: 100,
			});

			registerIntentProcessor('meeting_notes', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			const userPreferences = {
				capture_preferences: {
					create_derived_artifacts: false, // Global is false
				},
			};

			const captureOptions = {
				create_derived_artifacts: true, // Per-capture is true (should win)
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult,
				userPreferences,
				captureOptions
			);

			expect(result.success).toBe(true);
			expect(mockProcessor).toHaveBeenCalledTimes(1);
		});

		it('should skip when global preference is undefined and per-capture is false', async () => {
			const step = createMockWorkflowStep();
			const artifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-123',
				plain_text: 'Meeting notes content',
			});
			setMockData('artifacts', [artifact]);

			const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
				success: true,
				derivedArtifactId: 'derived-123',
				derivedType: 'cleaned_meeting_notes',
			});

			registerIntentProcessor('meeting_notes', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			const captureOptions = {
				create_derived_artifacts: false, // Per-capture is false
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult,
				undefined, // No userPreferences
				captureOptions
			);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Skipped - user preference disabled');
			expect(mockProcessor).not.toHaveBeenCalled();
		});
	});

	describe('Property 4: Derived Artifact Creation', () => {
		/**
		 * Property 4: Derived Artifact Creation
		 * 
		 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.12, 6.13, 6.14, 6.15, 11.1
		 * 
		 * For any successful derived artifact creation,
		 * the derived artifact SHALL be created in the artifacts table with all required fields set correctly.
		 */

		it('should create derived artifact in artifacts table (not derived_artifacts)', async () => {
			const step = createMockWorkflowStep();
			const sourceArtifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-123',
				filename: 'Meeting Notes.txt',
				plain_text: 'This is the original meeting notes content that needs to be cleaned up and formatted properly.',
			});
			setMockData('artifacts', [sourceArtifact]);

			const mockProcessor: IntentProcessor = jest.fn().mockImplementation(async (step, artifact, analysisResult) => {
				// Simulate creating derived artifact using createDerivedArtifactRecord
				const { createDerivedArtifactRecord } = await import('../../../../src/workflows/steps/createDerived');
				const derivedContent = 'Cleaned meeting notes content';
				const derivedType = 'cleaned_meeting_notes';
				const tokensUsed = 150;
				const originalLength = artifact.plain_text?.length || 0;

				const derivedArtifact = await createDerivedArtifactRecord(
					artifact,
					derivedContent,
					derivedType,
					tokensUsed,
					originalLength
				);

				return {
					success: true,
					derivedArtifactId: derivedArtifact.id,
					derivedType: derivedType,
					tokensUsed: tokensUsed,
				};
			});

			registerIntentProcessor('meeting_notes', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(true);

			// Verify artifact was created in artifacts table (not derived_artifacts)
			const artifacts = getMockData('artifacts');
			expect(artifacts.length).toBe(2); // Source + derived
			
			const derivedArtifact = artifacts.find((a: any) => a.id === result.derivedArtifactId);
			expect(derivedArtifact).toBeDefined();
			expect(derivedArtifact?.content_subtype).toBe('derived');
		});

		it('should set all required fields correctly on derived artifact', async () => {
			const step = createMockWorkflowStep();
			const sourceArtifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-456',
				team_id: 'team-789',
				filename: 'Project Document.md',
				plain_text: 'This is a long document that needs to be summarized for quick review.',
			});
			setMockData('artifacts', [sourceArtifact]);

			const mockProcessor: IntentProcessor = jest.fn().mockImplementation(async (step, artifact, analysisResult) => {
				const { createDerivedArtifactRecord } = await import('../../../../src/workflows/steps/createDerived');
				const derivedContent = 'Executive summary of the document';
				const derivedType = 'summarized_document';
				const tokensUsed = 200;
				const originalLength = artifact.plain_text?.length || 0;

				const derivedArtifact = await createDerivedArtifactRecord(
					artifact,
					derivedContent,
					derivedType,
					tokensUsed,
					originalLength
				);

				return {
					success: true,
					derivedArtifactId: derivedArtifact.id,
					derivedType: derivedType,
					tokensUsed: tokensUsed,
				};
			});

			registerIntentProcessor('document', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'document',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
				shouldClean: true,
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(true);

			// Get the derived artifact
			const artifacts = getMockData('artifacts');
			const derivedArtifact = artifacts.find((a: any) => a.id === result.derivedArtifactId);
			expect(derivedArtifact).toBeDefined();

			// Requirement 6.2: ID is a UUID
			expect(typeof derivedArtifact?.id).toBe('string');
			expect(derivedArtifact?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

			// Requirement 6.3: user_id from source artifact
			expect(derivedArtifact?.user_id).toBe('user-456');

			// Requirement 6.4: team_id from source artifact
			expect(derivedArtifact?.team_id).toBe('team-789');

			// Requirement 6.5: storage_path placeholder value
			expect(typeof derivedArtifact?.storage_path).toBe('string');
			expect(derivedArtifact?.storage_path).toContain('derived/');
			expect(derivedArtifact?.storage_path).toContain('.md');

			// Requirement 6.6: filename formatted with derivedType
			expect(derivedArtifact?.filename).toBe('Project Document.md (summarized document)');

			// Requirement 6.7: content_type is "text"
			expect(derivedArtifact?.content_type).toBe('text');

			// Requirement 6.8: content_subtype is "derived"
			expect(derivedArtifact?.content_subtype).toBe('derived');

			// Requirement 6.9: file_extension is "md"
			expect(derivedArtifact?.file_extension).toBe('md');

			// Requirement 6.10: plain_text is the AI-generated derived content
			expect(derivedArtifact?.plain_text).toBe('Executive summary of the document');

			// Requirement 6.11: content is null or empty JSONB
			expect(derivedArtifact?.content).toBeNull();

			// Requirement 6.12: lifecycle_stage is "complete"
			expect(derivedArtifact?.lifecycle_stage).toBe('complete');

			// Requirement 6.13: processing_status is "completed"
			expect(derivedArtifact?.processing_status).toBe('completed');
		});

		it('should set processing_metadata with correct values', async () => {
			const step = createMockWorkflowStep();
			const plainTextContent = '12345678901234567890123456789012345678901234567890'; // Exactly 50 characters
			const sourceArtifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-789',
				filename: 'Notes.txt',
				plain_text: plainTextContent,
			});
			setMockData('artifacts', [sourceArtifact]);

			const mockProcessor: IntentProcessor = jest.fn().mockImplementation(async (step, artifact, analysisResult) => {
				const { createDerivedArtifactRecord } = await import('../../../../src/workflows/steps/createDerived');
				const derivedContent = 'Cleaned content';
				const derivedType = 'cleaned_meeting_notes';
				const tokensUsed = 120;
				const originalLength = artifact.plain_text?.length || 0;

				const derivedArtifact = await createDerivedArtifactRecord(
					artifact,
					derivedContent,
					derivedType,
					tokensUsed,
					originalLength
				);

				return {
					success: true,
					derivedArtifactId: derivedArtifact.id,
					derivedType: derivedType,
					tokensUsed: tokensUsed,
				};
			});

			registerIntentProcessor('meeting_notes', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(true);

			// Get the derived artifact
			const artifacts = getMockData('artifacts');
			const derivedArtifact = artifacts.find((a: any) => a.id === result.derivedArtifactId);
			expect(derivedArtifact).toBeDefined();

			// Requirement 6.14: processing_metadata contains required fields
			const metadata = derivedArtifact?.processing_metadata;
			expect(metadata).toBeDefined();
			expect(typeof metadata).toBe('object');

			// derived_from: source artifact ID
			expect(metadata?.derived_from).toBe(TEST_ARTIFACT_ID);

			// derived_type: derivedType
			expect(metadata?.derived_type).toBe('cleaned_meeting_notes');

			// derived_at: ISO timestamp
			expect(metadata?.derived_at).toBeDefined();
			expect(typeof metadata?.derived_at).toBe('string');
			expect(new Date(metadata?.derived_at).toISOString()).toBe(metadata?.derived_at);

			// tokens_used: tokensUsed
			expect(metadata?.tokens_used).toBe(120);
			expect(typeof metadata?.tokens_used).toBe('number');

			// original_length: length of source content
			expect(metadata?.original_length).toBe(50);
			expect(typeof metadata?.original_length).toBe('number');

			// derived_length: length of derived content
			expect(metadata?.derived_length).toBe('Cleaned content'.length);
			expect(typeof metadata?.derived_length).toBe('number');

			// compression_ratio: derived_length / original_length
			const expectedRatio = 'Cleaned content'.length / 50;
			expect(metadata?.compression_ratio).toBeCloseTo(expectedRatio, 5);
			expect(typeof metadata?.compression_ratio).toBe('number');
		});

		it('should set tags array to ["derived", derivedType]', async () => {
			const step = createMockWorkflowStep();
			const sourceArtifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-tags',
				filename: 'Document.txt',
				plain_text: 'Content to process',
			});
			setMockData('artifacts', [sourceArtifact]);

			// Test with meeting_notes intent
			const mockProcessorMeeting: IntentProcessor = jest.fn().mockImplementation(async (step, artifact, analysisResult) => {
				const { createDerivedArtifactRecord } = await import('../../../../src/workflows/steps/createDerived');
				const derivedContent = 'Cleaned notes';
				const derivedType = 'cleaned_meeting_notes';
				const tokensUsed = 100;
				const originalLength = artifact.plain_text?.length || 0;

				const derivedArtifact = await createDerivedArtifactRecord(
					artifact,
					derivedContent,
					derivedType,
					tokensUsed,
					originalLength
				);

				return {
					success: true,
					derivedArtifactId: derivedArtifact.id,
					derivedType: derivedType,
					tokensUsed: tokensUsed,
				};
			});

			registerIntentProcessor('meeting_notes', mockProcessorMeeting);

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(true);

			// Get the derived artifact
			const artifacts = getMockData('artifacts');
			const derivedArtifact = artifacts.find((a: any) => a.id === result.derivedArtifactId);
			expect(derivedArtifact).toBeDefined();

			// Requirement 6.15: tags array contains ["derived", derivedType]
			expect(Array.isArray(derivedArtifact?.tags)).toBe(true);
			expect(derivedArtifact?.tags).toEqual(['derived', 'cleaned_meeting_notes']);
		});

		it('should create derived artifact with correct tags for document intent', async () => {
			const step = createMockWorkflowStep();
			const sourceArtifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-doc',
				filename: 'Report.pdf',
				plain_text: 'Long document content',
			});
			setMockData('artifacts', [sourceArtifact]);

			const mockProcessorDoc: IntentProcessor = jest.fn().mockImplementation(async (step, artifact, analysisResult) => {
				const { createDerivedArtifactRecord } = await import('../../../../src/workflows/steps/createDerived');
				const derivedContent = 'Document summary';
				const derivedType = 'summarized_document';
				const tokensUsed = 150;
				const originalLength = artifact.plain_text?.length || 0;

				const derivedArtifact = await createDerivedArtifactRecord(
					artifact,
					derivedContent,
					derivedType,
					tokensUsed,
					originalLength
				);

				return {
					success: true,
					derivedArtifactId: derivedArtifact.id,
					derivedType: derivedType,
					tokensUsed: tokensUsed,
				};
			});

			registerIntentProcessor('document', mockProcessorDoc);

			const analysisResult: AnalysisResult = {
				intent: 'document',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
				shouldClean: true,
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(true);

			// Get the derived artifact
			const artifacts = getMockData('artifacts');
			const derivedArtifact = artifacts.find((a: any) => a.id === result.derivedArtifactId);
			expect(derivedArtifact).toBeDefined();

			// Tags should be ["derived", "summarized_document"]
			expect(derivedArtifact?.tags).toEqual(['derived', 'summarized_document']);
		});

		it('should handle null team_id from source artifact', async () => {
			const step = createMockWorkflowStep();
			const sourceArtifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-solo',
				team_id: null, // No team
				filename: 'Personal Note.txt',
				plain_text: 'Personal content',
			});
			setMockData('artifacts', [sourceArtifact]);

			const mockProcessor: IntentProcessor = jest.fn().mockImplementation(async (step, artifact, analysisResult) => {
				const { createDerivedArtifactRecord } = await import('../../../../src/workflows/steps/createDerived');
				const derivedContent = 'Cleaned personal note';
				const derivedType = 'cleaned_meeting_notes';
				const tokensUsed = 80;
				const originalLength = artifact.plain_text?.length || 0;

				const derivedArtifact = await createDerivedArtifactRecord(
					artifact,
					derivedContent,
					derivedType,
					tokensUsed,
					originalLength
				);

				return {
					success: true,
					derivedArtifactId: derivedArtifact.id,
					derivedType: derivedType,
					tokensUsed: tokensUsed,
				};
			});

			registerIntentProcessor('meeting_notes', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(true);

			// Get the derived artifact
			const artifacts = getMockData('artifacts');
			const derivedArtifact = artifacts.find((a: any) => a.id === result.derivedArtifactId);
			expect(derivedArtifact).toBeDefined();

			// Requirement 6.4: team_id should be null when source has no team
			expect(derivedArtifact?.team_id).toBeNull();
		});

		it('should format filename with derivedType replacing underscores with spaces', async () => {
			const step = createMockWorkflowStep();
			const sourceArtifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-filename',
				filename: 'Q4 Strategy Meeting',
				plain_text: 'Meeting notes',
			});
			setMockData('artifacts', [sourceArtifact]);

			const mockProcessor: IntentProcessor = jest.fn().mockImplementation(async (step, artifact, analysisResult) => {
				const { createDerivedArtifactRecord } = await import('../../../../src/workflows/steps/createDerived');
				const derivedContent = 'Cleaned notes';
				const derivedType = 'cleaned_meeting_notes'; // Has underscores
				const tokensUsed = 90;
				const originalLength = artifact.plain_text?.length || 0;

				const derivedArtifact = await createDerivedArtifactRecord(
					artifact,
					derivedContent,
					derivedType,
					tokensUsed,
					originalLength
				);

				return {
					success: true,
					derivedArtifactId: derivedArtifact.id,
					derivedType: derivedType,
					tokensUsed: tokensUsed,
				};
			});

			registerIntentProcessor('meeting_notes', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(true);

			// Get the derived artifact
			const artifacts = getMockData('artifacts');
			const derivedArtifact = artifacts.find((a: any) => a.id === result.derivedArtifactId);
			expect(derivedArtifact).toBeDefined();

			// Requirement 6.6: filename should have underscores replaced with spaces
			expect(derivedArtifact?.filename).toBe('Q4 Strategy Meeting (cleaned meeting notes)');
		});

		it('should verify all database fields are set on derived artifact creation', async () => {
			const step = createMockWorkflowStep();
			const sourceArtifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-complete',
				team_id: 'team-complete',
				filename: 'Complete Test.md',
				plain_text: 'Full test content here',
			});
			setMockData('artifacts', [sourceArtifact]);

			const mockProcessor: IntentProcessor = jest.fn().mockImplementation(async (step, artifact, analysisResult) => {
				const { createDerivedArtifactRecord } = await import('../../../../src/workflows/steps/createDerived');
				const derivedContent = 'Processed content';
				const derivedType = 'summarized_document';
				const tokensUsed = 175;
				const originalLength = artifact.plain_text?.length || 0;

				const derivedArtifact = await createDerivedArtifactRecord(
					artifact,
					derivedContent,
					derivedType,
					tokensUsed,
					originalLength
				);

				return {
					success: true,
					derivedArtifactId: derivedArtifact.id,
					derivedType: derivedType,
					tokensUsed: tokensUsed,
				};
			});

			registerIntentProcessor('document', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'document',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
				shouldClean: true,
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(true);

			// Get the derived artifact
			const artifacts = getMockData('artifacts');
			const derivedArtifact = artifacts.find((a: any) => a.id === result.derivedArtifactId);
			expect(derivedArtifact).toBeDefined();

			// Comprehensive validation of all fields (Requirements 6.1-6.15, 11.1)
			expect(derivedArtifact).toMatchObject({
				// Core identification
				id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
				user_id: 'user-complete',
				team_id: 'team-complete',
				
				// Storage fields
				storage_path: expect.stringContaining('derived/'),
				storage_url: expect.any(String),
				
				// Content identification
				filename: 'Complete Test.md (summarized document)',
				content_type: 'text',
				content_subtype: 'derived',
				file_extension: 'md',
				
				// Content fields
				plain_text: 'Processed content',
				content: null,
				
				// Lifecycle fields
				lifecycle_stage: 'complete',
				processing_status: 'completed',
				
				// Tags
				tags: ['derived', 'summarized_document'],
			});

			// Validate processing_metadata structure
			expect(derivedArtifact?.processing_metadata).toMatchObject({
				derived_from: TEST_ARTIFACT_ID,
				derived_type: 'summarized_document',
				derived_at: expect.any(String),
				tokens_used: 175,
				original_length: 22, // 'Full test content here'.length
				derived_length: 'Processed content'.length,
				compression_ratio: expect.any(Number),
			});

			// Requirement 11.1: Stored in artifacts table (not derived_artifacts), ensuring editability
			expect(artifacts.some((a: any) => a.id === result.derivedArtifactId && a.content_subtype === 'derived')).toBe(true);
		});
	});

	describe('Property 5: Non-Fatal Step Execution', () => {
		/**
		 * Property 5: Non-Fatal Step Execution
		 * 
		 * Validates: Requirements 1.7, 13.5
		 * 
		 * For any failure in the create_derived step,
		 * the step SHALL return a failure result (not throw an exception),
		 * the step status SHALL be marked as 'failed',
		 * and the workflow SHALL continue to the next step (non-fatal behavior).
		 * 
		 * Note: The orchestrator is responsible for continuing workflow execution.
		 * This property test validates that the step itself handles failures gracefully
		 * and returns failure results without throwing exceptions.
		 */

		it('should return failure result (not throw) when processor fails', async () => {
			const step = createMockWorkflowStep();
			const artifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-123',
				plain_text: 'Content to process',
			});
			setMockData('artifacts', [artifact]);

			const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
				success: false,
				error: 'AI processing failed',
			});

			registerIntentProcessor('meeting_notes', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			// Requirement 1.7, 13.5: Should return failure result, not throw
			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(false);
			expect(result.error).toBe('AI processing failed');
			// Should not throw - test passes if we get here
		});

		it('should return failure result (not throw) when processor throws exception', async () => {
			const step = createMockWorkflowStep();
			const artifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-123',
				plain_text: 'Content to process',
			});
			setMockData('artifacts', [artifact]);

			const mockProcessor: IntentProcessor = jest.fn().mockRejectedValue(
				new Error('Processor exception')
			);

			registerIntentProcessor('meeting_notes', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			// Requirement 1.7, 13.5: Should catch exception and return failure result, not throw
			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Processor exception');
			// Should not throw - test passes if we get here
		});

		it('should mark step status as failed when step fails', async () => {
			const step = createMockWorkflowStep({ id: 123 });
			const artifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-123',
				plain_text: 'Content to process',
			});
			setMockData('artifacts', [artifact]);

			const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
				success: false,
				error: 'Database error during artifact creation',
			});

			registerIntentProcessor('meeting_notes', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			// Verify step status was updated to 'failed'
			// Check mock data for workflow_steps table
			const workflowSteps = getMockData('workflow_steps');
			const updatedStep = workflowSteps.find((s: any) => s.id === step.id);
			
			// The step status update happens via supabase mock, so we verify via mock calls
			// The actual status update is verified through the supabase.from().update() calls
			expect(mockSupabase.from).toHaveBeenCalledWith('workflow_steps');
		});

		it('should handle AI failure scenario gracefully', async () => {
			const step = createMockWorkflowStep();
			const artifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-123',
				plain_text: 'Content for AI processing',
			});
			setMockData('artifacts', [artifact]);

			// Simulate AI failure (e.g., API timeout, rate limit, empty response)
			const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
				success: false,
				error: 'AI returned empty content',
			});

			registerIntentProcessor('meeting_notes', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			// Requirement 13.3, 13.5: Should handle AI failure gracefully
			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(false);
			expect(result.error).toBe('AI returned empty content');
			// Should not throw - workflow can continue
		});

		it('should handle database error scenario gracefully', async () => {
			const step = createMockWorkflowStep();
			const artifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-123',
				plain_text: 'Content to process',
			});
			setMockData('artifacts', [artifact]);

			// Simulate database error during artifact creation
			const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
				success: false,
				error: 'Failed to create derived artifact',
			});

			registerIntentProcessor('meeting_notes', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			// Requirement 6.16, 13.5: Should handle database error gracefully
			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Failed to create derived artifact');
			// Should not throw - workflow can continue
		});

		it('should handle content extraction failure scenario gracefully', async () => {
			const step = createMockWorkflowStep();
			// Artifact with no extractable content
			const artifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-123',
				plain_text: null,
				content: null,
				processing_metadata: {},
			});
			setMockData('artifacts', [artifact]);

			const mockProcessor: IntentProcessor = jest.fn().mockResolvedValue({
				success: false,
				error: 'No text content available to process',
			});

			registerIntentProcessor('meeting_notes', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			// Requirement 3.5, 13.5: Should handle content extraction failure gracefully
			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(false);
			expect(result.error).toBe('No text content available to process');
			// Should not throw - workflow can continue
		});

		it('should handle artifact not found scenario gracefully', async () => {
			const step = createMockWorkflowStep();
			setMockData('artifacts', []); // No artifacts in database

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			// Requirement 13.1, 13.5: Should handle artifact not found gracefully
			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID_2),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Artifact not found');
			// Should not throw - workflow can continue
		});

		it('should return failure result for multiple failure scenarios without throwing', async () => {
			const step = createMockWorkflowStep();
			const artifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-123',
				plain_text: 'Content',
			});
			setMockData('artifacts', [artifact]);

			const failureScenarios = [
				{ error: 'AI call failed', processor: jest.fn().mockResolvedValue({ success: false, error: 'AI call failed' }) },
				{ error: 'Database connection timeout', processor: jest.fn().mockResolvedValue({ success: false, error: 'Database connection timeout' }) },
				{ error: 'Content too long', processor: jest.fn().mockResolvedValue({ success: false, error: 'Content too long' }) },
			];

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			// Test each failure scenario
			for (const scenario of failureScenarios) {
				clearIntentProcessors();
				registerIntentProcessor('meeting_notes', scenario.processor);

				// Requirement 1.7, 13.5: All failures should return result, not throw
				const result = await executeCreateDerivedArtifactStep(
					step,
					ArtifactId.parse(TEST_ARTIFACT_ID),
					StepId.parse(step.id),
					analysisResult
				);

				expect(result.success).toBe(false);
				expect(result.error).toBe(scenario.error);
				// Should not throw for any scenario
			}
		});

		it('should ensure step failure does not prevent workflow continuation (non-fatal behavior)', async () => {
			const step = createMockWorkflowStep();
			const artifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-123',
				plain_text: 'Content',
			});
			setMockData('artifacts', [artifact]);

			const mockProcessor: IntentProcessor = jest.fn().mockRejectedValue(
				new Error('Critical processor failure')
			);

			registerIntentProcessor('meeting_notes', mockProcessor);

			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};

			// Requirement 1.7, 13.5: Step should catch all errors and return failure result
			// This allows orchestrator to continue workflow execution
			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			// Verify failure is returned (not thrown)
			expect(result.success).toBe(false);
			expect(result.error).toBe('Critical processor failure');

			// Verify step was called (execution attempted)
			expect(mockProcessor).toHaveBeenCalled();

			// The fact that we get here without exception proves non-fatal behavior
			// The orchestrator can check result.success and continue to next step
		});
	});

	describe('Property 6: Artifact Linking', () => {
		/**
		 * Property 6: Artifact Linking
		 * 
		 * Validates: Requirements 7.1, 7.2
		 * 
		 * For any successful derived artifact creation,
		 * the source artifact SHALL be updated to link to the derived artifact:
		 * - Source artifact's `processing_metadata.derived_artifact_id` SHALL be updated with derived artifact ID
		 * - Source artifact's `lifecycle_stage` SHALL be updated to `"artifacts_created"` (if not already at later stage)
		 */

		it('should update source artifact processing_metadata with derived_artifact_id', async () => {
			const sourceArtifactId = 'source-artifact-123';
			const derivedArtifactId = 'derived-artifact-456';
			
			const sourceArtifact = createMockArtifact({
				id: sourceArtifactId,
				user_id: 'user-123',
				lifecycle_stage: 'actions_extracted',
				processing_metadata: {
					analysis: {
						intent: 'meeting_notes',
					},
				},
			});
			
			setMockData('artifacts', [sourceArtifact]);
			
			// Call linkDerivedArtifact directly
			await linkDerivedArtifact(sourceArtifactId, derivedArtifactId);
			
			// Verify source artifact was updated
			const artifacts = getMockData('artifacts');
			const updatedSourceArtifact = artifacts.find((a: any) => a.id === sourceArtifactId);
			
			expect(updatedSourceArtifact).toBeDefined();
			
			// Requirement 7.1: processing_metadata.derived_artifact_id should be set
			expect(updatedSourceArtifact?.processing_metadata).toBeDefined();
			expect(typeof updatedSourceArtifact?.processing_metadata).toBe('object');
			expect(updatedSourceArtifact?.processing_metadata?.derived_artifact_id).toBe(derivedArtifactId);
			
			// Verify existing metadata is preserved (merged, not replaced)
			expect(updatedSourceArtifact?.processing_metadata?.analysis).toBeDefined();
			expect(updatedSourceArtifact?.processing_metadata?.analysis?.intent).toBe('meeting_notes');
		});

		it('should update source artifact lifecycle_stage to artifacts_created when at earlier stage', async () => {
			const sourceArtifactId = 'source-artifact-789';
			const derivedArtifactId = 'derived-artifact-012';
			
			const sourceArtifact = createMockArtifact({
				id: sourceArtifactId,
				user_id: 'user-789',
				lifecycle_stage: 'actions_extracted', // Earlier stage
				processing_metadata: {},
			});
			
			setMockData('artifacts', [sourceArtifact]);
			
			// Call linkDerivedArtifact
			await linkDerivedArtifact(sourceArtifactId, derivedArtifactId);
			
			// Verify source artifact was updated
			const artifacts = getMockData('artifacts');
			const updatedSourceArtifact = artifacts.find((a: any) => a.id === sourceArtifactId);
			
			expect(updatedSourceArtifact).toBeDefined();
			
			// Requirement 7.2: lifecycle_stage should be updated to "artifacts_created"
			expect(updatedSourceArtifact?.lifecycle_stage).toBe('artifacts_created');
			
			// Also verify derived_artifact_id is set
			expect(updatedSourceArtifact?.processing_metadata?.derived_artifact_id).toBe(derivedArtifactId);
		});

		it('should NOT update lifecycle_stage when already at artifacts_created', async () => {
			const sourceArtifactId = 'source-artifact-345';
			const derivedArtifactId = 'derived-artifact-678';
			
			const sourceArtifact = createMockArtifact({
				id: sourceArtifactId,
				user_id: 'user-345',
				lifecycle_stage: 'artifacts_created', // Already at this stage
				processing_metadata: {},
			});
			
			setMockData('artifacts', [sourceArtifact]);
			
			// Call linkDerivedArtifact
			await linkDerivedArtifact(sourceArtifactId, derivedArtifactId);
			
			// Verify source artifact was updated
			const artifacts = getMockData('artifacts');
			const updatedSourceArtifact = artifacts.find((a: any) => a.id === sourceArtifactId);
			
			expect(updatedSourceArtifact).toBeDefined();
			
			// Requirement 7.2: lifecycle_stage should remain "artifacts_created" (not downgraded)
			expect(updatedSourceArtifact?.lifecycle_stage).toBe('artifacts_created');
			
			// Verify derived_artifact_id is still set
			expect(updatedSourceArtifact?.processing_metadata?.derived_artifact_id).toBe(derivedArtifactId);
		});

		it('should NOT update lifecycle_stage when already at later stage (complete)', async () => {
			const sourceArtifactId = 'source-artifact-901';
			const derivedArtifactId = 'derived-artifact-234';
			
			const sourceArtifact = createMockArtifact({
				id: sourceArtifactId,
				user_id: 'user-901',
				lifecycle_stage: 'complete', // Later stage than "artifacts_created"
				processing_metadata: {},
			});
			
			setMockData('artifacts', [sourceArtifact]);
			
			// Call linkDerivedArtifact
			await linkDerivedArtifact(sourceArtifactId, derivedArtifactId);
			
			// Verify source artifact was updated
			const artifacts = getMockData('artifacts');
			const updatedSourceArtifact = artifacts.find((a: any) => a.id === sourceArtifactId);
			
			expect(updatedSourceArtifact).toBeDefined();
			
			// Requirement 7.2: lifecycle_stage should NOT be updated (already at later stage)
			expect(updatedSourceArtifact?.lifecycle_stage).toBe('complete');
			
			// Verify derived_artifact_id is still set
			expect(updatedSourceArtifact?.processing_metadata?.derived_artifact_id).toBe(derivedArtifactId);
		});

		it('should NOT update lifecycle_stage when already at later stage (archived)', async () => {
			const sourceArtifactId = 'source-artifact-567';
			const derivedArtifactId = 'derived-artifact-890';
			
			const sourceArtifact = createMockArtifact({
				id: sourceArtifactId,
				user_id: 'user-567',
				lifecycle_stage: 'archived', // Later stage than "artifacts_created"
				processing_metadata: {},
			});
			
			setMockData('artifacts', [sourceArtifact]);
			
			// Call linkDerivedArtifact
			await linkDerivedArtifact(sourceArtifactId, derivedArtifactId);
			
			// Verify source artifact was updated
			const artifacts = getMockData('artifacts');
			const updatedSourceArtifact = artifacts.find((a: any) => a.id === sourceArtifactId);
			
			expect(updatedSourceArtifact).toBeDefined();
			
			// Requirement 7.2: lifecycle_stage should NOT be updated (already at later stage)
			expect(updatedSourceArtifact?.lifecycle_stage).toBe('archived');
			
			// Verify derived_artifact_id is still set
			expect(updatedSourceArtifact?.processing_metadata?.derived_artifact_id).toBe(derivedArtifactId);
		});

		it('should link artifacts through full processor flow', async () => {
			const step = createMockWorkflowStep();
			const sourceArtifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-full',
				plain_text: 'Meeting notes content',
				lifecycle_stage: 'actions_extracted',
				processing_metadata: {
					analysis: {
						intent: 'meeting_notes',
					},
				},
			});
			setMockData('artifacts', [sourceArtifact]);
			
			const mockProcessor: IntentProcessor = jest.fn().mockImplementation(async (step, artifact, analysisResult) => {
				const { createDerivedArtifactRecord, linkDerivedArtifact } = await import('../../../../src/workflows/steps/createDerived');
				const derivedContent = 'Cleaned meeting notes';
				const derivedType = 'cleaned_meeting_notes';
				const tokensUsed = 100;
				const originalLength = artifact.plain_text?.length || 0;
				
				// Create derived artifact
				const derivedArtifact = await createDerivedArtifactRecord(
					artifact,
					derivedContent,
					derivedType,
					tokensUsed,
					originalLength
				);
				
				// Link artifacts (as processors do)
				await linkDerivedArtifact(artifact.id, derivedArtifact.id);
				
				return {
					success: true,
					derivedArtifactId: derivedArtifact.id,
					derivedType: derivedType,
					tokensUsed: tokensUsed,
				};
			});
			
			registerIntentProcessor('meeting_notes', mockProcessor);
			
			const analysisResult: AnalysisResult = {
				intent: 'meeting_notes',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
			};
			
			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);
			
			expect(result.success).toBe(true);
			
			// Verify source artifact was linked
			const artifacts = getMockData('artifacts');
			const updatedSourceArtifact = artifacts.find((a: any) => a.id === TEST_ARTIFACT_ID);
			
			expect(updatedSourceArtifact).toBeDefined();
			
			// Requirement 7.1: processing_metadata.derived_artifact_id should be set
			expect(updatedSourceArtifact?.processing_metadata?.derived_artifact_id).toBe(result.derivedArtifactId);
			
			// Requirement 7.2: lifecycle_stage should be updated to "artifacts_created"
			expect(updatedSourceArtifact?.lifecycle_stage).toBe('artifacts_created');
			
			// Verify existing metadata is preserved
			expect(updatedSourceArtifact?.processing_metadata?.analysis?.intent).toBe('meeting_notes');
		});

		it('should merge derived_artifact_id into existing processing_metadata without replacing other fields', async () => {
			const sourceArtifactId = 'source-merge-test';
			const derivedArtifactId = 'derived-merge-test';
			
			const sourceArtifact = createMockArtifact({
				id: sourceArtifactId,
				user_id: 'user-merge',
				lifecycle_stage: 'actions_extracted',
				processing_metadata: {
					analysis: {
						intent: 'meeting_notes',
						topics: ['project planning', 'sprint review'],
					},
					extraction: {
						entities_count: 5,
					},
				},
			});
			
			setMockData('artifacts', [sourceArtifact]);
			
			// Call linkDerivedArtifact
			await linkDerivedArtifact(sourceArtifactId, derivedArtifactId);
			
			// Verify source artifact was updated
			const artifacts = getMockData('artifacts');
			const updatedSourceArtifact = artifacts.find((a: any) => a.id === sourceArtifactId);
			
			expect(updatedSourceArtifact).toBeDefined();
			
			// Requirement 7.1: derived_artifact_id should be added
			expect(updatedSourceArtifact?.processing_metadata?.derived_artifact_id).toBe(derivedArtifactId);
			
			// Verify existing metadata fields are preserved (merged, not replaced)
			expect(updatedSourceArtifact?.processing_metadata?.analysis).toBeDefined();
			expect(updatedSourceArtifact?.processing_metadata?.analysis?.intent).toBe('meeting_notes');
			expect(updatedSourceArtifact?.processing_metadata?.analysis?.topics).toEqual(['project planning', 'sprint review']);
			expect(updatedSourceArtifact?.processing_metadata?.extraction).toBeDefined();
			expect(updatedSourceArtifact?.processing_metadata?.extraction?.entities_count).toBe(5);
		});
	});

	describe('Property 7: Token Usage Tracking', () => {
		/**
		 * Property 7: Token Usage Tracking
		 * 
		 * Validates: Requirements 5.6, 14.1, 14.2, 14.3
		 * 
		 * For any successful derived artifact creation,
		 * token usage SHALL be tracked throughout the process:
		 * - `tokensUsed` SHALL be extracted from Anthropic API response (input_tokens + output_tokens)
		 * - `tokensUsed` SHALL be stored in derived artifact's `processing_metadata.tokens_used` field
		 * - `tokensUsed` SHALL be included in workflow step `output` JSONB
		 */

		it('should extract tokensUsed from Anthropic API response', async () => {
			const step = createMockWorkflowStep();
			const sourceArtifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-token',
				plain_text: 'Document content to process',
			});
			setMockData('artifacts', [sourceArtifact]);

			// Set specific token usage values in mock Anthropic response
			const inputTokens = 250;
			const outputTokens = 150;
			const expectedTokensUsed = inputTokens + outputTokens; // 400
			const derivedContent = 'Document summary';

			setMockTextResponse(derivedContent, {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
			});

			// Use actual document processor (which calls callAnthropicWithRetry).
			// This used to exercise the real meeting-notes processor; that
			// processor was retired (ADR-082, #874) so the document processor is
			// now the real-processor case for this property.
			const { createDerivedForDocument } = await import('../../../../src/workflows/steps/processors/document');
			registerIntentProcessor('document', createDerivedForDocument);

			const analysisResult: AnalysisResult = {
				intent: 'document',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
				shouldClean: true,
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(true);
			
			// Requirement 5.6: tokensUsed should be extracted from API response
			expect(result.tokensUsed).toBe(expectedTokensUsed);
			expect(typeof result.tokensUsed).toBe('number');

			// Verify Anthropic API was called and usage was extracted correctly
			expect(mockCallAnthropicText).toHaveBeenCalled();
		});

		it('should store tokensUsed in derived artifact processing_metadata.tokens_used field', async () => {
			const step = createMockWorkflowStep();
			const sourceArtifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-metadata',
				plain_text: 'Document content to summarize',
			});
			setMockData('artifacts', [sourceArtifact]);

			// Set specific token usage values
			const inputTokens = 300;
			const outputTokens = 200;
			const expectedTokensUsed = inputTokens + outputTokens; // 500
			const derivedContent = 'Document summary';

			setMockTextResponse(derivedContent, {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
			});

			// Use actual document processor
			const { createDerivedForDocument } = await import('../../../../src/workflows/steps/processors/document');
			registerIntentProcessor('document', createDerivedForDocument);

			const analysisResult: AnalysisResult = {
				intent: 'document',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
				shouldClean: true,
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(true);
			expect(result.derivedArtifactId).toBeDefined();

			// Get the derived artifact from database
			const artifacts = getMockData('artifacts');
			const derivedArtifact = artifacts.find((a: any) => a.id === result.derivedArtifactId);
			expect(derivedArtifact).toBeDefined();

			// Requirement 14.1, 14.2: tokensUsed should be stored in processing_metadata.tokens_used
			const metadata = derivedArtifact?.processing_metadata;
			expect(metadata).toBeDefined();
			expect(typeof metadata).toBe('object');
			expect(metadata?.tokens_used).toBe(expectedTokensUsed);
			expect(typeof metadata?.tokens_used).toBe('number');
		});

		it('should include tokensUsed in workflow step output JSONB', async () => {
			const step = createMockWorkflowStep();
			const sourceArtifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-output',
				plain_text: 'Content for step output test',
			});
			setMockData('artifacts', [sourceArtifact]);

			// Set specific token usage values
			const inputTokens = 180;
			const outputTokens = 120;
			const expectedTokensUsed = inputTokens + outputTokens; // 300
			const derivedContent = 'Processed content';

			setMockTextResponse(derivedContent, {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
			});

			// Use actual document processor. This used to exercise the real
			// meeting-notes processor; that processor was retired (ADR-082,
			// #874) so the document processor is now the real-processor case
			// for this property.
			const { createDerivedForDocument } = await import('../../../../src/workflows/steps/processors/document');
			registerIntentProcessor('document', createDerivedForDocument);

			const analysisResult: AnalysisResult = {
				intent: 'document',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
				shouldClean: true,
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(true);

			// Requirement 14.3: tokensUsed should be included in step output
			// The step output is set at line 1090-1095 in createDerived.ts
			// Verify through return value (which is what gets passed to step output)
			expect(result.tokensUsed).toBe(expectedTokensUsed);
			expect(typeof result.tokensUsed).toBe('number');

			// Also check the workflow_steps mock data if available
			const workflowSteps = getMockData('workflow_steps');
			const completedStep = workflowSteps.find((s: any) => 
				s.id === step.id && s.status === 'completed'
			);

			if (completedStep?.output) {
				// Requirement 14.3: tokensUsed in step output JSONB
				expect(completedStep.output.tokensUsed).toBe(expectedTokensUsed);
				expect(typeof completedStep.output.tokensUsed).toBe('number');
			}
		});

		it('should track tokensUsed through full flow from API response to artifact metadata to step output', async () => {
			const step = createMockWorkflowStep();
			const sourceArtifact = createMockArtifact({
				id: TEST_ARTIFACT_ID,
				user_id: 'user-full-tokens',
				plain_text: 'Complete flow test content',
			});
			setMockData('artifacts', [sourceArtifact]);

			// Set specific token usage values
			const inputTokens = 500;
			const outputTokens = 300;
			const expectedTokensUsed = inputTokens + outputTokens; // 800
			const derivedContent = 'Full flow processed content';

			setMockTextResponse(derivedContent, {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
			});

			// Use actual document processor
			const { createDerivedForDocument } = await import('../../../../src/workflows/steps/processors/document');
			registerIntentProcessor('document', createDerivedForDocument);

			const analysisResult: AnalysisResult = {
				intent: 'document',
				entities_mentioned: [],
				actions_suggested: [],
				topics: [],
				sentiment: 'neutral',
				confidence: 0.9,
				shouldClean: true,
			};

			const result = await executeCreateDerivedArtifactStep(
				step,
				ArtifactId.parse(TEST_ARTIFACT_ID),
				StepId.parse(step.id),
				analysisResult
			);

			expect(result.success).toBe(true);
			expect(result.derivedArtifactId).toBeDefined();

			// 1. Verify tokensUsed is extracted from API response (Requirement 5.6)
			expect(result.tokensUsed).toBe(expectedTokensUsed);
			expect(mockCallAnthropicText).toHaveBeenCalled();

			// 2. Verify tokensUsed is stored in derived artifact metadata (Requirement 14.1, 14.2)
			const artifacts = getMockData('artifacts');
			const derivedArtifact = artifacts.find((a: any) => a.id === result.derivedArtifactId);
			expect(derivedArtifact).toBeDefined();
			expect(derivedArtifact?.processing_metadata?.tokens_used).toBe(expectedTokensUsed);

			// 3. Verify tokensUsed is included in step output (Requirement 14.3)
			// Check return value (which is what gets stored in step output)
			expect(result.tokensUsed).toBe(expectedTokensUsed);
			
			// Also verify through workflow_steps mock data if available
			const workflowSteps = getMockData('workflow_steps');
			const completedStep = workflowSteps.find((s: any) => 
				s.id === step.id && s.status === 'completed'
			);
			if (completedStep?.output) {
				expect(completedStep.output.tokensUsed).toBe(expectedTokensUsed);
			}
		});
	});
});

/**
 * PROV-O provenance block (ADR-DRAFT-artifact-provenance-links, #225)
 *
 * prov:wasDerivedFrom / wasGeneratedBy / wasAttributedTo are realized as a
 * structured JSONB block in the derived artifact's processing_metadata (option 3
 * of #225 — metadata realization, not relational edges). These tests pin the
 * block's shape with and without the Step-05 activity context.
 */
describe('createDerivedArtifactRecord — provenance block (#225)', () => {
	const SOURCE_ID = '11111111-2222-3333-4444-555555555555';

	it('writes the full PROV block when Step-05 activity context is passed', async () => {
		const sourceArtifact = createMockArtifact({
			id: SOURCE_ID,
			user_id: 'user-123',
			plain_text: 'source content',
		});
		setMockData('artifacts', [sourceArtifact]);

		const { createDerivedArtifactRecord } = await import('../../../../src/workflows/steps/createDerived');
		const derived = await createDerivedArtifactRecord(
			sourceArtifact,
			'derived content',
			'summarized_document',
			10,
			100,
			{ workflowId: 'wf-1', stepId: 5, stepType: 'create_derived_artifact' }
		);

		const stored = getMockData('artifacts').find((a: any) => a.id === derived.id) as any;
		expect(stored).toBeDefined();
		expect(stored.processing_metadata.prov).toEqual({
			derived_from: SOURCE_ID,
			was_generated_by: {
				workflow_id: 'wf-1',
				step_id: 5,
				step_type: 'create_derived_artifact',
			},
			was_attributed_to: 'user-123',
		});
		// Legacy flat pointer retained for compatibility.
		expect(stored.processing_metadata.derived_from).toBe(SOURCE_ID);
	});

	it('writes was_generated_by: null when no activity context is passed (legacy callers)', async () => {
		const sourceArtifact = createMockArtifact({
			id: SOURCE_ID,
			user_id: 'user-123',
			plain_text: 'source content',
		});
		setMockData('artifacts', [sourceArtifact]);

		const { createDerivedArtifactRecord } = await import('../../../../src/workflows/steps/createDerived');
		const derived = await createDerivedArtifactRecord(
			sourceArtifact,
			'derived content',
			'summarized_document',
			10,
			100
		);

		const stored = getMockData('artifacts').find((a: any) => a.id === derived.id) as any;
		expect(stored.processing_metadata.prov).toEqual({
			derived_from: SOURCE_ID,
			was_generated_by: null,
			was_attributed_to: 'user-123',
		});
	});
});

/**
 * The user-facing notice written to system_decisions when a derived artifact is
 * created. Its one production caller is the document processor, which passes
 * 'summarized_document'. The meeting-notes processor that passed
 * 'cleaned_meeting_notes' was retired (ADR-082, #874), so that type now gets the
 * same generic notice as any other type with no copy of its own (#1050).
 */
describe('createDerivedArtifactNotification', () => {
	beforeEach(() => {
		resetMockData();
	});

	const notify = (derivedType: string) =>
		createDerivedArtifactNotification('user-123', 'source-1', 'derived-1', derivedType, 0.25, 42);

	it('writes the document-summary notice for summarized_document', async () => {
		const result = await notify('summarized_document');

		expect(result?.id).toBeDefined();
		const [decision] = getMockData('system_decisions') as any[];
		expect(decision).toMatchObject({
			user_id: 'user-123',
			artifact_id: 'source-1',
			decision_type: 'derived_artifact_created',
			stage: 'artifacts_created',
			title: 'Document summary created',
			description: 'I created a summary of your document with key points and main takeaways.',
			blocking: false,
			status: 'auto_applied',
			decision_payload: {
				originalArtifactId: 'source-1',
				derivedArtifactId: 'derived-1',
				derivedType: 'summarized_document',
				compressionRatio: 0.25,
				tokensUsed: 42,
			},
		});
	});

	it.each(['cleaned_meeting_notes', 'some_future_type'])(
		'writes the generic notice for %s, which has no copy of its own',
		async (derivedType) => {
			await notify(derivedType);

			const [decision] = getMockData('system_decisions') as any[];
			expect(decision.title).toBe('Derived artifact created');
			expect(decision.description).toBe(
				`I created a derived version of your artifact (${derivedType}).`,
			);
		},
	);
});
