import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { MACHINE_INGEST_SURFACES } from "../../domain/capturePreferences.js";
import type { HotTierCandidateRow, HotTierCandidatesParams, HotTierCandidatesResult } from "../../ports/entities.js";
import { createHotTierCandidatesAction } from "./hotTierCandidates.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../..");

function makeCandidate(i: number): HotTierCandidateRow {
	return {
		id: `00000000-0000-4000-8000-00000000000${i}`,
		entity_type: i % 2 === 0 ? "people" : "term",
		title: `Candidate ${i}`,
		aliases: [`Alias ${i}`],
		mentions: 10 - i,
		last_mention_at: `2026-11-${String(20 - i).padStart(2, "0")}T12:00:00.000Z`,
	};
}

describe("hot_tier_candidates action (#2392)", () => {
	const fixedNow = new Date("2026-11-21T12:00:00.000Z");

	it("case 1: hot_count 2 with 7 ranked rows returns 5 candidates, slots 5, and formatted header", async () => {
		const rows = [1, 2, 3, 4, 5, 6, 7].map(makeCandidate);
		const getHotTierCandidates = vi.fn(async (): Promise<HotTierCandidatesResult> => ({
			hot_count: 2,
			candidates: rows,
		}));
		const action = createHotTierCandidatesAction({
			entities: { getHotTierCandidates },
			now: () => fixedNow,
		});

		expect(action.id).toBe("hot_tier_candidates");
		expect(action.domain).toBe("kg");
		expect(action.annotations?.readOnlyHint).toBe(true);

		const result = await action.run({}, { userId: "user-1" });
		expect(result.hot_count).toBe(2);
		expect(result.target).toBe(12);
		expect(result.slots).toBe(5);
		expect(result.candidates).toEqual(rows.slice(0, 5));

		const text = action.formatMcp!(result);
		expect(text.startsWith("hot tier: 2 of 12 rows, 5 suggestion slots")).toBe(true);
		expect(text).toContain("Candidate 1");
		expect(text).toContain("Candidate 5");
		expect(text).not.toContain("Candidate 6");
	});

	it("case 2: hot_count 10 returns exactly 2 candidates", async () => {
		const rows = [1, 2, 3, 4, 5].map(makeCandidate);
		const action = createHotTierCandidatesAction({
			entities: {
				getHotTierCandidates: vi.fn(async () => ({ hot_count: 10, candidates: rows })),
			},
			now: () => fixedNow,
		});

		const result = await action.run({});
		expect(result.slots).toBe(2);
		expect(result.candidates).toEqual(rows.slice(0, 2));
	});

	it("case 3: hot_count 12 and 14 return 0 candidates, slots 0, and target-reached text", async () => {
		const rows = [1, 2, 3].map(makeCandidate);
		for (const hotCount of [12, 14]) {
			const action = createHotTierCandidatesAction({
				entities: {
					getHotTierCandidates: vi.fn(async () => ({ hot_count: hotCount, candidates: rows })),
				},
				now: () => fixedNow,
			});

			const result = await action.run({});
			expect(result.slots).toBe(0);
			expect(result.candidates).toEqual([]);

			const text = action.formatMcp!(result);
			const lines = text.split("\n");
			expect(lines[0]).toBe(`hot tier: ${hotCount} of 12 rows, 0 suggestion slots`);
			expect(lines[1]).toContain("at its target");
			expect(lines).toHaveLength(2);
		}
	});

	it("case 4: passes defaults (30d window, min 3, limit 5, 90d quiet, MACHINE_INGEST_SURFACES, filtered entity_types)", async () => {
		let capturedParams: HotTierCandidatesParams | undefined;
		const action = createHotTierCandidatesAction({
			entities: {
				getHotTierCandidates: vi.fn(async (params) => {
					capturedParams = params;
					return { hot_count: 0, candidates: [] };
				}),
			},
			now: () => fixedNow,
		});

		await action.run({}, { userId: "owner-1" });

		expect(capturedParams).toBeDefined();
		expect(capturedParams!.windowStart).toBe(
			new Date(fixedNow.getTime() - 30 * 86_400_000).toISOString(),
		);
		expect(capturedParams!.minMentions).toBe(3);
		expect(capturedParams!.limit).toBe(5);
		expect(capturedParams!.quietStart).toBe(
			new Date(fixedNow.getTime() - 90 * 86_400_000).toISOString(),
		);
		expect(capturedParams!.excludedSurfaces).toEqual([...MACHINE_INGEST_SURFACES]);
		expect(capturedParams!.excludedSurfaces).toContain("gmail_ingest");
		expect(capturedParams!.excludedSurfaces).toContain("slack");
		expect(capturedParams!.excludedSurfaces).toContain("slack_dm");

		expect(capturedParams!.entityTypes).toContain("people");
		expect(capturedParams!.entityTypes).toContain("term");
		for (const excluded of ["event", "signal", "decision", "arrangement", "domain"]) {
			expect(capturedParams!.entityTypes).not.toContain(excluded);
		}
	});

	it("case 5: custom inputs days: 60, min_mentions: 2, max_suggestions: 3, target: 20 reach repo and slot arithmetic", async () => {
		const rows = [1, 2, 3, 4].map(makeCandidate);
		const getHotTierCandidates = vi.fn(async () => ({
			hot_count: 18,
			candidates: rows,
		}));
		const action = createHotTierCandidatesAction({
			entities: { getHotTierCandidates },
			now: () => fixedNow,
		});

		const result = await action.run(
			{ days: 60, min_mentions: 2, max_suggestions: 3, target: 20 },
			{ userId: "owner-1" },
		);

		expect(getHotTierCandidates).toHaveBeenCalledWith(
			expect.objectContaining({
				windowStart: new Date(fixedNow.getTime() - 60 * 86_400_000).toISOString(),
				minMentions: 2,
				limit: 3,
			}),
			"owner-1",
		);
		expect(result.target).toBe(20);
		expect(result.slots).toBe(2);
		expect(result.candidates).toEqual(rows.slice(0, 2));
	});

	it("case 6: propagates repository error instead of swallowing it", async () => {
		const action = createHotTierCandidatesAction({
			entities: {
				getHotTierCandidates: vi.fn(async () => {
					throw new Error("rpc failed");
				}),
			},
			now: () => fixedNow,
		});

		await expect(action.run({})).rejects.toThrow("rpc failed");
	});

	it("migration 159 defines public.get_hot_tier_candidates with rules, header, grants, and COMMENT ON FUNCTION", () => {
		const sqlPath = path.join(
			REPO_ROOT,
			"supabase/migrations/20261122120000_159_get_hot_tier_candidates_rpc.sql",
		);
		const sql = fs.readFileSync(sqlPath, "utf8");
		expect(sql).toContain("#1154");
		expect(sql).toContain("CREATE FUNCTION public.get_hot_tier_candidates(");
		expect(sql).toContain("COMMENT ON FUNCTION public.get_hot_tier_candidates(");
		expect(sql).toContain("REVOKE ALL ON FUNCTION public.get_hot_tier_candidates(");
		expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.get_hot_tier_candidates(");
		expect(sql).toContain("robot_authored");
		expect(sql).toContain("not_robot_authored");
		expect(sql).toContain("hot_declined_at");
		expect(sql).toContain("ON l.entity_id = e.id");
		expect(sql).toContain("ON a.id = l.artifact_id");
		expect(sql).not.toContain("e.id::text\n  JOIN");
		expect(sql).not.toContain("a.id::text = l.artifact_id");
	});
});
