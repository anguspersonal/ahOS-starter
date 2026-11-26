import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import type { WeeklyKpiSnapshotResult } from "@ahkms/core";

const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockOrder = vi.fn();
const mockLimit = vi.fn();

vi.mock("../../lib/supabase.js", () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: "test-jwt-token" } },
      }),
    },
    from: vi.fn(() => ({
      select: mockSelect,
    })),
  },
}));

import {
  DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT,
  DashboardCanvas,
  computeWeeklyKpiDeltas,
  formatBytesGiB,
  loadStoredWeeklyScorecards,
  parseStoredScorecardArtifact,
  weeklyKpiSnapshotActionClient,
} from "./DashboardCanvas.js";
import { executeActionClient } from "../../lib/actionClient.js";

describe("DashboardCanvas — Weekly KPI Scorecard Dashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReturnValue({ eq: mockEq });
    mockEq.mockReturnValue({ order: mockOrder });
    mockOrder.mockReturnValue({ limit: mockLimit });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders all 4 KPI pillars, executive summary cards, cloud drive breakdowns, and action controls", () => {
    const priorWeek: WeeklyKpiSnapshotResult = {
      ...DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT,
      week_key: "2026-W43",
      cloud_drives: {
        ...DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT.cloud_drives,
        onedrive_personal: {
          ...DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT.cloud_drives.onedrive_personal,
          quota: {
            ...DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT.cloud_drives.onedrive_personal.quota!,
            used_pct: 54.9,
          },
        },
      },
      knowledge_and_capture: {
        ...DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT.knowledge_and_capture,
        artifacts_captured: 120,
        clean_state: {
          ...DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT.knowledge_and_capture.clean_state,
          pass_rate_pct: 95.0,
        },
      },
    };

    const html = renderToString(
      <DashboardCanvas
        initialSnapshot={DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT}
        initialHistory={[DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT, priorWeek]}
        autoLoad={false}
      />,
    );

    // Canvas & header controls
    expect(html).toContain('data-testid="dashboard-kpi-canvas"');
    expect(html).toContain("KMS Weekly Scorecard");
    expect(html).toContain('data-testid="kpi-config-version-badge"');
    expect(html).toContain("KPI Config v2.0.0");
    expect(html).toContain("dedup_efficiency_pct");
    expect(html).toContain("para_filing_pct");
    expect(html).toContain("naming_hygiene_pct");
    expect(html).toContain("quota_and_boundary_pct");
    expect(html).toContain('data-testid="kpi-week-select"');
    expect(html).toContain('data-testid="kpi-window-days-select"');
    expect(html).toContain('data-testid="kpi-toggle-drives"');
    expect(html).toContain('data-testid="kpi-toggle-doctor"');
    expect(html).toContain('data-testid="kpi-toggle-record"');
    expect(html).toContain('data-testid="run-weekly-snapshot-button"');

    // Executive Summary Strip
    expect(html).toContain('data-testid="kpi-summary-strip"');
    expect(html).toContain('data-testid="kpi-card-summary-drives"');
    expect(html).toContain('data-testid="kpi-card-summary-knowledge"');
    expect(html).toContain('data-testid="kpi-card-summary-tasks"');
    expect(html).toContain('data-testid="kpi-card-summary-system"');

    // Closed-Loop Pipeline Stepper, Composite KPIs, and 3-Band Confidence Self-Healing
    expect(html).toContain('data-testid="kpi-closed-loop-pipeline"');
    expect(html).toContain('data-testid="kpi-composite-section"');
    expect(html).toContain(
      'data-testid="composite-kpi-card-cloud_storage_hygiene_pct"',
    );
    expect(html).toContain(
      'data-testid="composite-kpi-card-zero_hitl_auto_heal_pool"',
    );
    expect(html).toContain('data-testid="kpi-confidence-bands-section"');
    expect(html).toContain('data-testid="confidence-band-high"');
    expect(html).toContain('data-testid="confidence-band-medium"');
    expect(html).toContain('data-testid="confidence-band-low"');
    expect(html).toContain("11383");
    expect(html).toContain("46.10 GiB");

    // Week-over-week deltas rendered in summary strip
    expect(html).toContain("-1.5% WoW");
    expect(html).toContain("+2.2% WoW");

    // 4 Detailed Pillar Sections
    expect(html).toContain('data-testid="kpi-pillar-cloud-drives"');
    expect(html).toContain('data-testid="kpi-onedrive-card"');
    expect(html).toContain('data-testid="kpi-onedrive-folder-hygiene"');
    expect(html).toContain("Shadowed root folders (target 0)");
    expect(html).toContain("Structural cleanliness");
    expect(html).toContain('data-testid="kpi-gdrive-personal-card"');
    expect(html).toContain('data-testid="kpi-gdrive-work-card"');
    expect(html).toContain("8.To Sort (#1249)");
    expect(html).toContain("1.Projects/Startups/Work (#1251)");

    expect(html).toContain('data-testid="kpi-pillar-knowledge"');
    expect(html).toContain("Clean State (OK/Warn/Fail)");
    expect(html).toContain("Entity Derivation");

    expect(html).toContain('data-testid="kpi-pillar-tasks"');
    expect(html).toContain('data-testid="kpi-pillar-system"');
    expect(html).toContain("Action Ledger");

    // Markdown section
    expect(html).toContain('data-testid="kpi-markdown-section"');
    expect(html).toContain('data-testid="kpi-toggle-markdown-button"');
  });

  it("renders empty state when no weekly scorecard is loaded yet", () => {
    const html = renderToString(
      <DashboardCanvas
        initialSnapshot={null}
        initialHistory={[]}
        autoLoad={false}
      />,
    );

    expect(html).toContain('data-testid="kpi-empty-state"');
    expect(html).toContain("No KMS Weekly Scorecard Loaded");
    expect(html).toContain('data-testid="empty-run-snapshot-button"');
    expect(html).toContain('data-testid="load-sample-scorecard-button"');
  });

  it("computes week-over-week deltas across all 4 pillars", () => {
    const noPrev = computeWeeklyKpiDeltas(
      DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT,
      null,
    );
    expect(noPrev.previous_week_key).toBeNull();
    expect(noPrev.onedrive_used_pct_delta).toBeNull();
    expect(noPrev.artifacts_captured_delta).toBeNull();

    const previous: WeeklyKpiSnapshotResult = {
      ...DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT,
      week_key: "2026-W43",
      cloud_drives: {
        onedrive_personal: {
          ...DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT.cloud_drives.onedrive_personal,
          quota: {
            ...DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT.cloud_drives.onedrive_personal.quota!,
            used_bytes: 600_000_000_000,
            used_pct: 54.9,
          },
          tracked_folders: {
            to_sort: { size_bytes: 590_000_000_000, child_count: 58 },
            work_project: { size_bytes: 1_412_589_120, child_count: 303 },
          },
          folder_hygiene: {
            ...DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT.cloud_drives.onedrive_personal
              .folder_hygiene!,
            shadowed_root_folder_count: 16,
            structural_cleanliness_pct: 81.2,
          },
        },
        gdrive_personal: {
          ...DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT.cloud_drives.gdrive_personal,
          sampled_item_count: 980,
        },
        gdrive_work: {
          ...DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT.cloud_drives.gdrive_work,
          sampled_item_count: 530,
        },
      },
      knowledge_and_capture: {
        ...DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT.knowledge_and_capture,
        artifacts_captured: 110,
        clean_state: {
          ...DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT.knowledge_and_capture.clean_state,
          pass_rate_pct: 95.0,
        },
        duplicates: {
          duplicate_group_count: 5,
          redundant_artifact_count: 6,
        },
      },
      tasks_and_governance: {
        ...DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT.tasks_and_governance,
        active_open_count: 27,
        completed_in_window_count: 14,
        pending_review_decisions: 4,
      },
      system_and_ledger: {
        ...DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT.system_and_ledger,
        success_rate_pct: 98.5,
      },
    };

    const deltas = computeWeeklyKpiDeltas(
      DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT,
      previous,
    );
    expect(deltas.previous_week_key).toBe("2026-W43");
    expect(deltas.onedrive_used_pct_delta).toBe(-1.5);
    expect(deltas.onedrive_to_sort_children_delta).toBe(-8);
    expect(deltas.onedrive_shadowed_roots_delta).toBe(-3);
    expect(deltas.onedrive_structural_cleanliness_delta).toBe(2.9);
    expect(deltas.gdrive_personal_items_delta).toBe(20);
    expect(deltas.gdrive_work_items_delta).toBe(17);
    expect(deltas.artifacts_captured_delta).toBe(32);
    expect(deltas.clean_state_pass_rate_delta).toBe(2.2);
    expect(deltas.duplicate_groups_delta).toBe(1);
    expect(deltas.active_open_tasks_delta).toBe(8);
    expect(deltas.completed_tasks_delta).toBe(4);
    expect(deltas.pending_reviews_delta).toBe(-1);
    expect(deltas.ledger_success_rate_delta).toBe(0);
  });

  it("parses and loads stored weekly KPI scorecard artifacts from Supabase", async () => {
    const storedRow = {
      id: "art-week-44",
      title: "Weekly ahOS KPI Scorecard — 2026-W44",
      content: DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT.markdown,
      dedup_key: "kpi_weekly:2026-W44",
      surface: "kpi_snapshot",
      content_subtype: "weekly_kpi_scorecard",
      created_at: "2026-11-01T11:25:00.000Z",
      updated_at: "2026-11-01T11:25:00.000Z",
      processing_metadata: {
        week_key: "2026-W44",
        window_days: 7,
        generated_at: "2026-11-01T11:25:00.000Z",
        scorecard: {
          cloud_drives: DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT.cloud_drives,
          knowledge_and_capture:
            DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT.knowledge_and_capture,
          tasks_and_governance:
            DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT.tasks_and_governance,
          system_and_ledger:
            DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT.system_and_ledger,
          warnings: [],
        },
      },
    };

    const parsed = parseStoredScorecardArtifact(storedRow);
    expect(parsed).not.toBeNull();
    expect(parsed?.week_key).toBe("2026-W44");
    expect(parsed?.kpi_config_version).toBe("2.0.0");
    expect(parsed?.stored_kpi_config_version).toBe("1.0.0");
    expect(parsed?.recorded_artifact?.artifact_id).toBe("art-week-44");
    expect(parsed?.cloud_drives.onedrive_personal.quota?.used_pct).toBe(53.4);

    expect(parseStoredScorecardArtifact(null)).toBeNull();
    expect(parseStoredScorecardArtifact({ id: "missing-meta" })).toBeNull();

    mockLimit.mockResolvedValueOnce({
      data: [storedRow, storedRow],
      error: null,
    });

    const loaded = await loadStoredWeeklyScorecards(12);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].week_key).toBe("2026-W44");
  });

  it("dispatches weekly_kpi_snapshot via executeActionClient and formats human byte strings", async () => {
    expect(formatBytesGiB(null)).toBe("—");
    expect(formatBytesGiB(1024 * 1024 * 50)).toBe("50.0 MiB");
    expect(formatBytesGiB(1024 ** 3 * 2)).toBe("2.00 GiB");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => DEFAULT_SAMPLE_WEEKLY_KPI_SNAPSHOT,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeActionClient(weeklyKpiSnapshotActionClient, {
      window_days: 7,
      include_drives: true,
      include_system_doctor: true,
      record_snapshot: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/actions/weekly_kpi_snapshot",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(result.week_key).toBe("2026-W44");
    expect(result.knowledge_and_capture.artifacts_captured).toBe(142);
  });
});
