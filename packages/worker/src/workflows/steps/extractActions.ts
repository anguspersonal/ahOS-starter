/**
 * Step 4: Extract Actions
 * 
 * Converts AI-identified actions into concrete tasks, reminders, and events.
 * This step transforms suggestions from analysis into actionable items in the user's task list.
 * 
 * Features:
 * - Process each action suggested by AI analysis
 * - Determine task type (task, reminder, event)
 * - Enrich actions with AI (due date, time, duration, priority)
 * - Apply learned patterns from user's history
 * - Link tasks to relevant entities
 * - Create task records in database
 * - Set up reminder notifications
 * - Handle failures gracefully (non-fatal)
 * 
 * @see docs/Step04_Actions.md
 */

import { supabase } from '../../utils/supabase';
import logger from '../../utils/logger';
import { callAnthropicText } from '../../utils/anthropic';
import { generateUUID, parseDateTime } from '../../utils/helpers';
import { applySystemLearning as applySystemLearningFn } from '../../learning/apply';
import type {
  WorkflowStep,
  AnalysisResult,
  ExtractActionsResult,
} from './types';
import type { ArtifactId, StepId } from './types';
import { updateStepStatus } from './stepStatus';

// Constants
const DEFAULT_REMINDER_MINUTES_BEFORE = 15;

/**
 * Determine task type based on title and description
 */
export function determineTaskType(title: string, description?: string): 'task' | 'reminder' | 'event' {
  const titleLower = title.toLowerCase();
  const descLower = (description || '').toLowerCase();
  const combinedText = `${titleLower} ${descLower}`;

  // Check for reminder keywords
  const reminderKeywords = [
    'remind',
    'reminder',
    "don't forget",
    'remember to',
    'make sure to',
  ];

  for (const keyword of reminderKeywords) {
    if (combinedText.includes(keyword)) {
      return 'reminder';
    }
  }

  // Check for event keywords
  const eventKeywords = [
    'meeting',
    'call',
    'appointment',
    'interview',
    'presentation',
    'conference',
    'lunch',
    'dinner',
  ];

  for (const keyword of eventKeywords) {
    if (combinedText.includes(keyword)) {
      return 'event';
    }
  }

  // Default to task
  return 'task';
}

/**
 * Check if action needs AI enrichment
 */
export function needsEnrichment(action: {
  dueDate?: string;
  priority?: string;
  suggestedDuration?: number;
}): boolean {
  const missingFields: string[] = [];

  if (!action.dueDate || action.dueDate === '') {
    missingFields.push('dueDate');
  }

  if (!action.priority || action.priority === '') {
    missingFields.push('priority');
  }

  if (action.suggestedDuration === null || action.suggestedDuration === undefined) {
    missingFields.push('duration');
  }

  // If missing 2+ fields, needs enrichment
  return missingFields.length >= 2;
}

/**
 * Build prompt for AI action enrichment
 */
export function buildActionEnrichmentPrompt(
  action: { title: string; description?: string },
  artifact: { user_content?: string | null; content_subtype?: string | null; created_at?: string }
): string {
  const prompt = `You are enriching a task extracted from a user's artifact.

Task: ${action.title}
Description: ${action.description || 'None'}

Artifact context:
- User's note: ${artifact.user_content || 'None'}
- Artifact type: ${artifact.content_subtype || 'unknown'}
- Captured at: ${artifact.created_at || 'unknown'}

Please enrich this task with:
1. **dueDate**: When should this be done? (Format: YYYY-MM-DD, or null if unclear)
2. **dueTime**: What time of day? (Format: HH:MM in 24-hour format, or null if not specified)
3. **duration**: How long will it take? (Integer in minutes, or null if unknown)
4. **priority**: How urgent is this? (Options: "low", "medium", "high", "urgent")
5. **confidence**: How confident are you in these enrichments? (0-1 scale)

Context for inference:
- If the task says "call" someone, it usually takes 15-30 minutes
- If it says "review" something, it usually takes 30-60 minutes
- If it says "quick" or "brief", reduce duration
- If it says "urgent" or "asap", priority is "urgent" or "high"
- If it mentions a specific time, use that for dueTime
- If it says "today", use today's date
- If it says "tomorrow", use tomorrow's date
- If no time frame mentioned, dueDate can be null

Return ONLY a JSON object with these fields. No markdown, no explanation.

Current date/time: ${new Date().toISOString()}
`;

  return prompt;
}

/**
 * Map priority string to normalized priority
 */
export function mapPriority(priorityString: string | null | undefined): 'low' | 'medium' | 'high' | 'urgent' {
  if (!priorityString || priorityString === '') {
    return 'medium';
  }

  const priorityLower = priorityString.toLowerCase();

  // Urgent
  if (priorityLower === 'urgent' || priorityLower === 'critical' || priorityLower === 'asap') {
    return 'urgent';
  }

  // High
  if (priorityLower === 'high' || priorityLower === 'important') {
    return 'high';
  }

  // Low
  if (priorityLower === 'low' || priorityLower === 'minor') {
    return 'low';
  }

  // Default to medium
  return 'medium';
}

/**
 * Parse date string to Date object
 */
export function parseDateString(dateString: string | null | undefined): Date | null {
  if (!dateString || dateString === '') {
    return null;
  }

  try {
    const dateStringLower = dateString.toLowerCase().trim();

    // Handle relative dates
    if (dateStringLower === 'today') {
      const now = new Date();
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }

    if (dateStringLower === 'tomorrow') {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      return tomorrow;
    }

    // Handle "in X days/weeks/months"
    if (dateStringLower.startsWith('in ')) {
      const parts = dateStringLower.split(' ');
      if (parts.length >= 3) {
        const number = parseInt(parts[1], 10);
        const unit = parts[2];

        if (!isNaN(number)) {
          const result = new Date();
          if (unit.startsWith('day')) {
            result.setDate(result.getDate() + number);
            return result;
          } else if (unit.startsWith('week')) {
            result.setDate(result.getDate() + (number * 7));
            return result;
          } else if (unit.startsWith('month')) {
            result.setMonth(result.getMonth() + number);
            return result;
          }
        }
      }
    }

    // Handle ISO date format (YYYY-MM-DD)
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
      const date = new Date(dateString);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }

    // Try parsing as natural language date (fallback to parseDateTime)
    const parsed = parseDateTime(dateString);
    if (parsed) {
      return parsed;
    }

    return null;
  } catch (error: any) {
    logger.warn('Failed to parse date', { dateString, error: error.message });
    return null;
  }
}

/**
 * Parse time string to HH:MM format
 */
export function parseTimeString(timeString: string | null | undefined): string | null {
  if (!timeString || timeString === '') {
    return null;
  }

  try {
    const trimmed = timeString.trim();

    // Handle 24-hour format (HH:MM)
    if (/^\d{2}:\d{2}$/.test(trimmed)) {
      const [hours, minutes] = trimmed.split(':').map(Number);
      if (hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60) {
        return trimmed;
      }
    }

    // Handle 12-hour format (h:mm AM/PM)
    const twelveHourMatch = trimmed.match(/^(\d{1,2}):(\d{2})\s?(AM|PM|am|pm)$/);
    if (twelveHourMatch) {
      let hours = parseInt(twelveHourMatch[1], 10);
      const minutes = parseInt(twelveHourMatch[2], 10);
      const period = twelveHourMatch[3].toUpperCase();

      if (period === 'PM' && hours !== 12) {
        hours += 12;
      } else if (period === 'AM' && hours === 12) {
        hours = 0;
      }

      if (hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60) {
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
      }
    }

    // Handle relative times
    const timeStringLower = trimmed.toLowerCase();
    if (timeStringLower === 'morning') {
      return '09:00';
    } else if (timeStringLower === 'afternoon') {
      return '14:00';
    } else if (timeStringLower === 'evening') {
      return '18:00';
    } else if (timeStringLower === 'night') {
      return '20:00';
    }

    return null;
  } catch (error: any) {
    logger.warn('Failed to parse time', { timeString, error: error.message });
    return null;
  }
}

/**
 * Calculate notification time (minutes before due date/time)
 */
export function calculateNotificationTime(
  dueDate: Date,
  dueTime: string,
  minutesBefore: number = DEFAULT_REMINDER_MINUTES_BEFORE
): Date {
  // Combine date and time
  const [hours, minutes] = dueTime.split(':').map(Number);
  const dueDateTime = new Date(dueDate);
  dueDateTime.setHours(hours, minutes, 0, 0);

  // Subtract minutes
  const notifyAt = new Date(dueDateTime.getTime() - minutesBefore * 60 * 1000);
  return notifyAt;
}

/**
 * Apply system learning (stub implementation)
 * Queries system_learning table for task duration estimates
 */
// Re-export for tests and step modules that import from this file.
export const applySystemLearning = applySystemLearningFn;

/**
 * Execute the extract actions step
 */
export async function executeExtractActionsStep(
  step: WorkflowStep,
  artifactId: ArtifactId,
  stepId: StepId,
  analysisResult: AnalysisResult
): Promise<ExtractActionsResult> {
  const startTime = Date.now();

  logger.info('Starting extract actions step', {
    stepId: stepId.value,
    artifactId: artifactId.value,
    actionCount: analysisResult.actions_suggested?.length || 0,
  });

  // 1. Update step status to processing
  await updateStepStatus(stepId, 'running', {
    started_at: new Date().toISOString(),
    message: `Extracting ${analysisResult.actions_suggested?.length || 0} actions...`,
  });

  // 2. Fetch artifact
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
      tasksCreated: [],
    };
  }

  // 3. Check if actions exist
  if (!analysisResult.actions_suggested || analysisResult.actions_suggested.length === 0) {
    logger.info('No actions to extract', { artifactId: artifactId.value });
    await updateStepStatus(stepId, 'completed', {
      message: 'No actions to extract',
      completed_at: new Date().toISOString(),
      output: { tasksCreated: [] },
    });

    return {
      success: true,
      tasksCreated: [],
    };
  }

  logger.info(`Extracting ${analysisResult.actions_suggested.length} actions...`, { artifactId: artifactId.value });

  // 4. Track results
  const tasksCreated: ExtractActionsResult['tasksCreated'] = [];
  let tokensUsed = 0;

  // 5. Process each action
  for (const actionSuggested of analysisResult.actions_suggested) {
    try {
      logger.info('Processing action', { title: actionSuggested.title });

      // 5a. Determine task type
      const taskType = determineTaskType(actionSuggested.title, actionSuggested.description);
      logger.debug('Task type determined', { title: actionSuggested.title, taskType });

      // 5b. Enrich action with AI (if needed)
      let enrichedAction = { ...actionSuggested };
      if (needsEnrichment(actionSuggested)) {
        logger.info('Action needs enrichment, calling AI', { title: actionSuggested.title });

        try {
          const enrichmentPrompt = buildActionEnrichmentPrompt(actionSuggested, artifact);
          const aiResponse = await callAnthropicText(enrichmentPrompt, 4096);
          tokensUsed += aiResponse.usage.total_tokens || 0;

          // Parse response
          let enrichmentText = aiResponse.content;
          enrichmentText = enrichmentText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          const enrichmentResult = JSON.parse(enrichmentText);

          // Merge with original
          enrichedAction = {
            ...actionSuggested,
            dueDate: enrichmentResult.dueDate || actionSuggested.dueDate,
            dueTime: enrichmentResult.dueTime,
            suggestedDuration: enrichmentResult.duration || actionSuggested.suggestedDuration,
            priority: enrichmentResult.priority || actionSuggested.priority,
            enrichmentConfidence: enrichmentResult.confidence,
          } as typeof actionSuggested & { dueTime?: string; enrichmentConfidence?: number };

          logger.info('Action enriched', {
            title: enrichedAction.title,
            dueDate: enrichedAction.dueDate,
            duration: enrichedAction.suggestedDuration,
          });
        } catch (enrichmentError: any) {
          // Non-fatal - use original action
          logger.warn('Action enrichment failed', {
            title: actionSuggested.title,
            error: enrichmentError.message,
          });
          enrichedAction = actionSuggested;
        }
      }

      // 5c. Learned duration estimates are deferred, and this lookup is disabled.
      //
      // The loop it belongs to cannot produce a true answer as built. The only
      // writer of a task's duration is this step, a few lines below, writing the
      // model's *estimate*. Nothing anywhere records how long a task actually
      // took. So the analyser that fills the learning store would average this
      // step's own guesses and hand them back as learned patterns carrying
      // confidence scores: the ritual's own output becoming its own input, and a
      // wrong number arriving plausible and well-formatted.
      //
      // Left running, the lookup queries a store that can never hold a useful row.
      // Building this properly starts with capturing real elapsed durations, which
      // is a design question rather than a wiring one, and is tracked separately.

      // 5d. Link to entities
      let linkedEntityId: string | null = null;
      if (analysisResult.entities_mentioned && analysisResult.entities_mentioned.length > 0) {
        const titleLower = enrichedAction.title.toLowerCase();
        const descLower = (enrichedAction.description || '').toLowerCase();

        for (const entity of analysisResult.entities_mentioned) {
          const entityNameLower = entity.name.toLowerCase();
          if (titleLower.includes(entityNameLower) || descLower.includes(entityNameLower)) {
            // First find the entity in database
            const { data: entities } = await supabase
              .from('entities')
              .select('id')
              .eq('user_id', artifact.user_id)
              .ilike('title', entityNameLower)
              .limit(1);

            if (entities && entities.length > 0) {
              const entityId = entities[0].id;

              // Check if entity is linked to this artifact
              const { data: entityLink } = await supabase
                .from('artifact_entity_links')
                .select('entity_id')
                .eq('artifact_id', artifactId.value)
                .eq('entity_id', entityId)
                .limit(1)
                .single();

              if (entityLink) {
                linkedEntityId = entityLink.entity_id;
                logger.info('Task linked to entity', { entityName: entity.name, entityId });
                break;
              }
            }
          }
        }
      }

      // 5e. Create task record
      const taskId = generateUUID();
      const dueDate = parseDateString(enrichedAction.dueDate);
      const dueTime = parseTimeString((enrichedAction as any).dueTime);
      const confidenceScore = ((enrichedAction as any).enrichmentConfidence || 0.8) * 100;

      const { data: task, error: taskError } = await supabase
        .from('user_tasks')
        .insert({
          id: taskId,
          user_id: artifact.user_id,
          title: enrichedAction.title,
          description: enrichedAction.description || null,
          status: 'todo',
          priority: mapPriority(enrichedAction.priority),
          due_date: dueDate ? dueDate.toISOString().split('T')[0] : null,
          due_time: dueTime,
          duration_minutes: enrichedAction.suggestedDuration || null,
          source_artifact_id: artifactId.value,
          entity_id: linkedEntityId,
          confidence_score: confidenceScore,
          created_via: 'system',
          created_by: artifact.user_id,
          assigned_to: artifact.user_id,
        })
        .select()
        .single();

      if (taskError || !task) {
        throw new Error(taskError?.message || 'Failed to create task');
      }

      tasksCreated.push({
        id: task.id,
        title: task.title,
        dueDate: task.due_date,
        priority: task.priority,
      });

      logger.info('Task created', { taskId: task.id, title: task.title });

      // 5f. Create reminder notification (if applicable)
      if (taskType === 'reminder' && dueDate && dueTime) {
        const notifyAt = calculateNotificationTime(dueDate, dueTime, DEFAULT_REMINDER_MINUTES_BEFORE);

        // Only create if in future
        if (notifyAt > new Date()) {
          await supabase.from('system_decisions').insert({
            user_id: artifact.user_id,
            artifact_id: artifactId.value,
            decision_type: 'task_reminder',
            stage: 'actions_extracted',
            title: `Reminder: ${enrichedAction.title}`,
            description: enrichedAction.description || '',
            confidence_score: 100,
            blocking: false,
            status: 'pending',
            review_type: 'suggestion',
            decision_payload: {
              taskId: task.id,
              notifyAt: notifyAt.toISOString(),
              taskTitle: task.title,
            },
          });

          logger.info('Reminder notification created', { notifyAt: notifyAt.toISOString() });
        }
      }
    } catch (taskCreationError: any) {
      // Log error but continue with other actions
      logger.error('Failed to create task', {
        title: actionSuggested.title,
        error: taskCreationError.message,
      });

      // Create notification for user
      await supabase.from('system_decisions').insert({
        user_id: artifact.user_id,
        artifact_id: artifactId.value,
        decision_type: 'task_creation_failed',
        stage: 'actionable',
        title: "Couldn't create task",
        description: `Failed to create task: '${actionSuggested.title}'. Error: ${taskCreationError.message}`,
        confidence_score: 100,
        blocking: false,
        status: 'pending',
        review_type: 'quality_check',
        decision_payload: {
          originalAction: actionSuggested,
          error: taskCreationError.message,
          artifactId,
        },
      });
    }
  }

  // 6. Update artifact lifecycle stage
  if (tasksCreated.length > 0) {
    await supabase
      .from('artifacts')
      .update({ lifecycle_stage: 'actions_extracted' })
      .eq('id', artifactId.value);

    logger.info("Artifact lifecycle updated to 'actions_extracted'", { artifactId: artifactId.value });
  }

  // 7. Update step status
  const duration = Date.now() - startTime;
  await updateStepStatus(stepId, 'completed', {
    message: `Created ${tasksCreated.length} tasks`,
    completed_at: new Date().toISOString(),
    duration_ms: duration,
    output: {
      tasksCreated: tasksCreated.map(t => ({
        id: t.id,
        title: t.title,
        dueDate: t.dueDate,
        priority: t.priority,
      })),
      tokensUsed,
    },
  });

  logger.info('Action extraction complete', {
    tasksCreated: tasksCreated.length,
    tokensUsed,
    duration,
  });

  // 8. Return results
  return {
    success: true,
    tasksCreated,
    tokensUsed,
  };
}

