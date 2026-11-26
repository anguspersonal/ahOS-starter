import { z } from "zod";
import { ARTIFACT_SURFACES } from "../../domain/artifacts.js";
import type { Domain } from "../../domain/domains.js";
import { WEEKLY_KPI_SCORECARD_CONTENT_SUBTYPE } from "../../domain/vocab.js";
import type { ArtifactsPort } from "../../ports/artifacts.js";
import type { CleanStatePort } from "../../ports/cleanState.js";
import type { DoctorPort } from "../../ports/doctor.js";
import { LIST_FIELDS, type DrivePort } from "../../ports/drive.js";
import type { LedgerReadPort } from "../../ports/ledger.js";
import type { OneDriveItem, OneDrivePort } from "../../ports/onedrive.js";
import type { ReviewPort } from "../../ports/review.js";
import type { TasksPort } from "../../ports/tasks.js";
import { evaluateArtifactCleanState } from "../artifacts/cleanStateCheck.js";
import { DOCTOR_FAMILIES, type DoctorCheck, verdictFor } from "../config/doctorReport.js";
import { defineAction } from "../defineAction.js";
import { parseCounterCopyFileName } from "../onedrive/audit.js";
import {
	buildGDriveFolderNodesFromInventory,
	classifyFolderCollisions,
	walkOneDriveFolders,
	type FolderHygieneSummary,
} from "../onedrive/folderCollisions.js";
import type { ActionContext, ActionDefinition } from "../types.js";

export { WEEKLY_KPI_SCORECARD_CONTENT_SUBTYPE };

/**
 * Semantic version of the Composite KPI definitions and weighting formulas.
 * Bumping this constant triggers retroactive recomputation of historical snapshots
 * via `recomputeSnapshotKpis()` while preserving `stored_kpi_config_version`.
 */
export const KPI_CONFIG_VERSION = "2.0.0" as const;

export const weeklyKpiSnapshotInput = {
	window_days: z
		.number()
		.int()
		.min(1)
		.max(90)
		.optional()
		.describe("Lookback window in days for weekly velocity and health metrics (default 7, max 90)."),
	include_drives: z
		.boolean()
		.optional()
		.describe(
			"When true (default), query OneDrive Personal and Google Drive (angus + work) quota, top-level folders, duplicate confidence bands, and parity highlights.",
		),
	include_system_doctor: z
		.boolean()
		.optional()
		.describe("When true (default false), run ahos_doctor checks and include the verdict in system_and_ledger."),
	record_snapshot: z
		.boolean()
		.optional()
		.describe(
			"When true (default), persist or update the weekly scorecard artifact in ahKMS under dedup_key 'kpi_weekly:<YYYY-Www>' with surface 'kpi_snapshot' (role 'metrics'). Set false for dry-run inspection.",
		),
	week_key: z
		.string()
		.trim()
		.regex(/^\d{4}-W\d{2}$/, "week_key must match ISO week format YYYY-Www (e.g. '2026-W44')")
		.optional()
		.describe("Optional ISO week key override (e.g. '2026-W44'). Defaults to the current UTC ISO week."),
};

export const weeklyKpiSnapshotSchema = z.object(weeklyKpiSnapshotInput);
export type WeeklyKpiSnapshotInput = z.infer<typeof weeklyKpiSnapshotSchema>;

export type KpiConfidenceBand = "high" | "medium" | "low";
export type KpiHealthStatus = "healthy" | "warning" | "critical";

export interface DuplicateCandidateItem {
	id: string;
	name: string;
	parentKey: string;
	sizeBytes: number;
	hash: string | null;
}

export interface DriveDuplicateConfidenceMetrics {
	evaluated_file_count: number;
	hashed_file_count: number;
	high_confidence_same_folder: {
		clusters: number;
		redundant_files: number;
		reclaimable_bytes: number;
	};
	medium_confidence_cross_folder: {
		clusters: number;
		redundant_files: number;
		reclaimable_bytes: number;
	};
	low_confidence_version_families: {
		clusters: number;
		redundant_files: number;
	};
	total_exact_clusters: number;
	total_exact_redundant_files: number;
	total_reclaimable_bytes: number;
	duplicate_rate_pct: number;
	counter_copy_named_files?: number;
	os_junk_files?: number;
}

export interface OneDriveFolderSummary {
	name: string;
	size_bytes: number;
	child_count: number;
}

export interface OneDrivePersonalKpiSummary {
	status: "ok" | "degraded" | "skipped";
	quota: {
		total_bytes: number;
		used_bytes: number;
		remaining_bytes: number;
		deleted_bytes: number;
		used_pct: number;
		state: string;
	} | null;
	root_item_count: number;
	root_folder_count: number;
	root_file_count: number;
	top_folders: OneDriveFolderSummary[];
	tracked_folders: {
		to_sort: { size_bytes: number; child_count: number } | null;
		work_project: { size_bytes: number; child_count: number } | null;
	};
	duplicates?: DriveDuplicateConfidenceMetrics;
	folder_hygiene?: FolderHygieneSummary | null;
}

export interface GdriveDomainKpiSummary {
	domain: Domain;
	status: "ok" | "degraded" | "skipped";
	sampled_item_count: number;
	sampled_truncated: boolean;
	folder_count: number;
	file_count: number;
	google_native_count: number;
	binary_file_count: number;
	binary_bytes: number;
	root_item_count: number;
	root_folder_names: string[];
	duplicates?: DriveDuplicateConfidenceMetrics;
	folder_hygiene?: FolderHygieneSummary | null;
}

export interface CloudDrivesKpiSection {
	onedrive_personal: OneDrivePersonalKpiSummary;
	gdrive_personal: GdriveDomainKpiSummary;
	gdrive_work: GdriveDomainKpiSummary;
}

export interface KnowledgeAndCaptureKpiSection {
	window_days: number;
	artifacts_captured: number;
	by_surface: Record<string, number>;
	clean_state: {
		evaluated_count: number;
		ok: number;
		warn: number;
		fail: number;
		pass_rate_pct: number;
	};
	embedding_coverage: {
		with_embedding: number;
		missing_embedding: number;
		coverage_pct: number;
	};
	derivation: {
		completed: number;
		skipped: number;
		pending: number;
		failed: number;
	};
	graph_connectivity: {
		linked_artifacts: number;
		total_entity_links: number;
		total_structural_edges: number;
	};
	duplicates: {
		duplicate_group_count: number;
		redundant_artifact_count: number;
	};
}

export interface TasksAndGovernanceKpiSection {
	sampled_task_count: number;
	by_status: Record<string, number>;
	active_open_count: number;
	completed_in_window_count: number;
	overdue_count: number;
	pending_review_decisions: number;
}

export interface SystemAndLedgerKpiSection {
	window_days: number;
	total_invocations: number;
	success_count: number;
	error_count: number;
	pending_approval_count: number;
	success_rate_pct: number;
	top_actions: Array<{
		action_id: string;
		total: number;
		success: number;
		error: number;
		pending_approval: number;
	}>;
	ledger_row_estimate: number;
	ledger_total_bytes: number;
	doctor: {
		status: "ok" | "warn" | "fail";
		ok_count: number;
		warn_count: number;
		fail_count: number;
	} | null;
}

export interface CompositeKpiItem {
	id: string;
	name: string;
	pillar: "cloud_drives" | "knowledge" | "governance" | "system";
	value: number;
	unit: "%" | "files" | "GiB";
	target: string;
	status: KpiHealthStatus;
	confidence_band: KpiConfidenceBand;
	formula: string;
	kpi_config_version?: string;
	constituent_metrics: Record<string, number | string>;
}

export interface ConfidenceBandTierSummary {
	band: KpiConfidenceBand;
	confidence_range: ">=0.99" | "0.80-0.98" | "<0.80";
	execution_mode: "auto_heal_zero_hitl" | "rule_gated_batch" | "hitl_review_queue";
	clusters: number;
	redundant_files: number;
	reclaimable_bytes: number;
	description: string;
	recommended_action: string;
}

export interface SelfHealingSummary {
	schedule_window_days: number;
	total_reclaimable_bytes: number;
	total_redundant_files: number;
	auto_healable_pct: number;
	bands: {
		high_auto_heal: ConfidenceBandTierSummary;
		medium_rule_gated: ConfidenceBandTierSummary;
		low_hitl_review: ConfidenceBandTierSummary;
	};
}

export interface RecordedScorecardArtifact {
	recorded: boolean;
	artifact_id: string | null;
	dedup_key: string;
	surface: string;
	content_subtype: string;
	deduplicated: boolean;
	updated: boolean;
}

export interface WeeklyKpiSnapshotResult {
	week_key: string;
	window_days: number;
	generated_at: string;
	kpi_config_version?: string;
	stored_kpi_config_version?: string;
	cloud_drives: CloudDrivesKpiSection;
	knowledge_and_capture: KnowledgeAndCaptureKpiSection;
	tasks_and_governance: TasksAndGovernanceKpiSection;
	system_and_ledger: SystemAndLedgerKpiSection;
	composite_kpis?: CompositeKpiItem[];
	self_healing?: SelfHealingSummary;
	recorded_artifact: RecordedScorecardArtifact;
	warnings: string[];
	markdown: string;
}

export interface WeeklyKpiSnapshotPorts {
	onedrive: OneDrivePort;
	drive: DrivePort;
	cleanState: CleanStatePort;
	artifacts: ArtifactsPort;
	tasks: TasksPort;
	review: ReviewPort;
	ledger: LedgerReadPort;
	doctor?: DoctorPort;
}

const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_NATIVE_PREFIX = "application/vnd.google-apps.";
const OPEN_TASK_STATUSES = new Set(["todo", "in_progress", "blocked"]);

export function createEmptyDriveDuplicateMetrics(): DriveDuplicateConfidenceMetrics {
	return {
		evaluated_file_count: 0,
		hashed_file_count: 0,
		high_confidence_same_folder: {
			clusters: 0,
			redundant_files: 0,
			reclaimable_bytes: 0,
		},
		medium_confidence_cross_folder: {
			clusters: 0,
			redundant_files: 0,
			reclaimable_bytes: 0,
		},
		low_confidence_version_families: {
			clusters: 0,
			redundant_files: 0,
		},
		total_exact_clusters: 0,
		total_exact_redundant_files: 0,
		total_reclaimable_bytes: 0,
		duplicate_rate_pct: 0,
		counter_copy_named_files: 0,
		os_junk_files: 0,
	};
}

/**
 * Returns true if the filename is an OS or Office temporary junk artifact
 * (`.DS_Store`, `Thumbs.db`, `desktop.ini`, or `~$*`).
 */
export function isOsJunkFileName(rawName: string): boolean {
	const trimmed = rawName.trim().toLowerCase();
	if (!trimmed) return false;
	if (
		trimmed === ".ds_store" ||
		trimmed === "thumbs.db" ||
		trimmed === "desktop.ini"
	) {
		return true;
	}
	if (trimmed.startsWith("~$")) {
		return true;
	}
	return false;
}

/**
 * Extracts the clean canonical filename (preserving original casing) when `rawName`
 * carries an explicit copy marker (`Copy of ...`, `... (1).ext`, `... - Copy.ext`).
 * Returns `null` when no explicit copy marker is present.
 */
export function extractCleanCanonicalFileName(rawName: string): string | null {
	const trimmed = rawName.trim();
	if (!trimmed) return null;

	let working = trimmed;
	let modified = false;

	if (/^copy\s+of\s+/i.test(working)) {
		working = working.replace(/^copy\s+of\s+/i, "").trim();
		modified = true;
	}

	const dashCopyMatch = /^(.+?)\s+-\s*copy(?:\s*\(\d{1,3}\))?(\.[^.]+)?$/i.exec(
		working,
	);
	if (dashCopyMatch?.[1]) {
		const stem = dashCopyMatch[1].trim();
		const ext = dashCopyMatch[2] ?? "";
		working = `${stem}${ext}`;
		modified = true;
	}

	const parenMatch = /^(.+?)\s*\(\d{1,3}\)(\.[^.]+)?$/.exec(working);
	if (parenMatch?.[1]) {
		const stem = parenMatch[1].trim();
		const ext = parenMatch[2] ?? "";
		working = `${stem}${ext}`;
		modified = true;
	}

	return modified && working.length > 0 && working !== trimmed ? working : null;
}

/**
 * Returns true when `rawName` has an explicit counter-copy suffix (`foo (1).ext`,
 * `Copy of foo.ext`, `foo - Copy.ext`).
 */
export function isCounterCopyFileName(rawName: string): boolean {
	return extractCleanCanonicalFileName(rawName) !== null;
}

/**
 * Normalizes a filename to its canonical counter-copy name inside a folder:
 * - `Report 1.docx` -> `report.docx`
 * - `Report (2).docx` -> `report.docx`
 * - `Copy of Report.docx` -> `report.docx`
 */
export function normalizeCanonicalDuplicateFileName(rawName: string): string {
	const trimmed = rawName.trim();
	const withoutCopyPrefix = trimmed.replace(/^copy\s+of\s+/i, "");
	const parenMatch = /^(.+?)\s*\(\d+\)(\.[^.]+)?$/.exec(withoutCopyPrefix);
	if (parenMatch) {
		const stem = parenMatch[1]?.trim() ?? withoutCopyPrefix;
		const ext = parenMatch[2] ?? "";
		return `${stem}${ext}`.toLowerCase();
	}
	const counterParsed = parseCounterCopyFileName(withoutCopyPrefix);
	if (counterParsed) {
		return counterParsed.canonicalName.toLowerCase();
	}
	return withoutCopyPrefix.toLowerCase();
}

/**
 * Normalizes a filename or document title into a version-family key (Low-Confidence Band <0.80):
 * Strips extension, counter suffixes, `(1)`, `v1`/`v2.3`, `draft`/`final`/`copy` markers, and punctuation.
 */
export function normalizeVersionFamilyStem(rawName: string): string {
	const lower = rawName.trim().toLowerCase();
	const withoutExt = lower.replace(/\.[a-z0-9]{1,8}$/i, "");
	const stripped = withoutExt
		.replace(/^copy\s+of\s+/i, "")
		.replace(/\(\d+\)/g, " ")
		.replace(/\b(?:v|ver|version|rev)[_.\-\s]*\d+(?:\.\d+)?\b/g, " ")
		.replace(/\b(?:draft|final|copy|backup|edited|revised)\b/g, " ")
		.replace(/\s+\d+$/g, " ")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
	return stripped;
}

/**
 * Deterministically classifies a set of drive files into 3 Confidence Bands:
 * - High Confidence (>=0.99, Zero-HITL Auto-Heal): Same parent folder + same canonical name + identical cryptographic hash + size > 0.
 * - Medium Confidence (0.80-0.98, Rule-Gated Batch): Cross-folder or renamed files with identical cryptographic hash + size > 0.
 * - Low Confidence (<0.80, HITL Review Queue): Distinct content hashes (or unhashed files) sharing the same normalized version-family stem.
 */
export function computeDriveDuplicateMetrics(
	items: DuplicateCandidateItem[],
): DriveDuplicateConfidenceMetrics {
	if (items.length === 0) {
		return createEmptyDriveDuplicateMetrics();
	}

	let hashedFileCount = 0;

	// Group by exact cryptographic hash + byte size
	const byExactHash = new Map<string, DuplicateCandidateItem[]>();
	for (const item of items) {
		const normalizedHash = item.hash?.trim().toLowerCase() || null;
		if (normalizedHash && item.sizeBytes > 0) {
			hashedFileCount++;
			const exactKey = `${normalizedHash}:${item.sizeBytes}`;
			const bucket = byExactHash.get(exactKey) ?? [];
			bucket.push(item);
			byExactHash.set(exactKey, bucket);
		}
	}

	let highClusters = 0;
	let highRedundantFiles = 0;
	let highReclaimableBytes = 0;

	let mediumClusters = 0;
	let mediumRedundantFiles = 0;
	let mediumReclaimableBytes = 0;

	for (const group of byExactHash.values()) {
		if (group.length < 2) continue;

		// Sub-group by (parentKey + canonicalName) to isolate High-Confidence same-folder clones/counter-copies
		const bySameFolderCanonical = new Map<string, DuplicateCandidateItem[]>();
		for (const member of group) {
			const canonicalName = normalizeCanonicalDuplicateFileName(member.name);
			const subKey = `${member.parentKey}::${canonicalName}`;
			const subBucket = bySameFolderCanonical.get(subKey) ?? [];
			subBucket.push(member);
			bySameFolderCanonical.set(subKey, subBucket);
		}

		let remainingCrossFolderRepresentatives = 0;
		let representativeSize = group[0]?.sizeBytes ?? 0;

		for (const subGroup of bySameFolderCanonical.values()) {
			remainingCrossFolderRepresentatives++;
			if (subGroup.length > 1) {
				highClusters++;
				const redundant = subGroup.length - 1;
				highRedundantFiles += redundant;
				highReclaimableBytes += redundant * (subGroup[0]?.sizeBytes ?? 0);
			}
		}

		// If the exact same hash+size still appears across multiple folders/canonical names,
		// the remaining representatives form a Medium-Confidence cross-folder cluster.
		if (remainingCrossFolderRepresentatives > 1) {
			mediumClusters++;
			const crossRedundant = remainingCrossFolderRepresentatives - 1;
			mediumRedundantFiles += crossRedundant;
			mediumReclaimableBytes += crossRedundant * representativeSize;
		}
	}

	// Low Confidence (<0.80): Version families across distinct content hashes (or unhashed items)
	const byVersionStem = new Map<string, Set<string>>();
	let unhashedSeq = 0;
	for (const item of items) {
		const stem = normalizeVersionFamilyStem(item.name);
		if (stem.length < 4) continue;
		const contentIdentity =
			item.hash && item.sizeBytes > 0
				? `${item.hash.trim().toLowerCase()}:${item.sizeBytes}`
				: `unhashed:${item.parentKey}:${item.name.toLowerCase()}:${++unhashedSeq}`;
		const set = byVersionStem.get(stem) ?? new Set<string>();
		set.add(contentIdentity);
		byVersionStem.set(stem, set);
	}

	let lowClusters = 0;
	let lowRedundantFiles = 0;
	for (const identities of byVersionStem.values()) {
		if (identities.size > 1) {
			lowClusters++;
			lowRedundantFiles += identities.size - 1;
		}
	}

	const totalExactClusters = highClusters + mediumClusters;
	const totalExactRedundantFiles = highRedundantFiles + mediumRedundantFiles;
	const totalReclaimableBytes = highReclaimableBytes + mediumReclaimableBytes;

	const folderLowerNames = new Set<string>();
	for (const item of items) {
		folderLowerNames.add(`${item.parentKey}::${item.name.trim().toLowerCase()}`);
	}

	let counterCopyNamedFiles = 0;
	let osJunkFiles = 0;
	for (const item of items) {
		if (isOsJunkFileName(item.name)) {
			osJunkFiles++;
			continue;
		}
		if (isCounterCopyFileName(item.name)) {
			counterCopyNamedFiles++;
			continue;
		}
		const counterParsed = parseCounterCopyFileName(item.name.trim());
		if (
			counterParsed &&
			counterParsed.counter <= 999 &&
			folderLowerNames.has(
				`${item.parentKey}::${counterParsed.canonicalName.toLowerCase()}`,
			)
		) {
			counterCopyNamedFiles++;
		}
	}

	return {
		evaluated_file_count: items.length,
		hashed_file_count: hashedFileCount,
		high_confidence_same_folder: {
			clusters: highClusters,
			redundant_files: highRedundantFiles,
			reclaimable_bytes: highReclaimableBytes,
		},
		medium_confidence_cross_folder: {
			clusters: mediumClusters,
			redundant_files: mediumRedundantFiles,
			reclaimable_bytes: mediumReclaimableBytes,
		},
		low_confidence_version_families: {
			clusters: lowClusters,
			redundant_files: lowRedundantFiles,
		},
		total_exact_clusters: totalExactClusters,
		total_exact_redundant_files: totalExactRedundantFiles,
		total_reclaimable_bytes: totalReclaimableBytes,
		duplicate_rate_pct: roundPct(totalExactRedundantFiles, items.length, 0),
		counter_copy_named_files: counterCopyNamedFiles,
		os_junk_files: osJunkFiles,
	};
}

/**
 * Computes ISO 8601 week key (`YYYY-Www`) in UTC.
 */
export function computeIsoWeekKey(date: Date = new Date()): string {
	const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	const dayNum = d.getUTCDay() || 7;
	d.setUTCDate(d.getUTCDate() + 4 - dayNum);
	const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
	const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
	return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function roundPct(numerator: number, denominator: number, emptyDefault = 100): number {
	if (denominator <= 0) return emptyDefault;
	return Math.round((numerator / denominator) * 1000) / 10;
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

function formatGiB(bytes: number): string {
	return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function formatMiB(bytes: number): string {
	return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

function toOneDriveCandidate(item: OneDriveItem, fallbackParent: string): DuplicateCandidateItem | null {
	if (item.folder && !item.file) return null;
	if (!item.file && item.name.trim().toLowerCase() === "personal vault") return null;
	const hash =
		item.file?.hashes?.sha256Hash ??
		item.file?.hashes?.sha1Hash ??
		item.file?.hashes?.quickXorHash ??
		null;
	return {
		id: item.id,
		name: item.name,
		parentKey: item.parentReference?.id ?? item.parentReference?.path ?? fallbackParent,
		sizeBytes: item.size ?? 0,
		hash,
	};
}

/**
 * Builds the 3-Band Self-Healing Readiness Summary from raw drive and KMS duplicate metrics.
 */
export function computeSelfHealingSummary(params: {
	cloudDrives: CloudDrivesKpiSection;
	knowledgeAndCapture: KnowledgeAndCaptureKpiSection;
	scheduleWindowDays?: number;
}): SelfHealingSummary {
	const { cloudDrives, knowledgeAndCapture, scheduleWindowDays = 3 } = params;
	const odDup = cloudDrives.onedrive_personal.duplicates ?? createEmptyDriveDuplicateMetrics();
	const gdPersonalDup = cloudDrives.gdrive_personal.duplicates ?? createEmptyDriveDuplicateMetrics();
	const gdWorkDup = cloudDrives.gdrive_work.duplicates ?? createEmptyDriveDuplicateMetrics();

	const highClusters =
		odDup.high_confidence_same_folder.clusters +
		gdPersonalDup.high_confidence_same_folder.clusters +
		gdWorkDup.high_confidence_same_folder.clusters +
		knowledgeAndCapture.duplicates.duplicate_group_count;

	const highRedundant =
		odDup.high_confidence_same_folder.redundant_files +
		gdPersonalDup.high_confidence_same_folder.redundant_files +
		gdWorkDup.high_confidence_same_folder.redundant_files +
		knowledgeAndCapture.duplicates.redundant_artifact_count;

	const highBytes =
		odDup.high_confidence_same_folder.reclaimable_bytes +
		gdPersonalDup.high_confidence_same_folder.reclaimable_bytes +
		gdWorkDup.high_confidence_same_folder.reclaimable_bytes;

	const medClusters =
		odDup.medium_confidence_cross_folder.clusters +
		gdPersonalDup.medium_confidence_cross_folder.clusters +
		gdWorkDup.medium_confidence_cross_folder.clusters;

	const medRedundant =
		odDup.medium_confidence_cross_folder.redundant_files +
		gdPersonalDup.medium_confidence_cross_folder.redundant_files +
		gdWorkDup.medium_confidence_cross_folder.redundant_files;

	const medBytes =
		odDup.medium_confidence_cross_folder.reclaimable_bytes +
		gdPersonalDup.medium_confidence_cross_folder.reclaimable_bytes +
		gdWorkDup.medium_confidence_cross_folder.reclaimable_bytes;

	const lowClusters =
		odDup.low_confidence_version_families.clusters +
		gdPersonalDup.low_confidence_version_families.clusters +
		gdWorkDup.low_confidence_version_families.clusters;

	const lowRedundant =
		odDup.low_confidence_version_families.redundant_files +
		gdPersonalDup.low_confidence_version_families.redundant_files +
		gdWorkDup.low_confidence_version_families.redundant_files;

	const totalReclaimableBytes = highBytes + medBytes;
	const totalRedundantFiles = highRedundant + medRedundant + lowRedundant;
	const autoHealablePct = roundPct(highRedundant, Math.max(1, highRedundant + medRedundant), 100);

	return {
		schedule_window_days: scheduleWindowDays,
		total_reclaimable_bytes: totalReclaimableBytes,
		total_redundant_files: totalRedundantFiles,
		auto_healable_pct: totalRedundantFiles === 0 ? 100 : autoHealablePct,
		bands: {
			high_auto_heal: {
				band: "high",
				confidence_range: ">=0.99",
				execution_mode: "auto_heal_zero_hitl",
				clusters: highClusters,
				redundant_files: highRedundant,
				reclaimable_bytes: highBytes,
				description:
					"Same-folder + same-canonical-name + identical cryptographic hash (SHA-256/MD5) + identical byte size.",
				recommended_action:
					"Zero-HITL autonomous cleanup: keep oldest/canonical item in folder and trash/delete N-1 identical clones.",
			},
			medium_rule_gated: {
				band: "medium",
				confidence_range: "0.80-0.98",
				execution_mode: "rule_gated_batch",
				clusters: medClusters,
				redundant_files: medRedundant,
				reclaimable_bytes: medBytes,
				description:
					"Cross-folder byte-identical copies (same SHA-256/MD5 + size) across different PARA folders or 8.To Sort.",
				recommended_action:
					"Policy-gated batch heal: retain canonical copy in 1.Projects–7.Secure; deduplicate 8.To Sort staging copy.",
			},
			low_hitl_review: {
				band: "low",
				confidence_range: "<0.80",
				execution_mode: "hitl_review_queue",
				clusters: lowClusters,
				redundant_files: lowRedundant,
				reclaimable_bytes: 0,
				description:
					"Version-family title stem matches with differing or unhashed content (e.g. v1/v2, draft/final).",
				recommended_action:
					"Route to decision_review queue for minimal HITL confirmation before superseding or archiving.",
			},
		},
	};
}

/**
 * Computes composite KPIs where each KPI is explicitly constructed from constituent raw metrics.
 */
export function computeCompositeKpis(params: {
	cloudDrives: CloudDrivesKpiSection;
	knowledgeAndCapture: KnowledgeAndCaptureKpiSection;
	tasksAndGovernance: TasksAndGovernanceKpiSection;
	systemAndLedger: SystemAndLedgerKpiSection;
	selfHealing?: SelfHealingSummary;
}): CompositeKpiItem[] {
	const { cloudDrives, knowledgeAndCapture, tasksAndGovernance, systemAndLedger } = params;
	const selfHealing =
		params.selfHealing ??
		computeSelfHealingSummary({ cloudDrives, knowledgeAndCapture });

	const od = cloudDrives.onedrive_personal;
	const gdPersonal = cloudDrives.gdrive_personal;
	const gdWork = cloudDrives.gdrive_work;
	const odDup = od.duplicates ?? createEmptyDriveDuplicateMetrics();
	const gdDup = gdPersonal.duplicates ?? createEmptyDriveDuplicateMetrics();
	const gdWorkDup = gdWork.duplicates ?? createEmptyDriveDuplicateMetrics();

	const odUsedPct = od.quota?.used_pct ?? 0;
	const odFreePct = od.quota ? round1(Math.max(0, 100 - odUsedPct)) : 100;
	const toSortBytes = od.tracked_folders.to_sort?.size_bytes ?? 0;
	const toSortShareOfUsedPct =
		od.quota && od.quota.used_bytes > 0
			? roundPct(toSortBytes, od.quota.used_bytes, 0)
			: 0;

	// KPI 1 (v2.0.0): Cloud Storage Hygiene Composite (%) — 4 constituent sub-scores:
	// 1a. Deduplication Efficiency (weight 0.35)
	const totalEvaluatedFiles =
		odDup.evaluated_file_count +
		gdDup.evaluated_file_count +
		gdWorkDup.evaluated_file_count;
	const totalExactRedundantFiles =
		odDup.total_exact_redundant_files +
		gdDup.total_exact_redundant_files +
		gdWorkDup.total_exact_redundant_files;
	const dedupEfficiencyPct =
		totalEvaluatedFiles > 0
			? round1(Math.max(0, 100 - (totalExactRedundantFiles / totalEvaluatedFiles) * 100))
			: 100;

	// 1b. PARA Filing & Root Cleanliness (weight 0.25)
	const rootCleanlinessPct =
		od.status === "skipped"
			? 100
			: Math.max(0, round1(100 - od.root_file_count * 5));
	const folderStructuralScores: number[] = [];
	if (od.folder_hygiene && typeof od.folder_hygiene.structural_cleanliness_pct === "number") {
		folderStructuralScores.push(od.folder_hygiene.structural_cleanliness_pct);
	}
	if (
		gdPersonal.folder_hygiene &&
		typeof gdPersonal.folder_hygiene.structural_cleanliness_pct === "number"
	) {
		folderStructuralScores.push(gdPersonal.folder_hygiene.structural_cleanliness_pct);
	}
	const folderStructuralCleanlinessPct =
		folderStructuralScores.length > 0
			? round1(
					folderStructuralScores.reduce((sum, v) => sum + v, 0) /
						folderStructuralScores.length,
				)
			: 100;
	const toSortContainmentPct = round1(Math.max(0, 100 - toSortShareOfUsedPct));
	const paraFilingPct =
		od.status === "skipped" && gdPersonal.status === "skipped"
			? 100
			: round1(
					0.4 * rootCleanlinessPct +
						0.4 * folderStructuralCleanlinessPct +
						0.2 * toSortContainmentPct,
				);

	// 1c. Canonical Naming Hygiene (weight 0.20)
	const totalCounterCopyFiles =
		(odDup.counter_copy_named_files ?? odDup.high_confidence_same_folder.redundant_files) +
		(gdDup.counter_copy_named_files ?? gdDup.high_confidence_same_folder.redundant_files) +
		(gdWorkDup.counter_copy_named_files ??
			gdWorkDup.high_confidence_same_folder.redundant_files);
	const totalOsJunkFiles =
		(odDup.os_junk_files ?? 0) +
		(gdDup.os_junk_files ?? 0) +
		(gdWorkDup.os_junk_files ?? 0);
	const totalNamingViolations = totalCounterCopyFiles + totalOsJunkFiles;
	const namingHygienePct =
		totalEvaluatedFiles > 0
			? round1(Math.max(0, 100 - (totalNamingViolations / totalEvaluatedFiles) * 100))
			: 100;

	// 1d. Quota & Domain Boundary Health (weight 0.20)
	const workStrandedItems = od.tracked_folders.work_project?.child_count ?? 0;
	const domainBoundaryPct =
		od.status === "skipped"
			? 100
			: Math.max(0, round1(100 - workStrandedItems * 2.5));
	const quotaAndBoundaryPct =
		od.status === "skipped"
			? 100
			: round1(0.6 * odFreePct + 0.4 * domainBoundaryPct);

	const storageHygienePct = round1(
		0.35 * dedupEfficiencyPct +
			0.25 * paraFilingPct +
			0.2 * namingHygienePct +
			0.2 * quotaAndBoundaryPct,
	);
	const storageHygieneStatus: KpiHealthStatus =
		storageHygienePct >= 95 ? "healthy" : storageHygienePct >= 80 ? "warning" : "critical";

	// KPI 2: Zero-HITL Auto-Heal Ready Pool (files)
	const autoHealFiles = selfHealing.bands.high_auto_heal.redundant_files;
	const autoHealStatus: KpiHealthStatus =
		autoHealFiles === 0 ? "healthy" : autoHealFiles <= 25 ? "warning" : "critical";

	// KPI 3: OneDrive Personal Quota Headroom (%)
	const odHeadroomStatus: KpiHealthStatus =
		odFreePct >= 50 && toSortShareOfUsedPct <= 50
			? "healthy"
			: odFreePct >= 25
				? "warning"
				: "critical";

	// KPI 4: Knowledge Clean-State & Enrichment Composite (%)
	const derivEvaluated =
		knowledgeAndCapture.derivation.completed +
		knowledgeAndCapture.derivation.pending +
		knowledgeAndCapture.derivation.failed;
	const derivCompletionPct = roundPct(
		knowledgeAndCapture.derivation.completed,
		derivEvaluated,
		100,
	);
	const knowledgeCompositePct = round1(
		0.5 * knowledgeAndCapture.clean_state.pass_rate_pct +
			0.3 * knowledgeAndCapture.embedding_coverage.coverage_pct +
			0.2 * derivCompletionPct,
	);
	const knowledgeStatus: KpiHealthStatus =
		knowledgeCompositePct >= 95
			? "healthy"
			: knowledgeCompositePct >= 85
				? "warning"
				: "critical";

	// KPI 5: Governance & Task Execution Health (%)
	const onTimeOpenTasks = Math.max(
		0,
		tasksAndGovernance.active_open_count - tasksAndGovernance.overdue_count,
	);
	const onTimeTaskPct = roundPct(
		onTimeOpenTasks,
		tasksAndGovernance.active_open_count,
		100,
	);
	const reviewClearancePct = Math.max(
		0,
		100 - tasksAndGovernance.pending_review_decisions * 5,
	);
	const governanceCompositePct = round1(0.6 * onTimeTaskPct + 0.4 * reviewClearancePct);
	const governanceStatus: KpiHealthStatus =
		governanceCompositePct >= 90
			? "healthy"
			: governanceCompositePct >= 70
				? "warning"
				: "critical";

	// KPI 6: Autonomous Action Reliability (%)
	const reliabilityPct = systemAndLedger.success_rate_pct;
	const reliabilityStatus: KpiHealthStatus =
		reliabilityPct >= 98 && systemAndLedger.doctor?.status !== "fail"
			? "healthy"
			: reliabilityPct >= 94
				? "warning"
				: "critical";

	return [
		{
			id: "cloud_storage_hygiene_pct",
			name: "Cloud Storage Hygiene Composite",
			pillar: "cloud_drives",
			value: storageHygienePct,
			unit: "%",
			target: ">= 95.0%",
			status: storageHygieneStatus,
			confidence_band: "high",
			kpi_config_version: KPI_CONFIG_VERSION,
			formula:
				"0.35 * dedup_efficiency_pct + 0.25 * para_filing_pct + 0.20 * naming_hygiene_pct + 0.20 * quota_and_boundary_pct",
			constituent_metrics: {
				kpi_config_version: KPI_CONFIG_VERSION,
				dedup_efficiency_pct: dedupEfficiencyPct,
				para_filing_pct: paraFilingPct,
				naming_hygiene_pct: namingHygienePct,
				quota_and_boundary_pct: quotaAndBoundaryPct,
				evaluated_file_count: totalEvaluatedFiles,
				exact_redundant_files: totalExactRedundantFiles,
				high_conf_same_folder_files: selfHealing.bands.high_auto_heal.redundant_files,
				medium_conf_cross_folder_files: selfHealing.bands.medium_rule_gated.redundant_files,
				counter_copy_named_files: totalCounterCopyFiles,
				os_junk_files: totalOsJunkFiles,
				root_loose_files: od.root_file_count,
				folder_structural_cleanliness_pct: folderStructuralCleanlinessPct,
				to_sort_share_of_used_pct: toSortShareOfUsedPct,
				onedrive_free_pct: odFreePct,
				work_stranded_items: workStrandedItems,
				reclaimable_bytes: selfHealing.total_reclaimable_bytes,
			},
		},
		{
			id: "zero_hitl_auto_heal_pool",
			name: "Zero-HITL Auto-Heal Pool",
			pillar: "cloud_drives",
			value: autoHealFiles,
			unit: "files",
			target: "0 files",
			status: autoHealStatus,
			confidence_band: "high",
			kpi_config_version: KPI_CONFIG_VERSION,
			formula: "onedrive_same_folder_dups + gdrive_same_folder_dups + kms_exact_dups",
			constituent_metrics: {
				onedrive_same_folder_files: odDup.high_confidence_same_folder.redundant_files,
				gdrive_personal_same_folder_files: gdDup.high_confidence_same_folder.redundant_files,
				kms_redundant_artifacts: knowledgeAndCapture.duplicates.redundant_artifact_count,
				auto_heal_clusters: selfHealing.bands.high_auto_heal.clusters,
				auto_heal_reclaimable_bytes: selfHealing.bands.high_auto_heal.reclaimable_bytes,
			},
		},
		{
			id: "onedrive_quota_headroom_pct",
			name: "OneDrive Quota Headroom",
			pillar: "cloud_drives",
			value: odFreePct,
			unit: "%",
			target: ">= 50.0% free",
			status: odHeadroomStatus,
			confidence_band: "medium",
			kpi_config_version: KPI_CONFIG_VERSION,
			formula: "100 - (onedrive_used_bytes / onedrive_total_bytes * 100)",
			constituent_metrics: {
				onedrive_used_pct: odUsedPct,
				onedrive_remaining_bytes: od.quota?.remaining_bytes ?? 0,
				to_sort_size_bytes: toSortBytes,
				to_sort_share_of_used_pct: toSortShareOfUsedPct,
				work_project_items: od.tracked_folders.work_project?.child_count ?? 0,
			},
		},
		{
			id: "knowledge_clean_state_score_pct",
			name: "Knowledge Clean-State Composite",
			pillar: "knowledge",
			value: knowledgeCompositePct,
			unit: "%",
			target: ">= 95.0%",
			status: knowledgeStatus,
			confidence_band: "high",
			kpi_config_version: KPI_CONFIG_VERSION,
			formula: "0.5 * clean_state_pct + 0.3 * embedding_pct + 0.2 * derivation_pct",
			constituent_metrics: {
				clean_state_pass_rate_pct: knowledgeAndCapture.clean_state.pass_rate_pct,
				embedding_coverage_pct: knowledgeAndCapture.embedding_coverage.coverage_pct,
				derivation_completion_pct: derivCompletionPct,
				artifacts_captured: knowledgeAndCapture.artifacts_captured,
				clean_state_fail_count: knowledgeAndCapture.clean_state.fail,
			},
		},
		{
			id: "governance_execution_health_pct",
			name: "Governance & Task Execution Health",
			pillar: "governance",
			value: governanceCompositePct,
			unit: "%",
			target: ">= 90.0%",
			status: governanceStatus,
			confidence_band: "low",
			kpi_config_version: KPI_CONFIG_VERSION,
			formula: "0.6 * on_time_open_task_pct + 0.4 * review_queue_clearance_pct",
			constituent_metrics: {
				on_time_open_task_pct: onTimeTaskPct,
				active_open_count: tasksAndGovernance.active_open_count,
				overdue_count: tasksAndGovernance.overdue_count,
				completed_in_window_count: tasksAndGovernance.completed_in_window_count,
				pending_review_decisions: tasksAndGovernance.pending_review_decisions,
			},
		},
		{
			id: "autonomous_action_reliability_pct",
			name: "Autonomous Action Reliability",
			pillar: "system",
			value: reliabilityPct,
			unit: "%",
			target: ">= 98.0%",
			status: reliabilityStatus,
			confidence_band: "high",
			kpi_config_version: KPI_CONFIG_VERSION,
			formula: "success_count / max(1, total_invocations) * 100",
			constituent_metrics: {
				total_invocations: systemAndLedger.total_invocations,
				success_count: systemAndLedger.success_count,
				error_count: systemAndLedger.error_count,
				pending_approval_count: systemAndLedger.pending_approval_count,
				doctor_status: systemAndLedger.doctor?.status ?? "not_run",
			},
		},
	];
}

/**
 * Purely recomputes `self_healing` and `composite_kpis` from a snapshot's immutable
 * raw metrics using the current `KPI_CONFIG_VERSION`, while preserving
 * `stored_kpi_config_version` (defaulting to `"1.0.0"` for pre-versioned snapshots).
 */
export function recomputeSnapshotKpis(
	snapshot: WeeklyKpiSnapshotResult,
): WeeklyKpiSnapshotResult {
	const storedVersion =
		snapshot.stored_kpi_config_version ??
		snapshot.kpi_config_version ??
		"1.0.0";
	const selfHealing = computeSelfHealingSummary({
		cloudDrives: snapshot.cloud_drives,
		knowledgeAndCapture: snapshot.knowledge_and_capture,
		scheduleWindowDays: snapshot.self_healing?.schedule_window_days ?? 3,
	});
	const compositeKpis = computeCompositeKpis({
		cloudDrives: snapshot.cloud_drives,
		knowledgeAndCapture: snapshot.knowledge_and_capture,
		tasksAndGovernance: snapshot.tasks_and_governance,
		systemAndLedger: snapshot.system_and_ledger,
		selfHealing,
	});
	return {
		...snapshot,
		kpi_config_version: KPI_CONFIG_VERSION,
		stored_kpi_config_version: storedVersion,
		self_healing: selfHealing,
		composite_kpis: compositeKpis,
	};
}

async function collectOneDriveSummary(
	onedrive: OneDrivePort,
	warnings: string[],
): Promise<OneDrivePersonalKpiSummary> {
	let quota: OneDrivePersonalKpiSummary["quota"] = null;
	let rootItems: Awaited<ReturnType<OneDrivePort["listChildren"]>>["items"] = [];
	let degraded = false;
	const candidateItems: DuplicateCandidateItem[] = [];

	try {
		const q = await onedrive.getQuota();
		quota = {
			total_bytes: q.total,
			used_bytes: q.used,
			remaining_bytes: q.remaining,
			deleted_bytes: q.deleted,
			used_pct: q.total > 0 ? roundPct(q.used, q.total, 0) : 0,
			state: q.state,
		};
	} catch (err) {
		degraded = true;
		warnings.push(`onedrive.getQuota failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	try {
		const rootRes = await onedrive.listChildren({ pageSize: 200 });
		rootItems = rootRes.items ?? [];
		for (const item of rootItems) {
			const cand = toOneDriveCandidate(item, "root");
			if (cand) candidateItems.push(cand);
		}
	} catch (err) {
		degraded = true;
		warnings.push(`onedrive.listChildren(root) failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	const folders = rootItems.filter((i) => Boolean(i.folder));
	const files = rootItems.filter(
		(i) => !i.folder && i.name.trim().toLowerCase() !== "personal vault",
	);
	const topFolders: OneDriveFolderSummary[] = [...folders]
		.sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
		.slice(0, 10)
		.map((f) => ({
			name: f.name,
			size_bytes: f.size ?? 0,
			child_count: f.folder?.childCount ?? 0,
		}));

	const toSortRoot = folders.find((f) => f.name === "8.To Sort");
	let toSortSummary: { size_bytes: number; child_count: number } | null = toSortRoot
		? { size_bytes: toSortRoot.size ?? 0, child_count: toSortRoot.folder?.childCount ?? 0 }
		: null;

	if (!degraded) {
		try {
			const toSortChildren = await onedrive.listChildren({ path: "8.To Sort", pageSize: 200 });
			const items = toSortChildren.items ?? [];
			if (!toSortSummary) {
				const totalSize = items.reduce((sum, item) => sum + (item.size ?? 0), 0);
				toSortSummary = {
					size_bytes: totalSize,
					child_count: items.length,
				};
			}
			for (const item of items) {
				const cand = toOneDriveCandidate(item, "8.To Sort");
				if (cand) candidateItems.push(cand);
			}
		} catch {
			// Optional tracked folder may not exist
		}
	}

	let workSummary: { size_bytes: number; child_count: number } | null = null;
	if (!degraded) {
		for (const workPath of [
			"1.Projects/Startups/Work (Oct 2025–Present)",
			"1.Projects/Startups/Work",
		]) {
			try {
				const hlChildren = await onedrive.listChildren({
					path: workPath,
					pageSize: 200,
				});
				const items = hlChildren.items ?? [];
				const totalSize = items.reduce((sum, item) => sum + (item.size ?? 0), 0);
				workSummary = {
					size_bytes: totalSize,
					child_count: items.length,
				};
				for (const item of items) {
					const cand = toOneDriveCandidate(item, workPath);
					if (cand) candidateItems.push(cand);
				}
				if (items.length > 0) {
					break;
				}
			} catch {
				// Optional tracked folder may not exist
			}
		}
	}

	const duplicates = computeDriveDuplicateMetrics(candidateItems);
	let folderHygiene: FolderHygieneSummary | null = null;
	if (!degraded) {
		try {
			const walk = await walkOneDriveFolders(onedrive, {
				maxDepth: 3,
				maxFolders: 250,
				seedRootItems: rootItems,
			});
			folderHygiene = classifyFolderCollisions(walk.folders, {
				provider: "onedrive",
				domain: "angus",
				truncated: walk.truncated,
				max_depth_scanned: walk.max_depth_scanned,
				max_clusters: 10,
			}).summary;
		} catch (err) {
			warnings.push(
				`onedrive folder_hygiene scan failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	return {
		status: degraded ? "degraded" : "ok",
		quota,
		root_item_count: rootItems.length,
		root_folder_count: folders.length,
		root_file_count: files.length,
		top_folders: topFolders,
		tracked_folders: {
			to_sort: toSortSummary,
			work_project: workSummary,
		},
		duplicates,
		folder_hygiene: folderHygiene,
	};
}

async function collectGdriveDomainSummary(
	drive: DrivePort,
	domain: Domain,
	warnings: string[],
): Promise<GdriveDomainKpiSummary> {
	try {
		const [allRes, rootRes] = await Promise.all([
			drive.listFiles({
				domain,
				q: "trashed = false",
				pageSize: 1000,
				fields: LIST_FIELDS,
			}),
			drive.listFiles({
				domain,
				q: "'root' in parents and trashed = false",
				pageSize: 200,
				fields: LIST_FIELDS,
			}),
		]);

		const files = allRes.files ?? [];
		const rootFiles = rootRes.files ?? [];

		let folderCount = 0;
		let fileCount = 0;
		let googleNativeCount = 0;
		let binaryFileCount = 0;
		let binaryBytes = 0;
		const duplicateCandidates: DuplicateCandidateItem[] = [];

		for (const item of files) {
			if (item.mimeType === GOOGLE_FOLDER_MIME) {
				folderCount++;
			} else {
				fileCount++;
				const parsedSize = Number(item.size ?? 0);
				const sizeBytes = Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : 0;
				if (item.mimeType?.startsWith(GOOGLE_NATIVE_PREFIX)) {
					googleNativeCount++;
				} else {
					binaryFileCount++;
					binaryBytes += sizeBytes;
				}
				duplicateCandidates.push({
					id: item.id ?? `${domain}-${fileCount}`,
					name: item.name ?? "(unnamed)",
					parentKey: item.parents?.[0] ?? "root",
					sizeBytes,
					hash: item.sha256Checksum ?? item.md5Checksum ?? null,
				});
			}
		}

		const duplicates = computeDriveDuplicateMetrics(duplicateCandidates);

		const rootFolderNames = rootFiles
			.filter((f) => f.mimeType === GOOGLE_FOLDER_MIME)
			.map((f) => f.name)
			.filter((name): name is string => Boolean(name))
			.sort((a, b) => a.localeCompare(b))
			.slice(0, 15);

		const gdriveFolderWalk = buildGDriveFolderNodesFromInventory(
			domain,
			files,
			rootFiles,
			{
				maxDepth: 4,
				maxFolders: 400,
				truncated: Boolean(allRes.nextPageToken),
			},
		);
		const folderHygiene = classifyFolderCollisions(gdriveFolderWalk.folders, {
			provider: "gdrive",
			domain,
			truncated: gdriveFolderWalk.truncated,
			max_depth_scanned: gdriveFolderWalk.max_depth_scanned,
			max_clusters: 10,
		}).summary;

		return {
			domain,
			status: "ok",
			sampled_item_count: files.length,
			sampled_truncated: Boolean(allRes.nextPageToken),
			folder_count: folderCount,
			file_count: fileCount,
			google_native_count: googleNativeCount,
			binary_file_count: binaryFileCount,
			binary_bytes: binaryBytes,
			root_item_count: rootFiles.length,
			root_folder_names: rootFolderNames,
			duplicates,
			folder_hygiene: folderHygiene,
		};
	} catch (err) {
		warnings.push(`drive.listFiles(${domain}) failed: ${err instanceof Error ? err.message : String(err)}`);
		return {
			domain,
			status: "degraded",
			sampled_item_count: 0,
			sampled_truncated: false,
			folder_count: 0,
			file_count: 0,
			google_native_count: 0,
			binary_file_count: 0,
			binary_bytes: 0,
			root_item_count: 0,
			root_folder_names: [],
			duplicates: createEmptyDriveDuplicateMetrics(),
			folder_hygiene: null,
		};
	}
}

export function renderWeeklyKpiScorecardMarkdown(params: {
	weekKey: string;
	windowDays: number;
	generatedAt: string;
	cloudDrives: CloudDrivesKpiSection;
	knowledgeAndCapture: KnowledgeAndCaptureKpiSection;
	tasksAndGovernance: TasksAndGovernanceKpiSection;
	systemAndLedger: SystemAndLedgerKpiSection;
	compositeKpis?: CompositeKpiItem[];
	selfHealing?: SelfHealingSummary;
	warnings: string[];
}): string {
	const {
		weekKey,
		windowDays,
		generatedAt,
		cloudDrives,
		knowledgeAndCapture,
		tasksAndGovernance,
		systemAndLedger,
		warnings,
	} = params;

	const selfHealing =
		params.selfHealing ??
		computeSelfHealingSummary({ cloudDrives, knowledgeAndCapture });
	const compositeKpis =
		params.compositeKpis ??
		computeCompositeKpis({
			cloudDrives,
			knowledgeAndCapture,
			tasksAndGovernance,
			systemAndLedger,
			selfHealing,
		});

	const lines: string[] = [
		`# KMS Weekly Scorecard — ${weekKey}`,
		"",
		`- **Generated at**: ${generatedAt}`,
		`- **Window**: ${windowDays} day(s)`,
		`- **KPI Config Version**: \`${KPI_CONFIG_VERSION}\``,
		"",
		"## 0. Composite KPIs (Built from Raw Metrics)",
	];

	for (const kpi of compositeKpis) {
		lines.push(
			`- **${kpi.name}** (\`${kpi.id}\`, band: \`${kpi.confidence_band}\`, status: **${kpi.status.toUpperCase()}**): **${kpi.value}${kpi.unit === "%" ? "%" : ` ${kpi.unit}`}** (target: ${kpi.target}) — formula: \`${kpi.formula}\``,
		);
	}

	lines.push(
		"",
		"## 0b. Self-Healing Confidence Bands (Minimal HITL)",
		`- **Band 1 — High Confidence (\`${selfHealing.bands.high_auto_heal.confidence_range}\`, Zero-HITL Auto-Heal)**: ${selfHealing.bands.high_auto_heal.clusters} clusters / ${selfHealing.bands.high_auto_heal.redundant_files} redundant files (${formatMiB(selfHealing.bands.high_auto_heal.reclaimable_bytes)} reclaimable)`,
		`- **Band 2 — Medium Confidence (\`${selfHealing.bands.medium_rule_gated.confidence_range}\`, Rule-Gated Batch)**: ${selfHealing.bands.medium_rule_gated.clusters} clusters / ${selfHealing.bands.medium_rule_gated.redundant_files} redundant files (${formatMiB(selfHealing.bands.medium_rule_gated.reclaimable_bytes)} reclaimable)`,
		`- **Band 3 — Low Confidence (\`${selfHealing.bands.low_hitl_review.confidence_range}\`, HITL Review Queue)**: ${selfHealing.bands.low_hitl_review.clusters} version families / ${selfHealing.bands.low_hitl_review.redundant_files} candidate variants`,
		"",
		"## 1. Cloud Drives & Storage Parity",
	);

	const od = cloudDrives.onedrive_personal;
	if (od.status === "skipped") {
		lines.push("- **OneDrive Personal**: skipped");
	} else {
		const quotaText = od.quota
			? `${formatGiB(od.quota.used_bytes)} / ${formatGiB(od.quota.total_bytes)} (${od.quota.used_pct}% used, ${formatGiB(od.quota.remaining_bytes)} free, state: ${od.quota.state})`
			: "quota unavailable";
		lines.push(
			`- **OneDrive Personal** (${od.status}): ${quotaText}; root items: ${od.root_item_count} (${od.root_folder_count} folders, ${od.root_file_count} files)`,
		);
		if (od.tracked_folders.to_sort) {
			lines.push(
				`  - \`8.To Sort\`: ${formatGiB(od.tracked_folders.to_sort.size_bytes)} (${od.tracked_folders.to_sort.child_count} top-level children)`,
			);
		}
		if (od.tracked_folders.work_project) {
			lines.push(
				`  - \`1.Projects/Startups/Work\`: ${formatMiB(od.tracked_folders.work_project.size_bytes)} (${od.tracked_folders.work_project.child_count} top-level children)`,
			);
		}
		if (od.duplicates) {
			lines.push(
				`  - **Sampled duplicate hygiene**: ${od.duplicates.high_confidence_same_folder.redundant_files} high-conf same-folder, ${od.duplicates.medium_confidence_cross_folder.redundant_files} medium-conf cross-folder, ${od.duplicates.low_confidence_version_families.redundant_files} low-conf version variants`,
			);
		}
		if (od.folder_hygiene) {
			const fh = od.folder_hygiene;
			lines.push(
				`  - **Folder Structure Hygiene**: ${fh.structural_cleanliness_pct}% clean (${fh.shadowed_root_folder_count} shadowed root folders, ${fh.structural_collision_cluster_count} structural collision clusters, ${fh.cross_pillar_cluster_count} cross-pillar clusters, ${fh.empty_shadow_folder_count} empty shadow folders)`,
			);
		}
	}

	for (const gd of [cloudDrives.gdrive_personal, cloudDrives.gdrive_work]) {
		const label = gd.domain === "angus" ? "Google Drive Personal (angus)" : "Google Drive Work (work)";
		if (gd.status === "skipped") {
			lines.push(`- **${label}**: skipped`);
		} else {
			const truncSuffix = gd.sampled_truncated ? "+" : "";
			lines.push(
				`- **${label}** (${gd.status}): ${gd.sampled_item_count}${truncSuffix} active items (${gd.folder_count} folders, ${gd.file_count} files: ${gd.google_native_count} Google-native, ${gd.binary_file_count} binary totaling ${formatMiB(gd.binary_bytes)}); root items: ${gd.root_item_count}`,
			);
			if (gd.duplicates) {
				lines.push(
					`  - **Sampled duplicate hygiene**: ${gd.duplicates.high_confidence_same_folder.redundant_files} high-conf same-folder (${formatMiB(gd.duplicates.high_confidence_same_folder.reclaimable_bytes)}), ${gd.duplicates.medium_confidence_cross_folder.redundant_files} medium-conf cross-folder, ${gd.duplicates.low_confidence_version_families.redundant_files} low-conf version variants`,
				);
			}
			if (gd.folder_hygiene) {
				const fh = gd.folder_hygiene;
				lines.push(
					`  - **Folder Structure Hygiene**: ${fh.structural_cleanliness_pct}% clean (${fh.shadowed_root_folder_count} shadowed root folders, ${fh.structural_collision_cluster_count} structural collision clusters, ${fh.cross_pillar_cluster_count} cross-pillar clusters)`,
				);
			}
		}
	}

	lines.push(
		"",
		"## 2. Knowledge & Capture Health",
		`- **Artifacts captured (${windowDays}d)**: ${knowledgeAndCapture.artifacts_captured}`,
		`- **Clean State (ADR-114)**: ${knowledgeAndCapture.clean_state.pass_rate_pct}% pass (${knowledgeAndCapture.clean_state.ok} ok, ${knowledgeAndCapture.clean_state.warn} warn, ${knowledgeAndCapture.clean_state.fail} fail of ${knowledgeAndCapture.clean_state.evaluated_count} evaluated)`,
		`- **Embedding coverage**: ${knowledgeAndCapture.embedding_coverage.coverage_pct}% (${knowledgeAndCapture.embedding_coverage.with_embedding} embedded, ${knowledgeAndCapture.embedding_coverage.missing_embedding} missing)`,
		`- **Entity derivation**: ${knowledgeAndCapture.derivation.completed} completed, ${knowledgeAndCapture.derivation.skipped} skipped, ${knowledgeAndCapture.derivation.pending} pending, ${knowledgeAndCapture.derivation.failed} failed`,
		`- **Graph connectivity**: ${knowledgeAndCapture.graph_connectivity.linked_artifacts} linked artifacts, ${knowledgeAndCapture.graph_connectivity.total_entity_links} entity links, ${knowledgeAndCapture.graph_connectivity.total_structural_edges} structural edges`,
		`- **Duplicate clusters**: ${knowledgeAndCapture.duplicates.duplicate_group_count} clusters (${knowledgeAndCapture.duplicates.redundant_artifact_count} redundant pointers)`,
		"",
		"## 3. Tasks & Governance",
		`- **Active open tasks**: ${tasksAndGovernance.active_open_count} (sampled ${tasksAndGovernance.sampled_task_count} tasks)`,
		`- **Completed in window (${windowDays}d)**: ${tasksAndGovernance.completed_in_window_count}`,
		`- **Overdue open tasks**: ${tasksAndGovernance.overdue_count}`,
		`- **Pending review / approval decisions**: ${tasksAndGovernance.pending_review_decisions}`,
		"",
		"## 4. System & Action Ledger Health",
		`- **Action invocations (${windowDays}d)**: ${systemAndLedger.total_invocations} (${systemAndLedger.success_rate_pct}% success; ${systemAndLedger.success_count} ok, ${systemAndLedger.error_count} error, ${systemAndLedger.pending_approval_count} pending_approval)`,
		`- **Ledger footprint**: ~${systemAndLedger.ledger_row_estimate} rows (${formatMiB(systemAndLedger.ledger_total_bytes)})`,
	);

	if (systemAndLedger.doctor) {
		lines.push(
			`- **System Doctor**: ${systemAndLedger.doctor.status.toUpperCase()} (${systemAndLedger.doctor.ok_count} ok, ${systemAndLedger.doctor.warn_count} warn, ${systemAndLedger.doctor.fail_count} fail)`,
		);
	}

	if (warnings.length > 0) {
		lines.push("", "## Warnings");
		for (const w of warnings) {
			lines.push(`- ${w}`);
		}
	}

	return lines.join("\n");
}

export function formatWeeklyKpiSnapshotMcp(result: WeeklyKpiSnapshotResult): string {
	const recLine = result.recorded_artifact.recorded
		? `Recorded artifact: ${result.recorded_artifact.artifact_id} (dedup_key=${result.recorded_artifact.dedup_key}, surface=${result.recorded_artifact.surface}, deduplicated=${result.recorded_artifact.deduplicated}, updated=${result.recorded_artifact.updated})`
		: `Dry-run (not persisted; target dedup_key=${result.recorded_artifact.dedup_key})`;
	return `${result.markdown}\n\n---\n${recLine}`;
}

/**
 * Creates the `weekly_kpi_snapshot` Core Action (ADR-115 RCA).
 * Collects Cloud Drive & Parity KPIs alongside non-Drive ahOS operational KPIs
 * (Knowledge & Capture health, Tasks & Governance, System & Ledger health),
 * computes Composite KPIs and Confidence-Banded Self-Healing telemetry,
 * and persists an idempotent weekly scorecard artifact under surface `kpi_snapshot` (role `metrics`).
 */
export function createWeeklyKpiSnapshotAction(
	ports: WeeklyKpiSnapshotPorts,
): ActionDefinition<typeof weeklyKpiSnapshotSchema, WeeklyKpiSnapshotResult> {
	return defineAction({
		id: "weekly_kpi_snapshot",
		description:
			"Compute and optionally persist the KMS Weekly Scorecard across Cloud Drives (OneDrive Personal, Google Drive 'angus' and 'work') and ahOS knowledge-management pillars (Knowledge & Capture, Tasks & Governance, System & Action Ledger) under dedup_key 'kpi_weekly:<YYYY-Www>' (surface 'kpi_snapshot', role 'metrics'). Distinct from the Work company scorecard on work-mcp (scorecard_*).",
		domain: "ops",
		schema: weeklyKpiSnapshotSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		run: async (input: WeeklyKpiSnapshotInput, ctx: ActionContext): Promise<WeeklyKpiSnapshotResult> => {
			const now = new Date();
			const generatedAt = now.toISOString();
			const windowDays = input.window_days ?? 7;
			const includeDrives = input.include_drives ?? true;
			const includeSystemDoctor = input.include_system_doctor ?? false;
			const recordSnapshot = input.record_snapshot ?? true;
			const weekKey = input.week_key ?? computeIsoWeekKey(now);
			const dedupKey = `kpi_weekly:${weekKey}`;
			const sinceDate = new Date(now.getTime() - windowDays * 86_400_000);
			const sinceIso = sinceDate.toISOString();
			const todayDateStr = generatedAt.slice(0, 10);
			const warnings: string[] = [];

			// 1. Cloud Drives & Parity
			let cloudDrives: CloudDrivesKpiSection;
			if (includeDrives) {
				const [onedrivePersonal, gdrivePersonal, gdriveWork] = await Promise.all([
					collectOneDriveSummary(ports.onedrive, warnings),
					collectGdriveDomainSummary(ports.drive, "angus", warnings),
					collectGdriveDomainSummary(ports.drive, "work", warnings),
				]);
				cloudDrives = {
					onedrive_personal: onedrivePersonal,
					gdrive_personal: gdrivePersonal,
					gdrive_work: gdriveWork,
				};
			} else {
				cloudDrives = {
					onedrive_personal: {
						status: "skipped",
						quota: null,
						root_item_count: 0,
						root_folder_count: 0,
						root_file_count: 0,
						top_folders: [],
						tracked_folders: { to_sort: null, work_project: null },
						duplicates: createEmptyDriveDuplicateMetrics(),
						folder_hygiene: null,
					},
					gdrive_personal: {
						domain: "angus",
						status: "skipped",
						sampled_item_count: 0,
						sampled_truncated: false,
						folder_count: 0,
						file_count: 0,
						google_native_count: 0,
						binary_file_count: 0,
						binary_bytes: 0,
						root_item_count: 0,
						root_folder_names: [],
						duplicates: createEmptyDriveDuplicateMetrics(),
						folder_hygiene: null,
					},
					gdrive_work: {
						domain: "work",
						status: "skipped",
						sampled_item_count: 0,
						sampled_truncated: false,
						folder_count: 0,
						file_count: 0,
						google_native_count: 0,
						binary_file_count: 0,
						binary_bytes: 0,
						root_item_count: 0,
						root_folder_names: [],
						duplicates: createEmptyDriveDuplicateMetrics(),
						folder_hygiene: null,
					},
				};
			}

			// 2. Knowledge & Capture Health
			const bySurface: Record<string, number> = {};
			let artifactsCaptured = 0;
			let evaluatedCount = 0;
			let cleanOk = 0;
			let cleanWarn = 0;
			let cleanFail = 0;
			let withEmbedding = 0;
			let missingEmbedding = 0;
			let derivCompleted = 0;
			let derivSkipped = 0;
			let derivPending = 0;
			let derivFailed = 0;
			let linkedArtifacts = 0;
			let totalEntityLinks = 0;
			let totalStructuralEdges = 0;

			try {
				if (ctx.userId) {
					const csData = await ports.cleanState.loadEvaluationData({
						userId: ctx.userId,
						windowDays,
					});
					artifactsCaptured = csData.artifacts.length;
					for (const art of csData.artifacts) {
						const surf = art.surface || "unknown";
						bySurface[surf] = (bySurface[surf] ?? 0) + 1;

						if (art.has_embedding) {
							withEmbedding++;
						} else {
							missingEmbedding++;
						}

						if (art.derivation_status === "completed") {
							derivCompleted++;
						} else if (art.derivation_status === "skipped") {
							derivSkipped++;
						} else if (art.derivation_status === "failed") {
							derivFailed++;
						} else {
							derivPending++;
						}

						if (art.entity_links.length > 0) {
							linkedArtifacts++;
							totalEntityLinks += art.entity_links.length;
						}
						totalStructuralEdges += art.structural_relationship_count ?? 0;

						// Skip self-scorecard snapshots when grading narrative Clean State
						if (
							art.surface === ARTIFACT_SURFACES.kpiSnapshot ||
							art.content_subtype === WEEKLY_KPI_SCORECARD_CONTENT_SUBTYPE
						) {
							continue;
						}

						evaluatedCount++;
						const ev = evaluateArtifactCleanState(art, csData.ledger);
						const statuses = Object.values(ev.layers);
						if (statuses.includes("fail")) {
							cleanFail++;
						} else if (statuses.includes("warn")) {
							cleanWarn++;
						} else {
							cleanOk++;
						}
					}
				} else {
					warnings.push("cleanState.loadEvaluationData skipped: no userId in ActionContext");
				}
			} catch (err) {
				warnings.push(
					`cleanState.loadEvaluationData failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			let duplicateGroupCount = 0;
			let redundantArtifactCount = 0;
			try {
				const dupRes = await ports.artifacts.documentDuplicates({ limit: 50 }, ctx.userId);
				duplicateGroupCount = dupRes.clusters.length;
				redundantArtifactCount = dupRes.clusters.reduce(
					(sum, cluster) => sum + Math.max(0, cluster.memberCount - 1),
					0,
				);
			} catch (err) {
				warnings.push(
					`artifacts.documentDuplicates failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			const knowledgeAndCapture: KnowledgeAndCaptureKpiSection = {
				window_days: windowDays,
				artifacts_captured: artifactsCaptured,
				by_surface: bySurface,
				clean_state: {
					evaluated_count: evaluatedCount,
					ok: cleanOk,
					warn: cleanWarn,
					fail: cleanFail,
					pass_rate_pct: roundPct(cleanOk, evaluatedCount, 100),
				},
				embedding_coverage: {
					with_embedding: withEmbedding,
					missing_embedding: missingEmbedding,
					coverage_pct: roundPct(withEmbedding, artifactsCaptured, 100),
				},
				derivation: {
					completed: derivCompleted,
					skipped: derivSkipped,
					pending: derivPending,
					failed: derivFailed,
				},
				graph_connectivity: {
					linked_artifacts: linkedArtifacts,
					total_entity_links: totalEntityLinks,
					total_structural_edges: totalStructuralEdges,
				},
				duplicates: {
					duplicate_group_count: duplicateGroupCount,
					redundant_artifact_count: redundantArtifactCount,
				},
			};

			// 3. Tasks & Governance
			const byStatus: Record<string, number> = {};
			let sampledTaskCount = 0;
			let activeOpenCount = 0;
			let completedInWindowCount = 0;
			let overdueCount = 0;
			let pendingReviewDecisions = 0;

			try {
				const tasksRes = await ports.tasks.taskCrud({ operation: "query", limit: 100 }, ctx);
				const tasks = tasksRes.tasks ?? [];
				sampledTaskCount = tasks.length;
				for (const t of tasks) {
					const st = t.status || "unknown";
					byStatus[st] = (byStatus[st] ?? 0) + 1;
					if (OPEN_TASK_STATUSES.has(st)) {
						activeOpenCount++;
						if (t.due_date && t.due_date.slice(0, 10) < todayDateStr) {
							overdueCount++;
						}
					}
					if (st === "done" && t.completed_at && t.completed_at >= sinceIso) {
						completedInWindowCount++;
					}
				}
			} catch (err) {
				warnings.push(`tasks.taskCrud failed: ${err instanceof Error ? err.message : String(err)}`);
			}

			try {
				const reviewRes = await ports.review.reviewList(
					{ status: "pending", limit: 100, offset: 0 },
					ctx.userId,
				);
				pendingReviewDecisions = reviewRes.total ?? reviewRes.decisions.length;
			} catch (err) {
				warnings.push(`review.reviewList failed: ${err instanceof Error ? err.message : String(err)}`);
			}

			const tasksAndGovernance: TasksAndGovernanceKpiSection = {
				sampled_task_count: sampledTaskCount,
				by_status: byStatus,
				active_open_count: activeOpenCount,
				completed_in_window_count: completedInWindowCount,
				overdue_count: overdueCount,
				pending_review_decisions: pendingReviewDecisions,
			};

			// 4. System & Ledger Health
			let totalInvocations = 0;
			let successCount = 0;
			let errorCount = 0;
			let pendingApprovalCount = 0;
			let ledgerRowEstimate = 0;
			let ledgerTotalBytes = 0;
			const actionMap = new Map<
				string,
				{ action_id: string; total: number; success: number; error: number; pending_approval: number }
			>();

			try {
				const ledgerSummary = await ports.ledger.querySummary({ since: sinceIso });
				ledgerRowEstimate = ledgerSummary.row_estimate;
				ledgerTotalBytes = ledgerSummary.total_bytes;

				for (const bucket of ledgerSummary.by_action) {
					totalInvocations += bucket.count;
					if (bucket.outcome === "success") successCount += bucket.count;
					else if (bucket.outcome === "error") errorCount += bucket.count;
					else if (bucket.outcome === "pending_approval") pendingApprovalCount += bucket.count;

					const entry = actionMap.get(bucket.action_id) ?? {
						action_id: bucket.action_id,
						total: 0,
						success: 0,
						error: 0,
						pending_approval: 0,
					};
					entry.total += bucket.count;
					if (bucket.outcome === "success") entry.success += bucket.count;
					else if (bucket.outcome === "error") entry.error += bucket.count;
					else if (bucket.outcome === "pending_approval") entry.pending_approval += bucket.count;
					actionMap.set(bucket.action_id, entry);
				}
			} catch (err) {
				warnings.push(`ledger.querySummary failed: ${err instanceof Error ? err.message : String(err)}`);
			}

			const topActions = [...actionMap.values()]
				.sort((a, b) => b.total - a.total || a.action_id.localeCompare(b.action_id))
				.slice(0, 10);

			let doctorSummary: SystemAndLedgerKpiSection["doctor"] = null;
			if (includeSystemDoctor && ports.doctor) {
				try {
					const checks: DoctorCheck[] = [];
					for (const family of DOCTOR_FAMILIES) {
						const familyChecks = await ports.doctor.run(family);
						checks.push(...familyChecks);
					}
					const status = verdictFor(checks);
					doctorSummary = {
						status,
						ok_count: checks.filter((c) => c.status === "ok").length,
						warn_count: checks.filter((c) => c.status === "warn").length,
						fail_count: checks.filter((c) => c.status === "fail").length,
					};
				} catch (err) {
					warnings.push(`doctor.run failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			const systemAndLedger: SystemAndLedgerKpiSection = {
				window_days: windowDays,
				total_invocations: totalInvocations,
				success_count: successCount,
				error_count: errorCount,
				pending_approval_count: pendingApprovalCount,
				success_rate_pct: roundPct(successCount, totalInvocations, 100),
				top_actions: topActions,
				ledger_row_estimate: ledgerRowEstimate,
				ledger_total_bytes: ledgerTotalBytes,
				doctor: doctorSummary,
			};

			// 5. Compute Self-Healing Confidence Bands & Composite KPIs
			const selfHealing = computeSelfHealingSummary({
				cloudDrives,
				knowledgeAndCapture,
			});
			const compositeKpis = computeCompositeKpis({
				cloudDrives,
				knowledgeAndCapture,
				tasksAndGovernance,
				systemAndLedger,
				selfHealing,
			});

			const markdown = renderWeeklyKpiScorecardMarkdown({
				weekKey,
				windowDays,
				generatedAt,
				cloudDrives,
				knowledgeAndCapture,
				tasksAndGovernance,
				systemAndLedger,
				compositeKpis,
				selfHealing,
				warnings,
			});

			// 6. Persist Weekly Scorecard Artifact (surface: kpi_snapshot -> role: metrics)
			let recordedArtifact: RecordedScorecardArtifact = {
				recorded: false,
				artifact_id: null,
				dedup_key: dedupKey,
				surface: ARTIFACT_SURFACES.kpiSnapshot,
				content_subtype: WEEKLY_KPI_SCORECARD_CONTENT_SUBTYPE,
				deduplicated: false,
				updated: false,
			};

			if (recordSnapshot) {
				const captureRes = await ports.artifacts.capture(
					{
						text: markdown,
						title: `KMS Weekly Scorecard — ${weekKey}`,
						content_subtype: WEEKLY_KPI_SCORECARD_CONTENT_SUBTYPE,
						surface: ARTIFACT_SURFACES.kpiSnapshot,
						captured_by: "weekly_kpi_snapshot",
						dedup_key: dedupKey,
						tags: ["kpi", "metrics", "kms-weekly-scorecard", weekKey],
						processing_metadata: {
							schema_version: 2,
							kpi_config_version: KPI_CONFIG_VERSION,
							week_key: weekKey,
							window_days: windowDays,
							generated_at: generatedAt,
							zero_commitments: true,
							derivation: {
								status: "skipped",
								reason: "role_metrics",
							},
							scorecard: {
								kpi_config_version: KPI_CONFIG_VERSION,
								cloud_drives: cloudDrives,
								knowledge_and_capture: knowledgeAndCapture,
								tasks_and_governance: tasksAndGovernance,
								system_and_ledger: systemAndLedger,
								composite_kpis: compositeKpis,
								self_healing: selfHealing,
								warnings,
							},
						},
					},
					ctx.userId,
					{ updateOnDedupKey: true },
				);

				recordedArtifact = {
					recorded: true,
					artifact_id: captureRes.id,
					dedup_key: dedupKey,
					surface: ARTIFACT_SURFACES.kpiSnapshot,
					content_subtype: WEEKLY_KPI_SCORECARD_CONTENT_SUBTYPE,
					deduplicated: Boolean(captureRes.deduplicated),
					updated: Boolean(captureRes.updated),
				};
			}

			return {
				week_key: weekKey,
				window_days: windowDays,
				generated_at: generatedAt,
				kpi_config_version: KPI_CONFIG_VERSION,
				stored_kpi_config_version: KPI_CONFIG_VERSION,
				cloud_drives: cloudDrives,
				knowledge_and_capture: knowledgeAndCapture,
				tasks_and_governance: tasksAndGovernance,
				system_and_ledger: systemAndLedger,
				composite_kpis: compositeKpis,
				self_healing: selfHealing,
				recorded_artifact: recordedArtifact,
				warnings,
				markdown,
			};
		},
		formatMcp: formatWeeklyKpiSnapshotMcp,
	});
}
