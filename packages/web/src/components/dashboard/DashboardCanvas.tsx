import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ARTIFACT_SURFACES,
  DAILY_EMAIL_FLOW_CONTENT_SUBTYPE,
  DAILY_EMAIL_FLOW_FORMULA,
  DAILY_EMAIL_FLOW_UNREAD_QUERY,
  KPI_CONFIG_VERSION,
  WEEKLY_KPI_SCORECARD_CONTENT_SUBTYPE,
  computeCompositeKpis,
  computeIsoWeekKey,
  computeSelfHealingSummary,
  parseStoredDailyEmailFlowArtifact,
  recomputeSnapshotKpis,
  weeklyKpiSnapshotSchema,
  type CloudDrivesKpiSection,
  type CompositeKpiItem,
  type DailyEmailFlowSnapshot,
  type KnowledgeAndCaptureKpiSection,
  type SelfHealingSummary,
  type SystemAndLedgerKpiSection,
  type TasksAndGovernanceKpiSection,
  type WeeklyKpiSnapshotInput,
  type WeeklyKpiSnapshotResult,
} from "@ahkms/core";
import {
  executeActionClient,
  type ClientActionDefinition,
} from "../../lib/actionClient.js";
import { navigateToTab } from "../../lib/router.js";
import { EmailPipelinePanel } from "./EmailPipelinePanel.js";
import { isSupabaseConfigured, supabase } from "../../lib/supabase.js";
import {
  DEFAULT_DAILY_EMAIL_FLOW_SNAPSHOT,
  loadStoredDailyEmailFlowSnapshots,
} from "../inbox/PriorityInboxCanvas.js";

/**
 * Parses a stored `public.artifacts` row (`content_subtype = 'daily_email_flow_scorecard'`)
 * into a `DailyEmailFlowSnapshot`.
 */
export function parseStoredDailyEmailFlowSnapshot(
  row: Record<string, unknown> | null | undefined,
): DailyEmailFlowSnapshot | null {
  return parseStoredDailyEmailFlowArtifact(row);
}

/**
 * Loads the latest stored `daily_email_flow_scorecard` artifact from `public.artifacts`
 * (`content_subtype = DAILY_EMAIL_FLOW_CONTENT_SUBTYPE`).
 */
export async function loadLatestStoredDailyEmailFlowSnapshot(): Promise<DailyEmailFlowSnapshot | null> {
  const snapshots = await loadStoredDailyEmailFlowSnapshots(14);
  if (snapshots.length > 0) {
    return snapshots[0];
  }
  if (!isSupabaseConfigured || !supabase || typeof supabase.from !== "function") {
    return null;
  }
  const { data, error } = await supabase
    .from("artifacts")
    .select(
      "id, title, dedup_key, surface, content_subtype, processing_metadata, created_at, updated_at",
    )
    .eq("content_subtype", DAILY_EMAIL_FLOW_CONTENT_SUBTYPE)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error || !Array.isArray(data) || data.length === 0) {
    return null;
  }
  return parseStoredDailyEmailFlowSnapshot(
    data[0] as Record<string, unknown>,
  );
}

/**
 * Client action definition for `POST /api/actions/weekly_kpi_snapshot`.
 */
export const weeklyKpiSnapshotActionClient: ClientActionDefinition<
  WeeklyKpiSnapshotInput,
  WeeklyKpiSnapshotResult
> = {
  id: "weekly_kpi_snapshot",
  name: "KMS Weekly Scorecard Snapshot",
  description:
    "Compute and optionally persist the ahOS KMS Weekly Scorecard across Cloud Drives, Knowledge & Capture, Tasks & Governance, and System & Action Ledger health (distinct from the Work company weekly scorecard on work-mcp).",
  schema: weeklyKpiSnapshotSchema,
};

export interface WeeklyKpiDeltas {
  previous_week_key: string | null;
  onedrive_used_bytes_delta: number | null;
  onedrive_used_pct_delta: number | null;
  onedrive_to_sort_children_delta: number | null;
  onedrive_shadowed_roots_delta: number | null;
  onedrive_structural_cleanliness_delta: number | null;
  gdrive_personal_items_delta: number | null;
  gdrive_work_items_delta: number | null;
  artifacts_captured_delta: number | null;
  clean_state_pass_rate_delta: number | null;
  duplicate_groups_delta: number | null;
  active_open_tasks_delta: number | null;
  completed_tasks_delta: number | null;
  pending_reviews_delta: number | null;
  ledger_success_rate_delta: number | null;
}

const SAMPLE_CLOUD_DRIVES: CloudDrivesKpiSection = {
  onedrive_personal: {
    status: "ok",
    quota: {
      total_bytes: 1_104_880_336_896,
      used_bytes: 589_808_418_816,
      remaining_bytes: 515_071_918_080,
      deleted_bytes: 2_384_912_384,
      used_pct: 53.4,
      state: "normal",
    },
    root_item_count: 8,
    root_folder_count: 8,
    root_file_count: 0,
    top_folders: [
      { name: "8.To Sort", size_bytes: 587_583_684_608, child_count: 50 },
      { name: "1.Projects", size_bytes: 1_845_493_760, child_count: 14 },
      { name: "2.Areas", size_bytes: 268_435_456, child_count: 9 },
      { name: "3.Resources", size_bytes: 110_804_992, child_count: 6 },
    ],
    tracked_folders: {
      to_sort: { size_bytes: 587_583_684_608, child_count: 50 },
      work_project: { size_bytes: 1_412_589_120, child_count: 303 },
    },
    duplicates: {
      evaluated_file_count: 28_277,
      hashed_file_count: 28_277,
      high_confidence_same_folder: {
        clusters: 280,
        redundant_files: 753,
        reclaimable_bytes: 316_522_496,
      },
      medium_confidence_cross_folder: {
        clusters: 3_326,
        redundant_files: 7_003,
        reclaimable_bytes: 20_215_169_024,
      },
      low_confidence_version_families: {
        clusters: 12_194,
        redundant_files: 26_197,
      },
      total_exact_clusters: 3_606,
      total_exact_redundant_files: 7_756,
      total_reclaimable_bytes: 20_531_691_520,
      duplicate_rate_pct: 27.4,
    },
    folder_hygiene: {
      provider: "onedrive",
      domain: "angus",
      sampled_folder_count: 138,
      truncated: false,
      max_depth_scanned: 4,
      collision_cluster_count: 26,
      root_shadowed_cluster_count: 7,
      multi_depth_cluster_count: 10,
      structural_collision_cluster_count: 17,
      cross_pillar_cluster_count: 9,
      shadowed_root_folder_count: 13,
      structural_duplicate_folder_count: 22,
      empty_shadow_folder_count: 10,
      shadowed_folder_bytes: 6_361_516_032,
      structural_cleanliness_pct: 84.1,
      top_collisions: [],
    },
  },
  gdrive_personal: {
    domain: "angus",
    status: "ok",
    sampled_item_count: 1000,
    sampled_truncated: true,
    folder_count: 168,
    file_count: 832,
    google_native_count: 214,
    binary_file_count: 618,
    binary_bytes: 19_428_431_872,
    root_item_count: 42,
    root_folder_names: ["1.Projects", "2.Areas", "3.Resources", "4.Archive", "8.To Sort"],
    duplicates: {
      evaluated_file_count: 16_716,
      hashed_file_count: 16_716,
      high_confidence_same_folder: {
        clusters: 482,
        redundant_files: 10_618,
        reclaimable_bytes: 49_177_378_816,
      },
      medium_confidence_cross_folder: {
        clusters: 44,
        redundant_files: 938,
        reclaimable_bytes: 3_868_622_848,
      },
      low_confidence_version_families: {
        clusters: 312,
        redundant_files: 640,
      },
      total_exact_clusters: 526,
      total_exact_redundant_files: 11_556,
      total_reclaimable_bytes: 53_046_001_664,
      duplicate_rate_pct: 69.1,
    },
    folder_hygiene: {
      provider: "gdrive",
      domain: "angus",
      sampled_folder_count: 168,
      truncated: true,
      max_depth_scanned: 4,
      collision_cluster_count: 3,
      root_shadowed_cluster_count: 1,
      multi_depth_cluster_count: 1,
      structural_collision_cluster_count: 2,
      cross_pillar_cluster_count: 1,
      shadowed_root_folder_count: 1,
      structural_duplicate_folder_count: 2,
      empty_shadow_folder_count: 0,
      shadowed_folder_bytes: 0,
      structural_cleanliness_pct: 98.8,
      top_collisions: [],
    },
  },
  gdrive_work: {
    domain: "work",
    status: "ok",
    sampled_item_count: 547,
    sampled_truncated: false,
    folder_count: 89,
    file_count: 458,
    google_native_count: 312,
    binary_file_count: 146,
    binary_bytes: 4_819_255_296,
    root_item_count: 9,
    root_folder_names: ["1.Product & Tech", "2.Clinical & Safety", "3.Commercial", "4.Operations"],
    duplicates: {
      evaluated_file_count: 458,
      hashed_file_count: 146,
      high_confidence_same_folder: {
        clusters: 2,
        redundant_files: 3,
        reclaimable_bytes: 8_388_608,
      },
      medium_confidence_cross_folder: {
        clusters: 1,
        redundant_files: 2,
        reclaimable_bytes: 4_194_304,
      },
      low_confidence_version_families: {
        clusters: 8,
        redundant_files: 12,
      },
      total_exact_clusters: 3,
      total_exact_redundant_files: 5,
      total_reclaimable_bytes: 12_582_912,
      duplicate_rate_pct: 1.1,
    },
    folder_hygiene: {
      provider: "gdrive",
      domain: "work",
      sampled_folder_count: 89,
      truncated: false,
      max_depth_scanned: 4,
      collision_cluster_count: 0,
      root_shadowed_cluster_count: 0,
      multi_depth_cluster_count: 0,
      structural_collision_cluster_count: 0,
      cross_pillar_cluster_count: 0,
      shadowed_root_folder_count: 0,
      structural_duplicate_folder_count: 0,
      empty_shadow_folder_count: 0,
      shadowed_folder_bytes: 0,
      structural_cleanliness_pct: 100,
      top_collisions: [],
    },
  },
};

const SAMPLE_KNOWLEDGE_AND_CAPTURE: KnowledgeAndCaptureKpiSection = {
  window_days: 7,
  artifacts_captured: 142,
  by_surface: {
    claude_code: 48,
    github: 39,
    discovered_gdrive_work: 28,
    slack: 19,
    kpi_snapshot: 1,
    other: 7,
  },
  clean_state: {
    evaluated_count: 142,
    ok: 138,
    warn: 4,
    fail: 0,
    pass_rate_pct: 97.2,
  },
  embedding_coverage: {
    with_embedding: 139,
    missing_embedding: 3,
    coverage_pct: 97.9,
  },
  derivation: {
    completed: 112,
    skipped: 27,
    pending: 3,
    failed: 0,
  },
  graph_connectivity: {
    linked_artifacts: 112,
    total_entity_links: 486,
    total_structural_edges: 1294,
  },
  duplicates: {
    duplicate_group_count: 6,
    redundant_artifact_count: 9,
  },
};

const SAMPLE_TASKS_AND_GOVERNANCE: TasksAndGovernanceKpiSection = {
  sampled_task_count: 84,
  by_status: {
    todo: 24,
    in_progress: 9,
    blocked: 2,
    done: 49,
  },
  active_open_count: 35,
  completed_in_window_count: 18,
  overdue_count: 2,
  pending_review_decisions: 3,
};

const SAMPLE_SYSTEM_AND_LEDGER: SystemAndLedgerKpiSection = {
  window_days: 7,
  total_invocations: 1840,
  success_count: 1812,
  error_count: 19,
  pending_approval_count: 9,
  success_rate_pct: 98.5,
  top_actions: [
    { action_id: "knowledge_search", total: 420, success: 419, error: 1, pending_approval: 0 },
    { action_id: "entity_query", total: 310, success: 310, error: 0, pending_approval: 0 },
    { action_id: "capture", total: 195, success: 193, error: 2, pending_approval: 0 },
    { action_id: "github_issue_get", total: 164, success: 164, error: 0, pending_approval: 0 },
    { action_id: "task_crud", total: 118, success: 115, error: 1, pending_approval: 2 },
  ],
  ledger_row_estimate: 14_820,
  ledger_total_bytes: 28_311_552,
  doctor: {
    status: "ok",
    ok_count: 24,
    warn_count: 1,
    fail_count: 0,
  },
};

const SAMPLE_SELF_HEALING = computeSelfHealingSummary({
  cloudDrives: SAMPLE_CLOUD_DRIVES,
  knowledgeAndCapture: SAMPLE_KNOWLEDGE_AND_CAPTURE,
  scheduleWindowDays: 3,
});

const SAMPLE_COMPOSITE_KPIS = computeCompositeKpis({
  cloudDrives: SAMPLE_CLOUD_DRIVES,
  knowledgeAndCapture: SAMPLE_KNOWLEDGE_AND_CAPTURE,
  tasksAndGovernance: SAMPLE_TASKS_AND_GOVERNANCE,
  systemAndLedger: SAMPLE_SYSTEM_AND_LEDGER,
  selfHealing: SAMPLE_SELF_HEALING,
});

export const DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT: WeeklyKpiSnapshotResult = {
  week_key: "2026-W44",
  window_days: 7,
  generated_at: "2026-11-01T11:25:00.000Z",
  kpi_config_version: KPI_CONFIG_VERSION,
  stored_kpi_config_version: KPI_CONFIG_VERSION,
  cloud_drives: SAMPLE_CLOUD_DRIVES,
  knowledge_and_capture: SAMPLE_KNOWLEDGE_AND_CAPTURE,
  tasks_and_governance: SAMPLE_TASKS_AND_GOVERNANCE,
  system_and_ledger: SAMPLE_SYSTEM_AND_LEDGER,
  composite_kpis: SAMPLE_COMPOSITE_KPIS,
  self_healing: SAMPLE_SELF_HEALING,
  recorded_artifact: {
    recorded: true,
    artifact_id: "00000000-0000-4000-8000-000000002044",
    dedup_key: "kpi_weekly:2026-W44",
    surface: ARTIFACT_SURFACES.kpiSnapshot,
    content_subtype: WEEKLY_KPI_SCORECARD_CONTENT_SUBTYPE,
    deduplicated: false,
    updated: true,
  },
  warnings: [],
  markdown: "# KMS Weekly Scorecard — 2026-W44\n\nGenerated at 2026-11-01T11:25:00.000Z (7-day window).",
};

export function formatBytesGiB(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "—";
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  }
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

/**
 * Computes week-over-week deltas between the selected weekly snapshot and a prior snapshot.
 */
export function computeWeeklyKpiDeltas(
  current: WeeklyKpiSnapshotResult,
  previous: WeeklyKpiSnapshotResult | null | undefined,
): WeeklyKpiDeltas {
  if (!previous) {
    return {
      previous_week_key: null,
      onedrive_used_bytes_delta: null,
      onedrive_used_pct_delta: null,
      onedrive_to_sort_children_delta: null,
      onedrive_shadowed_roots_delta: null,
      onedrive_structural_cleanliness_delta: null,
      gdrive_personal_items_delta: null,
      gdrive_work_items_delta: null,
      artifacts_captured_delta: null,
      clean_state_pass_rate_delta: null,
      duplicate_groups_delta: null,
      active_open_tasks_delta: null,
      completed_tasks_delta: null,
      pending_reviews_delta: null,
      ledger_success_rate_delta: null,
    };
  }

  const currOd = current.cloud_drives?.onedrive_personal;
  const prevOd = previous.cloud_drives?.onedrive_personal;

  return {
    previous_week_key: previous.week_key,
    onedrive_used_bytes_delta:
      currOd?.quota && prevOd?.quota
        ? currOd.quota.used_bytes - prevOd.quota.used_bytes
        : null,
    onedrive_used_pct_delta:
      currOd?.quota && prevOd?.quota
        ? round1(currOd.quota.used_pct - prevOd.quota.used_pct)
        : null,
    onedrive_to_sort_children_delta:
      currOd?.tracked_folders?.to_sort && prevOd?.tracked_folders?.to_sort
        ? currOd.tracked_folders.to_sort.child_count -
          prevOd.tracked_folders.to_sort.child_count
        : null,
    onedrive_shadowed_roots_delta:
      currOd?.folder_hygiene && prevOd?.folder_hygiene
        ? currOd.folder_hygiene.shadowed_root_folder_count -
          prevOd.folder_hygiene.shadowed_root_folder_count
        : null,
    onedrive_structural_cleanliness_delta:
      currOd?.folder_hygiene && prevOd?.folder_hygiene
        ? round1(
            currOd.folder_hygiene.structural_cleanliness_pct -
              prevOd.folder_hygiene.structural_cleanliness_pct,
          )
        : null,
    gdrive_personal_items_delta:
      current.cloud_drives?.gdrive_personal && previous.cloud_drives?.gdrive_personal
        ? current.cloud_drives.gdrive_personal.sampled_item_count -
          previous.cloud_drives.gdrive_personal.sampled_item_count
        : null,
    gdrive_work_items_delta:
      current.cloud_drives?.gdrive_work && previous.cloud_drives?.gdrive_work
        ? current.cloud_drives.gdrive_work.sampled_item_count -
          previous.cloud_drives.gdrive_work.sampled_item_count
        : null,
    artifacts_captured_delta:
      current.knowledge_and_capture.artifacts_captured -
      previous.knowledge_and_capture.artifacts_captured,
    clean_state_pass_rate_delta: round1(
      current.knowledge_and_capture.clean_state.pass_rate_pct -
        previous.knowledge_and_capture.clean_state.pass_rate_pct,
    ),
    duplicate_groups_delta:
      current.knowledge_and_capture.duplicates.duplicate_group_count -
      previous.knowledge_and_capture.duplicates.duplicate_group_count,
    active_open_tasks_delta:
      current.tasks_and_governance.active_open_count -
      previous.tasks_and_governance.active_open_count,
    completed_tasks_delta:
      current.tasks_and_governance.completed_in_window_count -
      previous.tasks_and_governance.completed_in_window_count,
    pending_reviews_delta:
      current.tasks_and_governance.pending_review_decisions -
      previous.tasks_and_governance.pending_review_decisions,
    ledger_success_rate_delta: round1(
      current.system_and_ledger.success_rate_pct -
        previous.system_and_ledger.success_rate_pct,
    ),
  };
}

/**
 * Parses a stored `artifacts` row (`surface = 'kpi_snapshot'` / `content_subtype = 'weekly_kpi_scorecard'`)
 * into a `WeeklyKpiSnapshotResult`.
 */
export function parseStoredScorecardArtifact(
  row: Record<string, unknown> | null | undefined,
): WeeklyKpiSnapshotResult | null {
  if (!row || typeof row !== "object") return null;
  const meta =
    row.processing_metadata && typeof row.processing_metadata === "object"
      ? (row.processing_metadata as Record<string, unknown>)
      : null;
  if (!meta) return null;

  const scorecard =
    meta.scorecard && typeof meta.scorecard === "object"
      ? (meta.scorecard as Record<string, unknown>)
      : null;
  if (!scorecard) return null;

  const cloudDrives = scorecard.cloud_drives as CloudDrivesKpiSection | undefined;
  const knowledgeAndCapture = scorecard.knowledge_and_capture as
    | KnowledgeAndCaptureKpiSection
    | undefined;
  const tasksAndGovernance = scorecard.tasks_and_governance as
    | TasksAndGovernanceKpiSection
    | undefined;
  const systemAndLedger = scorecard.system_and_ledger as
    | SystemAndLedgerKpiSection
    | undefined;

  if (!cloudDrives || !knowledgeAndCapture || !tasksAndGovernance || !systemAndLedger) {
    return null;
  }

  const selfHealing =
    (scorecard.self_healing as SelfHealingSummary | undefined) ??
    computeSelfHealingSummary({
      cloudDrives,
      knowledgeAndCapture,
    });

  const compositeKpis =
    Array.isArray(scorecard.composite_kpis) && scorecard.composite_kpis.length > 0
      ? (scorecard.composite_kpis as CompositeKpiItem[])
      : computeCompositeKpis({
          cloudDrives,
          knowledgeAndCapture,
          tasksAndGovernance,
          systemAndLedger,
          selfHealing,
        });

  const dedupKey =
    typeof row.dedup_key === "string" && row.dedup_key.trim().length > 0
      ? row.dedup_key.trim()
      : null;
  const weekFromDedup =
    dedupKey && dedupKey.startsWith("kpi_weekly:")
      ? dedupKey.slice("kpi_weekly:".length)
      : null;
  const weekKey =
    typeof meta.week_key === "string" && meta.week_key.trim().length > 0
      ? meta.week_key.trim()
      : weekFromDedup || computeIsoWeekKey();

  const windowDays =
    typeof meta.window_days === "number" && Number.isFinite(meta.window_days)
      ? meta.window_days
      : 7;
  const generatedAt =
    typeof meta.generated_at === "string" && meta.generated_at.trim().length > 0
      ? meta.generated_at
      : typeof row.updated_at === "string"
        ? row.updated_at
        : typeof row.created_at === "string"
          ? row.created_at
          : new Date().toISOString();

  const warnings = Array.isArray(scorecard.warnings)
    ? scorecard.warnings.filter((w): w is string => typeof w === "string")
    : [];

  const storedKpiConfigVersion =
    typeof scorecard.kpi_config_version === "string" &&
    scorecard.kpi_config_version.trim().length > 0
      ? scorecard.kpi_config_version.trim()
      : typeof meta.kpi_config_version === "string" &&
          meta.kpi_config_version.trim().length > 0
        ? meta.kpi_config_version.trim()
        : "1.0.0";

  return recomputeSnapshotKpis({
    week_key: weekKey,
    window_days: windowDays,
    generated_at: generatedAt,
    kpi_config_version: storedKpiConfigVersion,
    stored_kpi_config_version: storedKpiConfigVersion,
    cloud_drives: cloudDrives,
    knowledge_and_capture: knowledgeAndCapture,
    tasks_and_governance: tasksAndGovernance,
    system_and_ledger: systemAndLedger,
    composite_kpis: compositeKpis,
    self_healing: selfHealing,
    recorded_artifact: {
      recorded: true,
      artifact_id: typeof row.id === "string" ? row.id : null,
      dedup_key: dedupKey ?? `kpi_weekly:${weekKey}`,
      surface:
        typeof row.surface === "string" ? row.surface : ARTIFACT_SURFACES.kpiSnapshot,
      content_subtype:
        typeof row.content_subtype === "string"
          ? row.content_subtype
          : WEEKLY_KPI_SCORECARD_CONTENT_SUBTYPE,
      deduplicated: true,
      updated: false,
    },
    warnings,
    markdown: typeof row.content === "string" ? row.content : "",
  });
}

/**
 * Loads persisted weekly KPI scorecards from the `artifacts` table (newest week first).
 */
export async function loadStoredWeeklyScorecards(
  limit = 12,
): Promise<WeeklyKpiSnapshotResult[]> {
  if (!isSupabaseConfigured || !supabase) {
    return [];
  }

  const { data, error } = await supabase
    .from("artifacts")
    .select(
      "id, title, content, dedup_key, surface, content_subtype, processing_metadata, created_at, updated_at",
    )
    .eq("content_subtype", WEEKLY_KPI_SCORECARD_CONTENT_SUBTYPE)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !Array.isArray(data)) {
    return [];
  }

  const parsed: WeeklyKpiSnapshotResult[] = [];
  const seenWeeks = new Set<string>();
  for (const row of data) {
    const item = parseStoredScorecardArtifact(row as Record<string, unknown>);
    if (item && !seenWeeks.has(item.week_key)) {
      seenWeeks.add(item.week_key);
      parsed.push(item);
    }
  }

  return parsed.sort((a, b) => b.week_key.localeCompare(a.week_key));
}

function DeltaPill({
  delta,
  unit = "",
  invertGood = false,
}: {
  delta: number | null;
  unit?: string;
  invertGood?: boolean;
}) {
  if (delta === null || Number.isNaN(delta)) {
    return (
      <span className="text-[10px] font-mono text-slate-500">no prior week</span>
    );
  }
  if (delta === 0) {
    return (
      <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 text-[10px] font-mono">
        {`0${unit} WoW`}
      </span>
    );
  }
  const isPositive = delta > 0;
  const isGood = invertGood ? !isPositive : isPositive;
  const colorClass = isGood
    ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
    : "bg-amber-500/15 text-amber-300 border-amber-500/30";
  const sign = isPositive ? "+" : "";

  return (
    <span
      className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${colorClass}`}
    >
      {`${sign}${delta}${unit} WoW`}
    </span>
  );
}

export interface DashboardCanvasProps {
  initialSnapshot?: WeeklyKpiSnapshotResult | null;
  initialHistory?: WeeklyKpiSnapshotResult[];
  initialEmailFlow?: DailyEmailFlowSnapshot;
  autoLoad?: boolean;
}

export function DashboardCanvas({
  initialSnapshot = null,
  initialHistory = [],
  initialEmailFlow = DEFAULT_DAILY_EMAIL_FLOW_SNAPSHOT,
  autoLoad = true,
}: DashboardCanvasProps = {}) {
  const [emailFlow, setEmailFlow] = useState<DailyEmailFlowSnapshot>(
    () => initialEmailFlow,
  );
  const [history, setHistory] = useState<WeeklyKpiSnapshotResult[]>(() => {
    if (initialHistory.length > 0) return initialHistory;
    if (initialSnapshot) return [initialSnapshot];
    return [];
  });
  const [selectedWeekKey, setSelectedWeekKey] = useState<string>(() => {
    if (initialSnapshot) return initialSnapshot.week_key;
    if (initialHistory.length > 0) return initialHistory[0].week_key;
    return "";
  });

  const [includeDrives, setIncludeDrives] = useState(true);
  const [includeDoctor, setIncludeDoctor] = useState(true);
  const [recordSnapshot, setRecordSnapshot] = useState(true);
  const [windowDays, setWindowDays] = useState(7);

  const [loadingHistory, setLoadingHistory] = useState(false);
  const [runningSnapshot, setRunningSnapshot] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [showMarkdown, setShowMarkdown] = useState(false);

  const refreshHistory = useCallback(async () => {
    setLoadingHistory(true);
    setErrorMessage(null);
    try {
      const [stored, latestEmailFlow] = await Promise.all([
        loadStoredWeeklyScorecards(12),
        loadLatestStoredDailyEmailFlowSnapshot(),
      ]);
      if (stored.length > 0) {
        setHistory(stored);
        setSelectedWeekKey((prev) =>
          prev && stored.some((s) => s.week_key === prev)
            ? prev
            : stored[0].week_key,
        );
      }
      if (latestEmailFlow) {
        setEmailFlow(latestEmailFlow);
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to load stored scorecards",
      );
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    if (!autoLoad) return;
    void refreshHistory();
  }, [autoLoad, refreshHistory]);

  const activeSnapshot = useMemo<WeeklyKpiSnapshotResult | null>(() => {
    if (history.length === 0) return initialSnapshot;
    return (
      history.find((s) => s.week_key === selectedWeekKey) ?? history[0] ?? null
    );
  }, [history, initialSnapshot, selectedWeekKey]);

  const previousSnapshot = useMemo<WeeklyKpiSnapshotResult | null>(() => {
    if (!activeSnapshot || history.length < 2) return null;
    const idx = history.findIndex((s) => s.week_key === activeSnapshot.week_key);
    if (idx >= 0 && idx + 1 < history.length) {
      return history[idx + 1];
    }
    return null;
  }, [activeSnapshot, history]);

  const deltas = useMemo<WeeklyKpiDeltas | null>(() => {
    if (!activeSnapshot) return null;
    return computeWeeklyKpiDeltas(activeSnapshot, previousSnapshot);
  }, [activeSnapshot, previousSnapshot]);

  const activeSelfHealing = useMemo<SelfHealingSummary | null>(() => {
    if (!activeSnapshot) return null;
    return (
      activeSnapshot.self_healing ??
      computeSelfHealingSummary({
        cloudDrives: activeSnapshot.cloud_drives,
        knowledgeAndCapture: activeSnapshot.knowledge_and_capture,
      })
    );
  }, [activeSnapshot]);

  const activeCompositeKpis = useMemo<CompositeKpiItem[]>(() => {
    if (!activeSnapshot) return [];
    if (
      activeSnapshot.kpi_config_version === KPI_CONFIG_VERSION &&
      activeSnapshot.composite_kpis &&
      activeSnapshot.composite_kpis.length > 0
    ) {
      return activeSnapshot.composite_kpis;
    }
    return computeCompositeKpis({
      cloudDrives: activeSnapshot.cloud_drives,
      knowledgeAndCapture: activeSnapshot.knowledge_and_capture,
      tasksAndGovernance: activeSnapshot.tasks_and_governance,
      systemAndLedger: activeSnapshot.system_and_ledger,
      selfHealing: activeSelfHealing ?? undefined,
    });
  }, [activeSelfHealing, activeSnapshot]);

  const handleRunWeeklySnapshot = useCallback(async () => {
    setRunningSnapshot(true);
    setErrorMessage(null);
    setStatusBanner(null);
    try {
      const result = await executeActionClient(weeklyKpiSnapshotActionClient, {
        window_days: windowDays,
        include_drives: includeDrives,
        include_system_doctor: includeDoctor,
        record_snapshot: recordSnapshot,
      });
      setHistory((prev) => {
        const filtered = prev.filter((item) => item.week_key !== result.week_key);
        return [result, ...filtered].sort((a, b) =>
          b.week_key.localeCompare(a.week_key),
        );
      });
      setSelectedWeekKey(result.week_key);
      setStatusBanner(
        result.recorded_artifact.recorded
          ? `Scorecard ${result.week_key} computed and saved (${result.recorded_artifact.dedup_key}).`
          : `Scorecard ${result.week_key} computed (dry-run preview).`,
      );
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Failed to run weekly_kpi_snapshot action",
      );
    } finally {
      setRunningSnapshot(false);
    }
  }, [includeDoctor, includeDrives, recordSnapshot, windowDays]);

  const handleLoadSampleBaseline = useCallback(() => {
    setHistory([DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT]);
    setSelectedWeekKey(DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT.week_key);
    setEmailFlow(initialEmailFlow);
    setStatusBanner(
      `Loaded sample baseline scorecard (${DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT.week_key}).`,
    );
  }, [initialEmailFlow]);

  const od = activeSnapshot?.cloud_drives.onedrive_personal;
  const gdPersonal = activeSnapshot?.cloud_drives.gdrive_personal;
  const gdWork = activeSnapshot?.cloud_drives.gdrive_work;
  const kc = activeSnapshot?.knowledge_and_capture;
  const tg = activeSnapshot?.tasks_and_governance;
  const sl = activeSnapshot?.system_and_ledger;

  return (
    <div className="space-y-6" data-testid="dashboard-kpi-canvas">
      {/* 1. Top Header & Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <h2 className="text-lg font-bold text-white tracking-tight">
              KMS Weekly Scorecard &amp; Self-Healing Loop
            </h2>
            <span className="px-2 py-0.5 bg-indigo-500/20 text-indigo-400 text-xs font-mono font-medium rounded-full border border-indigo-500/30">
              ADR-115 · kms-weekly-scorecard
            </span>
            {activeSnapshot && (
              <>
                <span
                  data-testid="kpi-active-week-badge"
                  className="px-2 py-0.5 bg-emerald-500/15 text-emerald-300 text-xs font-mono font-semibold rounded-full border border-emerald-500/30"
                >
                  {activeSnapshot.week_key}
                </span>
                <span
                  data-testid="kpi-config-version-badge"
                  className="px-2 py-0.5 bg-slate-800 text-slate-300 text-[11px] font-mono rounded-full border border-slate-700"
                >
                  {`KPI Config v${activeSnapshot.kpi_config_version ?? KPI_CONFIG_VERSION}${
                    activeSnapshot.stored_kpi_config_version &&
                    activeSnapshot.stored_kpi_config_version !==
                      (activeSnapshot.kpi_config_version ?? KPI_CONFIG_VERSION)
                      ? ` (recomputed from v${activeSnapshot.stored_kpi_config_version})`
                      : ""
                  }`}
                </span>
              </>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-1">
            ahOS Knowledge Management &amp; Storage Hygiene Scorecard (Tools → Raw
            Metrics → Composite KPIs → Baseline → Dashboard → 3-Day Schedule →
            Confidence-Banded Self-Healing; company metrics live on{" "}
            <code className="text-slate-300 font-mono">work-mcp/scorecard_*</code>
            ).
          </p>
        </div>

        {/* Action & Filter Toolbar */}
        <div className="flex flex-wrap items-center gap-2.5">
          {history.length > 0 && (
            <div className="flex items-center gap-1.5">
              <label
                htmlFor="kpi-week-select"
                className="text-[11px] font-mono text-slate-400"
              >
                Week:
              </label>
              <select
                id="kpi-week-select"
                data-testid="kpi-week-select"
                value={activeSnapshot?.week_key ?? ""}
                onChange={(e) => setSelectedWeekKey(e.target.value)}
                className="bg-slate-900 border border-slate-700 text-slate-200 text-xs font-mono rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-indigo-500"
              >
                {history.map((snap) => (
                  <option key={snap.week_key} value={snap.week_key}>
                    {snap.week_key} ({snap.window_days}d)
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <label
              htmlFor="kpi-window-days-select"
              className="text-[11px] font-mono text-slate-400"
            >
              Window:
            </label>
            <select
              id="kpi-window-days-select"
              data-testid="kpi-window-days-select"
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.target.value) || 7)}
              className="bg-slate-900 border border-slate-700 text-slate-200 text-xs font-mono rounded-lg px-2 py-1.5"
            >
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
            </select>
          </div>

          <label className="flex items-center gap-1.5 text-xs text-slate-300 bg-slate-900/80 border border-slate-800 px-2.5 py-1.5 rounded-lg cursor-pointer">
            <input
              type="checkbox"
              data-testid="kpi-toggle-drives"
              checked={includeDrives}
              onChange={(e) => setIncludeDrives(e.target.checked)}
              className="rounded border-slate-700 bg-slate-950 text-indigo-500"
            />
            <span>Drives</span>
          </label>

          <label className="flex items-center gap-1.5 text-xs text-slate-300 bg-slate-900/80 border border-slate-800 px-2.5 py-1.5 rounded-lg cursor-pointer">
            <input
              type="checkbox"
              data-testid="kpi-toggle-doctor"
              checked={includeDoctor}
              onChange={(e) => setIncludeDoctor(e.target.checked)}
              className="rounded border-slate-700 bg-slate-950 text-indigo-500"
            />
            <span>Doctor</span>
          </label>

          <label className="flex items-center gap-1.5 text-xs text-slate-300 bg-slate-900/80 border border-slate-800 px-2.5 py-1.5 rounded-lg cursor-pointer">
            <input
              type="checkbox"
              data-testid="kpi-toggle-record"
              checked={recordSnapshot}
              onChange={(e) => setRecordSnapshot(e.target.checked)}
              className="rounded border-slate-700 bg-slate-950 text-indigo-500"
            />
            <span>Persist</span>
          </label>

          <button
            type="button"
            data-testid="run-weekly-snapshot-button"
            disabled={runningSnapshot}
            onClick={() => void handleRunWeeklySnapshot()}
            className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold rounded-lg transition-colors shadow-sm flex items-center gap-1.5"
          >
            <span>
              {runningSnapshot ? "Running Snapshot..." : "Run Weekly Snapshot"}
            </span>
          </button>
        </div>
      </div>

      {/* Closed-Loop Self-Healing Pipeline Stepper */}
      <div
        data-testid="kpi-closed-loop-pipeline"
        className="p-3 bg-slate-900/50 border border-slate-800 rounded-xl flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono"
      >
        {[
          { step: "1. Tools", desc: "Graph + Drive SHA-256", active: true },
          { step: "2. Metrics", desc: "Raw drive & KMS telemetry", active: true },
          { step: "3. Composite KPIs", desc: "6 KPIs from raw metrics", active: true },
          { step: "4. Baseline", desc: "kpi_weekly:2026-W44", active: Boolean(activeSnapshot) },
          { step: "5. Dashboard", desc: "Live scorecard UI", active: true },
          { step: "6. 3-Day Check", desc: "Scheduled convergence", active: true },
          { step: "7. Self-Heal", desc: "Confidence bands (min HITL)", active: true },
        ].map((stage, idx) => (
          <div
            key={stage.step}
            className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border ${
              stage.active
                ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-200"
                : "bg-slate-950/60 border-slate-800 text-slate-400"
            }`}
          >
            <span className="font-bold text-white">{stage.step}</span>
            <span className="text-slate-400 hidden sm:inline">· {stage.desc}</span>
            {idx < 6 && <span className="text-slate-600 ml-1">→</span>}
          </div>
        ))}
      </div>

      {/* Daily Email Flow Waterfall (Unread & Processed per Inbox + Combined) */}
      <section
        data-testid="kpi-daily-email-flow-section"
        className="p-4 bg-slate-900/70 border border-slate-800 rounded-xl space-y-3"
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-800 pb-2.5">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-bold text-white">
                Daily Email Flow Waterfall · Unread &amp; Processed ({emailFlow.date_key})
              </h3>
              <span className="px-2 py-0.5 bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 text-[11px] font-mono rounded">
                {DAILY_EMAIL_FLOW_FORMULA}
              </span>
              <span className="px-2 py-0.5 bg-slate-950 border border-slate-800 text-slate-400 text-[11px] font-mono rounded">
                {DAILY_EMAIL_FLOW_UNREAD_QUERY}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Tracks Starting, New Today, Processed ↑, and End ↓ separately for Personal (angus), Work (work), and Combined (all).
            </p>
          </div>
          <button
            type="button"
            data-testid="kpi-open-priority-inbox-btn"
            onClick={() => navigateToTab("inbox")}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-mono rounded-lg border border-slate-700 transition-colors"
          >
            Open Priority Inbox →
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs font-mono">
          {[
            {
              key: "personal",
              title: "Personal Inbox (angus)",
              badge: "personal",
              metrics: emailFlow.personal,
            },
            {
              key: "work",
              title: "Work Inbox (work)",
              badge: "work",
              metrics: emailFlow.work,
            },
            {
              key: "all",
              title: "Combined (All Inboxes)",
              badge: "all",
              metrics: emailFlow.combined,
            },
          ].map((card) => (
            <div
              key={card.key}
              data-testid={`kpi-email-flow-card-${card.key}`}
              className="p-3 bg-slate-950/80 border border-slate-800/90 rounded-lg space-y-2"
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white">{card.title}</span>
                <span className="text-[10px] px-1.5 py-0.5 bg-slate-900 border border-slate-800 rounded text-slate-300">
                  {card.metrics.clearance_rate_pct}% clearance
                </span>
              </div>
              <div className="grid grid-cols-4 gap-1.5 text-center pt-1">
                <div className="p-1.5 bg-slate-900/80 rounded border border-slate-800">
                  <span className="block text-[10px] text-slate-400">Start</span>
                  <span className="text-sm font-bold text-white">
                    {card.metrics.starting}
                  </span>
                </div>
                <div className="p-1.5 bg-slate-900/80 rounded border border-slate-800">
                  <span className="block text-[10px] text-amber-300">+New</span>
                  <span className="text-sm font-bold text-amber-300">
                    +{card.metrics.new_today}
                  </span>
                </div>
                <div className="p-1.5 bg-emerald-950/25 rounded border border-emerald-500/30">
                  <span className="block text-[10px] text-emerald-300">Proc ↑</span>
                  <span className="text-sm font-bold text-emerald-400">
                    {card.metrics.processed_today}
                  </span>
                </div>
                <div className="p-1.5 bg-indigo-950/30 rounded border border-indigo-500/30">
                  <span className="block text-[10px] text-indigo-300">End ↓</span>
                  <span className="text-sm font-bold text-white">
                    {card.metrics.end}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Status & Error Banners */}
      {errorMessage && (
        <div
          data-testid="kpi-error-banner"
          className="p-3 bg-rose-950/60 border border-rose-500/40 rounded-lg text-xs text-rose-200 flex items-center justify-between"
        >
          <span>{errorMessage}</span>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="text-rose-300 hover:text-white font-mono text-[11px]"
          >
            Dismiss
          </button>
        </div>
      )}

      {statusBanner && (
        <div
          data-testid="kpi-status-banner"
          className="p-3 bg-emerald-950/50 border border-emerald-500/40 rounded-lg text-xs text-emerald-200 flex items-center justify-between"
        >
          <span>{statusBanner}</span>
          <button
            type="button"
            onClick={() => setStatusBanner(null)}
            className="text-emerald-300 hover:text-white font-mono text-[11px]"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Empty State when no snapshot is loaded yet */}
      {!activeSnapshot && (
        <div
          data-testid="kpi-empty-state"
          className="p-8 bg-slate-900/50 border border-slate-800 border-dashed rounded-xl flex flex-col items-center justify-center min-h-[280px] text-center"
        >
          <h3 className="text-sm font-semibold text-slate-200">
            {loadingHistory
              ? "Loading stored KMS weekly scorecards..."
              : "No KMS Weekly Scorecard Loaded"}
          </h3>
          <p className="text-xs text-slate-400 max-w-md mt-1">
            Run a live weekly snapshot across OneDrive, Google Drive (Personal &amp;
            Work), Clean State, Tasks &amp; Governance, and the Action Ledger, or
            inspect the baseline scorecard.
          </p>
          <div className="flex items-center gap-3 mt-4">
            <button
              type="button"
              data-testid="empty-run-snapshot-button"
              disabled={runningSnapshot}
              onClick={() => void handleRunWeeklySnapshot()}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg transition-colors"
            >
              {runningSnapshot ? "Running..." : "Run Live Weekly Snapshot"}
            </button>
            <button
              type="button"
              data-testid="load-sample-scorecard-button"
              onClick={handleLoadSampleBaseline}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-lg border border-slate-700 transition-colors"
            >
              Preview Baseline Scorecard
            </button>
          </div>
        </div>
      )}

      {/* Email pipeline (ADR-118): independent of the weekly scorecard's load state. */}
      <EmailPipelinePanel autoLoad={autoLoad} />

      {/* Active Scorecard Content */}
      {activeSnapshot && od && gdPersonal && gdWork && kc && tg && sl && (
        <>
          {/* 2. Executive Summary Strip (4 Top-Level KPI Cards) */}
          <div
            data-testid="kpi-summary-strip"
            className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4"
          >
            {/* Card 1: Cloud Drives Headline */}
            <div
              data-testid="kpi-card-summary-drives"
              className="p-4 bg-slate-900/70 border border-slate-800 rounded-xl space-y-2"
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  1. Cloud Drives &amp; Quota
                </span>
                <DeltaPill
                  delta={deltas?.onedrive_used_pct_delta ?? null}
                  unit="%"
                  invertGood
                />
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-bold text-white font-mono">
                  {od.quota ? `${od.quota.used_pct}%` : od.status}
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  {od.quota
                    ? `${formatBytesGiB(od.quota.used_bytes)} / ${formatBytesGiB(od.quota.total_bytes)}`
                    : "OneDrive"}
                </span>
              </div>
              <div className="text-[11px] text-slate-400 flex items-center justify-between pt-1 border-t border-slate-800/80">
                <span>
                  GDrive Personal:{" "}
                  <strong className="text-slate-200 font-mono">
                    {gdPersonal.sampled_item_count}
                    {gdPersonal.sampled_truncated ? "+" : ""}
                  </strong>
                </span>
                <span>
                  Work:{" "}
                  <strong className="text-slate-200 font-mono">
                    {gdWork.sampled_item_count}
                    {gdWork.sampled_truncated ? "+" : ""}
                  </strong>
                </span>
              </div>
            </div>

            {/* Card 2: Knowledge & Clean State Headline */}
            <div
              data-testid="kpi-card-summary-knowledge"
              className="p-4 bg-slate-900/70 border border-slate-800 rounded-xl space-y-2"
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  2. Clean State &amp; Capture
                </span>
                <DeltaPill
                  delta={deltas?.clean_state_pass_rate_delta ?? null}
                  unit="%"
                />
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-bold text-emerald-400 font-mono">
                  {kc.clean_state.pass_rate_pct}%
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  {kc.artifacts_captured} captured ({kc.window_days}d)
                </span>
              </div>
              <div className="text-[11px] text-slate-400 flex items-center justify-between pt-1 border-t border-slate-800/80">
                <span>
                  Embeddings:{" "}
                  <strong className="text-slate-200 font-mono">
                    {kc.embedding_coverage.coverage_pct}%
                  </strong>
                </span>
                <span>
                  Duplicates:{" "}
                  <strong className="text-slate-200 font-mono">
                    {kc.duplicates.duplicate_group_count} clusters
                  </strong>
                </span>
              </div>
            </div>

            {/* Card 3: Tasks & Governance Headline */}
            <div
              data-testid="kpi-card-summary-tasks"
              className="p-4 bg-slate-900/70 border border-slate-800 rounded-xl space-y-2"
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  3. Tasks &amp; Governance
                </span>
                <DeltaPill
                  delta={deltas?.completed_tasks_delta ?? null}
                  unit=" done"
                />
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-bold text-white font-mono">
                  {tg.active_open_count} open
                </span>
                <span className="text-xs text-emerald-400 font-mono">
                  +{tg.completed_in_window_count} done ({activeSnapshot.window_days}d)
                </span>
              </div>
              <div className="text-[11px] text-slate-400 flex items-center justify-between pt-1 border-t border-slate-800/80">
                <span>
                  Overdue:{" "}
                  <strong className="text-amber-300 font-mono">
                    {tg.overdue_count}
                  </strong>
                </span>
                <span>
                  Pending Reviews:{" "}
                  <strong className="text-indigo-300 font-mono">
                    {tg.pending_review_decisions}
                  </strong>
                </span>
              </div>
            </div>

            {/* Card 4: System & Action Ledger Headline */}
            <div
              data-testid="kpi-card-summary-system"
              className="p-4 bg-slate-900/70 border border-slate-800 rounded-xl space-y-2"
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  4. System &amp; Ledger
                </span>
                <DeltaPill
                  delta={deltas?.ledger_success_rate_delta ?? null}
                  unit="%"
                />
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-bold text-white font-mono">
                  {sl.success_rate_pct}%
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  {sl.total_invocations} calls ({sl.window_days}d)
                </span>
              </div>
              <div className="text-[11px] text-slate-400 flex items-center justify-between pt-1 border-t border-slate-800/80">
                <span>
                  Doctor:{" "}
                  <strong
                    className={`font-mono uppercase ${
                      sl.doctor?.status === "ok"
                        ? "text-emerald-400"
                        : sl.doctor?.status === "warn"
                          ? "text-amber-300"
                          : sl.doctor?.status === "fail"
                            ? "text-rose-400"
                            : "text-slate-400"
                    }`}
                  >
                    {sl.doctor ? sl.doctor.status : "not run"}
                  </strong>
                </span>
                <span>
                  Errors:{" "}
                  <strong className="text-slate-200 font-mono">
                    {sl.error_count}
                  </strong>
                </span>
              </div>
            </div>
          </div>

          {/* 2b. Composite KPIs (Built from Raw Metrics) */}
          {activeCompositeKpis.length > 0 && (
            <section
              data-testid="kpi-composite-section"
              className="p-5 bg-slate-900/60 border border-slate-800 rounded-xl space-y-4"
            >
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-800 pb-3">
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Composite KPIs · Built from Constituent Raw Metrics
                  </h3>
                  <p className="text-xs text-slate-400">
                    Each KPI explicitly declares its mathematical formula, target
                    threshold, confidence band, and underlying atomic metrics.
                  </p>
                </div>
                <span className="px-2 py-0.5 bg-indigo-500/15 text-indigo-300 text-[11px] font-mono rounded border border-indigo-500/30">
                  {activeCompositeKpis.filter((k) => k.status === "healthy").length} /{" "}
                  {activeCompositeKpis.length} Healthy
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {activeCompositeKpis.map((kpi) => {
                  const statusColors =
                    kpi.status === "healthy"
                      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                      : kpi.status === "warning"
                        ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
                        : "bg-rose-500/15 text-rose-300 border-rose-500/30";
                  const bandLabel =
                    kpi.confidence_band === "high"
                      ? "HIGH ≥0.99 · Zero-HITL"
                      : kpi.confidence_band === "medium"
                        ? "MED 0.80–0.98 · Rule-Gated"
                        : "LOW <0.80 · HITL Queue";

                  return (
                    <div
                      key={kpi.id}
                      data-testid={`composite-kpi-card-${kpi.id}`}
                      className="p-4 bg-slate-950/70 border border-slate-800/90 rounded-lg space-y-2.5 flex flex-col justify-between"
                    >
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-white">
                            {kpi.name}
                          </span>
                          <span
                            className={`px-2 py-0.5 text-[10px] font-mono uppercase rounded border ${statusColors}`}
                          >
                            {kpi.status}
                          </span>
                        </div>

                        <div className="flex items-baseline justify-between">
                          <span className="text-2xl font-bold font-mono text-white">
                            {kpi.value}
                            {kpi.unit === "%" ? "%" : ` ${kpi.unit}`}
                          </span>
                          <span className="text-[11px] font-mono text-slate-400">
                            Target: <strong className="text-slate-200">{kpi.target}</strong>
                          </span>
                        </div>

                        <div className="text-[10px] font-mono text-indigo-300 bg-indigo-950/30 border border-indigo-500/20 rounded px-2 py-1 truncate">
                          ƒ = {kpi.formula}
                        </div>
                      </div>

                      <div className="pt-2 border-t border-slate-800/80 space-y-1.5">
                        <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
                          <span>Constituent Metrics</span>
                          <span className="text-slate-300">{bandLabel}</span>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(kpi.constituent_metrics).map(([mKey, mVal]) => (
                            <span
                              key={mKey}
                              className="px-1.5 py-0.5 bg-slate-900 border border-slate-800 rounded text-[10px] font-mono text-slate-300"
                            >
                              {mKey}: <strong>{String(mVal)}</strong>
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* 2c. Confidence-Banded Duplicate & Self-Healing Telemetry */}
          {activeSelfHealing && (
            <section
              data-testid="kpi-confidence-bands-section"
              className="p-5 bg-slate-900/60 border border-slate-800 rounded-xl space-y-4"
            >
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-800 pb-3">
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Self-Healing Readiness · 3 Confidence Bands (Minimal HITL)
                  </h3>
                  <p className="text-xs text-slate-400">
                    Deterministic duplicate &amp; hygiene classification across
                    OneDrive Personal, Google Drive Personal, and ahKMS artifacts
                    observed over a {activeSelfHealing.schedule_window_days}-day
                    scheduled convergence window.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="px-2.5 py-1 bg-emerald-500/15 text-emerald-300 text-xs font-mono rounded border border-emerald-500/30">
                    {formatBytesGiB(activeSelfHealing.total_reclaimable_bytes)} Reclaimable
                  </span>
                  <span className="px-2.5 py-1 bg-indigo-500/15 text-indigo-300 text-xs font-mono rounded border border-indigo-500/30">
                    {activeSelfHealing.auto_healable_pct}% Auto-Healable
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {[
                  {
                    testId: "confidence-band-high",
                    title: "Band 1 · High Confidence (≥ 0.99)",
                    badge: "Zero-HITL Auto-Heal",
                    badgeClass:
                      "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
                    tier: activeSelfHealing.bands.high_auto_heal,
                  },
                  {
                    testId: "confidence-band-medium",
                    title: "Band 2 · Medium Confidence (0.80–0.98)",
                    badge: "Rule-Gated Batch",
                    badgeClass:
                      "bg-amber-500/15 text-amber-300 border-amber-500/30",
                    tier: activeSelfHealing.bands.medium_rule_gated,
                  },
                  {
                    testId: "confidence-band-low",
                    title: "Band 3 · Low Confidence (< 0.80)",
                    badge: "HITL Review Queue",
                    badgeClass:
                      "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
                    tier: activeSelfHealing.bands.low_hitl_review,
                  },
                ].map(({ testId, title, badge, badgeClass, tier }) => (
                  <div
                    key={testId}
                    data-testid={testId}
                    className="p-4 bg-slate-950/70 border border-slate-800/90 rounded-lg space-y-3 flex flex-col justify-between"
                  >
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-white">
                          {title}
                        </span>
                        <span
                          className={`px-2 py-0.5 text-[10px] font-mono rounded border ${badgeClass}`}
                        >
                          {badge}
                        </span>
                      </div>

                      <div className="grid grid-cols-3 gap-2 text-xs pt-1">
                        <div className="p-2 bg-slate-900/80 rounded border border-slate-800">
                          <span className="block text-[10px] text-slate-400">
                            Clusters
                          </span>
                          <span className="font-mono font-bold text-white">
                            {tier.clusters.toLocaleString()}
                          </span>
                        </div>
                        <div className="p-2 bg-slate-900/80 rounded border border-slate-800">
                          <span className="block text-[10px] text-slate-400">
                            Redundant
                          </span>
                          <span className="font-mono font-bold text-slate-200">
                            {tier.redundant_files.toLocaleString()}
                          </span>
                        </div>
                        <div className="p-2 bg-slate-900/80 rounded border border-slate-800">
                          <span className="block text-[10px] text-slate-400">
                            Reclaimable
                          </span>
                          <span className="font-mono font-bold text-emerald-300">
                            {tier.reclaimable_bytes > 0
                              ? formatBytesGiB(tier.reclaimable_bytes)
                              : "n/a"}
                          </span>
                        </div>
                      </div>

                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        {tier.description}
                      </p>
                    </div>

                    <div className="pt-2 border-t border-slate-800/80 text-[11px] font-mono text-slate-300">
                      <strong className="text-indigo-300">Action:</strong>{" "}
                      {tier.recommended_action}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 3. Pillar 1: Cloud Drives & Parity */}
          <section
            data-testid="kpi-pillar-cloud-drives"
            className="p-5 bg-slate-900/60 border border-slate-800 rounded-xl space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-sm font-bold text-white">
                  Pillar 1 · Cloud Drives &amp; Track A Parity
                </h3>
                <p className="text-xs text-slate-400">
                  OneDrive Personal quota &amp; tracked folders (#1249 8.To Sort,
                  #1251 Work) + Google Drive Personal &amp; Work workspace
                  inventories.
                </p>
              </div>
              <span className="px-2 py-0.5 bg-slate-800 text-slate-300 text-[11px] font-mono rounded">
                OneDrive: {od.status} · GDrive: {gdPersonal.status}/{gdWork.status}
              </span>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* OneDrive Personal Card */}
              <div
                data-testid="kpi-onedrive-card"
                className="p-4 bg-slate-950/70 border border-slate-800/90 rounded-lg space-y-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-white">
                    OneDrive Personal (angus)
                  </span>
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300">
                    {od.quota ? `${od.quota.used_pct}% used` : od.status}
                  </span>
                </div>

                {od.quota && (
                  <div className="space-y-1.5">
                    <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          od.quota.used_pct >= 85
                            ? "bg-rose-500"
                            : od.quota.used_pct >= 70
                              ? "bg-amber-500"
                              : "bg-indigo-500"
                        }`}
                        style={{
                          width: `${Math.min(100, Math.max(2, od.quota.used_pct))}%`,
                        }}
                      />
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-[11px] text-slate-400 pt-1">
                      <div>
                        <span className="block text-slate-500">Used</span>
                        <span className="font-mono text-slate-200">
                          {formatBytesGiB(od.quota.used_bytes)}
                        </span>
                      </div>
                      <div>
                        <span className="block text-slate-500">Remaining</span>
                        <span className="font-mono text-slate-200">
                          {formatBytesGiB(od.quota.remaining_bytes)}
                        </span>
                      </div>
                      <div>
                        <span className="block text-slate-500">Recycle Bin</span>
                        <span className="font-mono text-slate-200">
                          {formatBytesGiB(od.quota.deleted_bytes)}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="pt-2 border-t border-slate-800/80 space-y-1.5 text-xs">
                  <div className="flex items-center justify-between text-slate-300">
                    <span>8.To Sort (#1249)</span>
                    <span className="font-mono text-amber-300">
                      {od.tracked_folders.to_sort
                        ? `${formatBytesGiB(od.tracked_folders.to_sort.size_bytes)} (${od.tracked_folders.to_sort.child_count} items)`
                        : "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-slate-300">
                    <span>1.Projects/Startups/Work (#1251)</span>
                    <span className="font-mono text-indigo-300">
                      {od.tracked_folders.work_project
                        ? `${formatBytesGiB(od.tracked_folders.work_project.size_bytes)} (${od.tracked_folders.work_project.child_count} items)`
                        : "—"}
                    </span>
                  </div>
                  {od.duplicates && (
                    <div className="flex items-center justify-between text-slate-300 text-[11px]">
                      <span>Duplicates (High / Med)</span>
                      <span className="font-mono text-emerald-300">
                        {od.duplicates.high_confidence_same_folder.redundant_files} auto ·{" "}
                        {od.duplicates.medium_confidence_cross_folder.redundant_files} cross (
                        {formatBytesGiB(od.duplicates.total_reclaimable_bytes)})
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between text-slate-400 text-[11px]">
                    <span>Root children</span>
                    <span className="font-mono">
                      {od.root_item_count} ({od.root_folder_count} folders,{" "}
                      {od.root_file_count} files)
                    </span>
                  </div>
                </div>

                {od.folder_hygiene && (
                  <div
                    data-testid="kpi-onedrive-folder-hygiene"
                    className="pt-2 border-t border-slate-800/80 space-y-1 text-[11px]"
                  >
                    <div className="flex items-center justify-between text-slate-300">
                      <span>Shadowed root folders (target 0)</span>
                      <span className="flex items-center gap-1.5">
                        <strong
                          className={`font-mono ${
                            od.folder_hygiene.shadowed_root_folder_count === 0
                              ? "text-emerald-400"
                              : "text-amber-300"
                          }`}
                        >
                          {od.folder_hygiene.shadowed_root_folder_count}
                        </strong>
                        <DeltaPill
                          delta={deltas?.onedrive_shadowed_roots_delta ?? null}
                          invertGood
                        />
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-slate-400">
                      <span>Structural cleanliness (target &gt;=98%)</span>
                      <span className="font-mono text-slate-200">
                        {od.folder_hygiene.structural_cleanliness_pct}% (
                        {od.folder_hygiene.empty_shadow_folder_count} empty
                        shadows)
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* Google Drive Personal (angus) Card */}
              <div
                data-testid="kpi-gdrive-personal-card"
                className="p-4 bg-slate-950/70 border border-slate-800/90 rounded-lg space-y-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-white">
                    Google Drive Personal (angus)
                  </span>
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300">
                    {gdPersonal.sampled_item_count}
                    {gdPersonal.sampled_truncated ? "+" : ""} items
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="p-2 bg-slate-900/80 rounded border border-slate-800/80">
                    <span className="block text-[10px] text-slate-400">
                      Files / Folders
                    </span>
                    <span className="font-mono text-slate-200 font-semibold">
                      {gdPersonal.file_count} files · {gdPersonal.folder_count}{" "}
                      folders
                    </span>
                  </div>
                  <div className="p-2 bg-slate-900/80 rounded border border-slate-800/80">
                    <span className="block text-[10px] text-slate-400">
                      Native vs Binary
                    </span>
                    <span className="font-mono text-slate-200 font-semibold">
                      {gdPersonal.google_native_count} Docs ·{" "}
                      {gdPersonal.binary_file_count} bin
                    </span>
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-800/80 space-y-1 text-[11px] text-slate-400">
                  <div className="flex items-center justify-between">
                    <span>Sampled binary payload</span>
                    <span className="font-mono text-slate-200">
                      {formatBytesGiB(gdPersonal.binary_bytes)}
                    </span>
                  </div>
                  {gdPersonal.duplicates && (
                    <div className="flex items-center justify-between text-slate-300">
                      <span>Duplicates (High / Med)</span>
                      <span className="font-mono text-emerald-300">
                        {gdPersonal.duplicates.high_confidence_same_folder.redundant_files} auto ·{" "}
                        {gdPersonal.duplicates.medium_confidence_cross_folder.redundant_files} cross (
                        {formatBytesGiB(gdPersonal.duplicates.total_reclaimable_bytes)})
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span>My Drive root items</span>
                    <span className="font-mono text-slate-200">
                      {gdPersonal.root_item_count}
                    </span>
                  </div>
                  <div className="truncate text-slate-500 pt-0.5">
                    Root folders: {gdPersonal.root_folder_names.join(", ") || "—"}
                  </div>
                  {gdPersonal.folder_hygiene && (
                    <div className="flex items-center justify-between pt-1 border-t border-slate-800/60 text-slate-300">
                      <span>Folder hygiene</span>
                      <span className="font-mono text-emerald-300">
                        {gdPersonal.folder_hygiene.structural_cleanliness_pct}%
                        clean ({gdPersonal.folder_hygiene.shadowed_root_folder_count}{" "}
                        shadowed)
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Google Drive Work (work) Card */}
              <div
                data-testid="kpi-gdrive-work-card"
                className="p-4 bg-slate-950/70 border border-slate-800/90 rounded-lg space-y-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-white">
                    Google Drive Workspace (work)
                  </span>
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-blue-500/15 text-blue-300">
                    {gdWork.sampled_item_count}
                    {gdWork.sampled_truncated ? "+" : ""} items
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="p-2 bg-slate-900/80 rounded border border-slate-800/80">
                    <span className="block text-[10px] text-slate-400">
                      Files / Folders
                    </span>
                    <span className="font-mono text-slate-200 font-semibold">
                      {gdWork.file_count} files · {gdWork.folder_count}{" "}
                      folders
                    </span>
                  </div>
                  <div className="p-2 bg-slate-900/80 rounded border border-slate-800/80">
                    <span className="block text-[10px] text-slate-400">
                      Native vs Binary
                    </span>
                    <span className="font-mono text-slate-200 font-semibold">
                      {gdWork.google_native_count} Docs ·{" "}
                      {gdWork.binary_file_count} bin
                    </span>
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-800/80 space-y-1 text-[11px] text-slate-400">
                  <div className="flex items-center justify-between">
                    <span>Sampled binary payload</span>
                    <span className="font-mono text-slate-200">
                      {formatBytesGiB(gdWork.binary_bytes)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>My Drive root items</span>
                    <span className="font-mono text-slate-200">
                      {gdWork.root_item_count}
                    </span>
                  </div>
                  <div className="truncate text-slate-500 pt-0.5">
                    Root folders: {gdWork.root_folder_names.join(", ") || "—"}
                  </div>
                  {gdWork.folder_hygiene && (
                    <div className="flex items-center justify-between pt-1 border-t border-slate-800/60 text-slate-300">
                      <span>Folder hygiene</span>
                      <span className="font-mono text-emerald-300">
                        {gdWork.folder_hygiene.structural_cleanliness_pct}%
                        clean ({gdWork.folder_hygiene.shadowed_root_folder_count}{" "}
                        shadowed)
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* 4. Pillar 2 & Pillar 3 Side-by-Side */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Pillar 2: Knowledge & Capture Health */}
            <section
              data-testid="kpi-pillar-knowledge"
              className="p-5 bg-slate-900/60 border border-slate-800 rounded-xl space-y-4"
            >
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Pillar 2 · Knowledge &amp; Capture Health
                  </h3>
                  <p className="text-xs text-slate-400">
                    ADR-114 5-Layer Clean State, pgvector embeddings, entity
                    derivation, and duplicate clusters.
                  </p>
                </div>
                <span className="px-2 py-0.5 bg-emerald-500/15 text-emerald-300 text-xs font-mono rounded">
                  {kc.clean_state.pass_rate_pct}% Clean
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                <div className="p-3 bg-slate-950/70 border border-slate-800 rounded-lg">
                  <span className="block text-[10px] text-slate-400">
                    Clean State (OK/Warn/Fail)
                  </span>
                  <span className="font-mono text-sm font-bold text-white mt-0.5 block">
                    {kc.clean_state.ok} / {kc.clean_state.warn} /{" "}
                    {kc.clean_state.fail}
                  </span>
                </div>
                <div className="p-3 bg-slate-950/70 border border-slate-800 rounded-lg">
                  <span className="block text-[10px] text-slate-400">
                    Embedding Coverage
                  </span>
                  <span className="font-mono text-sm font-bold text-emerald-400 mt-0.5 block">
                    {kc.embedding_coverage.coverage_pct}% (
                    {kc.embedding_coverage.with_embedding})
                  </span>
                </div>
                <div className="p-3 bg-slate-950/70 border border-slate-800 rounded-lg">
                  <span className="block text-[10px] text-slate-400">
                    Entity Derivation
                  </span>
                  <span className="font-mono text-sm font-bold text-indigo-300 mt-0.5 block">
                    {kc.derivation.completed} done · {kc.derivation.pending} pend
                  </span>
                </div>
                <div className="p-3 bg-slate-950/70 border border-slate-800 rounded-lg">
                  <span className="block text-[10px] text-slate-400">
                    Duplicate Hygiene
                  </span>
                  <span className="font-mono text-sm font-bold text-amber-300 mt-0.5 block">
                    {kc.duplicates.duplicate_group_count} grp (
                    {kc.duplicates.redundant_artifact_count} files)
                  </span>
                </div>
              </div>

              {/* Surface Capture Breakdown */}
              <div className="space-y-1.5">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  Captured by Surface ({kc.artifacts_captured} total)
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(kc.by_surface).map(([surface, count]) => (
                    <span
                      key={surface}
                      className="px-2 py-0.5 bg-slate-950 border border-slate-800 rounded text-[11px] font-mono text-slate-300"
                    >
                      {surface}: <strong>{count}</strong>
                    </span>
                  ))}
                </div>
              </div>

              {/* Graph Connectivity */}
              <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
                <span>
                  Linked Artifacts:{" "}
                  <strong className="text-slate-200 font-mono">
                    {kc.graph_connectivity.linked_artifacts}
                  </strong>
                </span>
                <span>
                  Entity Links:{" "}
                  <strong className="text-slate-200 font-mono">
                    {kc.graph_connectivity.total_entity_links}
                  </strong>
                </span>
                <span>
                  Structural Edges:{" "}
                  <strong className="text-slate-200 font-mono">
                    {kc.graph_connectivity.total_structural_edges}
                  </strong>
                </span>
              </div>
            </section>

            {/* Pillar 3: Tasks & Governance */}
            <section
              data-testid="kpi-pillar-tasks"
              className="p-5 bg-slate-900/60 border border-slate-800 rounded-xl space-y-4"
            >
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Pillar 3 · Tasks &amp; Governance
                  </h3>
                  <p className="text-xs text-slate-400">
                    Open task backlog, weekly completion velocity, overdue items,
                    and pending HITL review decisions.
                  </p>
                </div>
                <span className="px-2 py-0.5 bg-indigo-500/15 text-indigo-300 text-xs font-mono rounded">
                  {tg.sampled_task_count} sampled
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                <div className="p-3 bg-slate-950/70 border border-slate-800 rounded-lg">
                  <span className="block text-[10px] text-slate-400">
                    Active Open
                  </span>
                  <span className="font-mono text-lg font-bold text-white mt-0.5 block">
                    {tg.active_open_count}
                  </span>
                </div>
                <div className="p-3 bg-slate-950/70 border border-slate-800 rounded-lg">
                  <span className="block text-[10px] text-slate-400">
                    Completed ({activeSnapshot.window_days}d)
                  </span>
                  <span className="font-mono text-lg font-bold text-emerald-400 mt-0.5 block">
                    {tg.completed_in_window_count}
                  </span>
                </div>
                <div className="p-3 bg-slate-950/70 border border-slate-800 rounded-lg">
                  <span className="block text-[10px] text-slate-400">
                    Overdue Tasks
                  </span>
                  <span className="font-mono text-lg font-bold text-amber-300 mt-0.5 block">
                    {tg.overdue_count}
                  </span>
                </div>
                <div className="p-3 bg-slate-950/70 border border-slate-800 rounded-lg">
                  <span className="block text-[10px] text-slate-400">
                    Pending Reviews
                  </span>
                  <span className="font-mono text-lg font-bold text-indigo-300 mt-0.5 block">
                    {tg.pending_review_decisions}
                  </span>
                </div>
              </div>

              {/* Status Distribution */}
              <div className="space-y-1.5">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  Tasks by Status
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(tg.by_status).map(([status, count]) => (
                    <span
                      key={status}
                      className="px-2.5 py-1 bg-slate-950 border border-slate-800 rounded text-xs font-mono text-slate-300"
                    >
                      {status}: <strong>{count}</strong>
                    </span>
                  ))}
                </div>
              </div>
            </section>
          </div>

          {/* 5. Pillar 4: System & Action Ledger */}
          <section
            data-testid="kpi-pillar-system"
            className="p-5 bg-slate-900/60 border border-slate-800 rounded-xl space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-sm font-bold text-white">
                  Pillar 4 · System &amp; Action Ledger Health
                </h3>
                <p className="text-xs text-slate-400">
                  Append-only action_ledger invocation volume, success rate, top
                  dispatched CAR actions, and ahos_doctor checks.
                </p>
              </div>
              <span className="px-2 py-0.5 bg-slate-800 text-slate-300 text-xs font-mono rounded">
                {sl.ledger_row_estimate.toLocaleString()} est. rows (
                {formatBytesGiB(sl.ledger_total_bytes)})
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
              <div className="p-3 bg-slate-950/70 border border-slate-800 rounded-lg">
                <span className="block text-[10px] text-slate-400">
                  Invocations ({sl.window_days}d)
                </span>
                <span className="font-mono text-base font-bold text-white mt-0.5 block">
                  {sl.total_invocations}
                </span>
              </div>
              <div className="p-3 bg-slate-950/70 border border-slate-800 rounded-lg">
                <span className="block text-[10px] text-slate-400">
                  Success Rate
                </span>
                <span className="font-mono text-base font-bold text-emerald-400 mt-0.5 block">
                  {sl.success_rate_pct}% ({sl.success_count})
                </span>
              </div>
              <div className="p-3 bg-slate-950/70 border border-slate-800 rounded-lg">
                <span className="block text-[10px] text-slate-400">
                  Action Errors
                </span>
                <span className="font-mono text-base font-bold text-rose-400 mt-0.5 block">
                  {sl.error_count}
                </span>
              </div>
              <div className="p-3 bg-slate-950/70 border border-slate-800 rounded-lg">
                <span className="block text-[10px] text-slate-400">
                  Pending Approval
                </span>
                <span className="font-mono text-base font-bold text-amber-300 mt-0.5 block">
                  {sl.pending_approval_count}
                </span>
              </div>
              <div className="p-3 bg-slate-950/70 border border-slate-800 rounded-lg">
                <span className="block text-[10px] text-slate-400">
                  ahos_doctor Verdict
                </span>
                <span className="font-mono text-base font-bold text-white mt-0.5 block uppercase">
                  {sl.doctor
                    ? `${sl.doctor.status} (${sl.doctor.ok_count}/${sl.doctor.warn_count}/${sl.doctor.fail_count})`
                    : "skipped"}
                </span>
              </div>
            </div>

            {sl.top_actions.length > 0 && (
              <div className="overflow-x-auto">
                <table
                  data-testid="kpi-top-actions-table"
                  className="w-full text-left border-collapse text-xs"
                >
                  <thead>
                    <tr className="border-b border-slate-800 text-[11px] font-mono text-slate-400">
                      <th className="py-2 pr-4">Action ID</th>
                      <th className="py-2 px-3">Total</th>
                      <th className="py-2 px-3">Success</th>
                      <th className="py-2 px-3">Error</th>
                      <th className="py-2 pl-3">Pending Gate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono">
                    {sl.top_actions.map((row) => (
                      <tr key={row.action_id} className="text-slate-300">
                        <td className="py-1.5 pr-4 text-indigo-300">
                          {row.action_id}
                        </td>
                        <td className="py-1.5 px-3">{row.total}</td>
                        <td className="py-1.5 px-3 text-emerald-400">
                          {row.success}
                        </td>
                        <td className="py-1.5 px-3 text-rose-400">
                          {row.error}
                        </td>
                        <td className="py-1.5 pl-3 text-amber-300">
                          {row.pending_approval}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* 6. Collapsible Markdown Scorecard & Warnings Footer */}
          <div
            data-testid="kpi-markdown-section"
            className="p-4 bg-slate-900/40 border border-slate-800 rounded-xl space-y-3"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 text-xs text-slate-400 font-mono">
                <span>
                  Dedup key:{" "}
                  <strong className="text-slate-200">
                    {activeSnapshot.recorded_artifact.dedup_key}
                  </strong>
                </span>
                <span>·</span>
                <span>
                  Surface:{" "}
                  <strong className="text-slate-200">
                    {activeSnapshot.recorded_artifact.surface}
                  </strong>
                </span>
                {activeSnapshot.warnings.length > 0 && (
                  <span className="text-amber-300">
                    · {activeSnapshot.warnings.length} warning(s)
                  </span>
                )}
              </div>
              <button
                type="button"
                data-testid="kpi-toggle-markdown-button"
                onClick={() => setShowMarkdown((prev) => !prev)}
                className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-mono rounded border border-slate-700"
              >
                {showMarkdown ? "Hide Markdown" : "View Markdown Scorecard"}
              </button>
            </div>

            {showMarkdown && (
              <pre
                data-testid="kpi-markdown-preview"
                className="p-4 bg-slate-950 border border-slate-800 rounded-lg text-xs font-mono text-slate-300 overflow-x-auto whitespace-pre-wrap"
              >
                {activeSnapshot.markdown}
              </pre>
            )}
          </div>
        </>
      )}
    </div>
  );
}
