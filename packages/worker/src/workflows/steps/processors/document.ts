/**
 * Document Processor
 * 
 * Processor for document intent that creates summarized_document derived artifacts.
 * Transforms long documents into concise executive summaries with key points,
 * action items, and tagged entities.
 * 
 * @see docs/create-derived-artifact/requirements.md
 * @see docs/create-derived-artifact/design.md
 */

import logger from '../../../utils/logger';
import type {
	WorkflowStep,
	AnalysisResult,
} from '../types';
import type {
	Artifact,
	CreateDerivedResult,
} from '../createDerived';
import {
	extractContentForProcessing,
	callAnthropicWithRetry,
	createDerivedArtifactRecord,
	linkDerivedArtifact,
	createDerivedArtifactNotification,
} from '../createDerived';

/**
 * Build AI prompt for summarizing documents
 * 
 * Creates a prompt that instructs the AI to transform a long document into
 * a concise executive summary with key points, action items, and tagged entities.
 * 
 * @param contentToProcess - Original document content
 * @param analysisResult - Analysis result with intent, topics, entities mentioned
 * @returns Formatted prompt string for Anthropic API
 */
export function buildSummaryPrompt(
	contentToProcess: string,
	analysisResult: AnalysisResult
): string {
	// Extract entities mentioned (if available)
	const entitiesList = analysisResult.entities_mentioned && Array.isArray(analysisResult.entities_mentioned)
		? analysisResult.entities_mentioned.map((entity: any) => {
			if (typeof entity === 'string') return entity;
			if (entity && typeof entity === 'object' && 'name' in entity) {
				return entity.name;
			}
			return String(entity);
		}).filter(Boolean).join(', ')
		: 'None identified';

	// Extract topics (if available)
	const topicsList = analysisResult.topics && Array.isArray(analysisResult.topics)
		? analysisResult.topics.join(', ')
		: 'None identified';

	const prompt = `You are creating an executive summary of a document. Transform the document into a concise, well-structured summary.

Original document:
${contentToProcess}

Analysis context:
- Intent: ${analysisResult.intent || 'document'}
- Topics discussed: ${topicsList}
- Entities mentioned: ${entitiesList}

Please create a summary following these guidelines:

1. **Executive Summary**: Start with a 2-3 sentence executive summary that captures the main purpose, key findings, and primary takeaway of the document.

2. **Key Points**: Include 3-7 bullet points that highlight the most important information, findings, or conclusions from the document. Use clear, concise language.

3. **Action Items**: If the document contains any action items, tasks, or next steps, include them in a dedicated section. Format as: \`→ [Action description] - [Owner/Assignee if mentioned]\`

4. **Entity Tagging**: Tag all mentioned entities using double brackets: \`[[Entity Name]]\`. This includes people, companies, projects, products, locations, or any other named entities.

5. **Length**: Keep the entire summary under 500 words. Prioritize clarity and key information over completeness.

6. **Markdown Formatting**: Use appropriate markdown formatting:
   - Headers for sections (## Executive Summary, ## Key Points, ## Action Items)
   - Bullet points for lists
   - Bold text for emphasis on critical points
   - Code blocks for technical terms or code snippets if mentioned

7. **Preserve Important Details**: Ensure the summary captures:
   - Main purpose and context
   - Key findings or conclusions
   - Important numbers, metrics, or data points
   - Decisions made or recommendations
   - Action items with owners (if mentioned)
   - Deadlines or dates mentioned

Return ONLY the processed markdown content. Do not include any preamble, explanation, or commentary. Start directly with the summary content.`;

	return prompt;
}

/**
 * Processor for document intent
 * 
 * Creates summarized_document derived artifact by:
 * 1. Extracting content from the artifact
 * 2. Building a prompt for summarizing the document
 * 3. Calling Anthropic API to generate summary content
 * 4. Creating derived artifact record
 * 5. Linking artifacts
 * 6. Creating user notification
 * 
 * @param step - Workflow step record
 * @param artifact - Source artifact record
 * @param analysisResult - Analysis result with intent and context
 * @returns CreateDerivedResult indicating success or failure
 */
export async function createDerivedForDocument(
	step: WorkflowStep,
	artifact: Artifact,
	analysisResult: AnalysisResult
): Promise<CreateDerivedResult> {
	logger.info('Processing document for derived artifact', {
		stepId: step.id,
		artifactId: artifact.id,
		intent: analysisResult.intent,
	});

	try {
		// 1. Extract content using shared helper
		const contentToProcess = extractContentForProcessing(artifact);
		if (!contentToProcess) {
			logger.warn('No text content available to process', {
				stepId: step.id,
				artifactId: artifact.id,
			});
			return {
				success: false,
				error: 'No text content available to process',
			};
		}

		// 2. Build prompt using intent-specific prompt builder
		const prompt = buildSummaryPrompt(contentToProcess, analysisResult);

		// 3. Call Anthropic with retry using shared helper
		const { derivedContent, tokensUsed } = await callAnthropicWithRetry(prompt);

		// 4. Create derived artifact using shared helper
		const derivedArtifact = await createDerivedArtifactRecord(
			artifact,
			derivedContent,
			'summarized_document',
			tokensUsed,
			contentToProcess.length,
			{ workflowId: step.workflow_id, stepId: step.id, stepType: step.step_type }
		);

		// 5. Link artifacts using shared helper
		await linkDerivedArtifact(artifact.id, derivedArtifact.id);

		// 6. Create notification using shared helper
		const compressionRatio = contentToProcess.length > 0
			? derivedContent.length / contentToProcess.length
			: 0;

		// Get user_id from artifact (required for notification)
		const userId = typeof artifact.user_id === 'string' ? artifact.user_id : null;
		let notificationId: string | undefined = undefined;
		
		if (!userId) {
			logger.warn('Artifact missing user_id, skipping notification', {
				stepId: step.id,
				artifactId: artifact.id,
			});
		} else {
			const notification = await createDerivedArtifactNotification(
				userId,
				artifact.id,
				derivedArtifact.id,
				'summarized_document',
				compressionRatio,
				tokensUsed
			);
			notificationId = notification?.id;
		}

		logger.info('Successfully created summarized document', {
			stepId: step.id,
			artifactId: artifact.id,
			derivedArtifactId: derivedArtifact.id,
			tokensUsed,
			notificationId,
		});

		// 7. Return success result
		return {
			success: true,
			derivedArtifactId: derivedArtifact.id,
			derivedType: 'summarized_document',
			tokensUsed,
			notificationId,
		};
	} catch (error) {
		logger.error('Failed to create derived artifact for document', {
			stepId: step.id,
			artifactId: artifact.id,
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});

		return {
			success: false,
			error: error instanceof Error ? error.message : 'Unknown error occurred',
			errorDetails: error instanceof Error ? error.stack : String(error),
		};
	}
}
