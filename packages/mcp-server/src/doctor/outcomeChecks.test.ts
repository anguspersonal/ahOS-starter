import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The ledger reads are stubbed at their module boundary; the classification is real.
vi.mock("../links.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../links.js")>();
	return { ...actual, getSynthesisCoverage: vi.fn(), getStreak: vi.fn(), getDailyLogQueue: vi.fn() };
});

vi.mock("../supabase.js", () => ({ supabase: { rpc: vi.fn() } }));

import { DOCTOR_FAMILIES } from "@ahkms/core";
import { getDailyLogQueue, getStreak, getSynthesisCoverage } from "../links.js";
import { createDoctorPort } from "./index.js";
import { supabase } from "../supabase.js";
import {
	MIGRATIONS_DIR,
	checkOutcomes,
	expectedMigrations,
	migrationsAppliedCheck,
} from "./outcomeChecks.js";
import type { DoctorCheck } from "./report.js";

const NOW = new Date("2026-11-20T14:00:00Z");
const find = (checks: DoctorCheck[], name: string) => checks.find((c) => c.name === name);
const day = (date: string, atoms: number, markers: { s?: number; u?: number; e?: number; eu?: number } = {}) => ({
	date,
	synthesized: markers.s ?? 0,
	synthesized_unattended: markers.u ?? 0,
	synthesized_external_ids: [],
	synthesized_unattended_external_ids: [],
	evidence_aggregated: markers.e ?? 0,
	evidence_aggregated_unattended: markers.eu ?? 0,
	evidence_aggregated_external_ids: [],
	evidence_aggregated_unattended_external_ids: [],
	captured_atoms: atoms,
	no_material: atoms === 0 && !markers.s && !markers.u && !markers.e && !markers.eu,
});
type QueueEntry = Awaited<ReturnType<typeof getDailyLogQueue>>[number];
/** A healthy queued twin: one pointer, a page, not yet folded into the State Doc. */
const twin = (artifact_id: string, over: Partial<QueueEntry> = {}): QueueEntry => ({
	artifact_id,
	date: "2026-11-18",
	title: "Daily Log 18 Nov",
	domain: "work",
	provider: "notion_work",
	page_id: "page-1",
	page_url: "https://www.notion.so/page-1",
	markers: "attended",
	conflicting_providers: [],
	consumed_by_state: null,
	...over,
});
const TWINS = "dos twins attributable";

beforeEach(() => {
	vi.mocked(getSynthesisCoverage).mockReset().mockResolvedValue([]);
	vi.mocked(getStreak)
		.mockReset()
		.mockResolvedValue({ current: 2, best: 5, formatted: "day 2 · best 5" });
	vi.mocked(getDailyLogQueue).mockReset().mockResolvedValue([]);
	vi.mocked(supabase.rpc).mockReset().mockResolvedValue({ data: [], error: null } as never);
});

describe("outcomes: the family is registered (#2268)", () => {
	it("is a doctor family with a runner", () => {
		expect(DOCTOR_FAMILIES).toContain("outcomes");
		expect(createDoctorPort().families).toContain("outcomes");
	});

	it("reports three checks per domain plus twins and migrations, all in the outcomes family", async () => {
		const checks = await checkOutcomes(NOW);

		expect(checks.map((c) => c.name).sort()).toEqual([
			"dos coverage read angus",
			"dos coverage read work",
			"dos streak read angus",
			"dos streak read work",
			"dos sweep closed angus",
			"dos sweep closed work",
			"dos twins attributable",
			"migrations applied",
		]);
		expect(new Set(checks.map((c) => c.family))).toEqual(new Set(["outcomes"]));
	});
});

describe("outcomes: dos sweep closed", () => {
	// today-2 is only closed by today's afternoon run, so including it would FAIL every
	// morning. The check stops at today-3, which yesterday's run already covered.
	it("asks for [today-7, today-3]: the days the sweep has already had a run to close", async () => {
		await checkOutcomes(NOW);

		expect(getSynthesisCoverage).toHaveBeenCalledWith("2026-11-13", "2026-11-17", "work");
		expect(getSynthesisCoverage).toHaveBeenCalledWith("2026-11-13", "2026-11-17", "angus");
	});

	it("uses the same window whatever the hour, before or after the day's sweep", async () => {
		await checkOutcomes(new Date("2026-11-20T00:05:00Z"));
		await checkOutcomes(new Date("2026-11-20T23:55:00Z"));

		for (const call of vi.mocked(getSynthesisCoverage).mock.calls) {
			expect(call.slice(0, 2)).toEqual(["2026-11-13", "2026-11-17"]);
		}
	});

	it("is ok when every day with material carries a draft or a confirmed log", async () => {
		vi.mocked(getSynthesisCoverage).mockResolvedValue([
			day("2026-11-13", 4, { s: 1 }),
			day("2026-11-14", 2, { u: 1 }),
			day("2026-11-15", 0),
		]);

		const c = find(await checkOutcomes(NOW), "dos sweep closed work");

		expect(c?.status).toBe("ok");
		expect(c?.fix).toBe("");
	});

	// The November 2026 outage: this exact condition was a WARN in the wiring family.
	it("FAILS, naming each day and its atom count, when a day with material has no marker", async () => {
		vi.mocked(getSynthesisCoverage).mockResolvedValue([
			day("2026-11-13", 3),
			day("2026-11-14", 1),
			day("2026-11-15", 0),
			day("2026-11-16", 5, { u: 1 }),
		]);

		const c = find(await checkOutcomes(NOW), "dos sweep closed work");

		expect(c?.status).toBe("fail");
		expect(c?.detail).toContain("2 day(s)");
		expect(c?.detail).toContain("2026-11-13 (3 atoms)");
		expect(c?.detail).toContain("2026-11-14 (1 atoms)");
		expect(c?.detail).not.toContain("2026-11-16");
		expect(c?.fix).toContain("sync catchup");
	});

	// #2276 / ADR-109 §2: a day closed by evidence aggregation is closed.
	it("does not count a day closed by evidence aggregation as missed", async () => {
		vi.mocked(getSynthesisCoverage).mockResolvedValue([
			day("2026-11-13", 3, { e: 1 }),
			day("2026-11-14", 2, { eu: 1 }),
		]);

		expect(find(await checkOutcomes(NOW), "dos sweep closed work")?.status).toBe("ok");
	});

	it("does not count a day with no material as missed", async () => {
		vi.mocked(getSynthesisCoverage).mockResolvedValue([day("2026-11-15", 0), day("2026-11-17", 0)]);

		expect(find(await checkOutcomes(NOW), "dos sweep closed angus")?.status).toBe("ok");
	});

	it("judges each domain on its own coverage", async () => {
		vi.mocked(getSynthesisCoverage).mockImplementation(async (_from, _to, domain) =>
			domain === "work" ? [day("2026-11-13", 3)] : [day("2026-11-13", 3, { u: 1 })],
		);

		const checks = await checkOutcomes(NOW);

		expect(find(checks, "dos sweep closed work")?.status).toBe("fail");
		expect(find(checks, "dos sweep closed angus")?.status).toBe("ok");
	});
});

describe("outcomes: dos coverage read", () => {
	it("is ok when the read returns", async () => {
		vi.mocked(getSynthesisCoverage).mockResolvedValue([day("2026-11-13", 0)]);

		expect(find(await checkOutcomes(NOW), "dos coverage read work")?.status).toBe("ok");
	});

	it("FAILS with the error when the read throws, and marks the sweep check unknown, not ok", async () => {
		vi.mocked(getSynthesisCoverage).mockRejectedValue(
			new Error("Coverage artifact lookup failed: canceling statement due to statement timeout."),
		);

		const checks = await checkOutcomes(NOW);
		const read = find(checks, "dos coverage read work");
		const closed = find(checks, "dos sweep closed work");

		expect(read?.status).toBe("fail");
		expect(read?.detail).toContain("statement timeout");
		expect(read?.fix).toContain("migration");
		expect(closed?.status).toBe("fail");
		expect(closed?.detail).toContain("unknown");
	});
});

describe("outcomes: dos streak read", () => {
	it("is ok and shows the streak when it computes", async () => {
		const c = find(await checkOutcomes(NOW), "dos streak read work");

		expect(c?.status).toBe("ok");
		expect(c?.detail).toContain("day 2 · best 5");
		expect(getStreak).toHaveBeenCalledWith("work");
	});

	it("WARNS, never fails, when the streak read throws: the streak decides nothing", async () => {
		vi.mocked(getStreak).mockRejectedValue(
			new Error("Streak material lookup failed: canceling statement due to statement timeout."),
		);

		const c = find(await checkOutcomes(NOW), "dos streak read angus");

		expect(c?.status).toBe("warn");
		expect(c?.detail).toContain("statement timeout");
	});

	it("a failing streak read does not hide the coverage result, or the reverse", async () => {
		vi.mocked(getStreak).mockRejectedValue(new Error("streak down"));
		vi.mocked(getSynthesisCoverage).mockResolvedValue([day("2026-11-13", 3, { s: 1 })]);
		let checks = await checkOutcomes(NOW);
		expect(find(checks, "dos sweep closed work")?.status).toBe("ok");
		expect(find(checks, "dos streak read work")?.status).toBe("warn");

		vi.mocked(getStreak).mockResolvedValue({ current: 1, best: 1, formatted: "day 1 · best 1" });
		vi.mocked(getSynthesisCoverage).mockRejectedValue(new Error("coverage down"));
		checks = await checkOutcomes(NOW);
		expect(find(checks, "dos coverage read work")?.status).toBe("fail");
		expect(find(checks, "dos streak read work")?.status).toBe("ok");
	});
});

describe("outcomes: dos twins attributable (#2314)", () => {
	it("is ok when no queued twin is pointerless or conflicted", async () => {
		vi.mocked(getDailyLogQueue).mockResolvedValue([twin("twin-a"), twin("twin-b", { markers: "unattended" })]);

		const c = find(await checkOutcomes(NOW), TWINS);

		expect(c).toMatchObject({ family: "outcomes", status: "ok", fix: "" });
		expect(c?.detail).toContain("2 queued");
	});

	it("is ok on an empty queue", async () => {
		expect(find(await checkOutcomes(NOW), TWINS)?.status).toBe("ok");
	});

	it("FAILS on a pointerless twin, naming it and the external_link_create repair", async () => {
		vi.mocked(getDailyLogQueue).mockResolvedValue([
			twin("twin-ok"),
			twin("twin-lost", {
				date: "2026-11-19",
				title: "Daily Log 19 Nov",
				domain: null,
				provider: null,
				page_id: null,
				page_url: null,
			}),
		]);

		const c = find(await checkOutcomes(NOW), TWINS);

		expect(c?.status).toBe("fail");
		expect(c?.detail).toContain("1 pointerless");
		expect(c?.detail).toContain("0 pointer conflict");
		expect(c?.detail).toContain("twin-lost");
		expect(c?.detail).toContain("Daily Log 19 Nov");
		expect(c?.detail).toContain("2026-11-19");
		expect(c?.detail).not.toContain("twin-ok");
		expect(c?.detail).toContain("no ritual will see them");
		expect(c?.detail).not.toContain("cross-domain disagreement");
		expect(c?.fix).toContain("external_link_create");
		expect(c?.fix).toContain("daily_log");
	});

	it("FAILS on a pointer conflict, counted as a conflict and not as pointerless", async () => {
		vi.mocked(getDailyLogQueue).mockResolvedValue([
			twin("twin-torn", {
				domain: null,
				provider: null,
				page_id: null,
				page_url: null,
				conflicting_providers: ["notion_work", "notion_personal"],
			}),
		]);

		const c = find(await checkOutcomes(NOW), TWINS);

		expect(c?.status).toBe("fail");
		expect(c?.detail).toContain("twin-torn");
		expect(c?.detail).toContain("1 pointer conflict");
		expect(c?.detail).toContain("0 pointerless");
		expect(c?.detail).toContain("notion_work and notion_personal");
		// A cross-provider conflict IS returned by both scoped reads, so the detail must not
		// claim no ritual sees it (qa-review round 1).
		expect(c?.detail).toContain("only the unscoped read shows the whole disagreement");
		expect(c?.detail).toContain("the work read sees it as healthy");
		expect(c?.detail).toContain("the angus read sees it as healthy");
		expect(c?.detail).toContain("so both rituals may fold it");
		expect(c?.detail).not.toContain("no ritual will see");
		expect(c?.fix).toContain("owner");
	});

	it("words a same-provider conflict as flagged by that domain and unseen by the other", async () => {
		vi.mocked(getDailyLogQueue).mockResolvedValue([
			twin("twin-doubled", {
				domain: null,
				provider: null,
				page_id: null,
				page_url: null,
				conflicting_providers: ["notion_work", "notion_work"],
			}),
		]);

		const c = find(await checkOutcomes(NOW), TWINS);

		expect(c?.status).toBe("fail");
		expect(c?.detail).toContain("1 pointer conflict");
		expect(c?.detail).toContain("the work read flags it as a conflict");
		expect(c?.detail).toContain("the angus read does not return it");
		// Neither domain sees it as healthy, so the detail must not claim both may fold it
		// (qa-review round 1 re-check).
		expect(c?.detail).not.toContain("sees it as healthy");
		expect(c?.detail).not.toContain("both rituals may fold it");
	});

	it("reports both classes together, each twin under its own", async () => {
		vi.mocked(getDailyLogQueue).mockResolvedValue([
			twin("twin-lost", { page_id: null }),
			twin("twin-torn", { page_id: null, conflicting_providers: ["notion_work", "notion_personal"] }),
			twin("twin-lost-2", { page_id: null, title: null, date: null }),
		]);

		const c = find(await checkOutcomes(NOW), TWINS);

		expect(c?.status).toBe("fail");
		expect(c?.detail).toContain("2 pointerless");
		expect(c?.detail).toContain("1 pointer conflict");
		for (const id of ["twin-lost", "twin-torn", "twin-lost-2"]) expect(c?.detail).toContain(id);
	});

	it("ignores an entry already folded into the State Doc", async () => {
		vi.mocked(getDailyLogQueue).mockResolvedValue([
			twin("twin-consumed-lost", { page_id: null, consumed_by_state: "state-doc-page" }),
			twin("twin-consumed-torn", {
				page_id: null,
				conflicting_providers: ["notion_work", "notion_personal"],
				consumed_by_state: "state-doc-page",
			}),
		]);

		const c = find(await checkOutcomes(NOW), TWINS);

		expect(c?.status).toBe("ok");
		expect(c?.detail).not.toContain("twin-consumed");
	});

	it("FAILS with the error when the queue read throws, and hides no other check", async () => {
		vi.mocked(getDailyLogQueue).mockRejectedValue(new Error("Daily log queue lookup failed: socket hang up"));

		const checks = await checkOutcomes(NOW);
		const c = find(checks, TWINS);

		expect(c).toMatchObject({ family: "outcomes", status: "fail" });
		expect(c?.detail).toContain("socket hang up");
		expect(find(checks, "dos sweep closed work")?.status).toBe("ok");
		expect(find(checks, "dos sweep closed angus")?.status).toBe("ok");
		expect(find(checks, "dos streak read work")?.status).toBe("ok");
		expect(find(checks, "dos streak read angus")?.status).toBe("ok");
		expect(find(checks, "migrations applied")).toBeDefined();
	});

	it("is not hidden by the other outcomes reads failing", async () => {
		vi.mocked(getSynthesisCoverage).mockRejectedValue(new Error("coverage down"));
		vi.mocked(getStreak).mockRejectedValue(new Error("streak down"));
		vi.mocked(supabase.rpc).mockRejectedValue(new Error("socket hang up"));
		vi.mocked(getDailyLogQueue).mockResolvedValue([twin("twin-lost", { page_id: null })]);

		const c = find(await checkOutcomes(NOW), TWINS);

		expect(c?.status).toBe("fail");
		expect(c?.detail).toContain("twin-lost");
	});

	// Scoped by domain, the read matches on the pointer's provider and so cannot return a
	// pointerless twin at all: only the unscoped read can show one.
	it("reads the queue once, with no domain", async () => {
		await checkOutcomes(NOW);

		expect(getDailyLogQueue).toHaveBeenCalledTimes(1);
		expect(vi.mocked(getDailyLogQueue).mock.calls[0][0]).toBeUndefined();
	});
});

describe("outcomes: migrations applied (#2269)", () => {
	let dir: string;
	const applied = (versions: string[]) =>
		vi.mocked(supabase.rpc).mockResolvedValue({ data: versions, error: null } as never);

	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "ahos-migrations-"));
		for (const file of [
			"20261107140000_151_entity_relationships_confidence_scale.sql",
			"20261110120000_152_action_ledger_client_local_seam.sql",
			"20261119120000_153_artifacts_coverage_keyset_indexes.sql",
			"README.md",
		]) {
			await writeFile(path.join(dir, file), "");
		}
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("reads version -> filename from the build's migration files, ignoring anything else", async () => {
		expect([...(await expectedMigrations(dir))]).toEqual([
			["20261107140000", "20261107140000_151_entity_relationships_confidence_scale.sql"],
			["20261110120000", "20261110120000_152_action_ledger_client_local_seam.sql"],
			["20261119120000", "20261119120000_153_artifacts_coverage_keyset_indexes.sql"],
		]);
	});

	it("resolves the repo's real migrations directory from this module", async () => {
		const real = await expectedMigrations(MIGRATIONS_DIR);

		expect(real.size).toBeGreaterThan(100);
		expect(real.get("20261120120000")).toBe("20261120120000_154_applied_migration_versions.sql");
	});

	it("is ok when every migration in the build is applied", async () => {
		applied(["20261107140000", "20261110120000", "20261119120000"]);

		const c = await migrationsAppliedCheck(dir);

		expect(c).toMatchObject({ family: "outcomes", name: "migrations applied", status: "ok", fix: "" });
		expect(c.detail).toContain("all 3 migration(s)");
		expect(supabase.rpc).toHaveBeenCalledWith("applied_migration_versions");
	});

	// The 2026-11-20 state: production at 151, the build carrying 152 and 153.
	it("FAILS, naming each unapplied file, when the database is behind the build", async () => {
		applied(["20261107140000"]);

		const c = await migrationsAppliedCheck(dir);

		expect(c.status).toBe("fail");
		expect(c.detail).toContain("2 migration(s)");
		expect(c.detail).toContain("20261110120000_152_action_ledger_client_local_seam.sql");
		expect(c.detail).toContain("20261119120000_153_artifacts_coverage_keyset_indexes.sql");
		expect(c.detail).not.toContain("_151_");
		expect(c.fix).toContain("supabase db push");
	});

	it("does not fail on applied versions that have no file in the build, but says so", async () => {
		applied(["20261107140000", "20261110120000", "20261119120000", "20260610203913"]);

		const c = await migrationsAppliedCheck(dir);

		expect(c.status).toBe("ok");
		expect(c.detail).toContain("1 applied version(s) have no file in this build");
	});

	it("accepts rows returned as objects as well as bare strings", async () => {
		vi.mocked(supabase.rpc).mockResolvedValue({
			data: ["20261107140000", "20261110120000", "20261119120000"].map((v) => ({
				applied_migration_versions: v,
			})),
			error: null,
		} as never);

		expect((await migrationsAppliedCheck(dir)).status).toBe("ok");
	});

	it("FAILS and names migration 154 when the function itself is missing", async () => {
		vi.mocked(supabase.rpc).mockResolvedValue({
			data: null,
			error: { code: "PGRST202", message: "Could not find the function public.applied_migration_versions" },
		} as never);

		const c = await migrationsAppliedCheck(dir);

		expect(c.status).toBe("fail");
		expect(c.detail).toContain("migration 154");
		expect(c.fix).toContain("supabase db push");
	});

	it("FAILS with the error on any other read failure", async () => {
		vi.mocked(supabase.rpc).mockResolvedValue({
			data: null,
			error: { code: "57014", message: "canceling statement due to statement timeout" },
		} as never);

		const c = await migrationsAppliedCheck(dir);

		expect(c.status).toBe("fail");
		expect(c.detail).toContain("statement timeout");
		expect(c.fix).not.toContain("db push");
	});

	it("WARNS, without asking the database, when the build carries no migration list", async () => {
		const c = await migrationsAppliedCheck(path.join(dir, "absent"));

		expect(c.status).toBe("warn");
		expect(c.detail).toContain("no migration list");
		expect(supabase.rpc).not.toHaveBeenCalled();
	});

	it("a throwing migrations check never hides the sweep checks", async () => {
		vi.mocked(supabase.rpc).mockRejectedValue(new Error("socket hang up"));

		const checks = await checkOutcomes(NOW);

		expect(find(checks, "migrations applied")).toMatchObject({ status: "fail" });
		expect(find(checks, "migrations applied")?.detail).toContain("socket hang up");
		expect(find(checks, "dos sweep closed work")?.status).toBe("ok");
	});
});
