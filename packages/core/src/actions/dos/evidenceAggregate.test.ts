import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_CAPTURE_PREFERENCES,
	DISCOVER_ROLE_SEED,
} from "../../domain/capturePreferences.js";
import type {
	DosEvidenceAggregateRow,
	ExternalLinkRepository,
} from "../../ports/externalLinks.js";
import { getDosEvidenceAggregate } from "../../adapters/supabase/externalLinks.js";
import {
	createDosEvidenceAggregateAction,
	formatDosEvidenceAggregateMcp,
} from "./evidenceAggregate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../..");

function makeRepo(
	impl?: (
		params: Parameters<ExternalLinkRepository["getDosEvidenceAggregate"]>[0],
	) => Promise<DosEvidenceAggregateRow>,
): ExternalLinkRepository {
	const defaultResult: DosEvidenceAggregateRow = {
		domain: "work",
		timezone: "Europe/London",
		since: "2026-11-07",
		until: "2026-11-20",
		days: [],
		late_arrivals: [],
	};
	return {
		recordExternalLink: vi.fn(),
		getArtifactContentSubtype: vi.fn(),
		getExternalLinks: vi.fn(),
		inspectDedupSlot: vi.fn(),
		claimDedupSlot: vi.fn(),
		finalizeExternalLink: vi.fn(),
		releaseClaimForFailedWrite: vi.fn(),
		interruptedClaimMessage: vi.fn(),
		scopeToDomain: vi.fn((q) => q),
		getSynthesizedArtifactIds: vi.fn(),
		computeStreak: vi.fn(),
		enumerateDays: vi.fn(),
		getSynthesisCoverage: vi.fn(),
		getStreak: vi.fn(),
		getDailyLogQueue: vi.fn(),
		getDosEvidenceAggregate: vi.fn(impl ?? (async () => defaultResult)),
	};
}

const dummyCtx = {
	userId: "user-1",
	requestId: "req-1",
	caller: "mcp" as const,
};

describe("dos_evidence_aggregate action (#2228)", () => {
	it("registers with read-only annotations and merges capture_preferences surface_role_map", async () => {
		const repo = makeRepo();
		const loadCapturePreferences = vi.fn(async () => ({
			...DEFAULT_CAPTURE_PREFERENCES,
			default_role: "narrative" as const,
			surface_role_map: {
				custom_feed: "evidence" as const,
				slack: "excluded" as const,
			},
		}));
		const action = createDosEvidenceAggregateAction({
			externalLinks: repo,
			config: { loadCapturePreferences },
		});

		expect(action.id).toBe("dos_evidence_aggregate");
		expect(action.annotations.readOnlyHint).toBe(true);
		expect(action.annotations.destructiveHint).toBe(false);
		expect(action.annotations.idempotentHint).toBe(true);
		expect(action.annotations.openWorldHint).toBe(false);

		await action.run(
			{ domain: "work", days: 7, timezone: "Europe/London", top_n: 3 },
			dummyCtx,
		);

		expect(loadCapturePreferences).toHaveBeenCalledTimes(1);
		expect(repo.getDosEvidenceAggregate).toHaveBeenCalledWith({
			domain: "work",
			days: 7,
			since: undefined,
			until: undefined,
			timezone: "Europe/London",
			topN: 3,
			surfaceRoleMap: {
				...DISCOVER_ROLE_SEED,
				custom_feed: "evidence",
				slack: "excluded",
			},
			defaultRole: "narrative",
		});
	});

	it("falls back to DEFAULT_CAPTURE_PREFERENCES when config port is omitted", async () => {
		const repo = makeRepo();
		const action = createDosEvidenceAggregateAction({ externalLinks: repo });

		await action.run({ domain: "angus" }, dummyCtx);

		expect(repo.getDosEvidenceAggregate).toHaveBeenCalledWith({
			domain: "angus",
			days: undefined,
			since: undefined,
			until: undefined,
			timezone: undefined,
			topN: undefined,
			surfaceRoleMap: { ...DISCOVER_ROLE_SEED },
			defaultRole: "narrative",
		});
	});

	it("rejects inverted since/until bounds and out-of-range days", async () => {
		const repo = makeRepo();
		const action = createDosEvidenceAggregateAction({ externalLinks: repo });

		await expect(
			action.run(
				{ domain: "work", since: "2026-11-20", until: "2026-11-10" },
				dummyCtx,
			),
		).rejects.toThrow(/must be on or after/);

		expect(() =>
			action.schema.parse({ domain: "work", days: 91 }),
		).toThrow();
		expect(() =>
			action.schema.parse({ domain: "work", days: 0 }),
		).toThrow();
	});

	it("formats F1-1 counts, F2-1 dated_earlier_note, and F3-1 late_arrivals in MCP output", () => {
		const sample: DosEvidenceAggregateRow = {
			domain: "work",
			timezone: "Europe/London",
			since: "2026-11-19",
			until: "2026-11-20",
			days: [
				{
					date: "2026-11-20",
					closed_at: "2026-11-20T18:00:00Z",
					material_total: 4,
					evidence_total: 2,
					excluded_or_robot_total: 2,
					dated_earlier_count: 1,
					dated_earlier_note: "1 arrived on 2026-11-20, dated earlier",
					groups: [
						{
							surface: "github",
							source_channel: "github_ingest",
							content_subtype: null,
							connection: "repo:example-org/core",
							count: 3,
							evidence_count: 2,
							excluded_or_robot_count: 1,
							top_n: [
								{
									id: "ev-1",
									title: "PR #101 merged",
									surface: "github",
									source_channel: "github_ingest",
									content_subtype: null,
									connection: "repo:example-org/core",
									captured_at: "2026-11-20T12:00:00Z",
									effective_at: "2026-11-20T12:00:00Z",
									event_date: "2026-11-20",
								},
							],
						},
						{
							surface: "derived",
							source_channel: "derived",
							content_subtype: null,
							connection: "repo:example-org/core",
							count: 1,
							evidence_count: 0,
							excluded_or_robot_count: 1,
							top_n: [],
						},
					],
					items: [
						{
							id: "ev-1",
							title: "PR #101 merged",
							surface: "github",
							source_channel: "github_ingest",
							content_subtype: null,
							connection: "repo:example-org/core",
							captured_at: "2026-11-20T12:00:00Z",
							effective_at: "2026-11-20T12:00:00Z",
							event_date: "2026-11-20",
						},
					],
					dated_earlier_items: [
						{
							id: "ev-2",
							title: "Backfilled PR #99",
							surface: "github",
							source_channel: "github_ingest",
							content_subtype: null,
							connection: "repo:example-org/core",
							captured_at: "2026-11-20T13:00:00Z",
							effective_at: "2026-11-18T09:00:00Z",
							event_date: "2026-11-18",
						},
					],
				},
			],
			late_arrivals: [
				{
					id: "ev-late-1",
					title: "Late evening commit",
					surface: "github",
					source_channel: "github_ingest",
					content_subtype: null,
					connection: "repo:example-org/core",
					captured_at: "2026-11-20T19:30:00Z",
					effective_at: "2026-11-20T19:30:00Z",
					captured_date: "2026-11-20",
					closed_at: "2026-11-20T18:00:00Z",
				},
			],
		};

		const text = formatDosEvidenceAggregateMcp(sample);
		expect(text).toContain("material=4 (evidence=2, excluded_or_robot=2)");
		expect(text).toContain("1 arrived on 2026-11-20, dated earlier");
		expect(text).toContain("repo:example-org/core");
		expect(text).toContain("late_arrivals (1):");
		expect(text).toContain("Late evening commit");
		expect(text).toContain('"dated_earlier_items"');
	});
});

describe("getDosEvidenceAggregate Supabase adapter (#2228)", () => {
	it("invokes public.get_dos_evidence_aggregate RPC with expected parameters", async () => {
		const rpc = vi.fn(async () => ({
			data: {
				domain: "work",
				timezone: "Europe/London",
				since: "2026-11-07",
				until: "2026-11-20",
				days: [],
				late_arrivals: [],
			},
			error: null,
		}));

		const result = await getDosEvidenceAggregate(
			{
				domain: "work",
				days: 14,
				timezone: "Europe/London",
				topN: 5,
				surfaceRoleMap: { github: "evidence" },
				defaultRole: "narrative",
			},
			{
				client: {
					from: vi.fn() as never,
					rpc: rpc as never,
				},
				ownerId: () => "owner-uuid",
			},
		);

		expect(rpc).toHaveBeenCalledWith("get_dos_evidence_aggregate", {
			p_user_id: "owner-uuid",
			p_domain: "work",
			p_days: 14,
			p_since: null,
			p_until: null,
			p_timezone: "Europe/London",
			p_top_n: 5,
			p_surface_role_map: { github: "evidence" },
			p_default_role: "narrative",
		});
		expect(result.domain).toBe("work");
		expect(result.days).toEqual([]);
		expect(result.late_arrivals).toEqual([]);
	});

	it("throws actionable error when rpc is missing or fails", async () => {
		await expect(
			getDosEvidenceAggregate(
				{ domain: "work" },
				{ client: { from: vi.fn() as never }, ownerId: () => "owner-uuid" },
			),
		).rejects.toThrow(/rpc\(\) wired/);

		await expect(
			getDosEvidenceAggregate(
				{ domain: "work" },
				{
					client: {
						from: vi.fn() as never,
						rpc: vi.fn(async () => ({
							data: null,
							error: { message: "function public.get_dos_evidence_aggregate does not exist" },
						})) as never,
					},
					ownerId: () => "owner-uuid",
				},
			),
		).rejects.toThrow(/migration 156/);
	});

	it("migration 156 defines get_dos_evidence_aggregate with F1-1, F2-1, F3-1, and derived_from parent join", () => {
		const sqlPath = path.join(
			repoRoot,
			"supabase/migrations/20261120140000_156_dos_evidence_aggregate_rpc.sql",
		);
		const sql = fs.readFileSync(sqlPath, "utf8");
		expect(sql).toContain("CREATE FUNCTION public.get_dos_evidence_aggregate(");
		expect(sql).toContain("SECURITY DEFINER");
		expect(sql).toContain("SET search_path = public");
		expect(sql).toContain("REVOKE ALL ON FUNCTION public.get_dos_evidence_aggregate");
		expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.get_dos_evidence_aggregate");
		expect(sql).toContain("processing_metadata->>'derived_from'");
		expect(sql).toContain("evidence_aggregated");
		expect(sql).toContain("evidence_aggregated_unattended");
		expect(sql).toContain("arrived on %s, dated earlier");
		expect(sql).toContain("late_arrivals");
	});
});
