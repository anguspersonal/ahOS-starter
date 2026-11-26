/**
 * Periodic batch learning analysis (issue #948).
 *
 * `runBatchLearningAnalysis` (`learning/analyze.ts`) has had no caller since
 * it was written — not from `schedule/`, not dynamically — so its five
 * pattern analysers have never run and `system_learning` has never
 * accumulated a row. This is the production trigger: on a fixed cadence it
 * runs the batch pass and records the outcome, following the exact shape
 * `runDedupSweep` (`dedupSweep.ts`, #396) and `runAlertEvaluation`
 * (`alertEvaluator.ts`, #573) already use — an env-gated interval on the
 * always-on worker host, single-flight via a `scheduler_locks` row, and
 * per-run history in `scheduler_runs` (migration 103 seeds the 'learning'
 * cadence).
 *
 * This closes the *write* half of the correction loop's second broken joint
 * ("the analyser has no caller"). Consuming what it writes back into a
 * decision path — `learning/apply.ts`'s `applySystemLearning`, imported but
 * never invoked by `workflows/steps/extractActions.ts` — is deliberately
 * NOT touched here: that call site carries its own documented reason the
 * lookup stays disabled (the only writer of a task's duration is that same
 * step's own AI estimate, so wiring the read back would have the analyser
 * average the step's guesses and hand them back as "learned" — the ritual's
 * output becoming its own input). #948 calls that half a separate design
 * question, not a wiring one; this cadence only makes the write side run.
 */
import { logger } from '../utils/logger';
import { runBatchLearningAnalysis } from '../learning/analyze';
import { withLock } from './lock';
import { recordRun } from './runLog';

const DEFAULT_INTERVAL_MINUTES = 1440; // daily, matching dedup/alerts

export interface LearningAnalysisCadenceSummary {
	users: number;
	errors: number;
}

/**
 * One cadence run: execute the batch learning pass and record the outcome.
 * Never throws — matches `runDedupSweep`/`runAlertEvaluation` so a failure
 * here can't take the worker process down; it is recorded as an error run
 * instead. Single-flight is applied by the scheduler (via `withLock`), not
 * here, matching the other two cadences' shape.
 */
export async function runLearningAnalysisCadence(): Promise<LearningAnalysisCadenceSummary> {
	const startedAt = new Date();

	try {
		const summary = await runBatchLearningAnalysis();
		await recordRun({
			cadence: 'learning',
			startedAt,
			counts: summary as unknown as Record<string, unknown>,
			error: summary.errors > 0 ? `${summary.errors} user(s) failed` : undefined,
		});
		logger.info('[LearningAnalysis] cadence complete', summary);
		return summary;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.error('[LearningAnalysis] cadence failed', { error: message });
		await recordRun({ cadence: 'learning', startedAt, counts: {}, error: message });
		return { users: 0, errors: 1 };
	}
}

/**
 * Read scheduler config at call time (not module load) so tests and deploys
 * can set env before starting. Off by default: unset or any value other than
 * "true" leaves the cadence disabled, so running the worker locally never
 * starts analysing on a timer.
 *
 * Deploy owner note (standing lesson from #505/#613): this env var is a
 * deploy-level switch. Setting it in code is not enough — it must also be
 * set on the actual worker host (Railway) for the cadence to ever run there.
 */
function readSchedulerEnv() {
	return {
		enabled: process.env.KMS_LEARNING_ANALYSIS_ENABLED === 'true',
		intervalMinutes: Number(
			process.env.KMS_LEARNING_ANALYSIS_INTERVAL_MINUTES ?? DEFAULT_INTERVAL_MINUTES,
		),
	};
}

/**
 * Start the periodic batch learning analysis on the worker host. No-op
 * unless KMS_LEARNING_ANALYSIS_ENABLED=true. Runs once immediately so a
 * deploy's effect is visible without waiting a full interval, then on the
 * configured cadence. Each tick runs under the shared `scheduler_locks`
 * single-flight guard.
 *
 * Returns the interval handle (or null when disabled) so a host can clear it.
 */
export function startLearningAnalysisScheduler(): NodeJS.Timeout | null {
	const env = readSchedulerEnv();
	if (!env.enabled) {
		logger.info(
			"learning analysis: KMS_LEARNING_ANALYSIS_ENABLED is not 'true' — learning cadence disabled",
		);
		return null;
	}

	const intervalMs = env.intervalMinutes * 60 * 1000;
	const tick = () => {
		withLock('learning', runLearningAnalysisCadence).catch((err) =>
			console.error('learning analysis tick failed:', err),
		);
	};

	logger.info(`learning analysis: enabled — running every ${env.intervalMinutes}m`);
	tick();
	return setInterval(tick, intervalMs);
}
