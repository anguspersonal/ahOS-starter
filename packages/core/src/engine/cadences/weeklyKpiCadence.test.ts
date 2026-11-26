import { describe, expect, it, vi } from "vitest";
import type { WeeklyKpiSnapshotPorts } from "../../actions/metrics/weeklyKpiSnapshot.js";
import {
	WEEKLY_KPI_CADENCE_INTERVAL_MS,
	createWeeklyKpiCadence,
} from "./weeklyKpiCadence.js";

const OWNER = "11111111-1111-4111-8111-111111111111";

function createStubPorts(): WeeklyKpiSnapshotPorts {
	return {
		onedrive: {
			getQuota: vi.fn().mockResolvedValue({
				total: 1000,
				used: 500,
				remaining: 500,
				deleted: 0,
				state: "normal",
			}),
			listChildren: vi.fn().mockResolvedValue({ items: [] }),
		} as unknown as WeeklyKpiSnapshotPorts["onedrive"],
		drive: {
			listFiles: vi.fn().mockResolvedValue({ files: [] }),
		} as unknown as WeeklyKpiSnapshotPorts["drive"],
		cleanState: {
			loadEvaluationData: vi.fn().mockResolvedValue({
				artifacts: [],
				ledger: { error_count: 0, failed_actions: [] },
			}),
		},
		artifacts: {
			capture: vi.fn().mockResolvedValue({
				id: "scorecard-1",
				title: "Weekly KPI Scorecard",
				tags: ["kpi"],
				source_channel: "system",
				storage_bucket: "artifacts",
				storage_path: "notes/scorecard-1.md",
				captured_at: "2026-11-01T00:00:00Z",
				captured_at_declared: false,
				deduplicated: false,
				updated: false,
			}),
			documentDuplicates: vi.fn().mockResolvedValue({
				rows: [],
				clusters: [],
				args: {},
			}),
		},
		tasks: {
			taskCrud: vi.fn().mockResolvedValue({ operation: "query", tasks: [] }),
		} as unknown as WeeklyKpiSnapshotPorts["tasks"],
		review: {
			reviewList: vi.fn().mockResolvedValue({ decisions: [], total: 0, limit: 100, offset: 0 }),
		} as unknown as WeeklyKpiSnapshotPorts["review"],
		ledger: {
			querySummary: vi.fn().mockResolvedValue({
				by_action: [],
				row_estimate: 0,
				total_bytes: 0,
			}),
		} as unknown as WeeklyKpiSnapshotPorts["ledger"],
	};
}

describe("createWeeklyKpiCadence (ADR-115 Layer 4)", () => {
	it("defaults to weekly interval (7 days) and enabled=true", () => {
		const ports = createStubPorts();
		const cadence = createWeeklyKpiCadence({
			ports,
			resolveUserIds: async () => [OWNER],
		});

		expect(cadence.name).toBe("weekly_kpi_snapshot");
		expect(cadence.intervalMs).toBe(WEEKLY_KPI_CADENCE_INTERVAL_MS);
		expect(cadence.enabled()).toBe(true);
	});

	it("throws when resolveUserIds returns no owner user ids", async () => {
		const ports = createStubPorts();
		const cadence = createWeeklyKpiCadence({
			ports,
			resolveUserIds: async () => [],
		});

		await expect(cadence.run()).rejects.toThrow(/no owner user id configured/);
	});

	it("executes weekly_kpi_snapshot per unique resolved user and records audit trail", async () => {
		const ports = createStubPorts();
		const auditRecords: unknown[] = [];
		const cadence = createWeeklyKpiCadence({
			ports,
			resolveUserIds: async () => [OWNER, OWNER],
			auditSink: (rec) => {
				auditRecords.push(rec);
			},
		});

		const totals = await cadence.run();
		expect(totals).toEqual({
			users: 1,
			recorded: 1,
			deduplicated: 0,
			updated: 0,
			warnings: 0,
			errors: 0,
		});
		expect(ports.artifacts.capture).toHaveBeenCalledTimes(1);
		expect(auditRecords).toHaveLength(1);
	});
});
