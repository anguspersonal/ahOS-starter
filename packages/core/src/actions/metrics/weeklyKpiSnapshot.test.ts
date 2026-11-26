import { describe, expect, it, vi } from "vitest";
import { ARTIFACT_SURFACES } from "../../domain/artifacts.js";
import { executeAction } from "../adapters/direct.js";
import {
	KPI_CONFIG_VERSION,
	WEEKLY_KPI_SCORECARD_CONTENT_SUBTYPE,
	computeCompositeKpis,
	computeDriveDuplicateMetrics,
	computeIsoWeekKey,
	computeSelfHealingSummary,
	createWeeklyKpiSnapshotAction,
	extractCleanCanonicalFileName,
	formatWeeklyKpiSnapshotMcp,
	isCounterCopyFileName,
	isOsJunkFileName,
	normalizeCanonicalDuplicateFileName,
	normalizeVersionFamilyStem,
	recomputeSnapshotKpis,
	type WeeklyKpiSnapshotPorts,
} from "./weeklyKpiSnapshot.js";

const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";

function createFakePorts(overrides: Partial<WeeklyKpiSnapshotPorts> = {}): WeeklyKpiSnapshotPorts {
	return {
		onedrive: {
			getQuota: vi.fn().mockResolvedValue({
				total: 1024 ** 4, // 1 TiB
				used: 547 * 1024 ** 3,
				remaining: 477 * 1024 ** 3,
				deleted: 0,
				state: "normal",
			}),
			listChildren: vi.fn().mockImplementation(async ({ path }) => {
				if (!path) {
					return {
						items: [
							{
								id: "f-1",
								name: "8.To Sort",
								size: 540 * 1024 ** 3,
								folder: { childCount: 14 },
							},
							{
								id: "f-2",
								name: "1.Projects",
								size: 5 * 1024 ** 3,
								folder: { childCount: 3 },
							},
							{
								id: "file-1",
								name: "notes.txt",
								size: 1024,
								file: { hashes: { sha256Hash: "aaa111" } },
							},
						],
					};
				}
				if (path === "1.Projects/Startups/Work") {
					return {
						items: [
							{
								id: "hl-1",
								name: "Pitch.pptx",
								size: 2 * 1024 ** 2,
								parentReference: { id: "hl-folder" },
								file: { hashes: { sha256Hash: "bbb222" } },
							},
							{
								id: "hl-1-copy",
								name: "Pitch 1.pptx",
								size: 2 * 1024 ** 2,
								parentReference: { id: "hl-folder" },
								file: { hashes: { sha256Hash: "bbb222" } },
							},
							{
								id: "hl-2",
								name: "Financials.xlsx",
								size: 3 * 1024 ** 2,
								parentReference: { id: "hl-folder" },
								file: { hashes: { sha256Hash: "ccc333" } },
							},
						],
					};
				}
				return { items: [] };
			}),
		} as unknown as WeeklyKpiSnapshotPorts["onedrive"],
		drive: {
			listFiles: vi.fn().mockImplementation(async ({ domain, q }) => {
				if (String(q).includes("'root' in parents")) {
					return {
						files: [
							{
								id: `${domain}-root-1`,
								name: "1.Projects",
								mimeType: "application/vnd.google-apps.folder",
							},
						],
					};
				}
				return {
					files: [
						{
							id: `${domain}-1`,
							name: "1.Projects",
							mimeType: "application/vnd.google-apps.folder",
						},
						{
							id: `${domain}-2`,
							name: "Spec Doc",
							mimeType: "application/vnd.google-apps.document",
						},
						{
							id: `${domain}-3`,
							name: "Deck.pdf",
							mimeType: "application/pdf",
							size: String(4 * 1024 ** 2),
							parents: ["folder-a"],
							sha256Checksum: "ddd444",
						},
						{
							id: `${domain}-4`,
							name: "Deck.pdf",
							mimeType: "application/pdf",
							size: String(4 * 1024 ** 2),
							parents: ["folder-a"],
							sha256Checksum: "ddd444",
						},
					],
					nextPageToken: domain === "work" ? "next-token" : undefined,
				};
			}),
		} as unknown as WeeklyKpiSnapshotPorts["drive"],
		cleanState: {
			loadEvaluationData: vi.fn().mockResolvedValue({
				artifacts: [
					{
						id: "art-1",
						title: "Clean Note",
						content: "Full meeting summary with decisions.",
						surface: "claude_code",
						source_channel: "mcp",
						source_url: null,
						source_drive_file_id: null,
						content_subtype: "note",
						has_embedding: true,
						derivation_status: "completed",
						processing_metadata: { zero_commitments: true },
						external_links: [{ kind: "synthesized", url: "https://notion.so/1" }],
						entity_links: [{ entity_id: "ent-1", relationship_type: "about" }],
						structural_relationship_count: 2,
					},
					{
						id: "art-kpi-self",
						title: "KMS Weekly Scorecard — 2026-W44",
						content: "# KMS Weekly Scorecard",
						surface: ARTIFACT_SURFACES.kpiSnapshot,
						source_channel: "system",
						source_url: null,
						source_drive_file_id: null,
						content_subtype: WEEKLY_KPI_SCORECARD_CONTENT_SUBTYPE,
						has_embedding: true,
						derivation_status: "skipped",
						processing_metadata: { zero_commitments: true },
						external_links: [],
						entity_links: [],
						structural_relationship_count: 0,
					},
				],
				ledger: {
					error_count: 0,
					failed_actions: [],
				},
			}),
		},
		artifacts: {
			capture: vi.fn().mockResolvedValue({
				id: "scorecard-art-123",
				title: "KMS Weekly Scorecard — 2026-W44",
				tags: ["kpi", "metrics", "kms-weekly-scorecard", "2026-W44"],
				source_channel: "system",
				storage_bucket: "artifacts",
				storage_path: "notes/user/scorecard-art-123.md",
				captured_at: "2026-11-01T10:00:00.000Z",
				captured_at_declared: false,
				deduplicated: false,
				updated: true,
			}),
			documentDuplicates: vi.fn().mockResolvedValue({
				rows: [],
				clusters: [
					{
						kind: "exact",
						key: "hash-1",
						memberCount: 3,
						rankedMembers: 3,
						distinctContents: 1,
						unhashedMembers: 0,
						members: [],
					},
				],
				args: { limit: 50 },
			}),
		},
		tasks: {
			taskCrud: vi.fn().mockResolvedValue({
				operation: "query",
				tasks: [
					{
						id: "t-1",
						title: "Migrate Work files",
						status: "todo",
						due_date: "2020-01-01",
						completed_at: null,
					},
					{
						id: "t-2",
						title: "Audit 8.To Sort",
						status: "in_progress",
						due_date: "2099-12-31",
						completed_at: null,
					},
					{
						id: "t-3",
						title: "Ship RCA",
						status: "done",
						due_date: null,
						completed_at: new Date().toISOString(),
					},
				],
			}),
		} as unknown as WeeklyKpiSnapshotPorts["tasks"],
		review: {
			reviewList: vi.fn().mockResolvedValue({
				decisions: [{ id: "rev-1" }, { id: "rev-2" }],
				total: 2,
				limit: 100,
				offset: 0,
			}),
		} as unknown as WeeklyKpiSnapshotPorts["review"],
		ledger: {
			querySummary: vi.fn().mockResolvedValue({
				by_action: [
					{ action_id: "knowledge_search", outcome: "success", count: 40 },
					{ action_id: "capture", outcome: "success", count: 10 },
					{ action_id: "capture", outcome: "error", count: 2 },
				],
				row_estimate: 1250,
				total_bytes: 5 * 1024 ** 2,
			}),
		} as unknown as WeeklyKpiSnapshotPorts["ledger"],
		doctor: {
			run: vi.fn().mockResolvedValue([
				{ family: "supabase", name: "db", status: "ok", summary: "connected" },
			]),
		} as unknown as WeeklyKpiSnapshotPorts["doctor"],
		...overrides,
	};
}

describe("weekly_kpi_snapshot action (ADR-115 RCA)", () => {
	it("computes ISO week keys accurately in UTC", () => {
		expect(computeIsoWeekKey(new Date("2026-11-01T10:00:00Z"))).toBe("2026-W44");
		expect(computeIsoWeekKey(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01");
	});

	it("classifies drive duplicates deterministically across High, Medium, and Low confidence bands", () => {
		expect(normalizeCanonicalDuplicateFileName("Report 1.pdf")).toBe("report.pdf");
		expect(normalizeCanonicalDuplicateFileName("Report (2).pdf")).toBe("report.pdf");
		expect(normalizeCanonicalDuplicateFileName("Copy of Report.pdf")).toBe("report.pdf");
		expect(normalizeVersionFamilyStem("Service Charge Invoice v2 (draft).pdf")).toBe(
			"service charge invoice",
		);

		const metrics = computeDriveDuplicateMetrics([
			// Band 1 (High >=0.99): 3 copies in same folder with same canonical name + hash + size
			{
				id: "1",
				name: "Passport.pdf",
				parentKey: "7.Secure",
				sizeBytes: 1_000_000,
				hash: "sha256-passport",
			},
			{
				id: "2",
				name: "Passport 1.pdf",
				parentKey: "7.Secure",
				sizeBytes: 1_000_000,
				hash: "sha256-passport",
			},
			{
				id: "3",
				name: "Passport (2).pdf",
				parentKey: "7.Secure",
				sizeBytes: 1_000_000,
				hash: "sha256-passport",
			},
			// Band 2 (Medium 0.80-0.98): same hash + size in a different folder (8.To Sort)
			{
				id: "4",
				name: "Passport.pdf",
				parentKey: "8.To Sort",
				sizeBytes: 1_000_000,
				hash: "sha256-passport",
			},
			// Band 3 (Low <0.80): version family stem match with a different hash
			{
				id: "5",
				name: "Board Deck v1.pptx",
				parentKey: "1.Projects",
				sizeBytes: 2_000_000,
				hash: "sha256-deck-v1",
			},
			{
				id: "6",
				name: "Board Deck v2 final.pptx",
				parentKey: "1.Projects",
				sizeBytes: 2_500_000,
				hash: "sha256-deck-v2",
			},
		]);

		expect(metrics.evaluated_file_count).toBe(6);
		expect(metrics.hashed_file_count).toBe(6);

		// Band 1: 1 cluster in 7.Secure with 2 redundant counter-copies (2 MB reclaimable)
		expect(metrics.high_confidence_same_folder).toEqual({
			clusters: 1,
			redundant_files: 2,
			reclaimable_bytes: 2_000_000,
		});

		// Band 2: 1 cross-folder cluster between 7.Secure and 8.To Sort (1 redundant copy, 1 MB reclaimable)
		expect(metrics.medium_confidence_cross_folder).toEqual({
			clusters: 1,
			redundant_files: 1,
			reclaimable_bytes: 1_000_000,
		});

		// Band 3: 1 version-family cluster ("board deck") with 1 variant
		expect(metrics.low_confidence_version_families).toEqual({
			clusters: 1,
			redundant_files: 1,
		});

		expect(metrics.total_exact_clusters).toBe(2);
		expect(metrics.total_exact_redundant_files).toBe(3);
		expect(metrics.total_reclaimable_bytes).toBe(3_000_000);
		expect(metrics.duplicate_rate_pct).toBe(50);
		expect(metrics.counter_copy_named_files).toBe(2);
		expect(metrics.os_junk_files).toBe(0);

		const threeDigitMetrics = computeDriveDuplicateMetrics([
			{
				id: "1",
				name: "About Us – TeamVine.pptx",
				parentKey: "8.To Sort",
				sizeBytes: 2_700_000,
				hash: "sha256-teamvine",
			},
			{
				id: "2",
				name: "About Us – TeamVine 155.pptx",
				parentKey: "8.To Sort",
				sizeBytes: 2_700_000,
				hash: "sha256-teamvine",
			},
		]);
		expect(threeDigitMetrics.counter_copy_named_files).toBe(1);
	});

	it("identifies OS junk and counter-copy naming patterns and recomputes v1.0.0 snapshots under KPI_CONFIG_VERSION 2.0.0", async () => {
		expect(isOsJunkFileName(".DS_Store")).toBe(true);
		expect(isOsJunkFileName("Thumbs.db")).toBe(true);
		expect(isOsJunkFileName("~$Budget.xlsx")).toBe(true);
		expect(isOsJunkFileName("Passport.pdf")).toBe(false);

		expect(extractCleanCanonicalFileName("Report (1).pdf")).toBe("Report.pdf");
		expect(extractCleanCanonicalFileName("Copy of Pitch.pptx")).toBe("Pitch.pptx");
		expect(extractCleanCanonicalFileName("Summary 2.docx")).toBeNull();
		expect(extractCleanCanonicalFileName("Clean.pdf")).toBeNull();
		expect(isCounterCopyFileName("Report (1).pdf")).toBe(true);
		expect(isCounterCopyFileName("Summary - Copy.docx")).toBe(true);
		expect(isCounterCopyFileName("Summary 2.docx")).toBe(false);
		expect(isCounterCopyFileName("Clean.pdf")).toBe(false);

		const ports = createFakePorts();
		const action = createWeeklyKpiSnapshotAction(ports);
		const fresh = await executeAction(
			action,
			{ record_snapshot: false, week_key: "2026-W44" },
			{ context: { userId: TEST_USER_ID, caller: "test" }, auditSink: () => {} },
		);

		expect(fresh.kpi_config_version).toBe(KPI_CONFIG_VERSION);
		const hygieneKpi = fresh.composite_kpis.find((k) => k.id === "cloud_storage_hygiene_pct");
		expect(hygieneKpi?.kpi_config_version).toBe("2.0.0");
		expect(hygieneKpi?.constituent_metrics).toEqual(
			expect.objectContaining({
				dedup_efficiency_pct: expect.any(Number),
				para_filing_pct: expect.any(Number),
				naming_hygiene_pct: expect.any(Number),
				quota_and_boundary_pct: expect.any(Number),
			}),
		);

		// Simulate a legacy v1.0.0 snapshot stored in Supabase before KPI_CONFIG_VERSION 2.0.0
		const legacySnapshot = {
			...fresh,
			kpi_config_version: undefined,
			stored_kpi_config_version: undefined,
			composite_kpis: fresh.composite_kpis.map((k) =>
				k.id === "cloud_storage_hygiene_pct"
					? { ...k, value: 94.7, formula: "100 * (1 - exact_redundant_files / evaluated_file_count)" }
					: k,
			),
		};

		const recomputed = recomputeSnapshotKpis(legacySnapshot);
		expect(recomputed.kpi_config_version).toBe("2.0.0");
		expect(recomputed.stored_kpi_config_version).toBe("1.0.0");
		const recomputedHygiene = recomputed.composite_kpis.find(
			(k) => k.id === "cloud_storage_hygiene_pct",
		);
		expect(recomputedHygiene?.value).toBe(hygieneKpi?.value);
		expect(recomputedHygiene?.formula).toContain("0.35 * dedup_efficiency_pct");
	});

	it("collects Drive + non-Drive KPIs, computes composite KPIs & confidence bands, and persists the weekly scorecard artifact", async () => {
		const ports = createFakePorts();
		const action = createWeeklyKpiSnapshotAction(ports);

		const result = await executeAction(
			action,
			{
				window_days: 7,
				include_drives: true,
				include_system_doctor: true,
				record_snapshot: true,
				week_key: "2026-W44",
			},
			{
				context: { userId: TEST_USER_ID, caller: "test" },
				auditSink: () => {},
			},
		);

		expect(result.week_key).toBe("2026-W44");
		expect(result.warnings).toEqual([]);

		// 1. Cloud Drives + Duplicate Confidence Bands
		expect(result.cloud_drives.onedrive_personal.status).toBe("ok");
		expect(result.cloud_drives.onedrive_personal.quota?.used_pct).toBe(53.4);
		expect(result.cloud_drives.onedrive_personal.root_folder_count).toBe(2);
		expect(result.cloud_drives.onedrive_personal.root_file_count).toBe(1);
		expect(result.cloud_drives.onedrive_personal.tracked_folders.to_sort?.child_count).toBe(14);
		expect(result.cloud_drives.onedrive_personal.tracked_folders.work_project?.child_count).toBe(3);
		expect(
			result.cloud_drives.onedrive_personal.duplicates?.high_confidence_same_folder.redundant_files,
		).toBe(1);
		expect(result.cloud_drives.onedrive_personal.folder_hygiene).toMatchObject({
			sampled_folder_count: 2,
			shadowed_root_folder_count: 0,
			structural_cleanliness_pct: 100,
		});

		expect(result.cloud_drives.gdrive_personal.status).toBe("ok");
		expect(result.cloud_drives.gdrive_personal.sampled_item_count).toBe(4);
		expect(result.cloud_drives.gdrive_personal.sampled_truncated).toBe(false);
		expect(result.cloud_drives.gdrive_personal.google_native_count).toBe(1);
		expect(result.cloud_drives.gdrive_personal.binary_file_count).toBe(2);
		expect(
			result.cloud_drives.gdrive_personal.duplicates?.high_confidence_same_folder.redundant_files,
		).toBe(1);
		expect(result.cloud_drives.gdrive_personal.folder_hygiene).toMatchObject({
			sampled_folder_count: 1,
			shadowed_root_folder_count: 0,
			structural_cleanliness_pct: 100,
		});

		expect(result.cloud_drives.gdrive_work.status).toBe("ok");
		expect(result.cloud_drives.gdrive_work.sampled_truncated).toBe(true);

		// 2. Knowledge & Capture (self scorecard excluded from clean_state pass/fail denominator)
		expect(result.knowledge_and_capture.artifacts_captured).toBe(2);
		expect(result.knowledge_and_capture.clean_state.evaluated_count).toBe(1);
		expect(result.knowledge_and_capture.clean_state.ok).toBe(1);
		expect(result.knowledge_and_capture.clean_state.pass_rate_pct).toBe(100);
		expect(result.knowledge_and_capture.duplicates.duplicate_group_count).toBe(1);
		expect(result.knowledge_and_capture.duplicates.redundant_artifact_count).toBe(2);

		// 3. Tasks & Governance
		expect(result.tasks_and_governance.sampled_task_count).toBe(3);
		expect(result.tasks_and_governance.active_open_count).toBe(2);
		expect(result.tasks_and_governance.overdue_count).toBe(1);
		expect(result.tasks_and_governance.completed_in_window_count).toBe(1);
		expect(result.tasks_and_governance.pending_review_decisions).toBe(2);

		// 4. System & Ledger
		expect(result.system_and_ledger.total_invocations).toBe(52);
		expect(result.system_and_ledger.success_count).toBe(50);
		expect(result.system_and_ledger.error_count).toBe(2);
		expect(result.system_and_ledger.doctor?.status).toBe("ok");

		// 5. Composite KPIs & Self-Healing Confidence Bands
		expect(result.composite_kpis).toHaveLength(6);
		expect(result.composite_kpis?.map((k) => k.id)).toEqual([
			"cloud_storage_hygiene_pct",
			"zero_hitl_auto_heal_pool",
			"onedrive_quota_headroom_pct",
			"knowledge_clean_state_score_pct",
			"governance_execution_health_pct",
			"autonomous_action_reliability_pct",
		]);
		expect(result.self_healing?.bands.high_auto_heal.confidence_range).toBe(">=0.99");
		expect(result.self_healing?.bands.high_auto_heal.redundant_files).toBe(5); // 1 OD + 1 GD angus + 1 GD work + 2 KMS
		expect(result.self_healing?.bands.medium_rule_gated.confidence_range).toBe("0.80-0.98");
		expect(result.self_healing?.bands.low_hitl_review.confidence_range).toBe("<0.80");

		// 6. Recorded artifact
		expect(result.recorded_artifact).toEqual({
			recorded: true,
			artifact_id: "scorecard-art-123",
			dedup_key: "kpi_weekly:2026-W44",
			surface: ARTIFACT_SURFACES.kpiSnapshot,
			content_subtype: WEEKLY_KPI_SCORECARD_CONTENT_SUBTYPE,
			deduplicated: false,
			updated: true,
		});

		expect(ports.artifacts.capture).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "KMS Weekly Scorecard — 2026-W44",
				surface: "kpi_snapshot",
				content_subtype: "weekly_kpi_scorecard",
				dedup_key: "kpi_weekly:2026-W44",
				tags: ["kpi", "metrics", "kms-weekly-scorecard", "2026-W44"],
				processing_metadata: expect.objectContaining({
					week_key: "2026-W44",
					zero_commitments: true,
					derivation: { status: "skipped", reason: "role_metrics" },
				}),
			}),
			TEST_USER_ID,
			{ updateOnDedupKey: true },
		);

		const formatted = formatWeeklyKpiSnapshotMcp(result);
		expect(formatted).toContain("# KMS Weekly Scorecard — 2026-W44");
		expect(formatted).toContain("## 0. Composite KPIs (Built from Raw Metrics)");
		expect(formatted).toContain("## 0b. Self-Healing Confidence Bands (Minimal HITL)");
		expect(formatted).toContain("Recorded artifact: scorecard-art-123");
	});

	it("supports dry-run inspection (record_snapshot=false) and drive skipping (include_drives=false)", async () => {
		const ports = createFakePorts();
		const action = createWeeklyKpiSnapshotAction(ports);

		const result = await executeAction(
			action,
			{
				include_drives: false,
				record_snapshot: false,
				week_key: "2026-W44",
			},
			{
				context: { userId: TEST_USER_ID, caller: "test" },
				auditSink: () => {},
			},
		);

		expect(result.cloud_drives.onedrive_personal.status).toBe("skipped");
		expect(result.cloud_drives.gdrive_personal.status).toBe("skipped");
		expect(result.cloud_drives.gdrive_work.status).toBe("skipped");
		expect(result.composite_kpis).toHaveLength(6);
		expect(result.recorded_artifact.recorded).toBe(false);
		expect(result.recorded_artifact.artifact_id).toBeNull();
		expect(ports.artifacts.capture).not.toHaveBeenCalled();
	});

	it("degrades gracefully with warnings when an external drive provider fails", async () => {
		const ports = createFakePorts({
			onedrive: {
				getQuota: vi.fn().mockRejectedValue(new Error("OneDrive token expired")),
				listChildren: vi.fn().mockRejectedValue(new Error("OneDrive token expired")),
			} as unknown as WeeklyKpiSnapshotPorts["onedrive"],
		});
		const action = createWeeklyKpiSnapshotAction(ports);

		const result = await executeAction(
			action,
			{
				record_snapshot: false,
				week_key: "2026-W44",
			},
			{
				context: { userId: TEST_USER_ID, caller: "test" },
				auditSink: () => {},
			},
		);

		expect(result.cloud_drives.onedrive_personal.status).toBe("degraded");
		expect(result.warnings.length).toBeGreaterThanOrEqual(2);
		expect(result.warnings[0]).toContain("OneDrive token expired");

		// Standalone helpers also work directly
		const selfHealing = computeSelfHealingSummary({
			cloudDrives: result.cloud_drives,
			knowledgeAndCapture: result.knowledge_and_capture,
		});
		const kpis = computeCompositeKpis({
			cloudDrives: result.cloud_drives,
			knowledgeAndCapture: result.knowledge_and_capture,
			tasksAndGovernance: result.tasks_and_governance,
			systemAndLedger: result.system_and_ledger,
			selfHealing,
		});
		expect(kpis).toHaveLength(6);
	});

	it("excludes OneDrive Personal Vault from root file count and samples 8.To Sort children even when 8.To Sort is at root", async () => {
		const ports = createFakePorts({
			onedrive: {
				getQuota: vi.fn().mockResolvedValue({
					total: 1024 ** 4,
					used: 100 * 1024 ** 3,
					remaining: 924 * 1024 ** 3,
					deleted: 0,
					state: "normal",
				}),
				listChildren: vi.fn().mockImplementation(async ({ path }) => {
					if (!path) {
						return {
							items: [
								{
									id: "f-tosort",
									name: "8.To Sort",
									size: 10 * 1024 ** 3,
									folder: { childCount: 2 },
								},
								{
									id: "vault-sys",
									name: "Personal Vault",
									size: 0,
								},
							],
						};
					}
					if (path === "8.To Sort") {
						return {
							items: [
								{
									id: "ts-1",
									name: "Invoice.pdf",
									size: 4096,
									parentReference: { id: "f-tosort" },
									file: { hashes: { sha256Hash: "hash-inv" } },
								},
								{
									id: "ts-2",
									name: "Invoice (1).pdf",
									size: 4096,
									parentReference: { id: "f-tosort" },
									file: { hashes: { sha256Hash: "hash-inv" } },
								},
							],
						};
					}
					return { items: [] };
				}),
			} as unknown as WeeklyKpiSnapshotPorts["onedrive"],
		});
		const action = createWeeklyKpiSnapshotAction(ports);

		const result = await executeAction(
			action,
			{ record_snapshot: false, week_key: "2026-W45" },
			{ context: { userId: TEST_USER_ID, caller: "test" }, auditSink: () => {} },
		);

		expect(result.cloud_drives.onedrive_personal.root_file_count).toBe(0);
		expect(
			result.cloud_drives.onedrive_personal.duplicates?.high_confidence_same_folder.redundant_files,
		).toBe(1);
	});
});
