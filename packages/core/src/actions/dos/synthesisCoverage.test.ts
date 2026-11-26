import { describe, expect, it, vi } from "vitest";
import type {
	ExternalLinkRepository,
	SynthesisCoverageDay,
	SynthesisStreak,
} from "../../ports/externalLinks.js";
import {
	MAX_COVERAGE_DAYS,
	createDosSynthesisCoverageAction,
	formatDosSynthesisCoverageMcp,
} from "./synthesisCoverage.js";

function makeRepo(
	days: SynthesisCoverageDay[] = [],
	streak: SynthesisStreak = { current: 2, best: 5, formatted: "day 2 · best 5" },
): ExternalLinkRepository {
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
		getSynthesisCoverage: vi.fn(async () => days),
		getStreak: vi.fn(async () => streak),
		getDailyLogQueue: vi.fn(),
	};
}

describe("dos_synthesis_coverage action (#1606)", () => {
	it("delegates from, to, and domain to getSynthesisCoverage and getStreak on ExternalLinkRepository", async () => {
		const days: SynthesisCoverageDay[] = [
			{
				date: "2026-08-13",
				synthesized: 1,
				synthesized_unattended: 0,
				synthesized_external_ids: ["page-13"],
				synthesized_unattended_external_ids: [],
				evidence_aggregated: 0,
				evidence_aggregated_unattended: 0,
				evidence_aggregated_external_ids: [],
				evidence_aggregated_unattended_external_ids: [],
				captured_atoms: 3,
				no_material: false,
			},
		];
		const streak: SynthesisStreak = { current: 4, best: 4, formatted: "day 4 🔥 · best 4" };
		const repo = makeRepo(days, streak);
		const action = createDosSynthesisCoverageAction(repo);

		const result = await action.run(
			{ from: "2026-08-13", to: "2026-08-13", domain: "work" },
			{ caller: "test", requestId: "req-1" },
		);

		expect(repo.getSynthesisCoverage).toHaveBeenCalledWith("2026-08-13", "2026-08-13", "work");
		expect(repo.getStreak).toHaveBeenCalledWith("work");
		expect(result).toEqual({
			from: "2026-08-13",
			to: "2026-08-13",
			span: 1,
			domain: "work",
			days,
			streak,
		});
	});

	it("refuses a backwards window where to < from", async () => {
		const repo = makeRepo();
		const action = createDosSynthesisCoverageAction(repo);

		await expect(
			action.run(
				{ from: "2026-08-14", to: "2026-08-13" },
				{ caller: "test", requestId: "req-1" },
			),
		).rejects.toThrow(
			"dos_synthesis_coverage: 'to' (2026-08-13) must be on or after 'from' (2026-08-14).",
		);
		expect(repo.getSynthesisCoverage).not.toHaveBeenCalled();
	});

	it("refuses a window wider than MAX_COVERAGE_DAYS (92) with the legacy message", async () => {
		const repo = makeRepo();
		const action = createDosSynthesisCoverageAction(repo);

		await expect(
			action.run(
				{ from: "2026-01-01", to: "2026-04-03" },
				{ caller: "test", requestId: "req-1" },
			),
		).rejects.toThrow(
			`dos_synthesis_coverage: window is 93 days; the maximum is ${MAX_COVERAGE_DAYS}. Narrow the range.`,
		);
		expect(repo.getSynthesisCoverage).not.toHaveBeenCalled();
	});

	it("formats per-day lines, streak badge, domain scoping note, and JSON block via formatMcp", () => {
		const days: SynthesisCoverageDay[] = [
			{
				date: "2026-08-13",
				synthesized: 1,
				synthesized_unattended: 1,
				synthesized_external_ids: ["page-att"],
				synthesized_unattended_external_ids: ["page-unatt"],
				evidence_aggregated: 0,
				evidence_aggregated_unattended: 0,
				evidence_aggregated_external_ids: [],
				evidence_aggregated_unattended_external_ids: [],
				captured_atoms: 2,
				no_material: false,
			},
			{
				date: "2026-08-14",
				synthesized: 0,
				synthesized_unattended: 0,
				synthesized_external_ids: [],
				synthesized_unattended_external_ids: [],
				evidence_aggregated: 0,
				evidence_aggregated_unattended: 0,
				evidence_aggregated_external_ids: [],
				evidence_aggregated_unattended_external_ids: [],
				captured_atoms: 1,
				no_material: false,
			},
			{
				date: "2026-08-15",
				synthesized: 0,
				synthesized_unattended: 0,
				synthesized_external_ids: [],
				synthesized_unattended_external_ids: [],
				evidence_aggregated: 0,
				evidence_aggregated_unattended: 0,
				evidence_aggregated_external_ids: [],
				evidence_aggregated_unattended_external_ids: [],
				captured_atoms: 0,
				no_material: true,
			},
		];

		const text = formatDosSynthesisCoverageMcp({
			from: "2026-08-13",
			to: "2026-08-15",
			span: 3,
			domain: "angus",
			days,
			streak: { current: 1, best: 3, formatted: "day 1 · best 3" },
		});

		expect(text).toContain("synthesis coverage 2026-08-13 → 2026-08-15 (3 day(s)), domain: angus, bucketed on artifacts.captured_at (UTC):");
		expect(text).toContain("streak: day 1 · best 3");
		expect(text).toContain("2026-08-13  synthesized=1  synthesized_unattended=1  evidence_aggregated=0  evidence_aggregated_unattended=0  synthesized → page-att  synthesized_unattended → page-unatt");
		expect(text).toContain("2026-08-14  synthesized=0  synthesized_unattended=0  evidence_aggregated=0  evidence_aggregated_unattended=0  → uncovered");
		expect(text).toContain("2026-08-15  synthesized=0  synthesized_unattended=0  evidence_aggregated=0  evidence_aggregated_unattended=0  → no_material");
		expect(text).toContain("1 day(s) carry a synthesis marker; 2 carry none.");
		expect(text).toContain("Of the days with no marker: 1 uncovered (material existed), 1 no_material (zero atoms captured).");
		expect(text).toContain("for domain 'angus' ALONE");
		expect(JSON.parse(text.split("```json\n")[1].split("\n```")[0])).toEqual(days);
	});

	// #2257: the streak spans all history and is the slower read. It is motivational and
	// decides nothing, so its failure must not discard the coverage the sweep needs.
	it("returns coverage with a null streak and the reason when the streak read fails", async () => {
		const repo = makeRepo([
			{
				date: "2026-08-13",
				synthesized: 0,
				synthesized_unattended: 0,
				synthesized_external_ids: [],
				synthesized_unattended_external_ids: [],
				evidence_aggregated: 0,
				evidence_aggregated_unattended: 0,
				evidence_aggregated_external_ids: [],
				evidence_aggregated_unattended_external_ids: [],
				captured_atoms: 3,
				no_material: false,
			},
		]);
		vi.mocked(repo.getStreak).mockRejectedValue(
			new Error("Streak material lookup failed: canceling statement due to statement timeout."),
		);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const action = createDosSynthesisCoverageAction(repo);

		const result = await action.run(
			{ from: "2026-08-13", to: "2026-08-13", domain: "work" },
			{ caller: "test", requestId: "req-1" },
		);
		const text = action.formatMcp!(result);
		const logged = errors.mock.calls.map((c) => String(c[0])).join("\n");
		errors.mockRestore();

		expect(result.streak).toBeNull();
		expect(result.streak_error).toContain("statement timeout");
		expect(result.days).toHaveLength(1);
		expect(text).toContain("streak: UNAVAILABLE (Streak material lookup failed");
		expect(text).toContain("2026-08-13  synthesized=");
		expect(logged).toContain("streak unavailable");
	});

	it("still fails the whole call when the COVERAGE read fails", async () => {
		const repo = makeRepo();
		vi.mocked(repo.getSynthesisCoverage).mockRejectedValue(
			new Error("Coverage artifact lookup failed: boom."),
		);
		const action = createDosSynthesisCoverageAction(repo);

		await expect(
			action.run({ from: "2026-08-13", to: "2026-08-13" }, { caller: "test", requestId: "req-1" }),
		).rejects.toThrow("Coverage artifact lookup failed");
		expect(repo.getStreak).not.toHaveBeenCalled();
	});

	it("omits streak_error on a healthy read", async () => {
		const action = createDosSynthesisCoverageAction(makeRepo());
		const result = await action.run(
			{ from: "2026-08-13", to: "2026-08-13" },
			{ caller: "test", requestId: "req-1" },
		);
		expect(result.streak).not.toBeNull();
		expect("streak_error" in result).toBe(false);
	});

	it("treats evidence-closed days as covered (not uncovered) and surfaces evidence counts in formatMcp", () => {
		const days: SynthesisCoverageDay[] = [
			{
				date: "2026-08-13",
				synthesized: 0,
				synthesized_unattended: 0,
				synthesized_external_ids: [],
				synthesized_unattended_external_ids: [],
				evidence_aggregated: 1,
				evidence_aggregated_unattended: 0,
				evidence_aggregated_external_ids: ["twin-13"],
				evidence_aggregated_unattended_external_ids: [],
				captured_atoms: 2,
				no_material: false,
			},
			{
				date: "2026-08-14",
				synthesized: 0,
				synthesized_unattended: 0,
				synthesized_external_ids: [],
				synthesized_unattended_external_ids: [],
				evidence_aggregated: 0,
				evidence_aggregated_unattended: 1,
				evidence_aggregated_external_ids: [],
				evidence_aggregated_unattended_external_ids: ["twin-14"],
				captured_atoms: 1,
				no_material: false,
			},
		];

		const text = formatDosSynthesisCoverageMcp({
			from: "2026-08-13",
			to: "2026-08-14",
			span: 2,
			domain: "work",
			days,
			streak: { current: 1, best: 1, formatted: "day 1 · best 1" },
		});

		expect(text).toContain("evidence_aggregated=1");
		expect(text).toContain("evidence_aggregated_unattended=1");
		expect(text).toContain("evidence_aggregated → twin-13");
		expect(text).toContain("evidence_aggregated_unattended → twin-14");
		expect(text).toContain("2 day(s) carry a synthesis marker; 0 carry none.");
		expect(text).toContain("Of the days with no marker: 0 uncovered (material existed), 0 no_material (zero atoms captured).");
		expect(text).not.toContain("2026-08-13  synthesized=0  synthesized_unattended=0  evidence_aggregated=1  evidence_aggregated_unattended=0  → uncovered");
	});
});
