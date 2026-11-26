import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SynthesisCoverageDay } from "@ahkms/core/adapters";
import {
	buildOracleCoverage,
	busiestMaterialDay,
	classifyLiveDifferences,
	CoverageFunctionMissingError,
	diffCoverage,
	explainStatement,
	formatParityReport,
	isMissingFunctionError,
	runDosCoverageParity,
	type ParityArtifactRow,
	type ParityClient,
	type ParityMarkerRow,
	type ParityQuery,
} from "../dosCoverageParity.js";

const migrationsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../supabase/migrations",
);

const FROM = "2026-11-01";
const TO = "2026-11-03";

/** A plain enriched note captured (and dated) at noon UTC on `day`. */
const atom = (id: string, day: string, extra: Partial<ParityArtifactRow> = {}): ParityArtifactRow => ({
	id,
	captured_at: `${day}T12:00:00+00:00`,
	effective_at: `${day}T12:00:00+00:00`,
	content_subtype: "note",
	lifecycle_stage: "enriched",
	...extra,
});

const marker = (
	artifact_id: string | null,
	kind: string,
	external_id: string | null,
	provider = "notion_personal",
): ParityMarkerRow => ({ artifact_id, kind, external_id, provider });

const ARTIFACTS: ParityArtifactRow[] = [
	atom("a1", "2026-11-01"),
	atom("a2", "2026-11-01"),
	atom("a3", "2026-11-02"),
	atom("twin-2", "2026-11-02", { content_subtype: "daily_log" }),
];
const MARKERS: ParityMarkerRow[] = [
	marker("a1", "synthesized", "page-b"),
	marker("a2", "synthesized", "page-a"),
	marker("a3", "synthesized_unattended", "page-c"),
	marker("twin-2", "evidence_aggregated_unattended", "page-c"),
];

const oracle = (over: Partial<Parameters<typeof buildOracleCoverage>[0]> = {}) =>
	buildOracleCoverage({ from: FROM, to: TO, artifacts: ARTIFACTS, markers: MARKERS, ...over });

const clone = (days: SynthesisCoverageDay[]): SynthesisCoverageDay[] =>
	JSON.parse(JSON.stringify(days)) as SynthesisCoverageDay[];

describe("buildOracleCoverage (the expected rows for get_dos_coverage_days, #2264)", () => {
	it("builds one row per day with counts per marker row and sorted distinct ids", () => {
		expect(oracle()).toEqual([
			{
				date: "2026-11-01",
				synthesized: 2,
				synthesized_unattended: 0,
				synthesized_external_ids: ["page-a", "page-b"],
				synthesized_unattended_external_ids: [],
				evidence_aggregated: 0,
				evidence_aggregated_unattended: 0,
				evidence_aggregated_external_ids: [],
				evidence_aggregated_unattended_external_ids: [],
				captured_atoms: 2,
				no_material: false,
			},
			{
				date: "2026-11-02",
				synthesized: 0,
				synthesized_unattended: 1,
				synthesized_external_ids: [],
				synthesized_unattended_external_ids: ["page-c"],
				evidence_aggregated: 0,
				evidence_aggregated_unattended: 1,
				evidence_aggregated_external_ids: [],
				evidence_aggregated_unattended_external_ids: ["page-c"],
				// The Daily Log twin carries a marker but is not an atom.
				captured_atoms: 1,
				no_material: false,
			},
			{
				date: "2026-11-03",
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
		]);
	});

	it("counts an atom captured on to + 1 and dated to on to (the window-edge rule)", () => {
		const late = atom("late", "2026-11-04", { effective_at: "2026-11-03T18:00:00+00:00" });
		const days = oracle({ artifacts: [...ARTIFACTS, late] });
		expect(days[2]).toMatchObject({ date: "2026-11-03", captured_atoms: 1, no_material: false });
	});

	it("scans exactly 7 days past to: captured on to + 7 counts, a later capture cannot attribute inside", () => {
		const atEdge = atom("edge", "2026-11-10", { effective_at: "2026-11-03T18:00:00+00:00" });
		const beyond = atom("beyond", "2026-11-11", { effective_at: "2026-11-03T18:00:00+00:00" });
		const days = oracle({ artifacts: [...ARTIFACTS, atEdge, beyond] });
		expect(days[2].captured_atoms).toBe(1);
	});

	it("does not count an atom captured before from, even when a marker brings its row in", () => {
		const early = atom("early", "2026-10-31");
		const days = oracle({
			artifacts: [...ARTIFACTS, early],
			markers: [...MARKERS, marker("early", "synthesized", "page-early")],
		});
		expect(days.map((d) => d.captured_atoms)).toEqual([2, 1, 0]);
		expect(days[0].synthesized).toBe(2);
	});

	it("counts a marker on a discovered artifact as a marker, not as an atom", () => {
		const pointer = atom("pointer", "2026-11-03", { lifecycle_stage: "discovered" });
		const days = oracle({
			artifacts: [...ARTIFACTS, pointer],
			markers: [...MARKERS, marker("pointer", "synthesized", "page-p")],
		});
		expect(days[2]).toMatchObject({
			synthesized: 1,
			synthesized_external_ids: ["page-p"],
			captured_atoms: 0,
			no_material: false,
		});
	});

	it("ignores a marker with a null artifact_id, and a kind outside the four", () => {
		const days = oracle({
			markers: [
				...MARKERS,
				marker(null, "synthesized", "page-orphan"),
				marker("a3", "task", "page-task"),
			],
		});
		expect(days).toEqual(oracle());
	});

	it("counts a marker with no external_id but lists no id for it", () => {
		const days = oracle({ markers: [marker("a3", "synthesized", null), marker("a3", "synthesized", "")] });
		expect(days[1]).toMatchObject({ synthesized: 2, synthesized_external_ids: [] });
	});

	it("scopes markers to the provider and leaves material domain-blind", () => {
		const days = oracle({
			markers: [...MARKERS, marker("a3", "synthesized", "page-h", "notion_work")],
			provider: "notion_work",
		});
		expect(days.map((d) => d.synthesized)).toEqual([0, 1, 0]);
		expect(days.map((d) => d.synthesized_unattended)).toEqual([0, 0, 0]);
		expect(days.map((d) => d.captured_atoms)).toEqual([2, 1, 0]);
	});

	it("starts at the earliest marker day when from is null, and is empty with no marker", () => {
		const days = oracle({ from: null, markers: [marker("a3", "synthesized", "page-c")] });
		expect(days.map((d) => d.date)).toEqual(["2026-11-02", "2026-11-03"]);
		expect(oracle({ from: null, markers: [] })).toEqual([]);
		expect(oracle({ from: null, provider: "notion_work" })).toEqual([]);
	});

	it("counts an artifact once when it is passed twice", () => {
		expect(oracle({ artifacts: [...ARTIFACTS, ...ARTIFACTS] })).toEqual(oracle());
	});
});

describe("diffCoverage (function result against the oracle)", () => {
	it("reports nothing for identical input", () => {
		expect(diffCoverage(oracle(), clone(oracle()))).toEqual([]);
	});

	it("reports a wrong captured_atoms", () => {
		const actual = clone(oracle());
		actual[0].captured_atoms = 3;
		expect(diffCoverage(oracle(), actual)).toEqual([
			{ date: "2026-11-01", field: "captured_atoms", expected: 2, actual: 3 },
		]);
	});

	it("reports a marker counted on the wrong day, on both days", () => {
		const actual = clone(oracle());
		actual[1].synthesized_unattended = 0;
		actual[1].synthesized_unattended_external_ids = [];
		actual[2].synthesized_unattended = 1;
		actual[2].synthesized_unattended_external_ids = ["page-c"];
		actual[2].no_material = false;
		expect(diffCoverage(oracle(), actual).map((d) => `${d.date} ${d.field}`)).toEqual([
			"2026-11-02 synthesized_unattended",
			"2026-11-02 synthesized_unattended_external_ids",
			"2026-11-03 synthesized_unattended",
			"2026-11-03 synthesized_unattended_external_ids",
			"2026-11-03 no_material",
		]);
	});

	it("reports an id array out of order", () => {
		const actual = clone(oracle());
		actual[0].synthesized_external_ids = ["page-b", "page-a"];
		expect(diffCoverage(oracle(), actual)).toEqual([
			{
				date: "2026-11-01",
				field: "synthesized_external_ids",
				expected: ["page-a", "page-b"],
				actual: ["page-b", "page-a"],
			},
		]);
	});

	it("reports a day present on one side only", () => {
		const actual = clone(oracle()).slice(1);
		actual.push({ ...actual[1], date: "2026-11-04" });
		expect(diffCoverage(oracle(), actual)).toEqual([
			{ date: "2026-11-01", field: "day", expected: "present", actual: "missing" },
			{ date: "2026-11-04", field: "day", expected: "missing", actual: "present" },
		]);
	});
});

describe("classifyLiveDifferences (function result against today's getSynthesisCoverage)", () => {
	const late = atom("late", "2026-11-04", { effective_at: "2026-11-03T18:00:00+00:00" });
	const artifacts = [...ARTIFACTS, late];
	const functionDays = buildOracleCoverage({ from: FROM, to: TO, artifacts, markers: MARKERS });
	// Today's read stops its scan at `to`, so it never sees `late`.
	const liveDays = oracle();

	it("reports nothing when the two agree", () => {
		expect(classifyLiveDifferences({ to: TO, functionDays, liveDays: clone(functionDays), artifacts })).toEqual([]);
	});

	it("labels a day that gains material only from atoms captured after to as window-edge", () => {
		const diffs = classifyLiveDifferences({ to: TO, functionDays, liveDays, artifacts });
		expect(diffs).toHaveLength(1);
		expect(diffs[0]).toMatchObject({ date: "2026-11-03", label: "window-edge" });
		expect(diffs[0].fields.map((f) => f.field)).toEqual(["captured_atoms", "no_material"]);
	});

	it("labels a surplus larger than the late atoms as unexplained", () => {
		const fn = clone(functionDays);
		fn[2].captured_atoms = 2;
		expect(classifyLiveDifferences({ to: TO, functionDays: fn, liveDays, artifacts })[0].label).toBe("unexplained");
	});

	it("labels a day where the function counts less than the live read as unexplained", () => {
		const fn = clone(liveDays);
		fn[0].captured_atoms = 1;
		expect(classifyLiveDifferences({ to: TO, functionDays: fn, liveDays, artifacts })[0]).toMatchObject({
			date: "2026-11-01",
			label: "unexplained",
		});
	});

	it("labels a saturated day as cap when both counts are at or above 2,000 and nothing else differs", () => {
		const fn = clone(liveDays);
		const live = clone(liveDays);
		fn[0].captured_atoms = 5400;
		live[0].captured_atoms = 2000;
		expect(classifyLiveDifferences({ to: TO, functionDays: fn, liveDays: live, artifacts })).toMatchObject([
			{ date: "2026-11-01", label: "cap" },
		]);

		live[0].captured_atoms = 1999;
		expect(classifyLiveDifferences({ to: TO, functionDays: fn, liveDays: live, artifacts })[0].label).toBe(
			"unexplained",
		);
	});

	it("labels any marker difference as unexplained, even beside a window-edge gain", () => {
		const live = clone(liveDays);
		live[2].synthesized = 1;
		live[2].no_material = false;
		expect(classifyLiveDifferences({ to: TO, functionDays, liveDays: live, artifacts })[0].label).toBe(
			"unexplained",
		);
	});
});

describe("EXPLAIN helper and missing-function detection", () => {
	it("names the day with the most material rows", () => {
		expect(busiestMaterialDay(ARTIFACTS)).toEqual({ date: "2026-11-01", material_rows: 2 });
		expect(busiestMaterialDay([])).toBeNull();
	});

	it("builds a single-day EXPLAIN (ANALYZE, BUFFERS) statement", () => {
		expect(explainStatement("00000000-0000-0000-0000-000000000000", "2026-11-01")).toBe(
			"EXPLAIN (ANALYZE, BUFFERS) SELECT public.get_dos_coverage_days('00000000-0000-0000-0000-000000000000'::uuid, '2026-11-01'::date, '2026-11-01'::date, NULL);",
		);
	});

	it("recognises PostgREST's and Postgres's missing-function errors and nothing else", () => {
		expect(isMissingFunctionError({ code: "PGRST202", message: "x" })).toBe(true);
		expect(
			isMissingFunctionError({
				message: "Could not find the function public.get_dos_coverage_days(p_from) in the schema cache",
			}),
		).toBe(true);
		expect(
			isMissingFunctionError({ message: "function public.get_dos_coverage_days(uuid) does not exist" }),
		).toBe(true);
		expect(isMissingFunctionError({ code: "57014", message: "canceling statement due to statement timeout" })).toBe(
			false,
		);
		expect(isMissingFunctionError(null)).toBe(false);
	});
});

describe("runDosCoverageParity (read-only run)", () => {
	const USER = "00000000-0000-0000-0000-000000000000";
	const late = atom("late", "2026-11-04", { effective_at: "2026-11-03T18:00:00+00:00" });
	const artifacts = [...ARTIFACTS, late];
	const scopes = [{ label: "unscoped", domain: undefined, provider: null }];

	/** A stub that serves the fixture rows and records every builder method called. */
	function stubClient(rpc: ParityClient["rpc"]) {
		const methods = new Set<string>();
		const from = (table: string): ParityQuery => {
			let ids: string[] | null = null;
			let stageFiltered = false;
			const result = () => {
				if (table === "artifact_external_links") {
					return { data: MARKERS.map((m, i) => ({ id: `m${i}`, ...m })), error: null };
				}
				const rows = ids
					? artifacts.filter((a) => ids?.includes(a.id))
					: artifacts.filter((a) => !stageFiltered || a.lifecycle_stage !== "discovered");
				return { data: rows, error: null };
			};
			const q = new Proxy({} as ParityQuery, {
				get(_target, prop: string) {
					if (prop === "then") {
						return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
							Promise.resolve(result()).then(res, rej);
					}
					return (...args: unknown[]) => {
						methods.add(prop);
						if (prop === "in" && args[0] === "id") ids = args[1] as string[];
						if (prop === "or") stageFiltered = true;
						return q;
					};
				},
			});
			return q;
		};
		return { client: { from, rpc } satisfies ParityClient, methods };
	}

	const run = (rpc: ParityClient["rpc"], liveDays = oracle()) => {
		const { client, methods } = stubClient(rpc);
		return {
			methods,
			report: runDosCoverageParity({
				client,
				userId: USER,
				today: TO,
				windowDays: 3,
				scopes,
				liveCoverage: async (from) => liveDays.filter((d) => d.date >= from),
			}),
		};
	};

	const correctRpc: ParityClient["rpc"] = async (_fn, params) => ({
		data: buildOracleCoverage({
			from: params.p_from as string | null,
			to: params.p_to as string,
			artifacts,
			markers: MARKERS,
			provider: params.p_provider as string | null,
		}),
		error: null,
	});

	it("passes when the function matches the oracle and the only live difference is the window edge", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const { report, methods } = run(async (fn, params) => {
			expect(fn).toBe("get_dos_coverage_days");
			calls.push(params);
			return correctRpc(fn, params);
		});
		const result = await report;

		expect(result.ok).toBe(true);
		expect(calls).toEqual([
			{ p_user_id: USER, p_from: "2026-11-01", p_to: TO, p_provider: null },
			{ p_user_id: USER, p_from: null, p_to: TO, p_provider: null },
		]);
		expect(result.cases.map((c) => [c.label, c.days, c.oracleDifferences.length])).toEqual([
			["3-day window / unscoped", 3, 0],
			["streak history / unscoped", 3, 0],
		]);
		expect(result.cases[0].liveDifferences.map((d) => [d.date, d.label])).toEqual([
			["2026-11-03", "window-edge"],
		]);
		expect(result.busiest).toEqual({ date: "2026-11-01", material_rows: 2 });
		expect(formatParityReport(result).at(-1)).toBe("PARITY OK");
		// Read-only by construction: no builder method that writes was ever called.
		for (const write of ["insert", "update", "upsert", "delete"]) {
			expect(methods.has(write)).toBe(false);
		}
	});

	it("fails when the function disagrees with the oracle", async () => {
		const { report } = run(async (fn, params) => {
			const res = await correctRpc(fn, params);
			const days = clone(res.data as SynthesisCoverageDay[]);
			days[0].captured_atoms += 1;
			return { data: days, error: null };
		});
		const result = await report;
		expect(result.ok).toBe(false);
		const lines = formatParityReport(result);
		expect(lines.some((l) => l.includes("oracle 2026-11-01 captured_atoms: oracle=2 function=3"))).toBe(true);
		expect(lines.at(-1)).toBe("PARITY FAILED");
	});

	it("fails on an unexplained live difference even when the oracle agrees", async () => {
		const live = clone(oracle());
		live[0].synthesized = 9;
		const result = await run(correctRpc, live).report;
		expect(result.cases[0].oracleDifferences).toEqual([]);
		expect(result.ok).toBe(false);
	});

	it("throws a message to apply migration 158 when the function is missing", async () => {
		const { report } = run(async () => ({
			data: null,
			error: { code: "PGRST202", message: "Could not find the function public.get_dos_coverage_days" },
		}));
		await expect(report).rejects.toThrow(CoverageFunctionMissingError);
		await expect(
			run(async () => ({ data: null, error: { code: "PGRST202", message: "missing" } })).report,
		).rejects.toThrow(/Apply migration 158/);
	});
});

describe("migration 158 text guards (get_dos_coverage_days, #2264)", () => {
	const read = (file: string) => readFileSync(join(migrationsDir, file), "utf8");
	const sql = read("20261121120000_158_get_dos_coverage_days_rpc.sql");
	// Comments explain what the function must not do; guard the executable text only.
	const code = sql
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("--"))
		.join("\n");
	const flat = code.replace(/\s+/g, " ");

	it("declares the function with the agreed signature, dropping before creating", () => {
		expect(flat).toContain("DROP FUNCTION IF EXISTS public.get_dos_coverage_days(uuid, date, date, text);");
		expect(flat).toContain(
			"CREATE FUNCTION public.get_dos_coverage_days( p_user_id uuid, p_from date, p_to date, p_provider text DEFAULT NULL ) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public",
		);
		expect(code).not.toMatch(/CREATE\s+OR\s+REPLACE/i);
		expect(flat).toContain("REVOKE ALL ON FUNCTION public.get_dos_coverage_days(uuid, date, date, text) FROM PUBLIC;");
		expect(flat).toContain(
			"GRANT EXECUTE ON FUNCTION public.get_dos_coverage_days(uuid, date, date, text) TO authenticated, service_role;",
		);
	});

	it("writes the stage predicate exactly as migration 153's partial index does", () => {
		const index = read("20261119120000_153_artifacts_coverage_keyset_indexes.sql");
		const predicate = /idx_artifacts_user_material_captured[\s\S]*?\n\s*WHERE (.+);/.exec(index)?.[1];
		expect(predicate).toBe(
			"lifecycle_stage IS NULL OR lifecycle_stage <> ALL (ARRAY['discovered'::text, 'failed'::text])",
		);
		expect(code).toContain(`(${predicate})`);
	});

	it("excludes Daily Log twins and scaffolds from material, and does not filter on archived", () => {
		expect(code).toContain("content_subtype IS DISTINCT FROM 'daily_log'");
		expect(code).toContain("content_subtype IS DISTINCT FROM 'scaffold'");
		expect(code).not.toMatch(/archived/i);
	});

	it("takes the day at UTC and applies the 7-day rule to markers and material alike", () => {
		expect(code).toContain("(captured_at AT TIME ZONE 'UTC')::date");
		expect(code).toContain("(effective_at AT TIME ZONE 'UTC')::date");
		expect(code).not.toMatch(/Europe\/London|now\(\)|CURRENT_DATE/i);
		expect(code.match(/captured_day - d\.effective_day BETWEEN 0 AND 7 THEN d\.effective_day/g)).toHaveLength(2);
	});

	it("scans material 7 days past p_to and never attributes a marker by its own created_at", () => {
		expect(flat).toContain("captured_at < (((SELECT b.to_day FROM bounds b) + 8)::timestamp AT TIME ZONE 'UTC')");
		expect(code).not.toMatch(/created_at/);
	});

	it("names the four closing kinds, scopes markers by provider, and sorts ids in byte order", () => {
		for (const kind of [
			"'synthesized'",
			"'synthesized_unattended'",
			"'evidence_aggregated'",
			"'evidence_aggregated_unattended'",
		]) {
			expect(code).toContain(kind);
		}
		expect(flat).toContain("(p_provider IS NULL OR ael.provider = p_provider)");
		expect(flat).toContain('ORDER BY g.external_id COLLATE "C"');
	});
});
