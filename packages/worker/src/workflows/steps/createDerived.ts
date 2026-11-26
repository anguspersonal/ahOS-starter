/**
 * Step 5: Create Derived Artifact
 * 
 * Creates AI-generated derived versions of artifacts. Today the only registered
 * processor is `document` (a summary); the `meeting_notes` one was retired by
 * ADR-082 (see the registration note at the bottom of this file).
 *
 * Features:
 * - Intent-based routing to appropriate processors
 * - AI-powered content generation (document summaries)
 * - Derived artifact creation in artifacts table
 * - Linking derived artifacts to source artifacts
 * - User notifications for created artifacts
 * - Non-fatal step execution (workflow continues on failure)
 *
 * @see docs/WorkflowSteps/Step05_CreateDerivedArtifact.md
 */

import { supabase } from '../../utils/supabase';
import logger from '../../utils/logger';
import { captureMessage } from '../../utils/sentry';
import { callAnthropicText } from '../../utils/anthropic';
import { generateUUID } from '../../utils/helpers';
import { retryWithBackoff } from '../../utils/retry';
import { ARTIFACT_SURFACES } from '@ahkms/shared';
import type {
	WorkflowStep,
	AnalysisResult,
} from './types';
import type { ArtifactId, StepId } from './types';
import { createDerivedForDocument } from './processors/document';

/**
 * Artifact record from artifacts table
 * 
 * Minimal interface for artifacts used in derived artifact creation.
 * Contains only the fields needed for this step.
 * 
 * Note: The index signature `[key: string]: unknown` allows access to additional
 * database fields without explicit typing. This is intentional for database flexibility,
 * but means TypeScript won't catch typos in property names. Runtime validation via
 * `isValidArtifact()` ensures required fields are present.
 */
export interface Artifact {
	id: string;
	user_id: string | null;
	[key: string]: unknown; // Allow other fields from database
}

/**
 * Type guard to validate if an object is a valid Artifact
 * 
 * Validates that the object has the required fields (id, user_id) with correct types.
 */
function isValidArtifact(obj: unknown): obj is Artifact {
	if (typeof obj !== 'object' || obj === null) return false;
	const artifact = obj as Record<string, unknown>;
	return (
		'id' in artifact &&
		typeof artifact.id === 'string' &&
		'user_id' in artifact &&
		(artifact.user_id === null || typeof artifact.user_id === 'string')
	);
}

/**
 * Valid intent types for derived artifact creation
 * 
 * Note: 'unclear' intents are intentionally skipped - no derived artifact needed
 * when the AI cannot determine the artifact's intent.
 */
const INTENT_TYPES = [
	'meeting_notes',
	'document',
	'personal_reflection',
	'idea',
	'reminder',
	'reference',
	'task',
	'unclear',
] as const;

export type IntentType = typeof INTENT_TYPES[number];

/**
 * User preferences structure for derived artifact creation
 */
export interface UserPreferences {
	capture_preferences?: {
		create_derived_artifacts?: boolean;
		[key: string]: unknown; // Allow other preference fields
	};
	[key: string]: unknown; // Allow other user preference fields
}

/**
 * Capture options structure for per-capture overrides
 */
export interface CaptureOptions {
	create_derived_artifacts?: boolean;
	[key: string]: unknown; // Allow other capture option fields
}

/**
 * Result of create derived artifact step execution
 */
export interface CreateDerivedResult {
	success: boolean;
	derivedArtifactId?: string;      // UUID of created derived artifact (if successful)
	derivedType?: string;             // Type of derived artifact (e.g., "summarized_document")
	tokensUsed?: number;              // Anthropic API tokens consumed
	notificationId?: string;          // ID of user notification (if created)
	error?: string;                   // Error message (if failed)
	errorDetails?: string;             // Detailed error info (if failed)
}

/**
 * Intent processor function signature
 * 
 * Each processor handles the full lifecycle of creating a derived artifact for a specific intent type.
 */
export type IntentProcessor = (
	step: WorkflowStep,
	artifact: Artifact,
	analysisResult: AnalysisResult
) => Promise<CreateDerivedResult>;

/**
 * Mapping of intent types to their processor functions
 * 
 * Processors will be registered in tasks 9-10.
 * Uses Map for better encapsulation and protection against accidental modification.
 * @see docs/create-derived-artifact/tasks.md
 */
const INTENT_PROCESSORS = new Map<IntentType, IntentProcessor>();

/**
 * Register an intent processor function
 * 
 * Provides type-safe registration of intent processors.
 * Logs a warning if overwriting an existing processor.
 * 
 * @param intent - The intent type (e.g., "meeting_notes", "document")
 * @param processor - The processor function to handle this intent
 */
export function registerIntentProcessor(
	intent: IntentType,
	processor: IntentProcessor
): void {
	if (INTENT_PROCESSORS.has(intent)) {
		logger.warn(`Overwriting existing processor for intent: ${intent}`);
	}
	INTENT_PROCESSORS.set(intent, processor);
}

/**
 * Clear all registered intent processors
 * 
 * Primarily used for testing to reset processor state between tests.
 * Should not be used in production code.
 */
export function clearIntentProcessors(): void {
	INTENT_PROCESSORS.clear();
}

/**
 * Failure tracking for step status updates
 * 
 * Tracks consecutive failures per step ID to detect database connectivity issues.
 * 
 * **IMPORTANT LIMITATIONS:**
 * - This is module-level mutable state that tracks failures per-process only.
 * - In a multi-worker environment, each process maintains its own failure counts.
 * - State is NOT shared across workers, so failure detection is per-worker, not global.
 * - State is cleared between test runs via test setup/teardown.
 * 
 * **FUTURE IMPROVEMENT:**
 * For production multi-worker deployments, consider moving failure tracking to the database
 * (e.g., a `workflow_step_failures` table) to enable cross-worker failure detection.
 */
const stepFailureCounts = new Map<number, number>();
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Update workflow step status
 * 
 * Note: Errors are logged but not thrown to allow workflow execution to continue.
 * This is intentional for non-fatal steps, but repeated failures are tracked and
 * logged as warnings to detect database connectivity issues or schema problems.
 */
async function updateStepStatus(
	stepId: StepId,
	status: WorkflowStep['status'],
	updates: Partial<WorkflowStep>
): Promise<void> {
	try {
		const { error } = await supabase
			.from('workflow_steps')
			.update({
				status,
				...updates,
			})
			.eq('id', stepId.value);

		if (error) {
			const currentFailures = (stepFailureCounts.get(stepId.value) || 0) + 1;
			stepFailureCounts.set(stepId.value, currentFailures);
			
			logger.error('Failed to update step status', { 
				stepId: stepId.value, 
				status, 
				error,
				updates,
				consecutiveFailures: currentFailures,
			});

			// Alert if repeated failures detected
			if (currentFailures >= MAX_CONSECUTIVE_FAILURES) {
				logger.error('Repeated step status update failures - possible database issue', {
					stepId,
					consecutiveFailures: currentFailures,
					lastError: error,
				});
				captureMessage('Repeated workflow step status update failures - possible database issue', 'error', {
					tags: { step: 'createDerived', failureType: 'step_status_update' },
					extra: {
						stepId: stepId.value,
						status,
						consecutiveFailures: currentFailures,
						lastError: error.message,
					},
				});
			}
		} else {
			// Reset failure counter on success
			stepFailureCounts.delete(stepId.value);
		}
	} catch (err) {
		const currentFailures = (stepFailureCounts.get(stepId.value) || 0) + 1;
		stepFailureCounts.set(stepId.value, currentFailures);
		
		logger.error('Error updating step status', { 
			stepId, 
			status, 
			err,
			updates,
			consecutiveFailures: currentFailures,
		});

		// Alert if repeated failures detected
		if (currentFailures >= MAX_CONSECUTIVE_FAILURES) {
			logger.error('Repeated step status update failures - possible database issue', {
				stepId,
				consecutiveFailures: currentFailures,
				lastError: err,
			});
			captureMessage('Repeated workflow step status update failures - possible database issue', 'error', {
				tags: { step: 'createDerived', failureType: 'step_status_update' },
				extra: {
					stepId: stepId.value,
					status,
					consecutiveFailures: currentFailures,
					lastError: err instanceof Error ? err.message : String(err),
				},
			});
		}
	}
}

/**
 * Type guard for objects with optional create_derived_artifacts boolean flag
 * 
 * Validates that the object has the correct structure with create_derived_artifacts
 * as either undefined or a boolean value.
 * Used for both capture preferences and capture options.
 */
function hasCreateDerivedArtifactsFlag(obj: unknown): obj is { create_derived_artifacts?: boolean } {
	if (typeof obj !== 'object' || obj === null) return false;
	const prefs = obj as Record<string, unknown>;
	return 'create_derived_artifacts' in prefs
		? typeof prefs.create_derived_artifacts === 'boolean'
		: true; // undefined is valid
}

/**
 * Check user preference for derived artifact creation
 * 
 * Checks per-capture override first (takes precedence), then global preference.
 * Defaults to true if no preference is set.
 * 
 * @param userPreferences - Optional user preferences object
 * @param captureOptions - Optional capture options object with per-capture override
 * @returns Boolean indicating whether derived artifact creation should proceed
 */
async function checkDerivedArtifactPreference(
	userId: string,
	userPreferences?: UserPreferences,
	captureOptions?: CaptureOptions
): Promise<boolean> {
	// Check per-capture override first (takes precedence)
	if (captureOptions && hasCreateDerivedArtifactsFlag(captureOptions)) {
		if (captureOptions.create_derived_artifacts !== undefined) {
			return captureOptions.create_derived_artifacts === true;
		}
	}

	// If userPreferences provided, use it (no need to fetch from database)
	if (userPreferences) {
		const capturePrefs = userPreferences.capture_preferences;
		if (hasCreateDerivedArtifactsFlag(capturePrefs)) {
			if (capturePrefs.create_derived_artifacts !== undefined) {
				return capturePrefs.create_derived_artifacts === true;
			}
		}
	}

	// Only fetch from database if preferences not provided
	try {
		const { data, error } = await supabase
			.from('user_preferences')
			.select('capture_preferences')
			.eq('user_id', userId)
			.single();

		if (!error && data) {
			const capturePrefs = data.capture_preferences;
			if (hasCreateDerivedArtifactsFlag(capturePrefs)) {
				if (capturePrefs.create_derived_artifacts !== undefined) {
					return capturePrefs.create_derived_artifacts === true;
				}
			}
		}
	} catch (err) {
		logger.warn('Failed to fetch user preferences, defaulting to true', {
			userId,
			error: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
		});
	}

	// Default to true if no preference is set
	return true;
}

/**
 * Set of valid intent types for O(1) lookup performance
 * Derived from INTENT_TYPES to ensure consistency
 */
const VALID_INTENTS = new Set<IntentType>(INTENT_TYPES);

/**
 * Type guard to validate if a string is a valid IntentType
 * 
 * Uses Set for O(1) lookup performance instead of array.includes() O(n).
 * 
 * Note: Type assertion is necessary because Set.has() expects the exact type,
 * but we're checking if a runtime string value matches a known IntentType.
 */
function isValidIntentType(intent: string): intent is IntentType {
	return VALID_INTENTS.has(intent as IntentType);
}

/**
 * Sleep helper for retry delays
 * 
 * @param ms - Milliseconds to sleep
 * @returns Promise that resolves after the delay
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call Anthropic API with retry logic and empty content handling
 * 
 * Implements retry logic with exponential backoff (2s, 4s, 8s) for up to 3 attempts.
 * Treats empty content responses as failures and retries them.
 * 
 * @param prompt - The text prompt to send to Anthropic API
 * @returns Promise with derivedContent and tokensUsed
 * @throws Error if all retries fail or all retries return empty content
 */
export async function callAnthropicWithRetry(
	prompt: string
): Promise<{ derivedContent: string; tokensUsed: number }> {
	const MAX_RETRY_ATTEMPTS = 3;
	const RETRY_DELAYS = [2000, 4000, 8000]; // Exponential backoff: 2s, 4s, 8s

	/**
	 * Anthropic API usage information
	 */
	interface AnthropicUsage {
		input_tokens: number;
		output_tokens: number;
	}

	let lastError: Error | null = null;
	let attempt = 0;
	let aiResponse: { content: string; usage: AnthropicUsage } | null = null;

	while (attempt < MAX_RETRY_ATTEMPTS) {
		attempt++;

		try {
			logger.info(`Calling Anthropic API for derived content (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`, {
				promptLength: prompt.length,
			});

			aiResponse = await callAnthropicText(prompt, 4096);

			// Check if content is empty after trimming
			const derivedContent = aiResponse.content.trim();
			if (derivedContent.length === 0) {
				// Treat empty content as failure and retry
				logger.warn(`Anthropic API returned empty content (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`, {
					attempt,
				});

				// Wait before retry (if not last attempt)
				if (attempt < MAX_RETRY_ATTEMPTS) {
					const delay = RETRY_DELAYS[attempt - 1];
					logger.info(`Retrying in ${delay}ms due to empty content...`);
					await sleep(delay);
					continue; // Retry
				} else {
					// All retries returned empty content
					throw new Error('AI returned empty content');
				}
			}

			// Success - extract tokens used
			const tokensUsed = aiResponse.usage.input_tokens + aiResponse.usage.output_tokens;

			logger.info('Anthropic API call successful for derived content', {
				attempt,
				tokensUsed,
				contentLength: derivedContent.length,
			});

			return {
				derivedContent,
				tokensUsed,
			};
		} catch (error: unknown) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// If this is the "AI returned empty content" error from our check above, re-throw it
			if (lastError.message === 'AI returned empty content') {
				throw lastError;
			}

			logger.warn(`Anthropic API call failed (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`, {
				error: lastError.message,
				attempt,
			});

			// Wait before retry (if not last attempt)
			if (attempt < MAX_RETRY_ATTEMPTS) {
				const delay = RETRY_DELAYS[attempt - 1];
				logger.info(`Retrying in ${delay}ms...`);
				await sleep(delay);
			}
		}
	}

	// Check if all retries failed
	if (!aiResponse) {
		const errorMessage = lastError?.message || 'Unknown error';
		logger.error('Anthropic API call failed after all retries', {
			error: errorMessage,
		});
		throw new Error(`AI call failed: ${errorMessage}`);
	}

	// This should never be reached, but TypeScript needs it
	throw new Error('Unexpected error in callAnthropicWithRetry');
}

/**
 * Lifecycle stage progression order
 * 
 * Used to determine if an artifact is already at a later stage than "artifacts_created".
 * Stages later than "artifacts_created" are: "complete", "archived"
 */
const LIFECYCLE_STAGE_ORDER: Record<string, number> = {
	'uploaded': 0,
	'upload_failed': 0,
	'processing': 1,
	'analysed': 2,
	'analysis_failed': 2,
	'needs_review': 2,
	'entities_extracted': 3,
	'actions_extracted': 4,
	'artifacts_created': 5,
	'complete': 6,
	'archived': 7,
	'blocked': 0,
	'failed': 0,
};

/**
 * Check if a lifecycle stage is at or later than "artifacts_created"
 * 
 * @param stage - The lifecycle stage to check
 * @returns True if stage is at or later than "artifacts_created", false otherwise
 */
function isAtOrLaterThanArtifactsCreated(stage: string | null | undefined): boolean {
	if (!stage || typeof stage !== 'string') {
		return false;
	}
	
	const stageOrder = LIFECYCLE_STAGE_ORDER[stage] ?? -1;
	const artifactsCreatedOrder = LIFECYCLE_STAGE_ORDER['artifacts_created'] ?? 5;
	
	return stageOrder >= artifactsCreatedOrder;
}

/**
 * Link derived artifact to source artifact
 * 
 * Updates source artifact's processing_metadata to include derived_artifact_id
 * and updates lifecycle_stage to "artifacts_created" (if not already at a later stage).
 * 
 * This function is non-fatal: errors are logged as warnings but don't throw,
 * allowing the workflow to continue even if linking fails.
 * 
 * @param sourceArtifactId - UUID of the source artifact
 * @param derivedArtifactId - UUID of the derived artifact
 */
export async function linkDerivedArtifact(
	sourceArtifactId: string,
	derivedArtifactId: string
): Promise<void> {
	try {
		// 1. Fetch source artifact to get current state
		const { data: sourceArtifact, error: fetchError } = await supabase
			.from('artifacts')
			.select('lifecycle_stage, processing_metadata')
			.eq('id', sourceArtifactId)
			.single();
		
		if (fetchError || !sourceArtifact) {
			logger.warn('Failed to fetch source artifact for linking', {
				sourceArtifactId,
				derivedArtifactId,
				error: fetchError?.message || 'Artifact not found',
			});
			return; // Non-fatal: don't throw
		}
		
		// 2. Prepare processing_metadata update (merge derived_artifact_id)
		const existingProcessingMetadata = sourceArtifact.processing_metadata 
			? (typeof sourceArtifact.processing_metadata === 'object' 
				? sourceArtifact.processing_metadata as Record<string, unknown>
				: {})
			: {};
		
		const updatedProcessingMetadata = {
			...existingProcessingMetadata,
			derived_artifact_id: derivedArtifactId,
		};
		
		// 3. Determine lifecycle_stage update
		// Only update to "artifacts_created" if not already at a later stage
		const currentLifecycleStage = typeof sourceArtifact.lifecycle_stage === 'string' 
			? sourceArtifact.lifecycle_stage 
			: null;
		
		const shouldUpdateLifecycleStage = !isAtOrLaterThanArtifactsCreated(currentLifecycleStage);
		
		// 4. Build update object
		const updateData: Record<string, unknown> = {
			processing_metadata: updatedProcessingMetadata,
		};
		
		if (shouldUpdateLifecycleStage) {
			updateData.lifecycle_stage = 'artifacts_created';
		}
		
		// 5. Update source artifact
		const { error: updateError } = await supabase
			.from('artifacts')
			.update(updateData)
			.eq('id', sourceArtifactId);
		
		if (updateError) {
			logger.warn('Failed to link derived artifact to source artifact', {
				sourceArtifactId,
				derivedArtifactId,
				error: updateError.message,
			});
			return; // Non-fatal: don't throw
		}
		
		logger.info('Linked derived artifact to source artifact', {
			sourceArtifactId,
			derivedArtifactId,
			lifecycleStageUpdated: shouldUpdateLifecycleStage,
			currentLifecycleStage: currentLifecycleStage,
		});
	} catch (err) {
		// Catch any unexpected errors and log as warning (non-fatal)
		logger.warn('Unexpected error linking derived artifact to source artifact', {
			sourceArtifactId,
			derivedArtifactId,
			error: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
		});
		// Don't throw - non-fatal error
	}
}

/**
 * Create notification for derived artifact creation
 * 
 * Creates a user notification in the system_decisions table to inform the user
 * that a derived artifact has been created. The notification is non-blocking and
 * auto-applied, serving as an informational update.
 * 
 * This function is non-fatal: errors are logged as warnings but don't throw,
 * allowing the workflow to continue even if notification creation fails.
 * 
 * @param userId - UUID of the user who owns the artifact
 * @param artifactId - UUID of the source artifact
 * @param derivedArtifactId - UUID of the created derived artifact
 * @param derivedType - Type of derived artifact (e.g., "summarized_document")
 * @param compressionRatio - Compression ratio (derived_length / original_length)
 * @param tokensUsed - Number of tokens consumed by the AI API call
 * @returns The created notification record, or null if creation failed
 */
export async function createDerivedArtifactNotification(
	userId: string,
	artifactId: string,
	derivedArtifactId: string,
	derivedType: string,
	compressionRatio: number,
	tokensUsed: number
): Promise<{ id: string } | null> {
	try {
		// Determine notification title and description based on derivedType.
		// 'summarized_document' is the only type a registered processor produces;
		// 'cleaned_meeting_notes' lost its producer in ADR-082 (#874) and now takes
		// the generic notice like any other type.
		let title: string;
		let description: string;

		if (derivedType === 'summarized_document') {
			title = 'Document summary created';
			description = 'I created a summary of your document with key points and main takeaways.';
		} else {
			// Fallback for unknown derived types
			title = 'Derived artifact created';
			description = `I created a derived version of your artifact (${derivedType}).`;
		}

		// Build decision_payload JSONB
		const decisionPayload = {
			originalArtifactId: artifactId,
			derivedArtifactId: derivedArtifactId,
			derivedType: derivedType,
			compressionRatio: compressionRatio,
			tokensUsed: tokensUsed,
		};

		// Insert notification into system_decisions table
		const { data, error } = await supabase
			.from('system_decisions')
			.insert({
				user_id: userId,
				artifact_id: artifactId,
				decision_type: 'derived_artifact_created',
				stage: 'artifacts_created',
				title: title,
				description: description,
				confidence_score: 100,
				blocking: false,
				status: 'auto_applied',
				review_type: 'suggestion',
				decision_payload: decisionPayload,
			})
			.select('id')
			.single();

		if (error) {
			logger.warn('Failed to create derived artifact notification', {
				userId,
				artifactId,
				derivedArtifactId,
				derivedType,
				error: error.message,
			});
			return null; // Non-fatal: don't throw
		}

		if (!data) {
			logger.warn('Derived artifact notification created but no data returned', {
				userId,
				artifactId,
				derivedArtifactId,
			});
			return null; // Non-fatal: don't throw
		}

		logger.info('Created derived artifact notification', {
			notificationId: data.id,
			userId,
			artifactId,
			derivedArtifactId,
			derivedType,
		});

		return data;
	} catch (err) {
		// Catch any unexpected errors and log as warning (non-fatal)
		logger.warn('Unexpected error creating derived artifact notification', {
			userId,
			artifactId,
			derivedArtifactId,
			derivedType,
			error: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
		});
		// Don't throw - non-fatal error
		return null;
	}
}

/**
 * Helper: Extract text from content JSONB object
 * 
 * @param content - The content field (JSONB object)
 * @returns Text content if available, null otherwise
 */
function getTextFromContent(content: unknown): string | null {
	if (typeof content !== 'object' || content === null) {
		return null;
	}
	const contentObj = content as Record<string, unknown>;
	if ('text' in contentObj && contentObj.text !== undefined && contentObj.text !== null) {
		const text = String(contentObj.text).trim();
		return text.length > 0 ? text : null;
	}
	return null;
}

/**
 * Helper: Extract text from processing_metadata.analysis.extracted_text
 * 
 * @param processingMetadata - The processing_metadata field (JSONB object)
 * @returns Extracted text if available, null otherwise
 */
function getExtractedTextFromMetadata(processingMetadata: unknown): string | null {
	if (typeof processingMetadata !== 'object' || processingMetadata === null) {
		return null;
	}
	const metadata = processingMetadata as Record<string, unknown>;
	if ('analysis' in metadata && metadata.analysis !== undefined && metadata.analysis !== null) {
		if (typeof metadata.analysis === 'object') {
			const analysis = metadata.analysis as Record<string, unknown>;
			if ('extracted_text' in analysis && analysis.extracted_text !== undefined && analysis.extracted_text !== null) {
				const extractedText = String(analysis.extracted_text).trim();
				return extractedText.length > 0 ? extractedText : null;
			}
		}
	}
	return null;
}

/**
 * Extract content from artifact for processing
 * 
 * Implements priority order for content extraction:
 * 1. `artifact.plain_text` (if non-empty)
 * 2. `artifact.content.text` (if `content_type === "text"` and `content` is JSONB with `text` field)
 * 3. `artifact.processing_metadata.analysis.extracted_text`
 * 
 * Returns null if no processable content is available or if content is empty after trimming.
 * 
 * @param artifact - The artifact record from database
 * @returns Extracted text content or null if no processable content available
 */
export function extractContentForProcessing(artifact: Artifact): string | null {
	// Priority 1: Check plain_text (if non-empty)
	if (artifact.plain_text !== undefined && artifact.plain_text !== null) {
		const plainText = String(artifact.plain_text).trim();
		if (plainText.length > 0) {
			return plainText;
		}
	}

	// Priority 2: Check content.text (if content_type === "text" and content is JSONB with text field)
	if (artifact.content_type === 'text' && artifact.content !== undefined && artifact.content !== null) {
		const contentText = getTextFromContent(artifact.content);
		if (contentText) {
			return contentText;
		}
	}

	// Priority 3: Check processing_metadata.analysis.extracted_text
	if (artifact.processing_metadata !== undefined && artifact.processing_metadata !== null) {
		const extractedText = getExtractedTextFromMetadata(artifact.processing_metadata);
		if (extractedText) {
			return extractedText;
		}
	}

	// No processable content available
	return null;
}

/**
 * Create derived artifact record in artifacts table
 * 
 * Creates a new artifact record for derived content. The derived artifact is stored
 * in the `artifacts` table (not `derived_artifacts`) to ensure it has full artifact
 * capabilities including editability.
 * 
 * @param sourceArtifact - The source artifact from which the derived artifact is created
 * @param derivedContent - The AI-generated derived content (e.g. a document summary)
 * @param derivedType - Type of derived artifact (e.g., "summarized_document")
 * @param tokensUsed - Number of tokens consumed by the AI API call
 * @param originalLength - Length of the original content that was processed
 * @returns The created artifact record
 * @throws Error with message "Failed to create derived artifact" if database insert fails
 */
export async function createDerivedArtifactRecord(
	sourceArtifact: Artifact,
	derivedContent: string,
	derivedType: string,
	tokensUsed: number,
	originalLength: number,
	// Step-05 activity context for the PROV-O provenance block (#225). Optional so
	// existing callers/tests keep working; absent => was_generated_by is null.
	provenance?: { workflowId?: string; stepId?: number; stepType?: string }
): Promise<Artifact> {
	// Generate UUID for derived artifact ID
	const derivedArtifactId = generateUUID();
	
	// Format filename: "{source_artifact.filename} ({derivedType.replace("_", " ")})"
	const sourceFilename = typeof sourceArtifact.filename === 'string' 
		? sourceArtifact.filename 
		: 'Untitled';
	const derivedTypeDisplay = derivedType.replace(/_/g, ' ');
	const filename = `${sourceFilename} (${derivedTypeDisplay})`;
	
	// Calculate compression ratio
	const derivedLength = derivedContent.length;
	const compressionRatio = originalLength > 0 
		? derivedLength / originalLength 
		: 0;
	
	// Get user_id and team_id from source artifact
	const userId = typeof sourceArtifact.user_id === 'string' 
		? sourceArtifact.user_id 
		: null;
	const teamId = sourceArtifact.team_id !== undefined && sourceArtifact.team_id !== null
		? sourceArtifact.team_id
		: null;
	
	// Build storage_path placeholder (required by database, but derived artifacts are inline)
	const storagePath = `derived/${derivedArtifactId}.md`;
	
	// Build storage_url (required by database, but derived artifacts are inline)
	const storageUrl = ''; // Empty string for inline content
	
	// Get current timestamp
	const now = new Date().toISOString();
	
	// Build processing_metadata (merge into existing object structure)
	const existingProcessingMetadata = sourceArtifact.processing_metadata 
		? (typeof sourceArtifact.processing_metadata === 'object' 
			? sourceArtifact.processing_metadata as Record<string, unknown>
			: {})
		: {};
	
	const processingMetadata = {
		...existingProcessingMetadata,
		derived_from: sourceArtifact.id,
		derived_type: derivedType,
		derived_at: now,
		tokens_used: tokensUsed,
		original_length: originalLength,
		derived_length: derivedLength,
		compression_ratio: compressionRatio,
		// PROV-O realization (ADR-DRAFT-artifact-provenance-links, #225):
		// prov:wasDerivedFrom / wasGeneratedBy / wasAttributedTo are realized as this
		// JSONB block rather than relational edges — entity_relationships FKs entities,
		// and artifacts are not entities. The flat derived_from/derived_at keys above
		// stay for compatibility. Keys are exactly PROV_CONTEXT's EDGE_TYPES keys
		// (mcp-server vocab.ts). Escape hatch to a real edge table is in the ADR.
		prov: {
			derived_from: sourceArtifact.id,
			was_generated_by: provenance
				? {
					workflow_id: provenance.workflowId ?? null,
					step_id: provenance.stepId ?? null,
					step_type: provenance.stepType ?? null,
				}
				: null,
			was_attributed_to: userId,
		},
	};
	
	// Build artifact data object
	const artifactData: Record<string, unknown> = {
		id: derivedArtifactId,
		user_id: userId,
		team_id: teamId,
		storage_path: storagePath,
		storage_url: storageUrl,
		filename: filename,
		content_type: 'text',
		content_subtype: 'derived',
		file_extension: 'md',
		plain_text: derivedContent,
		content: null, // or empty JSONB {} - using null as specified
		lifecycle_stage: 'complete',
		processing_status: 'completed',
		processing_metadata: processingMetadata,
		tags: ['derived', derivedType],
		// Required fields from database schema
		storage_bucket: 'inputs', // Default bucket
		captured_at: now,
		captured_by: userId,
		source: 'derived',
		source_channel: 'derived',
		// Provenance (ADR-026; ADR-046 §2/§3, #584). A field-copy of source_channel,
		// exactly as the discover path does it — NOT the source artifact's surface,
		// though that was available here. See ARTIFACT_SURFACES.derived for why
		// inheriting would cost more than it buys.
		surface: ARTIFACT_SURFACES.derived,
		processed: true,
	};
	
	// Insert into database with error handling
	try {
		const { data: insertedData, error: insertError } = await supabase
			.from('artifacts')
			.insert(artifactData)
			.select('*')
			.single();
		
		if (insertError) {
			logger.error('Failed to create derived artifact', {
				derivedArtifactId,
				sourceArtifactId: sourceArtifact.id,
				derivedType,
				error: insertError.message,
			});
			throw new Error('Failed to create derived artifact');
		}
		
		if (!insertedData) {
			logger.error('Derived artifact created but no data returned', {
				derivedArtifactId,
				sourceArtifactId: sourceArtifact.id,
			});
			throw new Error('Failed to create derived artifact');
		}
		
		logger.info('Derived artifact created successfully', {
			derivedArtifactId,
			sourceArtifactId: sourceArtifact.id,
			derivedType,
			tokensUsed,
			compressionRatio,
		});
		
		// Return the created artifact record
		return insertedData as Artifact;
	} catch (error) {
		// Re-throw if it's already our error message
		if (error instanceof Error && error.message === 'Failed to create derived artifact') {
			throw error;
		}
		
		// Wrap other errors
		logger.error('Unexpected error creating derived artifact', {
			derivedArtifactId,
			sourceArtifactId: sourceArtifact.id,
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
		throw new Error('Failed to create derived artifact');
	}
}

/**
 * Route to the appropriate intent processor based on intent and analysis result
 * 
 * @param intent - The intent from analysis result (e.g., "meeting_notes", "document")
 * @param analysisResult - The full analysis result containing intent and conditional flags
 * @returns The processor function if found and conditions are met, null otherwise
 */
export function routeToIntentProcessor(
	intent: string,
	analysisResult: AnalysisResult
): IntentProcessor | null {
	// Validate intent format
	if (!intent || typeof intent !== 'string' || intent.trim() === '') {
		logger.warn('Invalid intent provided', { intent, analysisResult });
		return null;
	}

	// Trim whitespace and validate intent is a known IntentType
	const trimmedIntent = intent.trim();
	if (!isValidIntentType(trimmedIntent)) {
		logger.warn('Invalid intent type', { intent: trimmedIntent, analysisResult });
		return null;
	}

	// For documents, only process if shouldClean is true or undefined (default to true)
	// If shouldClean is explicitly false, skip processing
	if (trimmedIntent === 'document') {
		if (analysisResult.shouldClean === false) {
			return null; // Explicitly disabled
		}
		// If shouldClean is true or undefined, proceed with processing
	}

	// Look up processor in INTENT_PROCESSORS mapping
	const processor = INTENT_PROCESSORS.get(trimmedIntent);

	// Return processor function or null if not found
	return processor || null;
}

/**
 * Execute the create derived artifact step
 * 
 * @param step - The workflow step record to update with progress
 * @param artifactId - UUID of the source artifact
 * @param analysisResult - The analysis result from the analyze step
 * @param userPreferences - Optional user preferences object with capture_preferences.create_derived_artifacts flag
 * @param captureOptions - Optional capture options object with create_derived_artifacts flag (takes precedence over userPreferences)
 * @returns CreateDerivedResult indicating success or failure
 */
export async function executeCreateDerivedArtifactStep(
	step: WorkflowStep,
	artifactId: ArtifactId,
	stepId: StepId,
	analysisResult: AnalysisResult,
	userPreferences?: UserPreferences,
	captureOptions?: CaptureOptions
): Promise<CreateDerivedResult> {
	logger.info('Starting create derived artifact step', {
		stepId: stepId.value,
		artifactId: artifactId.value,
		intent: analysisResult.intent,
	});

	// Update step status to 'running' with started_at timestamp
	await updateStepStatus(stepId, 'running', {
		started_at: new Date().toISOString(),
		message: 'Creating derived artifact...',
	});

	try {
		// 1. Fetch artifact to get user_id for preference checking
		const { data: artifact, error: artifactError } = await supabase
			.from('artifacts')
			.select('*')
			.eq('id', artifactId.value)
			.single();

		if (artifactError || !artifact) {
			logger.error('Artifact not found', { artifactId: artifactId.value, error: artifactError?.message });
			await updateStepStatus(stepId, 'failed', {
				message: 'Artifact not found',
				error_message: artifactError?.message || 'Artifact not found',
				completed_at: new Date().toISOString(),
			});

			return {
				success: false,
				error: 'Artifact not found',
			};
		}

		// Type narrow user_id with proper validation
		const userId = typeof artifact.user_id === 'string' ? artifact.user_id : null;
		if (!userId) {
			logger.error('Artifact missing user_id', { artifactId: artifactId.value });
			await updateStepStatus(stepId, 'failed', {
				message: 'Artifact missing user_id',
				error_message: 'Artifact missing user_id',
				completed_at: new Date().toISOString(),
			});

			return {
				success: false,
				error: 'Artifact missing user_id',
			};
		}

		// 2. Check user preferences (global and per-capture)
		const shouldCreate = await checkDerivedArtifactPreference(userId, userPreferences, captureOptions);
		if (!shouldCreate) {
			logger.info('Skipping derived artifact creation - user preference disabled', { artifactId: artifactId.value, userId });
			await updateStepStatus(stepId, 'skipped', {
				message: 'Skipped - user preference disabled',
				completed_at: new Date().toISOString(),
			});

			return {
				success: false,
				error: 'Skipped - user preference disabled',
			};
		}

		// 3. Route to intent processor
		const processor = routeToIntentProcessor(analysisResult.intent, analysisResult);
		if (!processor) {
			logger.info('No processor found for intent', { artifactId, intent: analysisResult.intent });
			await updateStepStatus(stepId, 'skipped', {
				message: 'Skipped - intent doesn\'t require derived artifact',
				completed_at: new Date().toISOString(),
			});

			return {
				success: false,
				error: 'Skipped - intent doesn\'t require derived artifact',
			};
		}

		// 4. Validate artifact structure before processing
		if (!isValidArtifact(artifact)) {
			logger.error('Invalid artifact structure from database', { artifactId: artifactId.value });
			await updateStepStatus(stepId, 'failed', {
				message: 'Invalid artifact structure',
				error_message: 'Invalid artifact structure from database',
				completed_at: new Date().toISOString(),
			});

			return {
				success: false,
				error: 'Invalid artifact structure',
			};
		}

		// 4.5. Check content length for token limits (Phase 1 behavior)
		// Extract content to check length before processing
		const contentToCheck = extractContentForProcessing(artifact);
		if (contentToCheck) {
			// Conservative estimate: 1 token ≈ 4 characters
			// Limit to ~100,000 characters (roughly 25,000 tokens) to leave room for prompt
			// This is a Phase 1 check - in future phases, we may implement chunking
			// Can be overridden via MAX_DERIVED_CONTENT_LENGTH environment variable
			const MAX_CONTENT_LENGTH = process.env.MAX_DERIVED_CONTENT_LENGTH
				? parseInt(process.env.MAX_DERIVED_CONTENT_LENGTH, 10)
				: 100000;
			if (contentToCheck.length > MAX_CONTENT_LENGTH) {
				logger.warn('Content too long for processing', {
					stepId: stepId.value,
					artifactId: artifactId.value,
					contentLength: contentToCheck.length,
					maxLength: MAX_CONTENT_LENGTH,
				});
				await updateStepStatus(stepId, 'failed', {
					message: 'Content too long',
					error_message: 'Content too long',
					completed_at: new Date().toISOString(),
				});

				return {
					success: false,
					error: 'Content too long',
				};
			}
		}

		// 5. Call processor function
		// Note: Processors will be implemented in later tasks (tasks 9, 10)
		// For now, this will fail gracefully when processors are not yet registered
		let result: CreateDerivedResult;
		try {
			// Runtime validation via isValidArtifact ensures artifact type safety
			result = await processor(step, artifact, analysisResult);
		} catch (processorError) {
			logger.error('Processor execution failed', {
				stepId: step.id,
				artifactId,
				intent: analysisResult.intent,
				error: processorError instanceof Error ? processorError.message : String(processorError),
				stack: processorError instanceof Error ? processorError.stack : undefined,
			});
			// Re-throw to be caught by outer handler
			throw processorError;
		}

		// 6. Handle processor result
		if (result.success) {
			// Update step status to 'completed' with output
			await updateStepStatus(stepId, 'completed', {
				message: `Created derived artifact: ${result.derivedType || 'unknown'}`,
				completed_at: new Date().toISOString(),
				output: {
					derivedArtifactId: result.derivedArtifactId,
					derivedType: result.derivedType,
					tokensUsed: result.tokensUsed,
					notificationId: result.notificationId,
				},
			});

			return result;
		} else {
			// Processor failed - update step status to 'failed'
			await updateStepStatus(stepId, 'failed', {
				message: 'Failed to create derived artifact',
				error_message: result.error || 'Unknown error',
				completed_at: new Date().toISOString(),
			});

			return result;
		}
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		const errorStack = error instanceof Error ? error.stack : undefined;

		logger.error('Error in create derived artifact step', {
			stepId: stepId.value,
			artifactId: artifactId.value,
			error: errorMessage,
			stack: errorStack,
		});

		// Update step status to 'failed' with error message
		await updateStepStatus(stepId, 'failed', {
			message: 'Failed to create derived artifact',
			error_message: errorMessage,
			completed_at: new Date().toISOString(),
		});

		return {
			success: false,
			error: errorMessage,
			errorDetails: errorStack,
		};
	}
}

// Register intent processors at module load time
//
// `meeting_notes` deliberately has no processor here (ADR-082, #874): it used
// to register `createDerivedForMeetingNotes`, which LLM-rewrote a note into a
// `cleaned_meeting_notes` derived artifact at capture time — interpretation
// ADR-018 §2/§4 moved to read time. `analyze` still classifies `meeting_notes`
// as an intent (used for tagging/entities), it just now falls through
// `routeToIntentProcessor` with no processor found, same as any other intent
// with no derived-artifact step.
registerIntentProcessor('document', createDerivedForDocument);
