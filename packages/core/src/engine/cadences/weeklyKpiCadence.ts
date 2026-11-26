import type { CadenceDefinition } from "../runner.js";
import {
	createWeeklyKpiSnapshotAction,
	type WeeklyKpiSnapshotPorts,
} from "../../actions/metrics/weeklyKpiSnapshot.js";
import { executeAction } from "../../actions/adapters/direct.js";
import type { ActionAuditSink } from "../../actions/types.js";

export const WEEKLY_KPI_CADENCE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface WeeklyKpiCadenceOptions {
	ports: WeeklyKpiSnapshotPorts;
	/**
	 * Resolves the owner user ids to compute and persist the weekly KPI scorecard for.
	 * The scheduled cadence never runs without an explicit owner (#1306 C1).
	 */
	resolveUserIds: () => Promise<string[]>;
	intervalMs?: number;
	windowDays?: number;
	includeDrives?: boolean;
	includeSystemDoctor?: boolean;
	enabled?: () => boolean;
	auditSink?: ActionAuditSink;
}

/**
 * Creates the weekly KPI scorecard background cadence definition (ADR-115 Layer 4, ADR-101 #1321).
 * Single-flight via scheduler_locks, run history via scheduler_runs.
 * Runs `weekly_kpi_snapshot` per owner with `record_snapshot: true`, idempotently writing or
 * updating the weekly scorecard artifact (`kpi_weekly:<YYYY-Www>`) under surface `kpi_snapshot`.
 */
export function createWeeklyKpiCadence(options: WeeklyKpiCadenceOptions): CadenceDefinition {
	const windowDays = options.windowDays ?? 7;
	const includeDrives = options.includeDrives ?? true;
	const includeSystemDoctor = options.includeSystemDoctor ?? false;

	return {
		name: "weekly_kpi_snapshot",
		intervalMs: options.intervalMs ?? WEEKLY_KPI_CADENCE_INTERVAL_MS,
		enabled: options.enabled ?? (() => true),
		run: async () => {
			const userIds = [...new Set((await options.resolveUserIds()).filter(Boolean))];
			if (userIds.length === 0) {
				throw new Error("weekly_kpi_snapshot cadence has no owner user id configured (set KMS_USER_ID)");
			}

			const totals = {
				users: userIds.length,
				recorded: 0,
				deduplicated: 0,
				updated: 0,
				warnings: 0,
				errors: 0,
			};

			for (const userId of userIds) {
				try {
					const result = await executeAction(
						createWeeklyKpiSnapshotAction(options.ports),
						{
							window_days: windowDays,
							include_drives: includeDrives,
							include_system_doctor: includeSystemDoctor,
							record_snapshot: true,
						},
						{
							context: { userId, caller: "worker" },
							auditSink: options.auditSink,
						},
					);
					if (result.recorded_artifact.recorded) {
						totals.recorded++;
					}
					if (result.recorded_artifact.deduplicated) {
						totals.deduplicated++;
					}
					if (result.recorded_artifact.updated) {
						totals.updated++;
					}
					totals.warnings += result.warnings.length;
				} catch (err) {
					totals.errors++;
					console.error(`[weekly_kpi_snapshot] run failed for user ${userId}:`, err);
				}
			}

			return totals;
		},
	};
}
