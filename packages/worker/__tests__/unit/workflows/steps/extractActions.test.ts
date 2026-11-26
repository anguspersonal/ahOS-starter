/**
 * Unit tests for Extract Actions Step
 */

import {
  executeExtractActionsStep,
  determineTaskType,
  needsEnrichment,
  buildActionEnrichmentPrompt,
  mapPriority,
  parseDateString,
  parseTimeString,
  calculateNotificationTime,
  applySystemLearning,
} from '../../../../src/workflows/steps/extractActions';
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
  simulateTextFailure,
} from '../../../__mocks__/anthropic';

// Mock dependencies
jest.mock('../../../../src/utils/supabase');
jest.mock('../../../../src/utils/anthropic');

const mockSupabase = supabase as jest.Mocked<typeof supabase>;
const mockCallAnthropicText = callAnthropicText as jest.MockedFunction<typeof callAnthropicText>;

describe('Extract Actions Step', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMockData();
    resetAnthropicMocks();
  });

  describe('executeExtractActionsStep', () => {
    it('should return error when artifact not found', async () => {
      const step = createMockWorkflowStep();
      setMockData('artifacts', []);

      const analysisResult = {
        intent: 'meeting_notes',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [],
        topics: [],
        sentiment: 'neutral',
      };

      const result = await executeExtractActionsStep(step, ArtifactId.parse(TEST_ARTIFACT_ID_2), StepId.parse(step.id), analysisResult);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Artifact not found');
    });

    it('should return success with empty array when no actions', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({ id: TEST_ARTIFACT_ID });
      setMockData('artifacts', [artifact]);

      const analysisResult = {
        intent: 'meeting_notes',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [],
        topics: [],
        sentiment: 'neutral',
      };

      const result = await executeExtractActionsStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id), analysisResult);

      expect(result.success).toBe(true);
      expect(result.tasksCreated).toHaveLength(0);
    });

    it('should create task from simple action', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        user_id: 'user-123',
        content_subtype: 'note',
      });
      setMockData('artifacts', [artifact]);
      setMockData('user_tasks', []);

      const analysisResult = {
        intent: 'task',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [
          {
            title: 'Call mum',
            description: 'Follow up about dinner plans',
            priority: 'medium',
            dueDate: '2025-01-27',
            suggestedDuration: 20,
          },
        ],
        topics: [],
        sentiment: 'neutral',
      };

      const result = await executeExtractActionsStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id), analysisResult);

      expect(result.success).toBe(true);
      expect(result.tasksCreated).toHaveLength(1);
      expect(result.tasksCreated[0].title).toBe('Call mum');
      expect(result.tasksCreated[0].priority).toBe('medium');

      // Verify task was created in database
      const tasks = getMockData('user_tasks');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe('Call mum');
      expect(tasks[0].status).toBe('todo');
      expect(tasks[0].created_via).toBe('system');
    });

    it('should enrich action when fields are missing', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        user_id: 'user-123',
        content_subtype: 'note',
      });
      setMockData('artifacts', [artifact]);
      setMockData('user_tasks', []);

      const analysisResult = {
        intent: 'task',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [
          {
            title: 'Review document',
            // Missing dueDate, priority, suggestedDuration
          },
        ],
        topics: [],
        sentiment: 'neutral',
      };

      // Mock AI enrichment response
      setMockTextResponse(
        JSON.stringify({
          dueDate: '2025-01-28',
          dueTime: '14:00',
          duration: 30,
          priority: 'high',
          confidence: 0.8,
        }),
        { total_tokens: 500 }
      );

      const result = await executeExtractActionsStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id), analysisResult);

      expect(result.success).toBe(true);
      expect(mockCallAnthropicText).toHaveBeenCalled();
      expect(result.tokensUsed).toBe(500);

      const { getMockData } = require('../../../__mocks__/supabase');
      const tasks = getMockData('user_tasks');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].priority).toBe('high');
    });

    it('should handle enrichment failure gracefully', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        user_id: 'user-123',
      });
      setMockData('artifacts', [artifact]);
      setMockData('user_tasks', []);

      const analysisResult = {
        intent: 'task',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [
          {
            title: 'Review document',
          },
        ],
        topics: [],
        sentiment: 'neutral',
      };

      // Simulate AI failure
      simulateTextFailure(new Error('API error'));

      const result = await executeExtractActionsStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id), analysisResult);

      expect(result.success).toBe(true);
      // Task should still be created with defaults
      const { getMockData } = require('../../../__mocks__/supabase');
      const tasks = getMockData('user_tasks');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].priority).toBe('medium'); // Default priority
    });

    it('should link task to entity when entity mentioned', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        user_id: 'user-123',
      });
      setMockData('artifacts', [artifact]);
      setMockData('user_tasks', []);

      const entity = {
        id: 'entity-123',
        user_id: 'user-123',
        title: 'Mum',
        entity_type: 'people',
      };
      setMockData('entities', [entity]);
      setMockData('artifact_entity_links', [
        {
          artifact_id: TEST_ARTIFACT_ID,
          entity_id: 'entity-123',
        },
      ]);

      const analysisResult = {
        intent: 'task',
        confidence: 0.9,
        entities_mentioned: [
          { name: 'Mum', type: 'people', confidence: 0.9 },
        ],
        actions_suggested: [
          {
            title: 'Call mum',
            priority: 'medium',
          },
        ],
        topics: [],
        sentiment: 'neutral',
      };

      const result = await executeExtractActionsStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id), analysisResult);

      expect(result.success).toBe(true);
      const { getMockData } = require('../../../__mocks__/supabase');
      const tasks = getMockData('user_tasks');
      expect(tasks[0].entity_id).toBe('entity-123');
    });

    it('should create reminder notification for reminder-type tasks', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        user_id: 'user-123',
      });
      setMockData('artifacts', [artifact]);
      setMockData('user_tasks', []);
      setMockData('system_decisions', []);

      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 1);
      const dueDate = futureDate.toISOString().split('T')[0];

      const analysisResult = {
        intent: 'reminder',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [
          {
            title: 'Remind me to call mum',
            priority: 'medium',
            dueDate,
            dueTime: '14:00',
            suggestedDuration: 20,
          },
        ],
        topics: [],
        sentiment: 'neutral',
      };

      const result = await executeExtractActionsStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id), analysisResult);

      expect(result.success).toBe(true);
      const { getMockData } = require('../../../__mocks__/supabase');
      const decisions = getMockData('system_decisions');
      const reminder = decisions.find((d: any) => d.decision_type === 'task_reminder');
      expect(reminder).toBeDefined();
      expect(reminder.title).toContain('Reminder:');
    });

    it('should continue processing when one task fails', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        user_id: 'user-123',
      });
      setMockData('artifacts', [artifact]);
      setMockData('user_tasks', []);

      const analysisResult = {
        intent: 'task',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [
          {
            title: 'Task 1',
            priority: 'medium',
          },
          {
            title: 'Task 2',
            priority: 'medium',
          },
        ],
        topics: [],
        sentiment: 'neutral',
      };

      // Mock insert to fail for first task, succeed for second
      let callCount = 0;
      const originalFrom = mockSupabase.from;
      mockSupabase.from = jest.fn((table: string) => {
        if (table === 'user_tasks') {
          const builder = originalFrom(table);
          const originalInsert = builder.insert.bind(builder);
          builder.insert = jest.fn((data: any) => {
            callCount++;
            if (callCount === 1) {
              // First call fails
              return {
                select: jest.fn(() => ({
                  single: jest.fn(() =>
                    Promise.resolve({ data: null, error: { message: 'Database error' } })
                  ),
                })),
              } as any;
            }
            // Subsequent calls succeed
            return originalInsert(data);
          }) as any;
          return builder;
        }
        // For other tables (like system_decisions), use the original builder
        return originalFrom(table);
      });

      const result = await executeExtractActionsStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id), analysisResult);

      expect(result.success).toBe(true);
      // Should have created notification for failed task
      const { getMockData } = require('../../../__mocks__/supabase');
      const decisions = getMockData('system_decisions');
      const failureDecision = decisions.find((d: any) => d.decision_type === 'task_creation_failed');
      expect(failureDecision).toBeDefined();
      
      // Restore original mock
      mockSupabase.from = originalFrom;
    });

    it('should update artifact lifecycle stage when tasks created', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        user_id: 'user-123',
        lifecycle_stage: 'entities_extracted',
      });
      setMockData('artifacts', [artifact]);
      setMockData('user_tasks', []);

      const analysisResult = {
        intent: 'task',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [
          {
            title: 'Complete task',
            priority: 'medium',
          },
        ],
        topics: [],
        sentiment: 'neutral',
      };

      await executeExtractActionsStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id), analysisResult);

      // Verify artifact was updated
      const { getMockData } = require('../../../__mocks__/supabase');
      const artifacts = getMockData('artifacts');
      expect(artifacts[0].lifecycle_stage).toBe('actions_extracted');
    });
  });

  describe('determineTaskType', () => {
    it('should return "reminder" for reminder keywords', () => {
      expect(determineTaskType('Remind me to call')).toBe('reminder');
      expect(determineTaskType('Don\'t forget to buy milk')).toBe('reminder');
      expect(determineTaskType('Remember to check email')).toBe('reminder');
    });

    it('should return "event" for event keywords', () => {
      expect(determineTaskType('Meeting with team')).toBe('event');
      expect(determineTaskType('Call client')).toBe('event');
      expect(determineTaskType('Lunch appointment')).toBe('event');
    });

    it('should return "task" as default', () => {
      expect(determineTaskType('Review document')).toBe('task');
      expect(determineTaskType('Write report')).toBe('task');
    });
  });

  describe('needsEnrichment', () => {
    it('should return true when 2+ fields missing', () => {
      expect(needsEnrichment({})).toBe(true);
      expect(needsEnrichment({ dueDate: '2025-01-27' })).toBe(true);
      expect(needsEnrichment({ priority: 'high' })).toBe(true);
    });

    it('should return false when all fields present', () => {
      expect(needsEnrichment({
        dueDate: '2025-01-27',
        priority: 'high',
        suggestedDuration: 30,
      })).toBe(false);
    });
  });

  describe('mapPriority', () => {
    it('should map urgent priorities', () => {
      expect(mapPriority('urgent')).toBe('urgent');
      expect(mapPriority('critical')).toBe('urgent');
      expect(mapPriority('asap')).toBe('urgent');
    });

    it('should map high priorities', () => {
      expect(mapPriority('high')).toBe('high');
      expect(mapPriority('important')).toBe('high');
    });

    it('should map low priorities', () => {
      expect(mapPriority('low')).toBe('low');
      expect(mapPriority('minor')).toBe('low');
    });

    it('should default to medium', () => {
      expect(mapPriority(null)).toBe('medium');
      expect(mapPriority('')).toBe('medium');
      expect(mapPriority('unknown')).toBe('medium');
    });
  });

  describe('parseDateString', () => {
    it('should parse "today"', () => {
      const result = parseDateString('today');
      expect(result).toBeInstanceOf(Date);
      const today = new Date();
      expect(result?.getDate()).toBe(today.getDate());
    });

    it('should parse "tomorrow"', () => {
      const result = parseDateString('tomorrow');
      expect(result).toBeInstanceOf(Date);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      expect(result?.getDate()).toBe(tomorrow.getDate());
    });

    it('should parse "in X days"', () => {
      const result = parseDateString('in 3 days');
      expect(result).toBeInstanceOf(Date);
      const expected = new Date();
      expected.setDate(expected.getDate() + 3);
      expect(result?.getDate()).toBe(expected.getDate());
    });

    it('should parse "in X weeks"', () => {
      const result = parseDateString('in 2 weeks');
      expect(result).toBeInstanceOf(Date);
      const expected = new Date();
      expected.setDate(expected.getDate() + 14);
      expect(result?.getDate()).toBe(expected.getDate());
    });

    it('should parse "in X months"', () => {
      const result = parseDateString('in 1 month');
      expect(result).toBeInstanceOf(Date);
      const expected = new Date();
      expected.setMonth(expected.getMonth() + 1);
      expect(result?.getMonth()).toBe(expected.getMonth());
    });

    it('should parse ISO format', () => {
      const result = parseDateString('2025-01-27');
      expect(result).toBeInstanceOf(Date);
      expect(result?.getFullYear()).toBe(2025);
      expect(result?.getMonth()).toBe(0); // January is 0
      expect(result?.getDate()).toBe(27);
    });

    it('should return null for invalid input', () => {
      expect(parseDateString(null)).toBeNull();
      expect(parseDateString('')).toBeNull();
      expect(parseDateString('invalid date')).toBeNull();
    });
  });

  describe('parseTimeString', () => {
    it('should parse 24-hour format', () => {
      expect(parseTimeString('14:30')).toBe('14:30');
      expect(parseTimeString('09:00')).toBe('09:00');
    });

    it('should parse 12-hour format', () => {
      expect(parseTimeString('2:30 PM')).toBe('14:30');
      expect(parseTimeString('9:00 AM')).toBe('09:00');
      expect(parseTimeString('12:00 PM')).toBe('12:00');
      expect(parseTimeString('12:00 AM')).toBe('00:00');
    });

    it('should parse relative times', () => {
      expect(parseTimeString('morning')).toBe('09:00');
      expect(parseTimeString('afternoon')).toBe('14:00');
      expect(parseTimeString('evening')).toBe('18:00');
      expect(parseTimeString('night')).toBe('20:00');
    });

    it('should return null for invalid input', () => {
      expect(parseTimeString(null)).toBeNull();
      expect(parseTimeString('')).toBeNull();
      expect(parseTimeString('invalid time')).toBeNull();
    });
  });

  describe('calculateNotificationTime', () => {
    it('should calculate notification time correctly', () => {
      const dueDate = new Date('2025-01-27');
      const dueTime = '14:00';
      const result = calculateNotificationTime(dueDate, dueTime, 15);

      const expected = new Date('2025-01-27T14:00:00');
      expected.setMinutes(expected.getMinutes() - 15);

      expect(result.getTime()).toBe(expected.getTime());
    });
  });

  describe('applySystemLearning', () => {
    it('should return learning when pattern matches', async () => {
      setMockData('system_learning', [
        {
          id: 'learning-123',
          user_id: 'user-123',
          learning_type: 'task_duration_estimate',
          pattern: 'call family',
          pattern_data: { average_duration: 25 },
          confidence: 0.85,
          archived: false,
        },
      ]);

      const result = await applySystemLearning(
        'user-123',
        'task_duration_estimate',
        { taskDescription: 'Call mum', taskType: 'event' }
      );

      expect(result).not.toBeNull();
      expect(result?.pattern_data.average_duration).toBe(25);
      expect(result?.confidence).toBe(0.85);
    });

    it('should return null when no pattern matches', async () => {
      setMockData('system_learning', []);

      const result = await applySystemLearning(
        'user-123',
        'task_duration_estimate',
        { taskDescription: 'Review document', taskType: 'task' }
      );

      expect(result).toBeNull();
    });

    it('should return null when confidence too low', async () => {
      setMockData('system_learning', [
        {
          id: 'learning-123',
          user_id: 'user-123',
          learning_type: 'task_duration_estimate',
          pattern: 'call family',
          pattern_data: { average_duration: 25 },
          confidence: 0.5, // Below threshold
          archived: false,
        },
      ]);

      const result = await applySystemLearning(
        'user-123',
        'task_duration_estimate',
        { taskDescription: 'Call mum', taskType: 'event' }
      );

      expect(result).toBeNull();
    });
  });

  describe('buildActionEnrichmentPrompt', () => {
    it('should build prompt with task and artifact context', () => {
      const action = {
        title: 'Call mum',
        description: 'Follow up about dinner',
      };
      const artifact = {
        user_content: 'Need to call mum about dinner plans',
        content_subtype: 'note',
        created_at: '2025-01-26T10:00:00Z',
      };

      const prompt = buildActionEnrichmentPrompt(action, artifact);

      expect(prompt).toContain('Call mum');
      expect(prompt).toContain('Follow up about dinner');
      expect(prompt).toContain('Need to call mum about dinner plans');
      expect(prompt).toContain('note');
      expect(prompt).toContain('dueDate');
      expect(prompt).toContain('dueTime');
      expect(prompt).toContain('duration');
      expect(prompt).toContain('priority');
    });
  });

  describe('executeExtractActionsStep - Additional Edge Cases', () => {
    it('should create task without entity link when entity not found', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        user_id: 'user-123',
      });
      setMockData('artifacts', [artifact]);
      setMockData('user_tasks', []);
      setMockData('entities', []); // No entities
      setMockData('artifact_entity_links', []);

      const analysisResult = {
        intent: 'task',
        confidence: 0.9,
        entities_mentioned: [
          { name: 'Unknown Person', type: 'people', confidence: 0.9 },
        ],
        actions_suggested: [
          {
            title: 'Call Unknown Person',
            priority: 'medium',
          },
        ],
        topics: [],
        sentiment: 'neutral',
      };

      const result = await executeExtractActionsStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id), analysisResult);

      expect(result.success).toBe(true);
      const tasks = getMockData('user_tasks');
      expect(tasks[0].entity_id).toBeNull(); // No link created
    });

    it('should create task with past due date', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        user_id: 'user-123',
      });
      setMockData('artifacts', [artifact]);
      setMockData('user_tasks', []);

      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);
      const pastDateString = pastDate.toISOString().split('T')[0];

      const analysisResult = {
        intent: 'task',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [
          {
            title: 'Overdue task',
            priority: 'medium',
            dueDate: pastDateString,
          },
        ],
        topics: [],
        sentiment: 'neutral',
      };

      const result = await executeExtractActionsStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id), analysisResult);

      expect(result.success).toBe(true);
      const tasks = getMockData('user_tasks');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].due_date).toBe(pastDateString);
    });

    it('should not create reminder notification for past dates', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        user_id: 'user-123',
      });
      setMockData('artifacts', [artifact]);
      setMockData('user_tasks', []);
      setMockData('system_decisions', []);

      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);
      const pastDateString = pastDate.toISOString().split('T')[0];

      const analysisResult = {
        intent: 'reminder',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [
          {
            title: 'Remind me about past event',
            priority: 'medium',
            dueDate: pastDateString,
            suggestedDuration: 20,
          },
        ],
        topics: [],
        sentiment: 'neutral',
      };

      const result = await executeExtractActionsStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id), analysisResult);

      expect(result.success).toBe(true);
      const tasks = getMockData('user_tasks');
      expect(tasks).toHaveLength(1);

      // Should not create reminder notification for past dates
      const decisions = getMockData('system_decisions');
      const reminder = decisions.find((d: any) => d.decision_type === 'task_reminder');
      expect(reminder).toBeUndefined();
    });

    it('should handle invalid date format gracefully', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        user_id: 'user-123',
      });
      setMockData('artifacts', [artifact]);
      setMockData('user_tasks', []);

      const analysisResult = {
        intent: 'task',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [
          {
            title: 'Task with invalid date',
            priority: 'medium',
            dueDate: 'invalid-date-format',
          },
        ],
        topics: [],
        sentiment: 'neutral',
      };

      const result = await executeExtractActionsStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id), analysisResult);

      expect(result.success).toBe(true);
      const tasks = getMockData('user_tasks');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].due_date).toBeNull(); // Invalid date should be null
    });

    it('should handle multiple actions and process all', async () => {
      const step = createMockWorkflowStep();
      const artifact = createMockArtifact({
        id: TEST_ARTIFACT_ID,
        user_id: 'user-123',
      });
      setMockData('artifacts', [artifact]);
      setMockData('user_tasks', []);

      const analysisResult = {
        intent: 'task',
        confidence: 0.9,
        entities_mentioned: [],
        actions_suggested: [
          {
            title: 'Task 1',
            priority: 'high',
          },
          {
            title: 'Task 2',
            priority: 'medium',
          },
          {
            title: 'Task 3',
            priority: 'low',
          },
        ],
        topics: [],
        sentiment: 'neutral',
      };

      const result = await executeExtractActionsStep(step, ArtifactId.parse(TEST_ARTIFACT_ID), StepId.parse(step.id), analysisResult);

      expect(result.success).toBe(true);
      expect(result.tasksCreated).toHaveLength(3);
      const tasks = getMockData('user_tasks');
      expect(tasks).toHaveLength(3);
      expect(tasks.map((t: any) => t.title)).toEqual(['Task 1', 'Task 2', 'Task 3']);
    });
  });
});


