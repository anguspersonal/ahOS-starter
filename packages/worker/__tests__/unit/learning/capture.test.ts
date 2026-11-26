import { captureUserEdit } from '../../../src/learning/capture';
import { supabase } from '../../../src/utils/supabase';
import { resetMockData, getMockData } from '../../__mocks__/supabase';

jest.mock('../../../src/utils/supabase');

describe('learning/captureUserEdit', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		resetMockData();
	});

	it('inserts a user_edits record and returns its id', async () => {
		const id = await captureUserEdit(
			'user-123',
			'task_duration_correction',
			{ duration_minutes: 15 },
			{ duration_minutes: 30 },
			{
				artifactId: 'artifact-abc',
				entityId: 'entity-xyz',
				confidenceBefore: 60,
				source: 'test',
				additionalContext: { note: 'user corrected duration' },
			}
		);

		expect(typeof id).toBe('string');

		const edits = getMockData('user_edits');
		expect(edits).toHaveLength(1);
		expect(edits[0]).toMatchObject({
			user_id: 'user-123',
			edit_type: 'task_duration_correction',
			artifact_id: 'artifact-abc',
			entity_id: 'entity-xyz',
			confidence_before: 60,
		});
		expect(edits[0].original_value).toEqual({ duration_minutes: 15 });
		expect(edits[0].corrected_value).toEqual({ duration_minutes: 30 });
		expect(edits[0].edit_metadata?.source).toBe('test');
	});
});

