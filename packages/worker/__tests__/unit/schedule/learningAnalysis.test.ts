/**
 * Unit tests for the periodic batch learning analysis cadence (issue #948).
 *
 * Proves the production trigger actually invokes `runBatchLearningAnalysis`,
 * records the outcome to `scheduler_runs` under the 'learning' cadence, never
 * throws (a failure is recorded, not propagated), and that the scheduler
 * entry point drives it (once immediately, then on its interval) only when
 * enabled — mirroring `schedule/dedupSweep.test.ts`.
 */

// `runBatchLearningAnalysis` is the collaborator under test — mock just that
// export so the cadence's own logic (record-run shape, error isolation,
// scheduler gating) is what we exercise.
jest.mock('../../../src/learning/analyze', () => ({
	runBatchLearningAnalysis: jest.fn(),
}));
// The lock + run-log talk to scheduler_locks / scheduler_runs (not in the DB
// mock's table set); stub them so the cadence logic is isolated.
jest.mock('../../../src/schedule/lock');
jest.mock('../../../src/schedule/runLog');

import { runBatchLearningAnalysis } from '../../../src/learning/analyze';
import { withLock } from '../../../src/schedule/lock';
import { recordRun } from '../../../src/schedule/runLog';
import {
	runLearningAnalysisCadence,
	startLearningAnalysisScheduler,
} from '../../../src/schedule/learningAnalysis';

const runBatchMock = runBatchLearningAnalysis as jest.MockedFunction<typeof runBatchLearningAnalysis>;
const withLockMock = withLock as jest.MockedFunction<typeof withLock>;
const recordRunMock = recordRun as jest.MockedFunction<typeof recordRun>;

beforeEach(() => {
	jest.clearAllMocks();
	recordRunMock.mockResolvedValue(undefined);
	delete process.env.KMS_LEARNING_ANALYSIS_ENABLED;
	delete process.env.KMS_LEARNING_ANALYSIS_INTERVAL_MINUTES;
});

describe('runLearningAnalysisCadence', () => {
	it('runs the batch analysis and records a successful run with its summary', async () => {
		runBatchMock.mockResolvedValue({ users: 3, errors: 0 });

		const summary = await runLearningAnalysisCadence();

		expect(runBatchMock).toHaveBeenCalledTimes(1);
		expect(summary).toEqual({ users: 3, errors: 0 });
		expect(recordRunMock).toHaveBeenCalledWith(
			expect.objectContaining({
				cadence: 'learning',
				counts: { users: 3, errors: 0 },
				error: undefined,
			}),
		);
	});

	it('records a descriptive error when some users failed but does not throw', async () => {
		runBatchMock.mockResolvedValue({ users: 3, errors: 2 });

		const summary = await runLearningAnalysisCadence();

		expect(summary).toEqual({ users: 3, errors: 2 });
		expect(recordRunMock).toHaveBeenCalledWith(
			expect.objectContaining({ cadence: 'learning', error: '2 user(s) failed' }),
		);
	});

	it('records an error run and does not throw when the batch analysis rejects (e.g. enumeration failure)', async () => {
		runBatchMock.mockRejectedValue(new Error('db down'));

		const summary = await runLearningAnalysisCadence();

		expect(summary).toEqual({ users: 0, errors: 1 });
		expect(recordRunMock).toHaveBeenCalledWith(
			expect.objectContaining({ cadence: 'learning', counts: {}, error: 'db down' }),
		);
	});
});

describe('startLearningAnalysisScheduler', () => {
	beforeEach(() => {
		jest.useFakeTimers();
		withLockMock.mockResolvedValue({ skipped: true });
	});

	afterEach(() => {
		jest.clearAllTimers();
		jest.useRealTimers();
	});

	it('does nothing when KMS_LEARNING_ANALYSIS_ENABLED is not set', () => {
		const handle = startLearningAnalysisScheduler();

		jest.advanceTimersByTime(24 * 60 * 60 * 1000);

		expect(handle).toBeNull();
		expect(withLockMock).not.toHaveBeenCalled();
	});

	it('runs the cadence immediately under the learning lock when enabled', () => {
		process.env.KMS_LEARNING_ANALYSIS_ENABLED = 'true';

		const handle = startLearningAnalysisScheduler();

		expect(handle).not.toBeNull();
		expect(withLockMock).toHaveBeenCalledTimes(1);
		expect(withLockMock).toHaveBeenCalledWith('learning', runLearningAnalysisCadence);
		clearInterval(handle as NodeJS.Timeout);
	});

	it('re-runs the cadence on its configured interval', () => {
		process.env.KMS_LEARNING_ANALYSIS_ENABLED = 'true';
		process.env.KMS_LEARNING_ANALYSIS_INTERVAL_MINUTES = '10';

		const handle = startLearningAnalysisScheduler();
		withLockMock.mockClear();

		jest.advanceTimersByTime(10 * 60 * 1000 - 1);
		expect(withLockMock).not.toHaveBeenCalled();

		jest.advanceTimersByTime(1);
		expect(withLockMock).toHaveBeenCalledWith('learning', runLearningAnalysisCadence);

		clearInterval(handle as NodeJS.Timeout);
	});

	it('defaults to a 1440-minute (daily) interval when none is configured', () => {
		process.env.KMS_LEARNING_ANALYSIS_ENABLED = 'true';

		const handle = startLearningAnalysisScheduler();
		withLockMock.mockClear();

		jest.advanceTimersByTime(24 * 60 * 60 * 1000 - 1);
		expect(withLockMock).not.toHaveBeenCalled();

		jest.advanceTimersByTime(1);
		expect(withLockMock).toHaveBeenCalledTimes(1);

		clearInterval(handle as NodeJS.Timeout);
	});
});
