import { randomUUID } from "node:crypto";
import {
	executeAction,
	type DriveHygieneHealResult,
	type WeeklyKpiSnapshotResult,
} from "@ahkms/core";
import { serverRegistry } from "../actions/serverRegistry.js";
import { getCurrentUserId } from "../identity.js";
import { env } from "./env.js";
import { withLock } from "./lock.js";
import { recordRun } from "./runLog.js";
import { runDiscoverCadence } from "./discoverCadence.js";
import { runEnrichCadence } from "./enrichCadence.js";
import { runNotionAutomationsCadence } from "./notionAutomationsCadence.js";
import { runGmailAutomationsCadence } from "./gmailCadence.js";
import { runGmailTriageSweep, runJobHuntGmailSweep } from "@ahkms/core/engine";

// Email pipeline (ADR-118). The sweep lives in core's engine; this only supplies the
// server registry (whose gmail_priority_triage port holds the Gmail and Notion wiring)
// and records the run.
export async function runGmailTriageCadence(): Promise<void> {
	const startedAt = new Date();
	const result = await runGmailTriageSweep({
		userId: getCurrentUserId(),
		registry: serverRegistry(),
		mode: env.gmailTriageMode,
		maxThreads: env.gmailTriageMaxThreads,
		attentionBudget: env.gmailTriageAttentionBudget,
	});
	if (result.error) console.error("gmail triage cadence:", result.error);
	await recordRun({
		cadence: "gmail_automations",
		connector: "gmail_triage",
		startedAt,
		counts: result.counts,
		error: result.error,
	});
}

/**
 * Run one job-hunt personal-mailbox (`angus`) Gmail ingestion sweep (ADR-120 Phase 2, #2452)
 * inside the shared `gmail_automations` lock and record its metrics under `connector: "job_hunt_gmail"`.
 */
export async function runJobHuntGmailCadence(): Promise<void> {
	const startedAt = new Date();
	const result = await runJobHuntGmailSweep({
		userId: getCurrentUserId(),
		registry: serverRegistry(),
		mode: env.jobHuntGmailMode,
		maxMessages: env.jobHuntGmailMaxMessages,
	});
	if (result.error) console.error("job hunt gmail cadence:", result.error);
	await recordRun({
		cadence: "gmail_automations",
		connector: "job_hunt_gmail",
		startedAt,
		counts: result.counts,
		error: result.error,
	});
}

export async function runDriveHygieneCadence(): Promise<void> {
	const startedAt = new Date();
	try {
		const registry = serverRegistry();
		const healAction = registry.get("drive_hygiene_heal");
		if (!healAction) {
			throw new Error('Action "drive_hygiene_heal" not found in serverRegistry');
		}

		const userId = getCurrentUserId();
		const traceId = randomUUID();
		const healRequestId = randomUUID();

		const healResult = (await executeAction(
			healAction,
			{
				provider: "both",
				gdrive_domains: ["angus"],
				max_actions: env.driveHygieneMaxActions,
				dry_run: false,
			},
			{
				context: {
					caller: "worker",
					userId,
					requestId: healRequestId,
					traceId,
				},
			},
		)) as DriveHygieneHealResult;

		let snapshotWeekKey: string | null = null;
		let snapshotArtifactId: string | null = null;
		let cloudStorageHygienePct: number | null = null;
		let snapshotError: string | undefined;

		const snapshotAction = registry.get("weekly_kpi_snapshot");
		if (snapshotAction) {
			try {
				const snapshotResult = (await executeAction(
					snapshotAction,
					{
						window_days: 7,
						include_drives: true,
						include_system_doctor: false,
						record_snapshot: true,
					},
					{
						context: {
							caller: "worker",
							userId,
							requestId: randomUUID(),
							parentRequestId: healRequestId,
							traceId,
						},
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

		await recordRun({
			cadence: "dedup",
			connector: "drive_hygiene",
			startedAt,
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
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("drive hygiene cadence failed:", message);
		await recordRun({
			cadence: "dedup",
			connector: "drive_hygiene",
			startedAt,
			counts: {},
			error: message,
		});
	}
}

// Starts the Discover & Index scheduled cadences (ADR-016 Slice 3, #53). Only
// called from the HTTP entry point (http.ts) — the stdio entry point (index.ts,
// used by Claude Desktop) is a short-lived per-session subprocess, not the
// always-on host these cadences need. No-op unless KMS_SCHEDULER_ENABLED=true.
export function startScheduler(): void {
	if (!env.enabled) {
		console.error("scheduler: KMS_SCHEDULER_ENABLED is not 'true' — discover/enrich cadences disabled");
		return;
	}

	const discoverMs = env.discoverIntervalMinutes * 60 * 1000;
	const enrichMs = env.enrichIntervalMinutes * 60 * 1000;

	const tickDiscover = () => {
		withLock("discover", runDiscoverCadence).catch((err) =>
			console.error("discover cadence tick failed:", err),
		);
	};
	const tickEnrich = () => {
		withLock("enrich", runEnrichCadence).catch((err) =>
			console.error("enrich cadence tick failed:", err),
		);
	};

	console.error(
		`scheduler: enabled — ingest_discover(drive + notion${env.gmailAttachmentDiscoverEnabled ? ` + gmail attachments, ${env.gmailAttachmentDiscoverMaxMessages} messages/account/run` : ""}) every ${env.discoverIntervalMinutes}m, enrich every ${env.enrichIntervalMinutes}m (limit ${env.enrichBatchLimit})`,
	);
	if (!env.gmailAttachmentDiscoverEnabled) {
		console.error(
			"scheduler: KMS_GMAIL_ATTACHMENT_DISCOVER_ENABLED is not 'true': gmail attachment discover disabled",
		);
	}

	// Run once immediately so a deploy's effect is visible without waiting for the
	// first full interval, then on the configured cadence thereafter.
	tickDiscover();
	tickEnrich();
	setInterval(tickDiscover, discoverMs);
	setInterval(tickEnrich, enrichMs);

	// Notion automations reconciliation sweep (#546 / ADR-048): its own explicit
	// opt-in on top of the master switch — this cadence WRITES to the personal
	// Notion workspace, so it never rides along silently with discover/enrich.
	if (env.notionAutomationsEnabled) {
		const automationsMs = env.notionAutomationsIntervalMinutes * 60 * 1000;
		const tickNotionAutomations = () => {
			withLock("notion_automations", runNotionAutomationsCadence).catch((err) =>
				console.error("notion automations cadence tick failed:", err),
			);
		};
		console.error(
			`scheduler: notion automations sweep enabled — every ${env.notionAutomationsIntervalMinutes}m`,
		);
		tickNotionAutomations();
		setInterval(tickNotionAutomations, automationsMs);
	} else {
		console.error(
			"scheduler: KMS_NOTION_AUTOMATIONS_ENABLED is not 'true' — notion automations sweep disabled",
		);
	}

	const combineAutomationsWithPipelines =
		env.gmailAutomationsEnabled &&
		(env.gmailTriageEnabled || env.jobHuntGmailEnabled) &&
		env.gmailAutomationsIntervalMinutes === env.gmailTriageIntervalMinutes;

	// Gmail automations reconciliation sweep (#356): its own explicit opt-in
	// on top of the master switch. This cadence modifies Gmail labels and archives
	// resolved threads, so it never rides along silently with discover/enrich.
	if (env.gmailAutomationsEnabled && !combineAutomationsWithPipelines) {
		const gmailMs = env.gmailAutomationsIntervalMinutes * 60 * 1000;
		const tickGmailAutomations = () => {
			withLock("gmail_automations", runGmailAutomationsCadence).catch((err) =>
				console.error("gmail automations cadence tick failed:", err),
			);
		};
		console.error(
			`scheduler: gmail automations sweep enabled: every ${env.gmailAutomationsIntervalMinutes}m`,
		);
		tickGmailAutomations();
		setInterval(tickGmailAutomations, gmailMs);
	} else if (!env.gmailAutomationsEnabled) {
		console.error(
			"scheduler: KMS_GMAIL_AUTOMATIONS_ENABLED is not 'true': gmail automations sweep disabled",
		);
	}

	// Email pipeline (ADR-118) + job-hunt personal-mailbox Gmail ingestion (ADR-120 Phase 2, #2452):
	// Run all enabled connectors sharing the `gmail_automations` lock sequentially inside a single
	// `withLock("gmail_automations", ...)` callback with independent try/catch isolation per
	// connector (mirroring discoverCadence) so non-blocking lock acquisition never starves a sibling.
	if (env.gmailTriageEnabled || env.jobHuntGmailEnabled) {
		const pipelineMs = env.gmailTriageIntervalMinutes * 60 * 1000;
		const tickGmailPipelines = () => {
			withLock("gmail_automations", async () => {
				if (combineAutomationsWithPipelines) {
					try {
						await runGmailAutomationsCadence();
					} catch (err) {
						console.error("gmail automations cadence failed:", err);
					}
				}
				if (env.gmailTriageEnabled) {
					try {
						await runGmailTriageCadence();
					} catch (err) {
						console.error("gmail triage cadence failed:", err);
					}
				}
				if (env.jobHuntGmailEnabled) {
					try {
						await runJobHuntGmailCadence();
					} catch (err) {
						console.error("job hunt gmail cadence failed:", err);
					}
				}
			}).catch((err) => console.error("gmail pipelines cadence tick failed:", err));
		};
		if (combineAutomationsWithPipelines) {
			console.error(
				`scheduler: gmail automations sweep enabled (shared tick): every ${env.gmailAutomationsIntervalMinutes}m`,
			);
		}
		if (env.gmailTriageEnabled) {
			console.error(
				`scheduler: gmail triage enabled: every ${env.gmailTriageIntervalMinutes}m in '${env.gmailTriageMode}' mode`,
			);
		} else {
			console.error("scheduler: KMS_GMAIL_TRIAGE_ENABLED is 'false': gmail triage disabled");
		}
		if (env.jobHuntGmailEnabled) {
			console.error(
				`scheduler: job hunt gmail ingest enabled: every ${env.gmailTriageIntervalMinutes}m in '${env.jobHuntGmailMode}' mode`,
			);
		} else {
			console.error(
				"scheduler: KMS_JOB_HUNT_GMAIL_ENABLED is not 'true': job hunt gmail ingest disabled",
			);
		}
		tickGmailPipelines();
		setInterval(tickGmailPipelines, pipelineMs);
	} else {
		console.error("scheduler: KMS_GMAIL_TRIAGE_ENABLED is 'false': gmail triage disabled");
		console.error(
			"scheduler: KMS_JOB_HUNT_GMAIL_ENABLED is not 'true': job hunt gmail ingest disabled",
		);
	}

	// Stage 7A Cloud Drive Band 1 self-heal + KMS Weekly Scorecard snapshot cadence (ADR-115).
	// Runs under the seeded "dedup" lock and is enabled by default whenever KMS_SCHEDULER_ENABLED=true
	// (override with KMS_DRIVE_HYGIENE_ENABLED=false).
	if (env.driveHygieneEnabled) {
		const driveHygieneMs = env.driveHygieneIntervalMinutes * 60 * 1000;
		const tickDriveHygiene = () => {
			withLock("dedup", runDriveHygieneCadence).catch((err) =>
				console.error("drive hygiene cadence tick failed:", err),
			);
		};
		console.error(
			`scheduler: drive hygiene sweep enabled: every ${env.driveHygieneIntervalMinutes}m (max_actions ${env.driveHygieneMaxActions})`,
		);
		tickDriveHygiene();
		setInterval(tickDriveHygiene, driveHygieneMs);
	} else {
		console.error(
			"scheduler: KMS_DRIVE_HYGIENE_ENABLED is 'false': drive hygiene sweep disabled",
		);
	}
}
