import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DRIVE_HYGIENE_CADENCE_INTERVAL_MS,
	createDriveHygieneCadence,
	runDriveHygieneSweep,
} from "./driveHygieneCadence.js";

const OWNER = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

describe("runDriveHygieneSweep & createDriveHygieneCadence (ADR-115 Stage 7A)", () => {
	it("executes drive_hygiene_heal (dry_run=false) followed by weekly_kpi_snapshot and returns aggregated counts", async () => {
		const healHandler = vi.fn().mockResolvedValue({
			kpi_config_version: "2.0.0",
			dry_run: false,
			provider: "both",
			levers: [
				"dedup_same_folder",
				"delete_os_junk",
				"rename_orphan_counter_copies",
				"file_root_loose_to_sort",
			],
			max_actions: 100,
			summary: {
				candidates_found: 12,
				planned_within_cap: 12,
				executed_count: 12,
				failed_count: 0,
				skipped_cap_count: 0,
				reclaimed_bytes: 5_242_880,
				by_lever: {
					dedup_same_folder: { candidates: 10, executed: 10, reclaimed_bytes: 5_242_880 },
					delete_os_junk: { candidates: 1, executed: 1, reclaimed_bytes: 0 },
					rename_orphan_counter_copies: { candidates: 1, executed: 1, reclaimed_bytes: 0 },
					file_root_loose_to_sort: { candidates: 0, executed: 0, reclaimed_bytes: 0 },
				},
			},
			operations: [],
			warnings: [],
			markdown: "# Healed",
		});

		const snapshotHandler = vi.fn().mockResolvedValue({
			week_key: "2026-W45",
			composite_kpis: [
				{
					id: "cloud_storage_hygiene_pct",
					value: 76.4,
				},
			],
			recorded_artifact: {
				recorded: true,
				artifact_id: "art-w45-id",
			},
		});

		const registry = {
			get: vi.fn((id: string) => {
				if (id === "drive_hygiene_heal") {
					return {
						id: "drive_hygiene_heal",
						schema: { parse: (v: unknown) => v },
						run: healHandler,
					} as any;
				}
				if (id === "weekly_kpi_snapshot") {
					return {
						id: "weekly_kpi_snapshot",
						schema: { parse: (v: unknown) => v },
						run: snapshotHandler,
					} as any;
				}
				return undefined;
			}),
		};

		const result = await runDriveHygieneSweep({
			userId: OWNER,
			registry,
			maxActions: 100,
			auditSink: async () => {},
		});

		expect(healHandler).toHaveBeenCalledWith(
			{
				provider: "both",
				gdrive_domains: ["angus"],
				max_actions: 100,
				dry_run: false,
			},
			expect.objectContaining({
				caller: "worker",
				userId: OWNER,
			}),
		);
		expect(snapshotHandler).toHaveBeenCalledWith(
			{
				window_days: 7,
				include_drives: true,
				include_system_doctor: false,
				record_snapshot: true,
			},
			expect.objectContaining({
				caller: "worker",
				userId: OWNER,
			}),
		);
		expect(result.error).toBeUndefined();
		expect(result.counts).toMatchObject({
			candidates_found: 12,
			executed_count: 12,
			failed_count: 0,
			reclaimed_bytes: 5_242_880,
			week_key: "2026-W45",
			cloud_storage_hygiene_pct: 76.4,
			snapshot_artifact_id: "art-w45-id",
		});
	});

	it("records heal counts and surfaces error when weekly_kpi_snapshot fails or operations fail", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const registry = {
			get: vi.fn((id: string) => {
				if (id === "drive_hygiene_heal") {
					return {
						id: "drive_hygiene_heal",
						schema: { parse: (v: unknown) => v },
						run: vi.fn().mockResolvedValue({
							summary: {
								candidates_found: 3,
								planned_within_cap: 3,
								executed_count: 2,
								failed_count: 1,
								skipped_cap_count: 0,
								reclaimed_bytes: 1024,
								by_lever: {},
							},
						}),
					} as any;
				}
				if (id === "weekly_kpi_snapshot") {
					return {
						id: "weekly_kpi_snapshot",
						schema: { parse: (v: unknown) => v },
						run: vi.fn().mockRejectedValue(new Error("supabase timeout")),
					} as any;
				}
				return undefined;
			}),
		};

		const result = await runDriveHygieneSweep({
			userId: OWNER,
			registry,
			auditSink: async () => {},
		});

		expect(result.counts.executed_count).toBe(2);
		expect(result.counts.failed_count).toBe(1);
		expect(result.error).toContain(
			"1 Band 1 operation(s) failed during drive_hygiene_heal; weekly_kpi_snapshot failed: supabase timeout",
		);
	});

	it("createDriveHygieneCadence defaults to 6-hour interval under dedup lock and requires owner userId", async () => {
		const cadence = createDriveHygieneCadence({
			resolveUserIds: async () => [],
		});
		expect(cadence.name).toBe("dedup");
		expect(cadence.intervalMs).toBe(DRIVE_HYGIENE_CADENCE_INTERVAL_MS);
		expect(cadence.enabled()).toBe(true);
		await expect(cadence.run()).rejects.toThrow(/no owner user id configured/);
	});
});
