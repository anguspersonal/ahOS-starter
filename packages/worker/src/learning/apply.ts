import { supabase } from '../utils/supabase';
import logger from '../utils/logger';
import { patternMatches } from './patternMatches';

const LEARNING_CONFIDENCE_THRESHOLD = 0.7;

export type ApplyLearningContext = {
	taskDescription: string;
	taskType: string;
};

/**
 * Apply system learning (Phase 1: basic implementation)
 * Queries system_learning table for task duration estimates (and other types via pattern match).
 */
export async function applySystemLearning(
	userId: string,
	learningType: string,
	context: ApplyLearningContext
): Promise<{ pattern_data: { average_duration: number }; confidence: number } | null> {
	try {
		const { data: learnings, error } = await supabase
			.from('system_learning')
			.select('*')
			.eq('user_id', userId)
			.eq('learning_type', learningType)
			.eq('archived', false)
			.gt('confidence', 0.5)
			.order('confidence', { ascending: false })
			.limit(10);

		if (error || !learnings || learnings.length === 0) {
			return null;
		}

		const contextDesc = (context.taskDescription || '').toLowerCase();

		for (const learning of learnings as any[]) {
			if (patternMatches(learning.pattern, contextDesc)) {
				if (learning.confidence >= LEARNING_CONFIDENCE_THRESHOLD) {
					logger.info('Applying learned pattern', {
						pattern: learning.pattern,
						confidence: learning.confidence,
					});
					return {
						pattern_data: learning.pattern_data as { average_duration: number },
						confidence: learning.confidence,
					};
				}
			}
		}

		return null;
	} catch (err: any) {
		logger.warn('Failed to apply system learning', { userId, learningType, error: err?.message });
		return null;
	}
}

