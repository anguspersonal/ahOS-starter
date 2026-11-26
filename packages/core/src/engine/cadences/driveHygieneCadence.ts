import { randomUUID } from "node:crypto";
import type { CadenceDefinition } from "../runner.js";
import {
	createDriveHygieneHealAction,
	type DriveHygieneHealResult,
} from "../../actions/metrics/driveHygieneHeal.js";
import {
	createWeeklyKpiSnapshotAction,
	type WeeklyKpiSnapshotPorts,
	type WeeklyKpiSnapshotResult,
} from "../../actions/metrics/weeklyKpiSnapshot.js";
import { executeAction } from "../../actions/adapters/direct.js";
import type { ActionAuditSink, ActionDefinition } from "../../actions/types.js";

export const DRIVE_HYGIENE_CADENCE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DRIVE_HYGIENE_DEFAULT_MAX_ACTIONS = 500;

export interface ActionLookupPort {
	get(id: string): ActionDefinition<any, any> | undefined;
}

export interface DriveHygieneSweepOptions {
	userId: string;
	registry?: ActionLookupPort;
	ports?: WeeklyKpiSnapshotPorts;
	maxActions?: number;
	gdriveDomains?: Array<"angus" | "work">;
	windowDays?: number;
	includeSystemDoctor?: boolean;
	auditSink?: ActionAuditSink;
}

export interface DriveHygieneSweepCounts {
	candidates_found: number;
	planned_within_cap: number;
	executed_count: number;
	failed_count: number;
	skipped_cap_count: number;
	reclaimed_bytes: number;
	by_lever: DriveHygieneHealResult["summary"]["by_lever"];
	week_key: string | null;
	cloud_storage_hygiene_pct: number | null;
	snapshot_artifact_id: string | null;
	[key: string]: unknown;
}

export interface DriveHygieneSweepResult {
	counts: DriveHygieneSweepCounts;
	error?: string;
}

/**
 * Executes a single Stage 7A autonomous Band 1 (>= 0.99 confidence, zero-HITL)
 * Cloud Drive self-healing sweep followed by an idempotent KMS Weekly Scorecard
 * (`kpi_weekly:<YYYY-Www>`) snapshot refresh (ADR-115).
 */
export async function runDriveHygieneSweep(
	options: DriveHygieneSweepOptions,
): Promise<DriveHygieneSweepResult> {
	const healAction =
		options.registry?.get("drive_hygiene_heal") ??
		(options.ports
			? createDriveHygieneHealAction({
					onedrive: options.ports.onedrive,
					drive: options.ports.drive,
				})
			: undefined);

	if (!healAction) {
		throw new Error('Action "drive_hygiene_heal" not found in registry or ports');
	}

	const maxActions = options.maxActions ?? DRIVE_HYGIENE_DEFAULT_MAX_ACTIONS;
	const gdriveDomains = options.gdriveDomains ?? ["angus"];
	const windowDays = options.windowDays ?? 7;
	const includeSystemDoctor = options.includeSystemDoctor ?? false;
	const traceId = randomUUID();
	const healRequestId = randomUUID();

	const healResult = (await executeAction(
		healAction,
		{
			provider: "both",
			gdrive_domains: gdriveDomains,
			max_actions: maxActions,
			dry_run: false,
		},
		{
			context: {
				caller: "worker",
				userId: options.userId,
				requestId: healRequestId,
				traceId,
			},
			auditSink: options.auditSink,
		},
	)) as DriveHygieneHealResult;

	let snapshotWeekKey: string | null = null;
	let snapshotArtifactId: string | null = null;
	let cloudStorageHygienePct: number | null = null;
	let snapshotError: string | undefined;

	const snapshotAction =
		options.registry?.get("weekly_kpi_snapshot") ??
		(options.ports ? createWeeklyKpiSnapshotAction(options.ports) : undefined);

	if (snapshotAction) {
		try {
			const snapshotResult = (await executeAction(
				snapshotAction,
				{
					window_days: windowDays,
					include_drives: true,
					include_system_doctor: includeSystemDoctor,
					record_snapshot: true,
				},
				{
					context: {
						caller: "worker",
						userId: options.userId,
						requestId: randomUUID(),
						parentRequestId: healRequestId,
						traceId,
					},
					auditSink: options.auditSink,
				},
			)) as WeeklyKpiSnapshotResult;

			snapshotWeekKey = snapshotResult.week_key;
			snapshotArtifactId = snapshotResult.recorded_artifact?.artifact_id ?? null;
			const hygieneKpi = snapshotResult.composite_kpis?.find(
				(k) => k.id === "cloud_storage_hygiene_pct",
			);
			cloudStorageHygienePct = hygieneKpi?.value ?? null;
		} catch (err) {
			snapshotError = err instanceof Error ? err.message : String(err);
			console.error("drive hygiene cadence: weekly_kpi_snapshot failed:", snapshotError);
		}
	}

	const errorMessages: string[] = [];
	if (healResult.summary.failed_count > 0) {
		errorMessages.push(
			`${healResult.summary.failed_count} Band 1 operation(s) failed during drive_hygiene_heal`,
		);
	}
	if (snapshotError) {
		errorMessages.push(`weekly_kpi_snapshot failed: ${snapshotError}`);
	}

	return {
		counts: {
			candidates_found: healResult.summary.candidates_found,
			planned_within_cap: healResult.summary.planned_within_cap,
			executed_count: healResult.summary.executed_count,
			failed_count: healResult.summary.failed_count,
			skipped_cap_count: healResult.summary.skipped_cap_count,
			reclaimed_bytes: healResult.summary.reclaimed_bytes,
			by_lever: healResult.summary.by_lever,
			week_key: snapshotWeekKey,
			cloud_storage_hygiene_pct: cloudStorageHygienePct,
			snapshot_artifact_id: snapshotArtifactId,
		},
		error: errorMessages.length > 0 ? errorMessages.join("; ") : undefined,
	};
}

export interface DriveHygieneCadenceOptions {
	registry?: ActionLookupPort;
	ports?: WeeklyKpiSnapshotPorts;
	/**
	 * Resolves the owner user ids to execute Band 1 drive hygiene healing and weekly KPI snapshots for.
	 * The scheduled cadence never runs without an explicit owner (#1306 C1).
	 */
	resolveUserIds: () => Promise<string[]>;
	intervalMs?: number;
	maxActions?: number;
	gdriveDomains?: Array<"angus" | "work">;
	windowDays?: number;
	includeSystemDoctor?: boolean;
	enabled?: () => boolean;
	auditSink?: ActionAuditSink;
}

/**
 * Creates the Stage 7A Cloud Drive Band 1 self-healing + KMS Weekly Scorecard background
 * cadence definition (ADR-115, ADR-101 #1321).
 * Single-flight via scheduler_locks (`dedup`), run history via scheduler_runs.
 */
export function createDriveHygieneCadence(
	options: DriveHygieneCadenceOptions,
): CadenceDefinition {
	return {
		name: "dedup",
		intervalMs: options.intervalMs ?? DRIVE_HYGIENE_CADENCE_INTERVAL_MS,
		enabled: options.enabled ?? (() => true),
		run: async () => {
			const userIds = [...new Set((await options.resolveUserIds()).filter(Boolean))];
			if (userIds.length === 0) {
				throw new Error("dedup (drive_hygiene) cadence has no owner user id configured (set KMS_USER_ID)");
			}

			const totals = {
				users: userIds.length,
				candidates_found: 0,
				planned_within_cap: 0,
				executed_count: 0,
				failed_count: 0,
				skipped_cap_count: 0,
				reclaimed_bytes: 0,
				errors: 0,
			};

			for (const userId of userIds) {
				try {
					const res = await runDriveHygieneSweep({
						userId,
						registry: options.registry,
						ports: options.ports,
						maxActions: options.maxActions,
						gdriveDomains: options.gdriveDomains,
						windowDays: options.windowDays,
						includeSystemDoctor: options.includeSystemDoctor,
						auditSink: options.auditSink,
					});
					totals.candidates_found += res.counts.candidates_found;
					totals.planned_within_cap += res.counts.planned_within_cap;
					totals.executed_count += res.counts.executed_count;
					totals.failed_count += res.counts.failed_count;
					totals.skipped_cap_count += res.counts.skipped_cap_count;
					totals.reclaimed_bytes += res.counts.reclaimed_bytes;
					if (res.error) {
						totals.errors++;
					}
				} catch (err) {
					totals.errors++;
					console.error(`[dedup/drive_hygiene] run failed for user ${userId}:`, err);
				}
			}

			return totals;
		},
	};
}
