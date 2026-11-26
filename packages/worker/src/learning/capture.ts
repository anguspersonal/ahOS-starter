import { supabase } from '../utils/supabase';
import logger from '../utils/logger';

export type CaptureUserEditContext = {
	artifactId?: string;
	entityId?: string;
	confidenceBefore?: number | null;
	source?: string;
	additionalContext?: any;
};

/**
 * Captures a user correction or feedback as a row in `user_edits`.
 *
 * Phase 1: record the edit only (no pattern extraction here).
 */
export async function captureUserEdit(
	userId: string,
	editType: string,
	originalValue: unknown,
	correctedValue: unknown,
	context: CaptureUserEditContext = {}
): Promise<string> {
	logger.info('Capturing user edit', { userId, editType });

	// Note: original_value and corrected_value are JSONB fields that accept any JSON-serializable value
	const insertPayload = {
		user_id: userId,
		edit_type: editType,
		artifact_id: context.artifactId ?? null,
		entity_id: context.entityId ?? null,
		original_value: originalValue, // JSONB field accepts any JSON-serializable value
		corrected_value: correctedValue, // JSONB field accepts any JSON-serializable value
		confidence_before: context.confidenceBefore ?? null,
		edit_metadata: {
			timestamp: new Date().toISOString(),
			source: context.source ?? 'unknown',
			additional_context: context.additionalContext ?? null,
		},
	};

	const { data, error } = await supabase
		.from('user_edits')
		.insert(insertPayload)
		.select('id')
		.single();

	if (error || !data?.id) {
		logger.error('Failed to capture user edit', {
			userId,
			editType,
			error: error?.message,
			errorCode: error?.code,
			hasArtifactId: !!context.artifactId,
			hasEntityId: !!context.entityId,
		});
		throw new Error(error?.message || 'Failed to capture user edit');
	}

	logger.info('User edit captured', { userEditId: data.id, editType });
	return data.id as string;
}

