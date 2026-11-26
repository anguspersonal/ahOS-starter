import { applySystemLearning } from '../../../src/learning/apply';
import { patternMatches } from '../../../src/learning/patternMatches';
import { resetMockData, setMockData } from '../../__mocks__/supabase';

jest.mock('../../../src/utils/supabase');

describe('learning/patternMatches', () => {
	it('matches on at least one meaningful keyword (case-insensitive)', () => {
		expect(patternMatches('call family', 'Call mum')).toBe(true);
		expect(patternMatches('family', 'Call mum')).toBe(false);
	});

	it('treats underscores as spaces', () => {
		expect(patternMatches('call_family', 'Call mum')).toBe(true);
	});
});

describe('learning/applySystemLearning', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		resetMockData();
	});

	it('returns null when no learnings exist', async () => {
		setMockData('system_learning', []);
		const result = await applySystemLearning('user-123', 'task_duration_estimate', {
			taskDescription: 'Call mum',
			taskType: 'task',
		});
		expect(result).toBeNull();
	});

	it('returns null when confidence below threshold', async () => {
		setMockData('system_learning', [
			{
				id: 'learning-1',
				user_id: 'user-123',
				learning_type: 'task_duration_estimate',
				pattern: 'call family',
				pattern_data: { average_duration: 25 },
				confidence: 0.5,
				archived: false,
			},
		]);
		const result = await applySystemLearning('user-123', 'task_duration_estimate', {
			taskDescription: 'Call mum',
			taskType: 'task',
		});
		expect(result).toBeNull();
	});

	it('returns learning when pattern matches and confidence high enough', async () => {
		setMockData('system_learning', [
			{
				id: 'learning-1',
				user_id: 'user-123',
				learning_type: 'task_duration_estimate',
				pattern: 'call family',
				pattern_data: { average_duration: 25 },
				confidence: 0.85,
				archived: false,
			},
		]);
		const result = await applySystemLearning('user-123', 'task_duration_estimate', {
			taskDescription: 'Call mum',
			taskType: 'task',
		});
		expect(result).not.toBeNull();
		expect(result?.pattern_data.average_duration).toBe(25);
	});
});

