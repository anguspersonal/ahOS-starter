import { supabase } from '../utils/supabase';
import logger from '../utils/logger';
import { keysetPaginate, DEFAULT_KEYSET_PAGE_SIZE, DEFAULT_KEYSET_MAX_PAGES } from '../utils/keysetPaginate';

const MIN_OBSERVATIONS_FOR_PATTERN = 5;
const RECENCY_PREFERENCE_THRESHOLD = 1.5; // recencyChoices > similarityChoices * 1.5
const TASK_DURATION_CONSISTENCY_THRESHOLD = 0.3; // stdDev < avgDuration * 0.3
const MIN_CONTEXT_PATTERN_OBSERVATIONS = 3;

/**
 * Requested page size for `getUsersWithRecentEdits`' enumeration scan (#763,
 * same class as #401). See `utils/keysetPaginate.ts` for why this is a
 * request size, not a guarantee, and why the scan's only exhaustion signal
 * is an empty page.
 *
 * Exported so tests can exercise multi-page, exact-page-boundary, and
 * below-page-size-server-cap enumeration without needing thousands of
 * fixture rows.
 */
export const LEARNING_USER_SCAN_PAGE_SIZE = DEFAULT_KEYSET_PAGE_SIZE;

/** Safety valve for `getUsersWithRecentEdits` — see `utils/keysetPaginate.ts`. */
const LEARNING_USER_SCAN_MAX_PAGES = DEFAULT_KEYSET_MAX_PAGES;

type RecentEditRow = { id?: string | null; user_id?: string | null };

/**
 * Distinct user_ids that logged at least one edit since `since` — the users
 * worth running a nightly learning pass for. Mirrors the active-user
 * enumeration in schedule/dedupSweep.ts (dedupe in memory rather than a
 * DISTINCT).
 *
 * Pages through every matching row via `keysetPaginate` (#763, #778) rather
 * than a single unpaginated `.select()` — see that module's docstring for
 * why keyset-with-empty-page-termination is the only safe shape for an
 * enumeration that must never silently truncate.
 */
export async function getUsersWithRecentEdits(since: Date): Promise<string[]> {
	const ids = new Set<string>();

	await keysetPaginate<RecentEditRow>({
		label: 'getUsersWithRecentEdits',
		pageSize: LEARNING_USER_SCAN_PAGE_SIZE,
		maxPages: LEARNING_USER_SCAN_MAX_PAGES,
		getId: (row) => row.id,
		fetchPage: async (afterId, pageSize) => {
			let query = supabase
				.from('user_edits')
				.select('id, user_id')
				.gt('created_at', since.toISOString())
				.not('user_id', 'is', null)
				.order('id', { ascending: true })
				.limit(pageSize);
			if (afterId) query = query.gt('id', afterId);

			const { data, error } = await query;
			if (error) {
				throw new Error(`Failed to fetch users with recent edits: ${error.message}`);
			}
			return (data || []) as RecentEditRow[];
		},
		onPage: (rows) => {
			for (const row of rows) {
				if (typeof row.user_id === 'string' && row.user_id) ids.add(row.user_id);
			}
		},
	});

	return Array.from(ids);
}

/** Outcome of one {@link runBatchLearningAnalysis} pass, for the cadence that calls it (#948). */
export interface BatchLearningAnalysisSummary {
	/** Distinct users with a recent edit that were analysed this run. */
	users: number;
	/** Users whose per-user analysis threw (isolated; the rest still ran). */
	errors: number;
}

/**
 * Main entry point for batch learning analysis.
 *
 * Runs nightly (3AM user timezone) to extract patterns from recent user edits
 * and store them in the system_learning table.
 *
 * Enumeration failures (the `getUsersWithRecentEdits` call) are rethrown —
 * the caller (the 'learning' cadence, `schedule/learningAnalysis.ts`, #948)
 * catches them and records an error run rather than this function swallowing
 * them itself, matching the split `runDedupSweep`/`getActiveUserIds` and
 * `runAlertEvaluation`/`getAlertUsers` already use. Per-user analysis
 * failures are isolated below and counted, never rethrown.
 *
 * Phase 7: Batch Learning Analysis
 */
export async function runBatchLearningAnalysis(): Promise<BatchLearningAnalysisSummary> {
	logger.info('Starting batch learning analysis');

	try {
		// Get all users with recent edits (last 7 days)
		const sevenDaysAgo = new Date();
		sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

		const uniqueUserIds = await getUsersWithRecentEdits(sevenDaysAgo);

		if (uniqueUserIds.length === 0) {
			logger.info('No users with recent edits found');
			return { users: 0, errors: 0 };
		}

		logger.info(`Analyzing edits for ${uniqueUserIds.length} users`);

		let errors = 0;

		// Analyze patterns for each user
		for (const userId of uniqueUserIds) {
			try {
				logger.info('Analyzing edits for user', { userId });

				// Run all analysis functions
				await analyzeEntityMatchingPatterns(userId);
				await analyzeTaskDurationPatterns(userId);
				await analyzeIntentClassificationPatterns(userId);
				await analyzeDisambiguationPatterns(userId);
			} catch (err: any) {
				errors++;
				logger.error('Error analyzing patterns for user', {
					userId,
					error: err?.message,
				});
				// Continue with other users even if one fails
			}
		}

		logger.info('Batch learning analysis complete');
		return { users: uniqueUserIds.length, errors };
	} catch (err: any) {
		logger.error('Batch learning analysis failed', { error: err?.message });
		throw err;
	}
}

/**
 * Analyzes entity matching patterns to learn user preferences.
 * 
 * Identifies patterns like:
 * - "prefers_recency_over_similarity" - User consistently selects recently used entities
 * - "prefer_{relation}_in_work_context" - User prefers certain entity relations in work contexts
 * 
 * Phase 7: Batch Learning Analysis
 */
export async function analyzeEntityMatchingPatterns(userId: string): Promise<void> {
	logger.info('Analyzing entity matching patterns', { userId });

	try {
		// Fetch recent entity corrections (last 30 days)
		const thirtyDaysAgo = new Date();
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

		const { data: edits, error: editsError } = await supabase
			.from('user_edits')
			.select('*')
			.eq('user_id', userId)
			.in('edit_type', ['entity_match_correction', 'feedback_entity_disambiguation'])
			.gt('created_at', thirtyDaysAgo.toISOString())
			.order('created_at', { ascending: false })
			.limit(50);

		if (editsError) {
			logger.error('Failed to fetch entity edits', { userId, error: editsError.message });
			return;
		}

		if (!edits || edits.length < MIN_OBSERVATIONS_FOR_PATTERN) {
			logger.info('Not enough entity edit data', {
				userId,
				editCount: edits?.length || 0,
				required: MIN_OBSERVATIONS_FOR_PATTERN,
			});
			return;
		}

		// ========================================
		// PATTERN 1: Recency vs Similarity Preference
		// ========================================

		let recencyChoices = 0;
		let similarityChoices = 0;
		const editIds: string[] = [];

		for (const edit of edits as any[]) {
			editIds.push(edit.id);

			const originalValue = edit.original_value as any;
			const correctedValue = edit.corrected_value as any;

			if (!originalValue?.candidates || !correctedValue?.selectedEntityId) {
				continue;
			}

			const candidates = originalValue.candidates as any[];
			const selectedEntityId = correctedValue.selectedEntityId;

			const selectedCandidate = candidates.find((c: any) => c.id === selectedEntityId);

			if (selectedCandidate?.breakdown) {
				const recencyScore = selectedCandidate.breakdown.recencyScore || 0;
				const nameSimilarity = selectedCandidate.breakdown.nameSimilarity || 0;

				if (recencyScore > nameSimilarity) {
					recencyChoices++;
				} else {
					similarityChoices++;
				}
			}
		}

		// Check if user prefers recency
		if (recencyChoices > similarityChoices * RECENCY_PREFERENCE_THRESHOLD) {
			const totalChoices = recencyChoices + similarityChoices;
			const confidence = totalChoices > 0 ? recencyChoices / totalChoices : 0;

			if (confidence > 0.5) {
				await upsertSystemLearning({
					userId,
					learningType: 'entity_matching_preference',
					pattern: 'prefers_recency_over_similarity',
					patternData: {
						weight_recency: 0.4,
						weight_similarity: 0.3,
						observation_count: totalChoices,
					},
					confidence,
					observationCount: totalChoices,
					learnedFromEdits: editIds,
				});

				logger.info('Learned recency preference', {
					userId,
					confidence,
					recencyChoices,
					similarityChoices,
				});
			}
		}

		// ========================================
		// PATTERN 2: Context-based Preferences
		// ========================================

	const workContextChoices: Record<string, number> = {
		colleague: 0,
		friend: 0,
		family: 0,
	};

	const workKeywords = ['work', 'meeting', 'project', 'client'];

	// Fetch artifacts for context analysis
	const artifactIds = Array.from(
		new Set((edits as any[]).map((e) => e.artifact_id).filter(Boolean))
	);

	if (artifactIds.length > 0) {
		const { data: artifacts } = await supabase
			.from('artifacts')
			.select('id, user_content')
			.in('id', artifactIds);

		const artifactMap = new Map(
			(artifacts || []).map((a: any) => [a.id, a.user_content || ''])
		);

			for (const edit of edits as any[]) {
				const artifactContent = artifactMap.get(edit.artifact_id) || '';
				const contentLower = (artifactContent as string).toLowerCase();

				// Check if artifact contains work context keywords
				const hasWorkContext = workKeywords.some((keyword) =>
					contentLower.includes(keyword)
				);

				if (hasWorkContext && edit.corrected_value?.selectedEntityId) {
					// Fetch entity to get relation
					const { data: entity } = await supabase
						.from('entities')
						.select('properties')
						.eq('id', edit.corrected_value.selectedEntityId)
						.single();

					if (entity?.properties?.relation) {
						const relation = entity.properties.relation as string;
						if (workContextChoices.hasOwnProperty(relation)) {
							workContextChoices[relation]++;
						}
					}
				}
			}
		}

		// Identify dominant preference
		const maxRelation = Object.keys(workContextChoices).reduce((a, b) =>
			workContextChoices[a] > workContextChoices[b] ? a : b
		);

		if (workContextChoices[maxRelation] >= MIN_CONTEXT_PATTERN_OBSERVATIONS) {
			const totalContextChoices = Object.values(workContextChoices).reduce(
				(sum, count) => sum + count,
				0
			);
			const confidence =
				totalContextChoices > 0
					? workContextChoices[maxRelation] / totalContextChoices
					: 0;

			if (confidence > 0.5) {
				await upsertSystemLearning({
					userId,
					learningType: 'entity_context_pattern',
					pattern: `prefer_${maxRelation}_in_work_context`,
					patternData: {
						context_keywords: workKeywords,
						preferred_relation: maxRelation,
						observation_count: workContextChoices[maxRelation],
					},
					confidence,
					observationCount: workContextChoices[maxRelation],
					learnedFromEdits: editIds,
				});

				logger.info('Learned context preference', {
					userId,
					pattern: `prefer_${maxRelation}_in_work_context`,
					confidence,
					observationCount: workContextChoices[maxRelation],
				});
			}
		}

		logger.info('Entity matching pattern analysis complete', { userId });
	} catch (err: any) {
		logger.error('Error analyzing entity matching patterns', {
			userId,
			error: err?.message,
		});
		throw err;
	}
}

/**
 * Analyzes task duration patterns to learn typical task durations.
 * 
 * Groups completed tasks by keywords and calculates average durations
 * for consistent patterns.
 * 
 * Phase 7: Batch Learning Analysis
 */
export async function analyzeTaskDurationPatterns(userId: string): Promise<void> {
	logger.info('Analyzing task duration patterns', { userId });

	try {
		// Fetch completed tasks with duration (last 60 days)
		const sixtyDaysAgo = new Date();
		sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

		const { data: completedTasks, error: tasksError } = await supabase
			.from('user_tasks')
			.select('id, title, duration_minutes')
			.eq('user_id', userId)
			.eq('status', 'done')
			.not('completed_at', 'is', null)
			.not('duration_minutes', 'is', null)
			.gt('created_at', sixtyDaysAgo.toISOString());

		if (tasksError) {
			logger.error('Failed to fetch completed tasks', {
				userId,
				error: tasksError.message,
			});
			return;
		}

		if (!completedTasks || completedTasks.length < MIN_OBSERVATIONS_FOR_PATTERN) {
			logger.info('Not enough completed task data', {
				userId,
				taskCount: completedTasks?.length || 0,
				required: MIN_OBSERVATIONS_FOR_PATTERN,
			});
			return;
		}

		// Group tasks by keywords
		const taskGroups: Record<string, number[]> = {};

		for (const task of completedTasks as any[]) {
			const keywords = extractKeywords(task.title);
			if (keywords.length === 0) {
				continue;
			}

			const pattern = keywords.join('_');
			const duration = task.duration_minutes as number;

			if (!taskGroups[pattern]) {
				taskGroups[pattern] = [];
			}

			taskGroups[pattern].push(duration);
		}

		// Analyze patterns with enough data
		for (const [pattern, durations] of Object.entries(taskGroups)) {
			if (durations.length < MIN_OBSERVATIONS_FOR_PATTERN) {
				continue;
			}

			const avgDuration = durations.reduce((sum, d) => sum + d, 0) / durations.length;
			const minDuration = Math.min(...durations);
			const maxDuration = Math.max(...durations);

			// Calculate standard deviation
			const variance =
				durations.reduce((sum, d) => sum + Math.pow(d - avgDuration, 2), 0) /
				durations.length;
			const stdDev = Math.sqrt(variance);

			// Only learn if consistent (low std dev relative to mean)
			if (stdDev < avgDuration * TASK_DURATION_CONSISTENCY_THRESHOLD) {
				// Lower std dev = higher confidence
				const confidence = Math.max(0, Math.min(1, 1 - stdDev / avgDuration));

				if (confidence > 0.5) {
					await upsertSystemLearning({
						userId,
						learningType: 'task_duration_estimate',
						pattern,
						patternData: {
							task_keywords: pattern.split('_'),
							average_duration: Math.round(avgDuration),
							min_duration: minDuration,
							max_duration: maxDuration,
							observation_count: durations.length,
						},
						confidence,
						observationCount: durations.length,
						learnedFromEdits: [], // Tasks don't come from user_edits
					});

					logger.info('Learned duration pattern', {
						userId,
						pattern,
						averageDuration: Math.round(avgDuration),
						confidence,
						observationCount: durations.length,
					});
				}
			}
		}

		logger.info('Task duration pattern analysis complete', { userId });
	} catch (err: any) {
		logger.error('Error analyzing task duration patterns', {
			userId,
			error: err?.message,
		});
		throw err;
	}
}

/**
 * Analyzes intent classification patterns to learn user's typical content patterns.
 * 
 * Identifies patterns like "brief_text_is_reminder" based on user corrections.
 * 
 * Phase 7: Batch Learning Analysis
 * 
 * Note: This is a placeholder implementation. Full implementation will analyze
 * intent_correction edits and extract patterns from artifact content.
 */
export async function analyzeIntentClassificationPatterns(userId: string): Promise<void> {
	logger.info('Analyzing intent classification patterns', { userId });

	try {
		// Fetch recent intent corrections (last 30 days)
		const thirtyDaysAgo = new Date();
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

		const { data: edits, error: editsError } = await supabase
			.from('user_edits')
			.select('*')
			.eq('user_id', userId)
			.eq('edit_type', 'intent_correction')
			.gt('created_at', thirtyDaysAgo.toISOString())
			.order('created_at', { ascending: false })
			.limit(50);

		if (editsError) {
			logger.error('Failed to fetch intent edits', { userId, error: editsError.message });
			return;
		}

		if (!edits || edits.length < MIN_OBSERVATIONS_FOR_PATTERN) {
			logger.info('Not enough intent edit data', {
				userId,
				editCount: edits?.length || 0,
				required: MIN_OBSERVATIONS_FOR_PATTERN,
			});
			return;
		}

		// TODO: Implement intent pattern analysis
		// This will analyze original_value and corrected_value to identify patterns
		// like "brief_text_is_reminder" based on text length, action verbs, etc.

		logger.info('Intent classification pattern analysis complete (placeholder)', {
			userId,
		});
	} catch (err: any) {
		logger.error('Error analyzing intent classification patterns', {
			userId,
			error: err?.message,
		});
		// Don't throw - this is optional analysis
	}
}

/**
 * Analyzes disambiguation patterns to learn user's typical disambiguation choices.
 * 
 * Identifies context-based preferences for entity disambiguation.
 * 
 * Phase 7: Batch Learning Analysis
 * 
 * Note: This is a placeholder implementation. Full implementation will analyze
 * feedback_entity_disambiguation edits and extract context patterns.
 */
export async function analyzeDisambiguationPatterns(userId: string): Promise<void> {
	logger.info('Analyzing disambiguation patterns', { userId });

	try {
		// Fetch recent disambiguation feedback (last 30 days)
		const thirtyDaysAgo = new Date();
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

		const { data: edits, error: editsError } = await supabase
			.from('user_edits')
			.select('*')
			.eq('user_id', userId)
			.eq('edit_type', 'feedback_entity_disambiguation')
			.gt('created_at', thirtyDaysAgo.toISOString())
			.order('created_at', { ascending: false })
			.limit(50);

		if (editsError) {
			logger.error('Failed to fetch disambiguation edits', {
				userId,
				error: editsError.message,
			});
			return;
		}

		if (!edits || edits.length < MIN_OBSERVATIONS_FOR_PATTERN) {
			logger.info('Not enough disambiguation edit data', {
				userId,
				editCount: edits?.length || 0,
				required: MIN_OBSERVATIONS_FOR_PATTERN,
			});
			return;
		}

		// TODO: Implement disambiguation pattern analysis
		// This will analyze user choices in disambiguation scenarios
		// to identify context-based preferences

		logger.info('Disambiguation pattern analysis complete (placeholder)', { userId });
	} catch (err: any) {
		logger.error('Error analyzing disambiguation patterns', {
			userId,
			error: err?.message,
		});
		// Don't throw - this is optional analysis
	}
}

/**
 * Helper function to extract keywords from task title.
 * 
 * Filters out common stop words and returns meaningful keywords.
 */
function extractKeywords(text: string): string[] {
	if (!text) {
		return [];
	}

	const stopWords = new Set([
		'the',
		'be',
		'to',
		'of',
		'and',
		'a',
		'in',
		'that',
		'have',
		'i',
		'it',
		'for',
		'not',
		'on',
		'with',
		'he',
		'as',
		'you',
		'do',
		'at',
		'this',
		'but',
		'his',
		'by',
		'from',
		'they',
		'we',
		'say',
		'her',
		'she',
		'or',
		'an',
		'will',
		'my',
		'one',
		'all',
		'would',
		'there',
		'their',
	]);

	const words = text
		.toLowerCase()
		.replace(/[^\w\s]/g, ' ')
		.split(/\s+/)
		.filter((word) => word.length > 2 && !stopWords.has(word));

	// Return unique keywords, limit to 3 most significant
	return Array.from(new Set(words)).slice(0, 3);
}

/**
 * Upserts a learning record into system_learning table.
 * 
 * If a learning with the same user_id, learning_type, and pattern exists,
 * it updates the existing record. Otherwise, creates a new one.
 */
async function upsertSystemLearning(params: {
	userId: string;
	learningType: string;
	pattern: string;
	patternData: any;
	confidence: number;
	observationCount: number;
	learnedFromEdits: string[];
}): Promise<void> {
	const { userId, learningType, pattern, patternData, confidence, observationCount, learnedFromEdits } = params;

	try {
		// Check if learning already exists
		const { data: existing, error: checkError } = await supabase
			.from('system_learning')
			.select('id, observation_count, success_count, failure_count')
			.eq('user_id', userId)
			.eq('learning_type', learningType)
			.eq('pattern', pattern)
			.eq('archived', false)
			.single();

		if (checkError && checkError.code !== 'PGRST116') {
			// PGRST116 = no rows returned, which is fine
			logger.error('Error checking existing learning', {
				userId,
				learningType,
				pattern,
				error: checkError.message,
			});
			return;
		}

		if (existing) {
			// Update existing learning
			const { error: updateError } = await supabase
				.from('system_learning')
				.update({
					pattern_data: patternData,
					confidence,
					observation_count: observationCount,
					learned_from_edits: learnedFromEdits,
					updated_at: new Date().toISOString(),
				})
				.eq('id', existing.id);

			if (updateError) {
				logger.error('Failed to update system learning', {
					userId,
					learningType,
					pattern,
					error: updateError.message,
				});
			} else {
				logger.debug('Updated system learning', {
					userId,
					learningType,
					pattern,
					confidence,
				});
			}
		} else {
			// Create new learning
			const { error: insertError } = await supabase.from('system_learning').insert({
				user_id: userId,
				learning_type: learningType,
				pattern,
				pattern_data: patternData,
				confidence,
				observation_count: observationCount,
				success_count: 0,
				failure_count: 0,
				learned_from_edits: learnedFromEdits,
				archived: false,
				last_observed_at: new Date().toISOString(),
			});

			if (insertError) {
				logger.error('Failed to create system learning', {
					userId,
					learningType,
					pattern,
					error: insertError.message,
				});
			} else {
				logger.debug('Created system learning', {
					userId,
					learningType,
					pattern,
					confidence,
				});
			}
		}
	} catch (err: any) {
		logger.error('Error upserting system learning', {
			userId,
			learningType,
			pattern,
			error: err?.message,
		});
	}
}
